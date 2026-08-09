import { resolveUsableQuoteDeliveryChannels } from "@/lib/contact-outbound-safety";
import {
  buildQuoteSendAttemptId,
  parseQuoteDecisionOutboxPayload,
  quoteSentMessageDedupeKey,
  resolveQuoteSendAttemptId,
  shouldNotifyCustomerForQuoteDecision,
} from "@/lib/quote-outbox-contract";

describe("quote outbound contracts", () => {
  it("keeps intentional sends distinct while exact attempt reuse is stable", () => {
    const first = buildQuoteSendAttemptId(4);
    const resend = buildQuoteSendAttemptId(5);

    expect(first).toBe("revision-4");
    expect(resend).toBe("revision-5");
    expect(quoteSentMessageDedupeKey("quote-1", first, "sms")).toBe(
      "quote.sent:quote-1:revision-4:sms",
    );
    expect(quoteSentMessageDedupeKey("quote-1", first, "email")).toBe(
      "quote.sent:quote-1:revision-4:email",
    );
    expect(quoteSentMessageDedupeKey("quote-1", resend, "sms")).not.toBe(
      quoteSentMessageDedupeKey("quote-1", first, "sms"),
    );
    expect(() => buildQuoteSendAttemptId(0)).toThrow(
      "invalid_quote_send_revision",
    );
  });

  it("gives legacy queued events a distinct non-secret attempt identity", () => {
    expect(resolveQuoteSendAttemptId(undefined, "event-a")).toBe(
      "legacy-outbox-event-a",
    );
    expect(resolveQuoteSendAttemptId(undefined, "event-b")).toBe(
      "legacy-outbox-event-b",
    );
    expect(resolveQuoteSendAttemptId("revision-7", "event-a")).toBe(
      "revision-7",
    );
  });

  it("accepts only explicit customer or team decision sources", () => {
    expect(
      parseQuoteDecisionOutboxPayload({
        quoteId: "quote-1",
        decision: "accepted",
        source: "customer",
        notes: null,
      }),
    ).toEqual({
      quoteId: "quote-1",
      decision: "accepted",
      source: "customer",
      notes: null,
    });
    expect(
      parseQuoteDecisionOutboxPayload({
        quoteId: "quote-2",
        decision: "declined",
        source: "team",
      }),
    ).toEqual({
      quoteId: "quote-2",
      decision: "declined",
      source: "team",
      notes: null,
    });

    for (const source of [undefined, null, "admin", "team-console", ""]) {
      expect(
        parseQuoteDecisionOutboxPayload({
          quoteId: "quote-3",
          decision: "accepted",
          source,
        }),
      ).toBeNull();
    }
    expect(shouldNotifyCustomerForQuoteDecision("customer")).toBe(true);
    expect(shouldNotifyCustomerForQuoteDecision("team")).toBe(false);
  });

  it("returns only usable destinations and never queues a malformed secondary channel", () => {
    expect(
      resolveUsableQuoteDeliveryChannels({
        email: " CUSTOMER@Example.com ",
        phone: "not-a-number",
      }),
    ).toEqual({ email: "customer@example.com", phone: null });
    expect(
      resolveUsableQuoteDeliveryChannels({
        email: "not-an-email",
        phone: "404-555-0101",
        phoneE164: "+1123",
      }),
    ).toEqual({ email: null, phone: "+14045550101" });
    expect(
      resolveUsableQuoteDeliveryChannels({
        email: "invalid",
        phone: "123",
      }),
    ).toEqual({ email: null, phone: null });
  });
});
