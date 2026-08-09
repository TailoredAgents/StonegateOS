import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseAccessRolesPayload,
  parseAccessRoleUpdateMutationResult,
} from "../../../site/src/app/team/access-role-page";
import { classifyTeamActionRisk } from "@/lib/team-route-security-manifest";

const ROOT = join(process.cwd(), "../..");
const EDIT_FORM = readFileSync(
  join(ROOT, "apps/site/src/app/team/components/RoleEditForm.tsx"),
  "utf8",
);
const ACCESS_SECTION = readFileSync(
  join(ROOT, "apps/site/src/app/team/components/AccessSection.tsx"),
  "utf8",
);
const SITE_ROUTE = readFileSync(
  join(ROOT, "apps/site/src/app/api/team/access/roles/[roleId]/route.ts"),
  "utf8",
);
const API_ROUTE = readFileSync(
  join(ROOT, "apps/api/app/api/admin/roles/[roleId]/route.ts"),
  "utf8",
);

const ROLE_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const OPERATION_ID = "33333333-3333-4333-8333-333333333333";
const AUDIT_EVENT_ID = "44444444-4444-4444-8444-444444444444";
const CORRELATION_ID = "role-update-correlation-123456";
const CREATED_AT = "2026-08-08T12:00:00.000Z";
const EXPECTED_UPDATED_AT = "2026-08-08T12:30:00.000Z";
const UPDATED_AT = "2026-08-08T13:00:00.000Z";

function role() {
  return {
    id: ROLE_ID,
    name: "Office east",
    slug: "office_east",
    permissions: ["messages.read", "contacts.read"],
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
  };
}

function expectedUpdate() {
  return {
    id: ROLE_ID,
    name: "Office east",
    slug: "office_east",
    permissions: ["contacts.read", "messages.read"],
    expectedUpdatedAt: EXPECTED_UPDATED_AT,
    actorId: ACTOR_ID,
  };
}

function successPayload() {
  return {
    ok: true,
    data: {
      role: role(),
      assignedMemberCount: 2,
      revokedSessionCount: 3,
    },
    receipt: {
      operationId: OPERATION_ID,
      correlationId: CORRELATION_ID,
      actorId: ACTOR_ID,
      committedAt: UPDATED_AT,
      auditEventId: AUDIT_EVENT_ID,
      entityType: "team_role",
      entityId: ROLE_ID,
      version: UPDATED_AT,
    },
  };
}

function receiptHeaders(): Headers {
  return new Headers({ "x-correlation-id": CORRELATION_ID });
}

