jest.mock("nanoid", () => ({ nanoid: jest.fn(() => "test-share-token") }));
import { createHash, randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { eq, sql } from "drizzle-orm";
import {
  closeDbForTests,
  getDb,
  contacts,
  conversationMessages,
  externalMessageDispatches,
  properties,
  publicQuoteMutationReceipts,
  quotes,
  outboxEvents,
  teamMutationIdempotency,
  teamMembers,
  teamRoles,
  teamSessions,
} from "@/db";
import type { DatabaseClient } from "@/db";
import {
  processOutboxBatch,
  type OutboxBatchStats,
} from "@/lib/outbox-processor";
import * as notifications from "@/lib/notifications";
import type { QuoteNotificationPayload } from "@/lib/notifications";
import { queueSystemOutboundMessage } from "@/lib/system-outbound";
import {
  claimMessageDispatch,
  ensureMessageDispatchRequested,
} from "@/lib/external-message-dispatch";
import { POST as createQuote } from "../../app/api/quotes/route";
import { PATCH as updateQuote } from "../../app/api/quotes/[id]/route";
import { POST as sendQuote } from "../../app/api/quotes/[id]/send/route";
import {
  GET as publicQuote,
  POST as publicDecision,
} from "../../app/api/public/quotes/[token]/route";

const hasDatabase = Boolean(process.env["DATABASE_URL"]);
const describeOrSkip = hasDatabase ? describe : describe.skip;

function restoreEnvironmentValue(
  name: "ADMIN_API_KEY" | "QUOTE_ALERT_EMAIL" | "SITE_URL",
  value: string | undefined,
): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function isOutboxBatchStats(value: unknown): value is OutboxBatchStats {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  const total = candidate["total"];
  const processed = candidate["processed"];
  const skipped = candidate["skipped"];
  const errors = candidate["errors"];
  return (
    typeof total === "number" &&
    typeof processed === "number" &&
    typeof skipped === "number" &&
    typeof errors === "number"
  );
}

async function runOutboxBatch(limit: number): Promise<OutboxBatchStats> {
  const stats: unknown = await processOutboxBatch({ limit });
  if (!isOutboxBatchStats(stats)) {
    throw new Error("processOutboxBatch returned invalid stats");
  }
  return stats;
}

function isQuoteSentNotificationPayload(
  value: unknown,
): value is Pick<QuoteNotificationPayload, "quoteId" | "services"> {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  const quoteId = candidate["quoteId"];
  const services = candidate["services"];

  return (
    typeof quoteId === "string" &&
    Array.isArray(services) &&
    services.every((service) => typeof service === "string")
  );
}

describeOrSkip("Quote lifecycle integration", () => {
  const ADMIN_KEY = "test-admin-key";
  let db: DatabaseClient;
  let contactId: string;
  let propertyId: string;
  let createdQuoteId: string | null = null;
  let authRoleId: string | null = null;
  let authMemberId: string | null = null;
  const sessionToken = `quote-lifecycle-${randomUUID()}`;

  const originalAdminKey = process.env["ADMIN_API_KEY"];
  const originalAlertEmail = process.env["QUOTE_ALERT_EMAIL"];
  const originalSiteUrl = process.env["SITE_URL"];

  beforeAll(async () => {
    process.env["ADMIN_API_KEY"] = ADMIN_KEY;
    process.env["QUOTE_ALERT_EMAIL"] = "";
    process.env["SITE_URL"] = "https://example.com";
    db = getDb();

    const [authRole] = await db
      .insert(teamRoles)
      .values({
        name: "Quote lifecycle test",
        slug: `quote-lifecycle-${randomUUID()}`,
        permissions: ["quotes.write", "quotes.update", "quotes.send"],
      })
      .returning({ id: teamRoles.id });
    if (!authRole) {
      throw new Error("Failed to create quote lifecycle auth role");
    }
    authRoleId = authRole.id;

    const [authMember] = await db
      .insert(teamMembers)
      .values({
        name: "Quote lifecycle test",
        email: `quote-lifecycle-auth-${randomUUID()}@example.com`,
        roleId: authRole.id,
        active: true,
      })
      .returning({ id: teamMembers.id });
    if (!authMember) {
      throw new Error("Failed to create quote lifecycle auth member");
    }
    authMemberId = authMember.id;

    await db.insert(teamSessions).values({
      teamMemberId: authMember.id,
      sessionHash: createHash("sha256")
        .update(sessionToken)
        .digest("base64url"),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const [contact] = await db
      .insert(contacts)
      .values({
        firstName: "Integration",
        lastName: "Tester",
        email: `integration-${randomUUID()}@example.com`,
        phone: "404-555-0101",
      })
      .returning({ id: contacts.id });

    if (!contact) {
      throw new Error("Failed to create quote lifecycle contact");
    }
    contactId = contact.id;

    const [property] = await db
      .insert(properties)
      .values({
        contactId,
        addressLine1: "123 Integration Ave",
        city: "Testville",
        state: "GA",
        postalCode: "30301",
      })
      .returning({ id: properties.id });

    if (!property) {
      throw new Error("Failed to create quote lifecycle property");
    }
    propertyId = property.id;
  });

  afterAll(async () => {
    if (!hasDatabase) {
      return;
    }
    try {
      if (createdQuoteId) {
        await db
          .delete(publicQuoteMutationReceipts)
          .where(eq(publicQuoteMutationReceipts.quoteId, createdQuoteId));
        await db
          .delete(outboxEvents)
          .where(sql`payload->>'quoteId' = ${createdQuoteId}`);
        await db.delete(quotes).where(eq(quotes.id, createdQuoteId));
      }

      if (propertyId) {
        await db.delete(properties).where(eq(properties.id, propertyId));
      }
      if (contactId) {
        const archivedAt = new Date();
        await db
          .update(contacts)
          .set({
            email: null,
            phone: null,
            phoneE164: null,
            deletedAt: archivedAt,
            deletedBy: null,
            purgeEligibleAt: new Date(
              archivedAt.getTime() + 30 * 24 * 60 * 60 * 1_000,
            ),
            updatedAt: archivedAt,
          })
          .where(eq(contacts.id, contactId));
      }
      if (authMemberId) {
        await db
          .delete(teamSessions)
          .where(eq(teamSessions.teamMemberId, authMemberId));
        await db.delete(teamMembers).where(eq(teamMembers.id, authMemberId));
      }
      if (authRoleId) {
        await db.delete(teamRoles).where(eq(teamRoles.id, authRoleId));
      }
    } finally {
      restoreEnvironmentValue("ADMIN_API_KEY", originalAdminKey);
      restoreEnvironmentValue("QUOTE_ALERT_EMAIL", originalAlertEmail);
      restoreEnvironmentValue("SITE_URL", originalSiteUrl);
      await closeDbForTests();
    }
  });

  it("creates, sends, and finalizes a quote while processing outbox notifications", async () => {
    const body = {
      confirmation: "create_quote",
      contactId,
      propertyId,
      zoneId: "zone-core",
      selectedServices: ["furniture"],
      selectedAddOns: [],
      applyBundles: true,
      jobDurationMinutes: 180,
      clientScope: "Remove the quoted furniture and sweep the pickup area.",
    };

    const headers = new Headers({
      "x-api-key": ADMIN_KEY,
      authorization: `Bearer ${sessionToken}`,
      host: "api.test",
      origin: "https://api.test",
      "x-forwarded-proto": "https",
      "idempotency-key": `quote-create:${randomUUID()}`,
    });
    const createRequest = {
      json: () => Promise.resolve(body),
      headers,
    } as unknown as NextRequest;

    const createResponse = await createQuote(createRequest);
    expect(createResponse.ok).toBe(true);
    const created = (await createResponse.json()) as unknown as {
      data?: { quote?: { id?: string } };
      quote?: { id?: string };
    };
    const quoteId = created.data?.quote?.id ?? created.quote?.id;
    if (!quoteId) throw new Error("Create quote response omitted its ID");
    createdQuoteId = quoteId;

    headers.set("idempotency-key", `quote-update:${randomUUID()}`);
    headers.set("if-match", "1");
    const updateRequest = {
      json: () =>
        Promise.resolve({
          confirmation: "update_quote",
          zoneId: "zone-core",
          selectedServices: ["furniture"],
          selectedAddOns: [],
          applyBundles: true,
          jobDurationMinutes: 240,
          clientScope:
            "Remove the updated furniture scope and sweep the pickup area.",
        }),
      headers,
    } as unknown as NextRequest;
    const updateResponse = await updateQuote(updateRequest, {
      params: Promise.resolve({ id: quoteId }),
    });
    expect(updateResponse.ok).toBe(true);
    const updatedBody = (await updateResponse.json()) as unknown as {
      data?: { quote?: { revision?: number } };
    };
    expect(updatedBody.data?.quote?.revision).toBe(2);

    headers.set("idempotency-key", `quote-send:${randomUUID()}`);
    headers.set("if-match", "2");
    const sendRequest = {
      json: () => Promise.resolve({ confirmation: "send_quote" }),
      headers,
    } as unknown as NextRequest;

    const sendResponse = await sendQuote(sendRequest, {
      params: Promise.resolve({ id: quoteId }),
    });
    expect(sendResponse.ok).toBe(true);
    const sentBody = (await sendResponse.json()) as unknown as {
      data?: {
        shareUrl?: string | null;
        revision?: number;
        sendAttemptId?: string;
      };
    };
    const shareUrl = sentBody.data?.shareUrl;
    if (!shareUrl) throw new Error("Send quote response omitted its share URL");
    const shareToken = new URL(shareUrl).pathname
      .split("/")
      .filter(Boolean)
      .at(-1);
    if (!shareToken) throw new Error("Send quote response omitted its token");
    expect(sentBody.data?.revision).toBe(3);
    expect(sentBody.data?.sendAttemptId).toBe("revision-3");

    const replayResponse = await sendQuote(sendRequest, {
      params: Promise.resolve({ id: quoteId }),
    });
    expect(replayResponse.ok).toBe(true);
    expect(replayResponse.headers.get("idempotency-replayed")).toBe("true");

    headers.set("idempotency-key", `quote-resend:${randomUUID()}`);
    headers.set("if-match", "3");
    const resendResponse = await sendQuote(sendRequest, {
      params: Promise.resolve({ id: quoteId }),
    });
    expect(resendResponse.ok).toBe(true);
    const resentBody = (await resendResponse.json()) as unknown as {
      data?: { revision?: number; sendAttemptId?: string };
    };
    expect(resentBody.data).toMatchObject({
      revision: 4,
      sendAttemptId: "revision-4",
    });

    const sendEvents = await db
      .select({ id: outboxEvents.id, payload: outboxEvents.payload })
      .from(outboxEvents)
      .where(
        sql`${outboxEvents.type} = 'quote.sent' AND payload->>'quoteId' = ${quoteId}`,
      );
    expect(sendEvents).toHaveLength(2);
    expect(JSON.stringify(sendEvents)).not.toContain(shareToken);
    expect(
      sendEvents.map((event) =>
        typeof event.payload === "object" && event.payload
          ? event.payload["sendAttemptId"]
          : null,
      ),
    ).toEqual(expect.arrayContaining(["revision-3", "revision-4"]));

    const quoteRecord = await db
      .select({
        id: quotes.id,
        status: quotes.status,
        shareToken: quotes.shareToken,
        sentAt: quotes.sentAt,
        expiresAt: quotes.expiresAt,
        viewedAt: quotes.viewedAt,
        lastViewedAt: quotes.lastViewedAt,
        viewCount: quotes.viewCount,
        jobDurationMinutes: quotes.jobDurationMinutes,
        clientScope: quotes.clientScope,
        revision: quotes.revision,
      })
      .from(quotes)
      .where(eq(quotes.id, quoteId))
      .limit(1);

    expect(quoteRecord[0]?.status).toBe("sent");
    expect(quoteRecord[0]?.shareToken).toBeTruthy();
    expect(quoteRecord[0]?.sentAt).not.toBeNull();
    expect(quoteRecord[0]?.expiresAt).not.toBeNull();
    expect(quoteRecord[0]?.jobDurationMinutes).toBe(240);
    expect(quoteRecord[0]?.clientScope).toContain("updated furniture");
    expect(quoteRecord[0]?.revision).toBe(4);
    if (!quoteRecord[0]?.sentAt || !quoteRecord[0]?.expiresAt) {
      throw new Error("Expected sent and expiry timestamps");
    }
    const validDays = Math.round(
      (quoteRecord[0].expiresAt.getTime() - quoteRecord[0].sentAt.getTime()) /
        (24 * 60 * 60 * 1000),
    );
    expect(validDays).toBe(7);

    const previewRequest = {
      nextUrl: new URL(
        `https://example.com/api/public/quotes/${shareToken}?preview=1`,
      ),
    } as unknown as NextRequest;
    const previewResponse = await publicQuote(previewRequest, {
      params: Promise.resolve({ token: shareToken }),
    });
    expect(previewResponse.ok).toBe(true);

    const afterPreview = await db
      .select({ viewCount: quotes.viewCount, viewedAt: quotes.viewedAt })
      .from(quotes)
      .where(eq(quotes.id, quoteId))
      .limit(1);
    expect(afterPreview[0]?.viewCount).toBe(0);
    expect(afterPreview[0]?.viewedAt).toBeNull();

    const viewRequest = {
      nextUrl: new URL(`https://example.com/api/public/quotes/${shareToken}`),
    } as unknown as NextRequest;
    const viewResponse = await publicQuote(viewRequest, {
      params: Promise.resolve({ token: shareToken }),
    });
    expect(viewResponse.ok).toBe(true);

    const afterView = await db
      .select({
        viewCount: quotes.viewCount,
        viewedAt: quotes.viewedAt,
        lastViewedAt: quotes.lastViewedAt,
      })
      .from(quotes)
      .where(eq(quotes.id, quoteId))
      .limit(1);
    expect(afterView[0]?.viewCount).toBe(1);
    expect(afterView[0]?.viewedAt).not.toBeNull();
    expect(afterView[0]?.lastViewedAt).not.toBeNull();

    const sentSpy = jest
      .spyOn(notifications, "sendQuoteSentNotification")
      .mockResolvedValue(undefined);
    const decisionSpy = jest
      .spyOn(notifications, "sendQuoteDecisionNotification")
      .mockResolvedValue(undefined);

    const statsAfterSend = await runOutboxBatch(5);
    expect(statsAfterSend.processed).toBeGreaterThanOrEqual(1);
    expect(sentSpy).toHaveBeenCalled();
    const sentPayload: unknown = sentSpy.mock.calls.at(-1)?.[0];
    if (!isQuoteSentNotificationPayload(sentPayload)) {
      throw new Error("Expected quote sent notification payload");
    }
    expect(sentPayload.quoteId).toBe(quoteId);
    expect(sentPayload.services).toEqual(
      expect.arrayContaining<string>(["furniture"]),
    );
    const publicDecisionKey = `quote-public-decision:${randomUUID()}`;
    const decisionRequest = {
      json: () => Promise.resolve({ decision: "accepted" }),
      headers: new Headers({ "idempotency-key": publicDecisionKey }),
    } as unknown as NextRequest;

    const decisionResponse = await publicDecision(decisionRequest, {
      params: Promise.resolve({ token: shareToken }),
    });
    expect(decisionResponse.ok).toBe(true);

    const decisionReplayResponse = await publicDecision(decisionRequest, {
      params: Promise.resolve({ token: shareToken }),
    });
    expect(decisionReplayResponse.ok).toBe(true);
    expect(decisionReplayResponse.headers.get("idempotency-replayed")).toBe(
      "true",
    );

    const changedReplayResponse = await publicDecision(
      {
        json: () => Promise.resolve({ decision: "declined" }),
        headers: new Headers({ "idempotency-key": publicDecisionKey }),
      } as unknown as NextRequest,
      { params: Promise.resolve({ token: shareToken }) },
    );
    expect(changedReplayResponse.status).toBe(409);
    await expect(changedReplayResponse.json()).resolves.toMatchObject({
      error: "idempotency_key_reused",
    });

    const repeatDecisionResponse = await publicDecision(
      {
        json: () => Promise.resolve({ decision: "declined" }),
        headers: new Headers({
          "idempotency-key": `quote-public-decision:${randomUUID()}`,
        }),
      } as unknown as NextRequest,
      { params: Promise.resolve({ token: shareToken }) },
    );
    expect(repeatDecisionResponse.status).toBe(409);
    await expect(repeatDecisionResponse.json()).resolves.toMatchObject({
      error: "already_decided",
      status: "accepted",
    });

    const decisionEvents = await db
      .select({ id: outboxEvents.id })
      .from(outboxEvents)
      .where(
        sql`${outboxEvents.type} = 'quote.decision' AND payload->>'quoteId' = ${quoteId}`,
      );
    expect(decisionEvents).toHaveLength(1);

    const publicReceipts = await db
      .select({
        keyHash: publicQuoteMutationReceipts.keyHash,
        requestHash: publicQuoteMutationReceipts.requestHash,
        responseBody: publicQuoteMutationReceipts.responseBody,
      })
      .from(publicQuoteMutationReceipts)
      .where(eq(publicQuoteMutationReceipts.quoteId, quoteId));
    expect(publicReceipts).toHaveLength(1);
    expect(publicReceipts[0]?.keyHash).toHaveLength(64);
    expect(publicReceipts[0]?.requestHash).toHaveLength(64);
    expect(JSON.stringify(publicReceipts)).not.toContain(shareToken);

    const leakedTeamReceipts = await db
      .select({ responseBody: teamMutationIdempotency.responseBody })
      .from(teamMutationIdempotency)
      .where(
        sql`${teamMutationIdempotency.action} IN ('quote.created', 'quote.updated', 'quote.sent') AND ${teamMutationIdempotency.responseBody}::text LIKE ${`%${shareToken}%`}`,
      );
    expect(leakedTeamReceipts).toHaveLength(0);

    const statsAfterDecision = await runOutboxBatch(5);
    expect(statsAfterDecision.processed).toBeGreaterThanOrEqual(1);
    expect(decisionSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        quoteId,
        decision: "accepted",
      }),
    );

    const finalQuote = await db
      .select({
        status: quotes.status,
        decisionAt: quotes.decisionAt,
      })
      .from(quotes)
      .where(eq(quotes.id, quoteId))
      .limit(1);

    expect(finalQuote[0]?.status).toBe("accepted");
    expect(finalQuote[0]?.decisionAt).not.toBeNull();

    sentSpy.mockRestore();
    decisionSpy.mockRestore();
  });

  it("quarantines already-queued quote messages when the contact becomes DNC before dispatch", async () => {
    const attemptId = `revision-dnc-${randomUUID()}`;
    const smsMessageId = await queueSystemOutboundMessage({
      contactId,
      channel: "sms",
      toAddress: "+14045550101",
      body: "Quote delivery DNC regression",
      metadata: {
        kind: "quote.sent",
        quoteId: createdQuoteId,
        sendAttemptId: attemptId,
        autoFirstTouch: true,
      },
      dedupeKey: `quote.sent:${createdQuoteId}:${attemptId}:sms`,
    });
    const emailMessageId = await queueSystemOutboundMessage({
      contactId,
      channel: "email",
      toAddress: `integration-dnc-${randomUUID()}@example.com`,
      subject: "Quote delivery DNC regression",
      body: "Quote delivery DNC regression",
      metadata: {
        kind: "quote.sent",
        quoteId: createdQuoteId,
        sendAttemptId: attemptId,
        autoFirstTouch: true,
      },
      dedupeKey: `quote.sent:${createdQuoteId}:${attemptId}:email`,
    });
    if (!smsMessageId || !emailMessageId) {
      throw new Error("Failed to queue DNC regression messages");
    }
    try {
      await db
        .update(contacts)
        .set({ doNotContact: true, doNotContactAt: new Date() })
        .where(eq(contacts.id, contactId));

      await runOutboxBatch(25);

      const events = await db
        .select({
          payload: outboxEvents.payload,
          processedAt: outboxEvents.processedAt,
          quarantineReason: outboxEvents.quarantineReason,
        })
        .from(outboxEvents)
        .where(
          sql`${outboxEvents.type} = 'message.send' AND payload->>'messageId' IN (${smsMessageId}, ${emailMessageId})`,
        );
      expect(events).toHaveLength(2);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            processedAt: null,
            quarantineReason: "contact_dnc_before_message_dispatch",
          }),
          expect.objectContaining({
            processedAt: null,
            quarantineReason: "contact_dnc_before_message_dispatch",
          }),
        ]),
      );

      const messages = await db
        .select({
          id: conversationMessages.id,
          status: conversationMessages.deliveryStatus,
        })
        .from(conversationMessages)
        .where(
          sql`${conversationMessages.id} IN (${smsMessageId}, ${emailMessageId})`,
        );
      expect(messages).toHaveLength(2);
      expect(messages.every((message) => message.status === "failed")).toBe(
        true,
      );

      const dispatches = await db
        .select({ id: externalMessageDispatches.id })
        .from(externalMessageDispatches)
        .where(
          sql`${externalMessageDispatches.messageId} IN (${smsMessageId}, ${emailMessageId})`,
        );
      expect(dispatches).toHaveLength(0);
    } finally {
      await db
        .update(contacts)
        .set({ doNotContact: false, doNotContactAt: null })
        .where(eq(contacts.id, contactId));
      await db
        .delete(outboxEvents)
        .where(
          sql`${outboxEvents.type} = 'message.send' AND payload->>'messageId' IN (${smsMessageId}, ${emailMessageId})`,
        );
      await db
        .delete(conversationMessages)
        .where(
          sql`${conversationMessages.id} IN (${smsMessageId}, ${emailMessageId})`,
        );
    }
  });

  it("rechecks DNC after the durable request and before the provider claim", async () => {
    const messageId = await queueSystemOutboundMessage({
      contactId,
      channel: "sms",
      toAddress: "+14045550101",
      body: "Quote provider-boundary DNC regression",
      metadata: {
        kind: "quote.sent",
        quoteId: createdQuoteId,
        sendAttemptId: `revision-provider-dnc-${randomUUID()}`,
      },
      dedupeKey: `quote.provider-dnc:${createdQuoteId}:${randomUUID()}`,
    });
    if (!messageId)
      throw new Error("Failed to queue provider-boundary message");

    const [event] = await db
      .select({ id: outboxEvents.id })
      .from(outboxEvents)
      .where(
        sql`${outboxEvents.type} = 'message.send' AND payload->>'messageId' = ${messageId}`,
      )
      .limit(1);
    if (!event) throw new Error("Message outbox event was not created");

    try {
      const requested = await ensureMessageDispatchRequested({
        outboxEventId: event.id,
        messageId,
        contactId,
        channel: "sms",
        attemptNumber: 1,
      });
      expect(requested.kind).toBe("ready");
      if (requested.kind !== "ready") return;

      await db
        .update(contacts)
        .set({ doNotContact: true, doNotContactAt: new Date() })
        .where(eq(contacts.id, contactId));

      const claimed = await claimMessageDispatch({
        dispatchId: requested.dispatch.id,
      });
      expect(claimed).toMatchObject({
        kind: "settled",
        state: "failed",
        retryable: false,
        error: "contact_dnc_before_provider_dispatch",
        outboxFinalized: true,
      });

      const [dispatch] = await db
        .select({ state: externalMessageDispatches.state })
        .from(externalMessageDispatches)
        .where(eq(externalMessageDispatches.id, requested.dispatch.id));
      expect(dispatch?.state).toBe("failed");
    } finally {
      await db
        .update(contacts)
        .set({ doNotContact: false, doNotContactAt: null })
        .where(eq(contacts.id, contactId));
      await db
        .delete(externalMessageDispatches)
        .where(eq(externalMessageDispatches.messageId, messageId));
      await db.delete(outboxEvents).where(eq(outboxEvents.id, event.id));
      await db
        .delete(conversationMessages)
        .where(eq(conversationMessages.id, messageId));
    }
  });
});
