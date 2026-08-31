import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { isAdminRequest } from "../../../../web/admin";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import {
  loadPartnerStaffPreview,
  PARTNER_STAFF_PREVIEW_UUID_PATTERN,
} from "@/lib/partner-portal-staff-preview";
import { requirePermission } from "@/lib/permissions";
import { readPortalV2CorrelationId } from "@/lib/portal-v2-contract";

const REQUIRED_PERMISSION = "partners.read" as const;
const PREVIEW_SURFACE = "team.sales.outbound.partners.portal_preview";
const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  Vary: "Authorization",
} as const;

function responseWithNoStore(response: Response): Response {
  for (const [name, value] of Object.entries(NO_STORE_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
}

function notFound(correlationId: string): Response {
  return NextResponse.json(
    { ok: false, error: "not_found", correlationId },
    { status: 404, headers: NO_STORE_HEADERS },
  );
}

async function auditDeniedSafely(input: {
  request: NextRequest;
  correlationId: string;
  orgContactId: string | null;
  reason: string;
}): Promise<void> {
  try {
    await recordAuditEvent({
      actor: getAuditActorFromRequest(input.request),
      action: "partner_portal.staff_preview.denied",
      entityType: "partner_account",
      correlationId: input.correlationId,
      requiredPermissions: [REQUIRED_PERMISSION],
      outcome: "denied",
      surface: PREVIEW_SURFACE,
      meta: {
        previewMode: "read_only",
        reason: input.reason,
        ...(input.orgContactId ? { orgContactId: input.orgContactId } : {}),
      },
    });
  } catch (error) {
    console.error("[partner-staff-preview] denied_audit_failed", {
      correlationId: input.correlationId,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  }
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ orgContactId: string }> },
): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  if (!isAdminRequest(request)) {
    return NextResponse.json(
      { ok: false, error: "unauthorized", correlationId },
      { status: 401, headers: NO_STORE_HEADERS },
    );
  }

  const permissionError = await requirePermission(request, REQUIRED_PERMISSION);
  if (permissionError) {
    await auditDeniedSafely({
      request,
      correlationId,
      orgContactId: null,
      reason: "missing_capability",
    });
    return responseWithNoStore(permissionError);
  }

  const { orgContactId } = await context.params;
  const queryEntries = [...request.nextUrl.searchParams.entries()];
  const jobIdValues = request.nextUrl.searchParams.getAll("jobId");
  const jobId = jobIdValues[0]?.trim() || null;
  const validQuery =
    queryEntries.every(([key]) => key === "jobId") &&
    jobIdValues.length <= 1 &&
    (!jobId || PARTNER_STAFF_PREVIEW_UUID_PATTERN.test(jobId));
  if (
    !PARTNER_STAFF_PREVIEW_UUID_PATTERN.test(orgContactId) ||
    !validQuery
  ) {
    await auditDeniedSafely({
      request,
      correlationId,
      orgContactId: PARTNER_STAFF_PREVIEW_UUID_PATTERN.test(orgContactId)
        ? orgContactId
        : null,
      reason: "invalid_or_unscoped_resource",
    });
    return notFound(correlationId);
  }

  try {
    const result = await loadPartnerStaffPreview({ orgContactId, jobId });
    if (result.kind === "not_found") {
      await auditDeniedSafely({
        request,
        correlationId,
        orgContactId,
        reason: "invalid_or_unscoped_resource",
      });
      return notFound(correlationId);
    }

    // The response is fail-closed on audit persistence: staff never receives
    // preview data unless this exact account/job read has a durable audit row.
    await recordAuditEvent({
      actor: getAuditActorFromRequest(request),
      action: "partner_portal.staff_preview.viewed",
      entityType: "partner_account",
      entityId: result.preview.account.id,
      correlationId,
      requiredPermissions: [REQUIRED_PERMISSION],
      outcome: "succeeded",
      surface: PREVIEW_SURFACE,
      meta: {
        previewMode: "read_only",
        orgContactId,
        ...(jobId ? { jobId } : {}),
        returnedJobs: result.preview.page.returned,
      },
    });

    return NextResponse.json(
      {
        ok: true,
        correlationId,
        readOnly: true,
        preview: result.preview,
      },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    console.error("[partner-staff-preview] load_failed", {
      correlationId,
      orgContactId,
      jobId,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    try {
      await recordAuditEvent({
        actor: getAuditActorFromRequest(request),
        action: "partner_portal.staff_preview.failed",
        entityType: "partner_account",
        correlationId,
        requiredPermissions: [REQUIRED_PERMISSION],
        outcome: "failed",
        surface: PREVIEW_SURFACE,
        meta: {
          previewMode: "read_only",
          orgContactId,
          ...(jobId ? { jobId } : {}),
        },
      });
    } catch (auditError) {
      console.error("[partner-staff-preview] failure_audit_failed", {
        correlationId,
        errorName:
          auditError instanceof Error ? auditError.name : "UnknownError",
      });
    }
    return NextResponse.json(
      {
        ok: false,
        error: "preview_unavailable",
        correlationId,
        retryable: true,
      },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
