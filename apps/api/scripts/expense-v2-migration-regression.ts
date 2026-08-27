import "dotenv/config";

import assert from "node:assert/strict";
import postgres from "postgres";

type Mode = "seed" | "verify";

type FixtureRow = {
  id: string;
  category: string;
  categoryId: string | null;
  categoryNeedsReview: boolean;
  lifecycleStatus: string;
  version: number;
  createdAtEpoch: string | number;
  updatedAtEpoch: string | number;
  postedAtEpoch: string | number | null;
  allocationCount: string | number;
  allocationCents: string | number;
};

const POSTED_DUMP_ID = "71070000-0000-4000-8000-000000000001";
const DRAFT_DUMP_ID = "71070000-0000-4000-8000-000000000002";
const FUEL_ID = "71070000-0000-4000-8000-000000000003";
const UNKNOWN_ID = "71070000-0000-4000-8000-000000000004";

const expectedRows = [
  {
    id: POSTED_DUMP_ID,
    category: "Dump",
    categoryId: "dump_fees",
    categoryNeedsReview: false,
    lifecycleStatus: "posted",
    version: 4,
    createdAtEpoch: 1_777_645_860,
    updatedAtEpoch: 1_777_645_920,
    postedAtEpoch: 1_777_645_860,
    allocationCount: 1,
    allocationCents: 12_500,
  },
  {
    id: DRAFT_DUMP_ID,
    category: "  DUMP!! ",
    categoryId: "dump_fees",
    categoryNeedsReview: false,
    lifecycleStatus: "draft",
    version: 2,
    createdAtEpoch: 1_777_732_260,
    updatedAtEpoch: 1_777_732_320,
    postedAtEpoch: null,
    allocationCount: 1,
    allocationCents: 2_500,
  },
  {
    id: FUEL_ID,
    category: "Fuel",
    categoryId: "fuel",
    categoryNeedsReview: false,
    lifecycleStatus: "posted",
    version: 3,
    createdAtEpoch: 1_777_818_660,
    updatedAtEpoch: 1_777_818_720,
    postedAtEpoch: 1_777_818_660,
    allocationCount: 1,
    allocationCents: 5_000,
  },
  {
    id: UNKNOWN_ID,
    category: "Special historical cost",
    categoryId: null,
    categoryNeedsReview: true,
    lifecycleStatus: "posted",
    version: 5,
    createdAtEpoch: 1_777_905_060,
    updatedAtEpoch: 1_777_905_120,
    postedAtEpoch: 1_777_905_060,
    allocationCount: 0,
    allocationCents: 0,
  },
] as const;

function parseMode(): Mode {
  const args = process.argv.slice(2).filter((argument) => argument !== "--");
  if (args.length !== 1 || (args[0] !== "seed" && args[0] !== "verify")) {
    throw new Error("Usage: expense-v2-migration-regression.ts <seed|verify>");
  }
  return args[0];
}

function shouldUseSsl(connectionString: string): boolean {
  return (
    process.env["DATABASE_SSL"] === "true" ||
    /render\.com/u.test(connectionString) ||
    /sslmode=require/u.test(connectionString)
  );
}

function integer(value: string | number): number {
  const parsed = Number(value);
  assert.ok(Number.isSafeInteger(parsed), `Expected an integer, got ${value}`);
  return parsed;
}

async function seed(sql: ReturnType<typeof postgres>): Promise<void> {
  const hasV2Column = await sql<Array<{ exists: boolean }>>`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'expenses'
        AND column_name = 'category_id'
    ) AS "exists"
  `;
  assert.equal(
    hasV2Column[0]?.exists,
    false,
    "Seed must run against the 0101 production prefix",
  );

  await sql`
    INSERT INTO "expenses" (
      "id",
      "amount_cents",
      "category",
      "vendor",
      "source",
      "paid_at",
      "created_at",
      "updated_at",
      "lifecycle_status",
      "version",
      "posted_at"
    ) VALUES
      (
        ${POSTED_DUMP_ID}, 12500, 'Dump', 'Legacy Dump Vendor', 'manual',
        '2026-05-01T14:30:00Z', '2026-05-01T14:31:00Z',
        '2026-05-01T14:32:00Z', 'posted', 4, '2026-05-01T14:31:00Z'
      ),
      (
        ${DRAFT_DUMP_ID}, 2500, '  DUMP!! ', 'Draft Dump Vendor', 'manual',
        '2026-05-02T14:30:00Z', '2026-05-02T14:31:00Z',
        '2026-05-02T14:32:00Z', 'draft', 2, NULL
      ),
      (
        ${FUEL_ID}, 5000, 'Fuel', 'Fuel Vendor', 'manual',
        '2026-05-03T14:30:00Z', '2026-05-03T14:31:00Z',
        '2026-05-03T14:32:00Z', 'posted', 3, '2026-05-03T14:31:00Z'
      ),
      (
        ${UNKNOWN_ID}, 7500, 'Special historical cost', 'Unknown Vendor',
        'manual', '2026-05-04T14:30:00Z', '2026-05-04T14:31:00Z',
        '2026-05-04T14:32:00Z', 'posted', 5, '2026-05-04T14:31:00Z'
      )
  `;
  console.log("[expense-v2:migration-regression] legacy fixtures seeded");
}

