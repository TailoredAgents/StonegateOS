import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildInboxSnapshotSignature } from "@/lib/inbox-snapshot";

const API_ROOT = join(process.cwd());
const SITE_ROOT = join(process.cwd(), "../site");

function apiSource(relativePath: string): string {
  return readFileSync(join(API_ROOT, relativePath), "utf8");
}

function siteSource(relativePath: string): string {
  return readFileSync(join(SITE_ROOT, relativePath), "utf8");
}

describe("Inbox snapshot revisions", () => {
  it("is deterministic, changes with delivery state, and does not expose source data", () => {
    const input = {
      contact: "Ada Customer",
      messages: [{ id: "message-1", status: "queued" }],
    };
    const first = buildInboxSnapshotSignature(input);
    const second = buildInboxSnapshotSignature(input);
    const delivered = buildInboxSnapshotSignature({
      ...input,
      messages: [{ id: "message-1", status: "delivered" }],
    });

    expect(first).toBe(second);
    expect(delivered).not.toBe(first);
    expect(first).toHaveLength(43);
    expect(first).not.toContain("Ada Customer");
    expect(first).not.toContain("message-1");
  });
});

describe("Inbox polling API contracts", () => {
  const timelineRoute = apiSource("app/api/admin/inbox/timeline/route.ts");
  const threadsRoute = apiSource("app/api/admin/inbox/threads/route.ts");
  const timelineProxy = siteSource("src/app/api/team/inbox/timeline/route.ts");
  const threadsProxy = siteSource("src/app/api/team/inbox/threads/route.ts");

  it("returns a lightweight contact snapshot before loading bodies or thread history", () => {
    expect(timelineRoute).toContain(
      'const snapshotOnly = searchParams.get("snapshot") === "1"',
    );
    expect(timelineRoute).toContain("buildInboxSnapshotSignature");
    expect(timelineRoute).toContain("queuedCount:");
    expect(timelineRoute).toContain("failedCount:");
    expect(timelineRoute.indexOf("if (snapshotOnly)")).toBeLessThan(
      timelineRoute.indexOf("const threadsPromise"),
    );
    expect(timelineRoute).toContain("snapshot,\n    contact:");
    expect(timelineProxy).toContain('params.set("snapshot", "1")');
  });

  it("returns a bounded page revision before provider-policy and Facebook enrichment", () => {
    expect(threadsRoute).toContain(
      'const snapshotOnly = searchParams.get("snapshot") === "1"',
    );
    expect(threadsRoute).toContain("messageDeliveryCountMap");
    expect(threadsRoute).toContain("globalFailedMessageCount");
    expect(threadsRoute).toContain("buildInboxSnapshotSignature");
    expect(threadsRoute.indexOf("if (snapshotOnly)")).toBeLessThan(
      threadsRoute.indexOf("getServiceAreaPolicy(db)"),
    );
    expect(threadsRoute).toContain("snapshot,\n    pagination:");
    expect(threadsProxy).toContain('"snapshot",');
  });
});

describe("Inbox browser reliability contracts", () => {
  const liveUpdates = siteSource(
    "src/app/team/components/InboxLiveUpdatesClient.tsx",
  );
  const mediaGallery = siteSource(
    "src/app/team/components/InboxMediaGallery.tsx",
  );
  const inboxSection = siteSource("src/app/team/components/InboxSection.tsx");

  it("uses one abortable recursive poll with compact parallel snapshots", () => {
    expect(liveUpdates).not.toContain("setInterval(");
    expect(liveUpdates).toContain("let inFlight = false");
    expect(liveUpdates).toContain("new AbortController()");
    expect(liveUpdates).toContain("Promise.allSettled([");
    expect(
      liveUpdates.match(/searchParams\.set\("snapshot", "1"\)/gu),
    ).toHaveLength(2);
    expect(liveUpdates).toContain('threadsUrl.searchParams.set("limit", "50")');
    expect(liveUpdates).not.toContain(
      'threadsUrl.searchParams.set("limit", hasFilters',
    );
    expect(liveUpdates).toContain(
      'document.addEventListener("visibilitychange"',
    );
    expect(liveUpdates).toContain("controller.abort()");
    expect(liveUpdates).toContain("conversation shown may be stale");
  });

  it("loads media metadata only near view and caps each probe batch", () => {
    expect(mediaGallery).toContain("MAX_CONCURRENT_TYPE_PROBES = 3");
    expect(mediaGallery).toContain("new IntersectionObserver(");
    expect(mediaGallery).toContain('method: "HEAD"');
    expect(mediaGallery).toContain("signal: controller.signal");
    expect(mediaGallery).toContain(
      "Math.min(\n        MAX_CONCURRENT_TYPE_PROBES",
    );
    expect(mediaGallery).not.toContain("Promise.all(\n        mediaUrls.map");
    expect(mediaGallery).toContain("Preview unavailable");
  });

  it("keeps paging and selection in the URL and never disguises ancillary failure as empty", () => {
    expect(inboxSection).toContain('params.set("limit", "50")');
    expect(inboxSection).not.toContain(
      'params.set("limit", hasSearchFilters ? "200" : "50")',
    );
    expect(inboxSection).toContain('aria-label="Inbox pages"');
    expect(inboxSection).toContain("offset: threadPagination.offset");
    expect(inboxSection).toContain("requestedChannelParam ??");
    expect(inboxSection).toContain(
      "activeThread.id\n      : null) ?? activeChannelThreadId",
    );
    expect(inboxSection).toContain("This is not an empty Inbox");
    expect(inboxSection).toContain(
      "This does not mean there are no failed sends",
    );
    expect(inboxSection).toContain("Customer history is incomplete");
    expect(inboxSection).toContain("Delivery failed");
    expect(inboxSection).toContain("Retry delivery");
  });

  it("keeps the approval-first AI action visible outside optional customer details", () => {
    expect(inboxSection).toContain(
      'aria-labelledby="inbox-ai-workspace-title"',
    );
    expect(inboxSection).toContain(
      "{agentWorkspaceCard}\n\n              {activeContactId ? (",
    );
    expect(inboxSection).not.toContain(
      '<summary className="cursor-pointer list-none text-xs font-semibold uppercase tracking-wide text-slate-500">\n                          AI workspace',
    );
  });
});
