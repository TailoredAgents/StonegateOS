import { and, asc, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import {
  getDb,
  partnerAccountCostCenters,
  partnerAccountLocations,
  partnerAccounts,
  partnerServiceCatalog,
} from "@/db";
import { requirePermission } from "./permissions";
import { consumeTeamAuthRateLimit } from "./team-auth-rate-limit";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "./bounded-json-request";
import { normalizePartnerAccountWorkflow } from "./partner-account-workflows";
import {
  createPartnerRelationship,
  enablePartnerRelationshipAsStaff,
  invitePartnerAsStaff,
  managePartnerInvitationAsStaff,
  PartnerRelationshipCreateSchema,
  PartnerRelationshipEnableSchema,
  PartnerStaffInvitationActionSchema,
  PartnerStaffInvitationCreateSchema,
  PartnerWorkflowUpdateSchema,
  updatePartnerWorkflowAsStaff,
} from "./partner-relationship-management";
import {
  beginTeamMutation,
  TeamMutationFailure,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "./team-mutation";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  teamMutationIdempotencyReplayResponse,
  type TeamMutationIdempotencyClaim,
} from "./team-mutation-idempotency";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export async function getPartnerRelationshipContext(
  request: NextRequest,
  accountId: string,
): Promise<Response> {
  const denied = await requirePermission(request, "partners.accounts.read");
  if (denied) return denied;
  const headers = { "Cache-Control": "private, no-store" };
  if (!UUID.test(accountId))
    return NextResponse.json(
      { ok: false, error: "not_found" },
      { status: 404, headers },
    );
  const db = getDb();
  const [account] = await db
    .select({
      id: partnerAccounts.id,
      name: partnerAccounts.name,
      enabled: partnerAccounts.portalAccessEnabled,
      lifecycle: partnerAccounts.portalLifecycleStatus,
      setupStatus: partnerAccounts.portalSetupStatus,
      contactName: partnerAccounts.serviceContactName,
      contactEmail: partnerAccounts.serviceContactEmail,
      config: partnerAccounts.portalWorkflowConfig,
      revision: partnerAccounts.portalWorkflowRevision,
    })
    .from(partnerAccounts)
    .where(eq(partnerAccounts.id, accountId))
    .limit(1);
  if (!account)
    return NextResponse.json(
      { ok: false, error: "not_found" },
      { status: 404, headers },
    );
  const [locations, costCenters, services] = await Promise.all([
    db
      .select({
        id: partnerAccountLocations.id,
        label: partnerAccountLocations.siteName,
      })
      .from(partnerAccountLocations)
      .where(
        and(
          eq(partnerAccountLocations.partnerAccountId, accountId),
          eq(partnerAccountLocations.active, true),
        ),
      )
      .orderBy(asc(partnerAccountLocations.siteName))
      .limit(100),
    db
      .select({
        id: partnerAccountCostCenters.id,
        label: partnerAccountCostCenters.name,
      })
      .from(partnerAccountCostCenters)
      .where(
        and(
          eq(partnerAccountCostCenters.partnerAccountId, accountId),
          eq(partnerAccountCostCenters.active, true),
        ),
      )
      .orderBy(asc(partnerAccountCostCenters.name))
      .limit(100),
    db
      .select({
        key: partnerServiceCatalog.key,
        label: partnerServiceCatalog.label,
      })
      .from(partnerServiceCatalog)
      .where(eq(partnerServiceCatalog.active, true))
      .orderBy(asc(partnerServiceCatalog.label))
      .limit(100),
  ]);
  return NextResponse.json(
    {
      ok: true,
      account: {
        id: account.id,
        name: account.name,
        enabled: account.enabled,
        lifecycle: account.lifecycle,
        setupStatus: account.setupStatus,
        contactName: account.contactName,
        contactEmail: account.contactEmail,
      },
      config: normalizePartnerAccountWorkflow(account.config),
      version: String(account.revision),
      locations,
      costCenters,
      services,
    },
    { headers: { ...headers, ETag: '"' + account.revision + '"' } },
  );
}

export async function handlePartnerRelationshipWrite(
  request: NextRequest,
  kind: "create" | "invite" | "workflow" | "resend" | "revoke" | "enable",
  accountId?: string,
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions:
      kind === "create"
        ? ["partners.accounts.manage", "partners.invitations.send"]
        : kind === "invite" || kind === "resend"
          ? ["partners.invitations.send"]
          : kind === "revoke"
            ? ["partners.invitations.revoke"]
            : ["partners.accounts.manage"],
    risk: kind === "workflow" || kind === "revoke" ? "normal" : "external",
    requiresIdempotency: true,
    auditAction: "partner.relationship." + kind,
  });
  if (!boundary.ok) return boundary.response;
  const mutation = boundary.mutation;
  const db = getDb();
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    const raw = await readBoundedJsonRequest(request, {
      maximumBytes: 32_768,
      deadlineMs: 10_000,
      rejectDuplicateObjectKeys: true,
    });
    const schema =
      kind === "create"
        ? PartnerRelationshipCreateSchema
        : kind === "invite"
          ? PartnerStaffInvitationCreateSchema
          : kind === "resend" || kind === "revoke"
            ? PartnerStaffInvitationActionSchema
            : kind === "enable"
              ? PartnerRelationshipEnableSchema
              : PartnerWorkflowUpdateSchema;
    const parsed = schema.safeParse(raw);
    if (!parsed.success)
      throw new TeamMutationFailure(
        "invalid",
        "Check the company, contact, role and selected tools.",
        {
          fieldErrors: Object.fromEntries(
            parsed.error.issues.map((issue) => [
              issue.path.join("."),
              issue.message,
            ]),
          ),
        },
      );
    if (
      (kind === "resend" || kind === "revoke") &&
      PartnerStaffInvitationActionSchema.parse(parsed.data).action !== kind
    )
      throw new TeamMutationFailure(
        "invalid",
        "The invitation action does not match this request.",
      );
    if (
      (kind === "workflow" || kind === "enable") &&
      (!accountId || !UUID.test(accountId))
    )
      throw new TeamMutationFailure("invalid", "Choose an existing company.");
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/admin/partner-management/v1/relationship/" + kind,
      entityType: "partner_account",
      entityId:
        accountId ??
        (kind === "invite"
          ? PartnerStaffInvitationCreateSchema.parse(parsed.data).accountId
          : "new"),
      payload: parsed.data,
    });
    if (claimed.kind === "replay")
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    claim = claimed.claim;
    if (
      kind === "create" ||
      kind === "invite" ||
      kind === "resend" ||
      kind === "enable"
    ) {
      const rate = await consumeTeamAuthRateLimit({
        action: "partner_invitation_management",
        request,
        identity: { kind: "team_member", value: mutation.actor.id! },
      });
      if (rate.limited)
        throw new TeamMutationFailure(
          "rate_limited",
          "Too many invitation requests. Wait a few minutes before trying again.",
          { retryAfter: String(rate.retryAfterSeconds), retryable: true },
        );
    }
    const result = await db.transaction(async (tx) => {
      const data =
        kind === "create"
          ? await createPartnerRelationship(
              tx,
              mutation,
              PartnerRelationshipCreateSchema.parse(parsed.data),
            )
          : kind === "invite"
            ? await invitePartnerAsStaff(
                tx,
                mutation,
                PartnerStaffInvitationCreateSchema.parse(parsed.data),
              )
            : kind === "resend" || kind === "revoke"
              ? await managePartnerInvitationAsStaff(
                  tx,
                  mutation,
                  PartnerStaffInvitationActionSchema.parse(parsed.data),
                  request.headers.get("if-match"),
                )
              : kind === "enable"
                ? await enablePartnerRelationshipAsStaff(
                    tx,
                    mutation,
                    accountId!,
                  )
                : await updatePartnerWorkflowAsStaff(
                    tx,
                    mutation,
                    accountId!,
                    PartnerWorkflowUpdateSchema.parse(parsed.data),
                  );
      const invitation =
        "invitation" in data &&
        data.invitation &&
        typeof data.invitation === "object"
          ? (data.invitation as Record<string, unknown>)
          : null;
      const entityId =
        "invitationId" in data
          ? data.invitationId
          : kind === "invite" && typeof invitation?.["id"] === "string"
            ? invitation["id"]
            : data.accountId;
      const entityType =
        kind === "invite" && !invitation ? "partner_account" : data.recordType;
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType,
        entityId,
        metadata: {
          operation: kind,
          relationshipOnly: true,
          ...(kind === "create"
            ? {
                reason: PartnerRelationshipCreateSchema.parse(parsed.data)
                  .reason,
              }
            : kind === "enable"
              ? {
                  reason: PartnerRelationshipEnableSchema.parse(parsed.data)
                    .reason,
                }
              : {}),
        },
      });
      const success = teamMutationSuccessResult(mutation, data, {
        auditEventId: audit.auditEventId,
        committedAt: audit.committedAt,
        entityType,
        entityId,
        version: "version" in data ? data.version : "1",
      });
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
        success,
        kind === "workflow" ? 200 : 202,
      );
      return success;
    });
    return teamMutationResultResponse(
      result,
      kind === "workflow" ? 200 : 202,
      mutation.correlationId,
      { "Cache-Control": "private, no-store" },
    );
  } catch (error) {
    const safe =
      error instanceof BoundedJsonRequestError
        ? new TeamMutationFailure("invalid", "The request body is invalid.", {
            status: error.status,
          })
        : error;
    if (claim)
      await settleTeamMutationIdempotencyFailure(
        db,
        mutation,
        claim,
        safe,
      ).catch(() => undefined);
    return teamMutationExceptionResponse(safe, mutation);
  }
}
