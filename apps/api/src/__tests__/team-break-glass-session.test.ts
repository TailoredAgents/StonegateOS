type Query = {
  from: (...args: unknown[]) => Query;
  leftJoin: (...args: unknown[]) => Query;
  where: (...args: unknown[]) => Query;
  for: (...args: unknown[]) => Query;
  limit: (...args: unknown[]) => Promise<Array<Record<string, unknown>>>;
};

const mockDb = {
  transaction: jest.fn<Promise<unknown>, [(tx: unknown) => Promise<unknown>]>(),
};
const mockComputeEffectivePermissions = jest.fn<string[], [unknown]>();
jest.mock("@/db", () => ({
  getDb: () => mockDb,
  teamLoginTokens: {},
  teamMembers: {
    id: "team_members.id",
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
    revokedAt: "team_sessions.revoked_at",
  },
}));

jest.mock("@/lib/permissions", () => ({
  computeEffectivePermissions: mockComputeEffectivePermissions,
  permissionMatches: (granted: string, required: string) =>
    granted === "*" ||
    granted === required ||
    (granted.endsWith(".*") && required.startsWith(granted.slice(0, -2))),
  restrictOwnerOnlyPermissionsForRole: (
    _role: string | null,
    permissions: string[],
  ) => permissions,
}));

import { createBreakGlassTeamSession } from "@/lib/team-auth";
import type { TeamMutationAuditWriter } from "@/lib/team-mutation";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const CREW_ID = "22222222-2222-4222-8222-222222222222";

function query(rows: Array<Record<string, unknown>>): Query {
  const chain: Query = {
    from: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    for: () => chain,
    limit: () => Promise.resolve(rows),
  };
  return chain;
}

function transactionFor(member: Record<string, unknown>) {
  const revokeWhere = jest.fn(() => Promise.resolve(undefined));
  const revokeSet = jest.fn(() => ({ where: revokeWhere }));
  const insertValues = jest.fn(() => Promise.resolve(undefined));
  const tx = {
    select: jest.fn(() => query([member])),
    update: jest.fn(() => ({ set: revokeSet })),
    insert: jest.fn(() => ({ values: insertValues })),
  };
  mockDb.transaction.mockImplementation((callback) => callback(tx));
  return { tx, revokeWhere, insertValues };
}

