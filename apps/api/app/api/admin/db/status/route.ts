import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { isAdminRequest } from "../../../web/admin";

export async function GET(request: NextRequest) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  try {
    const db = getDb();

    const tablesRes = await db.execute(
      sql`select table_name from information_schema.tables where table_schema='public' order by table_name`
    );
    const tables = Array.isArray(tablesRes.rows)
      ? tablesRes.rows.map((r: any) => r.table_name)
      : [];

    let migrations = 0;
    try {
      const migRes = await db.execute(sql`select count(*)::int as cnt from drizzle.__drizzle_migrations`);
      const row = Array.isArray(migRes.rows) && migRes.rows[0] ? (migRes.rows[0] as any) : null;
      migrations = Number(row?.cnt ?? 0);
    } catch {
      migrations = 0;
    }

    const url = process.env["DATABASE_URL"] ?? "";
    const redacted = url.replace(/:[^:@/]+@/, ":***@");

    return NextResponse.json({ ok: true, databaseUrl: redacted, tables, migrations });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}
