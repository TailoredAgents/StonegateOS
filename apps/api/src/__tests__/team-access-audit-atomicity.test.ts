import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NextRequest } from "next/server";

const mockGetDb = jest.fn<unknown, []>();
const mockClaimTeamMutationIdempotency = jest.fn();
const mockCompleteTeamMutationIdempotency = jest.fn(() => Promise.resolve());
const mockSettleTeamMutationIdempotencyFailure = jest.fn(() =>
  Promise.resolve(),
);
const mockGetVerifiedRequestActor = jest.fn(() => ({
  type: "human" as const,
  id: "11111111-1111-4111-8111-111111111111",
  role: "owner",
  label: "Private Owner Name",
  sessionId: "22222222-2222-4222-8222-222222222222",
  authMethod: "team_session" as const,
}));

const mockTables = {
  auditLogs: { name: "audit_logs" },
  policySettings: {
    name: "policy_settings",
    key: "policy_settings.key",
    value: "policy_settings.value",
  },
  teamLoginTokens: {
    name: "team_login_tokens",
    teamMemberId: "team_login_tokens.team_member_id",
  },
  teamMembers: {
    name: "team_members",
    id: "team_members.id",
    nameColumn: "team_members.name",
    email: "team_members.email",
    emailNormalized: "team_members.email_normalized",
    emailIdentityStatus: "team_members.email_identity_status",
    phoneE164: "team_members.phone_e164",
    roleId: "team_members.role_id",
    active: "team_members.active",
    defaultCrewSplitBps: "team_members.default_crew_split_bps",
    permissionsGrant: "team_members.permissions_grant",
    permissionsDeny: "team_members.permissions_deny",
    passwordHash: "team_members.password_hash",
    createdAt: "team_members.created_at",
    updatedAt: "team_members.updated_at",
  },
  teamRoles: {
    name: "team_roles",
    id: "team_roles.id",
    nameColumn: "team_roles.name",
    slug: "team_roles.slug",
    permissions: "team_roles.permissions",
    createdAt: "team_roles.created_at",
    updatedAt: "team_roles.updated_at",
  },
  teamSessions: {
    name: "team_sessions",
    id: "team_sessions.id",
    teamMemberId: "team_sessions.team_member_id",
    revokedAt: "team_sessions.revoked_at",
  },
};

jest.mock("@/db", () => ({
  getDb: mockGetDb,
  auditLogs: mockTables.auditLogs,
  policySettings: mockTables.policySettings,
  teamLoginTokens: mockTables.teamLoginTokens,
  teamMembers: {
    ...mockTables.teamMembers,
    name: mockTables.teamMembers.nameColumn,
  },
  teamRoles: {
    ...mockTables.teamRoles,
    name: mockTables.teamRoles.nameColumn,
  },
  teamSessions: mockTables.teamSessions,
}));

jest.mock("@/lib/permissions", () => ({
  computeEffectivePermissions: jest.fn(() => ["access.manage"]),
  getDefaultPermissionsForRole: jest.fn(() => ["access.manage"]),
  permissionMatches: jest.fn(
    (granted: string, required: string) =>
      granted === "*" ||
      granted === required ||
      (granted.endsWith(".*") && required.startsWith(granted.slice(0, -1))),
  ),
  requirePermission: jest.fn(() => Promise.resolve(null)),
}));

jest.mock("@/lib/sales-scorecard", () => ({
  SALES_SCORECARD_POLICY_KEY: "sales_scorecard",
}));

jest.mock("@/lib/verified-actor-context", () => ({
  getVerifiedRequestActor: mockGetVerifiedRequestActor,
}));

jest.mock("@/lib/team-mutation-idempotency", () => ({
  claimTeamMutationIdempotency: mockClaimTeamMutationIdempotency,
  completeTeamMutationIdempotency: mockCompleteTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure:
    mockSettleTeamMutationIdempotencyFailure,
  teamMutationIdempotencyReplayResponse: jest.fn(),
}));

jest.mock("../../app/api/web/admin", () => ({
  isAdminRequest: jest.fn(() => true),
}));

import { POST as createMember } from "../../app/api/admin/team/members/route";
import {
  DELETE as deleteMember,
  PATCH as updateMember,
} from "../../app/api/admin/team/members/[memberId]/route";
import { POST as createRole } from "../../app/api/admin/roles/route";
import { PATCH as updateRole } from "../../app/api/admin/roles/[roleId]/route";
import {
  insertAccessSuccessAuditEvent,
  type VerifiedAccessActor,
} from "@/lib/access-audit";

