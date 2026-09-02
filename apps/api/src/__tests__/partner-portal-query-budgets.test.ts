import fs from "node:fs";
import path from "node:path";

function source(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("Partner Portal large-account query budgets", () => {
  test("job and location directories use bounded keyset pages", () => {
    for (const routePath of [
      "app/api/portal/v2/jobs/route.ts",
      "app/api/portal/v2/locations/route.ts",
    ]) {
      const route = source(routePath);
      expect(route).toContain("parsePortalV2Pagination(");
      expect(route).toContain("maximumLimit: 100");
      expect(route).toContain("pagination.limit + 1");
      expect(route).toContain("nextCursor");
    }
  });

  test("operations aggregation is bounded and backed by account-list indexes", () => {
    const report = source("src/lib/partner-portal-operations-reporting.ts");
    const schema = source("src/db/schema.ts");
    const migration = source(
      "src/db/migrations/0161_partner_portal_operations_query_budgets.sql",
    );

    expect(report).toContain(".limit(200)");
    expect(report).toContain('eq(webEventCountsDaily.event, "partner_funnel")');
    for (const indexName of [
      "web_event_counts_daily_partner_funnel_date_key_idx",
      "partner_bookings_account_created_id_idx",
      "partner_bookings_account_service_created_id_idx",
      "partner_bookings_account_property_created_id_idx",
      "partner_account_locations_account_active_site_id_idx",
      "partner_account_locations_account_site_id_idx",
    ]) {
      expect(schema).toContain(indexName);
      expect(migration).toContain(indexName);
    }
  });

  test("operations visibility is permission-gated, no-store, and correlated", () => {
    const route = source(
      "app/api/admin/partner-management/v1/operations/route.ts",
    );
    expect(route).toContain('"partners.accounts.read"');
    expect(route).toContain('"Cache-Control": "private, no-store, max-age=0"');
    expect(route).toContain('"x-correlation-id": correlationId');
    expect(route).toContain("PARTNER_OPERATIONS_RANGE_DAYS");
  });
});
