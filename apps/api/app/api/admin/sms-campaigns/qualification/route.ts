import { NextResponse, type NextRequest } from "next/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { requirePermission, resolvePermissionContext } from "@/lib/permissions";
import { getIntegrationContext } from "@/lib/agent-integration-context";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import {
  beginTeamMutation,
  teamMutationExceptionResponse,
  teamMutationSuccessResult,
  teamMutationResultResponse,
} from "@/lib/team-mutation";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  teamMutationIdempotencyReplayResponse,
  type TeamMutationIdempotencyClaim,
} from "@/lib/team-mutation-idempotency";
import {
  QualificationSchema,
  recordOutreachQualification,
} from "@/lib/individual-promotional-sms";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  const denied = await requirePermission(
    request,
    ["marketing.read", "contacts.read"],
    { mode: "all" },
  );
  if (denied) return denied;
  const selection = z
    .string()
    .uuid()
    .safeParse(request.nextUrl.searchParams.get("contactId"));
  if (!selection.success)
    return NextResponse.json(
      { error: "Exact contact ID required" },
      { status: 422 },
    );
  const [qualification] = await getDb().execute(
    sql`select version,qualification,facebook_status,holds,external_last_activity_at,evidence_reference,reviewed_at from sms_outreach_qualifications where contact_id=${selection.data}::uuid`,
  );
  return NextResponse.json(
    { qualification: qualification ?? null },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
export async function POST(request: NextRequest) {
  const denied = await requirePermission(
    request,
    ["marketing.write", "contacts.write"],
    { mode: "all" },
  );
  if (denied) return denied;
  const owner = await resolvePermissionContext(request);
  if (
    !getIntegrationContext(request)?.ownerDelegated &&
    (getIntegrationContext(request) ||
      owner.role !== "owner" ||
      owner.source === "service")
  )
    return NextResponse.json(
      { error: "An owner must attest to external evidence and exclusions." },
      { status: 403 },
    );
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["marketing.write", "contacts.write"],
    risk: "normal",
    requiresIdempotency: true,
    auditAction: "sms_campaign.qualification_recorded",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    const input = QualificationSchema.parse(
      await readBoundedJsonRequest(request, {
        maximumBytes: 16384,
        rejectDuplicateObjectKeys: true,
      }),
    );
    const db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/admin/sms-campaigns/qualification",
      entityType: "contact",
      entityId: input.contactId,
      payload: input,
    });
    if (claimed.kind === "replay")
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    claim = claimed.claim;
    const result = await db.transaction(async (tx) => {
      const data = await recordOutreachQualification(
        tx,
        mutation.actor.id!,
        input,
      );
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "contact",
        entityId: input.contactId,
        metadata: {
          version: data.version,
          evidenceReference: input.evidenceReference,
        },
      });
      const response = teamMutationSuccessResult(mutation, data, audit);
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
        response,
        200,
      );
      return response;
    });
    return teamMutationResultResponse(result, 200, mutation.correlationId);
  } catch (error) {
    if (claim)
      await settleTeamMutationIdempotencyFailure(
        getDb(),
        mutation,
        claim,
        error,
      ).catch(() => {});
    if (error instanceof z.ZodError)
      return NextResponse.json(
        { error: "Invalid request", issues: error.issues },
        { status: 422 },
      );
    if (error instanceof BoundedJsonRequestError)
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    return teamMutationExceptionResponse(error, mutation);
  }
}