type StoredRow = Record<string, unknown>;

function request(body: unknown): NextRequest {
  const url = new URL("https://api.example.test/api/admin/access-test");
  const raw = new Request(url, {
    method: "POST",
    headers: new Headers({
      "x-correlation-id": "access-correlation-123456",
      authorization: "Bearer raw-session-token-must-not-be-audited",
      "content-type": "application/json",
      host: url.host,
      origin: url.origin,
      "idempotency-key": "access-role-update-test-key-123456",
      "if-match": "2026-08-08T12:30:00.000Z",
    }),
    body: JSON.stringify(body),
  });
  Object.defineProperty(raw, "nextUrl", { value: url });
  return raw as unknown as NextRequest;
}

function createMemberDatabase(input: { failAudit: boolean }) {
  const committed = {
    members: [] as StoredRow[],
    audits: [] as StoredRow[],
  };
  const transaction = jest.fn(
    async (
      callback: (tx: {
        insert: (table: object) => {
          values: (values: StoredRow) => unknown;
        };
      }) => Promise<unknown>,
    ) => {
      const pending = {
        members: [] as StoredRow[],
        audits: [] as StoredRow[],
      };
      const tx = {
        insert: (table: object) => ({
          values: (values: StoredRow) => {
            if (table === mockTables.auditLogs) {
              if (input.failAudit) {
                return Promise.reject(new Error("audit unavailable"));
              }
              pending.audits.push(values);
              return Promise.resolve();
            }
            if ("id" in table && table.id === mockTables.teamMembers.id) {
              const member = {
                ...values,
                id: "33333333-3333-4333-8333-333333333333",
              };
              return {
                returning: () => {
                  pending.members.push(member);
                  return Promise.resolve([member]);
                },
              };
            }
            throw new Error("unexpected insert target");
          },
        }),
      };

      const result = await callback(tx);
      committed.members.push(...pending.members);
      committed.audits.push(...pending.audits);
      return result;
    },
  );

  return { committed, db: { transaction }, transaction };
}

const TARGET_MEMBER_ID = "33333333-3333-4333-8333-333333333333";
const TARGET_ROLE_ID = "44444444-4444-4444-8444-444444444444";

function isMemberTable(table: object): boolean {
  return (
    "id" in table &&
    (table as { id?: unknown }).id === mockTables.teamMembers.id
  );
}

function isRoleTable(table: object): boolean {
  return (
    "id" in table && (table as { id?: unknown }).id === mockTables.teamRoles.id
  );
}

function createMemberUpdateDatabase(input: { failAudit: boolean }) {
  const currentMember = {
    id: TARGET_MEMBER_ID,
    name: "Original Private Member",
    email: null,
    emailNormalized: null,
    emailIdentityStatus: "none",
    phoneE164: null,
    roleId: null,
    active: true,
    permissionsGrant: [] as string[],
    permissionsDeny: [] as string[],
    createdAt: new Date("2026-08-08T12:00:00.000Z"),
    updatedAt: new Date("2026-08-08T12:30:00.000Z"),
  };
  const committed = {
    memberUpdates: [] as StoredRow[],
    sessionRevocations: 0,
    loginTokenDeletes: 0,
    audits: [] as StoredRow[],
  };
  const transaction = jest.fn(
    async (callback: (tx: Record<string, unknown>) => Promise<unknown>) => {
      const pending = {
        memberUpdates: [] as StoredRow[],
        sessionRevocations: 0,
        loginTokenDeletes: 0,
        audits: [] as StoredRow[],
      };
      const tx = {
        execute: () => Promise.resolve(),
        select: () => ({
          from: () => ({
            where: () => ({
              for: () => ({
                limit: () => Promise.resolve([currentMember]),
              }),
            }),
          }),
        }),
        update: (table: object) => ({
          set: (values: StoredRow) => ({
            where: () => {
              if (isMemberTable(table)) {
                return {
                  returning: () => {
                    pending.memberUpdates.push(values);
                    return Promise.resolve([{ ...currentMember, ...values }]);
                  },
                };
              }
              if (table === mockTables.teamSessions) {
                pending.sessionRevocations += 1;
                return {
                  returning: () =>
                    Promise.resolve([
                      { id: "99999999-9999-4999-8999-999999999999" },
                    ]),
                };
              }
              throw new Error("unexpected update target");
            },
          }),
        }),
        delete: (table: object) => ({
          where: () => {
            if (table !== mockTables.teamLoginTokens) {
              return Promise.reject(new Error("unexpected delete target"));
            }
            pending.loginTokenDeletes += 1;
            return Promise.resolve();
          },
        }),
        insert: (table: object) => ({
          values: (values: StoredRow) => {
            if (table !== mockTables.auditLogs) {
              return Promise.reject(new Error("unexpected insert target"));
            }
            if (input.failAudit) {
              return Promise.reject(new Error("audit unavailable"));
            }
            pending.audits.push(values);
            return Promise.resolve();
          },
        }),
      };

      const result = await callback(tx);
      committed.memberUpdates.push(...pending.memberUpdates);
      committed.sessionRevocations += pending.sessionRevocations;
      committed.loginTokenDeletes += pending.loginTokenDeletes;
      committed.audits.push(...pending.audits);
      return result;
    },
  );

  return { committed, db: { transaction }, transaction };
}

