import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NextRequest } from "next/server";

const mockGetDb = jest.fn<unknown, []>();
const mockClaimTeamMutationIdempotency = jest.fn();
const mockCompleteTeamMutationIdempotency = jest.fn(() => Promise.resolve());
const mockSettleTeamMutationIdempotencyFailure = jest.fn(() =>
  Promise.resolve(),
);
const mockTeamMutationIdempotencyReplayResponse = jest.fn();
const mockRequirePermission = jest.fn(() =>
  Promise.resolve<Response | null>(null),
);
const ROLE_ID = "11111111-1111-4111-8111-111111111111";
const ROLE_VERSION = "2026-08-08T12:30:00.000Z";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const mockTeamMembers = {
  id: "team_members.id",
  name: "team_members.name",
  email: "team_members.email",
  emailNormalized: "team_members.email_normalized",
  emailIdentityStatus: "team_members.email_identity_status",
  phoneE164: "team_members.phone_e164",
  roleId: "team_members.role_id",
  active: "team_members.active",
  defaultCrewSplitBps: "team_members.default_crew_split_bps",
  permissionsGrant: "team_members.permissions_grant",
  permissionsDeny: "team_members.permissions_deny",
};

const mockTeamRoles = {
  id: "team_roles.id",
  name: "team_roles.name",
  slug: "team_roles.slug",
  permissions: "team_roles.permissions",
  createdAt: "team_roles.created_at",
  updatedAt: "team_roles.updated_at",
};

jest.mock("@/db", () => ({
  getDb: mockGetDb,
  policySettings: {
    key: "policy_settings.key",
    value: "policy_settings.value",
  },
  teamLoginTokens: { teamMemberId: "team_login_tokens.team_member_id" },
  teamMembers: mockTeamMembers,
  teamRoles: mockTeamRoles,
  teamSessions: {
    id: "team_sessions.id",
    teamMemberId: "team_sessions.team_member_id",
    revokedAt: "team_sessions.revoked_at",
  },
}));

jest.mock("@/lib/permissions", () => ({
  computeEffectivePermissions: jest.fn(() => []),
  getDefaultPermissionsForRole: jest.fn(() => []),
  permissionMatches: jest.fn(() => false),
  requirePermission: mockRequirePermission,
}));

jest.mock("@/lib/audit", () => ({
  getAuditActorFromRequest: jest.fn(() => ({ id: "member-1" })),
  recordAuditEvent: jest.fn(() => Promise.resolve()),
}));

jest.mock("@/lib/sales-scorecard", () => ({
  SALES_SCORECARD_POLICY_KEY: "sales_scorecard",
}));

jest.mock("@/lib/verified-actor-context", () => ({
  getVerifiedRequestActor: jest.fn(() => ({
    type: "human",
    id: "member-1",
    role: "owner",
    label: "Owner",
    sessionId: "session-1",
    authMethod: "team_session",
  })),
}));

jest.mock("@/lib/team-mutation-idempotency", () => ({
  claimTeamMutationIdempotency: mockClaimTeamMutationIdempotency,
  completeTeamMutationIdempotency: mockCompleteTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure:
    mockSettleTeamMutationIdempotencyFailure,
  teamMutationIdempotencyReplayResponse:
    mockTeamMutationIdempotencyReplayResponse,
}));

jest.mock("../../app/api/web/admin", () => ({
  isAdminRequest: jest.fn(() => true),
}));

import { PATCH as updateRole } from "../../app/api/admin/roles/[roleId]/route";
import {
  GET as getRoles,
  POST as createRole,
} from "../../app/api/admin/roles/route";
import { PATCH as updateMember } from "../../app/api/admin/team/members/[memberId]/route";

function request(body: unknown): NextRequest {
  const url = new URL("https://api.example.test/api/admin/access-test");
  const raw = new Request(url, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      host: url.host,
      origin: url.origin,
      "idempotency-key": "access-permission-input-test-key-123456",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  Object.defineProperty(raw, "nextUrl", { value: url });
  return raw as unknown as NextRequest;
}

function memberUpdateRequest(update: Record<string, unknown>): NextRequest {
  const url = new URL(
    "https://api.example.test/api/admin/team/members/55555555-5555-4555-8555-555555555555",
  );
  const raw = new Request(url, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      host: url.host,
      origin: url.origin,
      "idempotency-key": "access-member-update-test-key-123456",
      "if-match": ROLE_VERSION,
    },
    body: JSON.stringify({ expectedUpdatedAt: ROLE_VERSION, ...update }),
  });
  Object.defineProperty(raw, "nextUrl", { value: url });
  return raw as unknown as NextRequest;
}

