import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import {
  mediaAssets,
  quoteActivityEvents,
  quoteVersionAttachments,
  quoteVersions,
  quotes,
  type DatabaseClient,
} from "@/db";
import {
  MAX_QUOTE_ATTACHMENTS,
  MAX_QUOTE_ATTACHMENT_BYTES,
  normalizeQuoteAttachmentPurpose,
  quoteAttachmentContentDisposition,
  validateQuoteAttachment,
  type QuoteAttachmentPurpose,
} from "@/lib/quote-v2-attachments";
import {
  getMediaObject,
  getMediaStorageBucket,
  getMediaStorageProvider,
  putImmutableMediaObject,
} from "@/lib/media-storage";
import {
  TeamMutationFailure,
  type TeamMutationTransaction,
} from "@/lib/team-mutation";

type QuoteDbExecutor = DatabaseClient | TeamMutationTransaction;

export type QuoteV2AttachmentReceipt = {
  quoteId: string;
  versionId: string;
  attachmentId: string;
  draftRevision: number;
  quoteRevision: number;
  purpose: QuoteAttachmentPurpose;
  customerVisible: boolean;
  label: string | null;
  description: string | null;
  fileName: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  position: number;
};

function boundedOptionalText(
  value: string | null | undefined,
  maximum: number,
): string | null {
  const normalized = value?.normalize("NFKC").trim() ?? "";
  if (!normalized) return null;
  if (normalized.length > maximum) {
    throw new TeamMutationFailure(
      "invalid",
      "The attachment details are too long.",
      { fieldErrors: { attachments: `Use ${maximum} characters or fewer.` } },
    );
  }
  return normalized;
}

function safeOriginalFilename(value: string): string {
  const normalized = Array.from(value.normalize("NFKC"), (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f ||
      codePoint === 0x7f ||
      character === "\\" ||
      character === "/"
      ? "_"
      : character;
  })
    .join("")
    .trim()
    .slice(0, 240);
  return normalized || "proposal-attachment";
}

/**
 * Stores bytes and their relational binding while the version row is locked.
 * The object key contains no customer data and is content-addressed, making a
 * transport retry safe without overwriting different bytes.
 */
