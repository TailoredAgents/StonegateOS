import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { recordAuditEvent, getAuditActorFromRequest } from "@/lib/audit";
import { backfillFacebookDmContactNames } from "@/lib/facebook-dm-name-backfill";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../../web/admin";

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "messages.send");
  if (permissionError) return permissionError;

  let rawBody: unknown = {};
  try {
    rawBody = await request.json();
  } catch {
    rawBody = {};
  }

  const body = rawBody && typeof rawBody === "object" ? (rawBody as Record<string, unknown>) : {};
  const limitInput = body["limit"];
  const dryRun = body["dryRun"] === true;
  const contactIdFilter = typeof body["contactId"] === "string" ? body["contactId"].trim() : "";

  const limit = typeof limitInput === "number" && limitInput > 0 ? Math.min(limitInput, 100) : 25;
  const result = await backfillFacebookDmContactNames({
    limit,
    dryRun,
    contactId: contactIdFilter || null
  });

  await recordAuditEvent({
    actor: getAuditActorFromRequest(request),
    action: "facebook.dm.name_backfill",
    entityType: "conversation_thread",
    entityId: result.updates[0]?.threadId ?? null,
    meta: {
      dryRun,
      requestedLimit: limit,
      contactIdFilter: contactIdFilter || null,
      candidates: result.candidates,
      updated: result.updated,
      missingMessage: result.missingMessage,
      unresolved: result.unresolved
    }
  });

  return NextResponse.json({
    ok: true,
    dryRun,
    candidates: result.candidates,
    updated: result.updated,
    missingMessage: result.missingMessage,
    unresolved: result.unresolved,
    updates: result.updates.slice(0, 20)
  });
}
