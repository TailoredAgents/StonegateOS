import assert from "node:assert/strict";
import test from "node:test";
import {
  groupInboxThreads,
  inboxContactName,
  inboxFilters,
  loadInboxConversation,
  loadInboxList,
  type ThreadSummary,
} from "../src/app/team/inbox-loader";
import { parseInboxThreadPagePayload } from "../src/app/team/inbox-thread-page";

const contactId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const smsId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const emailId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const olderEmailId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const messageId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const createdAt = "2026-09-13T13:00:00.000Z";
const contact = {
  id: contactId,
  name: "Customer",
  email: "customer@example.test",
  phone: "+15555550123",
};
function summary(id = smsId, channel = "sms", time = createdAt): ThreadSummary {
  return {
    id,
    status: "open",
    channel,
    subject: null,
    lastMessagePreview: "Thanks",
    lastMessageAt: time,
    contact,
    property: null,
    messageCount: 1,
  };
}
function detail(id = smsId, channel = "sms", empty = false) {
  return {
    ok: true,
    thread: {
      id,
      status: "open",
      channel,
      subject: null,
      lastMessageAt: empty ? null : createdAt,
      contact,
      property: null,
    },
    participants: [],
    messages: empty
      ? []
      : [
          {
            id: messageId,
            threadId: id,
            direction: "inbound",
            channel,
            subject: null,
            body: "Thanks",
            mediaUrls: [],
            deliveryStatus: "delivered",
            participantName: "Customer",
            createdAt,
            metadata: null,
          },
        ],
    messagePage: {
      version: 1,
      state: empty ? "empty" : "available",
      complete: true,
      order: "oldest_to_newest",
      position: "newest",
      limit: 50,
      returned: empty ? 0 : 1,
      snapshot: empty ? null : { id: messageId, createdAt },
      hasOlder: false,
      hasNewer: false,
      olderCursor: null,
      newerCursor: null,
    },
  };
}
function list(threads: ThreadSummary[] = [], offset = 0) {
  return {
    threads,
    pagination: {
      limit: 50,
      offset,
      total: offset + threads.length,
      nextOffset: null,
    },
    queueCounts: { all: threads.length, needsReply: 0, waiting: 0, failed: 0 },
    snapshot: { signature: "inbox-fixture-v1" },
  };
}
const json = (payload: unknown, status = 200) =>
  Promise.resolve(Response.json(payload, { status }));

void test("valid detail fixtures satisfy the strict completeness contract", () => {
  assert.ok(parseInboxThreadPagePayload(detail(), smsId));
  assert.ok(parseInboxThreadPagePayload(detail(smsId, "sms", true), smsId));
});

void test("contact/channel selection resolves the newest matching thread before fetching its strict detail", async () => {
  const requests: string[] = [];
  const result = await loadInboxConversation(
    { contactId: ` ${contactId.toUpperCase()} `, channel: "email" },
    (path) => {
      requests.push(path);
      if (path.startsWith("/api/admin/inbox/timeline?"))
        return json({
          contact,
          threads: [
            summary(smsId),
            summary(olderEmailId, "email", "2026-09-12T13:00:00.000Z"),
            summary(emailId, "email"),
          ],
          messages: [],
        });
      if (path === `/api/admin/inbox/threads/${emailId}?limit=50`)
        return json(detail(emailId, "email"));
      throw Error(`Unexpected dependency: ${path}`);
    },
  );
  assert.deepEqual(requests, [
    `/api/admin/inbox/timeline?contactId=${contactId}&limit=50`,
    `/api/admin/inbox/threads/${emailId}?limit=50`,
  ]);
  assert.equal(result.selectedThreadId, emailId);
  assert.equal(result.detail?.thread.id, emailId);
  assert.equal(result.channel, "email");
  assert.equal(result.contactId, contactId);
  assert.equal(result.error, null);
});

void test("an explicit failed thread remains selected and never falls back to another customer's timeline", async () => {
  const requests: string[] = [];
  const result = await loadInboxConversation(
    { threadId: ` ${smsId.toUpperCase()} `, contactId, channel: "email" },
    (path) => {
      requests.push(path);
      return json({ error: "not_found" }, 404);
    },
  );
  assert.deepEqual(requests, [`/api/admin/inbox/threads/${smsId}?limit=50`]);
  assert.equal(result.selectedThreadId, smsId);
  assert.equal(result.detail, null);
  assert.equal(result.timeline, null);
  assert.equal(result.contactId, null);
  assert.equal(result.error?.status, 404);
  assert.equal(result.hasSelection, true);
});

