import "dotenv/config";
import { asc, eq, inArray } from "drizzle-orm";
import {
  appointmentAttachments,
  appointments,
  conversationMessages,
  conversationThreads,
  getDb,
  instantQuoteMedia,
  instantQuotes,
  leads,
  mediaAssets,
} from "../src/db";
import {
  importBufferedAppointmentMedia,
  importRemoteAppointmentMedia,
} from "../src/lib/appointment-media";
import {
  decideInstantQuoteMediaBackfillSlot,
  indexInstantQuoteMediaBackfillRelations,
} from "../src/lib/appointment-media-backfill-policy";

type BackfillStats = {
  mode: "dry_run" | "execute";
  generatedAt: string;
  candidates: {
    legacyAppointmentImages: number;
    legacyAppointmentFilesSkipped: number;
    instantQuoteImages: number;
    instantQuoteImagesAlreadyDurable: number;
    instantQuoteImagesToImport: number;
    instantQuoteImagesUnavailable: number;
    inboundMessageImages: number;
  };
  imported: number;
  alreadyPresent: number;
  retainedWithoutAppointmentLink: number;
  skipped: Array<{
    source: string;
    id: string;
    reason: string;
    filename?: string | null;
    contentType?: string | null;
  }>;
  failed: Array<{ source: string; id: string; error: string }>;
};

