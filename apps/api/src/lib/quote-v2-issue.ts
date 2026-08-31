import { createHash, randomUUID } from "node:crypto";
import {
  QuoteDocumentSnapshotSchema,
  QuoteRecipientSchema,
  type QuoteDocumentSnapshot,
} from "@/lib/quote-v2-contract";
import {
  assertQuoteReadyForIssue,
  hashQuoteContent,
  type QuoteCapabilityAction,
  type QuoteTotals,
} from "@/lib/quote-v2-domain";
import {
  capabilityActionsForRole,
  generateQuoteCapability,
  quoteCapabilityReadExpiry,
} from "@/lib/quote-v2-capability";
import {
  encryptQuoteDeliveryProviderPayload,
  hashQuoteDeliveryRecipientAddress,
} from "@/lib/quote-v2-delivery-payload";
import { renderQuoteProposalPdf } from "@/lib/quote-v2-pdf";
import {
  buildQuoteRenderModel,
  canonicalQuoteRenderJson,
  renderQuoteEmail,
  renderQuoteSms,
  type QuoteRenderModel,
} from "@/lib/quote-v2-render-model";
import { z } from "zod";

const IssueInputSchema = z
  .object({
    quoteId: z.string().uuid(),
    versionId: z.string().uuid(),
    quoteNumber: z.string().trim().min(1).max(80),
    versionNumber: z.number().int().positive(),
    document: QuoteDocumentSnapshotSchema,
    selectedOptionIds: z
      .array(z.string().trim().min(1).max(80))
      .max(100)
      .default([]),
    attachments: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            caption: z.string().trim().max(500).nullable().optional(),
            fileName: z.string().trim().min(1).max(500),
            mediaType: z.enum([
              "image/jpeg",
              "image/png",
              "image/webp",
              "image/heic",
              "application/pdf",
            ]),
            displayOrder: z.number().int().min(0).max(1_000),
          })
          .strict(),
      )
      .max(10)
      .default([]),
    recipients: z.array(QuoteRecipientSchema).min(1).max(20),
    coverMessage: z.string().trim().max(4_000).nullable().optional(),
    sendNow: z.boolean().default(true),
    issuedByTeamMemberId: z.string().uuid(),
    idempotencyKeyHash: z.string().regex(/^[0-9a-f]{64}$/u),
    correlationId: z.string().trim().min(8).max(128),
    publicBaseUrl: z.string().url().max(1_000),
    storageProvider: z.enum(["r2", "s3"]),
    storageBucket: z.string().trim().min(1).max(255),
    attemptNumber: z.number().int().positive().default(1),
  })
  .strict()
  .superRefine((input, context) => {
    if (
      input.recipients.filter((recipient) => recipient.role === "signer")
        .length !== 1
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recipients"],
        message: "Exactly one recipient must be the designated signer.",
      });
    }
  });

export type QuoteV2Recipient = z.infer<typeof QuoteRecipientSchema>;

export type QuoteIssuePersistencePlan = {
  version: {
    issuedAt: Date;
    expiresAt: Date;
    selectedOptionIds: string[];
    canonicalRenderJson: string;
    documentSchemaHash: string;
    pricingHash: string;
    templateHash: string;
    contentHash: string;
    totals: QuoteTotals;
  };
  document: {
    id: string;
    kind: "proposal_pdf";
    filename: string;
    contentType: "application/pdf";
    storageProvider: "r2" | "s3";
    storageBucket: string;
    storageObjectKey: string;
    byteSize: number;
    sha256: string;
    body: Buffer;
  };
  capabilities: Array<{
    id: string;
    quoteId: string;
    quoteVersionId: string;
    recipientRole: "signer" | "cc" | "bcc";
    recipientAddressHash: string;
    allowedActions: QuoteCapabilityAction[];
    tokenHash: string;
    status: "active";
    issuedAt: Date;
    actionExpiresAt: Date;
    readExpiresAt: Date;
    issuedByTeamMemberId: string;
  }>;
  sendAttempt: null | {
    id: string;
    quoteId: string;
    quoteVersionId: string;
    capabilityId: string;
    attemptNumber: number;
    idempotencyKeyHash: string;
    status: "requested";
    recipientManifest: Array<Record<string, unknown>>;
    messageSnapshot: Record<string, unknown>;
    requestedByTeamMemberId: string;
    correlationId: string;
    requestedAt: Date;
  };
  deliveries: Array<{
    id: string;
    sendAttemptId: string;
    channel: "email" | "sms";
    recipientRole: "signer" | "cc" | "bcc";
    recipientAddressHash: string;
    recipientDisplayHint: string;
    encryptedProviderPayload: string;
    encryptionKeyId: string;
    channelAttemptNumber: 1;
    status: "queued";
    queuedAt: Date;
  }>;
};

