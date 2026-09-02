import type { NextRequest } from "next/server";

const jest = import.meta.jest;
const mockModule = jest.unstable_mockModule as unknown as (
  moduleName: string,
  factory: () => Record<string, unknown>,
) => void;

let mockRows: Array<Array<Record<string, unknown>>> = [];

function mockQuery() {
  const query = {
    from: () => query,
    innerJoin: () => query,
    leftJoin: () => query,
    where: () => query,
    limit: () => Promise.resolve(mockRows.shift() ?? []),
  };
  return query;
}

const mockDb = {
  select: jest.fn(() => mockQuery()),
};

mockModule("@/db", () => ({
  auditLogs: {},
  getDb: () => mockDb,
  teamMembers: {
    id: "team_members.id",
    name: "team_members.name",
    active: "team_members.active",
    roleId: "team_members.role_id",
    permissionsGrant: "team_members.permissions_grant",
    permissionsDeny: "team_members.permissions_deny",
  },
  teamRoles: {
    id: "team_roles.id",
    slug: "team_roles.slug",
    permissions: "team_roles.permissions",
  },
  teamSessions: {
    id: "team_sessions.id",
    teamMemberId: "team_sessions.team_member_id",
    sessionHash: "team_sessions.session_hash",
    authMethod: "team_sessions.auth_method",
    createdAt: "team_sessions.created_at",
    assuranceLevel: "team_sessions.assurance_level",
    mfaVerifiedAt: "team_sessions.mfa_verified_at",
    expiresAt: "team_sessions.expires_at",
    revokedAt: "team_sessions.revoked_at",
  },
}));

const { requirePermission, resolvePermissionContext } = await import(
  "@/lib/permissions"
);
const { getAuditActorFromRequest } = await import("@/lib/audit");

function request(headers: Record<string, string>): NextRequest {
  return { headers: new Headers(headers) } as NextRequest;
}

function activeSessionRow(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    sessionId: "11111111-1111-4111-8111-111111111111",
    authMethod: "team_session",
    authenticatedAt: new Date(),
    assuranceLevel: "aal1",
    mfaVerifiedAt: null,
    memberId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    memberName: "Verified Sales User",
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
    active: true,
    roleSlug: "sales",
    permissions: ["quotes.send"],
    permissionsGrant: [],
    permissionsDeny: [],
    ...overrides,
  };
}

