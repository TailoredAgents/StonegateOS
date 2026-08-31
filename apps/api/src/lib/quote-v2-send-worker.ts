import { createHash } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  contacts,
  getDb,
  quoteActivityEvents,
  quoteCapabilities,
  quoteChangeRequests,
  quoteSendAttempts,
  quoteSendDeliveries,
  quoteVersionDocuments,
  quoteVersions,
  quotes,
} from "@/db";
import {
  decryptQuoteDeliveryProviderPayload,
  hashQuoteDeliveryRecipientAddress,
} from "@/lib/quote-v2-delivery-payload";
import {
  hashQuoteCapabilityToken,
  QUOTE_SIGNER_ACTIONS,
  QUOTE_VIEWER_ACTIONS,
} from "@/lib/quote-v2-capability";
import { getMediaObject } from "@/lib/media-storage";
import { sendEmailMessage, sendSmsMessage } from "@/lib/messaging";
import {
  parseQuoteV2OutboxEvent,
  quoteV2RetryDelayMs,
} from "@/lib/quote-v2-outbox-contract";

const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;

type WorkerOutcome =
  | { status: "processed"; error?: string }
  | {
      status: "retry";
      error: string;
      maxAttempts: number;
      nextAttemptAt: Date;
    }
  | {
      status: "quarantined";
      error: string;
      quarantineReason: string;
    };

type ProviderResult = Awaited<ReturnType<typeof sendEmailMessage>>;
type DeliveryStatus =
  | "queued"
  | "dispatched"
  | "delivered"
  | "failed"
  | "reconciliation_required"
  | "suppressed";

