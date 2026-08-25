import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workspaceRoot = resolve(__dirname, "../../../..");
const read = (path: string): string =>
  readFileSync(resolve(workspaceRoot, path), "utf8");

const schema = read("apps/api/src/db/schema.ts");
const migration = read(
  "apps/api/src/db/migrations/0099_team_version_precision.sql",
);
const journal = JSON.parse(
  read("apps/api/src/db/migrations/meta/_journal.json"),
) as {
  entries: Array<{
    idx: number;
    version: string;
    when: number;
    tag: string;
    breakpoints: boolean;
  }>;
};

const versionTables = [
  {
    schemaExport: "contacts",
    sqlTable: "contacts",
    casPath: "apps/api/src/lib/partner-operations.ts",
    casNeedle: "eq(contacts.updatedAt, existing.updatedAt)",
  },
  {
    schemaExport: "crmPipeline",
    sqlTable: "crm_pipeline",
    casPath: "apps/api/app/api/admin/crm/pipeline/[contactId]/route.ts",
    casNeedle: "eq(crmPipeline.updatedAt, input.previousUpdatedAt)",
  },
  {
    schemaExport: "crmTasks",
    sqlTable: "crm_tasks",
    casPath: "apps/api/app/api/admin/crm/reminders/[taskId]/route.ts",
    casNeedle: "eq(crmTasks.updatedAt, existing.updatedAt)",
  },
  {
    schemaExport: "teamRoles",
    sqlTable: "team_roles",
    casPath: "apps/api/app/api/admin/roles/[roleId]/route.ts",
    casNeedle: "eq(teamRoles.updatedAt, currentRole.updatedAt)",
  },
  {
    schemaExport: "teamMembers",
    sqlTable: "team_members",
    casPath: "apps/api/app/api/admin/team/members/[memberId]/route.ts",
    casNeedle: "eq(teamMembers.updatedAt, currentMember.updatedAt)",
  },
  {
    schemaExport: "mergeSuggestions",
    sqlTable: "merge_suggestions",
    casPath: "apps/api/src/lib/merge-queue.ts",
    casNeedle: "eq(mergeSuggestions.updatedAt, current.updatedAt)",
  },
  {
    schemaExport: "partnerUsers",
    sqlTable: "partner_users",
    casPath: "apps/api/app/api/admin/partners/users/route.ts",
    casNeedle: "eq(partnerUsers.updatedAt, user.updatedAt)",
  },
  {
    schemaExport: "partnerRateCards",
    sqlTable: "partner_rate_cards",
    casPath: "apps/api/app/api/admin/partners/rates/route.ts",
    casNeedle: "eq(partnerRateCards.updatedAt, existing.updatedAt)",
  },
  {
    schemaExport: "googleAdsAnalystRecommendations",
    sqlTable: "google_ads_analyst_recommendations",
    casPath: "apps/api/src/lib/google-ads-recommendation-operations.ts",
    casNeedle: "eq(googleAdsAnalystRecommendations.updatedAt, row.updatedAt)",
  },
  {
    schemaExport: "staffNotificationOperations",
    sqlTable: "staff_notification_operations",
    casPath:
      "apps/api/app/api/admin/partners/staff-notifications/reconciliation/route.ts",
    casNeedle: "eq(staffNotificationOperations.updatedAt, operation.updatedAt)",
  },
  {
    schemaExport: "paymentAttempts",
    sqlTable: "payment_attempts",
    casPath: "apps/api/src/lib/payment-reconciliation-admin.ts",
    casNeedle: "eq(paymentAttempts.updatedAt, before.updatedAt)",
  },
  {
    schemaExport: "payments",
    sqlTable: "payments",
    casPath: "apps/api/app/api/payments/[id]/detach/route.ts",
    casNeedle: "eq(payments.updatedAt, before.updatedAt)",
  },
  {
    schemaExport: "paymentRefunds",
    sqlTable: "payment_refunds",
    casPath: "apps/api/src/lib/payment-reconciliation-admin.ts",
    casNeedle: "eq(paymentRefunds.updatedAt, before.updatedAt)",
  },
] as const;

function schemaBlock(exportName: string): string {
  const start = schema.indexOf(`export const ${exportName} = pgTable`);
  expect(start).toBeGreaterThan(-1);
  const next = schema.indexOf("\nexport const ", start + 1);
  return schema.slice(start, next === -1 ? schema.length : next);
}

describe("/team optimistic-concurrency timestamp precision", () => {
  it("documents why PostgreSQL microseconds cannot be used as JavaScript ISO tokens", () => {
    const postgresTimestamp = "2026-08-09T11:13:40.651796Z";
    expect(new Date(postgresTimestamp).toISOString()).toBe(
      "2026-08-09T11:13:40.651Z",
    );
  });

  it.each(versionTables)(
    "uses millisecond precision for $sqlTable because its SQL CAS consumes a JavaScript Date",
    ({ schemaExport, casPath, casNeedle }) => {
      expect(schemaBlock(schemaExport)).toContain(
        'timestamp("updated_at", { withTimezone: true, precision: 3 })',
      );
      expect(read(casPath)).toContain(casNeedle);
    },
  );

  it("normalizes exactly the 13 additional timestamp-CAS tables", () => {
    const migratedTables = Array.from(
      migration.matchAll(/^    '([^']+)'[,]?$/gmu),
      (match) => match[1],
    );

    expect(migratedTables).toHaveLength(versionTables.length);
    expect(new Set(migratedTables)).toEqual(
      new Set(versionTables.map(({ sqlTable }) => sqlTable)),
    );
    expect(migration).toContain(
      "ALTER COLUMN updated_at TYPE timestamp(3) with time zone",
    );
    expect(migration).toContain(
      "WHEN feature_not_supported OR dependent_objects_still_exist",
    );
    expect(migration).not.toContain("'appointments'");
    expect(migration).not.toContain("created_at");
  });

  it("registers migration 0099 after the appointment precision migration", () => {
    const previous = journal.entries.at(-3);
    const current = journal.entries.at(-2);
    const next = journal.entries.at(-1);

    expect(previous).toMatchObject({
      idx: 95,
      version: "7",
      tag: "0098_appointment_version_precision",
      breakpoints: true,
    });
    expect(current).toMatchObject({
      idx: 96,
      version: "7",
      tag: "0099_team_version_precision",
      breakpoints: true,
    });
    expect(current?.when).toBeGreaterThan(previous?.when ?? 0);
    expect(next).toMatchObject({
      idx: 97,
      version: "7",
      tag: "0100_fixed_crew_job_rates",
      breakpoints: true,
    });
    expect(next?.when).toBeGreaterThan(current?.when ?? 0);
  });
});