export async function createQuoteV2Attachment(
  tx: TeamMutationTransaction,
  input: {
    versionId: string;
    expectedDraftRevision: number;
    actorTeamMemberId: string;
    correlationId: string;
    fileName: string;
    claimedContentType: string;
    bytes: Buffer;
    purpose: string;
    customerVisible: boolean;
    label?: string | null;
    description?: string | null;
    now?: Date;
  },
): Promise<QuoteV2AttachmentReceipt> {
  const now = input.now ?? new Date();
  const purpose = normalizeQuoteAttachmentPurpose({
    purpose: input.purpose,
    customerVisible: input.customerVisible,
  });
  let contentType: string;
  try {
    contentType = validateQuoteAttachment({
      fileName: input.fileName,
      claimedMediaType: input.claimedContentType,
      byteSize: input.bytes.byteLength,
      signature: input.bytes.subarray(0, 32),
    });
  } catch (error) {
    throw new TeamMutationFailure(
      "invalid",
      error instanceof Error ? error.message : "The attachment is invalid.",
      {
        fieldErrors: {
          attachments:
            "Choose a valid JPEG, PNG, WebP, HEIC, or PDF under 10 MB.",
        },
      },
    );
  }
  const [version] = await tx
    .select({
      id: quoteVersions.id,
      quoteId: quoteVersions.quoteId,
      state: quoteVersions.state,
      draftRevision: quoteVersions.draftRevision,
      quoteRevision: quotes.aggregateRevision,
      engineVersion: quotes.engineVersion,
      contactId: quotes.contactId,
    })
    .from(quoteVersions)
    .innerJoin(quotes, eq(quotes.id, quoteVersions.quoteId))
    .where(eq(quoteVersions.id, input.versionId))
    .for("update")
    .limit(1);
  if (!version || version.engineVersion !== "v2") {
    throw new TeamMutationFailure(
      "invalid",
      "The quote version was not found.",
      {
        status: 404,
      },
    );
  }
  if (
    version.state !== "draft" ||
    version.draftRevision !== input.expectedDraftRevision ||
    !version.quoteRevision
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "This draft changed before the attachment was added. Refresh and retry.",
      { fieldErrors: { version: "Reload the current quote draft." } },
    );
  }

  const existing = await tx
    .select({
      id: quoteVersionAttachments.id,
      position: quoteVersionAttachments.position,
      sha256: mediaAssets.sha256,
    })
    .from(quoteVersionAttachments)
    .innerJoin(
      mediaAssets,
      eq(mediaAssets.id, quoteVersionAttachments.mediaAssetId),
    )
    .where(eq(quoteVersionAttachments.quoteVersionId, input.versionId))
    .orderBy(asc(quoteVersionAttachments.position));
  if (existing.length >= MAX_QUOTE_ATTACHMENTS) {
    throw new TeamMutationFailure(
      "conflict",
      `A proposal can include up to ${MAX_QUOTE_ATTACHMENTS} attachments.`,
      {
        fieldErrors: {
          attachments: "Remove an attachment before adding another.",
        },
      },
    );
  }

  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  if (existing.some((attachment) => attachment.sha256 === sha256)) {
    throw new TeamMutationFailure(
      "conflict",
      "That exact file is already attached to this proposal.",
      { fieldErrors: { attachments: "Choose a different file." } },
    );
  }
  const attachmentId = randomUUID();
  const mediaAssetId = randomUUID();
  const occupiedPositions = new Set(
    existing.map((attachment) => attachment.position),
  );
  let position = 0;
  while (occupiedPositions.has(position)) position += 1;
  const fileName = safeOriginalFilename(input.fileName);
  const label = boundedOptionalText(input.label, 240);
  const description = boundedOptionalText(input.description, 1_000);
  const storageProvider = getMediaStorageProvider();
  const storageBucket = getMediaStorageBucket();
  const storageObjectKey = `quotes/versions/${input.versionId}/attachments/${sha256}`;

  await putImmutableMediaObject({
    key: storageObjectKey,
    body: input.bytes,
    contentType,
  });

  await tx.insert(mediaAssets).values({
    id: mediaAssetId,
    storageProvider,
    storageBucket,
    originalObjectKey: storageObjectKey,
    source: "quote_v2_attachment",
    sourceKey: `quote-v2:${input.versionId}:${sha256}`,
    status: "ready",
    originalFilename: fileName,
    contentType,
    byteSize: input.bytes.byteLength,
    sha256,
    uploadedByMemberId: input.actorTeamMemberId,
    contactId: version.contactId,
    sourceMetadata: {
      quoteId: version.quoteId,
      quoteVersionId: input.versionId,
      visibility: input.customerVisible ? "customer" : "internal",
      purpose,
    },
    readyAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await tx.insert(quoteVersionAttachments).values({
    id: attachmentId,
    quoteVersionId: input.versionId,
    mediaAssetId,
    purpose,
    position,
    label,
    description,
    customerVisible: input.customerVisible,
    metadata: {},
    attachedByTeamMemberId: input.actorTeamMemberId,
    createdAt: now,
  });

  const draftRevision = version.draftRevision + 1;
  const quoteRevision = version.quoteRevision + 1;
  await tx
    .update(quoteVersions)
    .set({ draftRevision, updatedAt: now })
    .where(eq(quoteVersions.id, input.versionId));
  await tx
    .update(quotes)
    .set({ aggregateRevision: quoteRevision, updatedAt: now })
    .where(eq(quotes.id, version.quoteId));
  await tx.insert(quoteActivityEvents).values({
    quoteId: version.quoteId,
    quoteVersionId: input.versionId,
    actorType: "team_member",
    actorTeamMemberId: input.actorTeamMemberId,
    eventType: "attachment_added",
    occurredAt: now,
    correlationId: input.correlationId,
    metadata: {
      attachmentId,
      purpose,
      visibility: input.customerVisible ? "customer" : "internal",
      contentType,
      byteSize: input.bytes.byteLength,
      sha256,
    },
  });

  return {
    quoteId: version.quoteId,
    versionId: input.versionId,
    attachmentId,
    draftRevision,
    quoteRevision,
    purpose,
    customerVisible: input.customerVisible,
    label,
    description,
    fileName,
    contentType,
    byteSize: input.bytes.byteLength,
    sha256,
    position,
  };
}

export async function removeQuoteV2Attachment(
  tx: TeamMutationTransaction,
  input: {
    versionId: string;
    attachmentId: string;
    expectedDraftRevision: number;
    actorTeamMemberId: string;
    correlationId: string;
    now?: Date;
  },
): Promise<{
  quoteId: string;
  versionId: string;
  attachmentId: string;
  draftRevision: number;
  quoteRevision: number;
}> {
  const now = input.now ?? new Date();
  const [version] = await tx
    .select({
      quoteId: quoteVersions.quoteId,
      state: quoteVersions.state,
      draftRevision: quoteVersions.draftRevision,
      quoteRevision: quotes.aggregateRevision,
      engineVersion: quotes.engineVersion,
    })
    .from(quoteVersions)
    .innerJoin(quotes, eq(quotes.id, quoteVersions.quoteId))
    .where(eq(quoteVersions.id, input.versionId))
    .for("update")
    .limit(1);
  if (!version || version.engineVersion !== "v2") {
    throw new TeamMutationFailure(
      "invalid",
      "The quote version was not found.",
      {
        status: 404,
      },
    );
  }
  if (
    version.state !== "draft" ||
    version.draftRevision !== input.expectedDraftRevision ||
    !version.quoteRevision
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "This draft changed before the attachment was removed. Refresh and retry.",
      { fieldErrors: { version: "Reload the current quote draft." } },
    );
  }
  const [attachment] = await tx
    .select({ mediaAssetId: quoteVersionAttachments.mediaAssetId })
    .from(quoteVersionAttachments)
    .where(
      and(
        eq(quoteVersionAttachments.id, input.attachmentId),
        eq(quoteVersionAttachments.quoteVersionId, input.versionId),
      ),
    )
    .limit(1);
  if (!attachment) {
    throw new TeamMutationFailure("invalid", "The attachment was not found.", {
      status: 404,
    });
  }
  await tx
    .delete(quoteVersionAttachments)
    .where(eq(quoteVersionAttachments.id, input.attachmentId));
  await tx
    .update(mediaAssets)
    .set({ deletedAt: now, updatedAt: now })
    .where(eq(mediaAssets.id, attachment.mediaAssetId));
  const draftRevision = version.draftRevision + 1;
  const quoteRevision = version.quoteRevision + 1;
  await tx
    .update(quoteVersions)
    .set({ draftRevision, updatedAt: now })
    .where(eq(quoteVersions.id, input.versionId));
  await tx
    .update(quotes)
    .set({ aggregateRevision: quoteRevision, updatedAt: now })
    .where(eq(quotes.id, version.quoteId));
  await tx.insert(quoteActivityEvents).values({
    quoteId: version.quoteId,
    quoteVersionId: input.versionId,
    actorType: "team_member",
    actorTeamMemberId: input.actorTeamMemberId,
    eventType: "attachment_removed",
    correlationId: input.correlationId,
    metadata: { attachmentId: input.attachmentId },
    occurredAt: now,
  });
  return {
    quoteId: version.quoteId,
    versionId: input.versionId,
    attachmentId: input.attachmentId,
    draftRevision,
    quoteRevision,
  };
}

