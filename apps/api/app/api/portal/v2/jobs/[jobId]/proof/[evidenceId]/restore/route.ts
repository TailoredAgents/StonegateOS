import type { NextRequest } from "next/server";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import { arePartnerPortalV2WritesEnabled } from "@/lib/partner-portal-feature-flags";
import { hasPartnerJobAccess } from "@/lib/partner-portal-v2-resource-authorization";
import { PartnerPortalMediaError, restorePartnerMedia } from "@/lib/partner-portal-v2-media";
import { isAllowedPartnerPortalMutationOrigin, isPortalV2Uuid } from "@/lib/partner-portal-v2-security";
import { readPortalV2CorrelationId, readPortalV2IdempotencyKey } from "@/lib/portal-v2-contract";
import { runPortalV2IdempotentMutation } from "@/lib/partner-portal-v2-idempotency";
import { createPartnerPortalV2ErrorResponse, createPartnerPortalV2StoredResponse, createPartnerPortalV2UnexpectedResponse } from "@/lib/partner-portal-v2-response";

export async function POST(request: NextRequest, context: { params: Promise<{ jobId: string; evidenceId: string }> }): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  try {
    if (!isAllowedPartnerPortalMutationOrigin(request)) return createPartnerPortalV2ErrorResponse("forbidden", 403, correlationId);
    const access = await requirePartnerCapability(request, "media.upload");
    if (!access.ok) return createPartnerPortalV2ErrorResponse(access.error, access.status, correlationId);
    const { principal } = access;
    const { jobId, evidenceId } = await context.params;
    if (!principal.accountId || !isPortalV2Uuid(jobId) || !isPortalV2Uuid(evidenceId) || !(await hasPartnerJobAccess(principal, jobId))) return createPartnerPortalV2ErrorResponse("not_found", 404, correlationId);
    if (!arePartnerPortalV2WritesEnabled(principal.accountId)) return createPartnerPortalV2ErrorResponse("service_unavailable", 503, correlationId);
    const idempotency = readPortalV2IdempotencyKey(request.headers);
    if (!idempotency.ok) return createPartnerPortalV2ErrorResponse("idempotency_key_required", 400, correlationId);
    const deletedAt = request.headers.get("if-match")?.replace(/^"|"$/gu, "");
    if (!deletedAt || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(deletedAt) || !Number.isFinite(Date.parse(deletedAt))) return createPartnerPortalV2ErrorResponse("revision_required", 428, correlationId);
    const result = await runPortalV2IdempotentMutation({ principal: principal.partnerUserId, action: "partner_media_restore", keyHash: idempotency.keyHash!, scope: `${principal.accountId}:${jobId}:${evidenceId}`, payload: { deletedAt }, correlationId, execute: async () => ({ status: 200, body: { ok: true, restored: await restorePartnerMedia({ parentKind: "job", parentId: jobId, associationId: evidenceId, principal, deletedAt, correlationId }) } }) });
    if (result.kind === "conflict") return createPartnerPortalV2ErrorResponse("idempotency_conflict", 409, correlationId);
    return createPartnerPortalV2StoredResponse(result.result, correlationId);
  } catch (error) {
    if (error instanceof PartnerPortalMediaError) return createPartnerPortalV2ErrorResponse(error.code, error.status, correlationId);
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
