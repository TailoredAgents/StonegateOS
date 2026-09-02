import { randomUUID } from "node:crypto";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import {
  outboxEvents,
  quoteCapabilities,
  quoteResponses,
  quoteVersions,
  quotes,
  salesOpportunities,
} from "@/db";
import { quoteCapabilityReadExpiry } from "@/lib/quote-v2-capability";
import {
  assertSalesOpportunityTransition,
  type SalesOpportunityState,
} from "@/lib/quote-v2-domain";
import { parseQuoteV2OutboxEvent } from "@/lib/quote-v2-outbox-contract";
import type { TeamMutationTransaction } from "@/lib/team-mutation";

export class QuoteV2TerminalDecisionConflict extends Error {
  constructor(
    message: string,
    readonly reason:
      | "version_changed"
      | "quote_changed"
      | "opportunity_changed",
  ) {
    super(message);
    this.name = "QuoteV2TerminalDecisionConflict";
  }
}

export type QuoteV2TerminalDecisionContext = Readonly<{
  quoteId: string;
  quoteNumber: string;
  versionId: string;
  versionNumber: number;
  contactId: string;
  opportunityId: string;
  opportunityStatus: SalesOpportunityState;
  opportunityRevision: number;
  quoteRevision: number;
}>;

export type QuoteV2TerminalAcceptedTotals = Readonly<{
  selectedOptionIds: readonly string[];
  subtotalMinCents: number;
  discountMinCents: number;
  totalMinCents: number;
  depositCents: number;
  balanceMinCents: number;
}>;

export type QuoteV2TerminalAfterAcceptanceHook = (
  tx: TeamMutationTransaction,
  input: {
    quoteId: string;
    versionId: string;
    responseId: string;
    acceptedDepositCents: number;
    correlationId: string;
  },
) => Promise<{ appointmentId: string; outboxEventId: string } | null>;

function opportunityTarget(input: {
  decision: "accepted" | "declined";
  currentStatus: SalesOpportunityState;
  hasOtherActionableQuote: boolean;
}): {
  status: SalesOpportunityState;
  pipelineStage: string;
  closes: boolean;
} {
  if (input.decision === "accepted") {
    return { status: "approved", pipelineStage: "approved", closes: false };
  }
  return input.hasOtherActionableQuote
    ? { status: "open", pipelineStage: "quoted", closes: false }
    : { status: "lost", pipelineStage: "lost", closes: true };
}

async function insertResponseOutboxEvent(
  tx: TeamMutationTransaction,
  input: {
    quoteId: string;
    versionId: string;
    responseId: string;
    correlationId: string;
    occurredAt: Date;
  },
): Promise<string> {
  const eventId = randomUUID();
  const payload = {
    schemaVersion: 2 as const,
    eventId,
    quoteId: input.quoteId,
    versionId: input.versionId,
    responseId: input.responseId,
    correlationId: input.correlationId,
    occurredAt: input.occurredAt.toISOString(),
  };
  parseQuoteV2OutboxEvent({ type: "quote.response_recorded.v2", payload });
  await tx.insert(outboxEvents).values({
    id: eventId,
    type: "quote.response_recorded.v2",
    payload,
    attempts: 0,
    createdAt: input.occurredAt,
  });
  return eventId;
}

function centsToLegacyNumeric(cents: number): string {
  return (cents / 100).toFixed(2);
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  if (candidate.code === "23505") return true;
  return candidate.cause !== error && isUniqueViolation(candidate.cause);
}

/**
 * Sole canonical terminal transition for public-capability, Staff, and
 * Partner-member decisions. Callers authenticate their actor and freeze the
 * actor-specific evidence; this function owns the response insert, exact
 * version/aggregate CAS, opportunity transition, capability retention, and
 * outbox write in one transaction.
 */
