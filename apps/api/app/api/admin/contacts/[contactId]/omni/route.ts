import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { loadOmniThreadFacts } from "@/lib/omni-thread-context";
import { isAdminRequest } from "../../../../web/admin";

type RouteContext = {
  params: Promise<{ contactId?: string }>;
};

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

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

  const url = new URL(request.url);
  const includeQuotePrice = url.searchParams.get("includeQuotePrice") === "1";

  const db = getDb();
  const facts = await loadOmniThreadFacts(db, {
    threadId: ZERO_UUID,
    contactId: contactIdTrimmed,
    threadPostalCode: null,
    includeQuotePrice
  });

  return NextResponse.json({ ok: true, facts });
}