describe("permission principal resolution", () => {
  const originalAdminKey = process.env["ADMIN_API_KEY"];

  beforeAll(() => {
    process.env["ADMIN_API_KEY"] = "internal-key";
  });

  afterAll(() => {
    if (originalAdminKey === undefined) {
      delete process.env["ADMIN_API_KEY"];
    } else {
      process.env["ADMIN_API_KEY"] = originalAdminKey;
    }
  });

  beforeEach(() => {
    mockRows = [];
    mockDb.select.mockClear();
  });

  it("prefers and verifies a forwarded team session over spoofed actor headers", async () => {
    mockRows.push([activeSessionRow()]);

    const teamRequest = request({
      "x-api-key": "internal-key",
      authorization: "Bearer verified-team-session",
      "x-actor-type": "human",
      "x-actor-id": "22222222-2222-4222-8222-222222222222",
      "x-actor-role": "owner",
      "x-actor-label": "Spoofed Owner",
    });
    const context = await resolvePermissionContext(teamRequest);

    expect(context).toEqual(
      expect.objectContaining({
        authenticated: true,
        source: "team_session",
        role: "sales",
      }),
    );
    expect(context.permissions).toContain("quotes.send");
    expect(context.permissions).not.toContain("*");
    expect(getAuditActorFromRequest(teamRequest)).toEqual({
      type: "human",
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      role: "sales",
      label: "Verified Sales User",
      sessionId: "11111111-1111-4111-8111-111111111111",
      authMethod: "team_session",
      authenticatedAt: expect.any(String) as unknown,
      assuranceLevel: "aal1",
      mfaVerifiedAt: null,
    });
  });

  it("propagates a persisted break-glass method into verified actor context", async () => {
    mockRows.push([activeSessionRow({ authMethod: "break_glass" })]);
    const teamRequest = request({
      "x-api-key": "internal-key",
      authorization: "Bearer verified-break-glass-session",
    });

    const context = await resolvePermissionContext(teamRequest);

    expect(context).toEqual(
      expect.objectContaining({
        authenticated: true,
        source: "break_glass",
        sessionId: "11111111-1111-4111-8111-111111111111",
      }),
    );
    expect(getAuditActorFromRequest(teamRequest)).toEqual({
      type: "human",
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      role: "sales",
      label: "Verified Sales User",
      sessionId: "11111111-1111-4111-8111-111111111111",
      authMethod: "break_glass",
      authenticatedAt: expect.any(String) as unknown,
      assuranceLevel: "aal1",
      mfaVerifiedAt: null,
    });
  });

  it("does not fall back to a service principal when a forwarded session is invalid", async () => {
    mockRows.push([]);

    const context = await resolvePermissionContext(
      request({
        "x-api-key": "internal-key",
        authorization: "Bearer invalid-team-session",
        "x-actor-type": "worker",
        "x-actor-label": "sales-draft-prep",
      }),
    );

    expect(context).toEqual({
      authenticated: false,
      source: null,
      role: null,
      permissions: [],
      principalId: null,
      principalLabel: null,
      sessionId: null,
      authenticatedAt: null,
      assuranceLevel: null,
      mfaVerifiedAt: null,
    });
  });

  it("rejects expired, revoked, and inactive forwarded sessions", async () => {
    mockRows.push([
      activeSessionRow({ expiresAt: new Date(Date.now() - 1_000) }),
    ]);
    await expect(
      resolvePermissionContext(
        request({
          "x-api-key": "internal-key",
          authorization: "Bearer expired-team-session",
        }),
      ),
    ).resolves.toEqual(
      expect.objectContaining({ authenticated: false, permissions: [] }),
    );

    mockRows.push([
      activeSessionRow({ revokedAt: new Date(Date.now() - 1_000) }),
    ]);
    await expect(
      resolvePermissionContext(
        request({
          "x-api-key": "internal-key",
          authorization: "Bearer revoked-team-session",
        }),
      ),
    ).resolves.toEqual(
      expect.objectContaining({ authenticated: false, permissions: [] }),
    );

    mockRows.push([activeSessionRow({ active: false })]);
    await expect(
      resolvePermissionContext(
        request({
          "x-api-key": "internal-key",
          authorization: "Bearer inactive-team-session",
        }),
      ),
    ).resolves.toEqual(
      expect.objectContaining({ authenticated: false, permissions: [] }),
    );
  });

  it("returns 401 for key-only and role-only human requests", async () => {
    const keyOnly = await requirePermission(
      request({ "x-api-key": "internal-key" }),
      "messages.read",
    );
    expect(keyOnly?.status).toBe(401);

    const roleOnly = await requirePermission(
      request({
        "x-api-key": "internal-key",
        "x-actor-type": "human",
        "x-actor-role": "owner",
      }),
      "access.manage",
    );
    expect(roleOnly?.status).toBe(401);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("rejects spoofed human and service principals when the internal key is wrong", async () => {
    const spoofedHuman = await requirePermission(
      request({
        "x-api-key": "wrong-key",
        authorization: "Bearer valid-looking-team-session",
        "x-actor-type": "human",
        "x-actor-id": "33333333-3333-4333-8333-333333333333",
      }),
      "messages.read",
    );
    expect(spoofedHuman?.status).toBe(401);

    const spoofedWorker = await requirePermission(
      request({
        "x-api-key": "wrong-key",
        "x-actor-type": "worker",
        "x-actor-label": "sales-draft-prep",
      }),
      "messages.send",
    );
    expect(spoofedWorker?.status).toBe(401);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("rejects database-backed actor headers when no verified session is present", async () => {
    const teamRequest = request({
      "x-api-key": "internal-key",
      "x-actor-type": "human",
      "x-actor-id": "33333333-3333-4333-8333-333333333333",
      "x-actor-role": "owner",
      "x-actor-label": "Spoofed Owner",
    });
    const context = await resolvePermissionContext(teamRequest);

    expect(context.authenticated).toBe(false);
    expect(context.source).toBeNull();
    expect(context.permissions).toEqual([]);
    expect(mockDb.select).not.toHaveBeenCalled();
    expect(getAuditActorFromRequest(teamRequest)).toEqual({});
  });

  it("allows only the scoped permissions of named API workers", async () => {
    const workerRequest = request({
      "x-api-key": "internal-key",
      "x-actor-type": "worker",
      "x-actor-label": "sales-draft-prep",
      "x-actor-role": "owner",
    });

    await expect(
      requirePermission(workerRequest, "messages.send"),
    ).resolves.toBeNull();
    await expect(
      requirePermission(workerRequest, "messages.write"),
    ).resolves.toBeNull();

    const denied = await requirePermission(workerRequest, "access.manage");
    expect(denied?.status).toBe(403);

    const facebookRequest = request({
      "x-api-key": "internal-key",
      "x-actor-type": "worker",
      "x-actor-label": "facebook-autopilot",
    });
    await expect(
      requirePermission(facebookRequest, "bookings.manage"),
    ).resolves.toBeNull();
    expect(
      (await requirePermission(facebookRequest, "messages.send"))?.status,
    ).toBe(403);

    const dispatcherRequest = request({
      "x-api-key": "internal-key",
      "x-actor-type": "worker",
      "x-actor-label": "outbox-dispatcher",
    });
    await expect(
      requirePermission(dispatcherRequest, "outbox.dispatch"),
    ).resolves.toBeNull();
    expect(
      (await requirePermission(dispatcherRequest, "messages.send"))?.status,
    ).toBe(403);

    const publicChatRequest = request({
      "x-api-key": "internal-key",
      "x-actor-type": "worker",
      "x-actor-label": "public-chat-booking",
    });
    for (const permission of [
      "contacts.write",
      "properties.write",
      "pipeline.write",
      "bookings.manage",
    ] as const) {
      await expect(
        requirePermission(publicChatRequest, permission),
      ).resolves.toBeNull();
    }
    expect(
      (await requirePermission(publicChatRequest, "contacts.read"))?.status,
    ).toBe(403);
    expect(
      (await requirePermission(publicChatRequest, "messages.send"))?.status,
    ).toBe(403);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("reserves break-glass exchange for one narrow named service", async () => {
    const exchangeRequest = request({
      "x-api-key": "internal-key",
      "x-actor-type": "worker",
      "x-actor-label": "team-break-glass-exchange",
    });

    await expect(
      requirePermission(exchangeRequest, "access.break_glass"),
    ).resolves.toBeNull();
    expect(
      (await requirePermission(exchangeRequest, "access.manage"))?.status,
    ).toBe(403);

    const unrelatedWorker = request({
      "x-api-key": "internal-key",
      "x-actor-type": "worker",
      "x-actor-label": "outbox-dispatcher",
    });
    expect(
      (await requirePermission(unrelatedWorker, "access.break_glass"))?.status,
    ).toBe(403);
  });

  it("requires every permission when a high-risk route uses all mode", async () => {
    const headers = {
      "x-api-key": "internal-key",
      authorization: "Bearer reconciliation-session",
    };
    mockRows.push([
      activeSessionRow({
        roleSlug: "custom",
        permissions: ["payments.reconcile"],
      }),
    ]);

    const missingFinancialAuthority = await requirePermission(
      request(headers),
      ["payments.reconcile", "payments.manage"],
      { mode: "all" },
    );
    expect(missingFinancialAuthority?.status).toBe(403);

    mockRows.push([
      activeSessionRow({
        roleSlug: "custom",
        permissions: ["payments.reconcile", "payments.manage"],
      }),
    ]);
    await expect(
      requirePermission(
        request(headers),
        ["payments.reconcile", "payments.manage"],
        { mode: "all" },
      ),
    ).resolves.toBeNull();
  });

  it("applies server-side kill switches after authenticating an allowed principal", async () => {
    process.env["TEAM_KILL_OUTBOX_DISPATCH"] = "1";
    try {
      const response = await requirePermission(
        request({
          "x-api-key": "internal-key",
          "x-actor-type": "worker",
          "x-actor-label": "outbox-dispatcher",
        }),
        "outbox.dispatch",
      );

      expect(response?.status).toBe(503);
      await expect(response?.json()).resolves.toEqual(
        expect.objectContaining({
          error: "operation_disabled",
          category: "outbox_dispatch",
          retryable: false,
        }),
      );
    } finally {
      delete process.env["TEAM_KILL_OUTBOX_DISPATCH"];
    }
  });

  it("rejects unknown and mislabeled non-human principals", async () => {
    const unknown = await requirePermission(
      request({
        "x-api-key": "internal-key",
        "x-actor-type": "worker",
        "x-actor-label": "unknown-worker",
      }),
      "appointments.read",
    );
    expect(unknown?.status).toBe(401);

    const wrongType = await requirePermission(
      request({
        "x-api-key": "internal-key",
        "x-actor-type": "human",
        "x-actor-label": "facebook-autopilot",
      }),
      "bookings.manage",
    );
    expect(wrongType?.status).toBe(401);
  });
});
