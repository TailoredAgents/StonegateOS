import crypto from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { appointments, getDb, paymentAttempts } from "@/db";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import {
  AppointmentMediaError,
  getAppointmentScopeState,
} from "@/lib/appointment-media";
import { isSquarePosEnabled } from "@/lib/payment-feature-flags";
import {
  ACTIVE_PAYMENT_ATTEMPT_STATUSES,
  canCollectAppointmentPayment,
  canRetrySquareAttempt,
  expireStalePaymentAttemptsForAppointment,
  getActivePaymentAttempt,
  getAppointmentPaymentSummary,
  RETRYABLE_SQUARE_ATTEMPT_STATUS,
  requiresSquareAttemptReconciliation,
  UNRESOLVED_SQUARE_ATTEMPT_STATUSES,
} from "@/lib/payment-ledger";
import { isPaymentLedgerSchemaAvailable } from "@/lib/payment-schema";
import { requirePermission } from "@/lib/permissions";
import {
  buildSquarePosLaunchUrl,
  createSquarePosState,
  squareAttemptNote,
  verifySquarePosState,
} from "@/lib/square-pos";
import { hashSquareReturnNonce } from "@/lib/square-payments";
import { isAdminRequest } from "../../../web/admin";

const ATTEMPT_TTL_MS = 30 * 60 * 1_000;

const CreateAttemptSchema = z.object({
  clientRequestId: z.string().uuid(),
  platform: z.enum(["ios", "android"]),
});

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function pgCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  if (typeof record["code"] === "string") return record["code"];
  const cause = record["cause"];
  if (cause && typeof cause === "object") {
    const code = (cause as Record<string, unknown>)["code"];
    return typeof code === "string" ? code : null;
  }
  return null;
}

