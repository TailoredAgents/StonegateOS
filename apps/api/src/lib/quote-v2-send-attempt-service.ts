import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  contacts,
  mediaAssets,
  outboxEvents,
  quoteActivityEvents,
  quoteCapabilities,
  quoteChangeRequests,
  quoteSendAttempts,
  quoteSendDeliveries,
  quoteVersionAttachments,
  quoteVersionDocuments,
  quoteVersions,
  quotes,
} from "@/db";
import {
  QuoteDocumentSnapshotSchema,
  QuoteV2SendAttemptCommandSchema,
} from "@/lib/quote-v2-contract";
import {
  capabilityActionsForRole,
  generateQuoteCapability,
  hashQuoteCapabilityToken,
  QUOTE_SIGNER_ACTIONS,
  QUOTE_VIEWER_ACTIONS,
  quoteCapabilityReadExpiry,
} from "@/lib/quote-v2-capability";
import { requireActiveQuoteV2ContactForCapabilityMint } from "@/lib/quote-v2-contact-access";
import {
  decryptQuoteDeliveryProviderPayload,
  encryptQuoteDeliveryProviderPayload,
  hashQuoteDeliveryRecipientAddress,
  type QuoteDeliveryProviderPayload,
} from "@/lib/quote-v2-delivery-payload";
import {
  capabilityRecipientHash,
  deliveryAddress,
  proposalUrl,
  recipientDisplayHint,
  renderQuoteDeliveryContent,
  type QuoteV2Recipient,
} from "@/lib/quote-v2-issue";
import { parseQuoteV2OutboxEvent } from "@/lib/quote-v2-outbox-contract";
import { buildQuoteRenderModel } from "@/lib/quote-v2-render-model";
import type { TeamMutationTransaction } from "@/lib/team-mutation";
import { TeamMutationFailure } from "@/lib/team-mutation";
import type { z } from "zod";

const CUSTOMER_ATTACHMENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "application/pdf",
]);
const MAX_TOKEN_RECOVERY_ATTEMPTS = 200;
const MAX_TOKEN_RECOVERY_DELIVERIES = 400;
const BLOCKING_DELIVERY_STATUSES = [
  "queued",
  "dispatched",
  "delivered",
  "reconciliation_required",
] as const;

export type QuoteV2SendAttemptCommand = z.infer<
  typeof QuoteV2SendAttemptCommandSchema
>;

export type QuoteV2SendAttemptReceipt = {
  quoteId: string;
  versionId: string;
  quoteRevision: number;
  sendAttemptId: string;
  attemptNumber: number;
  mode: "resend" | "retry";
  deliveryIds: string[];
  retriedDeliveryIds: string[];
  overallState: "requested";
  outboxEventId: string;
  issuedAt: string;
  expiresAt: string;
};

type LockedSendSource = {
  quoteId: string;
  versionId: string;
  quoteNumber: string;
  versionNumber: number;
  quoteRevision: number;
  documentSnapshot: Record<string, unknown>;
  selectedOptionIds: string[];
  commercialContentHash: string;
  issuedAt: Date;
  expiresAt: Date;
};

type CapabilityRow = {
  id: string;
  recipientRole: string;
  recipientAddressHash: string;
  allowedActions: string[];
  tokenHash: string;
  status: string;
  readExpiresAt: Date;
  actionExpiresAt: Date | null;
};

