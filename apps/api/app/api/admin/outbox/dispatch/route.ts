import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { processOutboxBatch } from "@/lib/outbox-processor";
import { requirePermission, resolvePermissionContext } from "@/lib/permissions";

export async function POST(request: NextRequest): Promise<Response> {
  const permissionError = await requirePermission(request, "outbox.dispatch");
  if (permissionError) return permissionError;

  const permissionContext = await resolvePermissionContext(request);
  if (permissionContext.source !== "service") {
    return NextResponse.json({ error: "forbidden", requiredPrincipal: "outbox-dispatcher" }, { status: 403 });
  }

  let rawBody: unknown = {};
  try {
    rawBody = await request.json();
  } catch {
    rawBody = {};
  }
  const limitInput =
    rawBody && typeof rawBody === "object" && "limit" in rawBody
      ? (rawBody as Record<string, unknown>)["limit"]
      : undefined;
  const limit =
    typeof limitInput === "number" && limitInput > 0 ? Math.min(limitInput, 50) : 10;

  try {
    const stats = await processOutboxBatch({ limit });
    return NextResponse.json({ ok: true, ...stats });
  } catch (error) {
    return NextResponse.json({ error: "outbox_failed", details: String(error) }, { status: 500 });
  }
}