describe("Access role editing experience", () => {
  it("parses only complete versioned role inventories", () => {
    expect(parseAccessRolesPayload({ roles: [role()] })).toEqual([role()]);
    expect(
      parseAccessRolesPayload({
        roles: [{ ...role(), updatedAt: undefined }],
      }),
    ).toBeNull();
    expect(
      parseAccessRolesPayload({ roles: [{ ...role(), privateNote: "no" }] }),
    ).toBeNull();
    expect(
      parseAccessRolesPayload({
        roles: [{ ...role(), permissions: ["messages.read", "messages.read"] }],
      }),
    ).toBeNull();
    expect(parseAccessRolesPayload({ roles: [role(), role()] })).toBeNull();
  });

  it("binds the canonical success receipt to the role, actor, version, and correlation", () => {
    expect(
      parseAccessRoleUpdateMutationResult(
        successPayload(),
        receiptHeaders(),
        expectedUpdate(),
      ),
    ).toEqual(successPayload());

    for (const payload of [
      {
        ...successPayload(),
        data: {
          ...successPayload().data,
          role: {
            ...role(),
            id: "55555555-5555-4555-8555-555555555555",
          },
        },
      },
      {
        ...successPayload(),
        receipt: { ...successPayload().receipt, actorId: ROLE_ID },
      },
      {
        ...successPayload(),
        receipt: { ...successPayload().receipt, version: EXPECTED_UPDATED_AT },
      },
      { ...successPayload(), unexpected: true },
    ]) {
      expect(
        parseAccessRoleUpdateMutationResult(
          payload,
          receiptHeaders(),
          expectedUpdate(),
        ),
      ).toBeNull();
    }
    expect(
      parseAccessRoleUpdateMutationResult(
        successPayload(),
        new Headers({ "x-correlation-id": "different-correlation" }),
        expectedUpdate(),
      ),
    ).toBeNull();
  });

  it("accepts only the exact canonical typed error shape", () => {
    const failure = {
      ok: false,
      code: "conflict",
      message: "The role changed after it was loaded.",
      retryable: false,
      fieldErrors: { version: "Refresh the role." },
    } as const;
    expect(
      parseAccessRoleUpdateMutationResult(
        failure,
        new Headers(),
        expectedUpdate(),
      ),
    ).toEqual(failure);
    expect(
      parseAccessRoleUpdateMutationResult(
        { ...failure, secret: "not allowed" },
        new Headers(),
        expectedUpdate(),
      ),
    ).toBeNull();
  });

  it("provides a grouped reviewed editor with version and retry identity", () => {
    expect(ACCESS_SECTION).toContain("parseAccessRolesPayload");
    expect(ACCESS_SECTION).toContain("RoleEditForm");
    expect(EDIT_FORM).toContain(
      'pattern={"[A-Za-z][A-Za-z0-9_\\\\-]{1,63}"}',
    );
    expect(EDIT_FORM).not.toContain(
      'pattern="[A-Za-z][A-Za-z0-9_-]{1,63}"',
    );
    expect(EDIT_FORM).toContain("ACCESS_PERMISSION_GROUPS.map");
    expect(EDIT_FORM).toContain('name="expectedUpdatedAt"');
    expect(EDIT_FORM).toContain('name="idempotencyKey"');
    expect(EDIT_FORM).toContain("Save reviewed role");
    expect(EDIT_FORM).toContain("Permission or slug changes revoke");
    expect(EDIT_FORM).toContain('aria-live="polite"');
    expect(EDIT_FORM).toContain("min-h-[52px]");
    expect(EDIT_FORM).toContain("Sensitive");
  });

  it("authenticates before parsing and replays the exact Site request until a bound receipt exists", () => {
    expect(SITE_ROUTE).toContain("isSameOriginRoleUpdateRequest(request)");
    expect(SITE_ROUTE.indexOf("requireTeamPrincipal(request")).toBeLessThan(
      SITE_ROUTE.indexOf("readBoundedRoleForm(request)"),
    );
    expect(SITE_ROUTE).toContain('"Idempotency-Key": idempotencyKey');
    expect(SITE_ROUTE).toContain('"If-Match": expectedUpdatedAt');
    expect(SITE_ROUTE).toContain("const body = JSON.stringify({");
    expect(SITE_ROUTE).toContain("MAXIMUM_UPSTREAM_ATTEMPTS = 2");
    expect(SITE_ROUTE).toContain("parseAccessRoleUpdateMutationResult");
    expect(SITE_ROUTE).toContain("valid, correlated mutation receipt");
  });

  it("declares and enforces one destructive durable API mutation contract", () => {
    const boundary = API_ROUTE.indexOf("beginTeamMutation(request");
    expect(boundary).toBeGreaterThan(-1);
    expect(boundary).toBeLessThan(API_ROUTE.indexOf("context.params"));
    expect(boundary).toBeLessThan(API_ROUTE.indexOf("readBoundedJsonRequest("));
    expect(API_ROUTE).toContain('requiredPermissions: ["access.manage"]');
    expect(API_ROUTE).toContain('risk: "destructive"');
    expect(API_ROUTE).toContain("requiresIdempotency: true");
    expect(API_ROUTE).toContain('auditAction: "role.updated"');
    expect(API_ROUTE).toContain("claimTeamMutationIdempotency");
    expect(API_ROUTE).toContain("assertTeamMutationExpectedVersion");
    expect(API_ROUTE).toContain('.for("update")');
    expect(API_ROUTE).toContain(
      "eq(teamRoles.updatedAt, currentRole.updatedAt)",
    );
    expect(API_ROUTE).toContain(
      "Math.max(Date.now(), currentRole.updatedAt.getTime() + 1)",
    );
    expect(API_ROUTE).toContain("completeTeamMutationIdempotency(");
    expect(API_ROUTE).toContain("settleTeamMutationIdempotencyFailure(");
    expect(API_ROUTE).toContain("mutation.audit.insertSuccess(tx");
    expect(
      classifyTeamActionRisk("app/api/admin/roles/[roleId]/route.ts", "PATCH"),
    ).toBe("destructive");
  });
});