function createMemberDeleteDatabase(input: { failAudit: boolean }) {
  const currentMember = {
    id: TARGET_MEMBER_ID,
    name: "Deleted Private Member",
    email: "deleted.private@example.com",
    emailNormalized: "deleted.private@example.com",
    emailIdentityStatus: "ready",
    phoneE164: null,
    roleId: null,
    active: true,
    permissionsDeny: [] as string[],
  };
  const committed = {
    memberDeletes: 0,
    sessionRevocations: 0,
    loginTokenDeletes: 0,
    audits: [] as StoredRow[],
  };
  const transaction = jest.fn(
    async (callback: (tx: Record<string, unknown>) => Promise<unknown>) => {
      const pending = {
        memberDeletes: 0,
        sessionRevocations: 0,
        loginTokenDeletes: 0,
        audits: [] as StoredRow[],
      };
      const selectedRows: StoredRow[][] = [[currentMember], [], []];
      const tx = {
        execute: () => Promise.resolve(),
        select: () => ({
          from: () => ({
            where: () => ({
              for: () => ({
                limit: () => Promise.resolve(selectedRows.shift() ?? []),
              }),
            }),
          }),
        }),
        update: (table: object) => ({
          set: () => ({
            where: () => {
              if (table !== mockTables.teamSessions) {
                return Promise.reject(new Error("unexpected update target"));
              }
              pending.sessionRevocations += 1;
              return Promise.resolve();
            },
          }),
        }),
        delete: (table: object) => ({
          where: () => {
            if (isMemberTable(table)) {
              return {
                returning: () => {
                  pending.memberDeletes += 1;
                  return Promise.resolve([currentMember]);
                },
              };
            }
            if (table === mockTables.teamLoginTokens) {
              pending.loginTokenDeletes += 1;
              return Promise.resolve();
            }
            throw new Error("unexpected delete target");
          },
        }),
        insert: (table: object) => ({
          values: (values: StoredRow) => {
            if (table !== mockTables.auditLogs) {
              return Promise.reject(new Error("unexpected insert target"));
            }
            if (input.failAudit) {
              return Promise.reject(new Error("audit unavailable"));
            }
            pending.audits.push(values);
            return Promise.resolve();
          },
        }),
      };

      const result = await callback(tx);
      committed.memberDeletes += pending.memberDeletes;
      committed.sessionRevocations += pending.sessionRevocations;
      committed.loginTokenDeletes += pending.loginTokenDeletes;
      committed.audits.push(...pending.audits);
      return result;
    },
  );

  return { committed, db: { transaction }, transaction };
}

function createRoleDatabase(input: { failAudit: boolean }) {
  const committed = {
    defaultRoleBatches: 0,
    roles: [] as StoredRow[],
    audits: [] as StoredRow[],
  };
  const transaction = jest.fn(
    async (callback: (tx: Record<string, unknown>) => Promise<unknown>) => {
      const pending = {
        defaultRoleBatches: 0,
        roles: [] as StoredRow[],
        audits: [] as StoredRow[],
      };
      const tx = {
        insert: (table: object) => ({
          values: (values: StoredRow | StoredRow[]) => {
            if (table === mockTables.auditLogs) {
              if (input.failAudit) {
                return Promise.reject(new Error("audit unavailable"));
              }
              pending.audits.push(values as StoredRow);
              return Promise.resolve();
            }
            if (!isRoleTable(table)) {
              throw new Error("unexpected insert target");
            }
            if (Array.isArray(values)) {
              return {
                onConflictDoNothing: () => {
                  pending.defaultRoleBatches += 1;
                  return Promise.resolve();
                },
              };
            }
            return {
              returning: () => {
                const role = { ...values, id: TARGET_ROLE_ID };
                pending.roles.push(role);
                return Promise.resolve([role]);
              },
            };
          },
        }),
      };

      const result = await callback(tx);
      committed.defaultRoleBatches += pending.defaultRoleBatches;
      committed.roles.push(...pending.roles);
      committed.audits.push(...pending.audits);
      return result;
    },
  );
  const insert = (table: object) => ({
    values: (values: StoredRow[]) => ({
      onConflictDoNothing: () => {
        if (!isRoleTable(table)) {
          return Promise.reject(new Error("unexpected insert target"));
        }
        committed.defaultRoleBatches += Array.isArray(values) ? 1 : 0;
        return Promise.resolve();
      },
    }),
  });

  return { committed, db: { insert, transaction }, transaction };
}