for (const [status, text] of [
  [401, /session expired/i],
  [403, /do not have access/i],
  [409, /older page has expired/i],
  [422, /page link is invalid/i],
] as const) {
  void test(`HTTP ${status} is an explicit conversation failure, not an empty conversation`, async () => {
    const result = await loadInboxConversation({ threadId: smsId }, () =>
      json({ error: "read_failed" }, status),
    );
    assert.equal(result.detail, null);
    assert.equal(result.error?.status, status);
    assert.match(result.error.message, text);
  });
}

void test("a verified empty conversation remains different from malformed, unreadable, or unavailable messages", async () => {
  const empty = await loadInboxConversation({ threadId: smsId }, () =>
    json(detail(smsId, "sms", true)),
  );
  assert.equal(empty.error, null);
  assert.equal(empty.detail?.messagePage.state, "empty");
  for (const read of [
    () => json({ thread: detail().thread, messages: [] }),
    () =>
      json({
        ...detail(),
        messagePage: { ...detail().messagePage, complete: false },
      }),
    () => Promise.resolve(new Response("not-json")),
    () => Promise.reject(new Error("Connection unavailable")),
  ]) {
    const result = await loadInboxConversation({ threadId: smsId }, read);
    assert.equal(result.detail, null);
    assert.ok(result.error);
  }
});

void test("a missing channel conversation keeps the selected customer without borrowing messages from another channel", async () => {
  const requests: string[] = [];
  const result = await loadInboxConversation(
    { contactId, channel: "email" },
    (path) => {
      requests.push(path);
      return json({ contact, threads: [summary()], messages: [] });
    },
  );
  assert.equal(requests.length, 1);
  assert.equal(result.contactId, contactId);
  assert.equal(result.channel, "email");
  assert.equal(result.selectedThreadId, null);
  assert.equal(result.detail, null);
  assert.equal(result.error, null);
  assert.equal(result.hasSelection, true);
});

void test("resolution refuses mismatched customer, channel, or partner-job detail", async () => {
  for (const thread of [
    { ...detail(emailId, "email").thread, contact: { ...contact, id: smsId } },
    { ...detail(emailId, "email").thread, channel: "sms" },
    {
      ...detail(emailId, "email").thread,
      partnerJob: { accountId: "partner-a", jobId: "job-a" },
    },
  ]) {
    const result = await loadInboxConversation(
      { contactId, channel: "email" },
      (path) =>
        path.startsWith("/api/admin/inbox/timeline?")
          ? json({
              contact,
              threads: [summary(emailId, "email")],
              messages: [],
            })
          : json({ ...detail(emailId, "email"), thread }),
    );
    assert.equal(result.detail, null);
    assert.match(result.error!.message, /does not match/i);
  }
});

void test("malformed customer resolution does not trigger a guessed detail request", async () => {
  for (const payload of [
    null,
    { contact, threads: [null], messages: [] },
    { contact: { ...contact, name: null }, threads: [], messages: [] },
    { contact: { ...contact, id: smsId }, threads: [], messages: [] },
  ]) {
    const requests: string[] = [];
    const result = await loadInboxConversation(
      { contactId, channel: "sms" },
      (path) => {
        requests.push(path);
        return json(payload);
      },
    );
    assert.equal(requests.length, 1);
    assert.equal(result.detail, null);
    assert.ok(result.error);
  }
});

void test("explicit partner messages use web identity without inheriting a customer recipient", async () => {
  const payload = detail(smsId, "web");
  const result = await loadInboxConversation(
    { threadId: smsId, contactId, channel: "sms" },
    () =>
      json({
        ...payload,
        thread: {
          ...payload.thread,
          partnerJob: { accountId: "partner-a", jobId: "job-a" },
        },
      }),
  );
  assert.equal(result.error, null);
  assert.equal(result.channel, "web");
  assert.equal(result.contact, null);
  assert.equal(result.contactId, null);
  assert.equal(result.isPartnerConversation, true);
});

void test("history parameters retain exact opaque cursor values and require a matching complete history receipt", async () => {
  const requests: string[] = [];
  const payload = detail();
  const result = await loadInboxConversation(
    {
      threadId: smsId,
      messageLimit: "1",
      messageCursor: "opaque_history_cursor",
    },
    (path) => {
      requests.push(path);
      return json({
        ...payload,
        messagePage: { ...payload.messagePage, limit: 1, position: "history" },
      });
    },
  );
  assert.deepEqual(requests, [
    `/api/admin/inbox/threads/${smsId}?limit=1&cursor=opaque_history_cursor`,
  ]);
  assert.equal(result.error, null);
  assert.equal(result.detail?.messagePage.position, "history");
  const mismatch = await loadInboxConversation(
    { threadId: smsId, messageCursor: "opaque_history_cursor" },
    () => json(detail()),
  );
  assert.equal(mismatch.detail, null);
  assert.ok(mismatch.error);
});

