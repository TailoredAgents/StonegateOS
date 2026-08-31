import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  auditLogs,
  contacts,
  crmTasks,
  getDb,
  outboxEvents,
  quoteChangeRequests,
  quotes,
} from "@/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { sanitizeAuditMetadata } from "@/lib/audit-metadata";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import {
  normalizePublicQuoteIdempotencyKey,
  publicQuoteMutationKeyHash,
  publicQuoteMutationRequestHash,
} from "@/lib/public-quote-mutation";
import { getDefaultSalesAssigneeMemberId } from "@/lib/sales-scorecard";
import { maybeHandleQuoteV2PublicChange } from "@/lib/quote-v2-public-route";

const ChangeRequestSchema = z
  .object({
    quoteId: z.string().uuid(),
    expectedRevision: z.number().int().positive(),
    reason: z.enum([
      "Scope changed",
      "Price question",
      "Timing issue",
      "Address issue",
      "Need to add/remove items",
      "Other",
    ]),
    message: z.string().trim().max(1500).optional(),
  })
  .strict();

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

function publicCorrelationId(request: NextRequest): string {
  const candidate = request.headers.get("x-correlation-id")?.trim() ?? "";
  return CORRELATION_ID_PATTERN.test(candidate) ? candidate : randomUUID();
}

