import { NextRequest, NextResponse } from "next/server";
import { getDb, instantQuotes } from "@/db";
import { desc } from "drizzle-orm";
import { isAdminRequest } from "../../web/admin";

export async function GET(request: NextRequest) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const db = getDb();
  const rows = await db.select().from(instantQuotes).orderBy(desc(instantQuotes.createdAt)).limit(50);
  return NextResponse.json({ quotes: rows });
}
