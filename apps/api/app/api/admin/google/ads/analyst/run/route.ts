import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getDb, outboxEvents } from "@/db";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../../../web/admin";
import { getAuditActorFromRequest } from "@/lib/audit";

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const permissionError = await requirePermission(request, "policy.write");
  if (permissionError) return permissionError;

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const rangeDaysRaw = body["rangeDays"];
  const rangeDays =
    typeof rangeDaysRaw === "number"
      ? rangeDaysRaw
      : typeof rangeDaysRaw === "string"
        ? Number(rangeDaysRaw)
        : NaN;

  const payload: Record<string, unknown> = {
    invokedBy: "admin",
    rangeDays: Number.isFinite(rangeDays) ? Math.min(Math.max(Math.floor(rangeDays), 1), 30) : 7
  };

  const actor = getAuditActorFromRequest(request);
  if (actor.id) payload["createdBy"] = actor.id;

  const db = getDb();
  const [event] = await db
    .insert(outboxEvents)
    .values({
      type: "google.ads_analyst.run",
      payload
    })
    .returning({ id: outboxEvents.id });

  return NextResponse.json({ ok: true, queued: true, id: event?.id ?? null });
}

