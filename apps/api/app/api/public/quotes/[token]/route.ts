import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  auditLogs,
  contacts,
  crmPipeline,
  getDb,
  leadAutomationStates,
  leads,
  outboxEvents,
  properties,
  publicQuoteMutationReceipts,
  quotes,
} from "@/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { sanitizeAuditMetadata } from "@/lib/audit-metadata";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import {
  isPublicQuoteMutationSuccessBody,
  normalizePublicQuoteIdempotencyKey,
  PUBLIC_QUOTE_MUTATION_RECEIPT_TTL_MS,
  publicQuoteMutationKeyHash,
  publicQuoteMutationRequestHash,
} from "@/lib/public-quote-mutation";
import {
  maybeHandleQuoteV2PublicDecision,
  maybeHandleQuoteV2PublicGet,
} from "@/lib/quote-v2-public-route";

const PublicQuoteDecisionSchema = z
  .object({
    quoteId: z.string().uuid(),
    expectedRevision: z.number().int().positive(),
    decision: z.enum(["accepted", "declined"]),
    reason: z.string().trim().max(120).optional(),
    notes: z.string().trim().max(1000).optional(),
  })
  .strict();

const PublicQuoteRefreshSchema = z
  .object({
    action: z.literal("refresh"),
  })
  .strict();

const PublicQuoteActionSchema = z.union([
  PublicQuoteDecisionSchema,
  PublicQuoteRefreshSchema,
]);

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

function publicCorrelationId(request: NextRequest): string {
  const candidate = request.headers.get("x-correlation-id")?.trim() ?? "";
  return CORRELATION_ID_PATTERN.test(candidate) ? candidate : randomUUID();
}

function displayStatus(row: {
  status: string;
  expiresAt: Date | null;
  viewedAt: Date | null;
  refreshRequestedAt: Date | null;
  acceptedAppointmentId: string | null;
}): string {
  if (row.acceptedAppointmentId) return "booked";
  if (row.refreshRequestedAt) return "refresh_requested";
  if (row.status === "declined") return "rejected";
  if (row.status === "accepted") return "accepted";
  if (
    row.status === "sent" &&
    row.expiresAt &&
    row.expiresAt.getTime() < Date.now()
  )
    return "expired";
  if (row.status === "sent" && row.viewedAt) return "viewed";
  if (row.status === "sent") return "sent";
  return "draft";
}

