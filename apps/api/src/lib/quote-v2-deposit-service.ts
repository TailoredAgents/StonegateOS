import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  appointmentHolds,
  crmTasks,
  getDb,
  outboxEvents,
  paymentAttempts,
  payments,
  quoteActivityEvents,
  quoteResponses,
  quotes,
  salesOpportunities,
  type DatabaseClient,
} from "@/db";
import type { TeamMutationTransaction } from "@/lib/team-mutation";
import { QuoteDocumentSnapshotSchema } from "@/lib/quote-v2-contract";
import {
  createQuoteDepositPaymentLink,
  retrieveQuoteDepositCheckoutOutcome,
  type QuoteDepositCheckoutOutcome,
} from "@/lib/quote-square-checkout";
import {
  loadQuoteV2CapabilityByHash,
  type QuoteV2ResolvedCapability,
} from "@/lib/quote-v2-public-service";
import {
  quoteV2PublicAllowedActions,
  QuoteV2PublicStateError,
} from "@/lib/quote-v2-public";
import { parseQuoteV2OutboxEvent } from "@/lib/quote-v2-outbox-contract";

const ACTIVE_ATTEMPT_STATES = [
  "created",
  "launched",
  "pending_verification",
] as const;
const CHECKOUT_TTL_MS = 24 * 60 * 60 * 1_000;

type CheckoutMetadata = {
  schemaVersion: 2;
  requestHash: string;
  checkoutUrl?: string;
  providerPaymentLinkId?: string;
  providerVersion?: number | null;
  providerCreatedAt?: string | null;
};

export type QuoteV2DepositCheckoutReceipt = {
  attemptId: string;
  quoteId: string;
  versionId: string;
  responseId: string;
  checkoutUrl: string | null;
  state:
    | "creating"
    | "checkout_ready"
    | "pending"
    | "declined"
    | "captured"
    | "late_capture"
    | "refund_review";
  expectedAmountCents: number;
  expiresAt: string;
  replayed: boolean;
  requiresSchedulingConfirmation: boolean;
  requiresRefundReview: boolean;
};

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new QuoteV2PublicStateError(
      "provider_unavailable",
      "Deposit checkout is temporarily unavailable.",
    );
  }
  return value;
}

function checkoutMetadata(value: unknown): CheckoutMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record["schemaVersion"] !== 2 ||
    typeof record["requestHash"] !== "string"
  ) {
    return null;
  }
  return record as CheckoutMetadata;
}

function assertCheckoutAction(
  row: QuoteV2ResolvedCapability,
  input: { quoteId: string; versionId: string },
  now: Date,
): void {
  if (row.quoteId !== input.quoteId || row.versionId !== input.versionId) {
    throw new QuoteV2PublicStateError(
      "conflict",
      "This checkout no longer matches the displayed proposal.",
    );
  }
  if (!quoteV2PublicAllowedActions(row, now).includes("checkout")) {
    throw new QuoteV2PublicStateError(
      "conflict",
      "This proposal is not currently eligible for deposit checkout.",
    );
  }
}

async function loadAcceptedResponse(
  db: DatabaseClient | TeamMutationTransaction,
  input: {
    responseId: string;
    quoteId: string;
    versionId: string;
  },
) {
  const [response] = await db
    .select({
      id: quoteResponses.id,
      quoteId: quoteResponses.quoteId,
      versionId: quoteResponses.quoteVersionId,
      acceptedDepositCents: quoteResponses.acceptedDepositCents,
      contentHash: quoteResponses.contentHash,
    })
    .from(quoteResponses)
    .where(
      and(
        eq(quoteResponses.id, input.responseId),
        eq(quoteResponses.quoteId, input.quoteId),
        eq(quoteResponses.quoteVersionId, input.versionId),
        eq(quoteResponses.responseType, "accepted"),
      ),
    )
    .limit(1);
  if (
    !response ||
    !response.acceptedDepositCents ||
    response.acceptedDepositCents <= 0
  ) {
    throw new QuoteV2PublicStateError(
      "conflict",
      "An accepted proposal with a required deposit was not found.",
    );
  }
  return {
    ...response,
    acceptedDepositCents: response.acceptedDepositCents,
  } as typeof response & { acceptedDepositCents: number };
}

