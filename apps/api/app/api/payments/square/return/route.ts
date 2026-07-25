import crypto from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDb, paymentAttempts } from "@/db";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { getAppointmentPaymentSummary } from "@/lib/payment-ledger";
import { parseSquarePosCallback, verifySquarePosState } from "@/lib/square-pos";
import {
  hashSquareReturnNonce,
  reconcileSquareAttempt,
} from "@/lib/square-payments";
import { isAdminRequest } from "../../../web/admin";

function toSearchParams(value: unknown): URLSearchParams | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const query =
    record["query"] && typeof record["query"] === "object"
      ? (record["query"] as Record<string, unknown>)
      : record;
  const params = new URLSearchParams();
  for (const [key, raw] of Object.entries(query)) {
    if (typeof raw === "string") {
      params.set(key, raw);
    } else if (Array.isArray(raw)) {
      for (const item of raw) {
        if (typeof item === "string") params.append(key, item);
      }
    }
  }
  return params;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const params = toSearchParams(await request.json().catch(() => null));
  const callback = params ? parseSquarePosCallback(params) : null;
  if (!callback?.state) {
    return NextResponse.json(
      { error: "invalid_square_callback" },
      { status: 400 },
    );
  }
  const stateSecret = process.env["SQUARE_POS_STATE_SECRET"]?.trim();
  if (!stateSecret) {
    return NextResponse.json(
      { error: "square_not_configured" },
      { status: 503 },
    );
  }
  const state = verifySquarePosState({
    state: callback.state,
    secret: stateSecret,
  });
  if (!state) {
    return NextResponse.json(
      { error: "invalid_or_expired_square_state" },
      { status: 401 },
    );
  }

  const db = getDb();
  const [attempt] = await db
    .select({
      id: paymentAttempts.id,
      appointmentId: paymentAttempts.appointmentId,
      status: paymentAttempts.status,
      returnNonceHash: paymentAttempts.returnNonceHash,
      returnStateExpiresAt: paymentAttempts.returnStateExpiresAt,
      metadata: paymentAttempts.metadata,
    })
    .from(paymentAttempts)
    .where(
      and(
        eq(paymentAttempts.id, state.attemptId),
        eq(paymentAttempts.provider, "square"),
      ),
    )
    .limit(1);
  if (!attempt) {
    return NextResponse.json(
      { error: "payment_attempt_not_found" },
      { status: 404 },
    );
  }
  const nonceHash = hashSquareReturnNonce(state.nonce);
  if (
    !attempt.returnNonceHash ||
    !safeEqual(attempt.returnNonceHash, nonceHash) ||
    !attempt.returnStateExpiresAt ||
    attempt.returnStateExpiresAt < new Date()
  ) {
    return NextResponse.json(
      { error: "square_state_nonce_mismatch" },
      { status: 401 },
    );
  }
  if (attempt.status === "completed") {
    return NextResponse.json({
      ok: true,
      status: "verified",
      appointmentId: attempt.appointmentId,
      attemptId: attempt.id,
      paymentSummary: await getAppointmentPaymentSummary(
        db,
        attempt.appointmentId,
      ),
    });
  }

  const actor = getAuditActorFromRequest(request);
  if (callback.status === "error") {
    await db
      .update(paymentAttempts)
      .set({
        status: "pending_verification",
        ...(callback.transactionId
          ? { providerOrderId: callback.transactionId }
          : {}),
        errorCode: callback.errorCode ?? "square_pos_error",
        errorMessage: callback.errorDescription,
        resolvedAt: null,
        metadata: {
          ...(attempt.metadata ?? {}),
          callbackPlatform: callback.platform,
          clientTransactionId: callback.clientTransactionId,
          provisionalCallbackStatus: "error",
        },
        updatedAt: new Date(),
      })
      .where(eq(paymentAttempts.id, attempt.id));
    await recordAuditEvent({
      actor,
      action: "payment.square.verification_pending",
      entityType: "payment_attempt",
      entityId: attempt.id,
      meta: {
        appointmentId: attempt.appointmentId,
        errorCode: callback.errorCode,
        platform: callback.platform,
      },
    });
    if (!callback.transactionId) {
      return NextResponse.json({
        ok: true,
        status: "pending_verification",
        appointmentId: attempt.appointmentId,
        attemptId: attempt.id,
        errorCode: callback.errorCode,
      });
    }
  }

  if (!callback.transactionId) {
    await db
      .update(paymentAttempts)
      .set({
        status: "pending_verification",
        errorCode: "square_transaction_id_missing",
        updatedAt: new Date(),
      })
      .where(eq(paymentAttempts.id, attempt.id));
    return NextResponse.json({
      ok: true,
      status: "pending_verification",
      appointmentId: attempt.appointmentId,
      attemptId: attempt.id,
      errorCode: "square_transaction_id_missing",
    });
  }

  await db
    .update(paymentAttempts)
    .set({
      status: "pending_verification",
      providerOrderId: callback.transactionId,
      errorCode: null,
      errorMessage: null,
      metadata: {
        ...(attempt.metadata ?? {}),
        callbackPlatform: callback.platform,
        clientTransactionId: callback.clientTransactionId,
      },
      updatedAt: new Date(),
    })
    .where(eq(paymentAttempts.id, attempt.id));
  const reconciled = await reconcileSquareAttempt({
    attemptId: attempt.id,
    orderId: callback.transactionId,
  });
  const summary = await getAppointmentPaymentSummary(db, attempt.appointmentId);
  await recordAuditEvent({
    actor,
    action:
      reconciled.status === "verified"
        ? "payment.square.verified"
        : "payment.square.verification_pending",
    entityType: "payment_attempt",
    entityId: attempt.id,
    meta: {
      appointmentId: attempt.appointmentId,
      providerOrderId: callback.transactionId,
      reconciliationStatus: reconciled.status,
      ...("errorCode" in reconciled ? { errorCode: reconciled.errorCode } : {}),
    },
  });

  return NextResponse.json({
    ok: true,
    status: reconciled.status,
    appointmentId: attempt.appointmentId,
    attemptId: attempt.id,
    paymentSummary: summary,
    ...("errorCode" in reconciled ? { errorCode: reconciled.errorCode } : {}),
  });
}
