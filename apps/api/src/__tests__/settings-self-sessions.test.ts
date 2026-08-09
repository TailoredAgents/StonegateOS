import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  selfSessionCollectionVersion,
  selfSessionStatus,
  type SelfSessionVersionRecord,
} from "@/lib/self-session-management";
import { parsePersonalSessionInventory } from "../../../site/src/app/team/settings-sessions";

const REPOSITORY_ROOT = resolve(process.cwd(), "../..");

function read(relativePath: string): string {
  return readFileSync(resolve(REPOSITORY_ROOT, relativePath), "utf8");
}

function record(
  overrides: Partial<SelfSessionVersionRecord> = {},
): SelfSessionVersionRecord {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    authMethod: "team_session",
    createdAt: new Date("2026-08-08T12:00:00.000Z"),
    expiresAt: new Date("2026-09-08T12:00:00.000Z"),
    revokedAt: null,
    ...overrides,
  };
}

describe("personal Settings session management", () => {
  it("uses a deterministic opaque version that changes with security state", () => {
    const first = record();
    const second = record({
      id: "22222222-2222-4222-8222-222222222222",
      createdAt: new Date("2026-08-09T12:00:00.000Z"),
    });
    const forward = selfSessionCollectionVersion([first, second]);
    expect(forward).toMatch(/^[a-f0-9]{64}$/u);
    expect(selfSessionCollectionVersion([second, first])).toBe(forward);
    expect(
      selfSessionCollectionVersion([
        first,
        { ...second, revokedAt: new Date("2026-08-10T12:00:00.000Z") },
      ]),
    ).not.toBe(forward);
  });

  it("labels revoked before expired and never calls either active", () => {
    const now = new Date("2026-08-20T12:00:00.000Z");
    expect(selfSessionStatus(record(), now)).toBe("active");
    expect(
      selfSessionStatus(
        record({ expiresAt: new Date("2026-08-19T12:00:00.000Z") }),
        now,
      ),
    ).toBe("expired");
    expect(
      selfSessionStatus(
        record({
          expiresAt: new Date("2026-08-19T12:00:00.000Z"),
          revokedAt: new Date("2026-08-18T12:00:00.000Z"),
        }),
        now,
      ),
    ).toBe("revoked");
  });

  it("accepts only a complete inventory with exactly one current session", () => {
    const version = "a".repeat(64);
    const current = {
      current: true,
      authMethod: "team_session",
      createdAt: "2026-08-08T12:00:00.000Z",
      lastSeenAt: "2026-08-08T13:00:00.000Z",
      expiresAt: "2026-09-08T12:00:00.000Z",
      revokedAt: null,
      status: "active",
    };
    const valid = {
      ok: true,
      version,
      total: 1,
      limit: 50,
      truncated: false,
      activeOtherCount: 0,
      sessions: [current],
    };
    expect(parsePersonalSessionInventory(valid)).toEqual(
      expect.objectContaining({ version, sessions: [current] }),
    );
    expect(
      parsePersonalSessionInventory({ ...valid, sessions: [] }),
    ).toBeNull();
    expect(
      parsePersonalSessionInventory({
        ...valid,
        sessions: [{ ...current, current: false }],
      }),
    ).toBeNull();
    expect(
      parsePersonalSessionInventory({ ...valid, version: "raw-session-id" }),
    ).toBeNull();
    expect(
      parsePersonalSessionInventory({ ...valid, total: 2, truncated: false }),
    ).toBeNull();
    expect(
      parsePersonalSessionInventory({ ...valid, truncated: true }),
    ).toBeNull();
    expect(
      parsePersonalSessionInventory({
        ...valid,
        sessions: [{ ...current, status: "revoked", revokedAt: null }],
      }),
    ).toBeNull();
    expect(
      parsePersonalSessionInventory({
        ...valid,
        sessions: [
          { ...current, status: "active", revokedAt: current.createdAt },
        ],
      }),
    ).toBeNull();
    expect(
      parsePersonalSessionInventory({
        ...valid,
        activeOtherCount: 1,
      }),
    ).toBeNull();
  });

  it("scopes reads and revocation to the verified person without exposing session IDs", () => {
    const getRoute = read("apps/api/app/api/admin/team/sessions/self/route.ts");
    expect(getRoute).toContain('"sessions.manage_self"');
    expect(getRoute).toContain("getVerifiedRequestActor(request)");
    expect(getRoute).toContain(
      ".where(eq(teamSessions.teamMemberId, actor.id))",
    );
    expect(getRoute).toContain("current: session.id === actor.sessionId");
    expect(getRoute).not.toMatch(
      /sessions: visibleRows\.map[\s\S]*?id: session\.id/u,
    );

    const revokeRoute = read(
      "apps/api/app/api/admin/team/sessions/self/revoke/route.ts",
    );
    expect(revokeRoute).toContain(
      'requiredPermissions: ["sessions.manage_self"]',
    );
    expect(revokeRoute).toContain('risk: "destructive"');
    expect(revokeRoute).toContain("requiresIdempotency: true");
    expect(revokeRoute).toContain(
      "currentVersion !== mutation.expectedVersion",
    );
    expect(revokeRoute).toContain(".from(teamMembers)");
    expect(revokeRoute).toContain('.for("update")');
    expect(revokeRoute).toContain("ne(teamSessions.id, currentSessionId)");
    expect(revokeRoute).toContain(".returning({ id: teamSessions.id })");
    expect(revokeRoute).toContain("currentSessionPreserved: true");
    expect(revokeRoute).toContain("mutation.audit.insertSuccess(tx");
    expect(revokeRoute).toContain("completeTeamMutationIdempotency(");
  });

  it("keeps the UI truthful, typed-confirmed, and full-receipt gated", () => {
    const settings = read("apps/site/src/app/team/settings-surface.tsx");
    expect(settings).toContain('id="sessions"');
    expect(settings).toContain("This is not an empty session list");
    expect(settings).toContain("Current session");
    expect(settings).toContain("Type REVOKE");
    expect(settings).toContain('name="expectedVersion"');
    expect(settings).toContain("min-h-[44px]");

    const proxy = read(
      "apps/site/src/app/api/team/settings/sessions/revoke/route.ts",
    );
    expect(proxy).toContain('permissions: "sessions.manage_self"');
    expect(proxy).toContain('"Idempotency-Key": idempotencyKey');
    expect(proxy).toContain('"If-Match": `"${expectedVersion}"`');
    for (const receiptField of [
      "operationId",
      "correlationId",
      "actorId",
      "committedAt",
      "auditEventId",
      "version",
    ]) {
      expect(proxy).toContain(`"${receiptField}"`);
    }
  });
});