function isUuid(value: string | null | undefined): value is string {
  return Boolean(
    value &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value,
      ),
  );
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "payments.collect");
  if (permissionError) return permissionError;
  if (!isSquarePosEnabled()) {
    return NextResponse.json({ error: "square_pos_disabled" }, { status: 503 });
  }
  const db = getDb();
  if (!(await isPaymentLedgerSchemaAvailable(db))) {
    return NextResponse.json(
      { error: "payment_ledger_unavailable" },
      { status: 503 },
    );
  }

  const parsed = CreateAttemptSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", message: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { id: appointmentId } = await context.params;
  let scope;
  try {
    scope = await getAppointmentScopeState(appointmentId);
  } catch (error) {
    if (
      error instanceof AppointmentMediaError &&
      error.code === "appointment_not_found"
    ) {
      return NextResponse.json(
        { error: "appointment_not_found" },
        { status: 404 },
      );
    }
    console.error("[square] appointment scope check failed", {
      appointmentId,
      error: String(error),
    });
    return NextResponse.json(
      { error: "appointment_scope_unavailable" },
      { status: 503 },
    );
  }
  if (scope.needsScope) {
    return NextResponse.json(
      {
        error: "quoted_scope_required",
        message: "Add the quoted-to-remove summary before accepting payment.",
      },
      { status: 409 },
    );
  }

  let applicationId: string;
  let locationId: string;
  let callbackUrl: string;
  let fallbackUrl: string;
  let stateSecret: string;
  try {
    applicationId = requiredEnv("SQUARE_APPLICATION_ID");
    locationId = requiredEnv("SQUARE_LOCATION_ID");
    callbackUrl = requiredEnv("SQUARE_POS_CALLBACK_URL");
    fallbackUrl = requiredEnv("SQUARE_POS_FALLBACK_URL");
    stateSecret = requiredEnv("SQUARE_POS_STATE_SECRET");
    if (Buffer.byteLength(stateSecret, "utf8") < 32) {
      throw new Error("SQUARE_POS_STATE_SECRET must be at least 32 bytes");
    }
  } catch (error) {
    return NextResponse.json(
      { error: "square_not_configured", message: String(error) },
      { status: 503 },
    );
  }

  const actor = getAuditActorFromRequest(request);
  const now = new Date();

  let result:
    | {
        kind: "ready";
        id: string;
        amountCents: number;
        appointmentId: string;
        expiresAt: Date;
        metadata: Record<string, unknown> | null;
        reused: boolean;
      }
    | { kind: "not_found" }
    | { kind: "appointment_not_collectible"; appointmentStatus: string }
    | { kind: "scope_required" }
    | { kind: "total_required" }
    | { kind: "already_paid" }
    | { kind: "verification_in_progress"; attemptId: string }
    | { kind: "reconciliation_required"; attemptId: string }
    | { kind: "request_conflict" };
  try {
    result = await db.transaction(async (tx) => {
      const [appointment] = await tx
        .select({
          id: appointments.id,
          finalTotalCents: appointments.finalTotalCents,
          status: appointments.status,
          type: appointments.type,
        })
        .from(appointments)
        .where(eq(appointments.id, appointmentId))
        .limit(1)
        .for("update");
      if (!appointment) return { kind: "not_found" as const };
      if (!canCollectAppointmentPayment(appointment.status, appointment.type)) {
        return {
          kind: "appointment_not_collectible" as const,
          appointmentStatus: appointment.status,
        };
      }
      const lockedScope = await getAppointmentScopeState(appointmentId, tx);
      if (lockedScope.needsScope) {
        return { kind: "scope_required" as const };
      }
      if (
        appointment.finalTotalCents == null ||
        appointment.finalTotalCents <= 0
      ) {
        return { kind: "total_required" as const };
      }
      await expireStalePaymentAttemptsForAppointment(tx, appointmentId, now);
      const summary = await getAppointmentPaymentSummary(tx, appointmentId, {
        jobTotalCents: appointment.finalTotalCents,
        now,
      });
      if (summary.balanceCents == null || summary.balanceCents <= 0) {
        return { kind: "already_paid" as const };
      }

      const [sameRequest] = await tx
        .select({
          id: paymentAttempts.id,
          appointmentId: paymentAttempts.appointmentId,
          status: paymentAttempts.status,
          requestedJobAmountCents: paymentAttempts.requestedJobAmountCents,
          expiresAt: paymentAttempts.expiresAt,
          metadata: paymentAttempts.metadata,
        })
        .from(paymentAttempts)
        .where(eq(paymentAttempts.clientRequestId, parsed.data.clientRequestId))
        .limit(1);
      if (sameRequest) {
        if (sameRequest.appointmentId !== appointmentId) {
          return { kind: "request_conflict" as const };
        }
        if (canRetrySquareAttempt(sameRequest.status)) {
          // Continue below. A provider-declared setup/cancel error with no
          // transaction can safely relaunch this same attempt with fresh state.
        } else if (requiresSquareAttemptReconciliation(sameRequest.status)) {
          return {
            kind: "reconciliation_required" as const,
            attemptId: sameRequest.id,
          };
        } else if (sameRequest.status === "pending_verification") {
          return {
            kind: "verification_in_progress" as const,
            attemptId: sameRequest.id,
          };
        } else if (
          ACTIVE_PAYMENT_ATTEMPT_STATUSES.includes(
            sameRequest.status as (typeof ACTIVE_PAYMENT_ATTEMPT_STATUSES)[number],
          ) &&
          sameRequest.requestedJobAmountCents === summary.balanceCents
        ) {
          return {
            kind: "ready" as const,
            id: sameRequest.id,
            amountCents: sameRequest.requestedJobAmountCents,
            appointmentId,
            expiresAt: sameRequest.expiresAt,
            metadata: sameRequest.metadata,
            reused: true,
          };
        } else {
          return sameRequest.status === "completed"
            ? { kind: "already_paid" as const }
            : { kind: "request_conflict" as const };
        }
      }

      const [unresolvedAttempt] = await tx
        .select({ id: paymentAttempts.id })
        .from(paymentAttempts)
        .where(
          and(
            eq(paymentAttempts.appointmentId, appointmentId),
            eq(paymentAttempts.provider, "square"),
            inArray(paymentAttempts.status, [
              ...UNRESOLVED_SQUARE_ATTEMPT_STATUSES,
            ]),
          ),
        )
        .orderBy(desc(paymentAttempts.updatedAt))
        .limit(1);
      if (unresolvedAttempt) {
        return {
          kind: "reconciliation_required" as const,
          attemptId: unresolvedAttempt.id,
        };
      }

      const active = await getActivePaymentAttempt(tx, appointmentId, now);
      if (active) {
        if (active.status === "pending_verification") {
          return {
            kind: "verification_in_progress" as const,
            attemptId: active.id,
          };
        }
        if (active.requestedJobAmountCents === summary.balanceCents) {
          return {
            kind: "ready" as const,
            id: active.id,
            amountCents: active.requestedJobAmountCents,
            appointmentId,
            expiresAt: active.expiresAt,
            metadata: active.metadata,
            reused: true,
          };
        }
        await tx
          .update(paymentAttempts)
          .set({
            status: "expired",
            resolvedAt: now,
            errorCode: "appointment_balance_changed",
            updatedAt: now,
          })
          .where(eq(paymentAttempts.id, active.id));
        return {
          kind: "reconciliation_required" as const,
          attemptId: active.id,
        };
      }

      const retryableAttempt =
        sameRequest && canRetrySquareAttempt(sameRequest.status)
          ? sameRequest
          : (
              await tx
                .select({
                  id: paymentAttempts.id,
                  appointmentId: paymentAttempts.appointmentId,
                  status: paymentAttempts.status,
                  requestedJobAmountCents:
                    paymentAttempts.requestedJobAmountCents,
                  expiresAt: paymentAttempts.expiresAt,
                  metadata: paymentAttempts.metadata,
                })
                .from(paymentAttempts)
                .where(
                  and(
                    eq(paymentAttempts.appointmentId, appointmentId),
                    eq(paymentAttempts.provider, "square"),
                    eq(paymentAttempts.status, RETRYABLE_SQUARE_ATTEMPT_STATUS),
                  ),
                )
                .orderBy(desc(paymentAttempts.updatedAt))
                .limit(1)
            )[0];
      if (retryableAttempt) {
        const retryExpiresAt = new Date(now.getTime() + ATTEMPT_TTL_MS);
        const retryNonce = crypto.randomBytes(18).toString("base64url");
        const retryState = createSquarePosState({
          attemptId: retryableAttempt.id,
          nonce: retryNonce,
          secret: stateSecret,
          now,
          ttlSeconds: ATTEMPT_TTL_MS / 1_000,
        });
        const retryStateExpiresAt = new Date(
          (Math.floor(now.getTime() / 1_000) + ATTEMPT_TTL_MS / 1_000) * 1_000,
        );
        const previousRetryCount =
          typeof retryableAttempt.metadata?.["retryCount"] === "number" &&
          Number.isSafeInteger(retryableAttempt.metadata["retryCount"])
            ? retryableAttempt.metadata["retryCount"]
            : 0;
        const [retried] = await tx
          .update(paymentAttempts)
          .set({
            status: "created",
            requestedJobAmountCents: summary.balanceCents,
            currency: "USD",
            providerOrderId: null,
            providerPaymentId: null,
            squareLocationId: locationId,
            initiatedByMemberId: isUuid(actor.id) ? actor.id : null,
            returnNonceHash: hashSquareReturnNonce(retryNonce),
            returnStateExpiresAt: retryStateExpiresAt,
            expiresAt: retryExpiresAt,
            resolvedAt: null,
            errorCode: null,
            errorMessage: null,
            metadata: {
              ...(retryableAttempt.metadata ?? {}),
              platform: parsed.data.platform,
              squareReturnState: retryState,
              retryCount: previousRetryCount + 1,
              retriedAt: now.toISOString(),
            },
            updatedAt: now,
          })
          .where(
            and(
              eq(paymentAttempts.id, retryableAttempt.id),
              eq(paymentAttempts.appointmentId, appointmentId),
              eq(paymentAttempts.status, RETRYABLE_SQUARE_ATTEMPT_STATUS),
            ),
          )
          .returning({
            id: paymentAttempts.id,
            requestedJobAmountCents: paymentAttempts.requestedJobAmountCents,
            expiresAt: paymentAttempts.expiresAt,
            metadata: paymentAttempts.metadata,
          });
        if (!retried) throw new Error("payment_attempt_retry_conflict");
        return {
          kind: "ready" as const,
          id: retried.id,
          amountCents: retried.requestedJobAmountCents,
          appointmentId,
          expiresAt: retried.expiresAt,
          metadata: retried.metadata,
          reused: true,
        };
      }

      const createdAttemptId = crypto.randomUUID();
      const createdExpiresAt = new Date(now.getTime() + ATTEMPT_TTL_MS);
      const createdNonce = crypto.randomBytes(18).toString("base64url");
      const createdReturnState = createSquarePosState({
        attemptId: createdAttemptId,
        nonce: createdNonce,
        secret: stateSecret,
        now,
        ttlSeconds: ATTEMPT_TTL_MS / 1_000,
      });
      const createdReturnStateExpiresAt = new Date(
        (Math.floor(now.getTime() / 1_000) + ATTEMPT_TTL_MS / 1_000) * 1_000,
      );
      const [created] = await tx
        .insert(paymentAttempts)
        .values({
          id: createdAttemptId,
          appointmentId,
          provider: "square",
          clientRequestId: parsed.data.clientRequestId,
          status: "created",
          requestedJobAmountCents: summary.balanceCents,
          currency: "USD",
          squareLocationId: locationId,
          initiatedByMemberId: isUuid(actor.id) ? actor.id : null,
          returnNonceHash: hashSquareReturnNonce(createdNonce),
          returnStateExpiresAt: createdReturnStateExpiresAt,
          expiresAt: createdExpiresAt,
          metadata: {
            platform: parsed.data.platform,
            squareReturnState: createdReturnState,
          },
          createdAt: now,
          updatedAt: now,
        })
        .returning({
          id: paymentAttempts.id,
          requestedJobAmountCents: paymentAttempts.requestedJobAmountCents,
          expiresAt: paymentAttempts.expiresAt,
          metadata: paymentAttempts.metadata,
        });
      if (!created) throw new Error("payment_attempt_create_failed");
      return {
        kind: "ready" as const,
        id: created.id,
        amountCents: created.requestedJobAmountCents,
        appointmentId,
        expiresAt: created.expiresAt,
        metadata: created.metadata,
        reused: false,
      };
    });
  } catch (error) {
    if (pgCode(error) !== "23505") throw error;
    const active = await getActivePaymentAttempt(db, appointmentId, now);
    if (!active) throw error;
    result =
      active.status === "pending_verification"
        ? {
            kind: "verification_in_progress",
            attemptId: active.id,
          }
        : {
            kind: "ready",
            id: active.id,
            amountCents: active.requestedJobAmountCents,
            appointmentId,
            expiresAt: active.expiresAt,
            metadata: active.metadata,
            reused: true,
          };
  }

  if (result.kind === "not_found") {
    return NextResponse.json(
      { error: "appointment_not_found" },
      { status: 404 },
    );
  }
  if (result.kind === "appointment_not_collectible") {
    return NextResponse.json(
      {
        error: "appointment_not_collectible",
        appointmentStatus: result.appointmentStatus,
        message:
          "Payments cannot be collected for canceled, no-show, or quote-only appointments.",
      },
      { status: 409 },
    );
  }
  if (result.kind === "total_required") {
    return NextResponse.json(
      { error: "final_total_required" },
      { status: 409 },
    );
  }
  if (result.kind === "scope_required") {
    return NextResponse.json(
      {
        error: "quoted_scope_required",
        message: "Add the quoted-to-remove summary before accepting payment.",
      },
      { status: 409 },
    );
  }
  if (result.kind === "already_paid") {
    return NextResponse.json(
      { error: "appointment_already_paid" },
      { status: 409 },
    );
  }
  if (result.kind === "request_conflict") {
    return NextResponse.json(
      { error: "payment_request_conflict" },
      { status: 409 },
    );
  }
  if (result.kind === "verification_in_progress") {
    return NextResponse.json(
      {
        error: "square_verification_in_progress",
        attemptId: result.attemptId,
        message: "StonegateOS is still verifying the previous Square payment.",
      },
      { status: 409 },
    );
  }
  if (result.kind === "reconciliation_required") {
    return NextResponse.json(
      {
        error: "square_reconciliation_required",
        attemptId: result.attemptId,
        message:
          "The previous Square attempt must be reviewed by an owner before another payment can start.",
      },
      { status: 409 },
    );
  }

  const persistedState =
    typeof result.metadata?.["squareReturnState"] === "string"
      ? result.metadata["squareReturnState"]
      : null;
  const verifiedPersistedState = persistedState
    ? verifySquarePosState({
        state: persistedState,
        secret: stateSecret,
        now,
      })
    : null;
  const canReuseState =
    verifiedPersistedState?.attemptId === result.id &&
    verifiedPersistedState.expiresAt <= result.expiresAt;
  const nonce = canReuseState
    ? verifiedPersistedState.nonce
    : crypto.randomBytes(18).toString("base64url");
  const state = canReuseState
    ? persistedState!
    : createSquarePosState({
        attemptId: result.id,
        nonce,
        secret: stateSecret,
        now,
        ttlSeconds: Math.max(
          1,
          Math.floor((result.expiresAt.getTime() - now.getTime()) / 1_000),
        ),
      });
  const stateExpiresAt = canReuseState
    ? verifiedPersistedState.expiresAt
    : verifySquarePosState({ state, secret: stateSecret, now })!.expiresAt;
  const launchUrl = buildSquarePosLaunchUrl({
    platform: parsed.data.platform,
    amountCents: result.amountCents,
    applicationId,
    locationId,
    callbackUrl,
    fallbackUrl,
    state,
    note: squareAttemptNote({ appointmentId, attemptId: result.id }),
  });
  const [launched] = await db
    .update(paymentAttempts)
    .set({
      status: "launched",
      returnNonceHash: hashSquareReturnNonce(nonce),
      returnStateExpiresAt: stateExpiresAt,
      errorCode: null,
      errorMessage: null,
      metadata: {
        ...(result.metadata ?? {}),
        squareReturnState: state,
        lastLaunchPlatform: parsed.data.platform,
      },
      updatedAt: now,
    })
    .where(
      and(
        eq(paymentAttempts.id, result.id),
        eq(paymentAttempts.appointmentId, appointmentId),
        inArray(paymentAttempts.status, ["created", "launched"]),
      ),
    )
    .returning({ id: paymentAttempts.id });
  if (!launched) {
    return NextResponse.json(
      {
        error: "square_verification_in_progress",
        attemptId: result.id,
        message:
          "The Square payment changed state before it could be launched again.",
      },
      { status: 409 },
    );
  }
  await recordAuditEvent({
    actor,
    action: "payment.square.launched",
    entityType: "payment_attempt",
    entityId: result.id,
    meta: {
      appointmentId,
      amountCents: result.amountCents,
      platform: parsed.data.platform,
      reused: result.reused,
      stateReused: canReuseState,
    },
  });

  return NextResponse.json({
    ok: true,
    attemptId: result.id,
    appointmentId,
    status: "launched",
    amountCents: result.amountCents,
    currency: "USD",
    platform: parsed.data.platform,
    launchUrl,
    expiresAt: result.expiresAt.toISOString(),
    reused: result.reused,
  });
}
