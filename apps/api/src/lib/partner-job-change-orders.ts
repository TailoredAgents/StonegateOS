import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  appointments,
  outboxEvents,
  partnerBookings,
  partnerJobChangeOrders,
  partnerJobChangeRequests,
  partnerJobEvents,
  partnerNotifications,
  partnerQuotes,
  quoteVersionDocuments,
  quoteVersions,
  quotes,
  type PartnerJobChangeOrderOfferSnapshot,
} from "@/db";
import { loadPartnerAccountServiceAgreement } from "@/lib/partner-account-service-agreement-service";
import {
  PartnerJobChangeRequestBodySchema,
  type PartnerJobChangeRequestBody,
} from "@/lib/partner-job-change-requests";
import {
  TeamMutationFailure,
  type TeamMutationTransaction,
} from "@/lib/team-mutation";

const CURRENCY_PATTERN = /^[A-Z]{3}$/u;
const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/u;
const TERMINAL_JOB_STATUSES = new Set(["completed", "canceled", "declined"]);
const TERMINAL_APPOINTMENT_STATUSES = new Set([
  "completed",
  "canceled",
  "no_show",
]);

const OfferSnapshotSchema = z
  .object({
    version: z.literal(1),
    offeredAt: z.string().datetime({ offset: true }),
    partnerQuoteId: z.string().uuid(),
    quoteId: z.string().uuid(),
    quoteVersionId: z.string().uuid(),
    quoteVersionNumber: z.number().int().positive(),
    quoteContentHash: z.string().regex(CONTENT_HASH_PATTERN),
    amountMinor: z.number().int().positive(),
    currency: z.string().regex(CURRENCY_PATTERN),
    bookingRevision: z.number().int().positive(),
  })
  .strict();

function proposedChangesFromRow(
  reason: string,
  persisted: typeof partnerJobChangeRequests.$inferSelect.proposedChanges,
): PartnerJobChangeRequestBody["proposedChanges"] {
  const { version: _version, ...proposedChanges } = persisted;
  return PartnerJobChangeRequestBodySchema.parse({
    reason,
    proposedChanges,
  }).proposedChanges;
}

function applySafePublicFields(input: {
  current: Readonly<Record<string, unknown>>;
  proposed: PartnerJobChangeRequestBody["proposedChanges"];
}): {
  scope: Readonly<Record<string, unknown>>;
  appliedFields: readonly string[];
} {
  const scope: Record<string, unknown> = { ...input.current };
  const appliedFields: string[] = [];
  for (const key of [
    "description",
    "crewInstructions",
    "accessDetails",
    "onSiteContact",
  ] as const) {
    if (!Object.hasOwn(input.proposed, key)) continue;
    scope[key] = input.proposed[key] ?? null;
    appliedFields.push(key);
  }
  return {
    scope: Object.freeze(scope),
    appliedFields: Object.freeze(appliedFields),
  };
}

function pendingOperationalEffects(
  materiality: PartnerJobChangeRequestBody["proposedChanges"]["materiality"],
): readonly ("schedule" | "service" | "proof")[] {
  const effects: ("schedule" | "service" | "proof")[] = [];
  if (materiality.schedule) effects.push("schedule");
  if (materiality.service || materiality.quantity || materiality.hazards) {
    effects.push("service");
  }
  if (materiality.proof) effects.push("proof");
  return Object.freeze(effects);
}

/**
 * Freezes one exact, issued Quote V2 as the commercial offer for a material
 * job-change request. Callers must already hold the global and account/job
 * mutation locks and pass the post-decision booking revision.
 */
