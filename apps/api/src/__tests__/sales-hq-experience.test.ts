import { readFileSync } from "node:fs";
import { join } from "node:path";

function apiSource(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

function siteSource(path: string): string {
  return readFileSync(
    join(process.cwd(), "../site/src/app/team/components", path),
    "utf8",
  );
}

describe("Sales HQ experience", () => {
  const queueApi = apiSource("app/api/admin/sales/queue/route.ts");
  const scorecardApi = apiSource("app/api/admin/sales/scorecard/route.ts");
  const coachingApi = apiSource("app/api/admin/calls/coaching/route.ts");
  const activityApi = apiSource("app/api/admin/sales/activity/route.ts");
  const serverSection = siteSource("SalesScorecardSection.tsx");
  const client = siteSource("SalesHqClient.tsx");
  const activitySection = siteSource("SalesActivityLogSection.tsx");

  it("aligns every Sales HQ read with the surface permission", () => {
    for (const source of [queueApi, scorecardApi, coachingApi, activityApi]) {
      expect(source).toContain('requirePermission(request, "sales.read")');
    }
    expect(queueApi).not.toContain(
      'requirePermission(request, "appointments.read")',
    );
    expect(activityApi).not.toContain(
      'requirePermission(request, "audit.read")',
    );
    expect(activityApi).toContain(
      "parseSalesActivityQuery(request.nextUrl.searchParams)",
    );
  });

  it("returns an explicit next task and operational context", () => {
    expect(queueApi).toContain("nextTaskId: enrichedItems[0]?.id ?? null");
    expect(queueApi).toContain("operationalContext:");
    expect(queueApi).toContain("ownerMemberId: memberId");
    expect(queueApi).toContain("buildSalesHqSlaContext(item)");
    expect(queueApi).toContain("priorityReason:");
    expect(queueApi).toContain("lastTouchAt:");
    expect(queueApi).toContain("salesHqDraftAgeMinutes");
  });

  it("keeps human queue reads read-only while preserving named worker preparation", () => {
    expect(queueApi).toContain('principalLabel === "sales-draft-prep"');
    expect(queueApi).toContain('permissionMatches(permission, "sales.write")');
    expect(queueApi).toContain("canPersistQueuePreparation");
    expect(queueApi).toContain("await upsertSalesAgentMemory");
    expect(queueApi).toContain("const nextAction = canPersistQueuePreparation");
    expect(queueApi).toContain("if (canPersistQueuePreparation) {");
  });

  it("loads score, queue, directory, coaching, and supervisor independently", () => {
    expect(serverSection).toContain("loadJsonResource<ScorecardPayload>");
    expect(serverSection).toContain("loadJsonResource<QueuePayload>");
    expect(serverSection).toContain("loadJsonResource<TeamMemberPayload>");
    expect(serverSection).toContain("loadJsonResource<CallCoachingPayload>");
    expect(serverSection).toContain("resourceErrors.scorecard =");
    expect(serverSection).toContain("resourceErrors.queue =");
    expect(serverSection).toContain("resourceErrors.coaching =");
    expect(serverSection).not.toContain("// optional");
  });

  it("keeps queue failure distinct from a real empty queue", () => {
    expect(client).toContain("This is not an empty queue");
    expect(client).toContain("This does not mean the score is zero");
    expect(client).toContain("This is not a zero-call result");
    expect(client).toContain("background draft");
    expect(client).toContain("Retry draft preparation");
    expect(client).not.toContain("ignore background draft prep failures");
  });

  it("uses canonical task URLs and preserves a direct Inbox handoff", () => {
    expect(client).toContain("buildSalesHqSelectionHref");
    expect(client).toContain('params.set("queue", nextQueue)');
    expect(client).toContain('params.set("taskId", item.id)');
    expect(client).toContain("This task moved to a different queue");
    expect(client).toContain('teamSurfaceHref("inbox"');
    expect(client).toContain("Open in Inbox");
  });

  it("keeps Queue, Coaching, and Activity as named canonical subviews", () => {
    for (const source of [serverSection, activitySection]) {
      expect(source).toContain("#sales-hq-queue");
      expect(source).toContain("#sales-hq-coaching");
      expect(source).toContain('teamSurfaceHref("sales-log")');
    }
    expect(client).toContain('id="sales-hq-queue"');
    expect(client).toContain('id="sales-hq-coaching"');
  });

  it("does not let activity or member-directory transport failures erase each other", () => {
    expect(activitySection).toContain("Promise.allSettled");
    expect(activitySection).toContain("Sales activity returned malformed data");
    expect(activitySection).toContain(
      "Team-member filters returned malformed data",
    );
    expect(activitySection).toContain("incomplete or unsafe response");
    expect(activitySection).toContain("Return to newest activity");
  });
});
