import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), "../..");
const SECTION = readFileSync(
  join(ROOT, "apps/site/src/app/team/components/AccessSection.tsx"),
  "utf8",
);
const SESSIONS_ROUTE = readFileSync(
  join(ROOT, "apps/api/app/api/admin/team/sessions/route.ts"),
  "utf8",
);
const REVOKE_ROUTE = readFileSync(
  join(ROOT, "apps/api/app/api/admin/team/sessions/revoke/route.ts"),
  "utf8",
);
const REVOKE_PROXY = readFileSync(
  join(ROOT, "apps/site/src/app/api/team/access/sessions/revoke/route.ts"),
  "utf8",
);
const SESSION_REFRESH = readFileSync(
  join(
    ROOT,
    "apps/site/src/app/team/components/AccessSessionRefreshButton.tsx",
  ),
  "utf8",
);

describe("Access experience contract", () => {
  it("exposes Members, Roles, Routing, and Sessions as accessible landmarks", () => {
    expect(SECTION).toContain('aria-label="Access views"');
    for (const id of ["members", "roles", "routing", "sessions"]) {
      expect(SECTION).toContain(`id="${id}"`);
      expect(SECTION).toContain(`["${id}",`);
    }
    expect(SECTION).toContain("min-h-[44px]");
  });

  it("shows effective permissions after individual deny rules", () => {
    expect(SECTION).toContain("function effectivePermissionsFor");
    expect(SECTION).toContain('member.permissionsGrant.includes("*")');
    expect(SECTION).toContain('member.permissionsDeny.includes("*")');
    expect(SECTION).toContain("effective.delete(permission)");
    expect(SECTION).toContain("Effective access (");
    expect(SECTION).toContain("Deny always wins");
    expect(SECTION).toContain("PermissionSummary");
    expect(SECTION).toContain("PermissionOverrideRow");
    expect(SECTION).toContain("ACCESS_PERMISSION_GROUPS.map");
    expect(SECTION).toContain(
      "Both are currently stored; Deny takes priority.",
    );
    expect(SECTION).toContain("describeAccessPermission");
    expect(SECTION).toContain("Sensitive");
  });

  it("uses a reviewed role-template form instead of an unstructured permission wall", () => {
    expect(SECTION).toContain("RoleCreateForm");
    expect(SECTION).toContain("disabled={Boolean(rolesError)}");
  });

  it("keeps independent resource failures truthful and disables unsafe edits", () => {
    for (const marker of [
      "rolesError",
      "membersError",
      "routingError",
      "sessionsError",
    ]) {
      expect(SECTION).toContain(marker);
    }
    expect(SECTION).toContain("This is not an empty role list");
    expect(SECTION).toContain("This is not an empty member list");
    expect(SECTION).toContain("This is not an empty session history");
    expect(SECTION).toContain("cannot be changed safely");
    expect(SECTION).toContain("disabled={Boolean(rolesError)}");
    expect(SECTION).toContain("disabled={Boolean(membersError)}");
  });

  it("returns a bounded, privacy-safe, permission-gated session inventory", () => {
    const guardIndex = SESSIONS_ROUTE.indexOf(
      'requirePermission(request, "access.manage")',
    );
    const queryIndex = SESSIONS_ROUTE.indexOf("request.nextUrl.searchParams");
    expect(guardIndex).toBeGreaterThan(0);
    expect(guardIndex).toBeLessThan(queryIndex);
    expect(SESSIONS_ROUTE).toContain("const SESSION_LIMIT = 200");
    expect(SESSIONS_ROUTE).toContain('"Cache-Control": "no-store"');
    expect(SESSIONS_ROUTE).toContain("status: session.revokedAt");
    expect(SESSIONS_ROUTE).not.toContain("sessionHash:");
    expect(SESSIONS_ROUTE).not.toContain("ip: teamSessions.ip");
    expect(SECTION).toContain("Current session");
    expect(SECTION).toContain("Emergency access");
    expect(SECTION).toContain("AccessSessionRefreshButton");
    expect(SESSION_REFRESH).toContain("router.refresh()");
    expect(SESSION_REFRESH).toContain('type="button"');
    expect(SESSION_REFRESH).toContain("Refresh sessions");
  });

  it("revokes single or member sessions through one durable audited mutation", () => {
    expect(REVOKE_ROUTE).toContain("beginTeamMutation(request");
    expect(REVOKE_ROUTE).toContain('requiredPermissions: ["access.manage"]');
    expect(REVOKE_ROUTE).toContain('risk: "destructive"');
    expect(REVOKE_ROUTE).toContain("requiresIdempotency: true");
    expect(REVOKE_ROUTE).toContain('auditAction: "team.session.revoked"');
    expect(REVOKE_ROUTE).toContain('outcome: "attempted"');
    expect(REVOKE_ROUTE).toContain('? "failed" : "denied"');
    expect(REVOKE_ROUTE).toContain("mutation_failed");
    expect(REVOKE_ROUTE).toContain("claimTeamMutationIdempotency(");
    expect(REVOKE_ROUTE).toContain("mutation.audit.insertSuccess(tx");
    expect(REVOKE_ROUTE).toContain("completeTeamMutationIdempotency(");
    expect(REVOKE_ROUTE).toContain("settleTeamMutationIdempotencyFailure(");
    expect(REVOKE_ROUTE).toContain("targetId === mutation.actor.sessionId");
    expect(REVOKE_ROUTE).toContain("row.id !== mutation.actor.sessionId");
    expect(REVOKE_PROXY.indexOf("requireTeamPrincipal(request")).toBeLessThan(
      REVOKE_PROXY.indexOf("request.formData()"),
    );
    expect(REVOKE_PROXY).toContain('confirmation !== "REVOKE"');
    expect(REVOKE_PROXY).toContain('"Idempotency-Key": idempotencyKey');
    expect(REVOKE_PROXY).toContain("payload?.ok !== true");
    expect(SECTION).toContain("Revoke this session");
    expect(SECTION).toContain("Revoke my other sessions");
    expect(SECTION).toContain("Revoke all sessions");
  });
});