function roleUpdateRequest(update: Record<string, unknown>): NextRequest {
  const url = new URL(`https://api.example.test/api/admin/roles/${ROLE_ID}`);
  const raw = new Request(url, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      host: url.host,
      origin: url.origin,
      "idempotency-key": "access-role-update-test-key-123456",
      "if-match": ROLE_VERSION,
    },
    body: JSON.stringify({
      expectedUpdatedAt: ROLE_VERSION,
      name: "Custom role",
      slug: "custom_role",
      permissions: ["messages.read"],
      ...update,
    }),
  });
  Object.defineProperty(raw, "nextUrl", { value: url });
  return raw as unknown as NextRequest;
}

async function expectPermissionError(
  response: Response,
  expected: {
    code: "permissions_must_be_an_array" | "unsupported_permissions";
    field: "permissions" | "permissionsGrant" | "permissionsDeny";
  },
): Promise<void> {
  expect(response.status).toBe(422);
  const body: unknown = await response.json();
  expect(body).toMatchObject({ ok: false, code: "invalid" });
  const fieldErrors = isRecord(body) ? body["fieldErrors"] : null;
  expect(isRecord(fieldErrors)).toBe(true);
  expect(
    isRecord(fieldErrors) ? typeof fieldErrors[expected.field] : "missing",
  ).toBe("string");
  const message =
    typeof body === "object" &&
    body !== null &&
    "message" in body &&
    typeof body.message === "string"
      ? body.message
      : "";
  expect(message).toMatch(/\S/u);
  expect(mockClaimTeamMutationIdempotency).not.toHaveBeenCalled();
}

