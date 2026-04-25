import { NextResponse } from "next/server";
import { resolveMobileSessionFromCookies } from "../../../../mobile/lib/session";
import { loadMobileOwnerSummary } from "../../../../mobile/lib/owner-summary";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await resolveMobileSessionFromCookies();

  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!session.isOwner) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const summary = await loadMobileOwnerSummary();
  return NextResponse.json({ ok: true, summary });
}
