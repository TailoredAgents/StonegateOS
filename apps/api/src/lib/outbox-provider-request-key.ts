import { createHash } from "node:crypto";

/**
 * Stable, bounded duplicate evidence for a single legacy outbox attempt.
 * SMTP does not promise idempotency or exactly-once delivery.
 */
export function buildLegacyOutboxProviderRequestKey(input: {
  outboxEventId: string;
  messageId: string;
  channel: string;
  attemptNumber: number;
}): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        input.outboxEventId,
        input.messageId,
        input.channel,
        input.attemptNumber,
      ]),
    )
    .digest("hex");
  return `message-send:${digest}`;
}