export async function loadQuoteV2AttachmentContent(
  db: QuoteDbExecutor,
  input: {
    versionId: string;
    attachmentId: string;
    customerVisibleOnly: boolean;
  },
): Promise<{
  bytes: Buffer;
  contentType: string;
  contentDisposition: string;
  sha256: string;
}> {
  const [attachment] = await db
    .select({
      fileName: mediaAssets.originalFilename,
      contentType: mediaAssets.contentType,
      byteSize: mediaAssets.byteSize,
      sha256: mediaAssets.sha256,
      storageObjectKey: mediaAssets.originalObjectKey,
    })
    .from(quoteVersionAttachments)
    .innerJoin(
      mediaAssets,
      eq(mediaAssets.id, quoteVersionAttachments.mediaAssetId),
    )
    .where(
      and(
        eq(quoteVersionAttachments.id, input.attachmentId),
        eq(quoteVersionAttachments.quoteVersionId, input.versionId),
        ...(input.customerVisibleOnly
          ? [eq(quoteVersionAttachments.customerVisible, true)]
          : []),
        eq(mediaAssets.status, "ready"),
        isNull(mediaAssets.deletedAt),
      ),
    )
    .limit(1);
  if (
    !attachment?.contentType ||
    !attachment.sha256 ||
    !attachment.byteSize ||
    attachment.byteSize > MAX_QUOTE_ATTACHMENT_BYTES
  ) {
    throw new TeamMutationFailure("invalid", "The attachment was not found.", {
      status: 404,
    });
  }
  const bytes = await getMediaObject(
    attachment.storageObjectKey,
    MAX_QUOTE_ATTACHMENT_BYTES,
  );
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (
    bytes.byteLength !== attachment.byteSize ||
    actualHash !== attachment.sha256
  ) {
    throw new TeamMutationFailure(
      "internal",
      "The stored attachment failed integrity verification.",
      { retryable: true },
    );
  }
  return {
    bytes,
    contentType: attachment.contentType,
    contentDisposition: quoteAttachmentContentDisposition(
      attachment.fileName ?? "proposal-attachment",
    ),
    sha256: attachment.sha256,
  };
}

