import type {
  ActionPolicy,
  MutationResult,
  TeamPermission,
} from "@myst-os/sdk";
import type { NextRequest } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { DateTime } from "luxon";
import { z } from "zod";
import {
  appointmentCrewMembers,
  appointments,
  getDb,
  leads,
  outboxEvents,
  teamMembers,
} from "@/db";
import {
  AppointmentMediaError,
  assertAppointmentStatusTransitionAllowed,
} from "@/lib/appointment-media";
import {
  parseAppointmentBookingDetails,
  validateQuotedTotalForBookingDetails,
} from "@/lib/appointment-booking-details";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  type TeamMutationIdempotencyClaim,
  teamMutationIdempotencyReplayResponse,
} from "@/lib/team-mutation-idempotency";
import {
  lockCompletedAppointmentPayoutPeriodInTransaction,
  recalculateAppointmentCommissionsAndRefreshDraftPayoutsInTransaction,
  resolveConfiguredCrewPayout,
} from "@/lib/commissions";
import {
  expireStalePaymentAttemptsForAppointment,
  getBlockingSquareAttempt,
  getFinalTotalPaymentLock,
  requiresSquareAttemptReconciliation,
  validateFinalTotalChange,
} from "@/lib/payment-ledger";
import { isPaymentLedgerSchemaAvailable } from "@/lib/payment-schema";
import {
  beginTeamMutation,
  TeamMutationFailure,
  type TeamMutationContext,
  type TeamMutationTransaction,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";
import { getTeamOperationKillSwitchForRisk } from "@/lib/team-operation-kill-switch";

const STATUS_REQUEST_MAXIMUM_BYTES = 32_768;
const MAXIMUM_CENTS = 2_147_483_647;
const APPOINTMENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const BASE_STATUS_POLICY = {
  principalTypes: ["human"],
  requiredPermissions: ["appointments.update"],
  risk: "normal",
  requiresIdempotency: true,
  auditAction: "appointment.status.updated",
} satisfies ActionPolicy;

const PAYMENT_STATUS_POLICY = {
  ...BASE_STATUS_POLICY,
  requiredPermissions: ["appointments.update", "payments.collect"],
  risk: "financial",
} satisfies ActionPolicy;

const COMPLETION_OVERRIDE_STATUS_POLICY = {
  ...BASE_STATUS_POLICY,
  requiredPermissions: ["appointments.update", "payments.manage"],
  risk: "financial",
} satisfies ActionPolicy;

const PAYMENT_AND_COMPLETION_OVERRIDE_STATUS_POLICY = {
  ...BASE_STATUS_POLICY,
  requiredPermissions: [
    "appointments.update",
    "payments.collect",
    "payments.manage",
  ],
  risk: "financial",
} satisfies ActionPolicy;

const CrewMemberSchema = z
  .object({
    memberId: z.string().uuid(),
    splitBps: z.number().int().min(0).max(10_000),
  })
  .strict();

const StatusSchema = z
  .object({
    status: z.enum([
      "requested",
      "confirmed",
      "completed",
      "no_show",
      "canceled",
    ]),
    crew: z.string().trim().max(200).optional().nullable(),
    owner: z.string().trim().max(200).optional().nullable(),
    marketingMemberId: z.string().uuid().optional().nullable(),
    quotedTotalCents: z
      .number()
      .int()
      .min(0)
      .max(MAXIMUM_CENTS)
      .nullable()
      .optional(),
    bookingDetails: z.unknown().optional(),
    finalTotalCents: z.number().int().min(0).max(MAXIMUM_CENTS).optional(),
    expectedFinalTotalCents: z
      .number()
      .int()
      .min(0)
      .max(MAXIMUM_CENTS)
      .nullable()
      .optional(),
    finalTotalChangeReason: z.string().trim().min(1).max(500).optional(),
    cardTipCents: z.number().int().min(0).max(MAXIMUM_CENTS).optional(),
    finalTotalSameAsQuoted: z.boolean().optional(),
    sendCustomerNotification: z.boolean().optional().default(false),
    sendReviewRequest: z.boolean().optional().default(false),
    // Kept during the canonical-route migration so current callers can send
    // their duplicate version field. If-Match remains authoritative and the
    // two values must be byte-for-byte identical after header normalization.
    expectedVersion: z.string().trim().max(100).optional(),
    completedAt: z.string().trim().min(1).max(100).optional(),
    crewMembers: z.array(CrewMemberSchema).max(50).optional(),
  })
  .strict();

type RouteContext = { params: Promise<{ id?: string }> };
type StatusFailureResult = Extract<MutationResult<never>, { ok: false }> & {
  /** Temporary compatibility alias for callers still reading `error`. */
  error: string;
  attemptId?: string;
  currentVersion?: string;
  currentFinalTotalCents?: number | null;
  current?: Record<string, unknown>;
};

type StoredStatusOutcome<T = unknown> = {
  result: MutationResult<T> & Record<string, unknown>;
  status: number;
};

function parseLocalOrIsoDateTime(value: string, timezone: string): Date | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const hasTimezone =
    /[zZ]$/u.test(trimmed) || /[+-]\d{2}:\d{2}$/u.test(trimmed);
  const dateTime = hasTimezone
    ? DateTime.fromISO(trimmed, { setZone: true })
    : DateTime.fromISO(trimmed, { zone: timezone });
  return dateTime.isValid ? dateTime.toUTC().toJSDate() : null;
}

