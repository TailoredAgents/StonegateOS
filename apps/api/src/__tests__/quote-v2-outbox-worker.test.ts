import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  chooseQuoteV2NotificationChannel,
  processQuoteV2WorkflowOutbox,
  quoteV2CombinedNotificationDedupeKey,
  quoteV2WorkflowRetry,
} from "@/lib/quote-v2-outbox-worker";

describe("quote V2 workflow outbox", () => {
  const eventId = "23d4c389-1403-41dd-be4f-0a6cc91a801b";
  const basePayload = {
    schemaVersion: 2 as const,
    eventId,
    quoteId: "f0da8764-f724-4a17-bfa2-70cad4a31af0",
    versionId: "6000319b-e380-4c14-bd60-7366f18c42e4",
    responseId: "32d748a3-c644-4ac5-9f26-b85213430bad",
    correlationId: "quote.request-123",
    occurredAt: "2026-08-30T12:00:00.000Z",
  };

  it("quarantines unknown and misbound events before database dispatch", async () => {
    const unknown = await processQuoteV2WorkflowOutbox({
      id: eventId,
      type: "quote.future_event.v9",
      payload: basePayload,
      attempts: 0,
    });
    expect(unknown.status).toBe("quarantined");
    if (unknown.status !== "quarantined") {
      throw new Error("Unknown quote event was not quarantined.");
    }
    expect(unknown.quarantineReason).toContain("Unknown quote event");
    await expect(
      processQuoteV2WorkflowOutbox({
        id: "e420e8c5-8f58-4688-93cc-d7352213152d",
        type: "quote.response_recorded.v2",
        payload: basePayload,
        attempts: 0,
      }),
    ).resolves.toEqual({
      status: "quarantined",
      error: "quote_v2_workflow_event_binding_invalid",
      quarantineReason: "quote_v2_workflow_event_binding_invalid",
    });
  });

  it("uses one valid preferred channel with deterministic fallback", () => {
    expect(
      chooseQuoteV2NotificationChannel({
        preferredContactMethod: "email",
        phoneE164: "+12025550123",
        email: "client@example.test",
      }),
    ).toBe("email");
    expect(
      chooseQuoteV2NotificationChannel({
        preferredContactMethod: "phone",
        phoneE164: "+12025550123",
        email: "client@example.test",
      }),
    ).toBe("sms");
    expect(
      chooseQuoteV2NotificationChannel({
        preferredContactMethod: "phone",
        phoneE164: "202-555-0123",
        email: "client@example.test",
      }),
    ).toBe("email");
    expect(
      chooseQuoteV2NotificationChannel({
        preferredContactMethod: null,
        phoneE164: null,
        email: null,
      }),
    ).toBeNull();
  });

  it("uses a stable logical key so accepted/booked replay queues once", () => {
    const input = {
      responseId: "32d748a3-c644-4ac5-9f26-b85213430bad",
      appointmentId: "cbf3c2f5-df9d-4c34-9e0e-6a431f4d2551",
      channel: "sms" as const,
    };
    const first = quoteV2CombinedNotificationDedupeKey(input);
    expect(quoteV2CombinedNotificationDedupeKey(input)).toBe(first);
    expect(first).toBe(
      "quote-v2.accepted-booked:32d748a3-c644-4ac5-9f26-b85213430bad:cbf3c2f5-df9d-4c34-9e0e-6a431f4d2551:sms",
    );
    expect(first.length).toBeLessThan(240);
  });

  it("keeps workflow retries inside the eight-attempt quote budget", () => {
    const now = new Date("2026-08-30T12:00:00.000Z");
    expect(quoteV2WorkflowRetry(0, "pending", now)).toEqual({
      status: "retry",
      error: "pending",
      maxAttempts: 8,
      nextAttemptAt: new Date("2026-08-30T12:00:05.000Z"),
    });
    expect(quoteV2WorkflowRetry(7, "pending", now).nextAttemptAt).toEqual(
      new Date("2026-08-30T12:10:40.000Z"),
    );
  });

  it("suppresses customer confirmation when contact lifecycle forbids outbound communication", () => {
    const worker = readFileSync(
      resolve(process.cwd(), "src/lib/quote-v2-outbox-worker.ts"),
      "utf8",
    );
    expect(worker).toContain(
      "booking.contactDeletedAt || booking.contactDoNotContact",
    );
    expect(worker).toContain("notificationReason: booking.contactDeletedAt");
    expect(worker).toContain('"do_not_contact"');
    expect(worker).toContain('error: "booking_notification_suppressed"');
  });
});
