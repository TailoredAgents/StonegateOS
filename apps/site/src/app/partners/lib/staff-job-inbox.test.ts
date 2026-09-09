import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolveInboxConversationContext } from "../../team/inbox-conversation-context";

void test("a no-contact portal thread opens as the same job, never a CRM channel fallback", () => {
  const activeThread = {
    channel: "web",
    contact: null,
    partnerJob: { accountId: "account-a", jobId: "job-a" },
  };
  for (const requestedChannel of [null, "sms", "email", "dm"] as const) {
    assert.deepEqual(
      resolveInboxConversationContext({
        activeThread,
        requestedChannel,
        requestedContactId: "unrelated-contact",
      }),
      {
        isPartnerConversation: true,
        requestedChannel: "web",
        activeContactId: null,
      },
    );
  }
});

void test("ordinary CRM contact channel switching is preserved", () => {
  assert.deepEqual(
    resolveInboxConversationContext({
      activeThread: { channel: "email", contact: { id: "contact-a" } },
      requestedChannel: null,
      requestedContactId: null,
    }),
    {
      isPartnerConversation: false,
      requestedChannel: "email",
      activeContactId: "contact-a",
    },
  );
  assert.equal(
    resolveInboxConversationContext({
      activeThread: null,
      requestedChannel: "sms",
      requestedContactId: "contact-b",
    }).activeContactId,
    "contact-b",
  );
});

void test("staff desktop and mobile open direct partner threads with explicit reply visibility", () => {
  const desktop = readFileSync(
    new URL("../../team/components/InboxSection.tsx", import.meta.url),
    "utf8",
  );
  const mobile = readFileSync(
    new URL("../../mobile/page.tsx", import.meta.url),
    "utf8",
  );
  assert.match(desktop, /resolveInboxConversationContext/u);
  assert.match(
    desktop,
    /showConversation = Boolean\(\s*activeContactId \|\| \(isPartnerConversation && selectedThreadId\),?\s*\)/u,
  );
  assert.match(
    desktop,
    /selectedThreadId && requestedChannel !== "web"[\s\S]{0,80}InboxAutoDraftClient/u,
  );
  assert.match(desktop, /Reply to partner/u);
  assert.match(desktop, /Internal note/u);
  assert.match(
    mobile,
    /isPartnerJob=\{Boolean\(selectedThread\.thread\.partnerJob\)\}/u,
  );
  assert.match(mobile, /threadId=\{selectedThread\.thread\.id\}/u);
});