export async function persistQuoteV2TerminalDecision(
  tx: TeamMutationTransaction,
  input: {
    context: QuoteV2TerminalDecisionContext;
    decision: "accepted" | "declined";
    responseValues: typeof quoteResponses.$inferInsert;
    acceptedTotals: QuoteV2TerminalAcceptedTotals | null;
    decisionNotes: string | null;
    correlationId: string;
    now: Date;
    afterAcceptance?: QuoteV2TerminalAfterAcceptanceHook;
  },
): Promise<{
  responseId: string;
  quoteRevision: number;
  opportunityRevision: number;
  outboxEventId: string;
  appointmentId: string | null;
}> {
  const { context } = input;
  if (
    input.responseValues.quoteId !== context.quoteId ||
    input.responseValues.quoteVersionId !== context.versionId ||
    input.responseValues.responseType !== input.decision
  ) {
    throw new TypeError("quote_v2_terminal_response_binding_invalid");
  }

  let response: { id: string } | undefined;
  try {
    [response] = await tx
      .insert(quoteResponses)
      .values(input.responseValues)
      .returning({ id: quoteResponses.id });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new QuoteV2TerminalDecisionConflict(
        "This proposal already has a terminal response.",
        "version_changed",
      );
    }
    throw error;
  }
  if (!response) throw new Error("quote_v2_response_not_persisted");

  const [updatedVersion] = await tx
    .update(quoteVersions)
    .set({ state: input.decision, updatedAt: input.now })
    .where(
      and(
        eq(quoteVersions.id, context.versionId),
        eq(quoteVersions.quoteId, context.quoteId),
        eq(quoteVersions.state, "issued"),
      ),
    )
    .returning({ id: quoteVersions.id });
  if (!updatedVersion) {
    throw new QuoteV2TerminalDecisionConflict(
      "The proposal changed while the response was submitted.",
      "version_changed",
    );
  }

  const quoteRevision = context.quoteRevision + 1;
  const [updatedQuote] = await tx
    .update(quotes)
    .set({
      aggregateState: input.decision,
      aggregateRevision: quoteRevision,
      status: input.decision,
      decisionAt: input.now,
      decisionNotes: input.decisionNotes,
      revision: quoteRevision,
      ...(input.acceptedTotals
        ? {
            subtotal: centsToLegacyNumeric(
              input.acceptedTotals.subtotalMinCents,
            ),
            discounts: centsToLegacyNumeric(
              input.acceptedTotals.discountMinCents,
            ),
            total: centsToLegacyNumeric(input.acceptedTotals.totalMinCents),
            depositDue: centsToLegacyNumeric(
              input.acceptedTotals.depositCents,
            ),
            balanceDue: centsToLegacyNumeric(
              input.acceptedTotals.balanceMinCents,
            ),
          }
        : {}),
      updatedAt: input.now,
    })
    .where(
      and(
        eq(quotes.id, context.quoteId),
        eq(quotes.engineVersion, "v2"),
        eq(quotes.aggregateState, "open"),
        eq(quotes.aggregateRevision, context.quoteRevision),
        eq(quotes.currentVersionId, context.versionId),
        eq(quotes.publishedVersionId, context.versionId),
      ),
    )
    .returning({ id: quotes.id });
  if (!updatedQuote) {
    throw new QuoteV2TerminalDecisionConflict(
      "The quote changed while the response was submitted.",
      "quote_changed",
    );
  }

  const readExpiresAt = quoteCapabilityReadExpiry({
    at: input.now,
    outcome: input.decision,
  });
  const acceptedActionUntil = new Date(
    input.now.getTime() + 30 * 24 * 60 * 60 * 1_000,
  );
  await tx
    .update(quoteCapabilities)
    .set({
      readExpiresAt: sql`greatest(${quoteCapabilities.readExpiresAt}, ${readExpiresAt.toISOString()}::timestamptz)`,
      actionExpiresAt:
        input.decision === "accepted"
          ? sql`greatest(${quoteCapabilities.actionExpiresAt}, ${acceptedActionUntil.toISOString()}::timestamptz)`
          : null,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(quoteCapabilities.quoteVersionId, context.versionId),
        ne(quoteCapabilities.status, "revoked"),
      ),
    );

  const [otherActionableQuote] =
    input.decision === "declined"
      ? await tx
          .select({ id: quotes.id })
          .from(quotes)
          .where(
            and(
              eq(quotes.salesOpportunityId, context.opportunityId),
              eq(quotes.engineVersion, "v2"),
              inArray(quotes.aggregateState, ["draft", "open"]),
              ne(quotes.id, context.quoteId),
            ),
          )
          .limit(1)
      : [];
  const target = opportunityTarget({
    decision: input.decision,
    currentStatus: context.opportunityStatus,
    hasOtherActionableQuote: Boolean(otherActionableQuote),
  });
  if (context.opportunityStatus !== target.status) {
    assertSalesOpportunityTransition(context.opportunityStatus, target.status);
  }
  const opportunityRevision = context.opportunityRevision + 1;
  const [updatedOpportunity] = await tx
    .update(salesOpportunities)
    .set({
      status: target.status,
      pipelineStage: target.pipelineStage,
      ...(input.acceptedTotals
        ? { estimatedValueCents: input.acceptedTotals.totalMinCents }
        : {}),
      revision: opportunityRevision,
      ...(target.closes ? { closedAt: input.now } : {}),
      updatedAt: input.now,
    })
    .where(
      and(
        eq(salesOpportunities.id, context.opportunityId),
        eq(salesOpportunities.status, context.opportunityStatus),
        eq(salesOpportunities.revision, context.opportunityRevision),
      ),
    )
    .returning({ id: salesOpportunities.id });
  if (!updatedOpportunity) {
    throw new QuoteV2TerminalDecisionConflict(
      "The project changed while the response was submitted.",
      "opportunity_changed",
    );
  }

  const combined =
    input.decision === "accepted" &&
    input.acceptedTotals &&
    input.afterAcceptance
      ? await input.afterAcceptance(tx, {
          quoteId: context.quoteId,
          versionId: context.versionId,
          responseId: response.id,
          acceptedDepositCents: input.acceptedTotals.depositCents,
          correlationId: input.correlationId,
        })
      : null;
  const outboxEventId =
    combined?.outboxEventId ??
    (await insertResponseOutboxEvent(tx, {
      quoteId: context.quoteId,
      versionId: context.versionId,
      responseId: response.id,
      correlationId: input.correlationId,
      occurredAt: input.now,
    }));

  return {
    responseId: response.id,
    quoteRevision,
    opportunityRevision,
    outboxEventId,
    appointmentId: combined?.appointmentId ?? null,
  };
}