function attemptReceipt(input: {
  attempt: {
    id: string;
    quoteId: string | null;
    quoteVersionId: string | null;
    quoteResponseId: string | null;
    status: string;
    requestedJobAmountCents: number;
    expiresAt: Date;
    metadata: Record<string, unknown> | null;
  };
  replayed: boolean;
  outcome?: QuoteDepositCheckoutOutcome;
}): QuoteV2DepositCheckoutReceipt {
  const metadata = checkoutMetadata(input.attempt.metadata);
  if (
    !input.attempt.quoteId ||
    !input.attempt.quoteVersionId ||
    !input.attempt.quoteResponseId
  ) {
    throw new Error("quote_deposit_attempt_binding_incomplete");
  }
  const outcome = input.outcome;
  const state = outcome
    ? outcome.status
    : input.attempt.status === "launched"
      ? "checkout_ready"
      : input.attempt.status === "completed"
        ? "captured"
        : input.attempt.status === "failed"
          ? "declined"
          : input.attempt.status === "needs_review"
            ? "refund_review"
            : input.attempt.status === "pending_verification"
              ? "pending"
              : "creating";
  return {
    attemptId: input.attempt.id,
    quoteId: input.attempt.quoteId,
    versionId: input.attempt.quoteVersionId,
    responseId: input.attempt.quoteResponseId,
    checkoutUrl: metadata?.checkoutUrl ?? null,
    state,
    expectedAmountCents: input.attempt.requestedJobAmountCents,
    expiresAt: input.attempt.expiresAt.toISOString(),
    replayed: input.replayed,
    requiresSchedulingConfirmation:
      outcome?.requiresSchedulingConfirmation ?? false,
    requiresRefundReview: outcome?.requiresRefundReview ?? false,
  };
}

/**
 * Reserves an exact response-bound ledger row before calling Square. Provider
 * retries reuse the same attempt ID as Square's idempotency key.
 */