export type PreparedQuoteVersionIssue = {
  model: QuoteRenderModel;
  persistence: QuoteIssuePersistencePlan;
  /** Raw customer links are ephemeral and must be returned only to quotes.send. */
  oneTimeLinks: Array<{
    capabilityId: string;
    recipientRole: "signer" | "cc" | "bcc";
    proposalUrl: string;
  }>;
};

function addUtcDays(at: Date, days: number): Date {
  return new Date(at.getTime() + days * 24 * 60 * 60 * 1_000);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizedPublicBaseUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    throw new TypeError("The public quote origin must use HTTPS.");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

export function deliveryAddress(
  recipient: QuoteV2Recipient,
  channel: "email" | "sms",
): string {
  const address = channel === "email" ? recipient.email : recipient.phoneE164;
  if (!address) throw new TypeError(`Missing ${channel} delivery address.`);
  return address;
}

export function recipientDisplayHint(
  address: string,
  channel: "email" | "sms",
): string {
  if (channel === "sms") return `••••${address.slice(-4)}`;
  const domain = address.split("@")[1]?.toLowerCase();
  return domain ? `•••@${domain}` : "email recipient";
}

export function capabilityRecipientHash(recipient: QuoteV2Recipient): string {
  const addressHashes = recipient.channels
    .map((channel) =>
      hashQuoteDeliveryRecipientAddress({
        channel,
        address: deliveryAddress(recipient, channel),
      }),
    )
    .sort();
  return createHash("sha256")
    .update(`${recipient.role}\0${addressHashes.join("\0")}`, "utf8")
    .digest("hex");
}

export function proposalUrl(baseUrl: URL, token: string): string {
  return new URL(`/quote/${encodeURIComponent(token)}`, baseUrl).toString();
}

export function renderQuoteDeliveryContent(input: {
  model: QuoteRenderModel;
  proposalUrl: string;
  coverMessage?: string | null;
  channel: "email" | "sms";
  documentId: string;
}): {
  subject?: string;
  html?: string;
  text: string;
  documentId?: string;
} {
  return input.channel === "email"
    ? {
        ...renderQuoteEmail({
          model: input.model,
          proposalUrl: input.proposalUrl,
          coverMessage: input.coverMessage,
        }),
        documentId: input.documentId,
      }
    : {
        text: renderQuoteSms({
          model: input.model,
          proposalUrl: input.proposalUrl,
        }),
      };
}

export async function prepareQuoteVersionIssue(
  input: unknown,
  options?: {
    now?: Date;
    id?: () => string;
    logoSource?: string | null;
  },
): Promise<PreparedQuoteVersionIssue> {
  const parsed = IssueInputSchema.parse(input);
  const issuedAt = options?.now ?? new Date();
  if (!Number.isFinite(issuedAt.getTime())) {
    throw new TypeError("The proposal issue time is invalid.");
  }
  const id = options?.id ?? randomUUID;
  const publicBaseUrl = normalizedPublicBaseUrl(parsed.publicBaseUrl);
  const document: QuoteDocumentSnapshot = parsed.document;
  const readiness = assertQuoteReadyForIssue({
    pricing: document.pricing,
    parties: document.parties,
    scope: document.scope,
    terms: document.terms.terms,
    validityDays: document.terms.validityDays,
    selectedOptionIds: parsed.selectedOptionIds,
  });
  const expiresAt = addUtcDays(issuedAt, document.terms.validityDays);
  const model = buildQuoteRenderModel({
    quoteId: parsed.quoteId,
    versionId: parsed.versionId,
    quoteNumber: parsed.quoteNumber,
    versionNumber: parsed.versionNumber,
    issuedAt,
    expiresAt,
    document,
    selectedOptionIds: readiness.totals.selectedOptionIds,
    attachments: parsed.attachments,
  });
  const pdf = await renderQuoteProposalPdf({
    model,
    logoSource: options?.logoSource,
  });
  const issuedPdfHash = sha256(pdf);
  const documentId = id();
  const objectKey = `quotes/${parsed.quoteId}/versions/${parsed.versionId}/proposal-${issuedPdfHash}.pdf`;
  const readExpiresAt = quoteCapabilityReadExpiry({
    at: expiresAt,
    outcome: "open",
  });

  const capabilities: QuoteIssuePersistencePlan["capabilities"] = [];
  const oneTimeLinks: PreparedQuoteVersionIssue["oneTimeLinks"] = [];
  const ephemeralByCapability = new Map<
    string,
    { recipient: QuoteV2Recipient; token: string; proposalUrl: string }
  >();
  for (const recipient of parsed.recipients) {
    const capabilityId = id();
    const capability = generateQuoteCapability();
    const url = proposalUrl(publicBaseUrl, capability.token);
    capabilities.push({
      id: capabilityId,
      quoteId: parsed.quoteId,
      quoteVersionId: parsed.versionId,
      recipientRole: recipient.role,
      recipientAddressHash: capabilityRecipientHash(recipient),
      allowedActions: capabilityActionsForRole(
        recipient.role === "signer" ? "signer" : "viewer",
      ),
      tokenHash: capability.tokenHash,
      status: "active",
      issuedAt,
      actionExpiresAt: expiresAt,
      readExpiresAt,
      issuedByTeamMemberId: parsed.issuedByTeamMemberId,
    });
    oneTimeLinks.push({
      capabilityId,
      recipientRole: recipient.role,
      proposalUrl: url,
    });
    ephemeralByCapability.set(capabilityId, {
      recipient,
      token: capability.token,
      proposalUrl: url,
    });
  }

  const signerCapability = capabilities.find(
    (capability) => capability.recipientRole === "signer",
  );
  if (!signerCapability) {
    throw new TypeError("The proposal signer capability is missing.");
  }

  const sendAttemptId = parsed.sendNow ? id() : null;
  const sendAttempt: QuoteIssuePersistencePlan["sendAttempt"] = sendAttemptId
    ? {
        id: sendAttemptId,
        quoteId: parsed.quoteId,
        quoteVersionId: parsed.versionId,
        capabilityId: signerCapability.id,
        attemptNumber: parsed.attemptNumber,
        idempotencyKeyHash: parsed.idempotencyKeyHash,
        status: "requested",
        recipientManifest: capabilities.map((capability) => {
          const ephemeral = ephemeralByCapability.get(capability.id);
          return {
            capabilityId: capability.id,
            role: capability.recipientRole,
            channels: ephemeral?.recipient.channels ?? [],
            addressHash: capability.recipientAddressHash,
          };
        }),
        messageSnapshot: {
          coverMessage: parsed.coverMessage ?? null,
          contentHash: model.contentHash,
          issuedPdfHash,
          documentId,
        },
        requestedByTeamMemberId: parsed.issuedByTeamMemberId,
        correlationId: parsed.correlationId,
        requestedAt: issuedAt,
      }
    : null;

  const deliveries: QuoteIssuePersistencePlan["deliveries"] = [];
  if (sendAttemptId) {
    for (const capability of capabilities) {
      const ephemeral = ephemeralByCapability.get(capability.id);
      if (!ephemeral)
        throw new TypeError("Capability delivery data is missing.");
      for (const channel of ephemeral.recipient.channels) {
        const address = deliveryAddress(ephemeral.recipient, channel);
        const deliveryId = id();
        const content = renderQuoteDeliveryContent({
          model,
          proposalUrl: ephemeral.proposalUrl,
          coverMessage: parsed.coverMessage,
          channel,
          documentId,
        });
        const encrypted = encryptQuoteDeliveryProviderPayload({
          payload: {
            quoteId: parsed.quoteId,
            versionId: parsed.versionId,
            deliveryId,
            capabilityToken: ephemeral.token,
            channel,
            recipient: {
              role: ephemeral.recipient.role,
              name: ephemeral.recipient.name,
              address,
            },
            content,
          },
        });
        deliveries.push({
          id: deliveryId,
          sendAttemptId,
          channel,
          recipientRole: ephemeral.recipient.role,
          recipientAddressHash: hashQuoteDeliveryRecipientAddress({
            channel,
            address,
          }),
          recipientDisplayHint: recipientDisplayHint(address, channel),
          ...encrypted,
          channelAttemptNumber: 1,
          status: "queued",
          queuedAt: issuedAt,
        });
      }
    }
  }

  return {
    model,
    persistence: {
      version: {
        issuedAt,
        expiresAt,
        selectedOptionIds: readiness.totals.selectedOptionIds,
        canonicalRenderJson: canonicalQuoteRenderJson(model),
        documentSchemaHash: hashQuoteContent({
          schema: "quote_document_snapshot",
          version: document.schemaVersion,
        }),
        pricingHash: hashQuoteContent(document.pricing),
        templateHash: hashQuoteContent(document.terms),
        contentHash: model.contentHash,
        totals: readiness.totals,
      },
      document: {
        id: documentId,
        kind: "proposal_pdf",
        filename: `${parsed.quoteNumber}-v${parsed.versionNumber}.pdf`,
        contentType: "application/pdf",
        storageProvider: parsed.storageProvider,
        storageBucket: parsed.storageBucket,
        storageObjectKey: objectKey,
        byteSize: pdf.byteLength,
        sha256: issuedPdfHash,
        body: pdf,
      },
      capabilities,
      sendAttempt,
      deliveries,
    },
    oneTimeLinks,
  };
}
