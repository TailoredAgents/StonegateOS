import { INBOX_QUEUE_IDS, parseInboxQueue } from "@/lib/inbox-queue";
import {
  isInboxPagination,
  isInboxQueueCounts,
  isInboxSnapshotSignature,
} from "../../../site/src/app/team/inbox-state";

describe("Inbox queue identifiers", () => {
  it("accepts only the four canonical queues", () => {
    expect(INBOX_QUEUE_IDS).toEqual([
      "needs_reply",
      "waiting",
      "failed",
      "all",
    ]);

    for (const queue of INBOX_QUEUE_IDS) {
      expect(parseInboxQueue(queue)).toBe(queue);
    }
  });

  it("does not silently reinterpret malformed queue values", () => {
    expect(parseInboxQueue(null)).toBeNull();
    expect(parseInboxQueue("")).toBeNull();
    expect(parseInboxQueue("needs-response")).toBeNull();
    expect(parseInboxQueue("FAILED")).toBeNull();
    expect(parseInboxQueue(" failed ")).toBeNull();
  });
});

describe("Inbox queue response validation", () => {
  it("requires a nonblank live-update snapshot signature", () => {
    expect(isInboxSnapshotSignature("inbox-revision-123")).toBe(true);
    expect(isInboxSnapshotSignature(null)).toBe(false);
    expect(isInboxSnapshotSignature(undefined)).toBe(false);
    expect(isInboxSnapshotSignature(123)).toBe(false);
    expect(isInboxSnapshotSignature("")).toBe(false);
    expect(isInboxSnapshotSignature("   ")).toBe(false);
  });

  it("accepts exact non-negative server-derived counts", () => {
    expect(
      isInboxQueueCounts({ needsReply: 7, waiting: 3, failed: 2, all: 15 }),
    ).toBe(true);
  });

  it.each([
    null,
    {},
    { needsReply: 7, waiting: 3, failed: 2 },
    { needsReply: -1, waiting: 3, failed: 2, all: 15 },
    { needsReply: "7", waiting: 3, failed: 2, all: 15 },
  ])("rejects incomplete or malformed count payloads: %p", (value) => {
    expect(isInboxQueueCounts(value)).toBe(false);
  });

  it("accepts exact first-page and final-page pagination", () => {
    expect(
      isInboxPagination(
        { limit: 50, offset: 0, total: 75, nextOffset: 2 },
        2,
        50,
        0,
      ),
    ).toBe(true);
    expect(
      isInboxPagination(
        { limit: 50, offset: 50, total: 52, nextOffset: null },
        2,
        50,
        50,
      ),
    ).toBe(true);
  });

  it.each([
    [null, 0, 50, 0],
    [{}, 0, 50, 0],
    [{ limit: "50", offset: 0, total: 0, nextOffset: null }, 0, 50, 0],
    [{ limit: 50, offset: 0, total: 0, nextOffset: null }, 1, 50, 0],
    [{ limit: 50, offset: 0, total: 75, nextOffset: 50 }, 2, 50, 0],
    [{ limit: 25, offset: 0, total: 0, nextOffset: null }, 0, 50, 0],
    [{ limit: 50, offset: 50, total: 52, nextOffset: null }, 2, 50, 0],
  ] as const)(
    "rejects missing, malformed, or request-mismatched pagination: %p",
    (value, rowCount, expectedLimit, expectedOffset) => {
      expect(
        isInboxPagination(value, rowCount, expectedLimit, expectedOffset),
      ).toBe(false);
    },
  );
});