export async function createQuoteV2DepositCheckout(input: {
  tokenHash: string;
  quoteId: string;
  versionId: string;
  responseId: string;
  holdId?: string | null;
  idempotencyKeyHash: string;
  requestHash: string;
  correlationId: string;
  publicSiteOrigin: string;
  now?: Date;
}): Promise<QuoteV2DepositCheckoutReceipt> {
  const db = getDb();
  const now = input.now ?? new Date();
  const clientRequestId = `quote-deposit:${input.idempotencyKeyHash}`;

  const reservation = await db.transaction(async (tx) => {
    const row = await loadQuoteV2CapabilityByHash(tx, {
      tokenHash: input.tokenHash,
      lock: true,
    });
    if (!row) {
      throw new QuoteV2PublicStateError(
        "gone",
        "This proposal link is no longer available.",
      );
    }
    assertCheckoutAction(row, input, now);
    const response = await loadAcceptedResponse(tx, input);
    if (response.contentHash !== row.contentHash) {
      throw new QuoteV2PublicStateError(
        "conflict",
        "The acceptance evidence no longer matches this proposal.",
      );
    }

    let holdId: string | null = null;
    if (input.holdId) {
      const [hold] = await tx
        .select({ id: appointmentHolds.id })
        .from(appointmentHolds)
        .where(
          and(
            eq(appointmentHolds.id, input.holdId),
            eq(appointmentHolds.fullQuoteId, row.quoteId),
            eq(appointmentHolds.quoteVersionId, row.versionId),
            eq(appointmentHolds.status, "active"),
          ),
        )
        .limit(1);
      if (!hold) {
        throw new QuoteV2PublicStateError(
          "conflict",
          "The selected appointment hold is no longer active.",
        );
      }
      holdId = hold.id;
    }

    const [sameKey] = await tx
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.clientRequestId, clientRequestId))
      .limit(1);
    if (sameKey) {
      const metadata = checkoutMetadata(sameKey.metadata);
      if (
        sameKey.quoteId !== row.quoteId ||
        sameKey.quoteVersionId !== row.versionId ||
        sameKey.quoteResponseId !== response.id ||
        metadata?.requestHash !== input.requestHash
      ) {
        throw new QuoteV2PublicStateError(
          "conflict",
          "This request key was already used for another checkout.",
        );
      }
      return { attempt: sameKey, row, replayed: true };
    }

    const [active] = await tx
      .select()
      .from(paymentAttempts)
      .where(
        and(
          eq(paymentAttempts.quoteResponseId, response.id),
          eq(paymentAttempts.quotePaymentKind, "deposit"),
          inArray(paymentAttempts.status, [...ACTIVE_ATTEMPT_STATES]),
        ),
      )
      .orderBy(desc(paymentAttempts.createdAt))
      .limit(1);
    if (active) return { attempt: active, row, replayed: true };

    // Provider configuration is checked only after the immutable capability,
    // version, response, and optional hold have been validated. A provider
    // outage must never mask a stale-document conflict.
    const locationId = requiredEnvironment("SQUARE_LOCATION_ID");
    const attemptId = randomUUID();
    const expiresAt = new Date(now.getTime() + CHECKOUT_TTL_MS);
    const [created] = await tx
      .insert(paymentAttempts)
      .values({
        id: attemptId,
        quoteId: row.quoteId,
        quoteVersionId: row.versionId,
        quoteResponseId: response.id,
        appointmentHoldId: holdId,
        quotePaymentKind: "deposit",
        appointmentId: null,
        provider: "square",
        clientRequestId,
        status: "created",
        requestedJobAmountCents: response.acceptedDepositCents,
        currency: "USD",
        squareLocationId: locationId,
        expiresAt,
        metadata: {
          schemaVersion: 2,
          requestHash: input.requestHash,
        } satisfies CheckoutMetadata,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!created) throw new Error("quote_deposit_attempt_not_persisted");

    const eventId = randomUUID();
    const eventPayload = {
      schemaVersion: 2 as const,
      eventId,
      quoteId: row.quoteId,
      versionId: row.versionId,
      responseId: response.id,
      paymentAttemptId: created.id,
      correlationId: input.correlationId,
      occurredAt: now.toISOString(),
    };
    parseQuoteV2OutboxEvent({
      type: "quote.deposit_checkout_requested.v2",
      payload: eventPayload,
    });
    await tx.insert(outboxEvents).values({
      id: eventId,
      type: "quote.deposit_checkout_requested.v2",
      payload: eventPayload,
      createdAt: now,
    });
    await tx.insert(quoteActivityEvents).values({
      quoteId: row.quoteId,
      quoteVersionId: row.versionId,
      eventType: "deposit_checkout_requested",
      actorType: "customer",
      outboxEventId: eventId,
      metadata: {
        responseId: response.id,
        paymentAttemptId: created.id,
        expectedAmountCents: response.acceptedDepositCents,
      },
      occurredAt: now,
      createdAt: now,
    });
    return { attempt: created, row, replayed: false };
  });

  if (
    reservation.attempt.status !== "created" ||
    checkoutMetadata(reservation.attempt.metadata)?.checkoutUrl
  ) {
    return attemptReceipt({
      attempt: reservation.attempt,
      replayed: reservation.replayed,
    });
  }

  const document = QuoteDocumentSnapshotSchema.parse(
    reservation.row.documentSnapshot,
  );
  const returnUrl = new URL("/quote/payment-return", input.publicSiteOrigin);
  returnUrl.searchParams.set("attemptId", reservation.attempt.id);
  try {
    const stateSecret = requiredEnvironment("SQUARE_POS_STATE_SECRET");
    const locationId =
      reservation.attempt.squareLocationId?.trim() ||
      requiredEnvironment("SQUARE_LOCATION_ID");
    const created = await createQuoteDepositPaymentLink({
      amountCents: reservation.attempt.requestedJobAmountCents,
      locationId,
      idempotencyKey: `quote-deposit-${reservation.attempt.id}`,
      displayName: `Deposit for ${reservation.row.quoteNumber ?? "proposal"}`,
      buyer: {
        email: document.parties.email,
        phoneNumber: document.parties.phoneE164,
      },
      returnUrl: returnUrl.toString(),
      returnStateSecret: stateSecret,
      now,
    });
    const [launched] = await db
      .update(paymentAttempts)
      .set({
        status: "launched",
        providerOrderId: created.providerOrderId,
        returnNonceHash: created.requestFacts.returnStateHash,
        returnStateExpiresAt: new Date(
          created.requestFacts.returnStateExpiresAt,
        ),
        metadata: {
          ...(checkoutMetadata(reservation.attempt.metadata) ?? {
            schemaVersion: 2 as const,
            requestHash: input.requestHash,
          }),
          checkoutUrl: created.checkoutUrl,
          providerPaymentLinkId: created.providerPaymentLinkId,
          providerVersion: created.providerVersion,
          providerCreatedAt: created.providerCreatedAt,
        } satisfies CheckoutMetadata,
        errorCode: null,
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(paymentAttempts.id, reservation.attempt.id),
          eq(paymentAttempts.status, "created"),
        ),
      )
      .returning();
    const current =
      launched ??
      (
        await db
          .select()
          .from(paymentAttempts)
          .where(eq(paymentAttempts.id, reservation.attempt.id))
          .limit(1)
      )[0];
    if (!current) throw new Error("quote_deposit_attempt_disappeared");
    return attemptReceipt({ attempt: current, replayed: reservation.replayed });
  } catch (error) {
    await db
      .update(paymentAttempts)
      .set({
        errorCode: "square_checkout_unavailable",
        errorMessage:
          error instanceof Error
            ? error.message.slice(0, 500)
            : "provider_error",
        updatedAt: new Date(),
      })
      .where(eq(paymentAttempts.id, reservation.attempt.id));
    throw new QuoteV2PublicStateError(
      "provider_unavailable",
      "Deposit checkout is temporarily unavailable. Try again shortly.",
    );
  }
}