function createRoleUpdateDatabase(input: {
  failAudit: boolean;
  currentUpdatedAt?: string;
}) {
  const currentRole = {
    id: TARGET_ROLE_ID,
    name: "Original Private Role",
    slug: "private_dispatcher",
    permissions: ["messages.read"],
    createdAt: new Date("2026-08-08T12:00:00.000Z"),
    updatedAt: new Date(input.currentUpdatedAt ?? "2026-08-08T12:30:00.000Z"),
  };
  const committed = {
    roleUpdates: [] as StoredRow[],
    sessionRevocations: 0,
    audits: [] as StoredRow[],
  };
  const transaction = jest.fn(
    async (callback: (tx: Record<string, unknown>) => Promise<unknown>) => {
      const pending = {
        roleUpdates: [] as StoredRow[],
        sessionRevocations: 0,
        audits: [] as StoredRow[],
      };
      const tx = {
        execute: () => Promise.resolve(),
        select: () => ({
          from: (table: object) => ({
            where: () => ({
              for: () => {
                if (isRoleTable(table)) {
                  return {
                    limit: () => Promise.resolve([currentRole]),
                  };
                }
                if (isMemberTable(table)) {
                  return Promise.resolve([
                    {
                      id: "55555555-5555-4555-8555-555555555555",
                      active: true,
                      permissionsGrant: [],
                      permissionsDeny: [],
                    },
                  ]);
                }
                throw new Error("unexpected select target");
              },
            }),
          }),
        }),
        update: (table: object) => ({
          set: (values: StoredRow) => ({
            where: () => {
              if (isRoleTable(table)) {
                return {
                  returning: () => {
                    pending.roleUpdates.push(values);
                    return Promise.resolve([{ ...currentRole, ...values }]);
                  },
                };
              }
              if (table === mockTables.teamSessions) {
                return {
                  returning: () => {
                    pending.sessionRevocations += 1;
                    return Promise.resolve([
                      { id: "66666666-6666-4666-8666-666666666666" },
                    ]);
                  },
                };
              }
              throw new Error("unexpected update target");
            },
          }),
        }),
        insert: (table: object) => ({
          values: (values: StoredRow) => {
            if (table !== mockTables.auditLogs) {
              return Promise.reject(new Error("unexpected insert target"));
            }
            if (input.failAudit) {
              return Promise.reject(new Error("audit unavailable"));
            }
            pending.audits.push(values);
            return Promise.resolve();
          },
        }),
      };

      const result = await callback(tx);
      committed.roleUpdates.push(...pending.roleUpdates);
      committed.sessionRevocations += pending.sessionRevocations;
      committed.audits.push(...pending.audits);
      return result;
    },
  );

  return { committed, db: { transaction }, transaction };
}

