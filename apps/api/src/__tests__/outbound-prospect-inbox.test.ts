import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), "../..");

function source(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

describe("outbound prospect inbox contract", () => {
  it("limits prospect conversations to active imported accounts throughout the read path", () => {
    const scope = source("apps/api/src/lib/inbox-outbound-scope.ts");
    const list = source("apps/api/app/api/admin/inbox/threads/route.ts");
    const detail = source(
      "apps/api/app/api/admin/inbox/threads/[threadId]/route.ts",
    );
    const timeline = source("apps/api/app/api/admin/inbox/timeline/route.ts");

    for (const status of [
      "imported",
      "ready_for_first_touch",
      "attempting_contact",
      "conversation_active",
      "qualified_partner",
    ]) {
      expect(scope).toContain(`"${status}"`);
    }
    expect(scope).not.toContain('"active_partner"');
    expect(scope).not.toContain('"not_a_fit"');
    expect(scope).toContain("partnerAccounts.sourceCampaign");
    expect(scope).toContain("partnerAccounts.ownerMemberId");

    for (const route of [list, detail, timeline]) {
      expect(route).toContain("parseInboxThreadScope");
      expect(route).toContain("activeOutboundProspectCondition");
      expect(route).toContain("campaign");
      expect(route).toContain("outboundMemberId");
    }
    expect(list).toContain('scope === "outbound"');
    expect(detail).toContain('parsedScope.scope === "outbound"');
    expect(timeline).toContain('parsedScope.scope === "outbound"');
  });

  it("keeps the new inbox inside Partner Outreach and preserves campaign and owner scope", () => {
    const outbound = source(
      "apps/site/src/app/team/components/OutboundSection.tsx",
    );
    const loader = source("apps/site/src/app/team/inbox-loader.ts");
    const navigation = source("apps/site/src/app/team/outbound-navigation.ts");

    expect(outbound).toContain('label: "Prospect Inbox"');
    expect(outbound).toContain('scope: "outbound"');
    expect(outbound).toContain("outboundCampaign: filters.campaign");
    expect(outbound).toContain("outboundMemberId: memberId");
    expect(outbound).toContain('mode="outbound"');
    expect(outbound).toContain("outboundNavigation={{ memberId, filters }}");
    expect(navigation).toContain('"queue" | "inbox" | "import"');
    expect(loader).toContain('params.set("campaign"');
    expect(loader).toContain('params.set("memberId"');
  });

  it("derives outreach checks from recorded calls and delivered messages", () => {
    const query = source("apps/api/src/lib/outbound-queue-query.ts");
    const progress = source(
      "apps/site/src/app/team/components/OutboundOutreachProgress.tsx",
    );

    expect(query).toContain('LEFT JOIN "call_records"');
    expect(query).toContain('LEFT JOIN "conversation_messages"');
    expect(query).toContain(
      "messages.\"delivery_status\" IN ('sent', 'delivered')",
    );
    expect(query).toContain("messages.\"direction\" = 'inbound'");
    expect(progress).toContain('aria-label="Recorded outreach activity"');
    expect(progress).toContain('complete ? "✓ " : ""');
  });
});
