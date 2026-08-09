import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decodeInboxThreadMessageCursor,
  encodeInboxThreadMessageCursor,
  paginateInboxThreadMessageKeys,
  parseInboxThreadId,
  parseInboxThreadMessageQuery,
  type InboxThreadMessageKey,
} from "@/lib/inbox-thread-message-pagination";
import {
  buildInboxConversationQuery,
  parseInboxThreadPagePayload,
  parseInboxThreadRouteId,
} from "../../../site/src/app/team/inbox-thread-page";

const API_ROOT = process.cwd();
const SITE_ROOT = join(API_ROOT, "../site");
const THREAD_ID = "00000000-0000-4000-8000-000000000100";
const OTHER_THREAD_ID = "00000000-0000-4000-8000-000000000200";
const CREATED_AT = "2026-08-08T12:00:00.000Z";

function apiSource(relativePath: string): string {
  return readFileSync(join(API_ROOT, relativePath), "utf8");
}

function siteSource(relativePath: string): string {
  return readFileSync(join(SITE_ROOT, relativePath), "utf8");
}

function id(sequence: number): string {
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

function denseKeys(count: number): InboxThreadMessageKey[] {
  return Array.from({ length: count }, (_, index) => ({
    id: id(index + 1),
    createdAt: CREATED_AT,
  }));
}

function message(key: InboxThreadMessageKey) {
  return {
    id: key.id,
    threadId: THREAD_ID,
    direction: "inbound",
    channel: "sms",
    subject: null,
    body: `Message ${key.id}`,
    mediaUrls: [],
    deliveryStatus: "delivered",
    participantName: "Customer",
    createdAt: key.createdAt,
    metadata: null,
  };
}

function payloadFor(keys: InboxThreadMessageKey[]) {
  const result = paginateInboxThreadMessageKeys({
    threadId: THREAD_ID,
    keys,
  });
  if (!result.ok) throw new Error("Unexpected reference-page failure.");
  return {
    ok: true,
    thread: {
      id: THREAD_ID,
      status: "open",
      channel: "sms",
      subject: null,
      lastMessageAt: keys.at(-1)?.createdAt ?? null,
      contact: {
        id: id(900),
        name: "Customer",
        email: null,
        phone: "+15555550100",
      },
      property: null,
    },
    participants: [],
    messages: result.keys.map(message),
    messagePage: result.page,
  };
}

describe("selected Inbox thread cursor contract", () => {
  it("rejects missing and malformed thread IDs before UUID queries or proxy calls", () => {
    for (const parse of [parseInboxThreadId, parseInboxThreadRouteId]) {
      expect(parse(undefined)).toEqual(
        expect.objectContaining({
          ok: false,
          status: 400,
          error: "thread_id_required",
        }),
      );
      expect(parse("not-a-uuid")).toEqual(
        expect.objectContaining({
          ok: false,
          status: 422,
          error: "invalid_thread_id",
        }),
      );
      expect(parse(` ${THREAD_ID} `)).toEqual(
        expect.objectContaining({
          ok: false,
          status: 422,
          error: "invalid_thread_id",
        }),
      );
      expect(parse(THREAD_ID.toUpperCase())).toEqual({
        ok: true,
        threadId: THREAD_ID,
      });
    }
  });

  it("round-trips one exact-key v1 opaque cursor bound to thread, direction, snapshot, and limit", () => {
    const cursor = {
      version: 1 as const,
      threadId: THREAD_ID,
      limit: 50,
      direction: "older" as const,
      anchorCreatedAt: CREATED_AT,
      anchorId: id(10),
      snapshotCreatedAt: CREATED_AT,
      snapshotId: id(51),
    };
    const encoded = encodeInboxThreadMessageCursor(cursor);
    expect(encoded).not.toContain(THREAD_ID);
    expect(encoded).not.toContain(CREATED_AT);
    expect(decodeInboxThreadMessageCursor(encoded)).toEqual(cursor);
    expect(decodeInboxThreadMessageCursor(`${encoded}!`)).toBeNull();
    expect(decodeInboxThreadMessageCursor("a".repeat(1_201))).toBeNull();

    const withExtraKey = Buffer.from(
      JSON.stringify({ ...cursor, messageBody: "must never enter a cursor" }),
      "utf8",
    ).toString("base64url");
    expect(decodeInboxThreadMessageCursor(withExtraKey)).toBeNull();
  });

  it("uses createdAt plus id to page duplicate timestamps in both directions", () => {
    const keys = denseKeys(51).reverse();
    const newest = paginateInboxThreadMessageKeys({
      threadId: THREAD_ID,
      keys,
    });
    expect(newest.ok).toBe(true);
    if (!newest.ok) return;
    expect(newest.keys).toHaveLength(50);
    expect(newest.keys[0]?.id).toBe(id(2));
    expect(newest.keys.at(-1)?.id).toBe(id(51));
    expect(newest.page).toEqual(
      expect.objectContaining({
        state: "available",
        position: "newest",
        hasOlder: true,
        hasNewer: false,
      }),
    );

    const olderCursor = decodeInboxThreadMessageCursor(
      newest.page.olderCursor!,
    );
    expect(olderCursor?.direction).toBe("older");
    const older = paginateInboxThreadMessageKeys({
      threadId: THREAD_ID,
      keys,
      cursor: olderCursor,
    });
    expect(older.ok).toBe(true);
    if (!older.ok) return;
    expect(older.keys.map((key) => key.id)).toEqual([id(1)]);
    expect(older.page.position).toBe("history");
    expect(older.page.hasOlder).toBe(false);
    expect(older.page.hasNewer).toBe(true);

    const newerCursor = decodeInboxThreadMessageCursor(older.page.newerCursor!);
    expect(newerCursor?.direction).toBe("newer");
    const returnedNewest = paginateInboxThreadMessageKeys({
      threadId: THREAD_ID,
      keys,
      cursor: newerCursor,
    });
    expect(returnedNewest.ok).toBe(true);
    if (!returnedNewest.ok) return;
    expect(returnedNewest.keys.map((key) => key.id)).toEqual(
      newest.keys.map((key) => key.id),
    );
    expect(returnedNewest.page.position).toBe("history");
    expect(returnedNewest.page.hasNewer).toBe(false);
  });

  it("preserves PostgreSQL microseconds so same-millisecond rows cannot be skipped", () => {
    const microsecondKeys = [
      { id: id(20), createdAt: "2026-08-08T12:00:00.000001Z" },
      { id: id(1), createdAt: "2026-08-08T12:00:00.000002Z" },
    ];
    const result = paginateInboxThreadMessageKeys({
      threadId: THREAD_ID,
      keys: microsecondKeys,
      limit: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.keys).toEqual([microsecondKeys[1]]);
    const cursor = decodeInboxThreadMessageCursor(result.page.olderCursor!);
    expect(cursor).toEqual(
      expect.objectContaining({
        anchorCreatedAt: "2026-08-08T12:00:00.000002Z",
        snapshotCreatedAt: "2026-08-08T12:00:00.000002Z",
        limit: 1,
      }),
    );

    const precisePayload = payloadFor(microsecondKeys);
    expect(
      parseInboxThreadPagePayload(precisePayload, THREAD_ID),
    ).not.toBeNull();
  });

  it.each([
    [0, "empty", 0, false],
    [1, "available", 1, false],
    [50, "available", 50, false],
    [51, "available", 50, true],
  ] as const)(
    "returns a truthful bounded newest page for %i messages",
    (count, state, returned, hasOlder) => {
      const result = paginateInboxThreadMessageKeys({
        threadId: THREAD_ID,
        keys: denseKeys(count),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.page.state).toBe(state);
      expect(result.page.returned).toBe(returned);
      expect(result.page.hasOlder).toBe(hasOlder);
      expect(result.page.hasNewer).toBe(false);
      expect(result.keys).toHaveLength(returned);
    },
  );

  it("rejects malformed, duplicate, unknown, cross-thread, and limit-mismatched query state", () => {
    for (const params of [
      new URLSearchParams({ limit: "0" }),
      new URLSearchParams({ limit: "101" }),
      new URLSearchParams({ limit: "2.5" }),
      new URLSearchParams({ cursor: "" }),
      new URLSearchParams({ cursor: "not-a-cursor" }),
      new URLSearchParams({ unexpected: "1" }),
    ]) {
      expect(parseInboxThreadMessageQuery(params, THREAD_ID)).toEqual(
        expect.objectContaining({ ok: false }),
      );
    }
    const duplicateLimit = new URLSearchParams();
    duplicateLimit.append("limit", "50");
    duplicateLimit.append("limit", "50");
    expect(parseInboxThreadMessageQuery(duplicateLimit, THREAD_ID)).toEqual(
      expect.objectContaining({ ok: false, field: "limit" }),
    );

    const otherThreadCursor = encodeInboxThreadMessageCursor({
      version: 1,
      threadId: OTHER_THREAD_ID,
      limit: 50,
      direction: "older",
      anchorCreatedAt: CREATED_AT,
      anchorId: id(1),
      snapshotCreatedAt: CREATED_AT,
      snapshotId: id(2),
    });
    expect(
      parseInboxThreadMessageQuery(
        new URLSearchParams({ cursor: otherThreadCursor, limit: "50" }),
        THREAD_ID,
      ),
    ).toEqual(expect.objectContaining({ ok: false, field: "cursor" }));

    const limitBoundCursor = encodeInboxThreadMessageCursor({
      version: 1,
      threadId: THREAD_ID,
      limit: 25,
      direction: "older",
      anchorCreatedAt: CREATED_AT,
      anchorId: id(1),
      snapshotCreatedAt: CREATED_AT,
      snapshotId: id(2),
    });
    expect(
      parseInboxThreadMessageQuery(
        new URLSearchParams({ cursor: limitBoundCursor, limit: "50" }),
        THREAD_ID,
      ),
    ).toEqual(expect.objectContaining({ ok: false, field: "limit" }));
  });
});

describe("selected Inbox thread Site contract", () => {
  it("accepts a complete page and rejects incomplete, unordered, or mismatched payloads", () => {
    const valid = payloadFor(denseKeys(51));
    expect(parseInboxThreadPagePayload(valid, THREAD_ID)).not.toBeNull();

    expect(
      parseInboxThreadPagePayload(
        { ...valid, messages: [...valid.messages].reverse() },
        THREAD_ID,
      ),
    ).toBeNull();
    expect(parseInboxThreadPagePayload(valid, THREAD_ID, 25)).toBeNull();
    expect(
      parseInboxThreadPagePayload(
        {
          ...valid,
          messagePage: {
            ...valid.messagePage,
            snapshot: { createdAt: CREATED_AT, id: id(999) },
          },
        },
        THREAD_ID,
      ),
    ).toBeNull();
    expect(
      parseInboxThreadPagePayload(
        {
          ...valid,
          messages: [
            { ...valid.messages[0], threadId: OTHER_THREAD_ID },
            ...valid.messages.slice(1),
          ],
        },
        THREAD_ID,
      ),
    ).toBeNull();
    expect(
      parseInboxThreadPagePayload(
        {
          ...valid,
          messagePage: {
            ...valid.messagePage,
            returned: valid.messagePage.returned - 1,
          },
        },
        THREAD_ID,
      ),
    ).toBeNull();
    expect(
      parseInboxThreadPagePayload(
        { ...valid, messagePage: undefined },
        THREAD_ID,
      ),
    ).toBeNull();
    expect(
      parseInboxThreadPagePayload(
        {
          ...valid,
          messages: [],
          messagePage: { ...valid.messagePage, returned: 0 },
        },
        THREAD_ID,
      ),
    ).toBeNull();
  });

  it("preserves the full canonical Inbox context on conversation-page links", () => {
    const params = buildInboxConversationQuery({
      queue: "waiting",
      status: "open",
      view: "google",
      threadId: THREAD_ID,
      contactId: id(900),
      channel: "sms",
      q: "Ada Lovelace",
      firstMessageFrom: "2026-08-01",
      firstMessageTo: "2026-08-02",
      lastMessageFrom: "2026-08-03",
      lastMessageTo: "2026-08-04",
      offset: 50,
      messageCursor: "opaque_cursor",
      messageLimit: 50,
    });
    expect(Object.fromEntries(params.entries())).toEqual({
      inbox_queue: "waiting",
      inbox_status: "open",
      inbox_view: "google",
      threadId: THREAD_ID,
      contactId: id(900),
      channel: "sms",
      inbox_q: "Ada Lovelace",
      inbox_first_from: "2026-08-01",
      inbox_first_to: "2026-08-02",
      inbox_last_from: "2026-08-03",
      inbox_last_to: "2026-08-04",
      inbox_offset: "50",
      inbox_message_cursor: "opaque_cursor",
      inbox_message_limit: "50",
    });

    const newest = buildInboxConversationQuery({
      threadId: THREAD_ID,
      messageCursor: null,
      messageLimit: 50,
    });
    expect(newest.has("inbox_message_cursor")).toBe(false);
    expect(newest.get("inbox_message_limit")).toBe("50");

    const duplicated = buildInboxConversationQuery({
      threadId: THREAD_ID,
      messageCursor: ["first", "second"],
      messageLimit: ["50", "50"],
    });
    expect(duplicated.getAll("inbox_message_cursor")).toEqual([
      "first",
      "second",
    ]);
    expect(duplicated.getAll("inbox_message_limit")).toEqual(["50", "50"]);
  });

  it("keeps reads and delivery enrichment bounded and exposes truthful recovery UI", () => {
    const route = apiSource("app/api/admin/inbox/threads/[threadId]/route.ts");
    const schema = apiSource("src/db/schema.ts");
    const proxy = siteSource(
      "src/app/api/team/inbox/threads/[threadId]/route.ts",
    );
    const section = siteSource("src/app/team/components/InboxSection.tsx");
    const liveUpdates = siteSource(
      "src/app/team/components/InboxLiveUpdatesClient.tsx",
    );
    const actions = siteSource("src/app/team/actions.ts");
    const migration = apiSource(
      "src/db/migrations/0082_inbox_thread_message_pagination.sql",
    );

    expect(route).toContain(".limit(messageLimit + 1)");
    expect(route).toContain('\'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\'');
    expect(route).toContain("${timestamp}::timestamptz");
    expect(route).toContain("createdAt: row.createdAtKey");
    expect(route).toContain(
      "messageCreatedAtBefore(messageCursor.anchorCreatedAt)",
    );
    expect(route).toContain(
      "messageCreatedAtAfter(messageCursor.anchorCreatedAt)",
    );
    expect(route).toContain(
      "lt(conversationMessages.id, messageCursor.anchorId)",
    );
    expect(route).toContain(
      "gt(conversationMessages.id, messageCursor.anchorId)",
    );
    expect(route).toContain(
      "[asc(conversationMessages.createdAt), asc(conversationMessages.id)]",
    );
    expect(route).toContain(
      "[desc(conversationMessages.createdAt), desc(conversationMessages.id)]",
    );
    expect(route).toContain(
      "const messageIds = visibleMessageRows.map((row) => row.id)",
    );
    expect(route).toContain(
      ".where(inArray(messageDeliveryEvents.messageId, messageIds))",
    );
    expect(route).toContain("asc(messageDeliveryEvents.id)");
    expect(route).toContain("return staleMessagePage()");
    expect(schema).toContain('"conversation_messages_thread_created_id_idx"');
    expect(migration).toContain('("thread_id", "created_at", "id")');
    expect(route.indexOf("parseInboxThreadId(rawThreadId)")).toBeLessThan(
      route.indexOf("const db = getDb()"),
    );
    expect(proxy).toContain('const QUERY_KEYS = new Set(["cursor", "limit"])');
    expect(proxy).toContain("for (const value of input.getAll(key))");
    expect(proxy.indexOf("parseInboxThreadRouteId(threadId)")).toBeLessThan(
      proxy.indexOf("await callAdminApiAs("),
    );
    expect(section).toContain('aria-label="Conversation pages"');
    expect(section).toContain("Older conversation slice");
    expect(section).toContain("Return to newest");
    expect(section).toContain("This is not an empty conversation");
    expect(section).toContain("Replying from older history");
    expect(section).toContain(
      "the reply is not inserted into this fixed historical",
    );
    expect(section).toContain("min-h-[44px]");
    expect(liveUpdates).toContain("!props.isViewingNewest");
    expect(liveUpdates).toContain(
      "You remain on this older conversation page.",
    );

    const sendAction = actions.slice(
      actions.indexOf("export async function sendThreadMessageAction"),
      actions.indexOf("export async function retryFailedMessageAction"),
    );
    expect(sendAction).toContain('teamSurfaceHref("inbox"');
    expect(sendAction).not.toContain("inbox_message_cursor");
    expect(sendAction).not.toContain("messageCursor");
  });
});
