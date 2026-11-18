import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";
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
  DraftSelectionSchema,
  SingleSmsReleaseSchema,
  previewIndividualSms,
  releaseIndividualSms,
} from "@/lib/individual-promotional-sms";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const denied = await requirePermission(
    request,
    ["marketing.read", "contacts.read", "messages.read"],
    { mode: "all" },
  );
  if (denied) return denied;
  const selection = DraftSelectionSchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!selection.success)
    return NextResponse.json(
      { error: "Exact contactId, draftId and version are required." },
      { status: 422 },
    );
  return NextResponse.json(
    await previewIndividualSms(getDb(), selection.data),
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

export async function POST(request: NextRequest) {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: [
      "marketing.write",
      "contacts.read",
      "messages.read",
      "messages.send",
      "policy.write",
    ],
    risk: "external",
    requiresIdempotency: true,
    auditAction: "sms_campaign.single_released",
  });
  if (!boundary.ok) return boundary.response;
  if (!getIntegrationContext(request)) {
    const context = await resolvePermissionContext(request);
    if (
      !context.authenticated ||
      context.role !== "owner" ||
      context.source === "service"
    )
      return NextResponse.json(
        { error: "Owner review or an approved delegated action is required." },
        { status: 403 },
      );
  }
  const { mutation } = boundary;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    const input = SingleSmsReleaseSchema.parse(
      await readBoundedJsonRequest(request, {
        maximumBytes: 16384,
        rejectDuplicateObjectKeys: true,
      }),
    );
    const db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/admin/sms-campaigns/single",
      entityType: "sms_campaign_draft",
      entityId: input.draftId,
      payload: input,
    });
    if (claimed.kind === "replay")
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    claim = claimed.claim;
    const result = await db.transaction(async (tx) => {
      const data = await releaseIndividualSms(tx, mutation, input);
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "sms_campaign_draft",
        entityId: input.draftId,
        metadata: {
          contactId: input.contactId,
          version: input.version,
          released: data.released,
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
