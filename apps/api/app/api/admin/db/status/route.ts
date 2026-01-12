import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { isAdminRequest } from "../../../web/admin";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function hasColumn(db: ReturnType<typeof getDb>, table: string, column: string): Promise<boolean> {
  const res = await db.execute(
    sql`
      select count(*)::int as cnt
      from information_schema.columns
      where table_schema='public' and table_name=${table} and column_name=${column}
    `
  );
  const row = Array.isArray(res) && res[0] ? (res[0] as any) : null;
  return Number(row?.cnt ?? 0) > 0;
}

export async function GET(request: NextRequest) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  try {
    const db = getDb();

    const tablesRes = await db.execute(
      sql`select table_name from information_schema.tables where table_schema='public' order by table_name`
    );
    const tables = Array.isArray(tablesRes)
      ? tablesRes.map((r: any) => r.table_name)
      : [];

    let migrations = 0;
    try {
      const migRes = await db.execute(sql`select count(*)::int as cnt from drizzle.__drizzle_migrations`);
      const row = Array.isArray(migRes) && migRes[0] ? (migRes[0] as any) : null;
      migrations = Number(row?.cnt ?? 0);
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
