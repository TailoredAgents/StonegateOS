export const INBOX_QUEUE_IDS = [
  "needs_reply",
  "waiting",
  "failed",
  "all",
] as const;

export type InboxQueue = (typeof INBOX_QUEUE_IDS)[number];

export function parseInboxQueue(value: string | null): InboxQueue | null {
  return value && (INBOX_QUEUE_IDS as readonly string[]).includes(value)
    ? (value as InboxQueue)
    : null;
}
