import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { contacts, getDb } from "@/db";
import { loadOmniThreadFacts } from "@/lib/omni-thread-context";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../../web/admin";
import { and, eq, isNull } from "drizzle-orm";

type RouteContext = {
  params: Promise<{ contactId?: string }>;
};

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

export async function GET(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "contacts.read");
  if (permissionError) return permissionError;

  const { contactId } = await context.params;
  const contactIdTrimmed =
    typeof contactId === "string" ? contactId.trim() : "";
  if (!contactIdTrimmed || !isUuid(contactIdTrimmed)) {
    return NextResponse.json({ error: "contact_id_required" }, { status: 400 });
  }

  const url = new URL(request.url);
  const includeQuotePrice = url.searchParams.get("includeQuotePrice") === "1";

  const db = getDb();
  const [activeContact] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      and(
        eq(contacts.id, contactIdTrimmed),
        isNull(contacts.deletedAt),
      ),
    )
    .limit(1);
  if (!activeContact) {
    return NextResponse.json({ error: "contact_not_found" }, { status: 404 });
  }
  const facts = await loadOmniThreadFacts(db, {
    threadId: ZERO_UUID,
    contactId: contactIdTrimmed,
    threadPostalCode: null,
    includeQuotePrice,
  });

  return NextResponse.json({ ok: true, facts });
}
