import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { DatabaseClient } from "@/db";
import {
  contacts,
  mediaAssets,
  outboxEvents,
  quoteActivityEvents,
  quoteCapabilities,
  quoteSendAttempts,
  quoteSendDeliveries,
  quoteVersionAttachments,
  quoteVersionDocuments,
  quoteVersions,
  quotes,
  salesOpportunities,
} from "@/db";
import { requireActiveQuoteV2ContactForCapabilityMint } from "@/lib/quote-v2-contact-access";
import type { PreparedQuoteVersionIssue } from "@/lib/quote-v2-issue";
import { parseQuoteV2OutboxEvent } from "@/lib/quote-v2-outbox-contract";
import { TeamMutationFailure } from "@/lib/team-mutation";

const CUSTOMER_ATTACHMENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "application/pdf",
]);

export type QuoteV2ReadyIssueSource = {
  quoteId: string;
  versionId: string;
  quoteNumber: string;
  versionNumber: number;
  draftRevision: number;
  quoteRevision: number;
  aggregateState: string;
  previousPublishedVersionId: string | null;
  opportunityId: string;
  documentSnapshot: Record<string, unknown>;
  readyContentHash: string;
  attachments: Array<{
    id: string;
    caption: string | null;
    fileName: string;
    mediaType:
      | "image/jpeg"
      | "image/png"
      | "image/webp"
      | "image/heic"
      | "application/pdf";
    displayOrder: number;
  }>;
};

export async function loadQuoteV2ReadyIssueSource(
  db: DatabaseClient,
  versionId: string,
): Promise<QuoteV2ReadyIssueSource> {
  const [row] = await db
    .select({
      quoteId: quotes.id,
      quoteNumber: quotes.quoteNumber,
      engineVersion: quotes.engineVersion,
      aggregateState: quotes.aggregateState,
      aggregateRevision: quotes.aggregateRevision,
      currentVersionId: quotes.currentVersionId,
      publishedVersionId: quotes.publishedVersionId,
      opportunityId: quotes.salesOpportunityId,
      versionId: quoteVersions.id,
      versionNumber: quoteVersions.versionNumber,
      draftRevision: quoteVersions.draftRevision,
      state: quoteVersions.state,
      documentSnapshot: quoteVersions.documentSnapshot,
      readyContentHash: quoteVersions.contentHash,
      contactDeletedAt: contacts.deletedAt,
    })
    .from(quoteVersions)
    .innerJoin(quotes, eq(quotes.id, quoteVersions.quoteId))
    .innerJoin(contacts, eq(contacts.id, quotes.contactId))
    .where(eq(quoteVersions.id, versionId))
    .limit(1);
  if (
    !row ||
    row.engineVersion !== "v2" ||
    !["draft", "open"].includes(row.aggregateState ?? "") ||
    row.state !== "ready" ||
    row.currentVersionId !== row.versionId ||
    !row.quoteNumber ||
    !row.aggregateRevision ||
    !row.opportunityId ||
    !row.readyContentHash ||
    row.contactDeletedAt
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "This quote version is not ready to issue. Refresh the proposal.",
    );
  }

  const attachmentRows = await db
    .select({
      id: quoteVersionAttachments.id,
      caption: quoteVersionAttachments.label,
      description: quoteVersionAttachments.description,
      position: quoteVersionAttachments.position,
      fileName: mediaAssets.originalFilename,
      contentType: mediaAssets.contentType,
    })
    .from(quoteVersionAttachments)
    .innerJoin(
      mediaAssets,
      eq(mediaAssets.id, quoteVersionAttachments.mediaAssetId),
    )
    .where(
      and(
        eq(quoteVersionAttachments.quoteVersionId, versionId),
        eq(quoteVersionAttachments.customerVisible, true),
        eq(mediaAssets.status, "ready"),
        isNull(mediaAssets.deletedAt),
      ),
    )
    .orderBy(quoteVersionAttachments.position);
  const attachments = attachmentRows.map((attachment) => {
    const type = attachment.contentType?.split(";", 1)[0]?.trim().toLowerCase();
    if (!type || !CUSTOMER_ATTACHMENT_TYPES.has(type)) {
      throw new TeamMutationFailure(
        "conflict",
        "A customer attachment is not ready for publication.",
        {
          fieldErrors: {
            attachments: "Remove or replace unsupported attachments.",
          },
        },
      );
    }
    return {
      id: attachment.id,
      caption: attachment.caption ?? attachment.description ?? null,
      fileName: attachment.fileName?.trim() || "proposal-attachment",
      mediaType:
        type as QuoteV2ReadyIssueSource["attachments"][number]["mediaType"],
      displayOrder: attachment.position,
    };
  });

  return {
    quoteId: row.quoteId,
    versionId: row.versionId,
    quoteNumber: row.quoteNumber,
    versionNumber: row.versionNumber,
    draftRevision: row.draftRevision,
    quoteRevision: row.aggregateRevision,
    aggregateState: row.aggregateState!,
    previousPublishedVersionId: row.publishedVersionId,
    opportunityId: row.opportunityId,
    documentSnapshot: row.documentSnapshot,
    readyContentHash: row.readyContentHash,
    attachments,
  };
}

