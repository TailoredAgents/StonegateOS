import { buildLegacyOutboxProviderRequestKey } from "@/lib/outbox-provider-request-key";

describe("legacy outbox provider request keys", () => {
  const input = {
    outboxEventId: "event-private-identifier",
    messageId: "message-private-identifier",
    channel: "email",
    attemptNumber: 2,
  };

  it("is stable, bounded, and does not expose source identifiers", () => {
    const key = buildLegacyOutboxProviderRequestKey(input);
    expect(buildLegacyOutboxProviderRequestKey(input)).toBe(key);
    expect(key).toMatch(/^message-send:[a-f0-9]{64}$/u);
    expect(key.length).toBeLessThanOrEqual(240);
    expect(key).not.toContain(input.outboxEventId);
    expect(key).not.toContain(input.messageId);
  });

  it("changes for a deliberate new attempt or another source operation", () => {
    for (const changed of [
      { ...input, attemptNumber: 3 },
      { ...input, outboxEventId: "another-event" },
      { ...input, messageId: "another-message" },
      { ...input, channel: "sms" },
    ]) {
      expect(buildLegacyOutboxProviderRequestKey(changed)).not.toBe(
        buildLegacyOutboxProviderRequestKey(input),
      );
    }
  });
});