describe("break-glass session persistence", () => {
  const originalOwnerId = process.env["TEAM_BREAK_GLASS_OWNER_MEMBER_ID"];
  const originalCrewId = process.env["TEAM_BREAK_GLASS_CREW_MEMBER_ID"];
  const auditInsert = jest.fn(() =>
    Promise.resolve({
      auditEventId: "33333333-3333-4333-8333-333333333333",
      committedAt: "2026-08-08T12:00:00.000Z",
    }),
  );
  const audit = {
    insertSuccess: auditInsert,
  } as unknown as TeamMutationAuditWriter;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env["TEAM_BREAK_GLASS_OWNER_MEMBER_ID"] = OWNER_ID;
    process.env["TEAM_BREAK_GLASS_CREW_MEMBER_ID"] = CREW_ID;
    mockComputeEffectivePermissions.mockReturnValue(["*"]);
  });

  afterAll(() => {
    if (originalOwnerId === undefined) {
      delete process.env["TEAM_BREAK_GLASS_OWNER_MEMBER_ID"];
    } else {
      process.env["TEAM_BREAK_GLASS_OWNER_MEMBER_ID"] = originalOwnerId;
    }
    if (originalCrewId === undefined) {
      delete process.env["TEAM_BREAK_GLASS_CREW_MEMBER_ID"];
    } else {
      process.env["TEAM_BREAK_GLASS_CREW_MEMBER_ID"] = originalCrewId;
    }
  });

  it("fails closed before database access when the configured member ID is missing or malformed", async () => {
    delete process.env["TEAM_BREAK_GLASS_OWNER_MEMBER_ID"];

    await expect(
      createBreakGlassTeamSession({
        sessionType: "owner",
        clientIp: null,
        userAgent: null,
        audit,
      }),
    ).resolves.toBeNull();
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it("locks the configured active member and commits a one-hour audited recovery session", async () => {
    const { tx, insertValues } = transactionFor({
      id: OWNER_ID,
      active: true,
      roleSlug: "owner",
      rolePermissions: ["*"],
      permissionsGrant: [],
      permissionsDeny: [],
    });
    const now = new Date("2026-08-08T12:00:00.000Z");

    const result = await createBreakGlassTeamSession({
      sessionType: "owner",
      clientIp: "203.0.113.42",
      userAgent: "Recovery browser",
      audit,
      now,
    });

    expect(result).toEqual(
      expect.objectContaining({
        teamMemberId: OWNER_ID,
        expiresAt: new Date("2026-08-08T13:00:00.000Z"),
      }),
    );
    expect(tx.select).toHaveBeenCalledTimes(1);
    expect(tx.update).toHaveBeenCalledTimes(1);
    expect(insertValues).toHaveBeenCalledTimes(1);
    const insertedSession = insertValues.mock.calls[0]?.[0] as unknown as
      | Record<string, unknown>
      | undefined;
    expect(typeof insertedSession?.["id"]).toBe("string");
    expect(typeof insertedSession?.["sessionHash"]).toBe("string");
    expect(insertedSession).toMatchObject({
      teamMemberId: OWNER_ID,
      authMethod: "break_glass",
      ip: "203.0.113.42",
      userAgent: "Recovery browser",
      expiresAt: new Date("2026-08-08T13:00:00.000Z"),
    });
    expect(insertedSession?.["sessionHash"]).not.toBe(result?.sessionToken);
    expect(auditInsert).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        entityType: "team_session",
        entityId: result?.sessionId,
        after: {
          teamMemberId: OWNER_ID,
          authMethod: "break_glass",
          expiresAt: "2026-08-08T13:00:00.000Z",
        },
        metadata: {
          recoveryType: "owner",
          requiredPermission: "access.manage",
        },
      }),
    );
  });

  it("rejects inactive or explicitly denied configured members without issuing a session", async () => {
    let transaction = transactionFor({
      id: OWNER_ID,
      active: false,
      roleSlug: "owner",
      rolePermissions: ["*"],
      permissionsGrant: [],
      permissionsDeny: [],
    });
    await expect(
      createBreakGlassTeamSession({
        sessionType: "owner",
        clientIp: null,
        userAgent: null,
        audit,
      }),
    ).resolves.toBeNull();
    expect(transaction.insertValues).not.toHaveBeenCalled();

    transaction = transactionFor({
      id: OWNER_ID,
      active: true,
      roleSlug: "owner",
      rolePermissions: ["*"],
      permissionsGrant: [],
      permissionsDeny: ["access.manage"],
    });
    await expect(
      createBreakGlassTeamSession({
        sessionType: "owner",
        clientIp: null,
        userAgent: null,
        audit,
      }),
    ).resolves.toBeNull();
    expect(transaction.insertValues).not.toHaveBeenCalled();
    expect(auditInsert).not.toHaveBeenCalled();
  });

  it("uses the separately configured crew member and requires appointment access", async () => {
    mockComputeEffectivePermissions.mockReturnValue(["appointments.read"]);
    transactionFor({
      id: CREW_ID,
      active: true,
      roleSlug: "crew",
      rolePermissions: ["appointments.read"],
      permissionsGrant: [],
      permissionsDeny: [],
    });

    const result = await createBreakGlassTeamSession({
      sessionType: "crew",
      clientIp: null,
      userAgent: null,
      audit,
    });

    expect(result?.teamMemberId).toBe(CREW_ID);
    expect(auditInsert).toHaveBeenCalledTimes(1);
    const auditInput = auditInsert.mock.calls[0]?.[1] as unknown as
      | { metadata?: Record<string, unknown> }
      | undefined;
    expect(auditInput?.metadata).toEqual({
      recoveryType: "crew",
      requiredPermission: "appointments.read",
    });
  });
});
