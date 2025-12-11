import { NextRequest, NextResponse } from "next/server";
import { getDb, instantQuotes } from "@/db";
import { desc, eq } from "drizzle-orm";
import { isAdminRequest } from "../../web/admin";

export async function GET(request: NextRequest) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const db = getDb();
  const { searchParams } = request.nextUrl;
  const id = searchParams.get("id");
  const baseQuery = db.select().from(instantQuotes).orderBy(desc(instantQuotes.createdAt));
  const rows = id ? await baseQuery.where(eq(instantQuotes.id, id)).limit(1) : await baseQuery.limit(50);
  return NextResponse.json({ quotes: rows });
}
