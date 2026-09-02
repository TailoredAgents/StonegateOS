import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), "../..");
const ROUTE = readFileSync(
  join(ROOT, "apps/api/app/api/admin/partners/users/route.ts"),
  "utf8",
);
const ACTIONS = readFileSync(
  join(ROOT, "apps/site/src/app/team/actions.ts"),
  "utf8",
);
const UI = readFileSync(
  join(ROOT, "apps/site/src/app/team/components/PartnersSection.tsx"),
  "utf8",
);
const ROUTE_MANIFEST = readFileSync(
  join(ROOT, "apps/api/src/lib/team-route-security-manifest.ts"),
  "utf8",
);
const ACTION_MANIFEST = readFileSync(
  join(ROOT, "apps/site/src/app/team/action-policy-manifest.ts"),
  "utf8",
);

describe("partner portal access management", () => {
  const patchStart = ROUTE.indexOf("export async function PATCH(");
  const postStart = ROUTE.indexOf("export async function POST(");
  const patchSource = ROUTE.slice(patchStart, postStart);

  it("authenticates and applies destructive safety controls before body parsing", () => {
    expect(patchStart).toBeGreaterThan(-1);
    expect(patchSource.indexOf("beginTeamMutation(request")).toBeLessThan(
      patchSource.indexOf("readBoundedJsonRequest(request"),
    );
    expect(patchSource).toContain(
      'requiredPermissions: ["partners.identities.disable"]',
    );
    expect(patchSource).toContain('risk: "destructive"');
    expect(patchSource).toContain(
      'ignoredPermissionKillSwitches: ["external_sends"]',
    );
    expect(patchSource).toContain("requiresIdempotency: true");
    expect(patchSource).toContain("hasExactKeys(candidate, ACCESS_BODY_KEYS)");
    expect(ROUTE_MANIFEST).toContain(
      '"app/api/admin/partners/users/route.ts#PATCH": "destructive"',
    );
  });

  it("binds access changes to an exact organization, user, and version", () => {
    expect(patchSource).toContain("assertTeamMutationExpectedVersion(");
    expect(patchSource).toContain("user.orgContactId !== input.orgContactId");
    expect(patchSource).toContain('organization.partnerStatus !== "partner"');
    expect(patchSource).toContain("organization.deletedAt");
    expect(patchSource).toContain("eq(partnerUsers.updatedAt, user.updatedAt)");
    expect(patchSource).toContain("claimTeamMutationIdempotency(");
  });

  it("blocks activation but preserves safe deactivation through unresolved delivery", () => {
    for (const state of [
      '"requested"',
      '"dispatched"',
      '"reconciliation_required"',
    ]) {
      expect(patchSource).toContain(state);
    }
    expect(patchSource).toContain("unresolvedInvite && input.active");
    expect(patchSource).toContain('action: "partner_user.invite.quarantined"');
    expect(patchSource).toContain(
      'failureCode: "partner_user_deactivated_during_dispatch"',
    );
    expect(patchSource).toContain("unresolvedInviteDisposition");
    expect(patchSource).toContain("Resolve that operation first");
  });

  it("revokes sessions and links on deactivation without restoring either on activation", () => {
    expect(patchSource).toContain(".update(partnerSessions)");
    expect(patchSource).toContain(".update(partnerLoginTokens)");
    expect(patchSource).toContain("existingSessionsRestored: false");
    expect(patchSource).toContain("existingTokensRestored: false");
    expect(patchSource).not.toContain("revokedAt: null");
    expect(patchSource).not.toContain("usedAt: null");
  });

  it("commits the user state, success audit, receipt, and replay result together", () => {
    expect(patchSource).toContain("db.transaction(async (tx)");
    expect(patchSource).toContain("mutation.audit.insertSuccess(tx");
    expect(patchSource).toContain("completeTeamMutationIdempotency(");
    expect(patchSource).toContain("settleTeamMutationIdempotencyFailure(");
    expect(patchSource).toContain('entityType: "partner_user"');
  });

  it("exposes deliberate, accessible controls and rejects malformed success", () => {
    expect(ACTIONS).toContain(
      "export async function partnerPortalSetUserActiveAction",
    );
    expect(ACTIONS).toContain('method: "PATCH"');
    expect(ACTIONS).toContain('"If-Match": expectedVersion');
    expect(ACTIONS).toContain('"Idempotency-Key": idempotencyKey');
    expect(ACTIONS).toContain("parsePartnerPortalAccessChangeSuccess(");
    expect(ACTIONS).toContain("actorId: principal.memberId");
    expect(ACTIONS).toContain("no success is being claimed");
    expect(UI).toContain("Type DEACTIVATE");
    expect(UI).toContain("Activate portal user");
    expect(UI).toContain("Old sessions and links stay revoked");
    expect(UI).toContain("min-h-[44px]");
    expect(ACTION_MANIFEST).toContain("partnerPortalSetUserActiveAction");
    expect(ACTION_MANIFEST).toContain('"destructive"');
  });
});