function centsToLegacyNumeric(cents: number): string {
  return (cents / 100).toFixed(2);
}

export async function persistPreparedQuoteVersionIssue(
  tx: Parameters<DatabaseClient["transaction"]>[0] extends (
    transaction: infer Transaction,
  ) => Promise<unknown>
    ? Transaction
    : never,
  input: {
    source: QuoteV2ReadyIssueSource;
    prepared: PreparedQuoteVersionIssue;
    actorTeamMemberId: string;
    correlationId: string;
    now: Date;
  },
): Promise<{
  quoteId: string;
  versionId: string;
  quoteNumber: string;
  quoteRevision: number;
  sendAttemptId: string | null;
  overallState: "issued" | "requested";
  outboxEventId: string | null;
  issuedAt: string;
  expiresAt: string;
  oneTimeLinks: PreparedQuoteVersionIssue["oneTimeLinks"];
}> {
  const { source, prepared } = input;
  await requireActiveQuoteV2ContactForCapabilityMint(tx, {
    quoteId: source.quoteId,
  });
  const [locked] = await tx
    .select({
      quoteId: quotes.id,
      quoteRevision: quotes.aggregateRevision,
      aggregateState: quotes.aggregateState,
      currentVersionId: quotes.currentVersionId,
      opportunityId: quotes.salesOpportunityId,
      versionState: quoteVersions.state,
      draftRevision: quoteVersions.draftRevision,
      readyContentHash: quoteVersions.contentHash,
    })
    .from(quotes)
    .innerJoin(
      quoteVersions,
      and(
        eq(quoteVersions.id, source.versionId),
        eq(quoteVersions.quoteId, quotes.id),
      ),
    )
    .where(eq(quotes.id, source.quoteId))
    .for("update")
    .limit(1);
  if (
    !locked ||
    locked.aggregateState !== source.aggregateState ||
    locked.versionState !== "ready" ||
    locked.currentVersionId !== source.versionId ||
    locked.opportunityId !== source.opportunityId ||
    locked.quoteRevision !== source.quoteRevision ||
    locked.draftRevision !== source.draftRevision ||
    locked.readyContentHash !== source.readyContentHash
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "The proposal changed while its document was generated. Refresh and issue again.",
      { retryable: true },
    );
  }

  const versionPlan = prepared.persistence.version;
  const totals = versionPlan.totals;
  const [issuedVersion] = await tx
    .update(quoteVersions)
    .set({
      state: "issued",
      // Canonical content, hashes, selections, and totals were frozen during
      // draft -> ready. Issue adds publication evidence but cannot rewrite the
      // reviewed commercial document.
      validFrom: versionPlan.issuedAt,
      issuedAt: versionPlan.issuedAt,
      expiresAt: versionPlan.expiresAt,
      firstSentAt: prepared.persistence.sendAttempt
        ? versionPlan.issuedAt
        : null,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(quoteVersions.id, source.versionId),
        eq(quoteVersions.state, "ready"),
        eq(quoteVersions.draftRevision, source.draftRevision),
        eq(quoteVersions.contentHash, source.readyContentHash),
      ),
    )
    .returning({ id: quoteVersions.id });
  if (!issuedVersion) {
    throw new TeamMutationFailure(
      "conflict",
      "The proposal changed before issue. Refresh and retry.",
      { retryable: true },
    );
  }

  const nextQuoteRevision = source.quoteRevision + 1;
  const [updatedQuote] = await tx
    .update(quotes)
    .set({
      aggregateState: "open",
      aggregateRevision: nextQuoteRevision,
      publishedVersionId: source.versionId,
      status: "sent",
      sentAt: versionPlan.issuedAt,
      expiresAt: versionPlan.expiresAt,
      subtotal: centsToLegacyNumeric(totals.subtotalMinCents),
      discounts: centsToLegacyNumeric(totals.discountMinCents),
      total: centsToLegacyNumeric(totals.totalMinCents),
      depositDue: centsToLegacyNumeric(totals.depositCents),
      balanceDue: centsToLegacyNumeric(totals.balanceMinCents),
      revision: nextQuoteRevision,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(quotes.id, source.quoteId),
        eq(quotes.aggregateState, source.aggregateState),
        eq(quotes.aggregateRevision, source.quoteRevision),
      ),
    )
    .returning({ id: quotes.id });
  if (!updatedQuote) {
    throw new TeamMutationFailure(
      "conflict",
      "The quote changed before issue. Refresh and retry.",
      { retryable: true },
    );
  }

  if (
    source.previousPublishedVersionId &&
    source.previousPublishedVersionId !== source.versionId
  ) {
    const [previousPublished] = await tx
      .select({ state: quoteVersions.state })
      .from(quoteVersions)
      .where(
        and(
          eq(quoteVersions.id, source.previousPublishedVersionId),
          eq(quoteVersions.quoteId, source.quoteId),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !previousPublished ||
      !["issued", "expired"].includes(previousPublished.state)
    ) {
      throw new TeamMutationFailure(
        "conflict",
        "The previously published proposal changed before this revision was issued.",
        { retryable: true },
      );
    }
    if (previousPublished.state === "issued") {
      await tx
        .update(quoteVersions)
        .set({
          state: "superseded",
          supersededAt: versionPlan.issuedAt,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(quoteVersions.id, source.previousPublishedVersionId),
            eq(quoteVersions.quoteId, source.quoteId),
            eq(quoteVersions.state, "issued"),
          ),
        );
    }
    const supersededReadExpiry = new Date(
      versionPlan.issuedAt.getTime() + 90 * 24 * 60 * 60 * 1_000,
    );
    await tx
      .update(quoteCapabilities)
      .set({
        allowedActions: ["view", "pdf"],
        actionExpiresAt: null,
        readExpiresAt: sql`least(${quoteCapabilities.readExpiresAt}, ${supersededReadExpiry.toISOString()}::timestamptz)`,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(
            quoteCapabilities.quoteVersionId,
            source.previousPublishedVersionId,
          ),
          eq(quoteCapabilities.status, "active"),
        ),
      );
  }

  await tx
    .update(salesOpportunities)
    .set({
      pipelineStage: "quoted",
      estimatedValueCents: totals.totalMinCents,
      revision: sql`${salesOpportunities.revision} + 1`,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(salesOpportunities.id, source.opportunityId),
        eq(salesOpportunities.status, "open"),
      ),
    );

  const document = prepared.persistence.document;
  await tx.insert(quoteVersionDocuments).values({
    id: document.id,
    quoteVersionId: source.versionId,
    kind: document.kind,
    filename: document.filename,
    contentType: document.contentType,
    storageProvider: document.storageProvider,
    storageBucket: document.storageBucket,
    storageObjectKey: document.storageObjectKey,
    byteSize: document.byteSize,
    sha256: document.sha256,
    generatedByTeamMemberId: input.actorTeamMemberId,
    metadata: {
      versionContentHash: source.readyContentHash,
      renderContentHash: versionPlan.contentHash,
    },
    generatedAt: versionPlan.issuedAt,
    createdAt: input.now,
  });
  await tx.insert(quoteCapabilities).values(
    prepared.persistence.capabilities.map((capability) => ({
      ...capability,
      createdAt: input.now,
      updatedAt: input.now,
    })),
  );

  const sendAttempt = prepared.persistence.sendAttempt;
  if (sendAttempt) {
    await tx.insert(quoteSendAttempts).values({
      ...sendAttempt,
      metadata: {},
      createdAt: input.now,
      updatedAt: input.now,
    });
    if (prepared.persistence.deliveries.length > 0) {
      await tx.insert(quoteSendDeliveries).values(
        prepared.persistence.deliveries.map((delivery) => ({
          ...delivery,
          metadata: {},
          createdAt: input.now,
          updatedAt: input.now,
        })),
      );
    }
  }

  let outboxEventId: string | null = null;
  if (sendAttempt) {
    outboxEventId = randomUUID();
    const outboxPayload = {
      schemaVersion: 2 as const,
      eventId: outboxEventId,
      quoteId: source.quoteId,
      versionId: source.versionId,
      attemptId: sendAttempt.id,
      correlationId: input.correlationId,
      occurredAt: input.now.toISOString(),
    };
    parseQuoteV2OutboxEvent({
      type: "quote.send_requested.v2",
      payload: outboxPayload,
    });
    await tx.insert(outboxEvents).values({
      id: outboxEventId,
      type: "quote.send_requested.v2",
      payload: outboxPayload,
      attempts: 0,
      createdAt: input.now,
    });
  }
  await tx.insert(quoteActivityEvents).values({
    quoteId: source.quoteId,
    quoteVersionId: source.versionId,
    eventType: sendAttempt ? "quote.issue_requested" : "quote.issued",
    actorType: "team_member",
    actorTeamMemberId: input.actorTeamMemberId,
    outboxEventId,
    correlationId: input.correlationId,
    metadata: {
      documentId: document.id,
      sendAttemptId: sendAttempt?.id ?? null,
    },
    occurredAt: input.now,
    createdAt: input.now,
  });

  return {
    quoteId: source.quoteId,
    versionId: source.versionId,
    quoteNumber: source.quoteNumber,
    quoteRevision: nextQuoteRevision,
    sendAttemptId: sendAttempt?.id ?? null,
    overallState: sendAttempt ? "requested" : "issued",
    outboxEventId,
    issuedAt: versionPlan.issuedAt.toISOString(),
    expiresAt: versionPlan.expiresAt.toISOString(),
    oneTimeLinks: sendAttempt ? [] : prepared.oneTimeLinks,
  };
}
