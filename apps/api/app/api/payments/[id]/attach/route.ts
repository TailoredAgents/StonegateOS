import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { appointments, getDb, payments } from "@/db";
import {
  AttachLegacyPaymentRequestSchema,
  nextPaymentAssociationVersion,
  paymentProviderBindingMatches,
} from "@/lib/payment-association";
import {
  type LegacyStripeResolutionError,
  resolveLegacyStripePaymentInTransaction,
} from "@/lib/payment-reconciliation";
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

function legacyStripeFailure(
  code: LegacyStripeResolutionError,
): TeamMutationFailure {
  const messages: Record<LegacyStripeResolutionError, string> = {
    payment_not_found: "The historical Stripe payment was not found.",
    appointment_not_found: "The selected appointment was not found.",
    stripe_payment_required: "Only a Stripe payment can use this workflow.",
    stripe_payment_not_in_review:
      "This Stripe payment is no longer waiting for owner review.",
    stripe_payment_not_completed:
      "The Stripe provider record is not financially completed.",
    stripe_payment_already_attached_elsewhere:
      "This payment is already attached to another appointment.",
    owner_review_note_required: "A review reason is required.",
    stripe_allocation_invalid: "The job and tip allocation is invalid.",
    stripe_allocation_mismatch:
      "The job and tip allocation must equal the provider payment total.",
    appointment_final_total_required:
      "Set the appointment final total before attaching this payment.",
    appointment_has_other_payment_review:
      "Resolve the appointment's other payment review items first.",
    stripe_job_amount_exceeds_balance:
      "This allocation would pay more than the appointment's remaining balance.",
    payment_changed:
      "The payment changed while its appointment link was being updated.",
  };
  const notFound =
    code === "payment_not_found" || code === "appointment_not_found";
  const invalid =
    code === "owner_review_note_required" ||
    code === "stripe_allocation_invalid" ||
    code === "stripe_allocation_mismatch";
  return new TeamMutationFailure(
    notFound || invalid ? "invalid" : "conflict",
    messages[code],
    {
      status: notFound ? 404 : invalid ? 422 : 409,
      retryable: code === "payment_changed",
    },
  );
}

export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["payments.reconcile", "payments.manage"],
    risk: "financial",
    requiresIdempotency: true,
    auditAction: "team_api.payments.id.attach.post",
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

  const parsed = AttachLegacyPaymentRequestSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return teamMutationErrorResponse(
      "invalid",
      "The payment attachment request is incomplete or does not match its confirmation.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: {
          payment:
            "Refresh the payment, confirm ATTACH PAYMENT, and review every field.",
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
      route: "POST /api/payments/:paymentId/attach",
      entityType: "payment",
      entityId: paymentId,
      payload: parsed.data,
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const result = await db.transaction(async (tx) => {
      // Keep the same lock order as the shared Stripe resolver: appointment,
      // then payment. This avoids a payment/appointment deadlock under review.
      const [appointment] = await tx
        .select({ id: appointments.id })
        .from(appointments)
        .where(eq(appointments.id, parsed.data.appointmentId))
        .for("update")
        .limit(1);
      if (!appointment) {
        throw new TeamMutationFailure(
          "invalid",
          "The selected appointment was not found.",
          { status: 404 },
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
          updatedAt: payments.updatedAt,
        })
        .from(payments)
        .where(eq(payments.id, paymentId))
        .for("update")
        .limit(1);
      if (!before) {
        throw new TeamMutationFailure(
          "invalid",
          "The historical Stripe payment was not found.",
          { status: 404 },
        );
      }
      assertTeamMutationExpectedVersion(mutation, before.updatedAt);
      if (!paymentProviderBindingMatches(before, parsed.data.paymentBinding)) {
        throw new TeamMutationFailure(
          "conflict",
          "The local payment no longer matches the confirmed provider record. Refresh and compare it again.",
        );
      }
      if (before.appointmentId !== null) {
        throw new TeamMutationFailure(
          "conflict",
          "The payment is already attached to an appointment. Refresh before making another change.",
        );
      }

      const now = nextPaymentAssociationVersion(before.updatedAt);
      const resolution = await resolveLegacyStripePaymentInTransaction(tx, {
        paymentId: before.id,
        appointmentId: appointment.id,
        jobAmountCents: parsed.data.jobAmountCents,
        tipCents: parsed.data.tipCents,
        reviewNote: parsed.data.reviewNote,
        actorId: mutation.actor.id ?? null,
        actorLabel: mutation.actor.label ?? null,
        now,
      });
      if (!resolution.ok) throw legacyStripeFailure(resolution.code);

      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "payment",
        entityId: paymentId,
        before: {
          provider: before.provider,
          appointmentId: null,
          canonicalStatus: before.canonicalStatus,
          version: before.updatedAt.toISOString(),
        },
        after: {
          appointmentId: resolution.appointmentId,
          canonicalStatus: "completed",
          jobAmountCents: resolution.jobAmountCents,
          tipCents: resolution.tipCents,
          version: now.toISOString(),
        },
        metadata: {
          surface: "team.legacy_payments",
          operation: "attach",
          provider: before.provider,
          providerEffect: "none",
          providerIdentityVerified: true,
          providerPaymentIdBound: before.providerPaymentId !== null,
          providerOrderIdBound: before.providerOrderId !== null,
          stripeChargeIdBound: before.stripeChargeId !== null,
          reviewNoteLength: parsed.data.reviewNote.length,
          confirmation: "attach_payment",
          linkedAppointmentTipSynchronized: true,
        },
        committedAt: now,
      });
      const mutationResult = teamMutationSuccessResult(
        mutation,
        {
          action: "attach" as const,
          paymentId,
          appointmentId: resolution.appointmentId,
          provider: before.provider,
          canonicalStatus: "completed" as const,
          providerEffect: "none" as const,
          appointmentTipSynchronized: true,
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
        console.error("[payments] attach_idempotency_settlement_failed", {
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