export async function reconcileQuoteV2DepositAttempt(input: {
  attemptId: string;
  now?: Date;
}): Promise<{
  receipt: QuoteV2DepositCheckoutReceipt;
  paymentId: string | null;
}> {
  const db = getDb();
  const now = input.now ?? new Date();
  const [attempt] = await db
    .select()
    .from(paymentAttempts)
    .where(
      and(
        eq(paymentAttempts.id, input.attemptId),
        eq(paymentAttempts.provider, "square"),
        eq(paymentAttempts.quotePaymentKind, "deposit"),
      ),
    )
    .limit(1);
  if (
    !attempt?.providerOrderId ||
    !attempt.quoteId ||
    !attempt.quoteVersionId ||
    !attempt.quoteResponseId ||
    !attempt.squareLocationId
  ) {
    throw new QuoteV2PublicStateError(
      "conflict",
      "The deposit checkout is not ready for verification.",
    );
  }
  const [hold] = attempt.appointmentHoldId
    ? await db
        .select({ expiresAt: appointmentHolds.expiresAt })
        .from(appointmentHolds)
        .where(eq(appointmentHolds.id, attempt.appointmentHoldId))
        .limit(1)
    : [];
  const outcome = await retrieveQuoteDepositCheckoutOutcome({
    providerOrderId: attempt.providerOrderId,
    expectedAmountCents: attempt.requestedJobAmountCents,
    expectedLocationId: attempt.squareLocationId,
    holdExpiresAt: hold?.expiresAt ?? null,
    now,
  });

  const persisted = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.id, attempt.id))
      .for("update")
      .limit(1);
    if (!locked) throw new Error("quote_deposit_attempt_not_found");

    const status =
      outcome.status === "captured" || outcome.status === "late_capture"
        ? "completed"
        : outcome.status === "declined"
          ? "failed"
          : outcome.status === "refund_review"
            ? "needs_review"
            : "pending_verification";
    await tx
      .update(paymentAttempts)
      .set({
        status,
        providerPaymentId: outcome.providerPaymentId,
        resolvedAt:
          status === "completed" ||
          status === "failed" ||
          status === "needs_review"
            ? now
            : null,
        errorCode:
          outcome.status === "captured"
            ? null
            : `quote_deposit_${outcome.reason}`,
        errorMessage: outcome.status === "captured" ? null : outcome.reason,
        updatedAt: now,
      })
      .where(eq(paymentAttempts.id, locked.id));

    let paymentId: string | null = null;
    if (
      (outcome.status === "captured" || outcome.status === "late_capture") &&
      outcome.providerPaymentId
    ) {
      const [inserted] = await tx
        .insert(payments)
        .values({
          quoteId: locked.quoteId,
          quoteVersionId: locked.quoteVersionId,
          quoteResponseId: locked.quoteResponseId,
          quotePaymentKind: "deposit",
          provider: "square",
          providerPaymentId: outcome.providerPaymentId,
          providerOrderId: outcome.providerOrderId,
          paymentAttemptId: locked.id,
          amount: outcome.capturedAmountCents ?? locked.requestedJobAmountCents,
          jobAmountCents: locked.requestedJobAmountCents,
          tipCents: 0,
          totalAmountCents:
            outcome.capturedAmountCents ?? locked.requestedJobAmountCents,
          refundedAmountCents: outcome.refundedAmountCents,
          currency: "USD",
          status: outcome.providerPaymentStatus?.toLowerCase() ?? "completed",
          canonicalStatus: "completed",
          providerStatus: outcome.providerPaymentStatus,
          method: "card",
          receiptUrl: outcome.receiptUrl,
          squareLocationId: locked.squareLocationId,
          appointmentId: null,
          metadata: {
            reconciliation: "verified_quote_deposit",
            lateCapture: outcome.status === "late_capture",
          },
          paidAt: outcome.capturedAt ? new Date(outcome.capturedAt) : now,
          capturedAt: outcome.capturedAt ? new Date(outcome.capturedAt) : now,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: payments.id });
      if (inserted) paymentId = inserted.id;
      if (!paymentId) {
        const [existing] = await tx
          .select({ id: payments.id })
          .from(payments)
          .where(eq(payments.paymentAttemptId, locked.id))
          .limit(1);
        paymentId = existing?.id ?? null;
      }
    }

    await tx.insert(quoteActivityEvents).values({
      quoteId: locked.quoteId!,
      quoteVersionId: locked.quoteVersionId,
      eventType: `deposit_${outcome.status}`,
      actorType: "system",
      metadata: {
        paymentAttemptId: locked.id,
        paymentId,
        reason: outcome.reason,
        requiresSchedulingConfirmation: outcome.requiresSchedulingConfirmation,
        requiresRefundReview: outcome.requiresRefundReview,
      },
      occurredAt: now,
      createdAt: now,
    });

    if (outcome.status === "late_capture" && locked.quoteId) {
      const [quote] = await tx
        .select({
          contactId: quotes.contactId,
          opportunityId: quotes.salesOpportunityId,
          ownerTeamMemberId: salesOpportunities.ownerTeamMemberId,
        })
        .from(quotes)
        .leftJoin(
          salesOpportunities,
          eq(salesOpportunities.id, quotes.salesOpportunityId),
        )
        .where(eq(quotes.id, locked.quoteId))
        .limit(1);
      if (quote) {
        await tx.insert(crmTasks).values({
          salesOpportunityId: quote.opportunityId,
          contactId: quote.contactId,
          title: "Urgent: deposit captured after booking hold expired",
          dueAt: now,
          assignedTo: quote.ownerTeamMemberId,
          status: "open",
          notes: `Payment attempt ${locked.id} requires rebooking or refund review.`,
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    const [updated] = await tx
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.id, locked.id))
      .limit(1);
    if (!updated) throw new Error("quote_deposit_attempt_not_found");
    return { attempt: updated, paymentId };
  });
  return {
    receipt: attemptReceipt({
      attempt: persisted.attempt,
      replayed: false,
      outcome,
    }),
    paymentId: persisted.paymentId,
  };
}

