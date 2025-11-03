jest.mock("nanoid", () => ({ nanoid: jest.fn(() => "test-share-token") }));
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { eq, sql } from "drizzle-orm";
import { getDb, contacts, properties, quotes, outboxEvents } from "@/db";
import type { DatabaseClient } from "@/db";
import { processOutboxBatch, type OutboxBatchStats } from "@/lib/outbox-processor";
import * as notifications from "@/lib/notifications";
import type { QuoteNotificationPayload } from "@/lib/notifications";
import { POST as createQuote } from "../../app/api/quotes/route";
import { POST as sendQuote } from "../../app/api/quotes/[id]/send/route";
import { POST as publicDecision } from "../../app/api/public/quotes/[token]/route";

const hasDatabase = Boolean(process.env["DATABASE_URL"]);
const describeOrSkip = hasDatabase ? describe : describe.skip;

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
  value: unknown
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

  const originalAdminKey = process.env["ADMIN_API_KEY"];
  const originalAlertEmail = process.env["QUOTE_ALERT_EMAIL"];

  beforeAll(async () => {
    process.env["ADMIN_API_KEY"] = ADMIN_KEY;
    process.env["QUOTE_ALERT_EMAIL"] = "";
    db = getDb();

    const [contact] = await db
      .insert(contacts)
      .values({
        firstName: "Integration",
        lastName: "Tester",
        email: `integration-${randomUUID()}@example.com`,
        phone: "404-555-0101"
      })
      .returning({ id: contacts.id });

    contactId = contact.id;

    const [property] = await db
      .insert(properties)
      .values({
        contactId,
        addressLine1: "123 Integration Ave",
        city: "Testville",
        state: "GA",
        postalCode: "30301"
      })
      .returning({ id: properties.id });

    propertyId = property.id;
  });

  afterAll(async () => {
    if (!hasDatabase) {
      return;
    }

    if (createdQuoteId) {
      await db.delete(outboxEvents).where(sql`payload->>'quoteId' = ${createdQuoteId}`);
      await db.delete(quotes).where(eq(quotes.id, createdQuoteId));
    }

    await db.delete(properties).where(eq(properties.id, propertyId));
    await db.delete(contacts).where(eq(contacts.id, contactId));

    process.env["ADMIN_API_KEY"] = originalAdminKey;
    process.env["QUOTE_ALERT_EMAIL"] = originalAlertEmail;
  });

  it("creates, sends, and finalizes a quote while processing outbox notifications", async () => {
    const body = {
      contactId,
      propertyId,
      zoneId: "zone-core",
      selectedServices: ["furniture"],
      selectedAddOns: [],
      applyBundles: true
    };

    const headers = new Headers({ "x-api-key": ADMIN_KEY });
    const createRequest = {
      json: () => Promise.resolve(body),
      headers
    } as unknown as NextRequest;

    const createResponse = await createQuote(createRequest);
    expect(createResponse.ok).toBe(true);
    const created = (await createResponse.json()) as unknown as { quote: { id: string } };
    const quoteId = created.quote.id;
    createdQuoteId = quoteId;

    const sendRequest = {
      json: () => Promise.resolve({}),
      headers
    } as unknown as NextRequest;

    const sendResponse = await sendQuote(sendRequest, {
      params: Promise.resolve({ id: quoteId })
    });
    expect(sendResponse.ok).toBe(true);
    const sentBody = (await sendResponse.json()) as unknown as { shareToken: string | null };
    expect(sentBody.shareToken).toBeTruthy();

    const quoteRecord = await db
      .select({
        id: quotes.id,
        status: quotes.status,
        shareToken: quotes.shareToken,
        sentAt: quotes.sentAt
      })
      .from(quotes)
      .where(eq(quotes.id, quoteId))
      .limit(1);

    expect(quoteRecord[0]?.status).toBe("sent");
    expect(quoteRecord[0]?.shareToken).toBeTruthy();
    expect(quoteRecord[0]?.sentAt).not.toBeNull();

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
    expect(sentPayload.services).toEqual(expect.arrayContaining<string>(["furniture"]));
    const decisionRequest = {
      json: () => Promise.resolve({ decision: "accepted" }),
      headers: new Headers()
    } as unknown as NextRequest;

    const decisionResponse = await publicDecision(decisionRequest, {
      params: Promise.resolve({ token: sentBody.shareToken! })
    });
    expect(decisionResponse.ok).toBe(true);


    const statsAfterDecision = await runOutboxBatch(5);
    expect(statsAfterDecision.processed).toBeGreaterThanOrEqual(1);
    expect(decisionSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        quoteId,
        decision: "accepted"
      })
    );

    const finalQuote = await db
      .select({
        status: quotes.status,
        decisionAt: quotes.decisionAt
      })
      .from(quotes)
      .where(eq(quotes.id, quoteId))
      .limit(1);

    expect(finalQuote[0]?.status).toBe("accepted");
    expect(finalQuote[0]?.decisionAt).not.toBeNull();

    sentSpy.mockRestore();
    decisionSpy.mockRestore();
  });
});
