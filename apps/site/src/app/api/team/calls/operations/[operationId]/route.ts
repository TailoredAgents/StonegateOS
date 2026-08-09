import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { callAdminApiAs } from "@/app/team/lib/api";
import { requireTeamPrincipal } from "../../../auth";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const STATES = new Set([
  "requested",
  "dispatched",
  "active",
  "succeeded",
  "failed",
  "reconciliation_required",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ operationId?: string }> },
): Promise<Response> {
  const auth = await requireTeamPrincipal(request, {
    permissions: "calls.place",
    returnJson: true,
  });
  if (!auth.ok) return auth.response;

  const operationId = (await context.params).operationId?.trim() ?? "";
  if (!UUID_PATTERN.test(operationId)) {
    return NextResponse.json(
      { error: "invalid_call_operation_id" },
      { status: 422 },
    );
  }
  const upstream = await callAdminApiAs(
    auth.principal,
    `/api/admin/calls/operations/${operationId}`,
  );
  const payload: unknown = await upstream.json().catch(() => null);
  if (!upstream.ok) {
    return NextResponse.json(
      isRecord(payload) ? payload : { error: "call_status_unavailable" },
      { status: upstream.status },
    );
  }
  const operation =
    isRecord(payload) && isRecord(payload["operation"])
      ? payload["operation"]
      : null;
  if (
    !operation ||
    operation["id"] !== operationId ||
    typeof operation["contactId"] !== "string" ||
    !UUID_PATTERN.test(operation["contactId"]) ||
    typeof operation["state"] !== "string" ||
    !STATES.has(operation["state"]) ||
    !Number.isInteger(operation["version"]) ||
    typeof operation["contactCallBlocked"] !== "boolean"
  ) {
    return NextResponse.json(
      { error: "invalid_call_status_response" },
      { status: 502 },
    );
  }
  return NextResponse.json(payload, {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  });
}
