import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { loadOmniLeadContext } from "@/lib/omni-lead-context";
import { buildSalesAgentMemory, getSalesAgentMemory, upsertSalesAgentMemory } from "@/lib/sales-agent-memory";
import { isAdminRequest } from "../../../../web/admin";

type RouteContext = {
  params: Promise<{ contactId?: string }>;
};

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export async function GET(request: NextRequest, context: RouteContext): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { contactId } = await context.params;
  const contactIdTrimmed = typeof contactId === "string" ? contactId.trim() : "";
  if (!contactIdTrimmed || !isUuid(contactIdTrimmed)) {
    return NextResponse.json({ error: "contact_id_required" }, { status: 400 });
  }

  const includeQuotePrice = request.nextUrl.searchParams.get("includeQuotePrice") === "1";
  const db = getDb();

  const liveContext = await loadOmniLeadContext(db, {
    contactId: contactIdTrimmed,
    includeQuotePrice,
  });
  if (!liveContext) {
    return NextResponse.json({ error: "contact_not_found" }, { status: 404 });
  }

  let memory = await getSalesAgentMemory(db, contactIdTrimmed);
  if (!memory) {
    memory = await upsertSalesAgentMemory(db, {
      contactId: contactIdTrimmed,
      leadId: liveContext.latestLead?.id ?? null,
      memory: buildSalesAgentMemory(liveContext),
    });
  }

  return NextResponse.json({
    ok: true,
    memory,
    liveContext,
  });
}
