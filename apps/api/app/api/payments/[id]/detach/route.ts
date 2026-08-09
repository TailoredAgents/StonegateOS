import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { appointments, getDb, payments } from "@/db";
import {
  DetachLegacyPaymentRequestSchema,
  nextPaymentAssociationVersion,
  paymentProviderBindingMatches,
} from "@/lib/payment-association";
import { syncAppointmentCardTipCents } from "@/lib/payment-ledger";
import { isPaymentLedgerSchemaAvailable } from "@/lib/payment-schema";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  type TeamMutationIdempotencyClaim,
  teamMutationIdempotencyReplayResponse,
} from "@/lib/team-mutation-idempotency";
import {
  assertTeamMutationExpectedVersion,
  beginTeamMutation,
  TeamMutationFailure,
  teamMutationErrorResponse,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";

type RouteContext = { params: Promise<{ id?: string }> };
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["payments.reconcile", "payments.manage"],
    risk: "financial",
    requiresIdempotency: true,
    auditAction: "team_api.payments.id.detach.post",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;

  const { id: rawPaymentId } = await context.params;
  const paymentId = rawPaymentId?.trim() ?? "";
  if (!UUID_PATTERN.test(paymentId)) {
    return teamMutationErrorResponse(
      "invalid",
      "A valid payment ID is required.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { paymentId: "Select a valid payment record." },
      },
    );
  }
  if (mutation.expectedVersion === null || mutation.expectedVersion === "*") {
    return teamMutationErrorResponse(
      "invalid",
      "The latest payment version is required before changing its appointment link.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { version: "Refresh the payment and try again." },
      },
    );
  }

  const parsed = DetachLegacyPaymentRequestSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return teamMutationErrorResponse(
      "invalid",
      "The payment detachment request is incomplete or does not match its confirmation.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: {
          payment:
            "Refresh the payment, confirm DETACH PAYMENT, and provide a review reason.",
        },
      },
    );
  }

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    db = getDb();
    if (!(await isPaymentLedgerSchemaAvailable(db))) {
      return teamMutationErrorResponse(
        "internal",
        "Payment reconciliation is temporarily unavailable. No appointment link was changed.",
        {
          status: 503,
          retryable: true,
          correlationId: mutation.correlationId,
        },
      );
    }

    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/payments/:paymentId/detach",
      entityType: "payment",
      entityId: paymentId,
      payload: parsed.data,
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const result = await db.transaction(async (tx) => {
      const [appointment] = await tx
        .select({ id: appointments.id })
        .from(appointments)
        .where(eq(appointments.id, parsed.data.expectedAppointmentId))
        .for("update")
        .limit(1);
      if (!appointment) {
        throw new TeamMutationFailure(
          "conflict",
          "The payment's expected appointment is no longer available. Refresh before detaching it.",
        );
      }

      const [before] = await tx
        .select({
          id: payments.id,
          provider: payments.provider,
          providerPaymentId: payments.providerPaymentId,
          providerOrderId: payments.providerOrderId,
          stripeChargeId: payments.stripeChargeId,
          appointmentId: payments.appointmentId,
          canonicalStatus: payments.canonicalStatus,
          metadata: payments.metadata,
          updatedAt: payments.updatedAt,
        })
        .from(payments)
        .where(eq(payments.id, paymentId))
        .for("update")
        .limit(1);
      if (!before) {
        throw new TeamMutationFailure("invalid", "The payment was not found.", {
          status: 404,
        });
      }
      assertTeamMutationExpectedVersion(mutation, before.updatedAt);
      if (!paymentProviderBindingMatches(before, parsed.data.paymentBinding)) {
        throw new TeamMutationFailure(
          "conflict",
          "The local payment no longer matches the confirmed provider record. Refresh and compare it again.",
        );
      }
      if (before.appointmentId === null) {
        throw new TeamMutationFailure(
          "conflict",
          "The payment is already detached. Refresh the reconciliation list.",
        );
      }
      if (before.appointmentId !== appointment.id) {
        throw new TeamMutationFailure(
          "conflict",
          "The payment is now attached to a different appointment. Refresh before making another change.",
        );
      }

      const now = nextPaymentAssociationVersion(before.updatedAt);
      const [detached] = await tx
        .update(payments)
        .set({
          appointmentId: null,
          canonicalStatus: "needs_review",
          metadata: {
            ...(before.metadata ?? {}),
            ownerDetachment: {
              detachedAt: now.toISOString(),
              detachedBy: mutation.actor.id ?? mutation.actor.label,
              reviewNote: parsed.data.reviewNote,
              previousAppointmentId: before.appointmentId,
              previousCanonicalStatus: before.canonicalStatus,
            },
          },
          updatedAt: now,
        })
        .where(
          and(
            eq(payments.id, before.id),
            eq(payments.updatedAt, before.updatedAt),
            eq(payments.appointmentId, appointment.id),
          ),
        )
        .returning({ id: payments.id });
      if (!detached) {
        throw new TeamMutationFailure(
          "conflict",
          "The payment changed while it was being detached. No appointment link was changed.",
          { retryable: true },
        );
      }

      await syncAppointmentCardTipCents(tx, appointment.id);
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "payment",
        entityId: paymentId,
        before: {
          provider: before.provider,
          appointmentId: appointment.id,
          canonicalStatus: before.canonicalStatus,
          version: before.updatedAt.toISOString(),
        },
        after: {
          appointmentId: null,
          canonicalStatus: "needs_review",
          version: now.toISOString(),
        },
        metadata: {
          surface: "team.legacy_payments",
          operation: "detach",
          provider: before.provider,
          providerEffect: "none",
          providerIdentityVerified: true,
          providerPaymentIdBound: before.providerPaymentId !== null,
          providerOrderIdBound: before.providerOrderId !== null,
          stripeChargeIdBound: before.stripeChargeId !== null,
          reviewNoteLength: parsed.data.reviewNote.length,
          confirmation: "detach_payment",
          previousAppointmentTipSynchronized: true,
        },
        committedAt: now,
      });
      const mutationResult = teamMutationSuccessResult(
        mutation,
        {
          action: "detach" as const,
          paymentId,
          appointmentId: null,
          previousAppointmentId: appointment.id,
          provider: before.provider,
          canonicalStatus: "needs_review" as const,
          providerEffect: "none" as const,
          previousAppointmentTipSynchronized: true,
          version: now.toISOString(),
        },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "payment",
          entityId: paymentId,
          version: now.toISOString(),
        },
      );
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
        mutationResult,
        200,
      );
      return mutationResult;
    });

    return teamMutationResultResponse(result, 200, mutation.correlationId);
  } catch (error) {
    if (db && claim) {
      try {
        await settleTeamMutationIdempotencyFailure(db, mutation, claim, error);
      } catch (settlementError) {
        console.error("[payments] detach_idempotency_settlement_failed", {
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