function retryableProviderFailure(detail: string | undefined): boolean {
  const normalized = detail?.toLowerCase() ?? "provider_failed";
  return !(
    normalized.includes("invalid") ||
    normalized.includes("rejected:permanent") ||
    normalized.includes("failed:400") ||
    normalized.includes("failed:401") ||
    normalized.includes("failed:403") ||
    normalized.includes("failed:404")
  );
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function classifyQuoteV2DeliveryResult(input: {
  result: ProviderResult;
  attempt: number;
}): "dispatched" | "queued" | "failed" | "reconciliation_required" {
  if (input.result.ok) return "dispatched";
  if (input.result.deliveryCertainty === "uncertain") {
    return "reconciliation_required";
  }
  return retryableProviderFailure(input.result.detail) && input.attempt < 8
    ? "queued"
    : "failed";
}

export function resolveQuoteV2SendAttemptStatus(
  statuses: readonly string[],
):
  | "processing"
  | "reconciliation_required"
  | "partial"
  | "succeeded"
  | "failed" {
  const hasQueued = statuses.includes("queued");
  const hasReconciliation = statuses.includes("reconciliation_required");
  const sentCount = statuses.filter(
    (status) => status === "dispatched" || status === "delivered",
  ).length;
  const failedCount = statuses.filter(
    (status) => status === "failed" || status === "suppressed",
  ).length;
  return hasQueued
    ? "processing"
    : hasReconciliation
      ? "reconciliation_required"
      : sentCount > 0 && failedCount > 0
        ? "partial"
        : sentCount > 0
          ? "succeeded"
          : "failed";
}

async function markDeliveryEvidenceFailure(input: {
  deliveryId: string;
  code: "delivery_evidence_invalid" | "capability_inactive";
  status: "failed" | "suppressed";
}): Promise<void> {
  const now = new Date();
  const db = getDb();
  await db
    .update(quoteSendDeliveries)
    .set({
      status: input.status,
      errorCode: input.code,
      errorDetail:
        input.code === "capability_inactive"
          ? "The scoped customer capability is no longer active."
          : "The immutable encrypted delivery evidence could not be verified.",
      failedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(quoteSendDeliveries.id, input.deliveryId),
        eq(quoteSendDeliveries.status, "queued"),
      ),
    );
}

async function proposalPdf(input: {
  versionId: string;
  documentId: string | null | undefined;
}): Promise<{ filename: string; base64: string }> {
  if (!input.documentId) throw new Error("quote_pdf_reference_missing");
  const db = getDb();
  const [document] = await db
    .select({
      filename: quoteVersionDocuments.filename,
      contentType: quoteVersionDocuments.contentType,
      storageObjectKey: quoteVersionDocuments.storageObjectKey,
      byteSize: quoteVersionDocuments.byteSize,
      sha256: quoteVersionDocuments.sha256,
    })
    .from(quoteVersionDocuments)
    .where(
      and(
        eq(quoteVersionDocuments.id, input.documentId),
        eq(quoteVersionDocuments.quoteVersionId, input.versionId),
        eq(quoteVersionDocuments.kind, "proposal_pdf"),
      ),
    )
    .limit(1);
  if (
    !document ||
    document.contentType !== "application/pdf" ||
    document.byteSize <= 0 ||
    document.byteSize > MAX_DOCUMENT_BYTES
  ) {
    throw new Error("quote_pdf_evidence_invalid");
  }
  const bytes = await getMediaObject(
    document.storageObjectKey,
    MAX_DOCUMENT_BYTES + 1,
  );
  if (
    bytes.byteLength !== document.byteSize ||
    sha256(bytes) !== document.sha256
  ) {
    throw new Error("quote_pdf_hash_mismatch");
  }
  return { filename: document.filename, base64: bytes.toString("base64") };
}

async function dispatchDelivery(input: {
  delivery: typeof quoteSendDeliveries.$inferSelect;
  quoteId: string;
  versionId: string;
  outboxAttempt: number;
}): Promise<DeliveryStatus> {
  const db = getDb();
  let payload: ReturnType<typeof decryptQuoteDeliveryProviderPayload>;
  let pdf: Awaited<ReturnType<typeof proposalPdf>> | null;
  try {
    payload = decryptQuoteDeliveryProviderPayload({
      encryptedProviderPayload: input.delivery.encryptedProviderPayload,
      encryptionKeyId: input.delivery.encryptionKeyId,
      deliveryId: input.delivery.id,
      versionId: input.versionId,
    });
    const recipientAddressHash = hashQuoteDeliveryRecipientAddress({
      channel: payload.channel,
      address: payload.recipient.address,
    });
    if (
      payload.quoteId !== input.quoteId ||
      payload.versionId !== input.versionId ||
      payload.deliveryId !== input.delivery.id ||
      payload.channel !== input.delivery.channel ||
      payload.recipient.role !== input.delivery.recipientRole ||
      recipientAddressHash !== input.delivery.recipientAddressHash
    ) {
      throw new TypeError("quote_delivery_binding_invalid");
    }
    pdf =
      payload.channel === "email"
        ? await proposalPdf({
            versionId: input.versionId,
            documentId: payload.content.documentId,
          })
        : null;
  } catch {
    await markDeliveryEvidenceFailure({
      deliveryId: input.delivery.id,
      code: "delivery_evidence_invalid",
      status: "failed",
    });
    return "failed";
  }
  const tokenHash = hashQuoteCapabilityToken(payload.capabilityToken);
  const capabilityCheckedAt = new Date();
  const [capability] = await db
    .select({
      recipientRole: quoteCapabilities.recipientRole,
      allowedActions: quoteCapabilities.allowedActions,
      readExpiresAt: quoteCapabilities.readExpiresAt,
      actionExpiresAt: quoteCapabilities.actionExpiresAt,
    })
    .from(quoteCapabilities)
    .where(
      and(
        eq(quoteCapabilities.tokenHash, tokenHash),
        eq(quoteCapabilities.quoteId, input.quoteId),
        eq(quoteCapabilities.quoteVersionId, input.versionId),
        eq(quoteCapabilities.status, "active"),
      ),
    )
    .limit(1);
  if (
    !capability ||
    capability.recipientRole !== payload.recipient.role ||
    !(
      capability.recipientRole === "signer"
        ? QUOTE_SIGNER_ACTIONS
        : QUOTE_VIEWER_ACTIONS
    ).every((action) => capability.allowedActions.includes(action)) ||
    capability.readExpiresAt <= capabilityCheckedAt ||
    (capability.recipientRole === "signer" &&
      (!capability.actionExpiresAt ||
        capability.actionExpiresAt <= capabilityCheckedAt))
  ) {
    await markDeliveryEvidenceFailure({
      deliveryId: input.delivery.id,
      code: "capability_inactive",
      status: "suppressed",
    });
    return "suppressed";
  }
  const providerRequestKey = `quote-v2:${input.delivery.id}:${input.delivery.channelAttemptNumber}`;
  const dispatchStartedAt = new Date();
  const [claimed] = await db
    .update(quoteSendDeliveries)
    .set({
      status: "dispatched",
      providerRequestKey,
      dispatchedAt: dispatchStartedAt,
      errorCode: null,
      errorDetail: null,
      updatedAt: dispatchStartedAt,
    })
    .where(
      and(
        eq(quoteSendDeliveries.id, input.delivery.id),
        eq(quoteSendDeliveries.status, "queued"),
      ),
    )
    .returning({ id: quoteSendDeliveries.id });
  if (!claimed) return "dispatched";

  let result: ProviderResult;
  try {
    result =
      payload.channel === "email"
        ? await sendEmailMessage(
            payload.recipient.address,
            payload.content.subject ?? "Your proposal",
            payload.content.text,
            {
              idempotencyKey: providerRequestKey,
              emailHtml: payload.content.html,
              emailAttachments: pdf
                ? [
                    {
                      filename: pdf.filename,
                      content: pdf.base64,
                      contentType: "application/pdf",
                      encoding: "base64",
                    },
                  ]
                : [],
            },
          )
        : await sendSmsMessage(
            payload.recipient.address,
            payload.content.text,
            null,
            { idempotencyKey: providerRequestKey },
          );
  } catch {
    result = {
      ok: false,
      provider: payload.channel === "email" ? "smtp" : "twilio",
      providerMessageId: null,
      providerOperationIds: [],
      providerIdempotencySupported: false,
      deliveryCertainty: "uncertain",
      detail: "provider_dispatch_exception",
    };
  }
  const status = classifyQuoteV2DeliveryResult({
    result,
    attempt: input.outboxAttempt,
  });
  const finishedAt = new Date();
  await db
    .update(quoteSendDeliveries)
    .set({
      status,
      provider: result.provider ?? null,
      providerMessageId: result.providerMessageId ?? null,
      errorCode: result.ok ? null : status,
      errorDetail: result.ok ? null : (result.detail ?? "provider_failed"),
      failedAt:
        status === "failed" || status === "reconciliation_required"
          ? finishedAt
          : null,
      updatedAt: finishedAt,
    })
    .where(
      and(
        eq(quoteSendDeliveries.id, input.delivery.id),
        eq(quoteSendDeliveries.providerRequestKey, providerRequestKey),
      ),
    );
  return status;
}

export async function processQuoteV2SendRequestedOutbox(input: {
  id: string;
  type: string;
  payload: unknown;
  attempts: number;
}): Promise<WorkerOutcome> {
  let event: ReturnType<typeof parseQuoteV2OutboxEvent>;
  try {
    event = parseQuoteV2OutboxEvent({
      type: input.type,
      payload: input.payload,
    });
  } catch (error) {
    return {
      status: "quarantined",
      error: error instanceof Error ? error.message : "invalid_quote_event",
      quarantineReason: "invalid_quote_v2_event",
    };
  }
  if (
    event.type !== "quote.send_requested.v2" ||
    event.payload.eventId !== input.id ||
    !event.payload.attemptId
  ) {
    return {
      status: "quarantined",
      error: "quote_send_event_binding_invalid",
      quarantineReason: "quote_send_event_binding_invalid",
    };
  }
  const db = getDb();
  const [attempt] = await db
    .select({
      id: quoteSendAttempts.id,
      quoteId: quoteSendAttempts.quoteId,
      versionId: quoteSendAttempts.quoteVersionId,
      status: quoteSendAttempts.status,
      aggregateState: quotes.aggregateState,
      publishedVersionId: quotes.publishedVersionId,
      versionState: quoteVersions.state,
      versionExpiresAt: quoteVersions.expiresAt,
      contactDoNotContact: contacts.doNotContact,
      contactDeletedAt: contacts.deletedAt,
    })
    .from(quoteSendAttempts)
    .innerJoin(quotes, eq(quotes.id, quoteSendAttempts.quoteId))
    .innerJoin(
      quoteVersions,
      eq(quoteVersions.id, quoteSendAttempts.quoteVersionId),
    )
    .innerJoin(contacts, eq(contacts.id, quotes.contactId))
    .where(eq(quoteSendAttempts.id, event.payload.attemptId))
    .limit(1);
  if (
    !attempt ||
    attempt.quoteId !== event.payload.quoteId ||
    attempt.versionId !== event.payload.versionId
  ) {
    return {
      status: "quarantined",
      error: "quote_send_attempt_missing",
      quarantineReason: "quote_send_attempt_missing",
    };
  }
  if (
    attempt.status === "succeeded" ||
    attempt.status === "partial" ||
    attempt.status === "failed" ||
    attempt.status === "reconciliation_required" ||
    attempt.status === "canceled"
  ) {
    return { status: "processed" };
  }

  const deliveries = await db
    .select()
    .from(quoteSendDeliveries)
    .where(eq(quoteSendDeliveries.sendAttemptId, attempt.id));
  if (deliveries.length === 0) {
    return {
      status: "quarantined",
      error: "quote_send_deliveries_missing",
      quarantineReason: "quote_send_deliveries_missing",
    };
  }
  const now = new Date();
  const [openChange] = await db
    .select({ id: quoteChangeRequests.id })
    .from(quoteChangeRequests)
    .where(
      and(
        eq(quoteChangeRequests.quoteVersionId, attempt.versionId),
        inArray(quoteChangeRequests.status, ["open", "acknowledged"]),
      ),
    )
    .limit(1);
  const suppressionReason =
    attempt.contactDeletedAt || attempt.contactDoNotContact
      ? "contact_unavailable"
      : attempt.aggregateState !== "open" ||
          attempt.publishedVersionId !== attempt.versionId ||
          attempt.versionState !== "issued"
        ? "quote_no_longer_actionable"
        : !attempt.versionExpiresAt || attempt.versionExpiresAt <= now
          ? "quote_expired"
          : openChange
            ? "change_request_open"
            : null;
  if (suppressionReason) {
    await db.transaction(async (tx) => {
      await tx
        .update(quoteSendDeliveries)
        .set({
          status: "suppressed",
          errorCode: "send_suppressed",
          errorDetail: "Delivery was suppressed before provider dispatch.",
          failedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(quoteSendDeliveries.sendAttemptId, attempt.id),
            eq(quoteSendDeliveries.status, "queued"),
          ),
        );
      await tx
        .update(quoteSendDeliveries)
        .set({
          status: "reconciliation_required",
          errorCode: "ambiguous_dispatch",
          errorDetail:
            "Provider dispatch may have occurred before local confirmation.",
          failedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(quoteSendDeliveries.sendAttemptId, attempt.id),
            eq(quoteSendDeliveries.status, "dispatched"),
            isNull(quoteSendDeliveries.providerMessageId),
          ),
        );
      const terminalDeliveries = await tx
        .select({ status: quoteSendDeliveries.status })
        .from(quoteSendDeliveries)
        .where(eq(quoteSendDeliveries.sendAttemptId, attempt.id));
      const resolvedStatus = resolveQuoteV2SendAttemptStatus(
        terminalDeliveries.map((delivery) => delivery.status),
      );
      const terminalStatus =
        resolvedStatus === "failed" || resolvedStatus === "processing"
          ? "canceled"
          : resolvedStatus;
      await tx
        .update(quoteSendAttempts)
        .set({
          status: terminalStatus,
          completedAt: now,
          lastErrorCode:
            terminalStatus === "succeeded" ? null : suppressionReason,
          updatedAt: now,
        })
        .where(eq(quoteSendAttempts.id, attempt.id));
      await tx.insert(quoteActivityEvents).values({
        quoteId: attempt.quoteId,
        quoteVersionId: attempt.versionId,
        eventType: "quote.send_suppressed",
        actorType: "worker",
        outboxEventId: input.id,
        correlationId: event.payload.correlationId,
        metadata: { reason: suppressionReason, status: terminalStatus },
        occurredAt: now,
        createdAt: now,
      });
    });
    return { status: "processed" };
  }

  await db
    .update(quoteSendAttempts)
    .set({
      status: "processing",
      startedAt: attempt.status === "requested" ? now : undefined,
      updatedAt: now,
    })
    .where(
      and(
        eq(quoteSendAttempts.id, attempt.id),
        inArray(quoteSendAttempts.status, ["requested", "processing"]),
      ),
    );

  let shouldRetry = false;
  for (const delivery of deliveries) {
    if (delivery.status === "dispatched" && !delivery.providerMessageId) {
      await db
        .update(quoteSendDeliveries)
        .set({
          status: "reconciliation_required",
          errorCode: "ambiguous_dispatch",
          errorDetail:
            "Provider dispatch may have occurred before local confirmation.",
          failedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(quoteSendDeliveries.id, delivery.id));
      continue;
    }
    if (delivery.status !== "queued") continue;
    const status = await dispatchDelivery({
      delivery,
      quoteId: attempt.quoteId,
      versionId: attempt.versionId,
      outboxAttempt: input.attempts + 1,
    });
    if (status === "queued") shouldRetry = true;
  }

  const finalDeliveries = await db
    .select({ status: quoteSendDeliveries.status })
    .from(quoteSendDeliveries)
    .where(eq(quoteSendDeliveries.sendAttemptId, attempt.id));
  const statuses = finalDeliveries.map((delivery) => delivery.status);
  const hasQueued = statuses.includes("queued");
  const sentCount = statuses.filter(
    (status) => status === "dispatched" || status === "delivered",
  ).length;
  const failedCount = statuses.filter(
    (status) => status === "failed" || status === "suppressed",
  ).length;
  const attemptStatus = resolveQuoteV2SendAttemptStatus(statuses);
  const completedAt = attemptStatus === "processing" ? null : new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(quoteSendAttempts)
      .set({
        status: attemptStatus,
        completedAt,
        lastErrorCode: attemptStatus === "succeeded" ? null : attemptStatus,
        updatedAt: new Date(),
      })
      .where(eq(quoteSendAttempts.id, attempt.id));
    if (completedAt) {
      await tx.insert(quoteActivityEvents).values({
        quoteId: attempt.quoteId,
        quoteVersionId: attempt.versionId,
        eventType: "quote.delivery_completed",
        actorType: "worker",
        outboxEventId: input.id,
        correlationId: event.payload.correlationId,
        metadata: {
          sendAttemptId: attempt.id,
          status: attemptStatus,
          sentCount,
          failedCount,
        },
        occurredAt: completedAt,
        createdAt: completedAt,
      });
    }
  });
  return shouldRetry || hasQueued
    ? {
        status: "retry",
        error: "quote_delivery_retry_required",
        maxAttempts: 8,
        nextAttemptAt: new Date(
          Date.now() + quoteV2RetryDelayMs(input.attempts + 1),
        ),
      }
    : {
        status: "processed",
        ...(attemptStatus === "succeeded" ? {} : { error: attemptStatus }),
      };
}
