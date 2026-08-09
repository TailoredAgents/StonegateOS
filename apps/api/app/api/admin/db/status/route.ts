import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { requirePermission } from "@/lib/permissions";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function firstRecord(value: unknown): Record<string, unknown> | null {
  if (!Array.isArray(value)) return null;
  const first: unknown = value[0];
  return isRecord(first) ? first : null;
}

async function hasColumn(db: ReturnType<typeof getDb>, table: string, column: string): Promise<boolean> {
  const res = await db.execute(
    sql`
      select count(*)::int as cnt
      from information_schema.columns
      where table_schema='public' and table_name=${table} and column_name=${column}
    `
  );
  const row = firstRecord(res);
  return Number(row?.["cnt"] ?? 0) > 0;
}

export async function GET(request: NextRequest) {
  const permissionError = await requirePermission(request, "access.manage");
  if (permissionError) return permissionError;

  try {
    const db = getDb();

    const tablesRes = await db.execute(
      sql`select table_name from information_schema.tables where table_schema='public' order by table_name`
    );
    const tables = Array.isArray(tablesRes)
      ? tablesRes.flatMap((row) =>
          isRecord(row) && typeof row["table_name"] === "string"
            ? [row["table_name"]]
            : []
        )
      : [];

    let migrations = 0;
    try {
      const migRes = await db.execute(sql`select count(*)::int as cnt from drizzle.__drizzle_migrations`);
      const row = firstRecord(migRes);
      migrations = Number(row?.["cnt"] ?? 0);
    } catch {
      migrations = 0;
    }

    const columns = {
      contacts_salesperson_member_id: await hasColumn(db, "contacts", "salesperson_member_id"),
      team_members_default_crew_split_bps: await hasColumn(db, "team_members", "default_crew_split_bps"),
      appointments_completed_at: await hasColumn(db, "appointments", "completed_at"),
      appointments_sold_by_member_id: await hasColumn(db, "appointments", "sold_by_member_id"),
      appointments_marketing_member_id: await hasColumn(db, "appointments", "marketing_member_id"),
      appointments_quoted_total_cents: await hasColumn(db, "appointments", "quoted_total_cents"),
      appointments_final_total_cents: await hasColumn(db, "appointments", "final_total_cents")
    };

    const url = process.env["DATABASE_URL"] ?? "";
    const redacted = url.replace(/:[^:@/]+@/, ":***@");

    return NextResponse.json({ ok: true, databaseUrl: redacted, tables, migrations, columns });
  } catch (error) {
    const err = isRecord(error) ? error : null;
    return NextResponse.json({ ok: false, error: String(error), detail: err?.["message"] ?? null }, { status: 500 });
  }
}
