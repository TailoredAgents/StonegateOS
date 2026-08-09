import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import {
  parseOutboundImportPayload,
  readOutboundImportJsonRequest,
} from "@/lib/outbound-import";
import {
  prepareOutboundImportPreview,
  resolveOutboundImportAssignee,
} from "@/lib/outbound-import-service";
import { requirePermission } from "@/lib/permissions";
import { teamMutationExceptionResponse } from "@/lib/team-mutation";
import { isAdminRequest } from "../../../../web/admin";

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "outbound.import");
  if (permissionError) return permissionError;

  try {
    const payload = await readOutboundImportJsonRequest(request);
    const parsed = parseOutboundImportPayload(payload);
    const db = getDb();
    const assignee = await resolveOutboundImportAssignee(
      db,
      parsed.requestedAssigneeMemberId,
    );
    const prepared = await prepareOutboundImportPreview(db, parsed, assignee);
    return NextResponse.json(
      { ok: true, preview: prepared.preview },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return teamMutationExceptionResponse(error);
  }
}