type DeliveryPlan = {
  id: string;
  sendAttemptId: string;
  channel: "email" | "sms";
  recipientRole: "signer" | "cc" | "bcc";
  recipientAddressHash: string;
  recipientDisplayHint: string;
  encryptedProviderPayload: string;
  encryptionKeyId: string;
  channelAttemptNumber: number;
  status: "queued";
  queuedAt: Date;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

type AttemptPlan = {
  capabilityId: string | null;
  recipientManifest: Array<Record<string, unknown>>;
  messageSnapshot: Record<string, unknown>;
  deliveries: DeliveryPlan[];
  metadata: Record<string, unknown>;
  retriedDeliveryIds: string[];
  mode: "resend" | "retry";
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function metadataString(value: unknown, key: string): string | null {
  const candidate = record(value)?.[key];
  return typeof candidate === "string" && candidate.trim() ? candidate : null;
}

function isCapabilityActiveForRecipient(
  capability: CapabilityRow,
  input: { role: QuoteV2Recipient["role"]; addressHash: string; now: Date },
): boolean {
  return (
    capability.status === "active" &&
    capability.recipientRole === input.role &&
    capability.recipientAddressHash === input.addressHash &&
    capabilityHasDeliveryActions(capability) &&
    capability.readExpiresAt > input.now &&
    (input.role !== "signer" ||
      (capability.actionExpiresAt !== null &&
        capability.actionExpiresAt > input.now))
  );
}

function capabilityHasDeliveryActions(capability: {
  recipientRole: string;
  allowedActions: readonly string[];
}): boolean {
  const required =
    capability.recipientRole === "signer"
      ? QUOTE_SIGNER_ACTIONS
      : QUOTE_VIEWER_ACTIONS;
  return required.every((action) => capability.allowedActions.includes(action));
}

export function quoteV2RetryTargetsAreUnique(input: {
  deliveries: ReadonlyArray<{
    id: string;
    channel: string;
    recipientAddressHash: string;
    status: string;
  }>;
  blockingDeliveries: ReadonlyArray<{
    id: string;
    channel: string;
    recipientAddressHash: string;
    status: string;
    metadata?: unknown;
  }>;
}): boolean {
  const selectedIds = new Set(input.deliveries.map((delivery) => delivery.id));
  if (
    input.blockingDeliveries.some((delivery) => {
      const retryOfDeliveryId = metadataString(
        delivery.metadata,
        "retryOfDeliveryId",
      );
      return retryOfDeliveryId !== null && selectedIds.has(retryOfDeliveryId);
    })
  ) {
    return false;
  }
  const targets = new Set<string>();
  for (const delivery of input.deliveries) {
    if (delivery.status !== "failed") return false;
    const target = `${delivery.channel}\0${delivery.recipientAddressHash}`;
    if (targets.has(target)) return false;
    targets.add(target);
    if (
      input.blockingDeliveries.some(
        (candidate) =>
          !selectedIds.has(candidate.id) &&
          candidate.channel === delivery.channel &&
          candidate.recipientAddressHash === delivery.recipientAddressHash &&
          BLOCKING_DELIVERY_STATUSES.includes(
            candidate.status as (typeof BLOCKING_DELIVERY_STATUSES)[number],
          ),
      )
    ) {
      return false;
    }
  }
  return input.deliveries.length > 0;
}

async function loadLockedSendSource(
  tx: TeamMutationTransaction,
  input: { versionId: string; expectedQuoteRevision: number; now: Date },
): Promise<LockedSendSource> {
  const [row] = await tx
    .select({
      quoteId: quotes.id,
      quoteNumber: quotes.quoteNumber,
      engineVersion: quotes.engineVersion,
      aggregateState: quotes.aggregateState,
      quoteRevision: quotes.aggregateRevision,
      publishedVersionId: quotes.publishedVersionId,
      versionId: quoteVersions.id,
      versionNumber: quoteVersions.versionNumber,
      versionState: quoteVersions.state,
      documentSnapshot: quoteVersions.documentSnapshot,
      selectedOptionIds: quoteVersions.selectedOptionIds,
      commercialContentHash: quoteVersions.contentHash,
      issuedAt: quoteVersions.issuedAt,
      expiresAt: quoteVersions.expiresAt,
      contactDoNotContact: contacts.doNotContact,
      contactDeletedAt: contacts.deletedAt,
    })
    .from(quoteVersions)
    .innerJoin(quotes, eq(quotes.id, quoteVersions.quoteId))
    .innerJoin(contacts, eq(contacts.id, quotes.contactId))
    .where(eq(quoteVersions.id, input.versionId))
    .for("update")
    .limit(1);
  if (
    !row ||
    row.engineVersion !== "v2" ||
    row.aggregateState !== "open" ||
    row.publishedVersionId !== row.versionId ||
    row.versionState !== "issued" ||
    !row.quoteNumber ||
    !row.quoteRevision ||
    !row.commercialContentHash ||
    !row.issuedAt ||
    !row.expiresAt
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "This issued proposal is no longer available to send.",
    );
  }
  if (row.quoteRevision !== input.expectedQuoteRevision) {
    throw new TeamMutationFailure(
      "conflict",
      "The quote changed after it was loaded. Refresh delivery history.",
      { retryable: true, fieldErrors: { version: "Refresh the quote." } },
    );
  }
  if (row.expiresAt <= input.now) {
    throw new TeamMutationFailure(
      "conflict",
      "This proposal expired. Create and issue a revision before sending again.",
    );
  }
  if (row.contactDeletedAt || row.contactDoNotContact) {
    throw new TeamMutationFailure(
      "conflict",
      "Customer communication is disabled for this contact.",
    );
  }
  const [openChange] = await tx
    .select({ id: quoteChangeRequests.id })
    .from(quoteChangeRequests)
    .where(
      and(
        eq(quoteChangeRequests.quoteVersionId, row.versionId),
        inArray(quoteChangeRequests.status, ["open", "acknowledged"]),
      ),
    )
    .limit(1);
  if (openChange) {
    throw new TeamMutationFailure(
      "conflict",
      "Resolve the open change request before sending this proposal again.",
    );
  }
  return {
    quoteId: row.quoteId,
    versionId: row.versionId,
    quoteNumber: row.quoteNumber,
    versionNumber: row.versionNumber,
    quoteRevision: row.quoteRevision,
    documentSnapshot: row.documentSnapshot,
    selectedOptionIds: row.selectedOptionIds,
    commercialContentHash: row.commercialContentHash,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
  };
}

async function nextAttemptNumber(
  tx: TeamMutationTransaction,
  versionId: string,
): Promise<number> {
  const [row] = await tx
    .select({
      maximum: sql<number>`coalesce(max(${quoteSendAttempts.attemptNumber}), 0)::int`,
    })
    .from(quoteSendAttempts)
    .where(eq(quoteSendAttempts.quoteVersionId, versionId));
  const next = (row?.maximum ?? 0) + 1;
  if (!Number.isSafeInteger(next) || next < 1 || next > 1_000_000) {
    throw new TeamMutationFailure(
      "conflict",
      "This proposal has too many delivery attempts and needs review.",
    );
  }
  return next;
}

async function activeCapabilities(
  tx: TeamMutationTransaction,
  source: LockedSendSource,
): Promise<CapabilityRow[]> {
  return tx
    .select({
      id: quoteCapabilities.id,
      recipientRole: quoteCapabilities.recipientRole,
      recipientAddressHash: quoteCapabilities.recipientAddressHash,
      allowedActions: quoteCapabilities.allowedActions,
      tokenHash: quoteCapabilities.tokenHash,
      status: quoteCapabilities.status,
      readExpiresAt: quoteCapabilities.readExpiresAt,
      actionExpiresAt: quoteCapabilities.actionExpiresAt,
    })
    .from(quoteCapabilities)
    .where(
      and(
        eq(quoteCapabilities.quoteId, source.quoteId),
        eq(quoteCapabilities.quoteVersionId, source.versionId),
        eq(quoteCapabilities.status, "active"),
      ),
    )
    .orderBy(desc(quoteCapabilities.issuedAt));
}

function manifestContainsCapability(
  value: unknown,
  capabilityId: string,
): boolean {
  return (
    Array.isArray(value) &&
    value.some((entry) => record(entry)?.["capabilityId"] === capabilityId)
  );
}

async function recoverCapabilityTokens(
  tx: TeamMutationTransaction,
  input: { source: LockedSendSource; capabilities: CapabilityRow[] },
): Promise<Map<string, string>> {
  const wanted = new Map(
    input.capabilities.map((capability) => [capability.id, capability]),
  );
  if (wanted.size === 0) return new Map();
  const attempts = await tx
    .select({
      id: quoteSendAttempts.id,
      recipientManifest: quoteSendAttempts.recipientManifest,
    })
    .from(quoteSendAttempts)
    .where(eq(quoteSendAttempts.quoteVersionId, input.source.versionId))
    .orderBy(desc(quoteSendAttempts.requestedAt))
    .limit(MAX_TOKEN_RECOVERY_ATTEMPTS);
  const attemptIds = attempts
    .filter((attempt) =>
      [...wanted.keys()].some((capabilityId) =>
        manifestContainsCapability(attempt.recipientManifest, capabilityId),
      ),
    )
    .map((attempt) => attempt.id);
  if (attemptIds.length === 0) return new Map();
  const deliveries = await tx
    .select({
      id: quoteSendDeliveries.id,
      encryptedProviderPayload: quoteSendDeliveries.encryptedProviderPayload,
      encryptionKeyId: quoteSendDeliveries.encryptionKeyId,
    })
    .from(quoteSendDeliveries)
    .where(inArray(quoteSendDeliveries.sendAttemptId, attemptIds))
    .orderBy(desc(quoteSendDeliveries.createdAt))
    .limit(MAX_TOKEN_RECOVERY_DELIVERIES);
  const recovered = new Map<string, string>();
  for (const delivery of deliveries) {
    let payload: QuoteDeliveryProviderPayload;
    try {
      payload = decryptQuoteDeliveryProviderPayload({
        encryptedProviderPayload: delivery.encryptedProviderPayload,
        encryptionKeyId: delivery.encryptionKeyId,
        deliveryId: delivery.id,
        versionId: input.source.versionId,
      });
    } catch {
      continue;
    }
    if (payload.quoteId !== input.source.quoteId) continue;
    const tokenHash = hashQuoteCapabilityToken(payload.capabilityToken);
    const capability = input.capabilities.find(
      (candidate) => candidate.tokenHash === tokenHash,
    );
    if (capability && !recovered.has(capability.id)) {
      recovered.set(capability.id, payload.capabilityToken);
    }
  }
  return recovered;
}

async function freshSendPlan(
  tx: TeamMutationTransaction,
  input: {
    source: LockedSendSource;
    command: QuoteV2SendAttemptCommand;
    attemptId: string;
    actorTeamMemberId: string;
    publicBaseUrl: string;
    now: Date;
  },
): Promise<AttemptPlan> {
  const document = QuoteDocumentSnapshotSchema.safeParse(
    input.source.documentSnapshot,
  );
  if (!document.success) {
    throw new TeamMutationFailure(
      "internal",
      "The immutable proposal content could not be rendered for delivery.",
    );
  }
  const [proposalDocument, attachmentRows] = await Promise.all([
    tx
      .select({
        id: quoteVersionDocuments.id,
        sha256: quoteVersionDocuments.sha256,
        metadata: quoteVersionDocuments.metadata,
      })
      .from(quoteVersionDocuments)
      .where(
        and(
          eq(quoteVersionDocuments.quoteVersionId, input.source.versionId),
          eq(quoteVersionDocuments.kind, "proposal_pdf"),
        ),
      )
      .orderBy(asc(quoteVersionDocuments.generatedAt))
      .limit(2),
    tx
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
          eq(quoteVersionAttachments.quoteVersionId, input.source.versionId),
          eq(quoteVersionAttachments.customerVisible, true),
          eq(mediaAssets.status, "ready"),
          isNull(mediaAssets.deletedAt),
        ),
      )
      .orderBy(quoteVersionAttachments.position),
  ]);
  const issuedPdf = proposalDocument[0];
  if (!issuedPdf || proposalDocument.length !== 1) {
    throw new TeamMutationFailure(
      "conflict",
      "The issued proposal PDF evidence is unavailable or ambiguous. Resolve document evidence before sending.",
    );
  }
  const attachments = attachmentRows.map((attachment) => {
    const mediaType = attachment.contentType
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (!mediaType || !CUSTOMER_ATTACHMENT_TYPES.has(mediaType)) {
      throw new TeamMutationFailure(
        "conflict",
        "A published customer attachment is no longer available.",
      );
    }
    return {
      id: attachment.id,
      caption: attachment.caption ?? attachment.description ?? null,
      fileName: attachment.fileName?.trim() || "proposal-attachment",
      mediaType: mediaType as
        | "image/jpeg"
        | "image/png"
        | "image/webp"
        | "image/heic"
        | "application/pdf",
      displayOrder: attachment.position,
    };
  });
  const model = buildQuoteRenderModel({
    quoteId: input.source.quoteId,
    versionId: input.source.versionId,
    quoteNumber: input.source.quoteNumber,
    versionNumber: input.source.versionNumber,
    issuedAt: input.source.issuedAt,
    expiresAt: input.source.expiresAt,
    document: document.data,
    selectedOptionIds: input.source.selectedOptionIds,
    attachments,
  });
  const issuedRenderHash = metadataString(
    issuedPdf.metadata,
    "renderContentHash",
  );
  if (!issuedRenderHash || issuedRenderHash !== model.contentHash) {
    throw new TeamMutationFailure(
      "conflict",
      "The issued web, message, and PDF evidence do not reconcile.",
    );
  }

  const capabilities = await activeCapabilities(tx, input.source);
  const activeSigners = capabilities.filter(
    (capability) => capability.recipientRole === "signer",
  );
  const recipientHashes = new Set<string>();
  const deliveryTargets = new Set<string>();
  const exactCapabilities: CapabilityRow[] = [];
  for (const recipient of input.command.recipients) {
    const addressHash = capabilityRecipientHash(recipient);
    if (recipientHashes.has(addressHash)) {
      throw new TeamMutationFailure(
        "invalid",
        "A recipient is included more than once.",
        { fieldErrors: { recipients: "Remove duplicate recipients." } },
      );
    }
    recipientHashes.add(addressHash);
    for (const channel of recipient.channels) {
      const target = `${channel}\0${hashQuoteDeliveryRecipientAddress({
        channel,
        address: deliveryAddress(recipient, channel),
      })}`;
      if (deliveryTargets.has(target)) {
        throw new TeamMutationFailure(
          "invalid",
          "A delivery address and channel is included more than once.",
          { fieldErrors: { recipients: "Remove duplicate delivery targets." } },
        );
      }
      deliveryTargets.add(target);
    }
    const exact = capabilities.find((capability) =>
      isCapabilityActiveForRecipient(capability, {
        role: recipient.role,
        addressHash,
        now: input.now,
      }),
    );
    if (exact) exactCapabilities.push(exact);
  }
  const recovered = await recoverCapabilityTokens(tx, {
    source: input.source,
    capabilities: exactCapabilities,
  });
  const bindings: Array<{
    recipient: QuoteV2Recipient;
    capabilityId: string;
    capabilityAddressHash: string;
    token: string;
    minted: boolean;
    tokenHash: string;
  }> = [];
  for (const recipient of input.command.recipients) {
    const addressHash = capabilityRecipientHash(recipient);
    const exact = capabilities.find((capability) =>
      isCapabilityActiveForRecipient(capability, {
        role: recipient.role,
        addressHash,
        now: input.now,
      }),
    );
    const existingToken = exact ? recovered.get(exact.id) : null;
    if (exact && existingToken) {
      bindings.push({
        recipient,
        capabilityId: exact.id,
        capabilityAddressHash: exact.recipientAddressHash,
        token: existingToken,
        minted: false,
        tokenHash: exact.tokenHash,
      });
      continue;
    }
    const generated = generateQuoteCapability();
    bindings.push({
      recipient,
      capabilityId: randomUUID(),
      capabilityAddressHash: addressHash,
      token: generated.token,
      minted: true,
      tokenHash: generated.tokenHash,
    });
  }
  const signer = bindings.find(
    (binding) => binding.recipient.role === "signer",
  );
  if (!signer) {
    throw new TeamMutationFailure(
      "invalid",
      "Exactly one designated signer is required.",
    );
  }
  if (
    !signer.minted &&
    activeSigners.some((item) => item.id !== signer.capabilityId)
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "Multiple active signer links require reconciliation before resending.",
    );
  }

  const supersessionTargets = new Map<string, string>();
  for (const binding of bindings.filter((item) => item.minted)) {
    for (const capability of capabilities) {
      if (
        capability.recipientAddressHash === binding.capabilityAddressHash ||
        (binding.recipient.role === "signer" &&
          capability.recipientRole === "signer")
      ) {
        supersessionTargets.set(capability.id, binding.capabilityId);
      }
    }
  }
  for (const [capabilityId, replacementId] of supersessionTargets) {
    const [superseded] = await tx
      .update(quoteCapabilities)
      .set({
        status: "superseded",
        allowedActions: ["view", "pdf"],
        actionExpiresAt: null,
        supersededAt: input.now,
        supersededByCapabilityId: replacementId,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(quoteCapabilities.id, capabilityId),
          eq(quoteCapabilities.status, "active"),
        ),
      )
      .returning({ id: quoteCapabilities.id });
    if (!superseded) {
      throw new TeamMutationFailure(
        "conflict",
        "Customer proposal access changed before the send attempt was created.",
        { retryable: true },
      );
    }
  }
  const mintedBindings = bindings.filter((binding) => binding.minted);
  if (mintedBindings.length > 0) {
    const readExpiresAt = quoteCapabilityReadExpiry({
      at: input.source.expiresAt,
      outcome: "open",
    });
    await tx.insert(quoteCapabilities).values(
      mintedBindings.map((binding) => ({
        id: binding.capabilityId,
        quoteId: input.source.quoteId,
        quoteVersionId: input.source.versionId,
        recipientRole: binding.recipient.role,
        recipientAddressHash: binding.capabilityAddressHash,
        allowedActions: capabilityActionsForRole(
          binding.recipient.role === "signer" ? "signer" : "viewer",
        ),
        tokenHash: binding.tokenHash,
        status: "active",
        issuedAt: input.now,
        actionExpiresAt: input.source.expiresAt,
        readExpiresAt,
        issuedByTeamMemberId: input.actorTeamMemberId,
        createdAt: input.now,
        updatedAt: input.now,
      })),
    );
  }

  const baseUrl = new URL(input.publicBaseUrl);
  if (baseUrl.protocol !== "https:" && baseUrl.hostname !== "localhost") {
    throw new TeamMutationFailure(
      "internal",
      "The customer proposal origin is not secure.",
    );
  }
  const deliveries: DeliveryPlan[] = [];
  for (const binding of bindings) {
    const href = proposalUrl(baseUrl, binding.token);
    for (const channel of binding.recipient.channels) {
      const address = deliveryAddress(binding.recipient, channel);
      const deliveryId = randomUUID();
      const content = renderQuoteDeliveryContent({
        model,
        proposalUrl: href,
        coverMessage: input.command.coverMessage,
        channel,
        documentId: issuedPdf.id,
      });
      const encrypted = encryptQuoteDeliveryProviderPayload({
        payload: {
          quoteId: input.source.quoteId,
          versionId: input.source.versionId,
          deliveryId,
          capabilityToken: binding.token,
          channel,
          recipient: {
            role: binding.recipient.role,
            name: binding.recipient.name,
            address,
          },
          content,
        },
      });
      deliveries.push({
        id: deliveryId,
        sendAttemptId: input.attemptId,
        channel,
        recipientRole: binding.recipient.role,
        recipientAddressHash: hashQuoteDeliveryRecipientAddress({
          channel,
          address,
        }),
        recipientDisplayHint: recipientDisplayHint(address, channel),
        ...encrypted,
        channelAttemptNumber: 1,
        status: "queued",
        queuedAt: input.now,
        metadata: {},
        createdAt: input.now,
        updatedAt: input.now,
      });
    }
  }
  return {
    capabilityId: signer.capabilityId,
    recipientManifest: bindings.map((binding) => ({
      capabilityId: binding.capabilityId,
      role: binding.recipient.role,
      channels: binding.recipient.channels,
      addressHash: binding.capabilityAddressHash,
    })),
    messageSnapshot: {
      coverMessage: input.command.coverMessage ?? null,
      contentHash: model.contentHash,
      commercialContentHash: input.source.commercialContentHash,
      issuedPdfHash: issuedPdf.sha256,
      documentId: issuedPdf.id,
    },
    deliveries,
    metadata: {
      mode: "resend",
      reusedCapabilityCount: bindings.filter((binding) => !binding.minted)
        .length,
      mintedCapabilityIds: mintedBindings.map(
        (binding) => binding.capabilityId,
      ),
    },
    retriedDeliveryIds: [],
    mode: "resend",
  };
}

