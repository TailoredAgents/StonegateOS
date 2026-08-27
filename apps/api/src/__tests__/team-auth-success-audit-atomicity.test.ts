import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NextRequest } from "next/server";

type QueryRows = Array<Record<string, unknown>>;
type TransactionCallback = (tx: MockTransaction) => Promise<unknown>;

const mockTables = {
  auditLogs: { name: "audit_logs" },
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
    phoneE164: "team_members.phone_e164",
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
  teamSessions: {
    id: "team_sessions.id",
    teamMemberId: "team_sessions.team_member_id",
    sessionHash: "team_sessions.session_hash",
    authMethod: "team_sessions.auth_method",
    ip: "team_sessions.ip",
    userAgent: "team_sessions.user_agent",
    expiresAt: "team_sessions.expires_at",
    createdAt: "team_sessions.created_at",
    lastSeenAt: "team_sessions.last_seen_at",
    revokedAt: "team_sessions.revoked_at",
  },
};

type MockTransaction = ReturnType<typeof createTransaction>;

const mockDb = {
  transaction: jest.fn<Promise<unknown>, [TransactionCallback]>(),
};

jest.mock("@/db", () => ({
  getDb: () => mockDb,
  ...mockTables,
}));

jest.mock("@/lib/permissions", () => ({
  computeEffectivePermissions: () => [],
  permissionMatches: () => false,
  restrictOwnerOnlyPermissionsForRole: (
    _role: string | null,
    permissions: string[],
  ) => permissions,
}));

import {
  exchangeTeamLoginToken,
  hashPassword,
  loginWithPassword,
  revokeTeamSession,
  setTeamMemberPassword,
} from "@/lib/team-auth";

function request(headers: Record<string, string> = {}): NextRequest {
  return { headers: new Headers(headers) } as NextRequest;
}

function queryResult(rows: QueryRows): {
  returning: () => Promise<QueryRows>;
  then: Promise<QueryRows>["then"];
} {
  const promise = Promise.resolve(rows);
  return {
    returning: () => promise,
    then: promise.then.bind(promise),
  };
}

function createTransaction(input: {
  selectRows: QueryRows[];
  updateRows?: QueryRows[];
  deleteRows?: QueryRows[];
  failAudit?: boolean;
}) {
  const staged: Array<{ table: unknown; value: unknown }> = [];
  const auditRows: Array<Record<string, unknown>> = [];
  const selectRows = [...input.selectRows];
  const updateRows = [...(input.updateRows ?? [])];
  const deleteRows = [...(input.deleteRows ?? [])];

  const tx = {
    staged,
    auditRows,
    select: jest.fn(() => {
      const query = {
        from: (..._args: unknown[]) => query,
        leftJoin: (..._args: unknown[]) => query,
        where: (..._args: unknown[]) => query,
        for: (..._args: unknown[]) => query,
        limit: (..._args: unknown[]) =>
          Promise.resolve(selectRows.shift() ?? []),
      };
      return query;
    }),
    insert: jest.fn((table: unknown) => ({
      values: (value: Record<string, unknown>) => {
        if (table === mockTables.auditLogs) {
          if (input.failAudit) {
            return Promise.reject(new Error("audit unavailable"));
          }
          auditRows.push(value);
        }
        staged.push({ table, value });
        return Promise.resolve();
      },
    })),
    update: jest.fn((table: unknown) => ({
      set: (value: Record<string, unknown>) => ({
        where: (..._args: unknown[]) => {
          staged.push({ table, value });
          return queryResult(updateRows.shift() ?? []);
        },
      }),
    })),
    delete: jest.fn((table: unknown) => ({
      where: (..._args: unknown[]) => {
        staged.push({ table, value: { deleted: true } });
        return queryResult(deleteRows.shift() ?? []);
      },
    })),
  };
  return tx;
}

function useTransaction(
  tx: MockTransaction,
  committed: Array<{ table: unknown; value: unknown }>,
): void {
  mockDb.transaction.mockImplementationOnce(async (callback) => {
    const result = await callback(tx);
    committed.push(...tx.staged);
    return result;
  });
}

const auditContext = {
  correlationId: "287cc8f4-3ef1-4e87-a891-29a488b5fc92",
  surface: "/team/login" as const,
};