function replayDetails(value: unknown): {
  requestHash: string;
  changeRequestId: string;
  taskId: string;
  createdAt: string;
} | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const payload = value as Record<string, unknown>;
  if (
    typeof payload["requestHash"] !== "string" ||
    typeof payload["changeRequestId"] !== "string" ||
    typeof payload["taskId"] !== "string" ||
    typeof payload["createdAt"] !== "string"
  ) {
    return null;
  }
  return {
    requestHash: payload["requestHash"],
    changeRequestId: payload["changeRequestId"],
    taskId: payload["taskId"],
    createdAt: payload["createdAt"],
  };
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await context.params;
  if (!token) {
    return NextResponse.json({ error: "missing_token" }, { status: 400 });
  }

  const quoteV2 = await maybeHandleQuoteV2PublicChange(request, token);
  if (quoteV2.handled) return quoteV2.response;

  const idempotencyKey = normalizePublicQuoteIdempotencyKey(
    request.headers.get("idempotency-key"),
  );
  if (!idempotencyKey) {
    return NextResponse.json(
      {
        ok: false,
        error: "idempotency_key_required",
        message: "Refresh the quote page before requesting a change.",
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

  const parsed = ChangeRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error: "invalid_payload",
        message:
          "The change request is incomplete. Refresh the quote before trying again.",
        details: parsed.error.flatten(),
      },
      { status: 422 },
    );
  }

  const message = parsed.data.message || null;
  const keyHash = publicQuoteMutationKeyHash(idempotencyKey);
  const requestHash = publicQuoteMutationRequestHash({
    action: "change",
    quoteId: parsed.data.quoteId,
    expectedRevision: parsed.data.expectedRevision,
    reason: parsed.data.reason,
    notes: message,
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
        })
        .from(quotes)
        .where(eq(quotes.shareToken, token))
        .for("update")
        .limit(1);

      if (!quote) return { kind: "not_found" as const };
      if (quote.id !== parsed.data.quoteId) {
        await tx.insert(auditLogs).values({
          actorType: "system",
          actorLabel: "public-quote-capability",
          correlationId,
          outcome: "failed",
          surface: "/quote/[token]/changes",
          idempotencyKeyHash: keyHash,
          action: "quote.public_change_requested",
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

      const [priorOutbox] = await tx
        .select({ payload: outboxEvents.payload })
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.type, "quote.change_requested"),
            sql`${outboxEvents.payload}->>'quoteId' = ${quote.id}`,
            sql`${outboxEvents.payload}->>'idempotencyKeyHash' = ${keyHash}`,
          ),
        )
        .orderBy(desc(outboxEvents.createdAt))
        .limit(1);
      if (priorOutbox) {
        const replay = replayDetails(priorOutbox.payload);
        if (!replay) {
          throw new Error("public_quote_change_replay_corrupt");
        }
        if (replay.requestHash !== requestHash) {
          await tx.insert(auditLogs).values({
            actorType: "system",
            actorLabel: "public-quote-capability",
            correlationId,
            outcome: "failed",
            surface: "/quote/[token]/changes",
            idempotencyKeyHash: keyHash,
            action: "quote.public_change_requested",
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
        return {
          kind: "replay" as const,
          body: {
            ok: true as const,
            quoteId: quote.id,
            revision: parsed.data.expectedRevision,
            changeRequestId: replay.changeRequestId,
            createdAt: replay.createdAt,
          },
        };
      }

      if (quote.revision !== parsed.data.expectedRevision) {
        await tx.insert(auditLogs).values({
          actorType: "system",
          actorLabel: "public-quote-capability",
          correlationId,
          outcome: "failed",
          surface: "/quote/[token]/changes",
          idempotencyKeyHash: keyHash,
          action: "quote.public_change_requested",
          entityType: "quote",
          entityId: quote.id,
          meta: sanitizeAuditMetadata({
            reason: "stale_quote_revision",
            source: "customer",
            expectedRevision: parsed.data.expectedRevision,
            currentRevision: quote.revision,
            capabilityTokenStored: false,
          }),
        });
        return {
          kind: "stale" as const,
          quoteId: quote.id,
          expectedRevision: parsed.data.expectedRevision,
          currentRevision: quote.revision,
        };
      }

      if (quote.status !== "sent") {
        await tx.insert(auditLogs).values({
          actorType: "system",
          actorLabel: "public-quote-capability",
          correlationId,
          outcome: "failed",
          surface: "/quote/[token]/changes",
          idempotencyKeyHash: keyHash,
          action: "quote.public_change_requested",
          entityType: "quote",
          entityId: quote.id,
          meta: sanitizeAuditMetadata({
            reason: "quote_not_open_for_changes",
            source: "customer",
            existingStatus: quote.status,
            capabilityTokenStored: false,
          }),
        });
        return { kind: "not_open" as const, status: quote.status };
      }

      if (quote.expiresAt && quote.expiresAt.getTime() < Date.now()) {
        await tx.insert(auditLogs).values({
          actorType: "system",
          actorLabel: "public-quote-capability",
          correlationId,
          outcome: "failed",
          surface: "/quote/[token]/changes",
          idempotencyKeyHash: keyHash,
          action: "quote.public_change_requested",
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

      const [contact] = await tx
        .select({ salespersonMemberId: contacts.salespersonMemberId })
        .from(contacts)
        .where(eq(contacts.id, quote.contactId))
        .limit(1);
      const assignedTo =
        (contact?.salespersonMemberId ??
          (await getDefaultSalesAssigneeMemberId(tx))) ||
        null;
      const createdAt = new Date();
      const [created] = await tx
        .insert(quoteChangeRequests)
        .values({
          quoteId: quote.id,
          reason: parsed.data.reason,
          message,
          createdAt,
        })
        .returning({
          id: quoteChangeRequests.id,
          createdAt: quoteChangeRequests.createdAt,
        });
      if (!created?.id) {
        throw new Error("public_quote_change_request_not_persisted");
      }

      const [task] = await tx
        .insert(crmTasks)
        .values({
          contactId: quote.contactId,
          title: "Review quote change request",
          dueAt: createdAt,
          assignedTo,
          status: "open",
          notes: [
            `Quote ID: ${quote.id}`,
            `Change request ID: ${created.id}`,
            `Quote revision: ${quote.revision}`,
            `Reason: ${parsed.data.reason}`,
            message ? `Customer message: ${message}` : null,
          ]
            .filter((line): line is string => Boolean(line))
            .join("\n"),
          createdAt,
          updatedAt: createdAt,
        })
        .returning({ id: crmTasks.id });
      if (!task?.id) {
        throw new Error("public_quote_change_task_not_persisted");
      }

      const eventPayload = {
        quoteId: quote.id,
        contactId: quote.contactId,
        expectedRevision: quote.revision,
        reason: parsed.data.reason,
        message,
        changeRequestId: created.id,
        taskId: task.id,
        assignedTo,
        idempotencyKeyHash: keyHash,
        requestHash,
        createdAt: createdAt.toISOString(),
      };
      const [outbox] = await tx
        .insert(outboxEvents)
        .values({ type: "quote.change_requested", payload: eventPayload })
        .returning({ id: outboxEvents.id });
      if (!outbox?.id) {
        throw new Error("public_quote_change_outbox_not_persisted");
      }

      await tx.insert(auditLogs).values({
        actorType: "system",
        actorLabel: "public-quote-capability",
        correlationId,
        outcome: "succeeded",
        surface: "/quote/[token]/changes",
        idempotencyKeyHash: keyHash,
        action: "quote.public_change_requested",
        entityType: "quote_change_request",
        entityId: created.id,
        meta: sanitizeAuditMetadata({
          source: "customer",
          quoteId: quote.id,
          quoteRevision: quote.revision,
          taskId: task.id,
          outboxEventId: outbox.id,
          assignedToOwner: Boolean(assignedTo),
          hasMessage: Boolean(message),
          capabilityTokenStored: false,
        }),
        createdAt,
      });

      return {
        kind: "created" as const,
        body: {
          ok: true as const,
          quoteId: quote.id,
          revision: quote.revision,
          changeRequestId: created.id,
          createdAt:
            created.createdAt?.toISOString() ?? createdAt.toISOString(),
        },
      };
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
      case "replay":
        return NextResponse.json(result.body, {
          status: 201,
          headers: {
            "idempotency-replayed": "true",
            "x-correlation-id": correlationId,
          },
        });
      case "stale":
        return NextResponse.json(
          {
            ok: false,
            error: "stale_quote",
            message:
              "This quote changed after the page loaded. Refresh before requesting changes.",
            retryable: true,
            quoteId: result.quoteId,
            expectedRevision: result.expectedRevision,
            currentRevision: result.currentRevision,
          },
          { status: 409, headers: { "x-correlation-id": correlationId } },
        );
      case "not_open":
        return NextResponse.json(
          {
            ok: false,
            error: "quote_not_open_for_changes",
            status: result.status,
          },
          { status: 409, headers: { "x-correlation-id": correlationId } },
        );
      case "expired":
        return NextResponse.json(
          { ok: false, error: "expired" },
          { status: 410, headers: { "x-correlation-id": correlationId } },
        );
      case "created":
        return NextResponse.json(result.body, {
          status: 201,
          headers: { "x-correlation-id": correlationId },
        });
    }
  } catch {
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
          surface: "/quote/[token]/changes",
          idempotencyKeyHash: keyHash,
          action: "quote.public_change_requested",
          entityType: "quote",
          entityId: quote.id,
          meta: sanitizeAuditMetadata({
            reason: "unexpected_mutation_failure",
            source: "customer",
            capabilityTokenStored: false,
          }),
        });
      } catch {
        // A failed request remains failed even if failure evidence is unavailable.
      }
    })();
    return NextResponse.json(
      { error: "change_request_failed" },
      { status: 500, headers: { "x-correlation-id": correlationId } },
    );
  }
}