export async function createPartnerJobChangeOrderOffer(
  tx: TeamMutationTransaction,
  input: {
    partnerAccountId: string;
    partnerBookingId: string;
    partnerJobChangeRequestId: string;
    partnerQuoteId: string;
    bookingRevision: number;
    offeredByTeamMemberId: string;
    now: Date;
  },
): Promise<{
  id: string;
  revision: number;
  snapshot: PartnerJobChangeOrderOfferSnapshot;
}> {
  const [candidate] = await tx
    .select({
      partnerQuoteId: partnerQuotes.id,
      authority: partnerQuotes.authority,
      quoteId: quotes.id,
      aggregateState: quotes.aggregateState,
      aggregateRevision: quotes.aggregateRevision,
      currentVersionId: quotes.currentVersionId,
      publishedVersionId: quotes.publishedVersionId,
      quoteVersionId: quoteVersions.id,
      quoteVersionNumber: quoteVersions.versionNumber,
      quoteVersionState: quoteVersions.state,
      quoteContentHash: quoteVersions.contentHash,
      currency: quoteVersions.currency,
      totalMinCents: quoteVersions.totalMinCents,
      totalMaxCents: quoteVersions.totalMaxCents,
      issuedAt: quoteVersions.issuedAt,
      expiresAt: quoteVersions.expiresAt,
    })
    .from(partnerQuotes)
    .innerJoin(
      quotes,
      and(
        eq(quotes.id, partnerQuotes.quoteId),
        eq(quotes.partnerAccountId, partnerQuotes.partnerAccountId),
      ),
    )
    .innerJoin(
      quoteVersions,
      and(
        eq(quoteVersions.id, quotes.publishedVersionId),
        eq(quoteVersions.quoteId, quotes.id),
      ),
    )
    .where(
      and(
        eq(partnerQuotes.id, input.partnerQuoteId),
        eq(partnerQuotes.partnerAccountId, input.partnerAccountId),
        eq(partnerQuotes.partnerBookingId, input.partnerBookingId),
        eq(partnerQuotes.authority, "quote_v2"),
        eq(quotes.engineVersion, "v2"),
      ),
    )
    .for("update", { of: partnerQuotes })
    .limit(1);
  const [proposal] = candidate
    ? await tx
        .select({ id: quoteVersionDocuments.id })
        .from(quoteVersionDocuments)
        .where(
          and(
            eq(quoteVersionDocuments.quoteVersionId, candidate.quoteVersionId),
            eq(quoteVersionDocuments.kind, "proposal_pdf"),
          ),
        )
        .orderBy(desc(quoteVersionDocuments.generatedAt))
        .limit(1)
    : [];
  const currency = candidate?.currency.trim().toUpperCase() ?? "";
  const valid =
    candidate?.authority === "quote_v2" &&
    candidate.aggregateState === "open" &&
    candidate.aggregateRevision !== null &&
    candidate.currentVersionId === candidate.quoteVersionId &&
    candidate.publishedVersionId === candidate.quoteVersionId &&
    candidate.quoteVersionState === "issued" &&
    candidate.issuedAt !== null &&
    candidate.expiresAt !== null &&
    candidate.expiresAt > input.now &&
    candidate.totalMinCents !== null &&
    candidate.totalMinCents === candidate.totalMaxCents &&
    candidate.totalMinCents > 0 &&
    candidate.quoteContentHash !== null &&
    CONTENT_HASH_PATTERN.test(candidate.quoteContentHash) &&
    CURRENCY_PATTERN.test(currency) &&
    Boolean(proposal);
  if (!candidate || !valid) {
    throw new TeamMutationFailure(
      "invalid",
      "Choose a current, issued, fixed-price Quote V2 for this exact job.",
      {
        status: 422,
        fieldErrors: {
          partnerQuoteId:
            "The quote must be issued, unexpired, fixed-price, and bound to this job.",
        },
      },
    );
  }
  if (candidate.quoteContentHash === null) {
    throw new TeamMutationFailure(
      "invalid",
      "The selected quote is missing immutable issue evidence.",
      { status: 422 },
    );
  }
  const agreement = await loadPartnerAccountServiceAgreement(tx, {
    accountId: input.partnerAccountId,
    now: input.now,
    lock: true,
  });
  if (!agreement || agreement.currency !== currency) {
    throw new TeamMutationFailure(
      "invalid",
      "The quote currency does not match this account’s current service agreement.",
      {
        status: 422,
        fieldErrors: {
          partnerQuoteId: "Issue the quote in the account agreement currency.",
        },
      },
    );
  }
  const snapshot = Object.freeze({
    version: 1 as const,
    offeredAt: input.now.toISOString(),
    partnerQuoteId: candidate.partnerQuoteId,
    quoteId: candidate.quoteId,
    quoteVersionId: candidate.quoteVersionId,
    quoteVersionNumber: candidate.quoteVersionNumber,
    quoteContentHash: candidate.quoteContentHash,
    amountMinor: candidate.totalMinCents,
    currency,
    bookingRevision: input.bookingRevision,
  });
  const [created] = await tx
    .insert(partnerJobChangeOrders)
    .values({
      partnerAccountId: input.partnerAccountId,
      partnerBookingId: input.partnerBookingId,
      partnerJobChangeRequestId: input.partnerJobChangeRequestId,
      partnerQuoteId: input.partnerQuoteId,
      quoteId: candidate.quoteId,
      quoteVersionId: candidate.quoteVersionId,
      state: "offered",
      offerSnapshot: snapshot,
      baseBookingRevision: input.bookingRevision,
      revision: 1,
      offeredByTeamMemberId: input.offeredByTeamMemberId,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning({
      id: partnerJobChangeOrders.id,
      revision: partnerJobChangeOrders.revision,
    });
  if (!created) throw new Error("partner_job_change_order_offer_failed");
  return { ...created, snapshot };
}

export async function loadOfferedPartnerJobChangeOrderForQuote(
  tx: TeamMutationTransaction,
  input: {
    partnerAccountId: string;
    partnerQuoteId: string;
  },
): Promise<{ partnerBookingId: string } | null> {
  const [row] = await tx
    .select({ partnerBookingId: partnerJobChangeOrders.partnerBookingId })
    .from(partnerJobChangeOrders)
    .where(
      and(
        eq(partnerJobChangeOrders.partnerAccountId, input.partnerAccountId),
        eq(partnerJobChangeOrders.partnerQuoteId, input.partnerQuoteId),
        eq(partnerJobChangeOrders.state, "offered"),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Resolves an offered order from the exact Quote V2 response. */
export async function resolvePartnerJobChangeOrderFromQuoteResponse(
  tx: TeamMutationTransaction,
  input: {
    partnerAccountId: string;
    partnerQuoteId: string;
    quoteId: string;
    quoteVersionId: string;
    quoteResponseId: string;
    actorMembershipId: string;
    decision: "accepted" | "declined";
    acceptedAmountMinor: number | null;
    currency: string;
    correlationId: string;
    now: Date;
  },
): Promise<{ orderId: string; bookingRevision: number } | null> {
  const [order] = await tx
    .select({
      id: partnerJobChangeOrders.id,
      partnerBookingId: partnerJobChangeOrders.partnerBookingId,
      requestId: partnerJobChangeOrders.partnerJobChangeRequestId,
      quoteId: partnerJobChangeOrders.quoteId,
      quoteVersionId: partnerJobChangeOrders.quoteVersionId,
      offerSnapshot: partnerJobChangeOrders.offerSnapshot,
      baseBookingRevision: partnerJobChangeOrders.baseBookingRevision,
      revision: partnerJobChangeOrders.revision,
    })
    .from(partnerJobChangeOrders)
    .where(
      and(
        eq(partnerJobChangeOrders.partnerAccountId, input.partnerAccountId),
        eq(partnerJobChangeOrders.partnerQuoteId, input.partnerQuoteId),
        eq(partnerJobChangeOrders.state, "offered"),
      ),
    )
    .for("update")
    .limit(1);
  if (!order) return null;
  const snapshot = OfferSnapshotSchema.safeParse(order.offerSnapshot);
  if (
    !snapshot.success ||
    order.quoteId !== input.quoteId ||
    order.quoteVersionId !== input.quoteVersionId ||
    snapshot.data.partnerQuoteId !== input.partnerQuoteId ||
    snapshot.data.quoteId !== input.quoteId ||
    snapshot.data.quoteVersionId !== input.quoteVersionId ||
    snapshot.data.bookingRevision !== order.baseBookingRevision ||
    snapshot.data.currency !== input.currency ||
    (input.decision === "accepted" &&
      input.acceptedAmountMinor !== snapshot.data.amountMinor)
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "The change-order evidence no longer matches this quote. Contact Stonegate before responding.",
      { status: 409 },
    );
  }
  const [job] = await tx
    .select({
      version: partnerBookings.version,
      publicStatus: partnerBookings.publicStatus,
      scopeSnapshot: partnerBookings.scopeSnapshot,
      rateSnapshot: partnerBookings.rateSnapshot,
      appointmentStatus: appointments.status,
    })
    .from(partnerBookings)
    .innerJoin(appointments, eq(appointments.id, partnerBookings.appointmentId))
    .where(
      and(
        eq(partnerBookings.partnerAccountId, input.partnerAccountId),
        eq(partnerBookings.id, order.partnerBookingId),
      ),
    )
    .for("update", { of: partnerBookings })
    .limit(1);
  if (
    !job ||
    TERMINAL_JOB_STATUSES.has(job.publicStatus) ||
    TERMINAL_APPOINTMENT_STATUSES.has(job.appointmentStatus) ||
    job.version !== order.baseBookingRevision
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "The job changed after this change order was offered. Contact Stonegate for an updated proposal.",
      { status: 409 },
    );
  }
  const [request] = await tx
    .select({
      reason: partnerJobChangeRequests.reason,
      proposedChanges: partnerJobChangeRequests.proposedChanges,
      requestedByMembershipId: partnerJobChangeRequests.requestedByMembershipId,
      state: partnerJobChangeRequests.state,
    })
    .from(partnerJobChangeRequests)
    .where(
      and(
        eq(partnerJobChangeRequests.id, order.requestId),
        eq(partnerJobChangeRequests.partnerAccountId, input.partnerAccountId),
        eq(partnerJobChangeRequests.partnerBookingId, order.partnerBookingId),
      ),
    )
    .limit(1);
  if (!request || request.state !== "change_order_required") {
    throw new TeamMutationFailure(
      "conflict",
      "The underlying job-change review is no longer valid.",
      { status: 409 },
    );
  }
  const proposed = proposedChangesFromRow(
    request.reason,
    request.proposedChanges,
  );
  const safe = applySafePublicFields({
    current: job.scopeSnapshot ?? {},
    proposed,
  });
  const effects = pendingOperationalEffects(proposed.materiality);
  const bookingRevision = job.version + 1;
  const nextRateSnapshot =
    input.decision === "accepted"
      ? Object.freeze({
          ...job.rateSnapshot,
          amountMinor: snapshot.data.amountMinor,
          currency: snapshot.data.currency,
          finalPriceSource: "accepted_change_order_quote_v2",
          changeOrderId: order.id,
          partnerQuoteId: input.partnerQuoteId,
          quoteId: input.quoteId,
          quoteVersionId: input.quoteVersionId,
          quoteContentHash: snapshot.data.quoteContentHash,
          acceptedAt: input.now.toISOString(),
        })
      : job.rateSnapshot;
  const [updatedJob] = await tx
    .update(partnerBookings)
    .set({
      ...(input.decision === "accepted"
        ? {
            amountCents: snapshot.data.amountMinor,
            currency: snapshot.data.currency,
            scopeSnapshot: safe.scope,
            rateSnapshot: nextRateSnapshot,
          }
        : {}),
      version: bookingRevision,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(partnerBookings.partnerAccountId, input.partnerAccountId),
        eq(partnerBookings.id, order.partnerBookingId),
        eq(partnerBookings.version, job.version),
      ),
    )
    .returning({ version: partnerBookings.version });
  if (!updatedJob) {
    throw new TeamMutationFailure(
      "conflict",
      "The job changed while the change order was being resolved.",
      { status: 409 },
    );
  }
  const outcome = input.decision;
  const resolutionSnapshot = Object.freeze({
    version: 1 as const,
    outcome,
    quoteResponseId: input.quoteResponseId,
    bookingRevisionBefore: job.version,
    bookingRevisionAfter: updatedJob.version,
    appliedPublicFields:
      outcome === "accepted" ? safe.appliedFields : Object.freeze([]),
    operationalEffectsPending:
      outcome === "accepted" ? effects : Object.freeze([]),
  });
  const [resolved] = await tx
    .update(partnerJobChangeOrders)
    .set({
      state: outcome,
      quoteResponseId: input.quoteResponseId,
      resolutionSnapshot,
      resolvedAt: input.now,
      revision: order.revision + 1,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(partnerJobChangeOrders.id, order.id),
        eq(partnerJobChangeOrders.state, "offered"),
        eq(partnerJobChangeOrders.revision, order.revision),
      ),
    )
    .returning({ id: partnerJobChangeOrders.id });
  if (!resolved) {
    throw new TeamMutationFailure(
      "conflict",
      "The change order was resolved by another operation.",
      { status: 409 },
    );
  }
  const accepted = outcome === "accepted";
  const detail = accepted
    ? effects.length > 0
      ? "The change-order price and approved public details are final. Stonegate will confirm the requested operational changes separately; the current schedule, service, and proof requirements remain in effect until then."
      : "The change-order price and approved public details are now final."
    : "The change order was declined. The current job price and details remain unchanged.";
  const [event] = await tx
    .insert(partnerJobEvents)
    .values({
      partnerAccountId: input.partnerAccountId,
      partnerBookingId: order.partnerBookingId,
      eventType: accepted
        ? "job.change_order_accepted"
        : "job.change_order_declined",
      publicLabel: accepted ? "Change order accepted" : "Change order declined",
      publicDetail: detail,
      effectiveAt: input.now,
      actorType: "partner",
      actorMembershipId: input.actorMembershipId,
      metadata: {
        changeOrderId: order.id,
        partnerQuoteId: input.partnerQuoteId,
        amountMinor: accepted ? snapshot.data.amountMinor : null,
        currency: snapshot.data.currency,
        operationalEffectsPending: accepted ? effects : [],
      },
      createdAt: input.now,
    })
    .returning({ id: partnerJobEvents.id });
  if (!event) throw new Error("partner_job_change_order_event_failed");
  await tx.insert(partnerNotifications).values({
    partnerAccountId: input.partnerAccountId,
    membershipId: request.requestedByMembershipId,
    partnerBookingId: order.partnerBookingId,
    eventKey: accepted
      ? "job.change_order_accepted"
      : "job.change_order_declined",
    title: accepted ? "Change order accepted" : "Change order declined",
    body: detail,
    actionPath: `/partners/bookings/${order.partnerBookingId}`,
    createdAt: input.now,
  });
  await tx.insert(outboxEvents).values({
    type: "partner.job_change_order.resolved",
    payload: {
      partnerAccountId: input.partnerAccountId,
      partnerBookingId: order.partnerBookingId,
      changeOrderId: order.id,
      partnerQuoteId: input.partnerQuoteId,
      quoteResponseId: input.quoteResponseId,
      state: outcome,
      bookingRevision: updatedJob.version,
      partnerJobEventId: event.id,
      correlationId: input.correlationId,
    },
    createdAt: input.now,
  });
  return { orderId: order.id, bookingRevision: updatedJob.version };
}

/** Closes an unaccepted change order when its job is canceled. */
export async function supersedeOfferedPartnerJobChangeOrderForCancellation(
  tx: TeamMutationTransaction,
  input: {
    partnerAccountId: string;
    partnerBookingId: string;
    bookingRevisionBefore: number;
    bookingRevisionAfter: number;
    correlationId: string;
    now: Date;
  },
): Promise<void> {
  const [order] = await tx
    .select({
      id: partnerJobChangeOrders.id,
      revision: partnerJobChangeOrders.revision,
      requestedByMembershipId: partnerJobChangeRequests.requestedByMembershipId,
    })
    .from(partnerJobChangeOrders)
    .innerJoin(
      partnerJobChangeRequests,
      and(
        eq(
          partnerJobChangeRequests.partnerAccountId,
          partnerJobChangeOrders.partnerAccountId,
        ),
        eq(
          partnerJobChangeRequests.partnerBookingId,
          partnerJobChangeOrders.partnerBookingId,
        ),
        eq(
          partnerJobChangeRequests.id,
          partnerJobChangeOrders.partnerJobChangeRequestId,
        ),
      ),
    )
    .where(
      and(
        eq(partnerJobChangeOrders.partnerAccountId, input.partnerAccountId),
        eq(partnerJobChangeOrders.partnerBookingId, input.partnerBookingId),
        eq(partnerJobChangeOrders.state, "offered"),
      ),
    )
    .for("update", { of: partnerJobChangeOrders })
    .limit(1);
  if (!order) return;
  const resolutionSnapshot = Object.freeze({
    version: 1 as const,
    outcome: "superseded" as const,
    quoteResponseId: null,
    bookingRevisionBefore: input.bookingRevisionBefore,
    bookingRevisionAfter: input.bookingRevisionAfter,
    appliedPublicFields: Object.freeze([]),
    operationalEffectsPending: Object.freeze([]),
  });
  const [resolved] = await tx
    .update(partnerJobChangeOrders)
    .set({
      state: "superseded",
      resolutionSnapshot,
      resolvedAt: input.now,
      revision: order.revision + 1,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(partnerJobChangeOrders.id, order.id),
        eq(partnerJobChangeOrders.state, "offered"),
        eq(partnerJobChangeOrders.revision, order.revision),
      ),
    )
    .returning({ id: partnerJobChangeOrders.id });
  if (!resolved) throw new Error("partner_job_change_order_supersede_failed");
  await tx.insert(partnerNotifications).values({
    partnerAccountId: input.partnerAccountId,
    membershipId: order.requestedByMembershipId,
    partnerBookingId: input.partnerBookingId,
    eventKey: "job.change_order_superseded",
    title: "Change order closed",
    body: "The job was canceled, so its unaccepted change order was closed.",
    actionPath: `/partners/bookings/${input.partnerBookingId}`,
    createdAt: input.now,
  });
  await tx.insert(outboxEvents).values({
    type: "partner.job_change_order.resolved",
    payload: {
      partnerAccountId: input.partnerAccountId,
      partnerBookingId: input.partnerBookingId,
      changeOrderId: order.id,
      state: "superseded",
      correlationId: input.correlationId,
    },
    createdAt: input.now,
  });
}
