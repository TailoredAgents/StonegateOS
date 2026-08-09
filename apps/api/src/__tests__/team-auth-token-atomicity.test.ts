import type { NextRequest } from "next/server";

type MockSelectQuery = {
  from: (...args: unknown[]) => MockSelectQuery;
  leftJoin: (...args: unknown[]) => MockSelectQuery;
  where: (...args: unknown[]) => MockSelectQuery;
  for: (...args: unknown[]) => MockSelectQuery;
  limit: (...args: unknown[]) => Promise<Array<Record<string, unknown>>>;
};

type QueryRows = Array<Record<string, unknown>>;

type TransactionCallback = (transaction: unknown) => Promise<unknown>;

const mockDb = {
  transaction: jest.fn<Promise<unknown>, [TransactionCallback]>(),
  select: jest.fn<MockSelectQuery, [unknown?]>(),
  update: jest.fn<unknown, [unknown?]>(),
};

const mockTeamSessions = {
  id: "team_sessions.id",
  teamMemberId: "team_sessions.team_member_id",
  sessionHash: "team_sessions.session_hash",
  authMethod: "team_sessions.auth_method",
  expiresAt: "team_sessions.expires_at",
  revokedAt: "team_sessions.revoked_at",
};

jest.mock("@/db", () => ({
  getDb: () => mockDb,
  auditLogs: "audit_logs",
  policySettings: {
    key: "policy_settings.key",
    value: "policy_settings.value",
  },
  teamLoginTokens: {
    id: "team_login_tokens.id",
    teamMemberId: "team_login_tokens.team_member_id",
    tokenHash: "team_login_tokens.token_hash",
    expiresAt: "team_login_tokens.expires_at",
  },
  teamMembers: {
    id: "team_members.id",
    name: "team_members.name",
    email: "team_members.email",
    emailNormalized: "team_members.email_normalized",
    active: "team_members.active",
    passwordHash: "team_members.password_hash",
    passwordSetAt: "team_members.password_set_at",
    roleId: "team_members.role_id",
    permissionsGrant: "team_members.permissions_grant",
    permissionsDeny: "team_members.permissions_deny",
    updatedAt: "team_members.updated_at",
  },
  teamRoles: {
    id: "team_roles.id",
    slug: "team_roles.slug",
    permissions: "team_roles.permissions",
  },
  teamSessions: mockTeamSessions,
}));

jest.mock("@/lib/permissions", () => ({
  computeEffectivePermissions: () => ["contacts.read"],
  getDefaultPermissionsForRole: () => [],
}));

import {
  createTeamLoginToken,
  exchangeTeamLoginToken,
  requireTeamSession,
} from "@/lib/team-auth";

function request(headers: Record<string, string> = {}): NextRequest {
  return { headers: new Headers(headers) } as NextRequest;
}

function selectQuery(rows: Array<Record<string, unknown>>): MockSelectQuery {
  const query = {
    from: (..._args: unknown[]) => query,
    leftJoin: (..._args: unknown[]) => query,
    where: (..._args: unknown[]) => query,
    for: (..._args: unknown[]) => query,
    limit: (..._args: unknown[]) => Promise.resolve(rows),
  };
  return query;
}