describe("transaction-bound team authentication success audits", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("rolls back password-login session issuance when its success audit fails", async () => {
    const tx = createTransaction({
      selectRows: [
        [
          {
            id: "11111111-1111-4111-8111-111111111111",
            name: "Database Member",
            active: true,
            passwordHash: hashPassword("correct-password"),
            roleSlug: "database-role",
          },
        ],
      ],
      failAudit: true,
    });
    const committed: Array<{ table: unknown; value: unknown }> = [];
    useTransaction(tx, committed);

    await expect(
      loginWithPassword(
        "member@example.com",
        "correct-password",
        request(),
        30,
        auditContext,
      ),
    ).rejects.toThrow("audit unavailable");

    expect(
      tx.staged.some((entry) => entry.table === mockTables.teamSessions),
    ).toBe(true);
    expect(committed).toEqual([]);
  });

  it("attributes password-login success to the member, role, and new session read or created in the transaction", async () => {
    const tx = createTransaction({
      selectRows: [
        [
          {
            id: "11111111-1111-4111-8111-111111111111",
            name: "Database Member",
            active: true,
            passwordHash: hashPassword("correct-password"),
            roleSlug: "database-role",
          },
        ],
      ],
    });
    const committed: Array<{ table: unknown; value: unknown }> = [];
    useTransaction(tx, committed);

    const result = await loginWithPassword(
      "member@example.com",
      "correct-password",
      request({ "x-forwarded-for": "203.0.113.10" }),
      30,
      auditContext,
    );
    const session = committed.find(
      (entry) => entry.table === mockTables.teamSessions,
    )?.value as Record<string, unknown>;
    const audit = tx.auditRows[0];

    expect(result?.sessionId).toBe(session["id"]);
    expect(audit).toEqual(
      expect.objectContaining({
        action: "team.auth.password.login",
        actorId: "11111111-1111-4111-8111-111111111111",
        actorRole: "database-role",
        sessionId: session["id"],
        entityId: session["id"],
        outcome: "succeeded",
      }),
    );
    expect(JSON.stringify(audit)).not.toContain("correct-password");
    expect(JSON.stringify(audit)).not.toContain("member@example.com");
    expect(JSON.stringify(audit)).not.toContain("203.0.113.10");
  });

  it("rolls back token consumption and session issuance when either exchange audit cannot persist", async () => {
    const tx = createTransaction({
      selectRows: [
        [{ teamMemberId: "11111111-1111-4111-8111-111111111111" }],
        [
          {
            id: "11111111-1111-4111-8111-111111111111",
            name: "Database Member",
            email: "member@example.com",
            active: true,
            passwordHash: "configured",
            roleSlug: "database-role",
          },
        ],
      ],
      deleteRows: [[{ teamMemberId: "11111111-1111-4111-8111-111111111111" }]],
      failAudit: true,
    });
    const committed: Array<{ table: unknown; value: unknown }> = [];
    useTransaction(tx, committed);

    await expect(
      exchangeTeamLoginToken("private-one-time-token", request(), 30, {
        correlationId: auditContext.correlationId,
        surface: "/team/auth",
      }),
    ).rejects.toThrow("audit unavailable");

    expect(
      tx.staged.some((entry) => entry.table === mockTables.teamLoginTokens),
    ).toBe(true);
    expect(
      tx.staged.some((entry) => entry.table === mockTables.teamSessions),
    ).toBe(true);
    expect(committed).toEqual([]);
  });

  it("rolls back logout revocation when its success audit cannot persist", async () => {
    const tx = createTransaction({
      selectRows: [
        [
          {
            id: "22222222-2222-4222-8222-222222222222",
            teamMemberId: "11111111-1111-4111-8111-111111111111",
            authMethod: "team_session",
            revokedAt: null,
            roleSlug: "database-role",
          },
        ],
      ],
      updateRows: [[{ id: "22222222-2222-4222-8222-222222222222" }]],
      failAudit: true,
    });
    const committed: Array<{ table: unknown; value: unknown }> = [];
    useTransaction(tx, committed);

    await expect(
      revokeTeamSession("private-session-token", {
        correlationId: auditContext.correlationId,
        surface: "/team",
      }),
    ).rejects.toThrow("audit unavailable");

    expect(
      tx.staged.some(
        (entry) =>
          entry.table === mockTables.teamSessions &&
          (entry.value as Record<string, unknown>)["revokedAt"] instanceof Date,
      ),
    ).toBe(true);
    expect(committed).toEqual([]);
  });

  it("attributes logout success to the database-backed session snapshot", async () => {
    const tx = createTransaction({
      selectRows: [
        [
          {
            id: "22222222-2222-4222-8222-222222222222",
            teamMemberId: "11111111-1111-4111-8111-111111111111",
            authMethod: "break_glass",
            revokedAt: null,
            roleSlug: "database-owner",
          },
        ],
      ],
      updateRows: [[{ id: "22222222-2222-4222-8222-222222222222" }]],
    });
    const committed: Array<{ table: unknown; value: unknown }> = [];
    useTransaction(tx, committed);

    await revokeTeamSession("private-session-token", {
      correlationId: auditContext.correlationId,
      surface: "/team",
    });

    expect(tx.auditRows[0]).toEqual(
      expect.objectContaining({
        action: "team.auth.logout",
        actorId: "11111111-1111-4111-8111-111111111111",
        actorRole: "database-owner",
        sessionId: "22222222-2222-4222-8222-222222222222",
        authMethod: "break_glass",
        entityId: "22222222-2222-4222-8222-222222222222",
      }),
    );
    expect(committed).not.toEqual([]);
    expect(JSON.stringify(tx.auditRows)).not.toContain("private-session-token");
  });

  it("rolls back password and other-session revocations when the success audit fails", async () => {
    const tx = createTransaction({
      selectRows: [
        [
          {
            id: "11111111-1111-4111-8111-111111111111",
            active: true,
            passwordHash: "existing-password-hash",
            roleSlug: "database-role",
          },
        ],
        [
          {
            id: "22222222-2222-4222-8222-222222222222",
            authMethod: "team_session",
          },
        ],
      ],
      updateRows: [
        [{ id: "11111111-1111-4111-8111-111111111111" }],
        [
          { id: "33333333-3333-4333-8333-333333333333" },
          { id: "44444444-4444-4444-8444-444444444444" },
        ],
      ],
      deleteRows: [[]],
      failAudit: true,
    });
    const committed: Array<{ table: unknown; value: unknown }> = [];
    useTransaction(tx, committed);

    await expect(
      setTeamMemberPassword(
        "11111111-1111-4111-8111-111111111111",
        "private-replacement-password",
        "22222222-2222-4222-8222-222222222222",
        {
          correlationId: auditContext.correlationId,
          surface: "/team/settings",
        },
      ),
    ).rejects.toThrow("audit unavailable");

    expect(
      tx.staged.some((entry) => entry.table === mockTables.teamMembers),
    ).toBe(true);
    expect(
      tx.staged.some((entry) => entry.table === mockTables.teamSessions),
    ).toBe(true);
    expect(committed).toEqual([]);
  });

  it("attributes password success to the current database-backed session and member role", async () => {
    const tx = createTransaction({
      selectRows: [
        [
          {
            id: "11111111-1111-4111-8111-111111111111",
            active: true,
            passwordHash: null,
            roleSlug: "database-office",
          },
        ],
        [
          {
            id: "22222222-2222-4222-8222-222222222222",
            authMethod: "team_session",
          },
        ],
      ],
      updateRows: [
        [{ id: "11111111-1111-4111-8111-111111111111" }],
        [{ id: "33333333-3333-4333-8333-333333333333" }],
      ],
      deleteRows: [[]],
    });
    const committed: Array<{ table: unknown; value: unknown }> = [];
    useTransaction(tx, committed);

    const result = await setTeamMemberPassword(
      "11111111-1111-4111-8111-111111111111",
      "private-first-password",
      "22222222-2222-4222-8222-222222222222",
      {
        correlationId: auditContext.correlationId,
        surface: "/team/settings",
      },
    );

    expect(result).toEqual({
      passwordMode: "setup",
      revokedSessionCount: 1,
    });
    expect(tx.auditRows[0]).toEqual(
      expect.objectContaining({
        action: "team.auth.password.setup",
        actorId: "11111111-1111-4111-8111-111111111111",
        actorRole: "database-office",
        sessionId: "22222222-2222-4222-8222-222222222222",
        authMethod: "team_session",
        entityId: "11111111-1111-4111-8111-111111111111",
      }),
    );
    expect(tx.auditRows[0]?.["meta"]).toEqual(
      expect.objectContaining({
        passwordMode: "setup",
        revokedSessionCount: 1,
      }),
    );
    expect(committed).not.toEqual([]);
    expect(JSON.stringify(tx.auditRows)).not.toContain(
      "private-first-password",
    );
  });
});

