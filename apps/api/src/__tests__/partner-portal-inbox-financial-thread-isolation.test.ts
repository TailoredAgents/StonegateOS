import fs from "node:fs";
import path from "node:path";
import { GENERIC_INBOX_STAFF_SCOPE } from "@/lib/inbox-staff-scope";

function source(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

describe("generic Staff Inbox financial-thread isolation", () => {
  it("defines the generic Inbox as general-scope only", () => {
    expect(GENERIC_INBOX_STAFF_SCOPE).toBe("general");
    const policy = source("src/lib/inbox-staff-scope.ts");
    expect(policy).toContain(
      "eq(conversationThreads.staffScope, GENERIC_INBOX_STAFF_SCOPE)",
    );
  });

  it("classifies billing conversations outside the generic Inbox", () => {
    const billing = source("src/lib/partner-billing-dispute-requests.ts");
    expect(billing).toContain('staffScope: "partner_billing"');

    for (const route of [
      "app/api/admin/inbox/threads/route.ts",
      "app/api/admin/inbox/threads/ensure/route.ts",
    ]) {
      expect(source(route)).toContain('staffScope: "general"');
    }
  });

  it.each([
    ["messages.read list/count/search", "app/api/admin/inbox/threads/route.ts"],
    ["messages.read detail", "app/api/admin/inbox/threads/[threadId]/route.ts"],
    ["messages.read failed sends", "app/api/admin/inbox/failed-sends/route.ts"],
    ["messages.read timeline", "app/api/admin/inbox/timeline/route.ts"],
    [
      "messages.read media",
      "app/api/admin/inbox/messages/[messageId]/media/[index]/route.ts",
    ],
    ["messages.export", "app/api/admin/inbox/export/jsonl/route.ts"],
    [
      "messages.send",
      "app/api/admin/inbox/threads/[threadId]/messages/route.ts",
    ],
    ["messages.write draft", "app/api/admin/inbox/threads/[threadId]/draft/route.ts"],
    [
      "messages.write suggestion",
      "app/api/admin/inbox/threads/[threadId]/suggest/route.ts",
    ],
    ["messages.write ensure", "app/api/admin/inbox/threads/ensure/route.ts"],
    ["messages.delete", "app/api/admin/inbox/messages/[messageId]/route.ts"],
    [
      "messages.send retry",
      "app/api/admin/inbox/messages/[messageId]/retry/route.ts",
    ],
  ])("keeps %s behind the SQL staff-scope boundary", (_label, route) => {
    expect(source(route)).toContain("genericInboxThreadScopeCondition()");
  });

  it("applies the boundary to every independent aggregate and second-phase fetch", () => {
    expect(
      occurrences(
        source("app/api/admin/inbox/threads/route.ts"),
        "genericInboxThreadScopeCondition()",
      ),
    ).toBeGreaterThanOrEqual(3);
    expect(
      occurrences(
        source("app/api/admin/inbox/timeline/route.ts"),
        "genericInboxThreadScopeCondition()",
      ),
    ).toBeGreaterThanOrEqual(4);
    expect(
      occurrences(
        source("app/api/admin/inbox/export/jsonl/route.ts"),
        "genericInboxThreadScopeCondition()",
      ),
    ).toBeGreaterThanOrEqual(2);
    expect(
      occurrences(
        source("app/api/admin/inbox/threads/[threadId]/route.ts"),
        "genericInboxThreadScopeCondition()",
      ),
    ).toBeGreaterThanOrEqual(3);
    expect(
      occurrences(
        source("app/api/admin/inbox/threads/[threadId]/messages/route.ts"),
        "genericInboxThreadScopeCondition()",
      ),
    ).toBeGreaterThanOrEqual(2);
  });
});
