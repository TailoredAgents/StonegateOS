import { readFileSync } from "node:fs";
import { join } from "node:path";

const apiRoute = readFileSync(
  join(process.cwd(), "app/api/admin/sales/activity/route.ts"),
  "utf8",
);
const siteSection = readFileSync(
  join(
    process.cwd(),
    "../site/src/app/team/components/SalesActivityLogSection.tsx",
  ),
  "utf8",
);
const teamPage = readFileSync(
  join(process.cwd(), "../site/src/app/team/page.tsx"),
  "utf8",
);

describe("Sales HQ Activity experience", () => {
  it("uses bounded snapshot-stable cursor pages with exact totals", () => {
    expect(apiRoute).toContain(
      "parseSalesActivityQuery(request.nextUrl.searchParams)",
    );
    expect(apiRoute).toContain('"sales_activity_created_at_key"');
    expect(apiRoute).toContain("to_char(");
    expect(apiRoute).toContain(".limit(limit + 1)");
    expect(apiRoute).toContain("activityAtOrBefore(snapshot)");
    expect(apiRoute).toContain("buildSalesActivityPageMetadata({");
    expect(apiRoute).toContain("staleSalesActivityPage()");
    expect(apiRoute).not.toContain(".offset(offset)");
  });

  it("preserves member, filter, and opaque cursor state in canonical URLs", () => {
    expect(teamPage).toContain("salesCursor?: string | string[]");
    expect(teamPage).toContain("cursor: salesCursorParam");
    expect(teamPage).toContain("rangeDays: salesRangeDaysParam");
    expect(siteSection).toContain('appendActivitySearchValue(qs, "limit"');
    expect(siteSection).toContain('action={teamSurfaceHref("sales-log")}');
    expect(siteSection).toContain('name="salesRangeDays"');
    expect(siteSection).toContain('aria-label="Sales activity pages"');
    expect(siteSection).toContain("memberId: selectedMemberId");
    expect(siteSection).toContain("salesCursor: nextCursor");
    expect(siteSection).toContain("Return newest");
    expect(siteSection).not.toContain("salesOffset");
  });

  it("does not disguise upstream or member-directory failures as empty data", () => {
    expect(siteSection).not.toContain(
      'throw new Error("Failed to load sales activity")',
    );
    expect(siteSection).toContain("Sales Activity could not be loaded");
    expect(siteSection).toContain("This is not an empty activity history");
    expect(siteSection).toContain("Team-member filters are unavailable");
    expect(siteSection).toContain("Activity data is still available");
    expect(siteSection).toContain('role="alert"');
  });

  it("projects audit metadata into privacy-safe context with direct CRM links", () => {
    const publicEvents = apiRoute.slice(
      apiRoute.indexOf("const events = rows.map"),
      apiRoute.indexOf("const holdFilters"),
    );
    expect(apiRoute).toContain("publicSalesActivityContext({");
    expect(publicEvents).toContain("context:");
    expect(publicEvents).not.toContain("meta: row.meta ?? null");
    expect(siteSection).not.toContain('getMetaString(event.meta, "to")');
    expect(siteSection).not.toContain('getMetaString(event.meta, "from")');
    expect(siteSection).toContain('teamSurfaceHref("inbox"');
    expect(siteSection).toContain("Conversation");
    expect(siteSection).toContain("Call coaching");
  });

  it("shows durable automated-call terminal and reconciliation outcomes", () => {
    expect(siteSection).toContain("Customer was not connected");
    expect(siteSection).toContain("Automated call was not placed");
    expect(siteSection).toContain("Call result needs reconciliation");
  });
});
