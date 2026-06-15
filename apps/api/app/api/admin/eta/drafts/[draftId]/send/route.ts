import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getAuditActorFromRequest } from "@/lib/audit";
import { sendEtaDraft } from "@/lib/eta-agent";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../../../web/admin";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ draftId: string }> },
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "messages.send");
  if (permissionError) return permissionError;

  const { draftId } = await context.params;
  const result = await sendEtaDraft({
    draftId,
    actor: getAuditActorFromRequest(request),
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({ ok: true, messageId: result.messageId });
}
