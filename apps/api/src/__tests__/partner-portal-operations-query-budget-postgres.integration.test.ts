import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { closeDbForTests, getDb } from "@/db";

const describeWithDatabase = process.env["DATABASE_URL"]
  ? describe
  : describe.skip;

function rows(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  if (
    typeof result === "object" &&
    result !== null &&
    Array.isArray((result as { rows?: unknown }).rows)
  ) {
    return (result as { rows: Array<Record<string, unknown>> }).rows;
  }
  return [];
}

describeWithDatabase("Partner Portal operations query budgets", () => {
  afterAll(async () => {
    await closeDbForTests();
  });

  it("installs the exact bounded-report and large-account keyset indexes", async () => {
    const expected = [
      "web_event_counts_daily_partner_funnel_date_key_idx",
      "partner_bookings_account_created_id_idx",
      "partner_bookings_account_service_created_id_idx",
      "partner_bookings_account_property_created_id_idx",
      "partner_account_locations_account_active_site_id_idx",
      "partner_account_locations_account_site_id_idx",
    ];
    const result = await getDb().execute(sql`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND indexname IN (
          'web_event_counts_daily_partner_funnel_date_key_idx',
          'partner_bookings_account_created_id_idx',
          'partner_bookings_account_service_created_id_idx',
          'partner_bookings_account_property_created_id_idx',
          'partner_account_locations_account_active_site_id_idx',
          'partner_account_locations_account_site_id_idx'
        )
      ORDER BY indexname
    `);
    const indexes = rows(result);
    expect(indexes.map((row) => row["indexname"])).toEqual(
      [...expected].sort(),
    );
    for (const row of indexes) {
      const indexDefinition = row["indexdef"];
      expect(typeof indexDefinition).toBe("string");
      if (typeof indexDefinition === "string") {
        expect(indexDefinition).toMatch(/partner_account_id|partner_funnel/u);
      }
    }
  });

  it("uses indexed plans for funnel aggregation and service-filtered job pages", async () => {
    const accountId = randomUUID();
    const plans = await getDb().transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      // A nonexistent account gives competing indexes the same tiny estimate.
      // Plan against a populated temporary copy with every real index available,
      // so service selectivity is measured without depending on other tests' data.
      const bookingIndexes = rows(
        await tx.execute(sql`
        SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'partner_bookings'
      `),
      );
      await tx.execute(sql`
        CREATE TEMP TABLE partner_bookings
        (LIKE public.partner_bookings INCLUDING DEFAULTS INCLUDING CONSTRAINTS)
        ON COMMIT DROP
      `);
      for (const index of bookingIndexes) {
        const definition = index["indexdef"];
        if (
          typeof definition !== "string" ||
          !definition.includes(" ON public.partner_bookings ")
        ) {
          throw new Error("Unexpected production booking index definition");
        }
        await tx.execute(
          sql.raw(
            definition.replace(
              " ON public.partner_bookings ",
              " ON pg_temp.partner_bookings ",
            ),
          ),
        );
      }
      await tx.execute(sql`
        INSERT INTO pg_temp.partner_bookings
          (id, org_contact_id, appointment_id, partner_account_id, service_key, created_at)
        SELECT
          md5('query-budget-booking-' || n)::uuid,
          ${accountId}::uuid,
          md5('query-budget-appointment-' || n)::uuid,
          ${accountId}::uuid,
          CASE WHEN n % 100 = 0 THEN 'standard_pickup' ELSE 'other_service' END,
          '2026-08-01T00:00:00Z'::timestamptz + n * interval '1 minute'
        FROM generate_series(1, 10000) AS fixture(n)
      `);
      await tx.execute(sql`ANALYZE pg_temp.partner_bookings`);
      const funnel = await tx.execute(sql`
        EXPLAIN (FORMAT JSON)
        SELECT "key", sum("count")
        FROM "web_event_counts_daily"
        WHERE "event" = 'partner_funnel'
          AND "date_start" >= '2026-08-01'
        GROUP BY "key"
        LIMIT 200
      `);
      const jobs = await tx.execute(sql`
        EXPLAIN (FORMAT JSON)
        SELECT "id", "created_at"
        FROM "partner_bookings"
        WHERE "partner_account_id" = ${accountId}
          AND "service_key" = 'standard_pickup'
        ORDER BY "created_at" DESC, "id" DESC
        LIMIT 101
      `);
      return { funnel, jobs };
    });

    expect(JSON.stringify(rows(plans.funnel))).toContain(
      "web_event_counts_daily_partner_funnel_date_key_idx",
    );
    expect(JSON.stringify(rows(plans.jobs))).toContain(
      "partner_bookings_account_service_created_id_idx",
    );
  });
});
