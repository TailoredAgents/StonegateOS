import crypto from "node:crypto";
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
import { isSquarePosEnabled } from "@/lib/payment-feature-flags";
import {
  canCollectAppointmentPayment,
  expireStalePaymentAttemptsForAppointment,
  getAppointmentPaymentSummary,
} from "@/lib/payment-ledger";
import { isPaymentLedgerSchemaAvailable } from "@/lib/payment-schema";
import {
  hashSquareAttemptLaunchBinding,
  type SquareAttemptLaunchBinding,
} from "@/lib/square-attempt-binding";
import {
  buildSquarePosLaunchUrl,
  createSquarePosState,
  squareAttemptNote,
} from "@/lib/square-pos";
import { hashSquareReturnNonce } from "@/lib/square-payments";
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

const ATTEMPT_TTL_SECONDS = 30 * 60;
const SAFE_CONFIG_VALUE = /^\S.{0,498}\S$|^\S$/u;

const canonicalUuid = z
  .string()
  .transform((value) => value.normalize("NFKC").trim().toLowerCase())
  .pipe(z.string().regex(APPOINTMENT_PAYMENT_ID_PATTERN));
const canonicalPlatform = z
  .string()
  .transform((value) => value.normalize("NFKC").trim().toLowerCase())
  .pipe(z.enum(["ios", "android"]));
const CreateAttemptSchema = z
  .object({
    clientRequestId: canonicalUuid,
    platform: canonicalPlatform,
  })
  .strict();

type SquareAttemptData = {
  appointmentId: string;
  attemptId: string;
  clientRequestId: string;
  platform: "ios" | "android";
  amountCents: number;
  status: "launched";
  expiresAt: string;
  launchUrl: string;
  paymentSummary: Awaited<ReturnType<typeof getAppointmentPaymentSummary>>;
  version: string;
};

type SquareAttemptResult = MutationResult<SquareAttemptData>;

type SquareLaunchConfiguration = {
  applicationId: string;
  locationId: string;
  callbackUrl: string;
  fallbackUrl: string;
  stateSecret: string;
};