function isQuoteOnlyAppointmentType(value: string | null | undefined): boolean {
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
      "The current appointment version is required before changing its status.",
      {
        fieldErrors: {
          version: "Refresh the appointment and submit the change again.",
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

function statusFailure(
  code: StatusFailureResult["code"],
  error: string,
  message: string,
  options: {
    retryable?: boolean;
    fieldErrors?: Record<string, string>;
    extra?: Omit<
      StatusFailureResult,
      "ok" | "code" | "error" | "message" | "retryable" | "fieldErrors"
    >;
  } = {},
): StatusFailureResult {
  return {
    ok: false,
    code,
    error,
    message,
    retryable: options.retryable ?? false,
    ...(options.fieldErrors ? { fieldErrors: options.fieldErrors } : {}),
    ...(options.extra ?? {}),
  };
}

async function storeTerminalFailure(
  tx: TeamMutationTransaction,
  mutation: TeamMutationContext,
  claim: TeamMutationIdempotencyClaim,
  result: StatusFailureResult,
  status: number,
): Promise<StoredStatusOutcome<never>> {
  await completeTeamMutationIdempotency(tx, mutation, claim, result, status);
  return { result, status };
}

async function readExistingCrewMembers(
  tx: TeamMutationTransaction,
  appointmentId: string,
): Promise<Array<{ memberId: string; splitBps: number }>> {
  return tx
    .select({
      memberId: appointmentCrewMembers.memberId,
      splitBps: appointmentCrewMembers.splitBps,
    })
    .from(appointmentCrewMembers)
    .where(eq(appointmentCrewMembers.appointmentId, appointmentId));
}

function includesFinancialChanges(
  input: z.infer<typeof StatusSchema>,
): boolean {
  return (
    input.quotedTotalCents !== undefined ||
    input.bookingDetails !== undefined ||
    input.finalTotalCents !== undefined ||
    input.finalTotalSameAsQuoted !== undefined ||
    input.cardTipCents !== undefined
  );
}

function changesCompletedCommissionSource(
  input: z.infer<typeof StatusSchema>,
): boolean {
  return (
    input.status !== "completed" ||
    input.crewMembers !== undefined ||
    input.marketingMemberId !== undefined ||
    input.bookingDetails !== undefined ||
    input.quotedTotalCents !== undefined ||
    input.finalTotalCents !== undefined ||
    input.finalTotalSameAsQuoted !== undefined ||
    input.completedAt !== undefined
  );
}

function validateInputRelationships(
  input: z.infer<typeof StatusSchema>,
  expectedVersion: string,
): void {
  if (
    input.expectedVersion !== undefined &&
    input.expectedVersion !== expectedVersion
  ) {
    throw new TeamMutationFailure(
      "invalid",
      "The body version and If-Match version do not agree.",
      { fieldErrors: { version: "Send one matching appointment version." } },
    );
  }
  if (input.completedAt !== undefined && input.status !== "completed") {
    throw new TeamMutationFailure(
      "invalid",
      "A completion time can only be supplied when marking an appointment complete.",
      { fieldErrors: { completedAt: "Choose the completed status first." } },
    );
  }
  if (
    input.status !== "completed" &&
    (input.finalTotalCents !== undefined ||
      input.expectedFinalTotalCents !== undefined ||
      input.finalTotalSameAsQuoted !== undefined ||
      input.finalTotalChangeReason !== undefined ||
      input.cardTipCents !== undefined)
  ) {
    throw new TeamMutationFailure(
      "invalid",
      "Final totals and tips can only be changed while completing an appointment.",
      { fieldErrors: { status: "Choose the completed status first." } },
    );
  }
  if (
    input.finalTotalCents !== undefined &&
    input.finalTotalSameAsQuoted === true
  ) {
    throw new TeamMutationFailure(
      "invalid",
      "Choose either a final total or the quoted-total option, not both.",
      { fieldErrors: { finalTotalCents: "Submit one final-total choice." } },
    );
  }
  const requestsFinalTotal =
    input.finalTotalCents !== undefined ||
    input.finalTotalSameAsQuoted === true;
  if (requestsFinalTotal && input.expectedFinalTotalCents === undefined) {
    throw new TeamMutationFailure(
      "invalid",
      "The current final total is required before changing it.",
      {
        fieldErrors: {
          expectedFinalTotalCents:
            "Refresh the appointment and submit the latest total.",
        },
      },
    );
  }
  if (!requestsFinalTotal && input.expectedFinalTotalCents !== undefined) {
    throw new TeamMutationFailure(
      "invalid",
      "A current final total was supplied without a requested total change.",
      {
        fieldErrors: {
          expectedFinalTotalCents: "Submit a final-total choice as well.",
        },
      },
    );
  }
  if (!requestsFinalTotal && input.finalTotalChangeReason !== undefined) {
    throw new TeamMutationFailure(
      "invalid",
      "A final-total reason was supplied without a requested total change.",
      {
        fieldErrors: {
          finalTotalChangeReason: "Submit a final-total change as well.",
        },
      },
    );
  }
  const hasBookingDetails = input.bookingDetails !== undefined;
  const hasQuotedTotal = input.quotedTotalCents !== undefined;
  if (hasBookingDetails !== hasQuotedTotal) {
    throw new TeamMutationFailure(
      "invalid",
      "Booking details and their quoted total must be submitted together.",
      {
        fieldErrors: {
          bookingDetails: "Submit the complete booking-details update.",
        },
      },
    );
  }
  if (hasBookingDetails && input.status !== "completed") {
    throw new TeamMutationFailure(
      "invalid",
      "Booking details can only be updated as part of job completion.",
      {
        fieldErrors: {
          status: "Complete the job before saving its final booking details.",
        },
      },
    );
  }
  if (input.sendCustomerNotification && input.status !== "canceled") {
    throw new TeamMutationFailure(
      "invalid",
      "A customer status notice is only available when canceling an appointment.",
      {
        fieldErrors: {
          sendCustomerNotification:
            "Turn this off unless the appointment is being canceled.",
        },
      },
    );
  }
  if (input.sendReviewRequest && input.status !== "completed") {
    throw new TeamMutationFailure(
      "invalid",
      "A review request can only be requested while completing a job.",
      {
        fieldErrors: {
          sendReviewRequest: "Choose the completed status first.",
        },
      },
    );
  }
}

function buildExecutionPolicy(input: {
  hasFinancialChanges: boolean;
  requiresPaymentManagement: boolean;
  requiresCommissionManagement: boolean;
  status: z.infer<typeof StatusSchema>["status"];
  sendsCustomerMessage: boolean;
}): ActionPolicy | null {
  let policy: ActionPolicy | null = input.hasFinancialChanges
    ? input.requiresPaymentManagement
      ? PAYMENT_AND_COMPLETION_OVERRIDE_STATUS_POLICY
      : PAYMENT_STATUS_POLICY
    : input.requiresPaymentManagement
      ? COMPLETION_OVERRIDE_STATUS_POLICY
      : null;

  const requiredPermissions: TeamPermission[] = [
    ...(policy?.requiredPermissions ?? BASE_STATUS_POLICY.requiredPermissions),
  ];
  if (
    input.sendsCustomerMessage &&
    !requiredPermissions.includes("messages.send")
  ) {
    requiredPermissions.push("messages.send");
  }
  if (
    input.requiresCommissionManagement &&
    !requiredPermissions.includes("commissions.manage")
  ) {
    requiredPermissions.push("commissions.manage");
  }

  // Cancellation can delete a linked Google Calendar event. It therefore
  // crosses the external-effect boundary even when the operator deliberately
  // leaves the customer-notification checkbox off.
  const requiresExternalBoundary =
    input.sendsCustomerMessage || input.status === "canceled";
  if (
    !policy &&
    !requiresExternalBoundary &&
    !input.requiresCommissionManagement
  ) {
    return null;
  }

  policy = {
    ...BASE_STATUS_POLICY,
    requiredPermissions,
    risk:
      policy?.risk === "financial" || input.requiresCommissionManagement
        ? "financial"
        : requiresExternalBoundary
          ? "external"
          : "normal",
  };
  return policy;
}

function buildMessageAuthorizationEvidence(
  mutation: TeamMutationContext,
  auditEventId: string,
): Record<string, string> {
  if (
    mutation.principalType !== "human" ||
    !mutation.actor.id ||
    !mutation.actor.sessionId ||
    (mutation.actor.authMethod !== "team_session" &&
      mutation.actor.authMethod !== "break_glass") ||
    !mutation.policy.requiredPermissions.includes("messages.send")
  ) {
    throw new TeamMutationFailure(
      "internal",
      "The customer-message authorization receipt could not be created. No appointment changes were saved.",
    );
  }
  return {
    auditEventId,
    actorId: mutation.actor.id,
    sessionId: mutation.actor.sessionId,
    authMethod: mutation.actor.authMethod,
    correlationId: mutation.correlationId,
    operationId: mutation.operationId,
    requiredPermission: "messages.send",
  };
}

function isFinalTotalCorrectionIntent(
  input: z.infer<typeof StatusSchema>,
): boolean {
  if (
    input.finalTotalCents === undefined &&
    input.finalTotalSameAsQuoted !== true
  ) {
    return false;
  }
  if (input.expectedFinalTotalCents === null) return false;
  if (input.finalTotalCents !== undefined) {
    return input.finalTotalCents !== input.expectedFinalTotalCents;
  }
  // The quoted total is database-owned and deliberately not trusted from the
  // client. An existing final total plus "same as quoted" is therefore a
  // fail-closed correction intent which requires payments.manage.
  return true;
}

export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  // This boundary deliberately runs before params, URL state, body parsing, or
  // database access. Money and completion-time payloads pass a second,
  // stricter boundary below so the durable audit snapshots their strongest
  // effective permission set.
  const baseBoundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["appointments.update"],
    risk: "normal",
    requiresIdempotency: true,
    auditAction: "appointment.status.updated",
  } satisfies ActionPolicy);
  if (!baseBoundary.ok) return baseBoundary.response;
  let mutation = baseBoundary.mutation;

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    if (request.nextUrl.search.length > 0) {
      throw new TeamMutationFailure(
        "invalid",
        "Appointment status requests do not accept query parameters.",
      );
    }

    const { id: rawAppointmentId } = await context.params;
    const appointmentId = rawAppointmentId?.normalize("NFKC").trim() ?? "";
    if (!APPOINTMENT_ID_PATTERN.test(appointmentId)) {
      throw new TeamMutationFailure(
        "invalid",
        "Choose a valid appointment before changing its status.",
        { fieldErrors: { appointmentId: "Select a valid appointment." } },
      );
    }
    const expectedVersion = requireAppointmentVersion(mutation.expectedVersion);

    let input: unknown;
    try {
      input = await readBoundedJsonRequest(request, {
        maximumBytes: STATUS_REQUEST_MAXIMUM_BYTES,
        deadlineMs: 8_000,
      });
    } catch (error) {
      if (error instanceof BoundedJsonRequestError) {
        throw boundedRequestFailure(error);
      }
      throw error;
    }
    const parsed = StatusSchema.safeParse(input);
    if (!parsed.success) {
      throw new TeamMutationFailure(
        "invalid",
        "The appointment status request is invalid.",
        {
          fieldErrors: {
            request: "Review the status fields and submit them again.",
          },
        },
      );
    }
    validateInputRelationships(parsed.data, expectedVersion);

    let bookingDetailsUpdate:
      | NonNullable<ReturnType<typeof parseAppointmentBookingDetails>>
      | undefined;
    if (parsed.data.bookingDetails !== undefined) {
      const bookingDetails = parseAppointmentBookingDetails(
        parsed.data.bookingDetails,
      );
      if (!bookingDetails) {
        throw new TeamMutationFailure(
          "invalid",
          "The booking details are invalid.",
          {
            fieldErrors: {
              bookingDetails: "Review the booking details and submit again.",
            },
          },
        );
      }
      const quotedTotalError = validateQuotedTotalForBookingDetails(
        bookingDetails,
        parsed.data.quotedTotalCents ?? null,
      );
      if (quotedTotalError) {
        throw new TeamMutationFailure(
          "invalid",
          "The booking details require a valid quoted total.",
          {
            fieldErrors: {
              quotedTotalCents: quotedTotalError,
            },
          },
        );
      }
      bookingDetailsUpdate = bookingDetails;
    }

    const hasFinancialChanges = includesFinancialChanges(parsed.data);
    const hasCompletionTimeOverride = parsed.data.completedAt !== undefined;
    const hasFinalTotalCorrection = isFinalTotalCorrectionIntent(parsed.data);
    const requiresPaymentManagement =
      hasCompletionTimeOverride || hasFinalTotalCorrection;
    const sendsCustomerMessage =
      parsed.data.sendCustomerNotification || parsed.data.sendReviewRequest;
    const database = getDb();
    db = database;
    const [policyAppointment] = await database
      .select({
        status: appointments.status,
        updatedAt: appointments.updatedAt,
      })
      .from(appointments)
      .where(eq(appointments.id, appointmentId))
      .limit(1);
    // A replay carries the version from before the successful operation. Do
    // not invent a stronger correction permission for that stale version; the
    // idempotency store will replay it, while a new stale key still fails the
    // transaction's exact version check before any write.
    const requiresCommissionManagement = Boolean(
      policyAppointment?.status === "completed" &&
        policyAppointment.updatedAt.toISOString() === expectedVersion &&
        changesCompletedCommissionSource(parsed.data),
    );
    const executionPolicy = buildExecutionPolicy({
      hasFinancialChanges,
      requiresPaymentManagement,
      requiresCommissionManagement,
      status: parsed.data.status,
      sendsCustomerMessage,
    });
    if (executionPolicy) {
      const executionBoundary = await beginTeamMutation(
        request,
        executionPolicy,
      );
      if (!executionBoundary.ok) return executionBoundary.response;
      mutation = executionBoundary.mutation;
      // Both boundaries read the same concrete If-Match value. Keep this guard
      // explicit in case the shared boundary ever gains request-local state.
      if (mutation.expectedVersion !== expectedVersion) {
        throw new TeamMutationFailure(
          "invalid",
          "The appointment version changed during authorization.",
          { fieldErrors: { version: "Refresh and submit the change again." } },
        );
      }
    }
    if (
      parsed.data.status === "canceled" &&
      getTeamOperationKillSwitchForRisk("external") !== null
    ) {
      throw new TeamMutationFailure(
        "forbidden",
        "Appointment cancellation is temporarily disabled because Google Calendar cleanup cannot be requested safely.",
        { status: 503, retryable: false },
      );
    }

    const canManagePayments =
      mutation.policy.requiredPermissions.includes("payments.manage");
    let completedAtOverride: Date | undefined;
    if (parsed.data.completedAt !== undefined) {
      completedAtOverride =
        parseLocalOrIsoDateTime(
          parsed.data.completedAt,
          process.env["APPOINTMENT_TIMEZONE"] ?? "America/New_York",
        ) ?? undefined;
      if (!completedAtOverride) {
        throw new TeamMutationFailure(
          "invalid",
          "Enter a valid completion time.",
          { fieldErrors: { completedAt: "Enter a valid date and time." } },
        );
      }
    }

    let crewMembers = parsed.data.crewMembers;
    if (crewMembers !== undefined) {
      const resolvedCrewPayout = await resolveConfiguredCrewPayout(
        database,
        crewMembers.map((entry) => entry.memberId),
      );
      if (!resolvedCrewPayout.ok) {
        throw new TeamMutationFailure(
          "conflict",
          "Crew payout configuration is unavailable. No completion was saved; ask an owner to repair Payroll settings.",
          {
            fieldErrors: {
              crewMembers:
                "Payroll crew recipients require administrator review.",
            },
          },
        );
      }
      crewMembers = resolvedCrewPayout.splits;
    }

    const status = parsed.data.status;
    const claimPayload = {
      status,
      ...(parsed.data.crew !== undefined ? { crew: parsed.data.crew } : {}),
      ...(parsed.data.owner !== undefined ? { owner: parsed.data.owner } : {}),
      ...(parsed.data.marketingMemberId !== undefined
        ? { marketingMemberId: parsed.data.marketingMemberId }
        : {}),
      ...(bookingDetailsUpdate !== undefined
        ? {
            quotedTotalCents: parsed.data.quotedTotalCents ?? null,
            bookingDetails: bookingDetailsUpdate,
          }
        : {}),
      ...(parsed.data.finalTotalCents !== undefined
        ? { finalTotalCents: parsed.data.finalTotalCents }
        : {}),
      ...(parsed.data.expectedFinalTotalCents !== undefined
        ? { expectedFinalTotalCents: parsed.data.expectedFinalTotalCents }
        : {}),
      ...(parsed.data.finalTotalChangeReason !== undefined
        ? { finalTotalChangeReason: parsed.data.finalTotalChangeReason }
        : {}),
      ...(parsed.data.cardTipCents !== undefined
        ? { cardTipCents: parsed.data.cardTipCents }
        : {}),
      ...(parsed.data.finalTotalSameAsQuoted !== undefined
        ? { finalTotalSameAsQuoted: parsed.data.finalTotalSameAsQuoted }
        : {}),
      ...(completedAtOverride
        ? { completedAt: completedAtOverride.toISOString() }
        : {}),
      ...(crewMembers !== undefined ? { crewMembers } : {}),
      sendCustomerNotification: parsed.data.sendCustomerNotification,
      sendReviewRequest: parsed.data.sendReviewRequest,
    };

    const claimed = await claimTeamMutationIdempotency(database, mutation, {
      route: "POST /api/appointments/:appointmentId/status",
      entityType: "appointment",
      entityId: appointmentId,
      payload: claimPayload,
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const outcome = await database.transaction(async (tx) => {
      // Payment attempts lock this same row before calculating a balance. This
      // lock serializes completion, crew, and total decisions with collection.
      const [existing] = await tx
        .select({
          id: appointments.id,
          leadId: appointments.leadId,
          type: appointments.type,
          calendarEventId: appointments.calendarEventId,
          quotedTotalCents: appointments.quotedTotalCents,
          bookingDetails: appointments.bookingDetails,
          finalTotalCents: appointments.finalTotalCents,
          cardTipCents: appointments.cardTipCents,
          status: appointments.status,
          completedAt: appointments.completedAt,
          marketingMemberId: appointments.marketingMemberId,
          updatedAt: appointments.updatedAt,
        })
        .from(appointments)
        .where(eq(appointments.id, appointmentId))
        .for("update")
        .limit(1);

      if (!existing) {
        return storeTerminalFailure(
          tx,
          mutation,
          claimed.claim,
          statusFailure(
            "invalid",
            "not_found",
            "The appointment no longer exists.",
          ),
          404,
        );
      }
      const currentVersion = existing.updatedAt.toISOString();
      if (currentVersion !== expectedVersion) {
        return storeTerminalFailure(
          tx,
          mutation,
          claimed.claim,
          statusFailure(
            "conflict",
            "appointment_changed",
            "This appointment changed on another screen. Refresh it and review the latest status, total, crew, and time before retrying.",
            {
              fieldErrors: {
                version: "The submitted appointment version is stale.",
              },
              extra: {
                currentVersion,
                current: { version: currentVersion },
              },
            },
          ),
          409,
        );
      }

      const submittedAttributionMemberIds = Array.from(
        new Set([
          ...(crewMembers?.map((member) => member.memberId) ?? []),
          ...(parsed.data.marketingMemberId
            ? [parsed.data.marketingMemberId]
            : []),
        ]),
      );
      const submittedAttributionMembers =
        submittedAttributionMemberIds.length > 0
          ? await tx
              .select({ id: teamMembers.id, active: teamMembers.active })
              .from(teamMembers)
              .where(inArray(teamMembers.id, submittedAttributionMemberIds))
              // Prevent deactivation or deletion until attribution and its
              // commission rows have committed.
              .for("share")
          : [];
      const activeAttributionMemberIds = new Set(
        submittedAttributionMembers
          .filter((member) => member.active)
          .map((member) => member.id),
      );
      const inactiveCrewMember = crewMembers?.find(
        (member) => !activeAttributionMemberIds.has(member.memberId),
      );
      if (inactiveCrewMember) {
        return storeTerminalFailure(
          tx,
          mutation,
          claimed.claim,
          statusFailure(
            "invalid",
            "inactive_crew_member",
            "Every selected crew member must still be active before this appointment can be saved.",
            {
              fieldErrors: {
                crewMembers: "Remove inactive or missing crew members.",
              },
            },
          ),
          422,
        );
      }
      if (
        parsed.data.marketingMemberId &&
        !activeAttributionMemberIds.has(parsed.data.marketingMemberId)
      ) {
        return storeTerminalFailure(
          tx,
          mutation,
          claimed.claim,
          statusFailure(
            "invalid",
            "inactive_marketing_member",
            "The selected marketing team member is inactive or no longer exists.",
            {
              fieldErrors: {
                marketingMemberId: "Choose an active team member.",
              },
            },
          ),
          422,
        );
      }

      const isQuoteOnly = isQuoteOnlyAppointmentType(existing.type);
      const existingCrewMembers =
        status === "completed" && !isQuoteOnly && crewMembers === undefined
          ? await readExistingCrewMembers(tx, appointmentId)
          : [];
      const effectiveCrewMembers =
        crewMembers !== undefined ? crewMembers : existingCrewMembers;
      if (
        status === "completed" &&
        !isQuoteOnly &&
        effectiveCrewMembers.length === 0
      ) {
        return storeTerminalFailure(
          tx,
          mutation,
          claimed.claim,
          statusFailure(
            "invalid",
            "crew_required",
            "Select at least one crew member before marking complete.",
            {
              fieldErrors: {
                crewMembers: "Select at least one crew member.",
              },
            },
          ),
          422,
        );
      }

      let finalTotalCentsToSet: number | null | undefined;
      const effectiveQuotedTotalCents =
        bookingDetailsUpdate === undefined
          ? existing.quotedTotalCents
          : (parsed.data.quotedTotalCents ?? null);
      if (status === "completed" && !isQuoteOnly) {
        if (parsed.data.finalTotalCents !== undefined) {
          finalTotalCentsToSet = parsed.data.finalTotalCents;
        } else if (parsed.data.finalTotalSameAsQuoted === true) {
          finalTotalCentsToSet = effectiveQuotedTotalCents;
        }
      }
      const effectiveFinalTotalCents =
        finalTotalCentsToSet === undefined
          ? existing.finalTotalCents
          : finalTotalCentsToSet;
      if (
        status === "completed" &&
        !isQuoteOnly &&
        parsed.data.expectedFinalTotalCents !== undefined &&
        parsed.data.expectedFinalTotalCents !== existing.finalTotalCents
      ) {
        return storeTerminalFailure(
          tx,
          mutation,
          claimed.claim,
          statusFailure(
            "conflict",
            "final_total_changed",
            "The final job total changed on another screen or phone. Review the current amount and try again.",
            {
              fieldErrors: {
                finalTotalCents: "Review the latest final job total.",
              },
              extra: {
                currentFinalTotalCents: existing.finalTotalCents,
                current: { finalTotalCents: existing.finalTotalCents },
              },
            },
          ),
          409,
        );
      }
      if (
        status === "completed" &&
        !isQuoteOnly &&
        effectiveFinalTotalCents === null
      ) {
        return storeTerminalFailure(
          tx,
          mutation,
          claimed.claim,
          statusFailure(
            "invalid",
            "final_total_required",
            "Enter the final job total before marking complete.",
            {
              fieldErrors: {
                finalTotalCents: "Enter the final job total.",
              },
            },
          ),
          422,
        );
      }

      try {
        await assertAppointmentStatusTransitionAllowed({
          appointmentId,
          nextStatus: status,
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
            statusFailure(
              "conflict",
              "quoted_scope_required",
              "Add the quoted-to-remove summary before confirming or completing this appointment.",
            ),
            409,
          );
        }
        throw error;
      }

      const paymentLedgerAvailable =
        hasFinancialChanges && (await isPaymentLedgerSchemaAvailable(tx));
      if (hasFinancialChanges && !paymentLedgerAvailable) {
        throw new TeamMutationFailure(
          "internal",
          "Payment safety checks are temporarily unavailable. No appointment changes were saved; retry after the payment service recovers.",
          { status: 503, retryable: true },
        );
      }
      const isChangingFinalTotal =
        typeof finalTotalCentsToSet === "number" &&
        existing.finalTotalCents !== finalTotalCentsToSet;
      if (
        paymentLedgerAvailable &&
        (isChangingFinalTotal || parsed.data.cardTipCents !== undefined)
      ) {
        await expireStalePaymentAttemptsForAppointment(tx, appointmentId);
        const blockingAttempt = await getBlockingSquareAttempt(
          tx,
          appointmentId,
        );
        if (blockingAttempt) {
          const reconciliationRequired = requiresSquareAttemptReconciliation(
            blockingAttempt.status,
          );
          return storeTerminalFailure(
            tx,
            mutation,
            claimed.claim,
            statusFailure(
              "conflict",
              reconciliationRequired
                ? "square_reconciliation_required"
                : "square_verification_in_progress",
              reconciliationRequired
                ? "An unresolved Square attempt must be reviewed by a team member with payment-management access before changing the final total."
                : "Finish or reconcile the active Square attempt before changing the final total.",
              { extra: { attemptId: blockingAttempt.id } },
            ),
            409,
          );
        }

        const paymentLock = await getFinalTotalPaymentLock(tx, appointmentId, {
          schemaAvailable: true,
        });
        if (
          parsed.data.cardTipCents !== undefined &&
          paymentLock.hasSuccessfulPayment
        ) {
          return storeTerminalFailure(
            tx,
            mutation,
            claimed.claim,
            statusFailure(
              "conflict",
              "card_tip_managed_by_payments",
              "Card tips are synchronized from verified payment records and cannot be edited during completion.",
            ),
            409,
          );
        }
        if (isChangingFinalTotal) {
          const decision = validateFinalTotalChange({
            currentFinalTotalCents: existing.finalTotalCents,
            nextFinalTotalCents: finalTotalCentsToSet!,
            paidTowardJobCents: paymentLock.paidTowardJobCents,
            hasSuccessfulPayment: paymentLock.hasSuccessfulPayment,
            canManagePayments,
            changeReason: parsed.data.finalTotalChangeReason,
          });
          if (!decision.ok) {
            const managementRequired =
              decision.code === "payment_management_required_after_payment";
            return storeTerminalFailure(
              tx,
              mutation,
              claimed.claim,
              statusFailure(
                managementRequired ? "forbidden" : "conflict",
                decision.code,
                decision.message,
              ),
              managementRequired ? 403 : 409,
            );
          }
        }
      }

      const becameCompleted =
        existing.status !== "completed" && status === "completed";
      const leavingCompleted =
        existing.status === "completed" && status !== "completed";
      const statusChanged = existing.status !== status;
      const becameFinalTotalKnown =
        status === "completed" &&
        finalTotalCentsToSet !== undefined &&
        existing.finalTotalCents === null &&
        finalTotalCentsToSet !== null;
      if (parsed.data.sendCustomerNotification && !statusChanged) {
        return storeTerminalFailure(
          tx,
          mutation,
          claimed.claim,
          statusFailure(
            "invalid",
            "customer_notification_not_applicable",
            "The customer notice was not requested because the appointment already has that status.",
            {
              fieldErrors: {
                sendCustomerNotification:
                  "Choose a different status or leave the notice unchecked.",
              },
            },
          ),
          422,
        );
      }
      if (
        parsed.data.sendReviewRequest &&
        (!(becameCompleted || becameFinalTotalKnown) ||
          typeof effectiveFinalTotalCents !== "number")
      ) {
        return storeTerminalFailure(
          tx,
          mutation,
          claimed.claim,
          statusFailure(
            "invalid",
            "review_request_not_applicable",
            "The review request was not queued because this save does not newly complete a priced job.",
            {
              fieldErrors: {
                sendReviewRequest:
                  "Leave this unchecked when correcting an already completed job.",
              },
            },
          ),
          422,
        );
      }
      const committedAt = new Date(
        Math.max(Date.now(), existing.updatedAt.getTime() + 1),
      );
      const completedAtToSet = leavingCompleted
        ? null
        : completedAtOverride !== undefined
          ? completedAtOverride
          : becameCompleted
            ? committedAt
            : undefined;
      const needsCommissionRefresh =
        !isQuoteOnly &&
        (leavingCompleted ||
          (status === "completed" &&
            (becameCompleted ||
              finalTotalCentsToSet !== undefined ||
              parsed.data.marketingMemberId !== undefined ||
              completedAtToSet !== undefined ||
              crewMembers !== undefined ||
              bookingDetailsUpdate !== undefined)));
      let commissionPayoutRunIds: string[] = [];
      let commissionPeriod:
        | { timezone: string; periodStart: string; periodEnd: string }
        | undefined;
      if (needsCommissionRefresh) {
        const commissionCompletionTime =
          existing.status === "completed"
            ? existing.completedAt
            : completedAtToSet instanceof Date
              ? completedAtToSet
              : existing.completedAt;
        const payoutPeriod =
          await lockCompletedAppointmentPayoutPeriodInTransaction(
            tx,
            commissionCompletionTime,
          );
        if (!payoutPeriod.ok) {
          const finalized = payoutPeriod.reason === "payout_period_finalized";
          return storeTerminalFailure(
            tx,
            mutation,
            claimed.claim,
            statusFailure(
              "conflict",
              finalized
                ? "payout_period_finalized"
                : "commission_period_unavailable",
              finalized
                ? "This completed job belongs to a locked or paid payout period. Record a later commission adjustment instead of rewriting its attribution."
                : "The completed job has no valid commission period. Review its completion time before changing financial attribution.",
              {
                fieldErrors: {
                  completedAt: finalized
                    ? "Use a later payout adjustment for this correction."
                    : "Set a valid completion time first.",
                },
              },
            ),
            409,
          );
        }
        if (
          existing.status === "completed" &&
          completedAtToSet instanceof Date &&
          (completedAtToSet < payoutPeriod.periodStart ||
            completedAtToSet >= payoutPeriod.periodEnd)
        ) {
          return storeTerminalFailure(
            tx,
            mutation,
            claimed.claim,
            statusFailure(
              "conflict",
              "payout_period_change_requires_adjustment",
              "A completed job cannot be moved into a different payout week through status correction. Record a later adjustment instead.",
              {
                fieldErrors: {
                  completedAt:
                    "Keep the completion time in its current payout week or use an adjustment.",
                },
              },
            ),
            409,
          );
        }
        commissionPayoutRunIds = payoutPeriod.payoutRunIds;
        commissionPeriod = {
          timezone: payoutPeriod.timezone,
          periodStart: payoutPeriod.periodStart.toISOString(),
          periodEnd: payoutPeriod.periodEnd.toISOString(),
        };
      }

      const values: Partial<typeof appointments.$inferInsert> = {
        status,
        updatedAt: committedAt,
      };
      if (parsed.data.crew !== undefined)
        values.crew = parsed.data.crew ?? null;
      if (parsed.data.owner !== undefined)
        values.owner = parsed.data.owner ?? null;
      if (parsed.data.marketingMemberId !== undefined) {
        values.marketingMemberId = parsed.data.marketingMemberId ?? null;
      }
      if (bookingDetailsUpdate !== undefined) {
        values.quotedTotalCents = parsed.data.quotedTotalCents ?? null;
        values.bookingDetails = bookingDetailsUpdate;
      }
      if (finalTotalCentsToSet !== undefined) {
        values.finalTotalCents = finalTotalCentsToSet;
      }
      if (parsed.data.cardTipCents !== undefined) {
        values.cardTipCents = parsed.data.cardTipCents;
      }
      if (completedAtToSet !== undefined) {
        values.completedAt = completedAtToSet;
      }

      const [updated] = await tx
        .update(appointments)
        .set(values)
        .where(
          and(
            eq(appointments.id, appointmentId),
            eq(appointments.updatedAt, existing.updatedAt),
          ),
        )
        .returning({
          id: appointments.id,
          leadId: appointments.leadId,
          calendarEventId: appointments.calendarEventId,
          updatedAt: appointments.updatedAt,
        });
      if (!updated) {
        throw new TeamMutationFailure(
          "conflict",
          "The appointment changed while its status was being saved. No changes were committed; refresh and try again.",
          { retryable: true },
        );
      }

      if (crewMembers !== undefined) {
        await tx
          .delete(appointmentCrewMembers)
          .where(eq(appointmentCrewMembers.appointmentId, appointmentId));
        if (crewMembers.length > 0) {
          await tx.insert(appointmentCrewMembers).values(
            crewMembers.map((entry) => ({
              appointmentId,
              memberId: entry.memberId,
              splitBps: entry.splitBps,
              createdAt: committedAt,
            })),
          );
        }
      }

      if (needsCommissionRefresh) {
        await recalculateAppointmentCommissionsAndRefreshDraftPayoutsInTransaction(
          tx,
          appointmentId,
          { payoutRunIds: commissionPayoutRunIds },
        );
      }

      if (statusChanged && updated.leadId && status === "confirmed") {
        await tx
          .update(leads)
          .set({ status: "scheduled" })
          .where(eq(leads.id, updated.leadId));
      }

      const calendarSync: "not_required" | "requested" =
        updated.calendarEventId && status === "canceled"
          ? "requested"
          : "not_required";
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "appointment",
        entityId: updated.id,
        before: {
          status: existing.status,
          calendarEventId: existing.calendarEventId,
          quotedTotalCents: existing.quotedTotalCents,
          finalTotalCents: existing.finalTotalCents,
          cardTipCents: existing.cardTipCents,
          completedAt: existing.completedAt?.toISOString() ?? null,
          marketingMemberId: existing.marketingMemberId,
          version: currentVersion,
        },
        after: {
          status,
          quotedTotalCents: effectiveQuotedTotalCents,
          finalTotalCents: effectiveFinalTotalCents,
          ...(parsed.data.cardTipCents !== undefined
            ? { cardTipCents: parsed.data.cardTipCents }
            : {}),
          ...(completedAtToSet !== undefined
            ? {
                completedAt:
                  completedAtToSet instanceof Date
                    ? completedAtToSet.toISOString()
                    : null,
              }
            : {}),
          ...(parsed.data.marketingMemberId !== undefined
            ? { marketingMemberId: parsed.data.marketingMemberId }
            : {}),
          version: updated.updatedAt.toISOString(),
        },
        metadata: {
          leadId: updated.leadId,
          crewMembersChanged: crewMembers !== undefined,
          crewMembersCount:
            crewMembers === undefined ? undefined : crewMembers.length,
          bookingDetailsChanged: bookingDetailsUpdate !== undefined,
          finalTotalChangeReasonProvided:
            parsed.data.finalTotalChangeReason !== undefined,
          paymentLedgerChecked: paymentLedgerAvailable,
          statusChanged,
          calendarSync,
          customerNotificationRequested: parsed.data.sendCustomerNotification,
          reviewRequestRequested: parsed.data.sendReviewRequest,
          commissionsReconciled: needsCommissionRefresh,
          commissionPayoutRunIds,
          commissionPeriod,
        },
        committedAt: updated.updatedAt,
      });
      const messageAuthorization = sendsCustomerMessage
        ? buildMessageAuthorizationEvidence(mutation, audit.auditEventId)
        : null;
      await tx.insert(outboxEvents).values({
        type: "estimate.status_changed",
        payload: {
          appointmentId: updated.id,
          leadId: updated.leadId,
          status,
          statusChanged,
          version: updated.updatedAt.toISOString(),
          customerNotificationRequested: parsed.data.sendCustomerNotification,
          reviewRequestRequested: parsed.data.sendReviewRequest,
          messageAuthorization,
          correlationId: mutation.correlationId,
        },
      });
      if (calendarSync === "requested") {
        await tx.insert(outboxEvents).values({
          type: "appointment.calendar_sync_requested",
          payload: {
            appointmentId: updated.id,
            requestedCalendarEventId: updated.calendarEventId,
            version: updated.updatedAt.toISOString(),
            correlationId: mutation.correlationId,
            operationId: mutation.operationId,
            sourceAuditEventId: audit.auditEventId,
            actorId: mutation.actor.id,
            sessionId: mutation.actor.sessionId,
            authMethod: mutation.actor.authMethod,
            requiredPermission: "appointments.update",
            reason: "appointment.canceled",
          },
        });
      }
      if (parsed.data.sendReviewRequest) {
        await tx.insert(outboxEvents).values({
          type: "review.request",
          payload: {
            appointmentId: updated.id,
            status,
            version: updated.updatedAt.toISOString(),
            requested: true,
            correlationId: mutation.correlationId,
            messageAuthorization,
          },
        });
      }
      const data = {
        appointmentId: updated.id,
        status,
        version: updated.updatedAt.toISOString(),
        calendarSync,
        customerNotification: parsed.data.sendCustomerNotification
          ? ("requested" as const)
          : ("not_requested" as const),
        reviewRequest: parsed.data.sendReviewRequest
          ? ("requested" as const)
          : ("not_requested" as const),
        bookingDetailsUpdated: bookingDetailsUpdate !== undefined,
      };
      const success = {
        ...teamMutationSuccessResult(mutation, data, {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "appointment",
          entityId: updated.id,
          version: updated.updatedAt.toISOString(),
        }),
        // Temporary compatibility fields. They are part of the stored result,
        // so a lost response and every later replay remain byte-equivalent.
        appointmentId: updated.id,
        status,
        version: updated.updatedAt.toISOString(),
        calendarSync,
        customerNotification: data.customerNotification,
        reviewRequest: data.reviewRequest,
        bookingDetailsUpdated: bookingDetailsUpdate !== undefined,
      };
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
        success,
        200,
      );
      return { result: success, status: 200 } satisfies StoredStatusOutcome;
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
        console.error("[appointment-status] idempotency_settlement_failed", {
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