export async function listQuoteV2Attachments(
  db: QuoteDbExecutor,
  versionId: string,
): Promise<QuoteV2AttachmentReceipt[]> {
  const rows = await db
    .select({
      quoteId: quoteVersions.quoteId,
      versionId: quoteVersionAttachments.quoteVersionId,
      attachmentId: quoteVersionAttachments.id,
      draftRevision: quoteVersions.draftRevision,
      quoteRevision: quotes.aggregateRevision,
      purpose: quoteVersionAttachments.purpose,
      customerVisible: quoteVersionAttachments.customerVisible,
      label: quoteVersionAttachments.label,
      description: quoteVersionAttachments.description,
      fileName: mediaAssets.originalFilename,
      contentType: mediaAssets.contentType,
      byteSize: mediaAssets.byteSize,
      sha256: mediaAssets.sha256,
      position: quoteVersionAttachments.position,
    })
    .from(quoteVersionAttachments)
    .innerJoin(
      quoteVersions,
      eq(quoteVersions.id, quoteVersionAttachments.quoteVersionId),
    )
    .innerJoin(quotes, eq(quotes.id, quoteVersions.quoteId))
    .innerJoin(
      mediaAssets,
      eq(mediaAssets.id, quoteVersionAttachments.mediaAssetId),
    )
    .where(
      and(
        eq(quoteVersionAttachments.quoteVersionId, versionId),
        eq(quotes.engineVersion, "v2"),
        eq(mediaAssets.status, "ready"),
        isNull(mediaAssets.deletedAt),
      ),
    )
    .orderBy(asc(quoteVersionAttachments.position));
  return rows.flatMap((row) =>
    row.quoteRevision &&
    row.fileName &&
    row.contentType &&
    row.byteSize &&
    row.sha256
      ? [
          {
            ...row,
            purpose: row.purpose as QuoteAttachmentPurpose,
            quoteRevision: row.quoteRevision,
            fileName: row.fileName,
            contentType: row.contentType,
            byteSize: row.byteSize,
            sha256: row.sha256,
          },
        ]
      : [],
  );
}
