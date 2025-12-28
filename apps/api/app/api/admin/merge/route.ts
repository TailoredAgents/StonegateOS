import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { mergeContacts } from "@/lib/merge-queue";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../web/admin";

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "contacts.merge");
  if (permissionError) return permissionError;

  const payload = (await request.json().catch(() => null)) as {
    sourceContactId?: string;
    targetContactId?: string;
    reason?: string;
  } | null;

  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const sourceContactId =
    typeof payload.sourceContactId === "string" ? payload.sourceContactId.trim() : "";
  const targetContactId =
    typeof payload.targetContactId === "string" ? payload.targetContactId.trim() : "";

  if (!sourceContactId || !targetContactId) {
    return NextResponse.json({ error: "contact_ids_required" }, { status: 400 });
  }

  if (sourceContactId === targetContactId) {
    return NextResponse.json({ error: "same_contact" }, { status: 400 });
  }

  const actor = getAuditActorFromRequest(request);
  const reason = typeof payload.reason === "string" && payload.reason.trim().length > 0 ? payload.reason.trim() : "manual";

  let mergeResult: Awaited<ReturnType<typeof mergeContacts>>;
  try {
    mergeResult = await mergeContacts({ sourceContactId, targetContactId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "merge_failed";
    const status = message === "contact_not_found" ? 404 : 400;
    return NextResponse.json({ error: message }, { status });
  }

  await recordAuditEvent({
    actor,
    action: "contact.merged",
    entityType: "contact",
    entityId: targetContactId,
    meta: {
      sourceContactId,
      reason,
      moved: mergeResult.moved,
      updatedFields: mergeResult.updatedFields
    }
  });

  return NextResponse.json({ ok: true, targetContactId });
}