async function verify(sql: ReturnType<typeof postgres>): Promise<void> {
  const rows = await sql<FixtureRow[]>`
    SELECT
      e."id"::text AS "id",
      e."category" AS "category",
      e."category_id" AS "categoryId",
      e."category_needs_review" AS "categoryNeedsReview",
      e."lifecycle_status"::text AS "lifecycleStatus",
      e."version" AS "version",
      extract(epoch FROM e."created_at")::bigint AS "createdAtEpoch",
      extract(epoch FROM e."updated_at")::bigint AS "updatedAtEpoch",
      extract(epoch FROM e."posted_at")::bigint AS "postedAtEpoch",
      count(a."id")::bigint AS "allocationCount",
      coalesce(sum(a."amount_cents"), 0)::bigint AS "allocationCents"
    FROM "expenses" e
    LEFT JOIN "expense_allocations" a ON a."expense_id" = e."id"
    WHERE e."id" IN (
      ${POSTED_DUMP_ID},
      ${DRAFT_DUMP_ID},
      ${FUEL_ID},
      ${UNKNOWN_ID}
    )
    GROUP BY e."id"
    ORDER BY e."id"
  `;

  assert.equal(rows.length, expectedRows.length);
  assert.deepEqual(
    rows.map((row) => ({
      ...row,
      createdAtEpoch: integer(row.createdAtEpoch),
      updatedAtEpoch: integer(row.updatedAtEpoch),
      postedAtEpoch:
        row.postedAtEpoch == null ? null : integer(row.postedAtEpoch),
      allocationCount: integer(row.allocationCount),
      allocationCents: integer(row.allocationCents),
    })),
    expectedRows,
  );

  const triggers = await sql<Array<{ name: string; enabled: string }>>`
    SELECT t.tgname AS "name", t.tgenabled AS "enabled"
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    WHERE t.tgname IN (
      'expenses_lifecycle_transition_guard',
      'expenses_v2_evidence_guard',
      'expense_allocations_immutability_guard'
    )
    ORDER BY t.tgname
  `;
  assert.deepEqual(
    triggers.map((trigger) => ({ ...trigger })),
    [
      { name: "expense_allocations_immutability_guard", enabled: "O" },
      { name: "expenses_lifecycle_transition_guard", enabled: "O" },
      { name: "expenses_v2_evidence_guard", enabled: "O" },
    ],
  );

  await sql.unsafe(`
    DO $guard_check$
    BEGIN
      BEGIN
        UPDATE "expenses"
        SET "category_id" = 'fuel', "version" = "version" + 1
        WHERE "id" = '${POSTED_DUMP_ID}';
        RAISE EXCEPTION 'expenses_v2_evidence_guard did not reject mutation';
      EXCEPTION
        WHEN SQLSTATE '55000' THEN
          IF SQLERRM <> 'posted expense v2 evidence is immutable' THEN
            RAISE;
          END IF;
      END;

      BEGIN
        UPDATE "expense_allocations"
        SET "amount_cents" = "amount_cents" - 1
        WHERE "expense_id" = '${POSTED_DUMP_ID}';
        RAISE EXCEPTION 'expense allocation guard did not reject mutation';
      EXCEPTION
        WHEN SQLSTATE '55000' THEN
          IF SQLERRM <> 'posted expense allocations are immutable' THEN
            RAISE;
          END IF;
      END;
    END
    $guard_check$;
  `);

  console.log(
    "[expense-v2:migration-regression] populated 0101→latest upgrade verified",
  );
}

async function main(): Promise<void> {
  const mode = parseMode();
  const connectionString = process.env["DATABASE_URL"]?.trim();
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  const sql = postgres(connectionString, {
    max: 1,
    prepare: false,
    idle_timeout: 5,
    ...(shouldUseSsl(connectionString)
      ? { ssl: { rejectUnauthorized: false } }
      : {}),
  });

  try {
    if (mode === "seed") {
      await seed(sql);
    } else {
      await verify(sql);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error("[expense-v2:migration-regression] failed", error);
  process.exitCode = 1;
});
