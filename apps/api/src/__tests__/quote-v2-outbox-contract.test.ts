import {
  parseQuoteV2OutboxEvent,
  quoteV2RetryDelayMs,
  quoteV2ShouldQuarantine,
  QuoteV2OutboxContractError,
} from "@/lib/quote-v2-outbox-contract";

const payload = {
  schemaVersion: 2 as const,
  eventId: "23d4c389-1403-41dd-be4f-0a6cc91a801b",
  quoteId: "f0da8764-f724-4a17-bfa2-70cad4a31af0",
  versionId: "6000319b-e380-4c14-bd60-7366f18c42e4",
  correlationId: "quote.request-123",
  occurredAt: "2026-08-30T12:00:00.000Z",
};

const attemptId = "699ca1c3-ddca-4bab-a290-4cb4543a5e66";
const responseId = "32d748a3-c644-4ac5-9f26-b85213430bad";
const appointmentId = "cbf3c2f5-df9d-4c34-9e0e-6a431f4d2551";
const holdId = "b157bfee-5421-4800-b686-46d42af50975";
const paymentAttemptId = "61599a96-fd32-4dc5-97ac-060bc40a1992";
const paymentId = "6fe88507-5056-4845-a433-2a392586898d";

describe("quote V2 outbox contract", () => {
  it("accepts only versioned, identifier-only event payloads", () => {
    expect(
      parseQuoteV2OutboxEvent({
        type: "quote.send_requested.v2",
        payload: { ...payload, attemptId },
      }),
    ).toEqual({
      type: "quote.send_requested.v2",
      payload: { ...payload, attemptId },
    });

    expect(() =>
      parseQuoteV2OutboxEvent({
        type: "quote.send_requested.v2",
        payload: { ...payload, attemptId, schemaVersion: 1 },
      }),
    ).toThrow("schema version 2");
  });

  it("rejects PII and capability material from durable events", () => {
    for (const unsafe of [
      { recipientEmail: "alex@example.test" },
      { shareToken: "secret" },
      { nested: { customerName: "Alex" } },
      { publicUrl: "https://example.test/quote/token" },
    ]) {
      expect(() =>
        parseQuoteV2OutboxEvent({
          type: "quote.response_recorded.v2",
          payload: { ...payload, responseId, ...unsafe },
        }),
      ).toThrow("prohibited field");
    }
  });

  it("requires each event's durable subject bindings", () => {
    const valid = [
      ["quote.send_requested.v2", { attemptId }],
      ["quote.change_requested.v2", { responseId }],
      ["quote.response_recorded.v2", { responseId }],
      ["quote.deposit_checkout_requested.v2", { responseId, paymentAttemptId }],
      [
        "quote.accepted_and_booked.v2",
        { responseId, appointmentId, holdId, paymentAttemptId, paymentId },
      ],
    ] as const;
    for (const [type, bindings] of valid) {
      expect(() =>
        parseQuoteV2OutboxEvent({
          type,
          payload: { ...payload, ...bindings },
        }),
      ).not.toThrow();
      expect(() => parseQuoteV2OutboxEvent({ type, payload })).toThrow(
        "missing required",
      );
    }
  });

  it("requires complete booked-payment evidence when a deposit was used", () => {
    expect(() =>
      parseQuoteV2OutboxEvent({
        type: "quote.accepted_and_booked.v2",
        payload: {
          ...payload,
          responseId,
          appointmentId,
          holdId,
          paymentAttemptId,
        },
      }),
    ).toThrow("must be supplied together");
  });

  it("quarantines unknown quote events instead of silently skipping them", () => {
    let error: unknown;
    try {
      parseQuoteV2OutboxEvent({
        type: "quote.future_event.v9",
        payload,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(QuoteV2OutboxContractError);
    expect(
      quoteV2ShouldQuarantine({
        type: "quote.future_event.v9",
        attempt: 1,
        error,
      }),
    ).toBe(true);
  });

  it("uses bounded retries for transient quote handler failures", () => {
    expect(quoteV2RetryDelayMs(1)).toBe(5_000);
    expect(quoteV2RetryDelayMs(8)).toBe(640_000);
    expect(quoteV2RetryDelayMs(99)).toBe(640_000);
    expect(
      quoteV2ShouldQuarantine({
        type: "quote.send_requested.v2",
        attempt: 7,
        error: new Error("provider timeout"),
      }),
    ).toBe(false);
    expect(
      quoteV2ShouldQuarantine({
        type: "quote.send_requested.v2",
        attempt: 8,
        error: new Error("provider timeout"),
      }),
    ).toBe(true);
  });
});
