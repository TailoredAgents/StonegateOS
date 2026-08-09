export type InboxPagination = {
  limit: number;
  offset: number;
  total: number;
  nextOffset: number | null;
};

export type InboxQueue = "needs_reply" | "waiting" | "failed" | "all";

export type InboxQueueCounts = {
  needsReply: number;
  waiting: number;
  failed: number;
  all: number;
};

export function parseInboxQueue(
  value: string | null | undefined,
): InboxQueue | null {
  return value === "needs_reply" ||
    value === "waiting" ||
    value === "failed" ||
    value === "all"
    ? value
    : null;
}

export function isInboxQueueCounts(value: unknown): value is InboxQueueCounts {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const counts = value as Record<string, unknown>;
  return ["needsReply", "waiting", "failed", "all"].every((key) => {
    const count = counts[key];
    return Number.isSafeInteger(count) && Number(count) >= 0;
  });
}

export function isInboxSnapshotSignature(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isInboxPagination(
  value: unknown,
  rowCount: number,
  expectedLimit: number,
  expectedOffset: number,
): value is InboxPagination {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const pagination = value as Record<string, unknown>;
  const limit = pagination["limit"];
  const offset = pagination["offset"];
  const total = pagination["total"];
  const nextOffset = pagination["nextOffset"];
  if (
    !Number.isSafeInteger(limit) ||
    Number(limit) < 1 ||
    Number(limit) > 200 ||
    Number(limit) !== expectedLimit ||
    !Number.isSafeInteger(offset) ||
    Number(offset) < 0 ||
    Number(offset) !== expectedOffset ||
    !Number.isSafeInteger(total) ||
    Number(total) < 0 ||
    !Number.isSafeInteger(rowCount) ||
    rowCount < 0 ||
    rowCount > Number(limit)
  ) {
    return false;
  }

  const expectedNextOffset = Number(offset) + rowCount;
  if (rowCount > 0 && expectedNextOffset > Number(total)) return false;
  if (nextOffset === null) {
    return expectedNextOffset >= Number(total);
  }
  return (
    Number.isSafeInteger(nextOffset) &&
    Number(nextOffset) === expectedNextOffset &&
    Number(nextOffset) > Number(offset) &&
    Number(nextOffset) < Number(total)
  );
}
