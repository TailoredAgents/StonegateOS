import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.cwd(), "../..");

function source(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

describe("partner job list filter contract", () => {
  it("supports bounded multi-status views and date ranges without weakening cursor binding", () => {
    const route = source("apps/api/app/api/portal/v2/jobs/route.ts");
    const page = source(
      "apps/site/src/app/partners/(portal)/bookings/page.tsx",
    );

    expect(route).toContain("statuses.length > JOB_STATUSES.size");
    expect(route).toContain("new Set(statuses).size !== statuses.length");
    expect(route).toContain(
      "inArray(partnerBookings.publicStatus, normalizedFilters.statuses)",
    );
    expect(route).toContain("filterHash");
    expect(page).toContain('label: "Needs attention"');
    expect(page).toContain('label: "History"');
    expect(page).toContain('type="date"');
    expect(page).toContain('aria-current={active ? "page" : undefined}');
  });
});