describe("team permission route inputs", () => {
  beforeEach(() => {
    mockGetDb.mockReset();
    mockClaimTeamMutationIdempotency.mockReset();
    mockClaimTeamMutationIdempotency.mockResolvedValue({
      kind: "execute",
      claim: {
        id: "22222222-2222-4222-8222-222222222222",
        operationId: "33333333-3333-4333-8333-333333333333",
        attemptCount: 1,
        principalHash: "a".repeat(64),
        keyHash: "b".repeat(64),
        scopeHash: "c".repeat(64),
        requestHash: "d".repeat(64),
      },
    });
    mockCompleteTeamMutationIdempotency.mockReset();
    mockCompleteTeamMutationIdempotency.mockResolvedValue(undefined);
    mockSettleTeamMutationIdempotencyFailure.mockReset();
    mockSettleTeamMutationIdempotencyFailure.mockResolvedValue(undefined);
    mockTeamMutationIdempotencyReplayResponse.mockReset();
    mockRequirePermission.mockReset();
    mockRequirePermission.mockResolvedValue(null);
    mockGetDb.mockImplementation(() => {
      throw new Error("permission validation must run before database access");
    });
  });

  it("returns a truthful empty role list without provisioning during GET", async () => {
    const orderBy = jest.fn(() => Promise.resolve([]));
    const from = jest.fn(() => ({ orderBy }));
    const select = jest.fn(() => ({ from }));
    const insert = jest.fn(() => {
      throw new Error("GET must not insert roles");
    });
    const transaction = jest.fn(() => {
      throw new Error("GET must not open a write transaction");
    });
    mockGetDb.mockReturnValue({ insert, select, transaction });

    const response = await getRoles(request(undefined));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ roles: [] });
    expect(select).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledTimes(1);
    expect(orderBy).toHaveBeenCalledTimes(1);
    expect(insert).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each(["*", "read", "messages.*", "access.break_glass", "unknown.use"])(
    "rejects non-assignable role permission %s before creating a role",
    async (permission) => {
      await expectPermissionError(
        await createRole(
          request({
            name: "Restricted role",
            slug: "restricted",
            permissions: [permission],
          }),
        ),
        { code: "unsupported_permissions", field: "permissions" },
      );
    },
  );

  it("rejects a malformed permission list before updating a role", async () => {
    const response = await updateRole(
      roleUpdateRequest({ permissions: "messages.read" }),
      { params: Promise.resolve({ roleId: ROLE_ID }) },
    );
    expect(response.status).toBe(422);
    const payload = (await response.json()) as {
      ok?: unknown;
      code?: unknown;
      fieldErrors?: Record<string, unknown>;
    };
    expect(payload).toMatchObject({ ok: false, code: "invalid" });
    const permissionError = payload.fieldErrors?.["permissions"];
    expect(typeof permissionError).toBe("string");
    if (typeof permissionError !== "string") {
      throw new Error("expected a permission field error");
    }
    expect(permissionError).toMatch(/\S/u);
    expect(mockClaimTeamMutationIdempotency).not.toHaveBeenCalled();
  });

  it("denies the API role update before params, body parsing, or business database access", async () => {
    mockRequirePermission.mockResolvedValueOnce(
      Response.json({ error: "forbidden" }, { status: 403 }),
    );
    const deniedRequest = roleUpdateRequest({});
    const context = {} as { params: Promise<{ roleId: string }> };
    Object.defineProperty(context, "params", {
      get: () => {
        throw new Error("params_must_not_be_read_before_authorization");
      },
    });

    const response = await updateRole(deniedRequest, context);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      code: "forbidden",
      message: "You do not have permission to perform this action.",
      retryable: false,
    });
    expect(deniedRequest.bodyUsed).toBe(false);
    // The boundary may open the best-effort denied-action audit writer, but it
    // must never claim or enter the role mutation transaction.
    expect(mockGetDb).toHaveBeenCalledTimes(1);
    expect(mockClaimTeamMutationIdempotency).not.toHaveBeenCalled();
  });

  it("returns a durable replay without executing the role transaction again", async () => {
    const replay = {
      status: 200,
      result: {
        ok: true,
        data: { replayed: true },
        receipt: { operationId: "existing-operation" },
      },
    };
    const replayResponse = Response.json(replay.result, { status: 200 });
    mockClaimTeamMutationIdempotency.mockResolvedValueOnce({
      kind: "replay",
      replay,
    });
    mockTeamMutationIdempotencyReplayResponse.mockReturnValueOnce(
      replayResponse,
    );
    const transaction = jest.fn();
    mockGetDb.mockReturnValue({ transaction });

    const response = await updateRole(roleUpdateRequest({}), {
      params: Promise.resolve({ roleId: ROLE_ID }),
    });

    expect(response).toBe(replayResponse);
    expect(mockClaimTeamMutationIdempotency).toHaveBeenCalledTimes(1);
    expect(mockTeamMutationIdempotencyReplayResponse).toHaveBeenCalledWith(
      replay,
    );
    expect(transaction).not.toHaveBeenCalled();
    expect(mockCompleteTeamMutationIdempotency).not.toHaveBeenCalled();
    expect(mockSettleTeamMutationIdempotencyFailure).not.toHaveBeenCalled();
  });

  it("rejects custom creation with a reserved slug without mutating roles", async () => {
    const response = await createRole(
      request({ name: "Forged owner", slug: " OWNER ", permissions: [] }),
    );

    expect(response.status).toBe(409);
    const payload: unknown = await response.json();
    expect(payload).toMatchObject({
      ok: false,
      code: "conflict",
      retryable: false,
    });
    const fieldErrors = isRecord(payload) ? payload["fieldErrors"] : null;
    expect(
      isRecord(fieldErrors) && typeof fieldErrors["slug"] === "string",
    ).toBe(true);
    expect(mockClaimTeamMutationIdempotency).not.toHaveBeenCalled();
  });

  it.each(["a", "2_sales", "sales east", "sales/east"])(
    "rejects malformed custom role slug %s before persistence",
    async (slug) => {
      const response = await createRole(
        request({ name: "Malformed role", slug, permissions: [] }),
      );

      expect(response.status).toBe(422);
      const payload: unknown = await response.json();
      expect(payload).toMatchObject({
        ok: false,
        code: "invalid",
        retryable: false,
      });
      const fieldErrors = isRecord(payload) ? payload["fieldErrors"] : null;
      expect(
        isRecord(fieldErrors) && typeof fieldErrors["slug"] === "string",
      ).toBe(true);
      expect(mockClaimTeamMutationIdempotency).not.toHaveBeenCalled();
    },
  );

  it("rejects a malformed custom role slug before loading the role to update", async () => {
    const response = await updateRole(
      roleUpdateRequest({ slug: "sales/east" }),
      {
        params: Promise.resolve({ roleId: ROLE_ID }),
      },
    );

    expect(response.status).toBe(422);
    const payload = (await response.json()) as {
      ok?: unknown;
      code?: unknown;
      retryable?: unknown;
      fieldErrors?: Record<string, unknown>;
    };
    expect(payload).toMatchObject({
      ok: false,
      code: "invalid",
      retryable: false,
    });
    const slugError = payload.fieldErrors?.["slug"];
    expect(typeof slugError).toBe("string");
    if (typeof slugError !== "string") {
      throw new Error("expected a slug field error");
    }
    expect(slugError).toMatch(/\S/u);
    expect(mockClaimTeamMutationIdempotency).not.toHaveBeenCalled();
  });

  it("normalizes valid permissions and a custom slug before persistence", async () => {
    const createValues = jest.fn((values: Record<string, unknown>) => ({
      returning: jest.fn(() =>
        Promise.resolve([
          {
            id: "role-2",
            name: values["name"],
            slug: values["slug"],
            permissions: values["permissions"],
            createdAt: new Date("2026-08-08T12:30:00.000Z"),
            updatedAt: new Date("2026-08-08T12:30:00.000Z"),
          },
        ]),
      ),
    }));
    const transaction = jest.fn(
      async (callback: (tx: Record<string, unknown>) => Promise<unknown>) =>
        callback({
          insert: jest
            .fn()
            .mockReturnValueOnce({
              values: jest.fn(() => ({
                onConflictDoNothing: jest.fn(() => Promise.resolve()),
              })),
            })
            .mockReturnValueOnce({ values: createValues })
            .mockReturnValueOnce({
              values: jest.fn(() => Promise.resolve()),
            }),
        }),
    );
    mockGetDb.mockReturnValue({ transaction });

    const response = await createRole(
      request({
        name: "Dispatcher",
        slug: "  Custom_Dispatch  ",
        permissions: ["appointments.update", "messages.read"],
      }),
    );

    expect(response.status).toBe(201);
    expect(createValues).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "custom_dispatch",
        permissions: ["appointments.update", "messages.read"],
      }),
    );
  });

  it("returns a deterministic conflict when a custom role slug already exists", async () => {
    const duplicateSlugError = Object.assign(new Error("duplicate role slug"), {
      code: "23505",
      constraint: "team_roles_slug_key",
    });
    const transaction = jest.fn(() => Promise.reject(duplicateSlugError));
    mockGetDb.mockReturnValue({ transaction });

    const response = await createRole(
      request({ name: "Duplicate", slug: "existing_role", permissions: [] }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        code: "conflict",
        message: "Another role already uses that slug.",
        retryable: false,
      }),
    );
  });

  it.each([
    {
      name: "built-in slug rename",
      current: { id: "role-1", slug: "owner", permissions: ["*"] },
      update: { slug: "custom_owner" },
      message: "Built-in role slugs are permanent.",
    },
    {
      name: "reserved slug adoption",
      current: {
        id: "role-1",
        slug: "custom_role",
        permissions: ["messages.read"],
      },
      update: { slug: "office" },
      message: "That slug is reserved for a built-in role.",
    },
    {
      name: "owner access removal",
      current: { id: "role-1", slug: "owner", permissions: ["*"] },
      update: { permissions: ["messages.read"] },
      message: "The Owner role must retain Access administration permission.",
    },
  ])("blocks $name", async ({ current, update, message }) => {
    const currentRole = {
      ...current,
      id: ROLE_ID,
      name: "Current role",
      createdAt: new Date("2026-08-08T12:00:00.000Z"),
      updatedAt: new Date(ROLE_VERSION),
    };
    const transaction = jest.fn(
      async (callback: (tx: Record<string, unknown>) => Promise<unknown>) => {
        const tx = {
          execute: jest.fn(() => Promise.resolve()),
          select: jest.fn(() => ({
            from: jest.fn(() => ({
              where: jest.fn(() => ({
                for: jest.fn(() => ({
                  limit: jest.fn(() => Promise.resolve([currentRole])),
                })),
              })),
            })),
          })),
        };
        return callback(tx);
      },
    );
    mockGetDb.mockReturnValue({ transaction });

    const response = await updateRole(
      roleUpdateRequest({ slug: current.slug, ...update }),
      {
        params: Promise.resolve({ roleId: ROLE_ID }),
      },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        code: "conflict",
        message,
        retryable: false,
      }),
    );
  });

  it("returns a deterministic conflict for a concurrent duplicate slug", async () => {
    const duplicateSlugError = Object.assign(new Error("duplicate role slug"), {
      code: "23505",
      constraint: "team_roles_slug_key",
    });
    mockGetDb.mockReturnValue({
      transaction: jest.fn(() => Promise.reject(duplicateSlugError)),
    });

    const response = await updateRole(
      roleUpdateRequest({ slug: "existing_role" }),
      {
        params: Promise.resolve({ roleId: ROLE_ID }),
      },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        code: "conflict",
        message: "Another role already uses that slug.",
        retryable: false,
      }),
    );
  });

  it.each(["permissionsGrant", "permissionsDeny"] as const)(
    "rejects forged %s values before member safety or persistence",
    async (field) => {
      await expectPermissionError(
        await updateMember(
          memberUpdateRequest({
            name: "Team member",
            [field]: ["appointments.*"],
          }),
          {
            params: Promise.resolve({
              memberId: "55555555-5555-4555-8555-555555555555",
            }),
          },
        ),
        { code: "unsupported_permissions", field },
      );
    },
  );

  it("reads the Access role checkbox values as a multi-value input", () => {
    const siteRoute = readFileSync(
      join(process.cwd(), "../site/src/app/api/team/access/roles/route.ts"),
      "utf8",
    );

    expect(siteRoute).toContain('form.getAll("permissions")');
    expect(siteRoute).toContain("isAssignableTeamPermission");
    expect(siteRoute).not.toContain('.split(",")');
  });
});
