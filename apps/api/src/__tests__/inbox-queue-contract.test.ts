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
  const section = siteSource("src/app/team/components/InboxView.tsx");
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

  it("keeps list reads bounded while the API retains backward-compatible queue counts", () => {
    expect(route).toContain("sortedRowsQuery.limit(limit).offset(offset)");
    expect(route).toContain(
      "nextOffset: nextOffset < total ? nextOffset : null",
    );
    const loader = siteSource("src/app/team/inbox-loader.ts");
    expect(loader).toContain("isInboxPagination(");
    expect(loader).toContain("isInboxSnapshotSignature(");
    expect(section).toContain('aria-label="Conversation list pages"');
    expect(inboxState).toContain("Number(limit) !== expectedLimit");
    expect(inboxState).toContain("Number(offset) !== expectedOffset");
    expect(inboxState).toContain("Number(nextOffset) === expectedNextOffset");
  });

  it("carries queue, page, thread, contact, and channel through canonical URLs", () => {
    expect(threadPage).toContain(
      'setOptional(params, "inbox_queue", input.queue)',
    );
    expect(section).toContain("buildInboxConversationQuery(");
    expect(section).toContain("offset: list.pagination.offset");
    expect(page).toContain("params?.inbox_queue");
    expect(loaders).toContain("queue?: string;");
    expect(proxy).toContain('"queue",');
    expect(liveUpdates).toContain(
      'threadsUrl.searchParams.set("queue", props.queue)',
    );
  });

  it("moves useful filters into a collapsed panel and removes routine status controls", () => {
    const controls = siteSource(
      "src/app/team/components/InboxNavigationClient.tsx",
    );
    for (const label of [
      "All conversations",
      "Needs a reply",
      "Delivery problems",
    ])
      expect(controls).toContain(label);
    expect(controls).toContain("hidden={!open}");
    expect(controls).not.toContain('<option value="waiting">');
    expect(section).not.toContain("ownerQuickActions");
    expect(section).not.toContain("threadStatusControls");
    expect(section).not.toContain("updateThreadAction");
  });
});