export async function reconcileQuoteV2DepositForCapability(input: {
  tokenHash: string;
  attemptId: string;
  quoteId: string;
  versionId: string;
  responseId: string;
  now?: Date;
}): Promise<QuoteV2DepositCheckoutReceipt> {
  const db = getDb();
  const now = input.now ?? new Date();
  const capability = await loadQuoteV2CapabilityByHash(db, {
    tokenHash: input.tokenHash,
  });
  if (!capability) {
    throw new QuoteV2PublicStateError(
      "gone",
      "This proposal link is no longer available.",
    );
  }
  if (
    capability.quoteId !== input.quoteId ||
    capability.versionId !== input.versionId ||
    !quoteV2PublicAllowedActions(capability, now).includes("view")
  ) {
    throw new QuoteV2PublicStateError(
      "conflict",
      "This deposit does not match the displayed proposal.",
    );
  }
  const [attempt] = await db
    .select({ id: paymentAttempts.id })
    .from(paymentAttempts)
    .where(
      and(
        eq(paymentAttempts.id, input.attemptId),
        eq(paymentAttempts.quoteId, input.quoteId),
        eq(paymentAttempts.quoteVersionId, input.versionId),
        eq(paymentAttempts.quoteResponseId, input.responseId),
        eq(paymentAttempts.quotePaymentKind, "deposit"),
      ),
    )
    .limit(1);
  if (!attempt) {
    throw new QuoteV2PublicStateError(
      "conflict",
      "The deposit checkout was not found for this acceptance.",
    );
  }
  return (await reconcileQuoteV2DepositAttempt({ attemptId: attempt.id, now }))
    .receipt;
}
