import type {
  ActionPolicy,
  MutationResult,
  TeamPermission,
} from "@myst-os/sdk";
import type { NextRequest } from "next/server";
import { and, eq, ilike, inArray, isNotNull, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { z } from "zod";
import {
  appointmentCrewMembers,
  appointments,
  contacts,
  crmPipeline,
  crmTasks,
  getDb,
  leads,
  outboxEvents,
  teamMembers,
} from "@/db";
import {
  parseAppointmentBookingDetails,
  validateQuotedTotalForBookingDetails,
} from "@/lib/appointment-booking-details";
import {
  AppointmentMediaError,
  assertAppointmentStatusTransitionAllowed,
} from "@/lib/appointment-media";
import { getAppointmentCapacity } from "@/lib/appointment-capacity";
import { validateActiveAppointmentAttribution } from "@/lib/appointment-attribution";
import {
  acquireScheduleConflictLock,
  inspectScheduleConflicts,
} from "@/lib/appointment-schedule-conflicts";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { isGoogleCalendarEnabled } from "@/lib/calendar";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  type TeamMutationIdempotencyClaim,
  teamMutationIdempotencyReplayResponse,
} from "@/lib/team-mutation-idempotency";
import { resolveConfiguredCrewPayout } from "@/lib/commissions";
import {
  expireStalePaymentAttemptsForAppointment,
  getBlockingSquareAttempt,
  getFinalTotalPaymentLock,
  requiresSquareAttemptReconciliation,
  validateFinalTotalChange,
} from "@/lib/payment-ledger";
import { isPaymentLedgerSchemaAvailable } from "@/lib/payment-schema";
import { getBusinessHoursPolicy } from "@/lib/policy";
import { extractQuoteFollowUpAppointmentId } from "@/lib/quote-followups";
import { soldByChangeRequiresOverride } from "@/lib/sold-by-override";
import {
  beginTeamMutation,
  TeamMutationFailure,
  type TeamMutationContext,
  type TeamMutationTransaction,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";

const CONVERT_REQUEST_MAXIMUM_BYTES = 32_768;
const MAXIMUM_CENTS = 2_147_483_647;
const APPOINTMENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const CrewMemberSchema = z
  .object({
    memberId: z.string().uuid(),
    splitBps: z.number().int().min(0).max(10_000),
  })
  .strict();

const CompletionSchema = z
  .object({
    finalTotalCents: z.number().int().min(0).max(MAXIMUM_CENTS).optional(),
    finalTotalSameAsQuoted: z.boolean().optional(),
    expectedFinalTotalCents: z
      .number()
      .int()
      .min(0)
      .max(MAXIMUM_CENTS)
      .nullable(),
    finalTotalChangeReason: z.string().trim().min(1).max(500).optional(),
    cardTipCents: z.number().int().min(0).max(MAXIMUM_CENTS).optional(),
    completedAt: z.string().trim().min(1).max(100).optional(),
    marketingMemberId: z.string().uuid().nullable().optional(),
    crew: z.string().trim().max(200).nullable().optional(),
    owner: z.string().trim().max(200).nullable().optional(),
    crewMembers: z.array(CrewMemberSchema).min(1).max(50),
  })
  .strict();

const ConvertSchema = z
  .object({
    startAt: z.string().trim().min(1).max(100),
    soldByMemberId: z.string().uuid(),
    expectedSoldByMemberId: z.string().uuid().nullable(),
    expectedAssignedSalespersonMemberId: z.string().uuid().nullable(),
    quotedTotalCents: z.number().int().min(0).max(MAXIMUM_CENTS).nullable(),
    bookingDetails: z.unknown(),
    expectedStatus: z.enum([
      "requested",
      "confirmed",
      "completed",
      "no_show",
      "canceled",
    ]),
    completion: CompletionSchema.optional(),
  })
  .strict();

type RouteContext = { params: Promise<{ id?: string }> };
type ConvertInput = z.infer<typeof ConvertSchema>;
type ConvertFailureResult = Extract<MutationResult<never>, { ok: false }> & {
  current?: Record<string, unknown>;
};

type StoredConvertOutcome<T = unknown> = {
  result: MutationResult<T> & Record<string, unknown>;
  status: number;
};

function parseLocalOrIsoDateTime(value: string, timezone: string): Date | null {
  const trimmed = value.trim();
  const hasTimezone =
    /[zZ]$/u.test(trimmed) || /[+-]\d{2}:\d{2}$/u.test(trimmed);
  const dateTime = hasTimezone
    ? DateTime.fromISO(trimmed, { setZone: true })
    : DateTime.fromISO(trimmed, { zone: timezone });
  return dateTime.isValid ? dateTime.toUTC().toJSDate() : null;
}

function isConvertibleQuoteType(value: string | null | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return (
    normalized === "in_person_quote" || normalized === "in_person_estimate"
  );
}

function requireAppointmentVersion(value: string | null): string {
  if (
    value === null ||
    value === "*" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new TeamMutationFailure(
      "invalid",
      "The current appointment version is required before converting this quote.",
      {
        fieldErrors: {
          version: "Refresh the appointment and submit the conversion again.",
        },
      },
    );
  }
  return value;
}

function boundedRequestFailure(
  error: BoundedJsonRequestError,
): TeamMutationFailure {
  return new TeamMutationFailure("invalid", error.message, {
    status: error.status,
    fieldErrors: { request: "Send one bounded application/json object." },
  });
}

function conversionFailure(
  code: ConvertFailureResult["code"],
  message: string,
  options: {
    retryable?: boolean;
    fieldErrors?: Record<string, string>;
    current?: Record<string, unknown>;
  } = {},
): ConvertFailureResult {
  return {
    ok: false,
    code,
    message,
    retryable: options.retryable ?? false,
    ...(options.fieldErrors ? { fieldErrors: options.fieldErrors } : {}),
    ...(options.current ? { current: options.current } : {}),
  };
}

async function storeTerminalFailure(
  tx: TeamMutationTransaction,
  mutation: TeamMutationContext,
  claim: TeamMutationIdempotencyClaim,
  result: ConvertFailureResult,
  status: number,
): Promise<StoredConvertOutcome<never>> {
  await completeTeamMutationIdempotency(tx, mutation, claim, result, status);
  return { result, status };
}

function isFinalTotalCorrectionIntent(input: ConvertInput): boolean {
  const completion = input.completion;
  if (!completion || completion.expectedFinalTotalCents === null) return false;
  if (completion.finalTotalCents !== undefined) {
    return completion.finalTotalCents !== completion.expectedFinalTotalCents;
  }
  return completion.finalTotalSameAsQuoted === true;
}

function validateInputRelationships(input: ConvertInput): void {
  const completion = input.completion;
  if (!completion) return;
  if (
    completion.finalTotalCents !== undefined &&
    completion.finalTotalSameAsQuoted === true
  ) {
    throw new TeamMutationFailure(
      "invalid",
      "Choose either a final total or the quoted-total option, not both.",
      { fieldErrors: { finalTotalCents: "Submit one final-total choice." } },
    );
  }
  if (
    completion.finalTotalCents === undefined &&
    completion.finalTotalSameAsQuoted !== true
  ) {
    throw new TeamMutationFailure(
      "invalid",
      "Enter the final total before converting and completing the job.",
      { fieldErrors: { finalTotalCents: "Enter the final job total." } },
    );
  }
  if (
    completion.finalTotalChangeReason !== undefined &&
    !isFinalTotalCorrectionIntent(input)
  ) {
    throw new TeamMutationFailure(
      "invalid",
      "A correction reason is only accepted when changing an existing final total.",
      {
        fieldErrors: {
          finalTotalChangeReason: "Remove the unused correction reason.",
        },
      },
    );
  }
}

function executionPolicy(input: ConvertInput): ActionPolicy {
  const requiredPermissions: TeamPermission[] = [
    "appointments.update",
    "payments.collect",
  ];
  if (input.expectedStatus === "completed") {
    requiredPermissions.push("appointments.override_conflicts");
  }
  if (
    soldByChangeRequiresOverride({
      nextSoldByMemberId: input.soldByMemberId,
      currentSoldByMemberId: input.expectedSoldByMemberId,
      assignedSalespersonMemberId: input.expectedAssignedSalespersonMemberId,
    })
  ) {
    requiredPermissions.push("commissions.manage");
  }
  if (input.completion) {
    if (
      input.completion.completedAt !== undefined ||
      isFinalTotalCorrectionIntent(input)
    ) {
      requiredPermissions.push("payments.manage");
    }
  }
  return {
    principalTypes: ["human"],
    requiredPermissions,
    risk: "financial",
    requiresIdempotency: true,
    auditAction: "appointment.converted",
  };
}

export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  // This verified-human boundary intentionally precedes params, URL parsing,
  // body parsing, and database access. A second boundary below applies the
  // input-specific money and workflow-override permissions before any read.
  const baseBoundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["appointments.update", "payments.collect"],
    risk: "financial",
    requiresIdempotency: true,
    auditAction: "appointment.converted",
  } satisfies ActionPolicy);
  if (!baseBoundary.ok) return baseBoundary.response;
  let mutation = baseBoundary.mutation;

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    if (request.nextUrl.search.length > 0) {
      throw new TeamMutationFailure(
        "invalid",
        "Quote conversion requests do not accept query parameters.",
      );
    }

    const { id: rawAppointmentId } = await context.params;
    const appointmentId = rawAppointmentId?.normalize("NFKC").trim() ?? "";
    if (!APPOINTMENT_ID_PATTERN.test(appointmentId)) {
      throw new TeamMutationFailure(
        "invalid",
        "Choose a valid appointment before converting the quote.",
        { fieldErrors: { appointmentId: "Select a valid appointment." } },
      );
    }
    const expectedVersion = requireAppointmentVersion(mutation.expectedVersion);

    let body: unknown;
    try {
      body = await readBoundedJsonRequest(request, {
        maximumBytes: CONVERT_REQUEST_MAXIMUM_BYTES,
        deadlineMs: 8_000,
      });
    } catch (error) {
      if (error instanceof BoundedJsonRequestError) {
        throw boundedRequestFailure(error);
      }
      throw error;
    }
    const parsed = ConvertSchema.safeParse(body);
    if (!parsed.success) {
      throw new TeamMutationFailure(
        "invalid",
        "The quote conversion request is invalid.",
        {
          fieldErrors: {
            request: "Review the conversion fields and submit them again.",
          },
        },
      );
    }
    validateInputRelationships(parsed.data);

    const bookingDetails = parseAppointmentBookingDetails(
      parsed.data.bookingDetails,
    );
    if (!bookingDetails) {
      throw new TeamMutationFailure(
        "invalid",
        "The booking details are invalid.",
        { fieldErrors: { bookingDetails: "Review the booking details." } },
      );
    }
    const quotedTotalError = validateQuotedTotalForBookingDetails(
      bookingDetails,
      parsed.data.quotedTotalCents,
    );
    if (quotedTotalError) {
      throw new TeamMutationFailure(
        "invalid",
        "The booking details require a valid quoted total.",
        { fieldErrors: { quotedTotalCents: quotedTotalError } },
      );
    }

    const conversionPolicy = executionPolicy(parsed.data);
    const strongerBoundary = await beginTeamMutation(request, conversionPolicy);
    if (!strongerBoundary.ok) return strongerBoundary.response;
    mutation = strongerBoundary.mutation;
    if (mutation.expectedVersion !== expectedVersion) {
      throw new TeamMutationFailure(
        "invalid",
        "The appointment version changed during authorization.",
        { fieldErrors: { version: "Refresh and submit the change again." } },
      );
    }

    const calendarSyncRequested = isGoogleCalendarEnabled();
    if (calendarSyncRequested) {
      // Conversion remains classified at its maximum financial risk, while
      // this independent boundary ensures the external-change emergency stop
      // also blocks before any database write or Calendar outbox enqueue.
      const externalCalendarBoundary = await beginTeamMutation(request, {
        ...conversionPolicy,
        risk: "external",
        auditAction: "appointment.calendar_sync_requested",
      });
      if (!externalCalendarBoundary.ok) {
        return externalCalendarBoundary.response;
      }
    }

    // Resolve server-owned payout configuration only after every effective
    // permission and kill-switch boundary has passed. This keeps denied
    // conversion attempts from reading business configuration or opening the
    // database at all.
    const database = getDb();
    db = database;
    let crewMembers: Array<{ memberId: string; splitBps: number }> | undefined;
    if (parsed.data.completion) {
      const resolvedCrew = await resolveConfiguredCrewPayout(
        database,
        parsed.data.completion.crewMembers.map((entry) => entry.memberId),
      );
      if (!resolvedCrew.ok || resolvedCrew.splits.length === 0) {
        throw new TeamMutationFailure(
          "conflict",
          "Crew payout configuration is unavailable. No conversion was saved; ask an owner to repair Payroll settings.",
          {
            fieldErrors: {
              crewMembers:
                "Payroll crew recipients require administrator review.",
            },
          },
        );
      }
      crewMembers = resolvedCrew.splits;
    }

    const claimPayload = {
      startAt: parsed.data.startAt,
      soldByMemberId: parsed.data.soldByMemberId,
      expectedSoldByMemberId: parsed.data.expectedSoldByMemberId,
      expectedAssignedSalespersonMemberId:
        parsed.data.expectedAssignedSalespersonMemberId,
      quotedTotalCents: parsed.data.quotedTotalCents,
      bookingDetails,
      expectedStatus: parsed.data.expectedStatus,
      calendarSyncRequested,
      ...(parsed.data.completion
        ? {
            completion: {
              ...parsed.data.completion,
              crewMembers,
            },
          }
        : {}),
    };

    const claimed = await claimTeamMutationIdempotency(database, mutation, {
      route: "POST /api/appointments/:appointmentId/convert",
      entityType: "appointment",
      entityId: appointmentId,
      payload: claimPayload,
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const outcome = await database.transaction(async (tx) => {
      // Match the lock order used by booking and rescheduling so concurrent
      // schedule changes cannot both observe available capacity or deadlock.
      await acquireScheduleConflictLock(tx);

      const attributionMemberIds = Array.from(
        new Set([
          parsed.data.soldByMemberId,
          ...(crewMembers?.map((member) => member.memberId) ?? []),
          ...(parsed.data.completion?.marketingMemberId
            ? [parsed.data.completion.marketingMemberId]
            : []),
        ]),
      );
      const activeAttributionMembers = await tx
        .select({ id: teamMembers.id })
        .from(teamMembers)
        .where(
          and(
            inArray(teamMembers.id, attributionMemberIds),
            eq(teamMembers.active, true),
          ),
        )
        // Keep selected members active through the conversion commit.
        .for("share");
      const activeAttributionMemberIds = new Set(
        activeAttributionMembers.map((member) => member.id),
      );
      const attributionValidation = validateActiveAppointmentAttribution({
        activeMemberIds: activeAttributionMemberIds,
        soldByMemberId: parsed.data.soldByMemberId,
        crewMemberIds: crewMembers?.map((member) => member.memberId) ?? [],
        marketingMemberId: parsed.data.completion?.marketingMemberId ?? null,
      });
      if (!attributionValidation.ok) {
        const copy = {
          soldByMemberId: {
            message:
              "Choose an active team member as the seller before converting the quote.",
            field: "The selected seller is inactive or missing.",
          },
          crewMembers: {
            message:
              "Every selected crew member must be active before completing the converted job.",
            field: "Remove inactive or missing crew members.",
          },
          marketingMemberId: {
            message:
              "Choose an active marketing team member before completing the converted job.",
            field: "The selected marketing member is inactive or missing.",
          },
        }[attributionValidation.field];
        return storeTerminalFailure(
          tx,
          mutation,
          claimed.claim,
          conversionFailure("invalid", copy.message, {
            fieldErrors: { [attributionValidation.field]: copy.field },
          }),
          422,
        );
      }

      const [existing] = await tx
        .select({
          id: appointments.id,
          type: appointments.type,
          status: appointments.status,
          startAt: appointments.startAt,
          durationMinutes: appointments.durationMinutes,
          soldByMemberId: appointments.soldByMemberId,
          leadId: appointments.leadId,
          contactId: appointments.contactId,
          calendarEventId: appointments.calendarEventId,
          quotedTotalCents: appointments.quotedTotalCents,
          finalTotalCents: appointments.finalTotalCents,
          cardTipCents: appointments.cardTipCents,
          completedAt: appointments.completedAt,
          marketingMemberId: appointments.marketingMemberId,
          updatedAt: appointments.updatedAt,
          assignedSalespersonMemberId: contacts.salespersonMemberId,
        })
        .from(appointments)
        .leftJoin(contacts, eq(appointments.contactId, contacts.id))
        .where(eq(appointments.id, appointmentId))
        // PostgreSQL cannot lock the nullable side of this outer join.
        .for("update", { of: appointments })
        .limit(1);

      if (!existing) {
        return storeTerminalFailure(
          tx,
          mutation,
          claimed.claim,
          conversionFailure("invalid", "The appointment no longer exists."),
          404,
        );
      }
      const currentVersion = existing.updatedAt.toISOString();
      if (currentVersion !== expectedVersion) {
        return storeTerminalFailure(
          tx,
          mutation,
          claimed.claim,
          conversionFailure(
            "conflict",
            "This appointment changed on another screen. Refresh it before converting the quote.",
            {
              fieldErrors: {
                version: "The submitted appointment version is stale.",
              },
              current: {
                version: currentVersion,
                status: existing.status,
                type: existing.type,
              },
            },
          ),
          409,
        );
      }
      if (existing.status !== parsed.data.expectedStatus) {
        return storeTerminalFailure(
          tx,
          mutation,
          claimed.claim,
          conversionFailure(
            "conflict",
            "The appointment status changed before conversion. Refresh and review it.",
            {
              fieldErrors: { status: "Review the latest appointment status." },
              current: { version: currentVersion, status: existing.status },
            },
          ),
          409,
        );
      }
      if (
        existing.soldByMemberId !== parsed.data.expectedSoldByMemberId ||
        existing.assignedSalespersonMemberId !==
          parsed.data.expectedAssignedSalespersonMemberId
      ) {
        return storeTerminalFailure(
          tx,
          mutation,
          claimed.claim,
          conversionFailure(
            "conflict",
            "Seller attribution changed on another screen. Refresh and review it before converting the quote.",
            {
              fieldErrors: {
                soldByMemberId: "Review the latest assigned seller.",
              },
              current: {
                version: currentVersion,
                soldByMemberId: existing.soldByMemberId,
                assignedSalespersonMemberId:
                  existing.assignedSalespersonMemberId,
              },
            },
          ),
          409,
        );
      }
      if (!isConvertibleQuoteType(existing.type)) {
        return storeTerminalFailure(
          tx,
          mutation,
          claimed.claim,
          conversionFailure(
            "conflict",
            "This appointment is already a job or is not an in-person quote.",
            { current: { version: currentVersion, type: existing.type } },
          ),
          409,
        );
      }
      if (existing.status === "canceled" || existing.status === "no_show") {
        return storeTerminalFailure(
          tx,
          mutation,
          claimed.claim,
          conversionFailure(
            "conflict",
            "Canceled and no-show quotes must be reopened before conversion.",
            { current: { version: currentVersion, status: existing.status } },
          ),
          409,
        );
      }

      const businessHours = await getBusinessHoursPolicy(tx);
      const timezone =
        businessHours.timezone ||
        process.env["APPOINTMENT_TIMEZONE"] ||
        "America/New_York";
      const startAt = parseLocalOrIsoDateTime(parsed.data.startAt, timezone);
      if (!startAt) {
        return storeTerminalFailure(
          tx,
          mutation,
          claimed.claim,
          conversionFailure("invalid", "Enter a valid job start time.", {
            fieldErrors: { startAt: "Enter a valid date and time." },
          }),
          422,
        );
      }

      if (existing.startAt?.getTime() !== startAt.getTime()) {
        const scheduleDecision = await inspectScheduleConflicts(tx, {
          startAt,
          durationMinutes: existing.durationMinutes,
          capacity: getAppointmentCapacity(),
          excludeAppointmentId: appointmentId,
        });
        if (scheduleDecision.conflict) {
          return storeTerminalFailure(
            tx,
            mutation,
            claimed.claim,
            conversionFailure("conflict", scheduleDecision.message, {
              fieldErrors: {
                startAt:
                  "Choose another time; this time exceeds scheduling capacity.",
              },
              current: {
                conflictFingerprint: scheduleDecision.fingerprint,
                capacity: scheduleDecision.capacity,
                overlappingCount: scheduleDecision.overlappingCount,
                conflicts: scheduleDecision.conflicts.map((conflict) => ({
                  id: conflict.id,
                  kind: conflict.kind,
                  startAt: conflict.startAt,
                  endAt: conflict.endAt,
                })),
              },
            }),
            409,
          );
        }
      }

      const targetStatus = parsed.data.completion ? "completed" : "confirmed";
      try {
        await assertAppointmentStatusTransitionAllowed({
          appointmentId,
          nextStatus: targetStatus,
          database: tx,
        });
      } catch (error) {
        if (
          error instanceof AppointmentMediaError &&
          error.code === "quoted_scope_required"
        ) {
          return storeTerminalFailure(
            tx,
            mutation,
            claimed.claim,
            conversionFailure(
              "conflict",
              "Add the quoted-to-remove summary before converting this quote.",
            ),
            409,
          );
        }
        throw error;
      }

      const sellerAttributionChanged = soldByChangeRequiresOverride({
        nextSoldByMemberId: parsed.data.soldByMemberId,
        currentSoldByMemberId: parsed.data.expectedSoldByMemberId,
        assignedSalespersonMemberId:
          parsed.data.expectedAssignedSalespersonMemberId,
      });

      const completion = parsed.data.completion;
      let completedAt: Date | null = null;
      let finalTotalCents = existing.finalTotalCents;
      let cardTipCents = existing.cardTipCents;
      if (completion) {
        if (completion.expectedFinalTotalCents !== existing.finalTotalCents) {
          return storeTerminalFailure(
            tx,
            mutation,
            claimed.claim,
            conversionFailure(
              "conflict",
              "The final job total changed on another screen. Refresh and review it before completing the job.",
              {
                fieldErrors: { finalTotalCents: "Review the latest total." },
                current: {
                  version: currentVersion,
                  finalTotalCents: existing.finalTotalCents,
                },
              },
            ),
            409,
          );
        }
        finalTotalCents =
          completion.finalTotalCents ?? parsed.data.quotedTotalCents;
        if (finalTotalCents === null) {
          return storeTerminalFailure(
            tx,
            mutation,
            claimed.claim,
            conversionFailure(
              "invalid",
              "Enter the final total before completing the converted job.",
              {
                fieldErrors: { finalTotalCents: "Enter the final job total." },
              },
            ),
            422,
          );
        }

        const paymentLedgerAvailable = await isPaymentLedgerSchemaAvailable(tx);
        if (!paymentLedgerAvailable) {
          throw new TeamMutationFailure(
            "internal",
            "Payment safety checks are temporarily unavailable. No conversion was saved; retry after the payment service recovers.",
            { status: 503, retryable: true },
          );
        }
        await expireStalePaymentAttemptsForAppointment(tx, appointmentId);
        const blockingAttempt = await getBlockingSquareAttempt(
          tx,
          appointmentId,
        );
        if (blockingAttempt) {
          return storeTerminalFailure(
            tx,
            mutation,
            claimed.claim,
            conversionFailure(
              "conflict",
              requiresSquareAttemptReconciliation(blockingAttempt.status)
                ? "An unresolved Square attempt must be reconciled before completing this conversion."
                : "Finish or reconcile the active Square attempt before completing this conversion.",
              { current: { paymentAttemptId: blockingAttempt.id } },
            ),
            409,
          );
        }

        const paymentLock = await getFinalTotalPaymentLock(tx, appointmentId, {
          schemaAvailable: true,
        });
        if (
          completion.cardTipCents !== undefined &&
          paymentLock.hasSuccessfulPayment
        ) {
          return storeTerminalFailure(
            tx,
            mutation,
            claimed.claim,
            conversionFailure(
              "conflict",
              "Card tips are synchronized from verified payments and cannot be edited here.",
            ),
            409,
          );
        }
        if (finalTotalCents !== existing.finalTotalCents) {
          const decision = validateFinalTotalChange({
            currentFinalTotalCents: existing.finalTotalCents,
            nextFinalTotalCents: finalTotalCents,
            paidTowardJobCents: paymentLock.paidTowardJobCents,
            hasSuccessfulPayment: paymentLock.hasSuccessfulPayment,
            canManagePayments:
              mutation.policy.requiredPermissions.includes("payments.manage"),
            changeReason: completion.finalTotalChangeReason,
          });
          if (!decision.ok) {
            const managementRequired =
              decision.code === "payment_management_required_after_payment";
            return storeTerminalFailure(
              tx,
              mutation,
              claimed.claim,
              conversionFailure(
                managementRequired ? "forbidden" : "conflict",
                decision.message,
              ),
              managementRequired ? 403 : 409,
            );
          }
        }
        if (completion.cardTipCents !== undefined) {
          cardTipCents = completion.cardTipCents;
        }
        completedAt = completion.completedAt
          ? parseLocalOrIsoDateTime(completion.completedAt, timezone)
          : new Date();
        if (!completedAt) {
          return storeTerminalFailure(
            tx,
            mutation,
            claimed.claim,
            conversionFailure("invalid", "Enter a valid completion time.", {
              fieldErrors: { completedAt: "Enter a valid date and time." },
            }),
            422,
          );
        }
      }

      const committedAt = new Date(
        Math.max(Date.now(), existing.updatedAt.getTime() + 1),
      );
      if (completion && !completion.completedAt) completedAt = committedAt;

      const [updated] = await tx
        .update(appointments)
        .set({
          type: "job",
          startAt,
          status: targetStatus,
          soldByMemberId: parsed.data.soldByMemberId,
          quotedTotalCents: parsed.data.quotedTotalCents,
          bookingDetails,
          ...(completion
            ? {
                finalTotalCents,
                cardTipCents,
                completedAt,
                ...(completion.crew !== undefined
                  ? { crew: completion.crew }
                  : {}),
                ...(completion.owner !== undefined
                  ? { owner: completion.owner }
                  : {}),
                ...(completion.marketingMemberId !== undefined
                  ? { marketingMemberId: completion.marketingMemberId }
                  : {}),
              }
            : { completedAt: null }),
          updatedAt: committedAt,
        })
        .where(
          and(
            eq(appointments.id, appointmentId),
            eq(appointments.updatedAt, existing.updatedAt),
          ),
        )
        .returning({
          id: appointments.id,
          leadId: appointments.leadId,
          contactId: appointments.contactId,
          calendarEventId: appointments.calendarEventId,
          status: appointments.status,
          type: appointments.type,
          startAt: appointments.startAt,
          updatedAt: appointments.updatedAt,
        });
      if (!updated) {
        throw new TeamMutationFailure(
          "conflict",
          "The appointment changed while conversion was being saved. No changes were committed; refresh and try again.",
          { retryable: true },
        );
      }

      if (crewMembers) {
        await tx
          .delete(appointmentCrewMembers)
          .where(eq(appointmentCrewMembers.appointmentId, appointmentId));
        await tx.insert(appointmentCrewMembers).values(
          crewMembers.map((entry) => ({
            appointmentId,
            memberId: entry.memberId,
            splitBps: entry.splitBps,
            createdAt: committedAt,
          })),
        );
      }

      if (updated.leadId) {
        await tx
          .update(leads)
          .set({ status: "scheduled", updatedAt: committedAt })
          .where(eq(leads.id, updated.leadId));
      }

      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`pipeline:${updated.contactId}`}, 0))`,
      );
      const [pipelineBefore] = await tx
        .select({ stage: crmPipeline.stage })
        .from(crmPipeline)
        .where(eq(crmPipeline.contactId, updated.contactId))
        .limit(1);
      const pipelineStage = targetStatus === "completed" ? "won" : "qualified";
      if (pipelineBefore?.stage !== pipelineStage) {
        await tx
          .insert(crmPipeline)
          .values({
            contactId: updated.contactId,
            stage: pipelineStage,
            updatedAt: committedAt,
          })
          .onConflictDoUpdate({
            target: crmPipeline.contactId,
            set: { stage: pipelineStage, updatedAt: committedAt },
          });
        await tx.insert(outboxEvents).values({
          type: "pipeline.auto_stage_change",
          payload: {
            contactId: updated.contactId,
            fromStage: pipelineBefore?.stage ?? null,
            toStage: pipelineStage,
            reason: "appointment.converted",
            meta: { appointmentId, targetStatus },
          },
        });
      }

      const openQuoteFollowUps = await tx
        .select({ id: crmTasks.id, notes: crmTasks.notes })
        .from(crmTasks)
        .where(
          and(
            eq(crmTasks.contactId, updated.contactId),
            eq(crmTasks.status, "open"),
            isNotNull(crmTasks.notes),
            ilike(crmTasks.notes, "%kind=quote_follow_up%"),
          ),
        );
      const matchingTaskIds = openQuoteFollowUps
        .filter(
          (task) =>
            extractQuoteFollowUpAppointmentId(task.notes) === appointmentId,
        )
        .map((task) => task.id);
      if (matchingTaskIds.length > 0) {
        await tx
          .update(crmTasks)
          .set({ status: "completed", updatedAt: committedAt })
          .where(inArray(crmTasks.id, matchingTaskIds));
      }

      const lifecycleStatusChanged = existing.status !== targetStatus;
      await tx.insert(outboxEvents).values({
        type: "estimate.status_changed",
        payload: {
          appointmentId,
          leadId: updated.leadId,
          status: targetStatus,
          // Conversion has its own explicit approval boundary. Retain this
          // event for internal lifecycle work, but never let the generic
          // status handler turn it into an unapproved customer message.
          statusChanged: false,
          lifecycleStatusChanged,
          refreshCommissions: Boolean(completion),
          calendarEventId: null,
          correlationId: mutation.correlationId,
          version: updated.updatedAt.toISOString(),
          conversion: true,
          pipelineAlreadyApplied: true,
        },
      });

      const calendarSync = calendarSyncRequested ? "requested" : "not_required";
      if (calendarSync === "requested") {
        await tx.insert(outboxEvents).values({
          type: "appointment.calendar_sync_requested",
          payload: {
            appointmentId,
            requestedCalendarEventId: updated.calendarEventId,
            version: updated.updatedAt.toISOString(),
            correlationId: mutation.correlationId,
            reason: "appointment.converted",
          },
        });
      }
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "appointment",
        entityId: appointmentId,
        before: {
          type: existing.type,
          status: existing.status,
          startAt: existing.startAt?.toISOString() ?? null,
          soldByMemberId: existing.soldByMemberId,
          quotedTotalCents: existing.quotedTotalCents,
          finalTotalCents: existing.finalTotalCents,
          cardTipCents: existing.cardTipCents,
          completedAt: existing.completedAt?.toISOString() ?? null,
          marketingMemberId: existing.marketingMemberId,
          version: currentVersion,
        },
        after: {
          type: "job",
          status: targetStatus,
          startAt: startAt.toISOString(),
          soldByMemberId: parsed.data.soldByMemberId,
          quotedTotalCents: parsed.data.quotedTotalCents,
          finalTotalCents,
          cardTipCents,
          completedAt: completedAt?.toISOString() ?? null,
          ...(completion?.marketingMemberId !== undefined
            ? { marketingMemberId: completion.marketingMemberId }
            : {}),
          version: updated.updatedAt.toISOString(),
        },
        metadata: {
          sellerAttributionChanged,
          sellerChangePermissionChecked: sellerAttributionChanged,
          bookingDetailsChanged: true,
          completedAtomically: Boolean(completion),
          crewMembersCount: crewMembers?.length ?? 0,
          finalTotalChangeReasonProvided:
            completion?.finalTotalChangeReason !== undefined,
          paymentLedgerChecked: Boolean(completion),
          pipelineFrom: pipelineBefore?.stage ?? null,
          pipelineTo: pipelineStage,
          quoteFollowUpTasksCompleted: matchingTaskIds.length,
          calendarSync,
          calendarExternalSafetyChecked: calendarSyncRequested,
          reviewRequestQueued: false,
        },
        committedAt,
      });

      const data = {
        appointmentId,
        appointmentType: "job" as const,
        status: targetStatus,
        startAt: startAt.toISOString(),
        version: updated.updatedAt.toISOString(),
        calendarSync,
        completedAtomically: Boolean(completion),
      };
      const success = {
        ...teamMutationSuccessResult(mutation, data, {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "appointment",
          entityId: appointmentId,
          version: updated.updatedAt.toISOString(),
        }),
        appointmentId,
        appointmentType: "job" as const,
        status: targetStatus,
        startAt: startAt.toISOString(),
        version: updated.updatedAt.toISOString(),
        calendarSync,
      };
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
        success,
        200,
      );
      return { result: success, status: 200 } satisfies StoredConvertOutcome;
    });

    return teamMutationResultResponse(
      outcome.result,
      outcome.status,
      mutation.correlationId,
      { "Cache-Control": "private, no-store, max-age=0" },
    );
  } catch (error) {
    if (db && claim) {
      try {
        await settleTeamMutationIdempotencyFailure(db, mutation, claim, error);
      } catch (settlementError) {
        console.error("[appointment-convert] idempotency_settlement_failed", {
          operationId: mutation.operationId,
          correlationId: mutation.correlationId,
          errorName:
            settlementError instanceof Error
              ? settlementError.name
              : "UnknownError",
        });
      }
    }
    return teamMutationExceptionResponse(error, mutation);
  }
}
