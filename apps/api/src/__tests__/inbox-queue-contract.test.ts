import { readFileSync } from "node:fs";
import { join } from "node:path";

const API_ROOT = process.cwd();
const SITE_ROOT = join(API_ROOT, "../site");

function apiSource(relativePath: string): string {
  return readFileSync(join(API_ROOT, relativePath), "utf8");
}

function siteSource(relativePath: string): string {
  return readFileSync(join(SITE_ROOT, relativePath), "utf8");
}

describe("Inbox first-class queue contract", () => {
  const route = apiSource("app/api/admin/inbox/threads/route.ts");
  const failedSendsRoute = apiSource(
    "app/api/admin/inbox/failed-sends/route.ts",
  );
  const section = siteSource("src/app/team/components/InboxSection.tsx");
  const liveUpdates = siteSource(
    "src/app/team/components/InboxLiveUpdatesClient.tsx",
  );
  const proxy = siteSource("src/app/api/team/inbox/threads/route.ts");
  const page = siteSource("src/app/team/page.tsx");
  const loaders = siteSource("src/app/team/surface-loaders.tsx");
  const inboxState = siteSource("src/app/team/inbox-state.ts");
  const threadPage = siteSource("src/app/team/inbox-thread-page.ts");

  it("derives all four queue counts in one server-side aggregate", () => {
    expect(route).toContain('const rawQueue = searchParams.get("queue")');
    expect(route).toContain('{ error: "invalid_queue" }, { status: 422 }');
    expect(route).toContain('{ error: "invalid_contact_id" }, { status: 422 }');
    expect(route).toContain("const queueCountsQuery = db");
    expect(route).toContain("count(*) filter (where ${needsReplyQueueFilter})");
    expect(route).toContain("count(*) filter (where ${waitingQueueFilter})");
    expect(route).toContain("count(*) filter (where ${failedQueueFilter})");
    expect(route).toContain("queueCountsResultPromise");
    expect(route).toContain("queueCounts,");
  });

  it("keeps badge counts independent of the selected queue and legacy status", () => {
    expect(route).toContain(
      "They intentionally exclude both the selected\n  // queue and the transitional legacy status",
    );
    expect(route).toContain("queueCountsQuery.where(baseWhereClause)");

    const baseFilterBlock = route.slice(
      route.indexOf("const baseFilters = []"),
      route.indexOf("const filters = [...baseFilters]"),
    );
    expect(baseFilterBlock).not.toContain("if (status)");
    expect(baseFilterBlock).not.toContain("if (queue)");
    expect(route).toContain("const filters = [...baseFilters];\n  if (status)");
  });

  it("defines Failed as a current failed outbound, non-draft message", () => {
    expect(route).toContain("const failedQueueFilter = sql`exists (");
    expect(route).toContain("failed_cm.thread_id = ${conversationThreads.id}");
    expect(route).toContain("failed_cm.direction = 'outbound'");
    expect(route).toContain("failed_cm.delivery_status = 'failed'");
    expect(route).toContain(
      "coalesce(failed_cm.metadata ->> 'draft', 'false') <> 'true'",
    );
    expect(route).toContain("failedMessageCount:");
    expect(failedSendsRoute).toContain("const failedSendFilter = and(");
    expect(
      failedSendsRoute.match(/\.where\(failedSendFilter\)/gu),
    ).toHaveLength(2);
  });

  it("keeps list reads bounded and returns selected-queue pagination", () => {
    expect(route).toContain("sortedRowsQuery.limit(limit).offset(offset)");
    expect(route).toContain(
      "nextOffset: nextOffset < total ? nextOffset : null",
    );
    expect(section).toContain('params.set("limit", "50")');
    expect(section).toContain('aria-label="Inbox pages"');
    expect(section).toContain("queueCounts?.failed ?? null");
    expect(section).toContain("!isInboxPagination(");
    expect(section).toContain("!isInboxSnapshotSignature(snapshotSignature)");
    expect(section).toContain(
      "The Inbox returned an incomplete queue response.",
    );
    expect(section).not.toContain("total: threads.length");
    expect(inboxState).toContain("Number(limit) !== expectedLimit");
    expect(inboxState).toContain("Number(offset) !== expectedOffset");
    expect(inboxState).toContain(
      'typeof value === "string" && value.trim().length > 0',
    );
    expect(inboxState).toContain("Number(nextOffset) === expectedNextOffset");
    expect(section).not.toContain(
      "count: threads.filter((thread) => thread.needsAttention).length",
    );
  });

  it("carries queue, page, thread, contact, and channel through canonical URLs", () => {
    expect(threadPage).toContain(
      'setOptional(params, "inbox_queue", input.queue)',
    );
    expect(section).toContain("queue: activeQueue,");
    expect(section).toContain("offset: threadPagination.offset");
    expect(section).toContain("threadId: t.id");
    expect(section).toContain("contactId: t.contact.id");
    expect(section).toContain("channel: t.channel");
    expect(page).toContain("params?.inbox_queue");
    expect(loaders).toContain("queue?: string;");
    expect(proxy).toContain('"queue",');
    expect(liveUpdates).toContain(
      'threadsUrl.searchParams.set("queue", props.queue)',
    );
  });

  it("shows four named queues and never turns a failed load into zero", () => {
    for (const label of ["Needs Reply", "Waiting", "Failed", "All"]) {
      expect(section).toContain(`label: "${label}"`);
    }
    expect(section).toContain("Thread count unavailable");
    expect(section).toContain("This is not an empty Inbox");
    expect(section).toContain('item.count === null ? "—" : item.count');
    expect(section).toContain("Use the Failed queue to work every");
    expect(section).toContain("affected thread.");
  });
});