function parseLimit(): number | undefined {
  const raw = process.argv.find((arg) => arg.startsWith("--limit="));
  if (!raw) return undefined;
  const parsed = Number(raw.slice("--limit=".length));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function isSupportedImageContentType(value: string | null): boolean {
  const type = value?.split(";")[0]?.trim().toLowerCase() ?? "";
  return [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/heif",
  ].includes(type);
}

function inboundMediaSource(row: {
  channel: string;
  provider: string | null;
}): "twilio_mms" | "facebook_messenger" | null {
  const provider = row.provider?.trim().toLowerCase() ?? "";
  if (
    row.channel === "sms" &&
    (provider === "" || provider.includes("twilio"))
  ) {
    return "twilio_mms";
  }
  if (row.channel === "dm" && provider.includes("facebook")) {
    return "facebook_messenger";
  }
  return null;
}

function parseDataUrl(
  value: string,
): { contentType: string; bytes: Buffer } | null {
  if (!value.startsWith("data:")) return null;
  const comma = value.indexOf(",");
  if (comma < 0) return null;
  const metadata = value.slice(5, comma);
  if (!metadata.toLowerCase().endsWith(";base64")) return null;
  const contentType = metadata.slice(0, -";base64".length).trim().toLowerCase();
  if (!isSupportedImageContentType(contentType)) return null;
  try {
    return {
      contentType,
      bytes: Buffer.from(value.slice(comma + 1), "base64"),
    };
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");
  const limit = parseLimit();
  const db = getDb();
  const attachmentQuery = db
    .select({
      id: appointmentAttachments.id,
      appointmentId: appointmentAttachments.appointmentId,
      filename: appointmentAttachments.filename,
      contentType: appointmentAttachments.contentType,
      url: appointmentAttachments.url,
      contactId: appointments.contactId,
      createdAt: appointmentAttachments.createdAt,
    })
    .from(appointmentAttachments)
    .innerJoin(
      appointments,
      eq(appointments.id, appointmentAttachments.appointmentId),
    )
    .orderBy(
      asc(appointmentAttachments.createdAt),
      asc(appointmentAttachments.id),
    );
  const attachmentRows = limit
    ? await attachmentQuery.limit(limit)
    : await attachmentQuery;
  const quoteQuery = db
    .select({
      id: instantQuotes.id,
      photoUrls: instantQuotes.photoUrls,
      createdAt: instantQuotes.createdAt,
    })
    .from(instantQuotes)
    .orderBy(asc(instantQuotes.createdAt), asc(instantQuotes.id));
  const quoteRows = limit ? await quoteQuery.limit(limit) : await quoteQuery;
  const messageQuery = db
    .select({
      id: conversationMessages.id,
      direction: conversationMessages.direction,
      channel: conversationMessages.channel,
      provider: conversationMessages.provider,
      providerMessageId: conversationMessages.providerMessageId,
      mediaUrls: conversationMessages.mediaUrls,
      receivedAt: conversationMessages.receivedAt,
      createdAt: conversationMessages.createdAt,
      contactId: conversationThreads.contactId,
      leadId: conversationThreads.leadId,
    })
    .from(conversationMessages)
    .innerJoin(
      conversationThreads,
      eq(conversationThreads.id, conversationMessages.threadId),
    )
    .orderBy(asc(conversationMessages.createdAt), asc(conversationMessages.id));
  const messageRows = limit
    ? await messageQuery.limit(limit)
    : await messageQuery;
  const quoteLeadRows =
    quoteRows.length > 0
      ? await db
          .select({
            id: leads.id,
            contactId: leads.contactId,
            instantQuoteId: leads.instantQuoteId,
          })
          .from(leads)
          .where(
            inArray(
              leads.instantQuoteId,
              quoteRows.map((row) => row.id),
            ),
          )
          .orderBy(asc(leads.createdAt), asc(leads.id))
      : [];
  const durableQuoteMediaRows =
    quoteRows.length > 0
      ? await db
          .select({
            id: instantQuoteMedia.id,
            instantQuoteId: instantQuoteMedia.instantQuoteId,
            mediaAssetId: instantQuoteMedia.mediaAssetId,
            sortOrder: instantQuoteMedia.sortOrder,
            sourceKey: mediaAssets.sourceKey,
            status: mediaAssets.status,
            contactId: mediaAssets.contactId,
            deletedAt: mediaAssets.deletedAt,
          })
          .from(instantQuoteMedia)
          .innerJoin(
            mediaAssets,
            eq(mediaAssets.id, instantQuoteMedia.mediaAssetId),
          )
          .where(
            inArray(
              instantQuoteMedia.instantQuoteId,
              quoteRows.map((row) => row.id),
            ),
          )
          .orderBy(
            asc(instantQuoteMedia.instantQuoteId),
            asc(instantQuoteMedia.sortOrder),
            asc(instantQuoteMedia.createdAt),
            asc(instantQuoteMedia.id),
          )
      : [];
  const durableQuoteMediaBySlot = indexInstantQuoteMediaBackfillRelations(
    durableQuoteMediaRows,
  );
  const leadByQuoteId = new Map<string, { id: string; contactId: string }>();
  for (const lead of quoteLeadRows) {
    if (lead.instantQuoteId && !leadByQuoteId.has(lead.instantQuoteId)) {
      leadByQuoteId.set(lead.instantQuoteId, {
        id: lead.id,
        contactId: lead.contactId,
      });
    }
  }
  const quoteMediaPlans = quoteRows.flatMap((quote) =>
    quote.photoUrls.map((url, index) => {
      const lead = leadByQuoteId.get(quote.id);
      return {
        quote,
        url,
        index,
        sourceId: `${quote.id}:${index}`,
        lead,
        decision: lead
          ? decideInstantQuoteMediaBackfillSlot({
              instantQuoteId: quote.id,
              sortOrder: index,
              contactId: lead.contactId,
              relationsByQuote: durableQuoteMediaBySlot,
            })
          : null,
      };
    }),
  );
  const instantQuoteImagesAlreadyDurable = quoteMediaPlans.filter(
    (plan) => plan.decision?.action === "reuse",
  ).length;
  const instantQuoteImagesToImport = quoteMediaPlans.filter(
    (plan) =>
      plan.decision?.action === "import" || plan.decision?.action === "retry",
  ).length;
  const instantQuoteImagesUnavailable =
    quoteMediaPlans.length -
    instantQuoteImagesAlreadyDurable -
    instantQuoteImagesToImport;

  const imageAttachments = attachmentRows.filter((row) => {
    if (row.url.startsWith("data:")) return Boolean(parseDataUrl(row.url));
    return (
      isSupportedImageContentType(row.contentType) ||
      /\.(?:jpe?g|png|webp|heic|heif)(?:[?#].*)?$/i.test(row.url)
    );
  });
  const imageAttachmentIds = new Set(imageAttachments.map((row) => row.id));
  const skippedAttachments = attachmentRows.filter(
    (row) => !imageAttachmentIds.has(row.id),
  );
  const inboundMessagesWithMedia = messageRows.filter(
    (row) => row.direction === "inbound" && row.mediaUrls.length > 0,
  );
  const inboundMessages = inboundMessagesWithMedia.filter((row) =>
    Boolean(inboundMediaSource(row)),
  );
  const excludedInboundMessages = inboundMessagesWithMedia.filter(
    (row) => !inboundMediaSource(row),
  );
  const stats: BackfillStats = {
    mode: execute ? "execute" : "dry_run",
    generatedAt: new Date().toISOString(),
    candidates: {
      legacyAppointmentImages: imageAttachments.length,
      legacyAppointmentFilesSkipped:
        attachmentRows.length - imageAttachments.length,
      instantQuoteImages: quoteRows.reduce(
        (sum, row) => sum + row.photoUrls.length,
        0,
      ),
      instantQuoteImagesAlreadyDurable,
      instantQuoteImagesToImport,
      instantQuoteImagesUnavailable,
      inboundMessageImages: inboundMessages.reduce(
        (sum, row) => sum + row.mediaUrls.length,
        0,
      ),
    },
    imported: 0,
    alreadyPresent: 0,
    retainedWithoutAppointmentLink: 0,
    skipped: [
      ...skippedAttachments.map((row) => ({
        source: "appointment_attachment",
        id: row.id,
        reason: row.url.startsWith("data:")
          ? "invalid_or_unsupported_image_data_url"
          : "unsupported_or_non_image_legacy_file",
        filename: row.filename,
        contentType: row.contentType,
      })),
      ...excludedInboundMessages.flatMap((row) =>
        row.mediaUrls.map((_, index) => ({
          source: "conversation_message",
          id: `${row.id}:${index}`,
          reason: `unsupported_inbound_channel:${row.channel}:${row.provider ?? "unknown"}`,
        })),
      ),
      ...quoteMediaPlans.flatMap((plan) => {
        const relationCount = plan.decision?.relationCount ?? 0;
        return relationCount > 1
          ? [
              {
                source: "instant_quote",
                id: plan.sourceId,
                reason: `multiple_durable_relations:${relationCount}`,
              },
            ]
          : [];
      }),
    ],
    failed: execute
      ? []
      : quoteMediaPlans.flatMap((plan) => {
          if (!plan.lead) {
            return [
              {
                source: "instant_quote",
                id: plan.sourceId,
                error: "contact_lead_not_found",
              },
            ];
          }
          return plan.decision?.action === "blocked"
            ? [
                {
                  source: "instant_quote",
                  id: plan.sourceId,
                  error: plan.decision.reason,
                },
              ]
            : [];
        }),
  };

  if (!execute) {
    console.log(JSON.stringify(stats, null, 2));
    return;
  }

  for (const attachment of imageAttachments) {
    try {
      const data = parseDataUrl(attachment.url);
      const result = data
        ? await importBufferedAppointmentMedia({
            bytes: data.bytes,
            declaredContentType: data.contentType,
            sourceKey: `legacy_attachment:${attachment.id}`,
            originalFilename: attachment.filename,
            appointmentId: attachment.appointmentId,
            contactId: attachment.contactId,
            sourceCreatedAt: attachment.createdAt,
          })
        : await importRemoteAppointmentMedia({
            url: attachment.url,
            source: "legacy_attachment",
            sourceKey: `legacy_attachment:${attachment.id}`,
            originalFilename: attachment.filename,
            appointmentId: attachment.appointmentId,
            contactId: attachment.contactId,
            sourceCreatedAt: attachment.createdAt,
          });
      if (result.alreadyExists) stats.alreadyPresent += 1;
      else stats.imported += 1;
      if (!result.mediaId) stats.retainedWithoutAppointmentLink += 1;
    } catch (error) {
      stats.failed.push({
        source: "appointment_attachment",
        id: attachment.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const plan of quoteMediaPlans) {
    if (!plan.lead) {
      stats.failed.push({
        source: "instant_quote",
        id: plan.sourceId,
        error: "contact_lead_not_found",
      });
      continue;
    }
    if (plan.decision?.action === "reuse") {
      stats.alreadyPresent += 1;
      continue;
    }
    if (plan.decision?.action === "blocked") {
      stats.failed.push({
        source: "instant_quote",
        id: plan.sourceId,
        error: plan.decision.reason,
      });
      continue;
    }
    try {
      const result = await importRemoteAppointmentMedia({
        url: plan.url,
        source: "instant_quote",
        sourceKey: `instant_quote:${plan.quote.id}:${plan.index}`,
        contactId: plan.lead.contactId,
        exactLeadId: plan.lead.id,
        instantQuoteId: plan.quote.id,
        sourceMediaIndex: plan.index,
        sourceCreatedAt: plan.quote.createdAt,
      });
      if (result.alreadyExists) stats.alreadyPresent += 1;
      else stats.imported += 1;
      if (!result.mediaId) stats.retainedWithoutAppointmentLink += 1;
    } catch (error) {
      stats.failed.push({
        source: "instant_quote",
        id: plan.sourceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const message of inboundMessages) {
    const source = inboundMediaSource(message);
    if (!source) continue;
    for (const [index, url] of message.mediaUrls.entries()) {
      const sourceId = `${message.id}:${index}`;
      if (!message.contactId) {
        stats.failed.push({
          source: "conversation_message",
          id: sourceId,
          error: "contact_not_found",
        });
        continue;
      }
      try {
        const result = await importRemoteAppointmentMedia({
          url,
          source,
          sourceKey: `${source}:${message.providerMessageId ?? message.id}:${index}`,
          contactId: message.contactId,
          exactLeadId: message.leadId,
          sourceMessageId: message.id,
          sourceMediaIndex: index,
          provider: message.provider,
          sourceCreatedAt: message.receivedAt ?? message.createdAt,
        });
        if (result.alreadyExists) stats.alreadyPresent += 1;
        else stats.imported += 1;
        if (!result.mediaId) stats.retainedWithoutAppointmentLink += 1;
      } catch (error) {
        stats.failed.push({
          source: "conversation_message",
          id: sourceId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  console.log(JSON.stringify(stats, null, 2));
  if (stats.failed.length > 0) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
