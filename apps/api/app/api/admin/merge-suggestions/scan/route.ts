import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { scanMergeSuggestions } from "@/lib/merge-queue";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { isAdminRequest } from "../../../web/admin";

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = (await request.json().catch(() => null)) as {
    sinceDays?: number;
    limit?: number;
    minConfidence?: number;
  } | null;

  const result = await scanMergeSuggestions({
    sinceDays: typeof payload?.sinceDays === "number" ? payload.sinceDays : undefined,
    limit: typeof payload?.limit === "number" ? payload.limit : undefined,
    minConfidence: typeof payload?.minConfidence === "number" ? payload.minConfidence : undefined
  });

  await recordAuditEvent({
    actor: getAuditActorFromRequest(request),
    action: "merge.suggestions.scanned",
    entityType: "merge_suggestion",
    meta: result
  });

  return NextResponse.json({ ok: true, ...result });
}