async function retrySendPlan(
  tx: TeamMutationTransaction,
  input: {
    source: LockedSendSource;
    command: QuoteV2SendAttemptCommand;
    attemptId: string;
    now: Date;
  },
): Promise<AttemptPlan> {
  const selected = await tx
    .select({
      id: quoteSendDeliveries.id,
      sendAttemptId: quoteSendDeliveries.sendAttemptId,
      channel: quoteSendDeliveries.channel,
      recipientRole: quoteSendDeliveries.recipientRole,
      recipientAddressHash: quoteSendDeliveries.recipientAddressHash,
      recipientDisplayHint: quoteSendDeliveries.recipientDisplayHint,
      encryptedProviderPayload: quoteSendDeliveries.encryptedProviderPayload,
      encryptionKeyId: quoteSendDeliveries.encryptionKeyId,
      channelAttemptNumber: quoteSendDeliveries.channelAttemptNumber,
      status: quoteSendDeliveries.status,
      sourceAttemptVersionId: quoteSendAttempts.quoteVersionId,
      sourceAttemptCapabilityId: quoteSendAttempts.capabilityId,
      sourceAttemptMessageSnapshot: quoteSendAttempts.messageSnapshot,
    })
    .from(quoteSendDeliveries)
    .innerJoin(
      quoteSendAttempts,
      eq(quoteSendAttempts.id, quoteSendDeliveries.sendAttemptId),
    )
    .where(inArray(quoteSendDeliveries.id, input.command.retryDeliveryIds))
    .for("update");
  if (selected.length !== input.command.retryDeliveryIds.length) {
    throw new TeamMutationFailure(
      "invalid",
      "One or more selected delivery failures were not found.",
      { fieldErrors: { retryDeliveryIds: "Refresh delivery history." } },
    );
  }
  const sourceAttemptIds = new Set(
    selected.map((delivery) => delivery.sendAttemptId),
  );
  if (
    sourceAttemptIds.size !== 1 ||
    selected.some(
      (delivery) => delivery.sourceAttemptVersionId !== input.source.versionId,
    )
  ) {
    throw new TeamMutationFailure(
      "invalid",
      "Retry deliveries from one send attempt at a time.",
      {
        fieldErrors: { retryDeliveryIds: "Choose failures from one attempt." },
      },
    );
  }
  const sourceMessageSnapshot = record(
    selected[0]!.sourceAttemptMessageSnapshot,
  );
  const sourceRenderContentHash = metadataString(
    sourceMessageSnapshot,
    "contentHash",
  );
  const sourceDocumentId = metadataString(sourceMessageSnapshot, "documentId");
  if (
    !sourceMessageSnapshot ||
    sourceRenderContentHash !== input.source.commercialContentHash ||
    !sourceDocumentId
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "The original delivery snapshot no longer reconciles with the issued proposal.",
    );
  }
  const blockingDeliveries = await tx
    .select({
      id: quoteSendDeliveries.id,
      channel: quoteSendDeliveries.channel,
      recipientAddressHash: quoteSendDeliveries.recipientAddressHash,
      status: quoteSendDeliveries.status,
      metadata: quoteSendDeliveries.metadata,
    })
    .from(quoteSendDeliveries)
    .innerJoin(
      quoteSendAttempts,
      eq(quoteSendAttempts.id, quoteSendDeliveries.sendAttemptId),
    )
    .where(eq(quoteSendAttempts.quoteVersionId, input.source.versionId));
  if (
    !quoteV2RetryTargetsAreUnique({ deliveries: selected, blockingDeliveries })
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "A selected channel was already sent, is still processing, or needs reconciliation.",
      {
        fieldErrors: {
          retryDeliveryIds:
            "Retry only one current failed delivery per recipient and channel.",
        },
      },
    );
  }

  const decrypted = selected.map((delivery) => {
    let payload: QuoteDeliveryProviderPayload;
    try {
      payload = decryptQuoteDeliveryProviderPayload({
        encryptedProviderPayload: delivery.encryptedProviderPayload,
        encryptionKeyId: delivery.encryptionKeyId,
        deliveryId: delivery.id,
        versionId: input.source.versionId,
      });
    } catch {
      throw new TeamMutationFailure(
        "conflict",
        "The failed delivery evidence cannot be safely retried.",
      );
    }
    const expectedAddressHash = hashQuoteDeliveryRecipientAddress({
      channel: payload.channel,
      address: payload.recipient.address,
    });
    if (
      payload.quoteId !== input.source.quoteId ||
      payload.versionId !== input.source.versionId ||
      payload.channel !== delivery.channel ||
      payload.recipient.role !== delivery.recipientRole ||
      expectedAddressHash !== delivery.recipientAddressHash ||
      (payload.channel === "email" &&
        payload.content.documentId !== sourceDocumentId)
    ) {
      throw new TeamMutationFailure(
        "conflict",
        "The failed delivery no longer matches its immutable evidence.",
      );
    }
    return {
      delivery,
      payload,
      tokenHash: hashQuoteCapabilityToken(payload.capabilityToken),
    };
  });
  const tokenHashes = [...new Set(decrypted.map((item) => item.tokenHash))];
  const capabilities = await tx
    .select({
      id: quoteCapabilities.id,
      recipientRole: quoteCapabilities.recipientRole,
      recipientAddressHash: quoteCapabilities.recipientAddressHash,
      allowedActions: quoteCapabilities.allowedActions,
      tokenHash: quoteCapabilities.tokenHash,
      status: quoteCapabilities.status,
      readExpiresAt: quoteCapabilities.readExpiresAt,
      actionExpiresAt: quoteCapabilities.actionExpiresAt,
      quoteId: quoteCapabilities.quoteId,
      versionId: quoteCapabilities.quoteVersionId,
    })
    .from(quoteCapabilities)
    .where(inArray(quoteCapabilities.tokenHash, tokenHashes));
  const capabilityByTokenHash = new Map(
    capabilities.map((capability) => [capability.tokenHash, capability]),
  );
  const manifest = new Map<
    string,
    { role: string; channels: Set<string>; addressHash: string }
  >();
  const deliveries: DeliveryPlan[] = [];
  for (const item of decrypted) {
    const capability = capabilityByTokenHash.get(item.tokenHash);
    if (
      !capability ||
      capability.quoteId !== input.source.quoteId ||
      capability.versionId !== input.source.versionId ||
      capability.status !== "active" ||
      capability.recipientRole !== item.payload.recipient.role ||
      !capabilityHasDeliveryActions(capability) ||
      capability.readExpiresAt <= input.now ||
      (capability.recipientRole === "signer" &&
        (!capability.actionExpiresAt ||
          capability.actionExpiresAt <= input.now))
    ) {
      throw new TeamMutationFailure(
        "conflict",
        "The original customer link is no longer active. Create a new send attempt.",
      );
    }
    const prior = manifest.get(capability.id);
    if (prior) prior.channels.add(item.delivery.channel);
    else {
      manifest.set(capability.id, {
        role: capability.recipientRole,
        channels: new Set([item.delivery.channel]),
        addressHash: capability.recipientAddressHash,
      });
    }
    const deliveryId = randomUUID();
    const encrypted = encryptQuoteDeliveryProviderPayload({
      payload: { ...item.payload, deliveryId },
    });
    deliveries.push({
      id: deliveryId,
      sendAttemptId: input.attemptId,
      channel: item.delivery.channel as "email" | "sms",
      recipientRole: item.delivery.recipientRole as "signer" | "cc" | "bcc",
      recipientAddressHash: item.delivery.recipientAddressHash,
      recipientDisplayHint:
        item.delivery.recipientDisplayHint ??
        recipientDisplayHint(
          item.payload.recipient.address,
          item.payload.channel,
        ),
      ...encrypted,
      channelAttemptNumber: item.delivery.channelAttemptNumber + 1,
      status: "queued",
      queuedAt: input.now,
      metadata: { retryOfDeliveryId: item.delivery.id },
      createdAt: input.now,
      updatedAt: input.now,
    });
  }
  const sourceAttemptId = selected[0]!.sendAttemptId;
  return {
    capabilityId:
      [...manifest.entries()].find(
        ([, value]) => value.role === "signer",
      )?.[0] ?? selected[0]!.sourceAttemptCapabilityId,
    recipientManifest: [...manifest.entries()].map(([capabilityId, value]) => ({
      capabilityId,
      role: value.role,
      channels: [...value.channels],
      addressHash: value.addressHash,
    })),
    messageSnapshot: sourceMessageSnapshot,
    deliveries,
    metadata: {
      mode: "manual_retry",
      sourceAttemptId,
      retryDeliveryIds: input.command.retryDeliveryIds,
    },
    retriedDeliveryIds: [...input.command.retryDeliveryIds],
    mode: "retry",
  };
}

