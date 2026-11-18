import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db";
import { requirePermission } from "@/lib/permissions";
import {
  DraftSelectionSchema,
  individualSmsStatus,
} from "@/lib/individual-promotional-sms";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  const denied = await requirePermission(
    request,
    ["marketing.read", "contacts.read", "messages.read"],
    { mode: "all" },
  );
  if (denied) return denied;
  const selected = DraftSelectionSchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!selected.success)
    return NextResponse.json(
      { error: "Exact contactId, draftId and version are required." },
      { status: 422 },
    );
  return NextResponse.json(
    { receipt: await individualSmsStatus(getDb(), selected.data) },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