describe("transaction-bound Access audit evidence", () => {
  beforeEach(() => {
    mockGetDb.mockReset();
    mockClaimTeamMutationIdempotency.mockReset();
    mockClaimTeamMutationIdempotency.mockResolvedValue({
      kind: "execute",
      claim: {
        id: "77777777-7777-4777-8777-777777777777",
        operationId: "88888888-8888-4888-8888-888888888888",
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
  });

  it("rejects a service principal before Access persistence even if permission middleware is misconfigured", async () => {
    mockGetVerifiedRequestActor.mockReturnValueOnce({
      type: "worker",
      id: "access-worker",
      role: null,
      label: "access-worker",
      sessionId: null,
      authMethod: "service",
    } as never);

    const response = await createMember(
      request({ name: "Unauthorized Service Mutation" }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      code: "forbidden",
      message: "This type of principal cannot perform the action.",
      retryable: false,
    });
    expect(mockClaimTeamMutationIdempotency).not.toHaveBeenCalled();
  });

  it("rolls back member creation and returns truthful failure when audit storage fails", async () => {
    const fixture = createMemberDatabase({ failAudit: true });
    mockGetDb.mockReturnValue(fixture.db);

    const response = await createMember(
      request({
        name: "New Private Member",
        email: "new.private.member@example.com",
        active: true,
      }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      code: "internal",
      message:
        "The operation could not be completed. Try again or contact support with the request ID.",
      retryable: true,
    });
    expect(fixture.transaction).toHaveBeenCalledTimes(1);
    expect(fixture.committed.members).toHaveLength(0);
    expect(fixture.committed.audits).toHaveLength(0);
  });

  it("commits member creation with verified attribution and privacy-safe evidence", async () => {
    const fixture = createMemberDatabase({ failAudit: false });
    mockGetDb.mockReturnValue(fixture.db);

    const response = await createMember(
      request({
        name: "New Private Member",
        email: "new.private.member@example.com",
        active: true,
      }),
    );

    expect(response.status).toBe(201);
    expect(fixture.committed.members).toHaveLength(1);
    expect(fixture.committed.audits).toHaveLength(1);
    expect(fixture.committed.audits[0]).toEqual(
      expect.objectContaining({
        actorType: "human",
        actorId: "11111111-1111-4111-8111-111111111111",
        actorRole: "owner",
        actorLabel: "Private Owner Name",
        sessionId: "22222222-2222-4222-8222-222222222222",
        authMethod: "team_session",
        correlationId: "access-correlation-123456",
        requiredPermissions: ["access.manage"],
        outcome: "succeeded",
        action: "team_member.created",
        entityType: "team_member",
        entityId: "33333333-3333-4333-8333-333333333333",
      }),
    );
    expect(fixture.committed.audits[0]?.["meta"]).toMatchObject({
      active: true,
      roleAssigned: false,
      emailConfigured: true,
      phoneConfigured: false,
    });

    const serializedAudit = JSON.stringify(fixture.committed.audits[0]);
    expect(serializedAudit).not.toContain("New Private Member");
    expect(serializedAudit).not.toContain("new.private.member@example.com");
    expect(serializedAudit).not.toContain("raw-session-token");
    expect(serializedAudit).toContain("Private Owner Name");
  });

  it("allowlists Access metadata even when an unsafe caller circumvents TypeScript", async () => {
    const rows: StoredRow[] = [];
    const tx = {
      insert: () => ({
        values: (row: StoredRow) => {
          rows.push(row);
          return Promise.resolve();
        },
      }),
    };
    const actor: VerifiedAccessActor = {
      type: "human",
      id: "11111111-1111-4111-8111-111111111111",
      role: "owner",
      label: "Private Owner Name",
      sessionId: "22222222-2222-4222-8222-222222222222",
      authMethod: "team_session",
    };

    await insertAccessSuccessAuditEvent(tx as never, {
      actor,
      correlationId: "access-correlation-123456",
      action: "team_member.updated",
      entityType: "team_member",
      entityId: "33333333-3333-4333-8333-333333333333",
      metadata: {
        changedFields: ["email", "passwordHash", "loginToken", "email"],
        sessionsRevoked: true,
        passwordHash: "private-password-hash",
        loginToken: "private-login-token",
        email: "private@example.com",
      } as never,
    });

    expect(rows[0]?.["meta"]).toEqual({
      changedFields: ["email"],
      sessionsRevoked: true,
    });
    const serializedAudit = JSON.stringify(rows[0]);
    expect(serializedAudit).not.toContain("private-password-hash");
    expect(serializedAudit).not.toContain("private-login-token");
    expect(serializedAudit).not.toContain("private@example.com");
  });
});

describe("runtime rollback for every Access mutation", () => {
  beforeEach(() => {
    mockGetDb.mockReset();
    mockClaimTeamMutationIdempotency.mockReset();
    mockClaimTeamMutationIdempotency.mockResolvedValue({
      kind: "execute",
      claim: {
        id: "77777777-7777-4777-8777-777777777777",
        operationId: "88888888-8888-4888-8888-888888888888",
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
  });

  it("rolls back a member update when its audit insert fails", async () => {
    const fixture = createMemberUpdateDatabase({ failAudit: true });
    mockGetDb.mockReturnValue(fixture.db);

    const response = await updateMember(
      request({
        expectedUpdatedAt: "2026-08-08T12:30:00.000Z",
        name: "Updated Private Member",
        active: false,
      }),
      { params: Promise.resolve({ memberId: TARGET_MEMBER_ID }) },
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      code: "internal",
      message:
        "The operation could not be completed. Try again or contact support with the request ID.",
      retryable: true,
    });
    expect(fixture.transaction).toHaveBeenCalledTimes(1);
    expect(fixture.committed.memberUpdates).toHaveLength(0);
    expect(fixture.committed.sessionRevocations).toBe(0);
    expect(fixture.committed.loginTokenDeletes).toBe(0);
    expect(fixture.committed.audits).toHaveLength(0);
  });

  it("commits a member update and its privacy-safe audit together", async () => {
    const fixture = createMemberUpdateDatabase({ failAudit: false });
    mockGetDb.mockReturnValue(fixture.db);

    const response = await updateMember(
      request({
        expectedUpdatedAt: "2026-08-08T12:30:00.000Z",
        name: "Updated Private Member",
        active: false,
      }),
      { params: Promise.resolve({ memberId: TARGET_MEMBER_ID }) },
    );

    expect(response.status).toBe(200);
    expect(fixture.committed.memberUpdates).toHaveLength(1);
    expect(fixture.committed.sessionRevocations).toBe(1);
    expect(fixture.committed.loginTokenDeletes).toBe(1);
    expect(fixture.committed.audits).toHaveLength(1);
    expect(fixture.committed.audits[0]).toEqual(
      expect.objectContaining({
        action: "team_member.updated",
        entityType: "team_member",
        entityId: TARGET_MEMBER_ID,
        actorId: "11111111-1111-4111-8111-111111111111",
      }),
    );
    expect(fixture.committed.audits[0]?.["meta"]).toMatchObject({
      changedFields: ["name", "active"],
      phoneChanged: false,
      sessionsRevoked: true,
      revokedSessionCount: 1,
    });
    expect(JSON.stringify(fixture.committed.audits[0])).not.toContain(
      "Updated Private Member",
    );
  });

  it("rolls back member deletion, session revocation, and token deletion when audit storage fails", async () => {
    const fixture = createMemberDeleteDatabase({ failAudit: true });
    mockGetDb.mockReturnValue(fixture.db);

    const response = await deleteMember(request(undefined), {
      params: Promise.resolve({ memberId: TARGET_MEMBER_ID }),
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "audit_persistence_failed",
      retryable: true,
    });
    expect(fixture.transaction).toHaveBeenCalledTimes(1);
    expect(fixture.committed.memberDeletes).toBe(0);
    expect(fixture.committed.sessionRevocations).toBe(0);
    expect(fixture.committed.loginTokenDeletes).toBe(0);
    expect(fixture.committed.audits).toHaveLength(0);
  });

  it("commits member deletion and its security cleanup with one audit", async () => {
    const fixture = createMemberDeleteDatabase({ failAudit: false });
    mockGetDb.mockReturnValue(fixture.db);

    const response = await deleteMember(request(undefined), {
      params: Promise.resolve({ memberId: TARGET_MEMBER_ID }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(fixture.committed.memberDeletes).toBe(1);
    expect(fixture.committed.sessionRevocations).toBe(1);
    expect(fixture.committed.loginTokenDeletes).toBe(1);
    expect(fixture.committed.audits).toHaveLength(1);
    expect(fixture.committed.audits[0]).toEqual(
      expect.objectContaining({
        action: "team_member.deleted",
        entityType: "team_member",
        entityId: TARGET_MEMBER_ID,
        meta: {
          clearedDefaultAssignee: false,
          sessionsRevoked: true,
        },
      }),
    );
    const serializedAudit = JSON.stringify(fixture.committed.audits[0]);
    expect(serializedAudit).not.toContain("Deleted Private Member");
    expect(serializedAudit).not.toContain("deleted.private@example.com");
  });

  it("rolls back default provisioning and custom role creation when its audit insert fails", async () => {
    const fixture = createRoleDatabase({ failAudit: true });
    mockGetDb.mockReturnValue(fixture.db);

    const response = await createRole(
      request({
        name: "Private Dispatcher Role",
        slug: "private_dispatcher_role",
        permissions: ["messages.read"],
      }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      code: "internal",
      message:
        "The operation could not be completed. Try again or contact support with the request ID.",
      retryable: true,
    });
    expect(fixture.transaction).toHaveBeenCalledTimes(1);
    expect(fixture.committed.defaultRoleBatches).toBe(0);
    expect(fixture.committed.roles).toHaveLength(0);
    expect(fixture.committed.audits).toHaveLength(0);
  });

  it("commits default provisioning, custom role creation, and verified audit evidence together", async () => {
    const fixture = createRoleDatabase({ failAudit: false });
    mockGetDb.mockReturnValue(fixture.db);

    const response = await createRole(
      request({
        name: "Private Dispatcher Role",
        slug: "private_dispatcher_role",
        permissions: ["messages.read"],
      }),
    );

    expect(response.status).toBe(201);
    expect(fixture.committed.defaultRoleBatches).toBe(1);
    expect(fixture.committed.roles).toHaveLength(1);
    expect(fixture.committed.audits).toHaveLength(1);
    expect(fixture.committed.audits[0]).toEqual(
      expect.objectContaining({
        action: "role.created",
        entityType: "team_role",
        entityId: TARGET_ROLE_ID,
      }),
    );
    expect(fixture.committed.audits[0]?.["meta"]).toMatchObject({
      permissionCount: 1,
    });
    const serializedAudit = JSON.stringify(fixture.committed.audits[0]);
    expect(serializedAudit).not.toContain("Private Dispatcher Role");
    expect(serializedAudit).not.toContain("private_dispatcher_role");
  });

  it("rolls back a role update when its audit insert fails", async () => {
    const fixture = createRoleUpdateDatabase({ failAudit: true });
    mockGetDb.mockReturnValue(fixture.db);

    const response = await updateRole(
      request({
        expectedUpdatedAt: "2026-08-08T12:30:00.000Z",
        name: "Updated Private Role",
        slug: "private_dispatcher",
        permissions: ["messages.read", "messages.write"],
      }),
      { params: Promise.resolve({ roleId: TARGET_ROLE_ID }) },
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      code: "internal",
      message:
        "The operation could not be completed. Try again or contact support with the request ID.",
      retryable: true,
    });
    expect(fixture.transaction).toHaveBeenCalledTimes(1);
    expect(fixture.committed.roleUpdates).toHaveLength(0);
    expect(fixture.committed.sessionRevocations).toBe(0);
    expect(fixture.committed.audits).toHaveLength(0);
    expect(mockCompleteTeamMutationIdempotency).not.toHaveBeenCalled();
    expect(mockSettleTeamMutationIdempotencyFailure).toHaveBeenCalledTimes(1);
  });

  it("rejects a stale role version before updating, revoking, auditing, or completing", async () => {
    const fixture = createRoleUpdateDatabase({
      failAudit: false,
      currentUpdatedAt: "2026-08-08T12:31:00.000Z",
    });
    mockGetDb.mockReturnValue(fixture.db);

    const response = await updateRole(
      request({
        expectedUpdatedAt: "2026-08-08T12:30:00.000Z",
        name: "Updated Private Role",
        slug: "private_dispatcher",
        permissions: ["messages.read", "messages.write"],
      }),
      { params: Promise.resolve({ roleId: TARGET_ROLE_ID }) },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "conflict",
      retryable: false,
    });
    expect(fixture.committed.roleUpdates).toHaveLength(0);
    expect(fixture.committed.sessionRevocations).toBe(0);
    expect(fixture.committed.audits).toHaveLength(0);
    expect(mockCompleteTeamMutationIdempotency).not.toHaveBeenCalled();
    expect(mockSettleTeamMutationIdempotencyFailure).toHaveBeenCalledTimes(1);
  });

  it("commits a role update and its privacy-safe audit together", async () => {
    const fixture = createRoleUpdateDatabase({ failAudit: false });
    mockGetDb.mockReturnValue(fixture.db);

    const response = await updateRole(
      request({
        expectedUpdatedAt: "2026-08-08T12:30:00.000Z",
        name: "Updated Private Role",
        slug: "private_dispatcher",
        permissions: ["messages.read", "messages.write"],
      }),
      { params: Promise.resolve({ roleId: TARGET_ROLE_ID }) },
    );

    expect(response.status).toBe(200);
    expect(fixture.committed.roleUpdates).toHaveLength(1);
    expect(fixture.committed.sessionRevocations).toBe(1);
    expect(fixture.committed.audits).toHaveLength(1);
    expect(fixture.committed.audits[0]).toMatchObject({
      action: "role.updated",
      entityType: "team_role",
      entityId: TARGET_ROLE_ID,
    });
    expect(fixture.committed.audits[0]?.["meta"]).toMatchObject({
      changedFields: ["name", "permissions"],
      assignedMemberCount: 1,
      revokedSessionCount: 1,
      risk: "destructive",
      requiredPermissions: ["access.manage"],
    });
    expect(mockCompleteTeamMutationIdempotency).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(fixture.committed.audits[0])).not.toContain(
      "Updated Private Role",
    );
  });
});

describe("Access route audit transaction source boundaries", () => {
  const memberCollection = readFileSync(
    join(process.cwd(), "app/api/admin/team/members/route.ts"),
    "utf8",
  );
  const memberDetail = readFileSync(
    join(process.cwd(), "app/api/admin/team/members/[memberId]/route.ts"),
    "utf8",
  );
  const roleCollection = readFileSync(
    join(process.cwd(), "app/api/admin/roles/route.ts"),
    "utf8",
  );
  const roleDetail = readFileSync(
    join(process.cwd(), "app/api/admin/roles/[roleId]/route.ts"),
    "utf8",
  );

  it("keeps every successful Access audit inside the business transaction", () => {
    expect(
      memberCollection.match(/mutation\.audit\.insertSuccess\(tx/gu),
    ).toHaveLength(1);
    expect(
      memberDetail.match(/mutation\.audit\.insertSuccess\(tx/gu),
    ).toHaveLength(1);
    expect(
      memberDetail.match(/insertAccessSuccessAuditEvent\(tx/gu),
    ).toHaveLength(1);
    expect(
      roleCollection.match(/mutation\.audit\.insertSuccess\(tx/gu),
    ).toHaveLength(1);
    expect(
      roleDetail.match(/mutation\.audit\.insertSuccess\(tx/gu),
    ).toHaveLength(1);

    for (const source of [memberCollection, roleCollection]) {
      expect(source).toContain("db.transaction(async (tx)");
      expect(source).toContain("mutation.audit.insertSuccess(tx");
      expect(source).not.toContain("recordAuditEvent");
      expect(source).not.toContain("getAuditActorFromRequest");
    }
    expect(memberDetail).toContain("db.transaction(async (tx)");
    expect(memberDetail).toContain("mutation.audit.insertSuccess(tx");
    expect(memberDetail).toContain("insertAccessSuccessAuditEvent(tx");
    expect(roleDetail).toContain("db.transaction(async (tx)");
    expect(roleDetail).toContain("completeTeamMutationIdempotency(");
    expect(roleDetail).not.toContain("recordAuditEvent");
    expect(roleDetail).not.toContain("getAuditActorFromRequest");
  });

  it("writes audit evidence after protected state changes but before success returns", () => {
    const memberCreate = memberCollection.slice(
      memberCollection.indexOf("export async function POST"),
    );
    expect(memberCreate.indexOf(".insert(teamMembers)")).toBeLessThan(
      memberCreate.indexOf("mutation.audit.insertSuccess(tx"),
    );
    expect(
      memberCreate.indexOf("mutation.audit.insertSuccess(tx"),
    ).toBeLessThan(memberCreate.indexOf("teamMutationSuccessResult("));

    const memberUpdateAudit = memberDetail.indexOf(
      "mutation.audit.insertSuccess(tx",
    );
    const memberDeleteAudit = memberDetail.indexOf(
      'action: "team_member.deleted"',
    );
    expect(memberDetail.indexOf(".update(teamMembers)")).toBeLessThan(
      memberUpdateAudit,
    );
    expect(memberDetail.indexOf(".delete(teamMembers)")).toBeLessThan(
      memberDeleteAudit,
    );

    const roleCreate = roleCollection.slice(
      roleCollection.indexOf("export async function POST"),
    );
    expect(roleCreate.indexOf(".insert(teamRoles)")).toBeLessThan(
      roleCreate.indexOf("mutation.audit.insertSuccess(tx"),
    );
    expect(roleDetail.indexOf(".update(teamRoles)")).toBeLessThan(
      roleDetail.indexOf("mutation.audit.insertSuccess(tx"),
    );
    expect(roleDetail.indexOf(".update(teamSessions)")).toBeLessThan(
      roleDetail.indexOf("mutation.audit.insertSuccess(tx"),
    );
    expect(roleDetail.indexOf("mutation.audit.insertSuccess(tx")).toBeLessThan(
      roleDetail.indexOf("completeTeamMutationIdempotency("),
    );
  });
});
