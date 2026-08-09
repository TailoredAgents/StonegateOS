import type { ActionPolicy, MutationResult } from "@myst-os/sdk";
import type { NextRequest } from "next/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { appointments, getDb, paymentAttempts, payments } from "@/db";
import {
  APPOINTMENT_PAYMENT_ID_PATTERN,
  APPOINTMENT_PAYMENT_REQUEST_MAXIMUM_BYTES,
  appointmentPaymentMutationResponse,
  boundedAppointmentPaymentRequestFailure,
  completeAppointmentPaymentFailure,
  requireExactAppointmentPaymentVersion,
} from "@/lib/appointment-payment-mutation";
import { classifyPaymentCollectionAttemptSafety } from "@/lib/appointment-payment-attempt-safety";
import {
  AppointmentMediaError,
  getAppointmentScopeState,
} from "@/lib/appointment-media";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import {
  canCollectAppointmentPayment,
  expireStalePaymentAttemptsForAppointment,
  getAppointmentPaymentSummary,
} from "@/lib/payment-ledger";
import { isPaymentLedgerSchemaAvailable } from "@/lib/payment-schema";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  type TeamMutationIdempotencyClaim,
} from "@/lib/team-mutation-idempotency";
import {
  beginTeamMutation,
  recordTeamMutationFailure,
  TeamMutationFailure,
  teamMutationExceptionResult,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";

const MAXIMUM_TIP_CENTS = 10_000_000;
const MAXIMUM_NOTE_LENGTH = 500;

const canonicalUuid = z
  .string()
  .transform((value) => value.normalize("NFKC").trim().toLowerCase())
  .pipe(z.string().regex(APPOINTMENT_PAYMENT_ID_PATTERN));
const canonicalTender = z
  .string()
  .transform((value) => value.normalize("NFKC").trim().toLowerCase())
  .pipe(z.enum(["cash", "check"]));
const ManualPaymentSchema = z
  .object({
    clientRequestId: canonicalUuid,
    tenderType: canonicalTender,
    tipCents: z.number().int().nonnegative().max(MAXIMUM_TIP_CENTS),
    note: z.string().max(2_000).optional(),
  })
  .strict();

type ManualPaymentData = {
  appointmentId: string;
  paymentId: string;
  clientRequestId: string;
  tenderType: "cash" | "check";
  jobAmountCents: number;
  tipCents: number;
  totalAmountCents: number;
  status: "completed";
  paymentSummary: Awaited<ReturnType<typeof getAppointmentPaymentSummary>>;
  version: string;
};

type ManualPaymentResult = MutationResult<ManualPaymentData>;

function canonicalNote(value: string | undefined): string | null {
  if (value === undefined) return null;
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length === 0) return null;
  if (normalized.length > MAXIMUM_NOTE_LENGTH) {
    throw new TeamMutationFailure("invalid", "The payment note is too long.", {
      fieldErrors: { note: "Use 500 characters or fewer." },
    });
  }
  return normalized;
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["payments.collect"],
    risk: "financial",
    requiresIdempotency: true,
    auditAction: "payment.manual.recorded",
  } satisfies ActionPolicy);
  if (!boundary.ok) return boundary.response;
  const mutation = boundary.mutation;

  let database: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    if (
      !mutation.actor.id ||
      !APPOINTMENT_PAYMENT_ID_PATTERN.test(mutation.actor.id) ||
      !mutation.actor.sessionId ||
      !APPOINTMENT_PAYMENT_ID_PATTERN.test(mutation.actor.sessionId) ||
      (mutation.actor.authMethod !== "team_session" &&
        mutation.actor.authMethod !== "break_glass")
    ) {
      throw new TeamMutationFailure(
        "internal",
        "The verified payment-collection session is incomplete.",
      );
    }
    const actorId = mutation.actor.id;
    if (request.nextUrl.search.length > 0) {
      throw new TeamMutationFailure(
        "invalid",
        "Manual payment requests do not accept query parameters.",
      );
    }

    const { id: rawAppointmentId } = await context.params;
    const appointmentId =
      rawAppointmentId?.normalize("NFKC").trim().toLowerCase() ?? "";
    if (!APPOINTMENT_PAYMENT_ID_PATTERN.test(appointmentId)) {
      throw new TeamMutationFailure(
        "invalid",
        "Choose a valid appointment before recording payment.",
        { fieldErrors: { appointmentId: "Select a valid appointment." } },
      );
    }
    const expectedVersion = requireExactAppointmentPaymentVersion(
      mutation.expectedVersion,
    );

    let body: unknown;
    try {
      body = await readBoundedJsonRequest(request, {
        maximumBytes: APPOINTMENT_PAYMENT_REQUEST_MAXIMUM_BYTES,
        deadlineMs: 8_000,
      });
    } catch (error) {
      if (error instanceof BoundedJsonRequestError) {
        throw boundedAppointmentPaymentRequestFailure(error);
      }
      throw error;
    }
    const parsed = ManualPaymentSchema.safeParse(body);
    if (!parsed.success) {
      throw new TeamMutationFailure(
        "invalid",
        "Record cash or check with a valid tip and one client request ID.",
        {
          fieldErrors: {
            clientRequestId: "Use one stable UUID for this manual payment.",
            tenderType: "Choose cash or check.",
            tipCents: "Use a whole-cent nonnegative tip.",
          },
        },
      );
    }
    const note = canonicalNote(parsed.data.note);
    const input = {
      clientRequestId: parsed.data.clientRequestId,
      tenderType: parsed.data.tenderType,
      tipCents: parsed.data.tipCents,
      note,
    };

    database = getDb();
    const claimed = await claimTeamMutationIdempotency(database, mutation, {
      route: "POST /api/appointments/:appointmentId/manual-payments",
      entityType: "appointment",
      entityId: appointmentId,
      payload: input,
    });
    if (claimed.kind === "replay") {
      return appointmentPaymentMutationResponse(
        claimed.replay.result as ManualPaymentResult,
        claimed.replay.status,
        claimed.replay.correlationId,
        { replayed: true },
      );
    }
    claim = claimed.claim;

    const outcome = await database.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext('appointment_payment_collection'), hashtext(${appointmentId}))`,
      );
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext('payment_client_request'), hashtext(${input.clientRequestId}))`,
      );
      if (!(await isPaymentLedgerSchemaAvailable(tx))) {
        return completeAppointmentPaymentFailure(
          tx,
          mutation,
          claimed.claim,
          appointmentId,
          {
            ok: false,
            code: "internal",
            message:
              "Payment collection is temporarily unavailable while its ledger is being verified.",
            retryable: true,
          },
          503,
          { reason: "payment_ledger_unavailable" },
        );
      }

      const [appointment] = await tx
        .select({
          id: appointments.id,
          finalTotalCents: appointments.finalTotalCents,
          status: appointments.status,
          type: appointments.type,
          updatedAt: appointments.updatedAt,
        })
        .from(appointments)
        .where(eq(appointments.id, appointmentId))
        .for("update")
        .limit(1);
      if (!appointment) {
        return completeAppointmentPaymentFailure(
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
        return completeAppointmentPaymentFailure(
          tx,
          mutation,
          claimed.claim,
          appointmentId,
          {
            ok: false,
            code: "conflict",
            message:
              "This appointment changed on another screen. Refresh its balance before recording payment.",
            retryable: false,
            fieldErrors: { version: "The submitted version is stale." },
            current: { version: currentVersion },
          },
          409,
        );
      }
      if (!canCollectAppointmentPayment(appointment.status, appointment.type)) {
        return completeAppointmentPaymentFailure(
          tx,
          mutation,
          claimed.claim,
          appointmentId,
          {
            ok: false,
            code: "conflict",
            message:
              "Payments cannot be collected for canceled, no-show, or quote-only appointments.",
            retryable: false,
            fieldErrors: {
              appointmentId: "This appointment is not collectible.",
            },
          },
          409,
          {
            appointmentStatus: appointment.status,
            appointmentType: appointment.type,
          },
        );
      }
      if (
        appointment.finalTotalCents === null ||
        appointment.finalTotalCents <= 0
      ) {
        return completeAppointmentPaymentFailure(
          tx,
          mutation,
          claimed.claim,
          appointmentId,
          {
            ok: false,
            code: "conflict",
            message: "Set the final job total before recording payment.",
            retryable: false,
            fieldErrors: {
              finalTotalCents: "A positive final total is required.",
            },
          },
          409,
        );
      }

      let scope;
      try {
        scope = await getAppointmentScopeState(appointmentId, tx);
      } catch (error) {
        return completeAppointmentPaymentFailure(
          tx,
          mutation,
          claimed.claim,
          appointmentId,
          {
            ok: false,
            code: "internal",
            message:
              "The quoted scope could not be verified. No payment was recorded.",
            retryable: true,
          },
          error instanceof AppointmentMediaError &&
            error.code === "appointment_not_found"
            ? 404
            : 503,
          { reason: "appointment_scope_unavailable" },
        );
      }
      if (scope.needsScope) {
        return completeAppointmentPaymentFailure(
          tx,
          mutation,
          claimed.claim,
          appointmentId,
          {
            ok: false,
            code: "conflict",
            message:
              "Add the quoted-to-remove summary before recording payment.",
            retryable: false,
            fieldErrors: { quotedScopeText: "Quoted scope is required." },
          },
          409,
        );
      }

      const now = new Date();
      await tx
        .select({ id: paymentAttempts.id })
        .from(paymentAttempts)
        .where(eq(paymentAttempts.appointmentId, appointmentId))
        .for("update");
      await tx
        .select({ id: payments.id })
        .from(payments)
        .where(eq(payments.appointmentId, appointmentId))
        .for("update");
      await expireStalePaymentAttemptsForAppointment(tx, appointmentId, now);

      const providerPaymentId = `manual:${input.clientRequestId}`;
      const [clientRequestCollision] = await tx
        .select({ id: payments.id })
        .from(payments)
        .where(
          and(
            eq(payments.provider, "manual"),
            eq(payments.providerPaymentId, providerPaymentId),
          ),
        )
        .for("update")
        .limit(1);
      if (clientRequestCollision) {
        return completeAppointmentPaymentFailure(
          tx,
          mutation,
          claimed.claim,
          appointmentId,
          {
            ok: false,
            code: "conflict",
            message:
              "This manual-payment client request ID already belongs to another settled operation. Use the original Idempotency-Key to replay it.",
            retryable: false,
            fieldErrors: {
              clientRequestId: "Use a new request ID for a new operation.",
            },
          },
          409,
        );
      }

      const attemptRows = await tx
        .select({
          id: paymentAttempts.id,
          status: paymentAttempts.status,
          providerOrderId: paymentAttempts.providerOrderId,
          providerPaymentId: paymentAttempts.providerPaymentId,
          updatedAt: paymentAttempts.updatedAt,
        })
        .from(paymentAttempts)
        .where(
          and(
            eq(paymentAttempts.appointmentId, appointmentId),
            eq(paymentAttempts.provider, "square"),
          ),
        )
        .orderBy(desc(paymentAttempts.updatedAt))
        .for("update");
      const paymentRows = await tx
        .select({
          id: payments.id,
          paymentAttemptId: payments.paymentAttemptId,
          provider: payments.provider,
          status: payments.status,
          canonicalStatus: payments.canonicalStatus,
          providerStatus: payments.providerStatus,
        })
        .from(payments)
        .where(eq(payments.appointmentId, appointmentId))
        .for("update");
      const attemptSafety = classifyPaymentCollectionAttemptSafety({
        attempts: attemptRows,
        financiallyCompletedPaymentAttemptIds: new Set(
          paymentRows.flatMap((payment) => {
            const financiallyCompleted =
              payment.provider === "square" &&
              (payment.canonicalStatus === "completed" ||
                payment.status === "completed" ||
                payment.status === "succeeded" ||
                payment.providerStatus?.trim().toLowerCase() === "completed" ||
                payment.providerStatus?.trim().toLowerCase() === "succeeded");
            return payment.paymentAttemptId && financiallyCompleted
              ? [payment.paymentAttemptId]
              : [];
          }),
        ),
      });
      if (attemptSafety.kind !== "safe") {
        return completeAppointmentPaymentFailure(
          tx,
          mutation,
          claimed.claim,
          appointmentId,
          {
            ok: false,
            code: "conflict",
            message:
              attemptSafety.kind === "verification"
                ? "Wait for the active Square attempt to finish before recording cash or check."
                : "The previous Square attempt needs payment reconciliation before cash or check can be recorded.",
            retryable: false,
            attemptId: attemptSafety.attemptId,
          },
          409,
          { reason: `square_${attemptSafety.kind}_required` },
        );
      }

      const summaryBefore = await getAppointmentPaymentSummary(
        tx,
        appointmentId,
        {
          jobTotalCents: appointment.finalTotalCents,
          now,
          schemaAvailable: true,
        },
      );
      if (
        summaryBefore.status === "needs_review" ||
        summaryBefore.balanceCents === null ||
        summaryBefore.balanceCents <= 0 ||
        summaryBefore.paidTowardJobCents > appointment.finalTotalCents
      ) {
        return completeAppointmentPaymentFailure(
          tx,
          mutation,
          claimed.claim,
          appointmentId,
          {
            ok: false,
            code: "conflict",
            message:
              summaryBefore.balanceCents !== null &&
              summaryBefore.balanceCents <= 0 &&
              summaryBefore.status !== "needs_review"
                ? "This appointment is already paid."
                : "The payment ledger needs reconciliation before another payment can be recorded.",
            retryable: false,
          },
          409,
          { paymentStatus: summaryBefore.status },
        );
      }
      const totalAmountCents = summaryBefore.balanceCents + input.tipCents;
      if (
        !Number.isSafeInteger(totalAmountCents) ||
        totalAmountCents > 2_147_483_647
      ) {
        return completeAppointmentPaymentFailure(
          tx,
          mutation,
          claimed.claim,
          appointmentId,
          {
            ok: false,
            code: "invalid",
            message: "The balance and tip exceed the supported payment amount.",
            retryable: false,
            fieldErrors: { tipCents: "Reduce the tip amount." },
          },
          422,
        );
      }

      const committedAt = new Date(
        Math.max(Date.now(), appointment.updatedAt.getTime() + 1),
      );
      const version = committedAt.toISOString();
      const [appointmentVersionAdvanced] = await tx
        .update(appointments)
        .set({ updatedAt: committedAt })
        .where(
          and(
            eq(appointments.id, appointmentId),
            eq(appointments.updatedAt, appointment.updatedAt),
          ),
        )
        .returning({ id: appointments.id });
      if (!appointmentVersionAdvanced) {
        throw new TeamMutationFailure(
          "conflict",
          "The appointment changed while the payment was being recorded. Retry with the latest version.",
          { retryable: true },
        );
      }

      const [payment] = await tx
        .insert(payments)
        .values({
          provider: "manual",
          providerPaymentId,
          amount: totalAmountCents,
          jobAmountCents: summaryBefore.balanceCents,
          tipCents: input.tipCents,
          totalAmountCents,
          refundedAmountCents: 0,
          currency: "USD",
          status: "completed",
          canonicalStatus: "completed",
          providerStatus: "completed",
          method: input.tenderType,
          tenderType: input.tenderType,
          initiatedByMemberId: actorId,
          appointmentId,
          metadata: {
            clientRequestId: input.clientRequestId,
            note: input.note,
            operationId: mutation.operationId,
            correlationId: mutation.correlationId,
          },
          paidAt: committedAt,
          capturedAt: committedAt,
          createdAt: committedAt,
          updatedAt: committedAt,
        })
        .returning({ id: payments.id });
      if (!payment) {
        throw new TeamMutationFailure(
          "internal",
          "The manual payment could not be saved. No payment was recorded.",
          { retryable: true },
        );
      }

      const retryableAttempt = attemptSafety.retryableAttemptId
        ? attemptRows.find(
            (attempt) => attempt.id === attemptSafety.retryableAttemptId,
          )
        : undefined;
      if (retryableAttempt) {
        const [canceled] = await tx
          .update(paymentAttempts)
          .set({
            status: "canceled",
            errorCode: "manual_payment_recorded",
            errorMessage:
              "The remaining balance was recorded as a manual payment.",
            resolvedAt: committedAt,
            updatedAt: committedAt,
          })
          .where(
            and(
              eq(paymentAttempts.id, retryableAttempt.id),
              eq(paymentAttempts.appointmentId, appointmentId),
              eq(paymentAttempts.status, "retryable"),
              eq(paymentAttempts.updatedAt, retryableAttempt.updatedAt),
            ),
          )
          .returning({ id: paymentAttempts.id });
        if (!canceled) {
          throw new TeamMutationFailure(
            "conflict",
            "The safe Square retry changed before the manual payment could be recorded. Retry after reviewing payment state.",
            { retryable: true },
          );
        }
      }

      const paymentSummary = await getAppointmentPaymentSummary(
        tx,
        appointmentId,
        {
          jobTotalCents: appointment.finalTotalCents,
          now: committedAt,
          schemaAvailable: true,
        },
      );
      if (
        paymentSummary.status !== "paid" ||
        paymentSummary.balanceCents !== 0 ||
        paymentSummary.activeAttemptId !== null ||
        paymentSummary.paidTowardJobCents < appointment.finalTotalCents
      ) {
        throw new TeamMutationFailure(
          "internal",
          "The recorded payment did not settle the locked balance. No payment was saved.",
          { retryable: true },
        );
      }

      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "payment",
        entityId: payment.id,
        before: {
          appointmentVersion: currentVersion,
          balanceCents: summaryBefore.balanceCents,
          paymentStatus: summaryBefore.status,
        },
        after: {
          appointmentVersion: version,
          balanceCents: paymentSummary.balanceCents,
          paymentStatus: paymentSummary.status,
        },
        metadata: {
          appointmentId,
          clientRequestId: input.clientRequestId,
          tenderType: input.tenderType,
          jobAmountCents: summaryBefore.balanceCents,
          tipCents: input.tipCents,
          noteProvided: input.note !== null,
          canceledRetryableAttemptId: retryableAttempt?.id ?? null,
        },
        committedAt,
      });
      const result = teamMutationSuccessResult<ManualPaymentData>(
        mutation,
        {
          appointmentId,
          paymentId: payment.id,
          clientRequestId: input.clientRequestId,
          tenderType: input.tenderType,
          jobAmountCents: summaryBefore.balanceCents,
          tipCents: input.tipCents,
          totalAmountCents,
          status: "completed",
          paymentSummary,
          version,
        },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "payment",
          entityId: payment.id,
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

    return appointmentPaymentMutationResponse(
      outcome.result as ManualPaymentResult,
      outcome.status,
      mutation.correlationId,
    );
  } catch (error) {
    await recordTeamMutationFailure(mutation, {
      entityType: "appointment",
      code: error instanceof TeamMutationFailure ? error.code : "internal",
      metadata: {
        route: "manual_payments",
        boundary: claim ? "execution" : "input",
      },
    });
    if (database && claim) {
      try {
        await settleTeamMutationIdempotencyFailure(
          database,
          mutation,
          claim,
          error,
        );
      } catch (settlementError) {
        console.error("[appointment-manual-payment] settlement_failed", {
          operationId: mutation.operationId,
          correlationId: mutation.correlationId,
          errorName:
            settlementError instanceof Error
              ? settlementError.name
              : "UnknownError",
        });
      }
    }
    const failure = teamMutationExceptionResult(error);
    return appointmentPaymentMutationResponse(
      failure.result,
      failure.status,
      mutation.correlationId,
      { retryAfter: failure.retryAfter },
    );
  }
}
