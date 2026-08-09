import type { ActionPolicy, MutationResult } from "@myst-os/sdk";
import type { NextRequest } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { appointments, getDb } from "@/db";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import {
  lockCompletedAppointmentPayoutPeriodInTransaction,
  recalculateAppointmentCommissionsAndRefreshDraftPayoutsInTransaction,
} from "@/lib/commissions";
import {
  expireStalePaymentAttemptsForAppointment,
  getBlockingSquareAttempt,
  getFinalTotalPaymentLock,
  requiresSquareAttemptReconciliation,
  validateFinalTotalChange,
} from "@/lib/payment-ledger";
import { requirePermission } from "@/lib/permissions";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  type TeamMutationIdempotencyClaim,
} from "@/lib/team-mutation-idempotency";
import {
  beginTeamMutation,
  createTeamMutationDeniedAuditWriter,
  TeamMutationFailure,
  type TeamMutationContext,
  type TeamMutationTransaction,
  strengthenTeamMutationPolicy,
  teamMutationExceptionResult,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";

const MAXIMUM_CENTS = 2_147_483_647;
const FINAL_TOTAL_REQUEST_MAXIMUM_BYTES = 1_024;
const APPOINTMENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const FinalTotalSchema = z
  .object({
    finalTotalCents: z.number().int().min(0).max(MAXIMUM_CENTS),
    changeReason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

type RouteContext = { params: Promise<{ id?: string }> };

type FinalTotalData = {
  appointmentId: string;
  finalTotalCents: number;
  previousFinalTotalCents: number | null;
  paidTowardJobCents: number;
  paymentLocked: boolean;
  changed: boolean;
  version: string;
};

type FinalTotalFailure = Extract<
  MutationResult<FinalTotalData>,
  { ok: false }
> & {
  current?: { finalTotalCents: number | null; version: string };
  attemptId?: string;
};
type FinalTotalResult =
  | Extract<MutationResult<FinalTotalData>, { ok: true }>
  | FinalTotalFailure;

function requireAppointmentVersion(value: string | null): string {
  if (
    value === null ||
    value === "*" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new TeamMutationFailure(
      "invalid",
      "The current appointment version is required before changing the final total.",
      {
        fieldErrors: {
          version: "Refresh the appointment and submit the total again.",
        },
      },
    );
  }
  return value;
}

function boundedRequestFailure(
  error: BoundedJsonRequestError,
): TeamMutationFailure {
  if (error.code === "body_timeout") {
    return new TeamMutationFailure("timeout", error.message, {
      status: error.status,
      retryable: true,
      fieldErrors: { request: "Retry with the same request key." },
    });
  }
  return new TeamMutationFailure("invalid", error.message, {
    status: error.status,
    fieldErrors: { request: "Send one bounded application/json object." },
  });
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .filter((key) => record[key] !== undefined)
        .map((key) => [key, canonicalize(record[key])]),
    );
  }
  return value;
}

/** Canonical bytes make an idempotent replay identical to its first result. */
function finalTotalResponse(
  result: FinalTotalResult,
  status: number,
  correlationId: string,
  options: { replayed?: boolean; retryAfter?: string | null } = {},
): Response {
  const headers = new Headers({
    "Cache-Control": "private, no-store, max-age=0",
    "Content-Type": "application/json; charset=utf-8",
    "x-correlation-id": correlationId,
  });
  if (options.replayed) headers.set("idempotency-replayed", "true");
  if (options.retryAfter) headers.set("Retry-After", options.retryAfter);
  return new Response(JSON.stringify(canonicalize(result)), {
    status,
    headers,
  });
}

async function completeFailure(
  tx: TeamMutationTransaction,
  mutation: TeamMutationContext,
  claim: TeamMutationIdempotencyClaim,
  appointmentId: string,
  result: FinalTotalFailure,
  status: number,
  options: {
    metadata?: Record<string, unknown>;
    insertFailure?: NonNullable<TeamMutationContext["audit"]["insertFailure"]>;
  } = {},
): Promise<{ result: FinalTotalResult; status: number }> {
  const insertFailure =
    options.insertFailure ??
    (mutation.audit.insertFailure
      ? (
          auditTx: TeamMutationTransaction,
          input: Parameters<
            NonNullable<TeamMutationContext["audit"]["insertFailure"]>
          >[1],
        ) => mutation.audit.insertFailure!(auditTx, input)
      : undefined);
  if (!insertFailure) {
    throw new TeamMutationFailure(
      "internal",
      "The financial failure audit boundary is unavailable. No changes were saved.",
      { retryable: true },
    );
  }
  await insertFailure(tx, {
    outcome: result.code === "forbidden" ? "denied" : "failed",
    entityType: "appointment",
    entityId: appointmentId,
    code: result.code,
    metadata: {
      ...(options.metadata ?? {}),
      responseStatus: status,
    },
  });
  await completeTeamMutationIdempotency(tx, mutation, claim, result, status);
  return { result, status };
}

async function hasPaymentManagementAuthority(
  request: NextRequest,
): Promise<boolean> {
  return (await requirePermission(request, "payments.manage")) === null;
}

export async function PUT(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["payments.collect"],
    risk: "financial",
    requiresIdempotency: true,
    auditAction: "appointment.final_total.updated",
  } satisfies ActionPolicy);
  if (!boundary.ok) return boundary.response;
  let mutation = boundary.mutation;

  // Resolve optional correction authority from the same verified session
  // before reading route state or opening the business transaction.
  const canManagePayments = await hasPaymentManagementAuthority(request);

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    if (request.nextUrl.search.length > 0) {
      throw new TeamMutationFailure(
        "invalid",
        "Final-total requests do not accept query parameters.",
      );
    }

    const { id: rawAppointmentId } = await context.params;
    const appointmentId = rawAppointmentId?.normalize("NFKC").trim() ?? "";
    if (!APPOINTMENT_ID_PATTERN.test(appointmentId)) {
      throw new TeamMutationFailure(
        "invalid",
        "Choose a valid appointment before changing the final total.",
        { fieldErrors: { appointmentId: "Select a valid appointment." } },
      );
    }
    const expectedVersion = requireAppointmentVersion(mutation.expectedVersion);

    let input: unknown;
    try {
      input = await readBoundedJsonRequest(request, {
        maximumBytes: FINAL_TOTAL_REQUEST_MAXIMUM_BYTES,
        deadlineMs: 8_000,
      });
    } catch (error) {
      if (error instanceof BoundedJsonRequestError) {
        throw boundedRequestFailure(error);
      }
      throw error;
    }
    const parsed = FinalTotalSchema.safeParse(input);
    if (!parsed.success) {
      throw new TeamMutationFailure(
        "invalid",
        "Enter a valid final total and an optional reason of at most 500 characters.",
        {
          fieldErrors: {
            finalTotalCents:
              "Use a whole-cent amount between 0 and $21,474,836.47.",
          },
        },
      );
    }

    const database = getDb();
    db = database;
    const claimed = await claimTeamMutationIdempotency(database, mutation, {
      route: "PUT /api/appointments/:appointmentId/final-total",
      entityType: "appointment",
      entityId: appointmentId,
      payload: parsed.data,
    });
    if (claimed.kind === "replay") {
      return finalTotalResponse(
        claimed.replay.result as FinalTotalResult,
        claimed.replay.status,
        claimed.replay.correlationId,
        { replayed: true },
      );
    }
    claim = claimed.claim;

    const outcome = await database.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext('appointment_final_total'), hashtext(${appointmentId}))`,
      );
      const [appointment] = await tx
        .select({
          id: appointments.id,
          status: appointments.status,
          completedAt: appointments.completedAt,
          finalTotalCents: appointments.finalTotalCents,
          updatedAt: appointments.updatedAt,
        })
        .from(appointments)
        .where(eq(appointments.id, appointmentId))
        .for("update")
        .limit(1);
      if (!appointment) {
        return completeFailure(
          tx,
          mutation,
          claimed.claim,
          appointmentId,
          {
            ok: false,
            code: "invalid",
            message: "The appointment no longer exists.",
            retryable: false,
            fieldErrors: { appointmentId: "Refresh the appointment list." },
          },
          404,
        );
      }

      const currentVersion = appointment.updatedAt.toISOString();
      if (currentVersion !== expectedVersion) {
        return completeFailure(
          tx,
          mutation,
          claimed.claim,
          appointmentId,
          {
            ok: false,
            code: "conflict",
            message:
              "This appointment changed on another screen. Review the latest total before retrying.",
            retryable: false,
            fieldErrors: { version: "The submitted version is stale." },
            current: {
              finalTotalCents: appointment.finalTotalCents,
              version: currentVersion,
            },
          },
          409,
        );
      }

      const changed =
        appointment.finalTotalCents !== parsed.data.finalTotalCents;
      if (changed) {
        await expireStalePaymentAttemptsForAppointment(tx, appointmentId);
        const blockingAttempt = await getBlockingSquareAttempt(
          tx,
          appointmentId,
        );
        if (blockingAttempt) {
          const reconciliationRequired = requiresSquareAttemptReconciliation(
            blockingAttempt.status,
          );
          return completeFailure(
            tx,
            mutation,
            claimed.claim,
            appointmentId,
            {
              ok: false,
              code: "conflict",
              message: reconciliationRequired
                ? "An unresolved Square attempt must be reviewed with payment-management access before changing the final total."
                : "Finish or reconcile the active Square attempt before changing the final total.",
              retryable: false,
              fieldErrors: {
                finalTotalCents: reconciliationRequired
                  ? "Reconcile the Square attempt first."
                  : "Wait for Square verification to finish.",
              },
              attemptId: blockingAttempt.id,
            },
            409,
          );
        }
      }

      const paymentLock = await getFinalTotalPaymentLock(tx, appointmentId);
      if (changed && paymentLock.hasSuccessfulPayment && canManagePayments) {
        mutation = strengthenTeamMutationPolicy(mutation, ["payments.manage"]);
      }
      const decision = validateFinalTotalChange({
        currentFinalTotalCents: appointment.finalTotalCents,
        nextFinalTotalCents: parsed.data.finalTotalCents,
        paidTowardJobCents: paymentLock.paidTowardJobCents,
        hasSuccessfulPayment: paymentLock.hasSuccessfulPayment,
        canManagePayments,
        changeReason: parsed.data.changeReason,
      });
      if (!decision.ok) {
        const requiresManagement =
          decision.code === "payment_management_required_after_payment";
        return completeFailure(
          tx,
          mutation,
          claimed.claim,
          appointmentId,
          {
            ok: false,
            code: requiresManagement ? "forbidden" : "conflict",
            message: decision.message,
            retryable: false,
            fieldErrors: {
              [decision.code === "change_reason_required"
                ? "changeReason"
                : "finalTotalCents"]: decision.message,
            },
          },
          requiresManagement ? 403 : 409,
          {
            metadata: {
              paymentLocked: paymentLock.hasSuccessfulPayment,
              paidTowardJobCents: paymentLock.paidTowardJobCents,
              ...(requiresManagement
                ? { additionalRequiredPermission: "payments.manage" }
                : {}),
            },
            ...(requiresManagement
              ? {
                  insertFailure: createTeamMutationDeniedAuditWriter(mutation, [
                    "payments.manage",
                  ]),
                }
              : {}),
          },
        );
      }

      let payoutRunIds: string[] = [];
      let payoutPeriodAudit:
        | {
            timezone: string;
            periodStart: string;
            periodEnd: string;
          }
        | undefined;
      if (changed && appointment.status === "completed") {
        const payoutPeriod =
          await lockCompletedAppointmentPayoutPeriodInTransaction(
            tx,
            appointment.completedAt,
          );
        if (!payoutPeriod.ok) {
          const finalized = payoutPeriod.reason === "payout_period_finalized";
          return completeFailure(
            tx,
            mutation,
            claimed.claim,
            appointmentId,
            {
              ok: false,
              code: "conflict",
              message: finalized
                ? "That payout period is locked or paid. Record a later adjustment instead of rewriting the completed job total."
                : "This completed job has no completion timestamp. Repair the job record before changing its final total.",
              retryable: false,
              fieldErrors: {
                finalTotalCents: finalized
                  ? "The completed job belongs to a finalized payout period."
                  : "A valid completion timestamp is required.",
              },
              current: {
                finalTotalCents: appointment.finalTotalCents,
                version: currentVersion,
              },
            },
            409,
            {
              metadata: {
                reason: payoutPeriod.reason,
                timezone: payoutPeriod.timezone,
                periodStart: payoutPeriod.periodStart?.toISOString() ?? null,
                periodEnd: payoutPeriod.periodEnd?.toISOString() ?? null,
                finalizedRunId: payoutPeriod.finalizedRunId ?? null,
                finalizedRunStatus: payoutPeriod.finalizedRunStatus ?? null,
              },
            },
          );
        }
        payoutRunIds = payoutPeriod.payoutRunIds;
        payoutPeriodAudit = {
          timezone: payoutPeriod.timezone,
          periodStart: payoutPeriod.periodStart.toISOString(),
          periodEnd: payoutPeriod.periodEnd.toISOString(),
        };
      }

      const auditCommittedAt = new Date(
        Math.max(Date.now(), appointment.updatedAt.getTime() + 1),
      );
      const appointmentVersionAt = changed
        ? new Date(auditCommittedAt.getTime())
        : appointment.updatedAt;
      if (changed) {
        const [updated] = await tx
          .update(appointments)
          .set({
            finalTotalCents: parsed.data.finalTotalCents,
            updatedAt: appointmentVersionAt,
          })
          .where(
            and(
              eq(appointments.id, appointmentId),
              eq(appointments.updatedAt, appointment.updatedAt),
            ),
          )
          .returning({ id: appointments.id });
        if (!updated) {
          throw new TeamMutationFailure(
            "conflict",
            "The appointment changed while the final total was being saved. Retry with the latest version.",
            { retryable: true },
          );
        }
      }

      if (changed && appointment.status === "completed") {
        await recalculateAppointmentCommissionsAndRefreshDraftPayoutsInTransaction(
          tx,
          appointmentId,
          { payoutRunIds },
        );
      }

      const version = appointmentVersionAt.toISOString();
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "appointment",
        entityId: appointmentId,
        before: {
          finalTotalCents: appointment.finalTotalCents,
          version: currentVersion,
        },
        after: {
          finalTotalCents: parsed.data.finalTotalCents,
          version,
        },
        metadata: {
          changed,
          completedJobCommissionsRefreshed:
            changed && appointment.status === "completed",
          payoutRunIds,
          payoutPeriod: payoutPeriodAudit ?? null,
          paidTowardJobCents: paymentLock.paidTowardJobCents,
          paymentLocked: paymentLock.hasSuccessfulPayment,
          changeReasonProvided: parsed.data.changeReason !== undefined,
        },
        committedAt: auditCommittedAt,
      });
      const result = teamMutationSuccessResult<FinalTotalData>(
        mutation,
        {
          appointmentId,
          finalTotalCents: parsed.data.finalTotalCents,
          previousFinalTotalCents: appointment.finalTotalCents,
          paidTowardJobCents: paymentLock.paidTowardJobCents,
          paymentLocked: paymentLock.hasSuccessfulPayment,
          changed,
          version,
        },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "appointment",
          entityId: appointmentId,
          version,
        },
      );
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
        result,
        200,
      );
      return { result, status: 200 };
    });

    return finalTotalResponse(
      outcome.result,
      outcome.status,
      mutation.correlationId,
    );
  } catch (error) {
    if (db && claim) {
      try {
        await settleTeamMutationIdempotencyFailure(db, mutation, claim, error);
      } catch (settlementError) {
        console.error(
          "[appointment-final-total] idempotency_settlement_failed",
          {
            operationId: mutation.operationId,
            correlationId: mutation.correlationId,
            errorName:
              settlementError instanceof Error
                ? settlementError.name
                : "UnknownError",
          },
        );
      }
    }
    const failure = teamMutationExceptionResult(error);
    return finalTotalResponse(
      failure.result,
      failure.status,
      mutation.correlationId,
      { retryAfter: failure.retryAfter },
    );
  }
}