export async function createQuoteV2SendAttempt(
  tx: TeamMutationTransaction,
  input: {
    versionId: string;
    command: QuoteV2SendAttemptCommand;
    expectedQuoteRevision: number;
    actorTeamMemberId: string;
    idempotencyKeyHash: string;
    correlationId: string;
    publicBaseUrl?: string | null;
    now?: Date;
  },
): Promise<QuoteV2SendAttemptReceipt> {
  const command = QuoteV2SendAttemptCommandSchema.parse(input.command);
  const now = input.now ?? new Date();
  const activeContact = await requireActiveQuoteV2ContactForCapabilityMint(tx, {
    versionId: input.versionId,
  });
  const source = await loadLockedSendSource(tx, {
    versionId: input.versionId,
    expectedQuoteRevision: input.expectedQuoteRevision,
    now,
  });
  if (source.quoteId !== activeContact.quoteId) {
    throw new TeamMutationFailure(
      "conflict",
      "The proposal changed before delivery access could be created. Refresh and retry.",
      { retryable: true },
    );
  }
  const attemptNumber = await nextAttemptNumber(tx, source.versionId);
  const attemptId = randomUUID();
  let plan: AttemptPlan;
  if (command.retryDeliveryIds.length > 0) {
    plan = await retrySendPlan(tx, { source, command, attemptId, now });
  } else {
    if (!input.publicBaseUrl) {
      throw new TeamMutationFailure(
        "internal",
        "The customer proposal URL is not configured.",
        { retryable: true },
      );
    }
    plan = await freshSendPlan(tx, {
      source,
      command,
      attemptId,
      actorTeamMemberId: input.actorTeamMemberId,
      publicBaseUrl: input.publicBaseUrl,
      now,
    });
  }
  if (plan.deliveries.length === 0) {
    throw new TeamMutationFailure(
      "invalid",
      "Choose at least one delivery channel.",
      { fieldErrors: { recipients: "Choose email or SMS." } },
    );
  }

  await tx.insert(quoteSendAttempts).values({
    id: attemptId,
    quoteId: source.quoteId,
    quoteVersionId: source.versionId,
    capabilityId: plan.capabilityId,
    attemptNumber,
    idempotencyKeyHash: input.idempotencyKeyHash,
    status: "requested",
    recipientManifest: plan.recipientManifest,
    messageSnapshot: plan.messageSnapshot,
    requestedByTeamMemberId: input.actorTeamMemberId,
    correlationId: input.correlationId,
    requestedAt: now,
    metadata: plan.metadata,
    createdAt: now,
    updatedAt: now,
  });
  await tx.insert(quoteSendDeliveries).values(plan.deliveries);

  const nextQuoteRevision = source.quoteRevision + 1;
  const [updatedQuote] = await tx
    .update(quotes)
    .set({
      aggregateRevision: nextQuoteRevision,
      revision: nextQuoteRevision,
      updatedAt: now,
    })
    .where(
      and(
        eq(quotes.id, source.quoteId),
        eq(quotes.engineVersion, "v2"),
        eq(quotes.aggregateState, "open"),
        eq(quotes.publishedVersionId, source.versionId),
        eq(quotes.aggregateRevision, source.quoteRevision),
      ),
    )
    .returning({ id: quotes.id });
  if (!updatedQuote) {
    throw new TeamMutationFailure(
      "conflict",
      "The quote changed before the send attempt was recorded.",
      { retryable: true },
    );
  }
  const [updatedVersion] = await tx
    .update(quoteVersions)
    .set({
      firstSentAt: sql`coalesce(${quoteVersions.firstSentAt}, ${now})`,
      updatedAt: now,
    })
    .where(
      and(
        eq(quoteVersions.id, source.versionId),
        eq(quoteVersions.quoteId, source.quoteId),
        eq(quoteVersions.state, "issued"),
        eq(quoteVersions.issuedAt, source.issuedAt),
        eq(quoteVersions.expiresAt, source.expiresAt),
        eq(quoteVersions.contentHash, source.commercialContentHash),
      ),
    )
    .returning({ id: quoteVersions.id });
  if (!updatedVersion) {
    throw new TeamMutationFailure(
      "conflict",
      "The issued proposal evidence changed before delivery was queued.",
      { retryable: true },
    );
  }

  const outboxEventId = randomUUID();
  const outboxPayload = {
    schemaVersion: 2 as const,
    eventId: outboxEventId,
    quoteId: source.quoteId,
    versionId: source.versionId,
    attemptId,
    correlationId: input.correlationId,
    occurredAt: now.toISOString(),
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
    createdAt: now,
  });
  await tx.insert(quoteActivityEvents).values({
    quoteId: source.quoteId,
    quoteVersionId: source.versionId,
    eventType:
      plan.mode === "retry"
        ? "quote.delivery_retry_requested"
        : "quote.resend_requested",
    actorType: "team_member",
    actorTeamMemberId: input.actorTeamMemberId,
    outboxEventId,
    correlationId: input.correlationId,
    metadata: {
      sendAttemptId: attemptId,
      attemptNumber,
      deliveryIds: plan.deliveries.map((delivery) => delivery.id),
      retryDeliveryIds: plan.retriedDeliveryIds,
    },
    occurredAt: now,
    createdAt: now,
  });
  return {
    quoteId: source.quoteId,
    versionId: source.versionId,
    quoteRevision: nextQuoteRevision,
    sendAttemptId: attemptId,
    attemptNumber,
    mode: plan.mode,
    deliveryIds: plan.deliveries.map((delivery) => delivery.id),
    retriedDeliveryIds: plan.retriedDeliveryIds,
    overallState: "requested",
    outboxEventId,
    issuedAt: source.issuedAt.toISOString(),
    expiresAt: source.expiresAt.toISOString(),
  };
}
