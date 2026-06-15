import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { syncTraccarPositions } from "@/lib/eta-agent";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../../web/admin";

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "appointments.update");
  if (permissionError) return permissionError;

  const result = await syncTraccarPositions();
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
