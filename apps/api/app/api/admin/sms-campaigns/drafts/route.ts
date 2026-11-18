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
  DraftImportSchema,
  importPromotionalDrafts,
} from "@/lib/promotional-draft-import";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  const denied = await requirePermission(
    request,
    ["marketing.read", "contacts.read"],
    { mode: "all" },
  );
  if (denied) return denied;
  const parsed = z
    .object({
      campaignId: z.string().uuid(),
      contactId: z.string().uuid().optional(),
      offset: z.coerce.number().int().min(0).default(0),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    })
    .strict()
    .safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success)
    return NextResponse.json(
      { error: "Invalid draft query." },
      { status: 422 },
    );
  const q = parsed.data;
  const rows = await getDb().execute(
    sql`select id,contact_id,version,body,body_hash,source_reference,created_at from sms_campaign_drafts where campaign_id=${q.campaignId}::uuid and (${q.contactId ?? null}::uuid is null or contact_id=${q.contactId ?? null}::uuid) order by contact_id,version desc limit ${q.limit + 1} offset ${q.offset}`,
  );
  return NextResponse.json(
    {
      records: rows.slice(0, q.limit),
      nextOffset: rows.length > q.limit ? q.offset + q.limit : null,
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
export async function POST(request: NextRequest) {
  const denied = await requirePermission(
    request,
    ["marketing.write", "contacts.read"],
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
      { error: "An owner session is required to review and import drafts." },
      { status: 403 },
    );
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["marketing.write", "contacts.read"],
    risk: "normal",
    requiresIdempotency: true,
    auditAction: "sms_campaign.drafts_imported",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    const input = DraftImportSchema.parse(
      await readBoundedJsonRequest(request, {
        maximumBytes: 1024 * 1024,
        rejectDuplicateObjectKeys: true,
      }),
    );
    const db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/admin/sms-campaigns/drafts",
      entityType: "sms_campaign",
      entityId: input.campaignId,
      payload: input,
    });
    if (claimed.kind === "replay")
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    claim = claimed.claim;
    const result = await db.transaction(async (tx) => {
      const data = await importPromotionalDrafts(tx, mutation.actor.id!, input);
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "sms_campaign",
        entityId: input.campaignId,
        metadata: {
          dryRun: data.dryRun,
          sourceHash: data.sourceHash,
          reviewHash: data.reviewHash,
          rows: data.rows,
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