describe("authentication success-audit source boundaries", () => {
  const authSource = readFileSync(
    join(process.cwd(), "src/lib/team-auth.ts"),
    "utf8",
  );
  const auditSource = readFileSync(
    join(process.cwd(), "src/lib/team-auth-audit.ts"),
    "utf8",
  );
  const accessRevokeSource = readFileSync(
    join(process.cwd(), "app/api/admin/team/sessions/revoke/route.ts"),
    "utf8",
  );

  it.each([
    ["exchangeTeamLoginToken", "revokeTeamSession"],
    ["revokeTeamSession", "requireTeamSession"],
    ["setTeamMemberPassword", "loginWithPassword"],
    ["loginWithPassword", null],
  ])("keeps %s state and success evidence in one transaction", (name, next) => {
    const start = authSource.indexOf(`export async function ${name}`);
    const end = next
      ? authSource.indexOf(`export async function ${next}`, start)
      : authSource.length;
    const source = authSource.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(source).toContain("db.transaction");
    expect(source).toContain("insertTeamAuthSuccessAuditEvent(tx");
  });

  it("uses the caller transaction for allowlisted, privacy-safe auth evidence", () => {
    expect(auditSource).toContain("tx.insert(auditLogs)");
    expect(auditSource).toContain("sanitizeTeamAuthAuditMetadata");
    expect(auditSource).not.toContain("password: input");
    expect(auditSource).not.toContain("token: input");
  });

  it("keeps Access revocation and its verified audit in the same transaction", () => {
    const transactionIndex = accessRevokeSource.indexOf("db.transaction");
    const updateIndex = accessRevokeSource.indexOf(".update(teamSessions)");
    const auditIndex = accessRevokeSource.indexOf(
      "mutation.audit.insertSuccess(tx",
    );

    expect(transactionIndex).toBeGreaterThanOrEqual(0);
    expect(updateIndex).toBeGreaterThan(transactionIndex);
    expect(auditIndex).toBeGreaterThan(updateIndex);
  });
});