describe("team magic-link transaction semantics", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("locks the member, invalidates prior live links, and inserts the replacement in one transaction", async () => {
    const deleteWhere = jest.fn(() => Promise.resolve(undefined));
    const insertValues = jest.fn(() => Promise.resolve(undefined));
    const tx = {
      select: jest.fn(() => selectQuery([{ id: "member-1" }])),
      delete: jest.fn(() => ({ where: deleteWhere })),
      insert: jest.fn(() => ({ values: insertValues })),
    };
    mockDb.transaction.mockImplementation((callback) => callback(tx));

    await createTeamLoginToken("member-1", request(), 30);

    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(tx.select).toHaveBeenCalledTimes(1);
    expect(deleteWhere).toHaveBeenCalledTimes(1);
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ teamMemberId: "member-1" }),
    );
    expect(deleteWhere.mock.invocationCallOrder[0]).toBeLessThan(
      insertValues.mock.invocationCallOrder[0]!,
    );
  });

  it("creates at most one session when the token delete returns only once", async () => {
    const consumedRows: Array<Array<{ teamMemberId: string }>> = [
      [{ teamMemberId: "member-1" }],
      [],
    ];
    const selectedRows: QueryRows[] = [
      [{ teamMemberId: "member-1" }],
      [
        {
          id: "member-1",
          name: "Staff Member",
          email: "staff@example.com",
          active: true,
          passwordHash: "configured",
          roleSlug: "office",
        },
      ],
      [{ teamMemberId: "member-1" }],
      [
        {
          id: "member-1",
          name: "Staff Member",
          email: "staff@example.com",
          active: true,
          passwordHash: "configured",
          roleSlug: "office",
        },
      ],
    ];
    const sessionInsertValues = jest.fn(() => Promise.resolve(undefined));
    const auditInsertValues = jest.fn(() => Promise.resolve(undefined));
    const tx = {
      delete: jest.fn(() => ({
        where: () => ({
          returning: () => Promise.resolve(consumedRows.shift() ?? []),
        }),
      })),
      select: jest.fn(() => selectQuery(selectedRows.shift() ?? [])),
      insert: jest.fn((table: unknown) => ({
        values:
          table === mockTeamSessions ? sessionInsertValues : auditInsertValues,
      })),
    };
    mockDb.transaction.mockImplementation((callback) => callback(tx));

    const first = await exchangeTeamLoginToken(
      "one-time-token",
      request(),
      30,
      { correlationId: "correlation-1", surface: "/team/auth" },
    );
    const replay = await exchangeTeamLoginToken(
      "one-time-token",
      request(),
      30,
      { correlationId: "correlation-2", surface: "/team/auth" },
    );

    expect(first).not.toBeNull();
    expect(first?.sessionToken).toEqual(expect.any(String));
    expect(first?.needsPasswordSetup).toBe(false);
    expect(replay).toBeNull();
    expect(sessionInsertValues).toHaveBeenCalledTimes(1);
    expect(auditInsertValues).toHaveBeenCalledTimes(2);
    for (const [audit] of auditInsertValues.mock.calls) {
      expect(audit).toEqual(
        expect.objectContaining({
          actorId: "member-1",
          actorRole: "office",
          sessionId: first?.sessionId,
          entityId: first?.sessionId,
          outcome: "succeeded",
          correlationId: "correlation-1",
        }),
      );
    }
    expect(mockDb.transaction).toHaveBeenCalledTimes(2);
  });
});

describe("verified team session metadata", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns the verified session ID and auth method without exposing its hash", async () => {
    const rows: Array<Array<Record<string, unknown>>> = [
      [
        {
          id: "session-1",
          teamMemberId: "member-1",
          authMethod: "team_session",
          expiresAt: new Date(Date.now() + 60_000),
          revokedAt: null,
        },
      ],
      [
        {
          id: "member-1",
          name: "Staff Member",
          email: "staff@example.com",
          active: true,
          passwordHash: "configured",
          roleSlug: "office",
          rolePermissions: [],
          permissionsGrant: [],
          permissionsDeny: [],
        },
      ],
    ];
    mockDb.select.mockImplementation(() => selectQuery(rows.shift() ?? []));
    mockDb.update.mockImplementation(() => ({
      set: () => ({ where: () => Promise.resolve(undefined) }),
    }));

    const result = await requireTeamSession(
      request({ authorization: "Bearer verified-session-token" }),
    );

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        sessionId: "session-1",
        authMethod: "team_session",
      }),
    );
    expect(JSON.stringify(result)).not.toContain("verified-session-token");
    expect(JSON.stringify(result)).not.toContain("sessionHash");
  });
});
