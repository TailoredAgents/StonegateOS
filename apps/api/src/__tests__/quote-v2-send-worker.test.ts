import {
  classifyQuoteV2DeliveryResult,
  resolveQuoteV2SendAttemptStatus,
} from "@/lib/quote-v2-send-worker";

describe("quote V2 send worker outcomes", () => {
  it("records provider acceptance as sent without claiming mailbox delivery", () => {
    expect(
      classifyQuoteV2DeliveryResult({
        attempt: 1,
        result: {
          ok: true,
          provider: "smtp",
          providerMessageId: "provider-id",
          deliveryCertainty: "accepted",
        },
      }),
    ).toBe("dispatched");
  });

  it("retries known non-delivery but never repeats an ambiguous send", () => {
    expect(
      classifyQuoteV2DeliveryResult({
        attempt: 1,
        result: {
          ok: false,
          provider: "twilio",
          deliveryCertainty: "not_sent",
          detail: "sms_timeout",
        },
      }),
    ).toBe("queued");
    expect(
      classifyQuoteV2DeliveryResult({
        attempt: 1,
        result: {
          ok: false,
          provider: "smtp",
          deliveryCertainty: "uncertain",
          detail: "email_delivery_ambiguous",
        },
      }),
    ).toBe("reconciliation_required");
  });

  it("terminates permanent failures and the bounded retry budget", () => {
    expect(
      classifyQuoteV2DeliveryResult({
        attempt: 1,
        result: {
          ok: false,
          provider: "smtp",
          deliveryCertainty: "not_sent",
          detail: "email_rejected:permanent",
        },
      }),
    ).toBe("failed");
    expect(
      classifyQuoteV2DeliveryResult({
        attempt: 8,
        result: {
          ok: false,
          provider: "twilio",
          deliveryCertainty: "not_sent",
          detail: "sms_timeout",
        },
      }),
    ).toBe("failed");
  });

  it("keeps a mixed reconciliation and queued attempt active until safe retries finish", () => {
    expect(
      resolveQuoteV2SendAttemptStatus(["reconciliation_required", "queued"]),
    ).toBe("processing");
    expect(
      resolveQuoteV2SendAttemptStatus(["reconciliation_required", "failed"]),
    ).toBe("reconciliation_required");
  });
});
