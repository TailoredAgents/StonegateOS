import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { requirePermission } from "@/lib/permissions";
import {
  beginTeamMutation,
  teamMutationExceptionResponse,
  teamMutationSuccessResult,
  teamMutationResultResponse,
  TeamMutationFailure,
} from "@/lib/team-mutation";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  teamMutationIdempotencyReplayResponse,
  type TeamMutationIdempotencyClaim,
} from "@/lib/team-mutation-idempotency";
import {
  CampaignCommandSchema,
  mutateCampaign,
  readCampaignWorkspace,
} from "@/lib/sms-campaigns";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  const denied = await requirePermission(
    request,
    ["marketing.read", "contacts.read", "messages.read"],
    { mode: "all" },
  );
  if (denied) return denied;
  const id = request.nextUrl.searchParams.get("campaignId") ?? undefined;
  if (id && !z.string().uuid().safeParse(id).success)
    return NextResponse.json({ error: "Invalid campaign" }, { status: 422 });
  const financialAccess =
    (await requirePermission(
      request,
      ["quotes.read", "appointments.read", "payments.read"],
      { mode: "all" },
    )) === null;
  try {
    return NextResponse.json(
      await readCampaignWorkspace(
        id,
        (request.nextUrl.searchParams.get("q") ?? "").slice(0, 100),
        financialAccess,
      ),
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    console.error(
      "campaign_workspace_failed",
      error instanceof Error ? error.message : "Unknown error",
    );
    return NextResponse.json(
      {
        error:
          "Campaigns are unavailable. Check the campaign database migration and API connection.",
      },
      { status: 503 },
    );
  }
}
export async function POST(request: NextRequest) {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["marketing.write", "contacts.read", "messages.read"],
    risk: "normal",
    requiresIdempotency: true,
    auditAction: "sms_campaign.updated",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    const raw = await request.text();
    if (raw.length > 32_768)
      throw new TeamMutationFailure(
        "invalid",
        "Campaign request is too large.",
      );
    const parsed = CampaignCommandSchema.safeParse(JSON.parse(raw));
    if (!parsed.success)
      throw new TeamMutationFailure(
        "invalid",
        "Review the campaign fields and try again.",
      );
    const command = parsed.data;
    if (command.action === "consent") {
      const denied = await requirePermission(request, "contacts.write");
      if (denied) return denied;
    }
    if (command.action === "release" || command.action === "test") {
      const denied = await requirePermission(
        request,
        ["messages.send", "policy.write"],
        { mode: "all" },
      );
      if (denied) return denied;
    }
    const db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/admin/sms-campaigns",
      entityType: "sms_campaign",
      entityId: "campaignId" in command ? command.campaignId : command.action,
      payload: command,
    });
    if (claimed.kind === "replay")
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    claim = claimed.claim;
    const result = await db.transaction(async (tx) => {
      const data = await mutateCampaign(tx, mutation, command);
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "sms_campaign",
        entityId:
          typeof data["campaignId"] === "string" ? data["campaignId"] : null,
        metadata: { action: command.action },
        after: { version: data["version"], released: data["released"] },
      });
      const result = teamMutationSuccessResult(mutation, data, {
        ...audit,
        entityType: "sms_campaign",
        entityId:
          typeof data["campaignId"] === "string"
            ? data["campaignId"]
            : undefined,
      });
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
        result,
        200,
      );
      return result;
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
    return teamMutationExceptionResponse(error, mutation);
  }
}