void test("conversation and list loads only depend on their core endpoints", async () => {
  const paths: string[] = [];
  const read = (path: string) => {
    paths.push(path);
    if (path === `/api/admin/inbox/threads/${smsId}?limit=50`)
      return json(detail());
    if (path === "/api/admin/inbox/threads?limit=50&queue=all")
      return json(list([summary()]));
    return Promise.reject(
      Error("Optional provider/AI/CRM endpoint is unavailable"),
    );
  };
  const [conversation, inbox] = await Promise.all([
    loadInboxConversation({ threadId: smsId }, read),
    loadInboxList({}, read),
  ]);
  assert.equal(conversation.error, null);
  assert.equal(inbox.error, null);
  assert.equal(paths.length, 2);
  const unselected = await loadInboxConversation({}, read);
  assert.equal(paths.length, 2);
  assert.equal(unselected.hasSelection, false);
});

void test("filter normalization and paging preserve the user's selected queue and search", async () => {
  assert.deepEqual(
    inboxFilters({
      view: "attention",
      q: "  rear\n gate   access ",
      firstMessageFrom: " 2026-09-01 ",
    }),
    {
      queue: "needs_reply",
      view: "all",
      q: "rear gate access",
      firstMessageFrom: "2026-09-01",
      firstMessageTo: "",
      lastMessageFrom: "",
      lastMessageTo: "",
    },
  );
  assert.equal(
    inboxFilters({ view: "attention", status: "closed" }).queue,
    "all",
  );
  const paths: string[] = [];
  const result = await loadInboxList(
    { queue: "failed", view: "google", q: "  rear   gate ", offset: "50" },
    (path) => {
      paths.push(path);
      return json(list([summary()], 50));
    },
  );
  const params = new URL(paths[0]!, "http://example.test").searchParams;
  assert.equal(params.get("queue"), "failed");
  assert.equal(params.get("view"), "google");
  assert.equal(params.get("q"), "rear gate");
  assert.equal(params.get("offset"), "50");
  assert.equal(result.pagination.offset, 50);
  assert.equal(result.error, null);
});

void test("verified empty lists remain distinct from failed or incomplete list responses", async () => {
  const empty = await loadInboxList({}, () => json(list()));
  assert.deepEqual(empty.threads, []);
  assert.equal(empty.error, null);
  for (const read of [
    () => json(list(), 403),
    () => json(list(), 401),
    () => json({ threads: [] }),
    () => json({ ...list([summary()]), threads: [null] }),
    () => json({ ...list([summary()]), threads: [{ id: smsId }] }),
    () =>
      json({
        ...list(),
        pagination: { limit: 50, offset: 0, total: 1, nextOffset: null },
      }),
    () => Promise.resolve(new Response("invalid-json")),
  ]) {
    const result = await loadInboxList({}, read);
    assert.deepEqual(result.threads, []);
    assert.ok(result.error);
  }
});

void test("customer grouping combines staff channels but keeps every web and anonymous thread separate", () => {
  const rows = [
    summary(smsId, "sms", "2026-09-12T13:00:00.000Z"),
    summary(emailId, "email"),
    summary(olderEmailId, "web"),
    summary(messageId, "web"),
    { ...summary(contactId, "sms"), contact: null },
  ];
  const groups = groupInboxThreads(rows);
  assert.equal(groups.length, 4);
  assert.deepEqual(
    groups
      .find((group) => group.key === contactId)
      ?.threads.map((thread) => thread.id),
    [emailId, smsId],
  );
  assert.equal(
    groups.find((group) => group.key === `thread:${olderEmailId}`)?.threads
      .length,
    1,
  );
  assert.equal(
    groups.find((group) => group.key === `thread:${messageId}`)?.threads.length,
    1,
  );
  assert.equal(
    groups.find((group) => group.key === `thread:${contactId}`)?.threads.length,
    1,
  );
  assert.equal(
    rows[0]?.id,
    smsId,
    "group ordering does not reorder the original list",
  );
});

void test("unnamed customers use a usable phone or email label", () => {
  assert.equal(
    inboxContactName({ ...contact, name: " Unknown Contact " }),
    contact.phone,
  );
  assert.equal(
    inboxContactName({ ...contact, name: "", phone: null }),
    contact.email,
  );
  assert.equal(inboxContactName(null), "Customer");
  assert.equal(inboxContactName({ ...contact, name: "  Alex  " }), "Alex");
});
