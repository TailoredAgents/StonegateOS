import fs from "node:fs";
import path from "node:path";
import {
  evaluateMemberDeletion,
  evaluateMemberSecurityChange,
  evaluateSelfAccessChange,
  isActiveOwner,
  shouldRevokeMemberSessions,
} from "@/lib/team-access-safety";

const owner = {
  active: true,
  roleSlug: "owner",
  permissionsDeny: [] as string[],
};
const office = {
  active: true,
  roleSlug: "office",
  permissionsDeny: [] as string[],
};

describe("team Access owner safety", () => {
  it("recognizes only active, effective owners", () => {
    expect(isActiveOwner(owner)).toBe(true);
    expect(isActiveOwner({ ...owner, roleSlug: " Owner " })).toBe(true);
    expect(isActiveOwner({ ...owner, active: false })).toBe(false);
    expect(isActiveOwner(office)).toBe(false);
    expect(isActiveOwner({ ...owner, permissionsDeny: ["*"] })).toBe(false);
    expect(
      isActiveOwner({ ...owner, permissionsDeny: ["access.manage"] }),
    ).toBe(false);
    expect(isActiveOwner({ ...owner, permissionsDeny: ["access.*"] })).toBe(
      false,
    );
  });

  it("rejects self-deactivation without blocking a safe ownership transfer", () => {
    expect(
      evaluateMemberSecurityChange({
        actorId: "owner-1",
        memberId: "owner-1",
        current: owner,
        next: { ...owner, active: false },
        hasOtherActiveOwner: true,
      }),
    ).toBe("cannot_deactivate_current_member");

    expect(
      evaluateMemberSecurityChange({
        actorId: "owner-1",
        memberId: "owner-1",
        current: owner,
        next: office,
        hasOtherActiveOwner: true,
      }),
    ).toBeNull();
  });

  it("rejects every way of removing the last active owner", () => {
    const nextStates = [
      office,
      { ...owner, active: false },
      { ...owner, permissionsDeny: ["*"] },
      { ...owner, roleSlug: null },
    ];

    for (const next of nextStates) {
      expect(
        evaluateMemberSecurityChange({
          actorId: "admin-2",
          memberId: "owner-1",
          current: owner,
          next,
          hasOtherActiveOwner: false,
        }),
      ).toBe("last_active_owner_required");
    }
  });

  it("rejects self-deletion and deletion of the last active owner", () => {
    expect(
      evaluateMemberDeletion({
        actorId: "owner-1",
        memberId: "owner-1",
        current: owner,
        hasOtherActiveOwner: true,
      }),
    ).toBe("cannot_delete_current_member");

    expect(
      evaluateMemberDeletion({
        actorId: "admin-2",
        memberId: "owner-1",
        current: owner,
        hasOtherActiveOwner: false,
      }),
    ).toBe("last_active_owner_required");

    expect(
      evaluateMemberDeletion({
        actorId: "admin-2",
        memberId: "owner-1",
        current: owner,
        hasOtherActiveOwner: true,
      }),
    ).toBeNull();
  });

  it("allows intentional self-demotion only after another owner can administer Access", () => {
    expect(
      evaluateSelfAccessChange({
        actorId: "custom-admin",
        memberId: "custom-admin",
        retainsAccess: false,
        hasOtherActiveOwner: false,
      }),
    ).toBe("cannot_remove_own_access");

    expect(
      evaluateSelfAccessChange({
        actorId: "custom-admin",
        memberId: "custom-admin",
        retainsAccess: false,
        hasOtherActiveOwner: true,
      }),
    ).toBeNull();
    expect(
      evaluateSelfAccessChange({
        actorId: "custom-admin",
        memberId: "custom-admin",
        retainsAccess: true,
        hasOtherActiveOwner: false,
      }),
    ).toBeNull();
  });

  it("revokes sessions for identity, role, activation, phone, or permission changes", () => {
    const current = {
      email: "owner@example.com",
      roleId: "owner-role",
      active: true,
    };
    const unchanged = { ...current };

    expect(
      shouldRevokeMemberSessions({
        current,
        next: unchanged,
        phoneWasSubmitted: false,
        permissionsWereSubmitted: false,
      }),
    ).toBe(false);
    expect(
      shouldRevokeMemberSessions({
        current,
        next: { ...unchanged, email: "new@example.com" },
        phoneWasSubmitted: false,
        permissionsWereSubmitted: false,
      }),
    ).toBe(true);
    expect(
      shouldRevokeMemberSessions({
        current,
        next: { ...unchanged, roleId: "office-role" },
        phoneWasSubmitted: false,
        permissionsWereSubmitted: false,
      }),
    ).toBe(true);
    expect(
      shouldRevokeMemberSessions({
        current,
        next: { ...unchanged, active: false },
        phoneWasSubmitted: false,
        permissionsWereSubmitted: false,
      }),
    ).toBe(true);
    expect(
      shouldRevokeMemberSessions({
        current,
        next: unchanged,
        phoneWasSubmitted: true,
        permissionsWereSubmitted: false,
      }),
    ).toBe(true);
    expect(
      shouldRevokeMemberSessions({
        current,
        next: unchanged,
        phoneWasSubmitted: false,
        permissionsWereSubmitted: true,
      }),
    ).toBe(true);
  });
});

describe("team Access transaction contracts", () => {
  const memberRoute = fs.readFileSync(
    path.resolve(
      __dirname,
      "../../app/api/admin/team/members/[memberId]/route.ts",
    ),
    "utf8",
  );
  const roleRoute = fs.readFileSync(
    path.resolve(__dirname, "../../app/api/admin/roles/[roleId]/route.ts"),
    "utf8",
  );

  it("serializes member and role ownership changes with the shared transaction lock", () => {
    expect(memberRoute.match(/TEAM_ACCESS_SAFETY_LOCK_KEY/g)?.length).toBe(3);
    expect(roleRoute.match(/TEAM_ACCESS_SAFETY_LOCK_KEY/g)?.length).toBe(2);
    expect(memberRoute).toContain("pg_advisory_xact_lock");
    expect(roleRoute).toContain("pg_advisory_xact_lock");
  });

  it("revokes sessions in the same transaction as member and role changes", () => {
    expect(memberRoute).toContain(".update(teamSessions)");
    expect(memberRoute).toContain("isNull(teamSessions.revokedAt)");
    expect(roleRoute).toContain(".update(teamSessions)");
    expect(roleRoute).toContain("isNull(teamSessions.revokedAt)");
  });

  it("returns deterministic conflicts before any protected record update", () => {
    expect(memberRoute).toContain(
      "{ error, retryable: false }, { status: 409 }",
    );
    expect(roleRoute).toContain(
      'throw roleConflict("built_in_role_slug_immutable")',
    );
    expect(roleRoute).toContain(
      'throw roleConflict("owner_role_requires_access_manage")',
    );
    expect(memberRoute.indexOf("const selfSafetyConflict")).toBeLessThan(
      memberRoute.indexOf(".update(teamMembers)"),
    );
    expect(
      roleRoute.indexOf('throw roleConflict("built_in_role_slug_immutable")'),
    ).toBeLessThan(roleRoute.indexOf(".update(teamRoles)"));
  });
});