function mapPublicQuote(row: {
  id: string;
  status: string;
  services: string[];
  addOns: string[] | null;
  lineItems: unknown;
  subtotal: unknown;
  total: unknown;
  depositDue: unknown;
  balanceDue: unknown;
  quoteNumber: string | null;
  jobDurationMinutes: number;
  clientScope: string | null;
  revision: number;
  sentAt: Date | null;
  expiresAt: Date | null;
  viewedAt: Date | null;
  lastViewedAt: Date | null;
  viewCount: number;
  decisionAt: Date | null;
  decisionNotes: string | null;
  refreshRequestedAt: Date | null;
  acceptedAppointmentId: string | null;
  contactName: string | null;
  propertyAddressLine1: string | null;
  propertyCity: string | null;
  propertyState: string | null;
  propertyPostalCode: string | null;
}) {
  const expiresAtIso = row.expiresAt ? row.expiresAt.toISOString() : null;
  const expired = row.expiresAt ? row.expiresAt.getTime() < Date.now() : false;
  const customerName = row.contactName?.trim();
  const city = row.propertyCity?.trim();
  const state = row.propertyState?.trim();
  const postalCode = row.propertyPostalCode?.trim();
  const cityState = [city, state]
    .filter((part): part is string => Boolean(part && part.length))
    .join(", ")
    .trim();
  const serviceArea = [cityState, postalCode]
    .filter((part): part is string => Boolean(part && part.length))
    .join(" ")
    .trim();

  return {
    id: row.id,
    status: row.status,
    services: row.services,
    addOns: row.addOns,
    lineItems: row.lineItems,
    subtotal: Number(row.subtotal),
    total: Number(row.total),
    depositDue: Number(row.depositDue),
    balanceDue: Number(row.balanceDue),
    quoteNumber: row.quoteNumber ?? row.id.slice(0, 8).toUpperCase(),
    jobDurationMinutes: row.jobDurationMinutes,
    clientScope: row.clientScope,
    revision: row.revision,
    displayStatus: displayStatus(row),
    sentAt: row.sentAt ? row.sentAt.toISOString() : null,
    expiresAt: expiresAtIso,
    viewedAt: row.viewedAt ? row.viewedAt.toISOString() : null,
    lastViewedAt: row.lastViewedAt ? row.lastViewedAt.toISOString() : null,
    viewCount: row.viewCount,
    decisionAt: row.decisionAt ? row.decisionAt.toISOString() : null,
    expired,
    decisionNotes: row.decisionNotes,
    refreshRequestedAt: row.refreshRequestedAt
      ? row.refreshRequestedAt.toISOString()
      : null,
    acceptedAppointmentId: row.acceptedAppointmentId,
    customerName:
      customerName && customerName.length ? customerName : "Customer",
    addressLine1: row.propertyAddressLine1?.trim() ?? "",
    serviceArea: serviceArea.length ? serviceArea : "",
  };
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await context.params;
  if (!token) {
    return NextResponse.json({ error: "missing_token" }, { status: 400 });
  }

  const quoteV2 = await maybeHandleQuoteV2PublicGet(request, token);
  if (quoteV2.handled) return quoteV2.response;

  const db = getDb();
  const rows = await db
    .select({
      id: quotes.id,
      status: quotes.status,
      services: quotes.services,
      addOns: quotes.addOns,
      lineItems: quotes.lineItems,
      subtotal: quotes.subtotal,
      total: quotes.total,
      depositDue: quotes.depositDue,
      balanceDue: quotes.balanceDue,
      quoteNumber: quotes.quoteNumber,
      jobDurationMinutes: quotes.jobDurationMinutes,
      clientScope: quotes.clientScope,
      revision: quotes.revision,
      sentAt: quotes.sentAt,
      expiresAt: quotes.expiresAt,
      viewedAt: quotes.viewedAt,
      lastViewedAt: quotes.lastViewedAt,
      viewCount: quotes.viewCount,
      decisionAt: quotes.decisionAt,
      decisionNotes: quotes.decisionNotes,
      refreshRequestedAt: quotes.refreshRequestedAt,
      acceptedAppointmentId: quotes.acceptedAppointmentId,
      contactName: contacts.firstName,
      propertyAddressLine1: properties.addressLine1,
      propertyCity: properties.city,
      propertyState: properties.state,
      propertyPostalCode: properties.postalCode,
    })
    .from(quotes)
    .leftJoin(contacts, eq(quotes.contactId, contacts.id))
    .leftJoin(properties, eq(quotes.propertyId, properties.id))
    .where(eq(quotes.shareToken, token))
    .limit(1);

  const quote = rows[0];
  if (!quote) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const preview = request.nextUrl.searchParams.get("preview") === "1";
  let responseQuote = quote;
  if (!preview) {
    const now = new Date();
    const [viewed] = await db
      .update(quotes)
      .set({
        viewedAt: quote.viewedAt ?? now,
        lastViewedAt: now,
        viewCount: sql`${quotes.viewCount} + 1`,
        updatedAt: now,
      })
      .where(eq(quotes.id, quote.id))
      .returning({
        viewedAt: quotes.viewedAt,
        lastViewedAt: quotes.lastViewedAt,
        viewCount: quotes.viewCount,
      });
    if (viewed) {
      responseQuote = {
        ...quote,
        viewedAt: viewed.viewedAt,
        lastViewedAt: viewed.lastViewedAt,
        viewCount: viewed.viewCount,
      };
    }
  }

  return NextResponse.json({
    quote: mapPublicQuote(responseQuote),
  });
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await context.params;
  if (!token) {
    return NextResponse.json({ error: "missing_token" }, { status: 400 });
  }

  const quoteV2 = await maybeHandleQuoteV2PublicDecision(request, token);
  if (quoteV2.handled) return quoteV2.response;

  const idempotencyKey = normalizePublicQuoteIdempotencyKey(
    request.headers.get("idempotency-key"),
  );
  if (!idempotencyKey) {
    return NextResponse.json(
      {
        ok: false,
        error: "idempotency_key_required",
        message: "Refresh the quote page before trying this action again.",
      },
      { status: 422 },
    );
  }

  let body: unknown;
  try {
    body = await readBoundedJsonRequest(request, {
      maximumBytes: 4 * 1024,
      rejectDuplicateObjectKeys: true,
    });
  } catch (error) {
    const failure =
      error instanceof BoundedJsonRequestError
        ? error
        : new BoundedJsonRequestError(
            "invalid_body",
            "The request body could not be read.",
            400,
          );
    return NextResponse.json(
      { ok: false, error: failure.code, message: failure.message },
      { status: failure.status },
    );
  }

  const parsedBody = PublicQuoteActionSchema.safeParse(body);
  if (!parsedBody.success) {
    return NextResponse.json(
      {
        ok: false,
        error: "invalid_payload",
        message:
          "The quote action is incomplete. Refresh the quote before trying again.",
        details: parsedBody.error.flatten(),
      },
      { status: 422 },
    );
  }

  const decisionInput = "decision" in parsedBody.data ? parsedBody.data : null;
  const action = decisionInput ? "decision" : "refresh";
  const normalizedReason = decisionInput?.reason || null;
  const normalizedNotes = decisionInput?.notes || null;
  const keyHash = publicQuoteMutationKeyHash(idempotencyKey);
  const requestHash = publicQuoteMutationRequestHash({
    action,
    decision: decisionInput?.decision,
    reason: normalizedReason,
    notes: normalizedNotes,
    quoteId: decisionInput?.quoteId,
    expectedRevision: decisionInput?.expectedRevision,
  });
  const correlationId = publicCorrelationId(request);
  const db = getDb();
  try {
    const result = await db.transaction(async (tx) => {
      const [quote] = await tx
        .select({
          id: quotes.id,
          contactId: quotes.contactId,
          status: quotes.status,
          revision: quotes.revision,
          expiresAt: quotes.expiresAt,
          refreshRequestedAt: quotes.refreshRequestedAt,
        })
        .from(quotes)
        .where(eq(quotes.shareToken, token))
        .for("update")
        .limit(1);

      if (!quote) return { kind: "not_found" as const };
      if (decisionInput && quote.id !== decisionInput.quoteId) {
        await tx.insert(auditLogs).values({
          actorType: "system",
          actorLabel: "public-quote-capability",
          correlationId,
          outcome: "failed",
          surface: "/quote/[token]",
          idempotencyKeyHash: keyHash,
          action: "quote.public_decision",
          entityType: "quote",
          entityId: quote.id,
          meta: sanitizeAuditMetadata({
            reason: "quote_binding_mismatch",
            source: "customer",
            capabilityTokenStored: false,
          }),
        });
        return { kind: "not_found" as const };
      }

      const [receipt] = await tx
        .select({
          requestHash: publicQuoteMutationReceipts.requestHash,
          responseStatus: publicQuoteMutationReceipts.responseStatus,
          responseBody: publicQuoteMutationReceipts.responseBody,
          expiresAt: publicQuoteMutationReceipts.expiresAt,
        })
        .from(publicQuoteMutationReceipts)
        .where(
          and(
            eq(publicQuoteMutationReceipts.quoteId, quote.id),
            eq(publicQuoteMutationReceipts.action, action),
            eq(publicQuoteMutationReceipts.keyHash, keyHash),
          ),
        )
        .limit(1);
      if (receipt) {
        if (receipt.requestHash !== requestHash) {
          await tx.insert(auditLogs).values({
            actorType: "system",
            actorLabel: "public-quote-capability",
            correlationId,
            outcome: "failed",
            surface: "/quote/[token]",
            idempotencyKeyHash: keyHash,
            action: `quote.public_${action}`,
            entityType: "quote",
            entityId: quote.id,
            meta: sanitizeAuditMetadata({
              reason: "idempotency_key_reused_with_different_request",
              source: "customer",
              capabilityTokenStored: false,
            }),
          });
          return { kind: "idempotency_conflict" as const };
        }
        if (receipt.expiresAt.getTime() <= Date.now()) {
          await tx.insert(auditLogs).values({
            actorType: "system",
            actorLabel: "public-quote-capability",
            correlationId,
            outcome: "failed",
            surface: "/quote/[token]",
            idempotencyKeyHash: keyHash,
            action: `quote.public_${action}`,
            entityType: "quote",
            entityId: quote.id,
            meta: sanitizeAuditMetadata({
              reason: "idempotency_key_expired",
              source: "customer",
              capabilityTokenStored: false,
            }),
          });
          return { kind: "idempotency_expired" as const };
        }
        if (!isPublicQuoteMutationSuccessBody(receipt.responseBody)) {
          throw new Error("public_quote_receipt_corrupt");
        }
        return {
          kind: "replay" as const,
          status: receipt.responseStatus,
          body: receipt.responseBody,
        };
      }

      if (decisionInput && quote.revision !== decisionInput.expectedRevision) {
        await tx.insert(auditLogs).values({
          actorType: "system",
          actorLabel: "public-quote-capability",
          correlationId,
          outcome: "failed",
          surface: "/quote/[token]",
          idempotencyKeyHash: keyHash,
          action: "quote.public_decision",
          entityType: "quote",
          entityId: quote.id,
          meta: sanitizeAuditMetadata({
            reason: "stale_quote_revision",
            source: "customer",
            expectedRevision: decisionInput.expectedRevision,
            currentRevision: quote.revision,
            capabilityTokenStored: false,
          }),
        });
        return {
          kind: "stale" as const,
          quoteId: quote.id,
          expectedRevision: decisionInput.expectedRevision,
          currentRevision: quote.revision,
        };
      }

      if (!decisionInput) {
        const refreshAllowed =
          quote.status === "sent" &&
          quote.expiresAt !== null &&
          quote.expiresAt.getTime() < Date.now() &&
          quote.refreshRequestedAt === null;
        if (!refreshAllowed) {
          await tx.insert(auditLogs).values({
            actorType: "system",
            actorLabel: "public-quote-capability",
            correlationId,
            outcome: "failed",
            surface: "/quote/[token]",
            idempotencyKeyHash: keyHash,
            action: "quote.public_refresh",
            entityType: "quote",
            entityId: quote.id,
            meta: sanitizeAuditMetadata({
              reason: quote.refreshRequestedAt
                ? "refresh_already_requested"
                : quote.status !== "sent"
                  ? "quote_not_open_for_refresh"
                  : "quote_not_expired",
              source: "customer",
              capabilityTokenStored: false,
            }),
          });
          return { kind: "refresh_not_allowed" as const };
        }
        const requestedAt = new Date();
        const nextRevision = quote.revision + 1;
        const [updated] = await tx
          .update(quotes)
          .set({
            refreshRequestedAt: requestedAt,
            revision: nextRevision,
            updatedAt: requestedAt,
          })
          .where(
            and(eq(quotes.id, quote.id), eq(quotes.revision, quote.revision)),
          )
          .returning({
            id: quotes.id,
            revision: quotes.revision,
            refreshRequestedAt: quotes.refreshRequestedAt,
          });
        if (!updated) {
          await tx.insert(auditLogs).values({
            actorType: "system",
            actorLabel: "public-quote-capability",
            correlationId,
            outcome: "failed",
            surface: "/quote/[token]",
            idempotencyKeyHash: keyHash,
            action: "quote.public_refresh",
            entityType: "quote",
            entityId: quote.id,
            meta: sanitizeAuditMetadata({
              reason: "concurrent_quote_change",
              source: "customer",
              capabilityTokenStored: false,
            }),
          });
          return { kind: "conflict" as const };
        }
        const responseBody = {
          ok: true as const,
          quoteId: updated.id,
          revision: updated.revision,
          refreshRequestedAt:
            updated.refreshRequestedAt?.toISOString() ??
            requestedAt.toISOString(),
        };
        await tx.insert(auditLogs).values({
          actorType: "system",
          actorLabel: "public-quote-capability",
          correlationId,
          outcome: "succeeded",
          surface: "/quote/[token]",
          idempotencyKeyHash: keyHash,
          action: "quote.public_refresh",
          entityType: "quote",
          entityId: quote.id,
          meta: sanitizeAuditMetadata({
            source: "customer",
            beforeRevision: quote.revision,
            afterRevision: updated.revision,
            capabilityTokenStored: false,
          }),
          createdAt: requestedAt,
        });
        await tx.insert(publicQuoteMutationReceipts).values({
          quoteId: quote.id,
          action,
          keyHash,
          requestHash,
          responseStatus: 200,
          responseBody,
          createdAt: requestedAt,
          expiresAt: new Date(
            requestedAt.getTime() + PUBLIC_QUOTE_MUTATION_RECEIPT_TTL_MS,
          ),
        });
        return { kind: "refreshed" as const, body: responseBody };
      }

      const decision = decisionInput.decision;
      if (quote.status === "accepted" || quote.status === "declined") {
        await tx.insert(auditLogs).values({
          actorType: "system",
          actorLabel: "public-quote-capability",
          correlationId,
          outcome: "failed",
          surface: "/quote/[token]",
          idempotencyKeyHash: keyHash,
          action: "quote.public_decision",
          entityType: "quote",
          entityId: quote.id,
          meta: sanitizeAuditMetadata({
            reason: "quote_already_terminal",
            existingStatus: quote.status,
            requestedDecision: decision,
            source: "customer",
            capabilityTokenStored: false,
          }),
        });
        return {
          kind: "already_decided" as const,
          status: quote.status,
        };
      }
      if (quote.status !== "sent") {
        await tx.insert(auditLogs).values({
          actorType: "system",
          actorLabel: "public-quote-capability",
          correlationId,
          outcome: "failed",
          surface: "/quote/[token]",
          idempotencyKeyHash: keyHash,
          action: "quote.public_decision",
          entityType: "quote",
          entityId: quote.id,
          meta: sanitizeAuditMetadata({
            reason: "quote_not_issued",
            existingStatus: quote.status,
            source: "customer",
            capabilityTokenStored: false,
          }),
        });
        return { kind: "not_issued" as const };
      }
      const expired = quote.expiresAt
        ? quote.expiresAt.getTime() < Date.now()
        : false;
      if (expired) {
        await tx.insert(auditLogs).values({
          actorType: "system",
          actorLabel: "public-quote-capability",
          correlationId,
          outcome: "failed",
          surface: "/quote/[token]",
          idempotencyKeyHash: keyHash,
          action: "quote.public_decision",
          entityType: "quote",
          entityId: quote.id,
          meta: sanitizeAuditMetadata({
            reason: "quote_expired",
            source: "customer",
            capabilityTokenStored: false,
          }),
        });
        return { kind: "expired" as const };
      }

      const decisionAt = new Date();
      const noteParts = [
        normalizedReason ? `Reason: ${normalizedReason}` : null,
        normalizedNotes,
      ].filter((part): part is string => Boolean(part));
      const nextRevision = quote.revision + 1;
      const [updated] = await tx
        .update(quotes)
        .set({
          status: decision,
          decisionAt,
          decisionNotes: noteParts.length ? noteParts.join("\n") : null,
          refreshRequestedAt: null,
          revision: nextRevision,
          updatedAt: decisionAt,
        })
        .where(
          and(eq(quotes.id, quote.id), eq(quotes.revision, quote.revision)),
        )
        .returning({
          id: quotes.id,
          status: quotes.status,
          revision: quotes.revision,
          decisionAt: quotes.decisionAt,
          decisionNotes: quotes.decisionNotes,
        });
      if (!updated) {
        await tx.insert(auditLogs).values({
          actorType: "system",
          actorLabel: "public-quote-capability",
          correlationId,
          outcome: "failed",
          surface: "/quote/[token]",
          idempotencyKeyHash: keyHash,
          action: "quote.public_decision",
          entityType: "quote",
          entityId: quote.id,
          meta: sanitizeAuditMetadata({
            reason: "concurrent_quote_change",
            source: "customer",
            capabilityTokenStored: false,
          }),
        });
        return { kind: "conflict" as const };
      }

      const targetStage = decision === "accepted" ? "won" : "lost";
      await tx
        .insert(crmPipeline)
        .values({
          contactId: quote.contactId,
          stage: targetStage,
          updatedAt: decisionAt,
        })
        .onConflictDoUpdate({
          target: crmPipeline.contactId,
          set: { stage: targetStage, updatedAt: decisionAt },
        });
      const contactLeadIds = tx
        .select({ id: leads.id })
        .from(leads)
        .where(eq(leads.contactId, quote.contactId));
      await tx
        .update(leadAutomationStates)
        .set({
          followupState: "stopped",
          followupStep: 0,
          nextFollowupAt: null,
          updatedAt: decisionAt,
        })
        .where(inArray(leadAutomationStates.leadId, contactLeadIds));
      await tx.delete(outboxEvents).where(
        and(
          eq(outboxEvents.type, "followup.send"),
          isNull(outboxEvents.processedAt),
          isNull(outboxEvents.quarantinedAt),
          sql`(${outboxEvents.payload}->>'leadId') IN (
              SELECT ${leads.id}::text
              FROM ${leads}
              WHERE ${leads.contactId} = ${quote.contactId}
            )`,
        ),
      );

      const [outbox] = await tx
        .insert(outboxEvents)
        .values({
          type: "quote.decision",
          payload: {
            quoteId: updated.id,
            decision,
            source: "customer",
            notes: updated.decisionNotes,
          },
        })
        .returning({ id: outboxEvents.id });
      if (!outbox?.id) {
        throw new Error("public_quote_decision_outbox_not_persisted");
      }
      const responseBody = {
        ok: true as const,
        quoteId: updated.id,
        status: updated.status,
        revision: updated.revision,
        decisionAt: updated.decisionAt?.toISOString() ?? null,
      };
      await tx.insert(auditLogs).values({
        actorType: "system",
        actorLabel: "public-quote-capability",
        correlationId,
        outcome: "succeeded",
        surface: "/quote/[token]",
        idempotencyKeyHash: keyHash,
        action: "quote.public_decision",
        entityType: "quote",
        entityId: quote.id,
        meta: sanitizeAuditMetadata({
          source: "customer",
          decision,
          beforeRevision: quote.revision,
          afterRevision: updated.revision,
          pipelineStage: targetStage,
          outboxEventId: outbox.id,
          hasReason: Boolean(normalizedReason),
          hasNotes: Boolean(normalizedNotes),
          capabilityTokenStored: false,
        }),
        createdAt: decisionAt,
      });
      await tx.insert(publicQuoteMutationReceipts).values({
        quoteId: quote.id,
        action,
        keyHash,
        requestHash,
        responseStatus: 200,
        responseBody,
        createdAt: decisionAt,
        expiresAt: new Date(
          decisionAt.getTime() + PUBLIC_QUOTE_MUTATION_RECEIPT_TTL_MS,
        ),
      });
      return { kind: "decided" as const, body: responseBody };
    });

    switch (result.kind) {
      case "not_found":
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      case "idempotency_conflict":
        return NextResponse.json(
          {
            ok: false,
            error: "idempotency_key_reused",
            message:
              "This request key was already used for different quote details.",
          },
          { status: 409, headers: { "x-correlation-id": correlationId } },
        );
      case "idempotency_expired":
        return NextResponse.json(
          {
            ok: false,
            error: "idempotency_key_expired",
            message: "Refresh the quote page before trying again.",
          },
          { status: 409, headers: { "x-correlation-id": correlationId } },
        );
      case "replay":
        return NextResponse.json(result.body, {
          status: result.status,
          headers: {
            "idempotency-replayed": "true",
            "x-correlation-id": correlationId,
          },
        });
      case "already_decided":
        return NextResponse.json(
          { error: "already_decided", status: result.status },
          { status: 409 },
        );
      case "not_issued":
        return NextResponse.json(
          { error: "quote_not_issued" },
          { status: 409 },
        );
      case "refresh_not_allowed":
        return NextResponse.json(
          {
            error: "refresh_not_allowed",
            message: "This quote is not eligible for another refresh request.",
          },
          { status: 409 },
        );
      case "expired":
        return NextResponse.json({ error: "expired" }, { status: 410 });
      case "stale":
        return NextResponse.json(
          {
            ok: false,
            error: "stale_quote",
            message:
              "This quote changed after the page loaded. Refresh before responding.",
            retryable: true,
            quoteId: result.quoteId,
            expectedRevision: result.expectedRevision,
            currentRevision: result.currentRevision,
          },
          { status: 409, headers: { "x-correlation-id": correlationId } },
        );
      case "conflict":
        return NextResponse.json(
          { error: "quote_changed", retryable: true },
          { status: 409 },
        );
      case "refreshed":
        return NextResponse.json(result.body, {
          headers: { "x-correlation-id": correlationId },
        });
      case "decided":
        return NextResponse.json(result.body, {
          headers: { "x-correlation-id": correlationId },
        });
    }
  } catch {
    // The business transaction has already rolled back. Record only a safe,
    // token-free failure if the database remains available; audit failure must
    // never change the truthful 500 response.
    await (async () => {
      try {
        const [quote] = await db
          .select({ id: quotes.id })
          .from(quotes)
          .where(eq(quotes.shareToken, token))
          .limit(1);
        if (!quote) return;
        await db.insert(auditLogs).values({
          actorType: "system",
          actorLabel: "public-quote-capability",
          correlationId,
          outcome: "failed",
          surface: "/quote/[token]",
          idempotencyKeyHash: keyHash,
          action: `quote.public_${action}`,
          entityType: "quote",
          entityId: quote.id,
          meta: sanitizeAuditMetadata({
            reason: "unexpected_mutation_failure",
            source: "customer",
            capabilityTokenStored: false,
          }),
        });
      } catch {
        // A failed action remains failed even if failure evidence is unavailable.
      }
    })();
    return NextResponse.json(
      { error: "update_failed" },
      { status: 500, headers: { "x-correlation-id": correlationId } },
    );
  }
}
