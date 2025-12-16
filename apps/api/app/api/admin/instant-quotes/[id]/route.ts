import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getDb, instantQuotes } from "@/db";
import { isAdminRequest } from "../../../web/admin";
import { eq } from "drizzle-orm";

type RouteContext = {
  params: Promise<{ id?: string }>;
};

export async function DELETE(request: NextRequest, context: RouteContext): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ error: "instant_quote_id_required" }, { status: 400 });
  }

  const db = getDb();
  const [deleted] = await db
    .delete(instantQuotes)
    .where(eq(instantQuotes.id, id))
    .returning({ id: instantQuotes.id });

  if (!deleted?.id) {
    return NextResponse.json({ error: "instant_quote_not_found" }, { status: 404 });
  }

  return NextResponse.json({ deleted: true });
}

