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
  const view = siteSource("src/app/team/components/InboxView.tsx");

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

  it("keeps strict loading separate from optional tools and routes recovery through the client composer", () => {
    const loader = siteSource("src/app/team/inbox-loader.ts");
    expect(inboxSection).toContain("loadInboxList(input, read)");
    expect(inboxSection).toContain("loadInboxConversation(input, read)");
    expect(loader).toContain("parseInboxThreadPagePayload(");
    expect(loader).not.toContain("/api/admin/providers");
    expect(loader).not.toContain("sales-agent-next-action");
    expect(view).toContain("InboxRetryClient");
    expect(view).toContain("InboxComposerClient");
    expect(view).toContain("Delivery failed");
    expect(view).toContain("Retry delivery");
  });

  it("offers AI drafting without bringing the large workspace back above messages", () => {
    const tools = siteSource(
      "src/app/team/components/InboxOptionalToolsClient.tsx",
    );
    expect(view).toContain("InboxAiReplyClient");
    expect(view).not.toContain("agentWorkspaceCard");
    expect(tools).toContain("Draft a reply");
    expect(tools).toContain("Automation details");
    expect(tools).toContain("insertInboxComposerDraft");
  });
});