function secureHttpsUrl(value: string | undefined): string | null {
  const normalized = value?.trim() ?? "";
  if (normalized.length === 0 || normalized.length > 2_048) return null;
  try {
    const url = new URL(normalized);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function squareLaunchConfiguration(): SquareLaunchConfiguration | null {
  const applicationId = process.env["SQUARE_APPLICATION_ID"]?.trim() ?? "";
  const locationId = process.env["SQUARE_LOCATION_ID"]?.trim() ?? "";
  const callbackUrl = secureHttpsUrl(process.env["SQUARE_POS_CALLBACK_URL"]);
  const fallbackUrl = secureHttpsUrl(process.env["SQUARE_POS_FALLBACK_URL"]);
  const stateSecret = process.env["SQUARE_POS_STATE_SECRET"]?.trim() ?? "";
  if (
    !SAFE_CONFIG_VALUE.test(applicationId) ||
    !SAFE_CONFIG_VALUE.test(locationId) ||
    !callbackUrl ||
    !fallbackUrl ||
    Buffer.byteLength(stateSecret, "utf8") < 32 ||
    Buffer.byteLength(stateSecret, "utf8") > 4_096
  ) {
    return null;
  }
  return { applicationId, locationId, callbackUrl, fallbackUrl, stateSecret };
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
    auditAction: "payment.square.attempt_launched",
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
    const actorSessionId = mutation.actor.sessionId;
    const actorAuthMethod = mutation.actor.authMethod;
    if (!isSquarePosEnabled()) {
      throw new TeamMutationFailure(
        "forbidden",
        "Square payment collection is temporarily unavailable.",
        { status: 503 },
      );
    }
    if (request.nextUrl.search.length > 0) {
      throw new TeamMutationFailure(
        "invalid",
        "Square payment requests do not accept query parameters.",
      );
    }

    const { id: rawAppointmentId } = await context.params;
    const appointmentId =
      rawAppointmentId?.normalize("NFKC").trim().toLowerCase() ?? "";
    if (!APPOINTMENT_PAYMENT_ID_PATTERN.test(appointmentId)) {
      throw new TeamMutationFailure(
        "invalid",
        "Choose a valid appointment before collecting payment.",
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
    const parsed = CreateAttemptSchema.safeParse(body);
    if (!parsed.success) {
      throw new TeamMutationFailure(
        "invalid",
        "Choose this device platform and use one valid client request ID.",
        {
          fieldErrors: {
            clientRequestId: "Use one stable UUID for this Square attempt.",
            platform: "Choose iOS or Android.",
          },
        },
      );
    }
    const configuration = squareLaunchConfiguration();
    if (!configuration) {
      throw new TeamMutationFailure(
        "internal",
        "Square payment collection is not securely configured.",
        { status: 503 },
      );
    }

    database = getDb();
    const claimed = await claimTeamMutationIdempotency(database, mutation, {
      route: "POST /api/appointments/:appointmentId/payment-attempts",
      entityType: "appointment",
      entityId: appointmentId,
      payload: parsed.data,
    });
    if (claimed.kind === "replay") {
      return appointmentPaymentMutationResponse(
        claimed.replay.result as SquareAttemptResult,
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
        sql`select pg_advisory_xact_lock(hashtext('payment_client_request'), hashtext(${parsed.data.clientRequestId}))`,
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
              "This appointment changed on another screen. Refresh its balance before collecting payment.",
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
            message: "Set the final job total before collecting payment.",
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
              "The quoted scope could not be verified. No payment was started.",
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
              "Add the quoted-to-remove summary before accepting payment.",
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

      const [clientRequestCollision] = await tx
        .select({ id: paymentAttempts.id })
        .from(paymentAttempts)
        .where(eq(paymentAttempts.clientRequestId, parsed.data.clientRequestId))
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
              "This Square client request ID already belongs to another settled operation. Use the original Idempotency-Key to replay it.",
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
          metadata: paymentAttempts.metadata,
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
                ? "StonegateOS is still verifying the previous Square payment."
                : "The previous Square attempt needs payment reconciliation before another payment can start.",
            retryable: false,
            attemptId: attemptSafety.attemptId,
          },
          409,
          { reason: `square_${attemptSafety.kind}_required` },
        );
      }

      const retryableAttempt = attemptSafety.retryableAttemptId
        ? attemptRows.find(
            (attempt) => attempt.id === attemptSafety.retryableAttemptId,
          )
        : undefined;

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
                : "The payment ledger needs reconciliation before another payment can start.",
            retryable: false,
          },
          409,
          { paymentStatus: summaryBefore.status },
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
          "The appointment changed while Square payment collection was starting. Retry with the latest version.",
          { retryable: true },
        );
      }

      const attemptId = retryableAttempt?.id ?? crypto.randomUUID();
      const expiresAt = new Date(
        (Math.floor(now.getTime() / 1_000) + ATTEMPT_TTL_SECONDS) * 1_000,
      );
      const nonce = crypto.randomBytes(18).toString("base64url");
      const binding: SquareAttemptLaunchBinding = {
        platform: parsed.data.platform,
        amountCents: summaryBefore.balanceCents,
        appointmentId,
        attemptId,
        expiresAt: expiresAt.toISOString(),
        appointmentVersion: version,
        clientRequestId: parsed.data.clientRequestId,
        memberId: actorId,
        sessionId: actorSessionId,
        authMethod: actorAuthMethod,
      };
      const launchBindingHash = hashSquareAttemptLaunchBinding(binding);
      const state = createSquarePosState({
        attemptId,
        nonce,
        bindingHash: launchBindingHash,
        secret: configuration.stateSecret,
        now,
        ttlSeconds: ATTEMPT_TTL_SECONDS,
      });
      const launchUrl = buildSquarePosLaunchUrl({
        platform: parsed.data.platform,
        amountCents: summaryBefore.balanceCents,
        applicationId: configuration.applicationId,
        locationId: configuration.locationId,
        callbackUrl: configuration.callbackUrl,
        fallbackUrl: configuration.fallbackUrl,
        state,
        note: squareAttemptNote({ appointmentId, attemptId }),
      });
      const launchMetadata = {
        platform: parsed.data.platform,
        launchBinding: binding,
        launchBindingHash,
        operationId: mutation.operationId,
        correlationId: mutation.correlationId,
        launchedAt: committedAt.toISOString(),
      };

      if (retryableAttempt) {
        const retryable = retryableAttempt;
        const previousRetryCount =
          typeof retryable.metadata?.["retryCount"] === "number" &&
          Number.isSafeInteger(retryable.metadata["retryCount"])
            ? retryable.metadata["retryCount"]
            : 0;
        const [relaunched] = await tx
          .update(paymentAttempts)
          .set({
            clientRequestId: parsed.data.clientRequestId,
            status: "launched",
            requestedJobAmountCents: summaryBefore.balanceCents,
            currency: "USD",
            providerOrderId: null,
            providerPaymentId: null,
            squareLocationId: configuration.locationId,
            initiatedByMemberId: actorId,
            returnNonceHash: hashSquareReturnNonce(nonce),
            returnStateExpiresAt: expiresAt,
            expiresAt,
            resolvedAt: null,
            errorCode: null,
            errorMessage: null,
            metadata: {
              ...launchMetadata,
              retryCount: previousRetryCount + 1,
            },
            updatedAt: committedAt,
          })
          .where(
            and(
              eq(paymentAttempts.id, retryable.id),
              eq(paymentAttempts.appointmentId, appointmentId),
              eq(paymentAttempts.status, "retryable"),
              eq(paymentAttempts.updatedAt, retryable.updatedAt),
            ),
          )
          .returning({ id: paymentAttempts.id });
        if (!relaunched) {
          throw new TeamMutationFailure(
            "conflict",
            "The Square attempt changed before it could be relaunched. Retry after reviewing its latest state.",
            { retryable: true },
          );
        }
      } else {
        await tx.insert(paymentAttempts).values({
          id: attemptId,
          appointmentId,
          provider: "square",
          clientRequestId: parsed.data.clientRequestId,
          status: "launched",
          requestedJobAmountCents: summaryBefore.balanceCents,
          currency: "USD",
          squareLocationId: configuration.locationId,
          initiatedByMemberId: actorId,
          returnNonceHash: hashSquareReturnNonce(nonce),
          returnStateExpiresAt: expiresAt,
          expiresAt,
          metadata: launchMetadata,
          createdAt: committedAt,
          updatedAt: committedAt,
        });
      }

      const paymentSummary = await getAppointmentPaymentSummary(
        tx,
        appointmentId,
        {
          jobTotalCents: appointment.finalTotalCents,
          now,
          schemaAvailable: true,
        },
      );
      if (paymentSummary.activeAttemptId !== attemptId) {
        throw new TeamMutationFailure(
          "internal",
          "The Square attempt was not reflected in the payment ledger. No launch was saved.",
          { retryable: true },
        );
      }

      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "payment_attempt",
        entityId: attemptId,
        before: {
          appointmentVersion: currentVersion,
          balanceCents: summaryBefore.balanceCents,
          retryableAttemptId: retryableAttempt?.id ?? null,
        },
        after: {
          appointmentVersion: version,
          attemptStatus: "launched",
          amountCents: summaryBefore.balanceCents,
          expiresAt: expiresAt.toISOString(),
        },
        metadata: {
          appointmentId,
          clientRequestId: parsed.data.clientRequestId,
          platform: parsed.data.platform,
          launchBindingHash,
          relaunched: retryableAttempt !== undefined,
        },
        committedAt,
      });
      const result = teamMutationSuccessResult<SquareAttemptData>(
        mutation,
        {
          appointmentId,
          attemptId,
          clientRequestId: parsed.data.clientRequestId,
          platform: parsed.data.platform,
          amountCents: summaryBefore.balanceCents,
          status: "launched",
          expiresAt: expiresAt.toISOString(),
          launchUrl,
          paymentSummary,
          version,
        },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "payment_attempt",
          entityId: attemptId,
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
      outcome.result as SquareAttemptResult,
      outcome.status,
      mutation.correlationId,
    );
  } catch (error) {
    await recordTeamMutationFailure(mutation, {
      entityType: "appointment",
      code: error instanceof TeamMutationFailure ? error.code : "internal",
      metadata: {
        route: "payment_attempts",
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
        console.error("[appointment-payment-attempt] settlement_failed", {
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
