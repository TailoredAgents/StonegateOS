import type { NextRequest } from "next/server";

type TeamMember = {
  id: string;
  name: string;
  email: string | null;
  roleSlug: string | null;
  passwordSet: boolean;
  permissions: string[];
};

type SessionResult =
  | {
      ok: true;
      sessionId: string;
      authMethod: "team_session" | "break_glass";
      teamMember: TeamMember;
    }
  | { ok: false; status: number; error: string };

type ExchangeResult = {
  sessionToken: string;
  sessionId: string;
  teamMember: Omit<TeamMember, "permissions">;
  needsPasswordSetup: boolean;
};

type AuthAuditContext = {
  correlationId: string;
  surface: "/team/auth" | "/team/settings" | "/team";
};

const mockExchangeTeamLoginToken = jest.fn<
  Promise<ExchangeResult | null>,
  [string, NextRequest, number, AuthAuditContext]
>();
const mockRequireTeamSession = jest.fn<Promise<SessionResult>, [NextRequest]>();
const mockRevokeTeamSession = jest.fn<
  Promise<void>,
  [string, AuthAuditContext]
>();
const mockSetTeamMemberPassword = jest.fn<
  Promise<{
    revokedSessionCount: number;
    passwordMode: "setup" | "change";
  }>,
  [string, string, string, AuthAuditContext]
>();
const mockRecordTeamAuthAuditEventSafely = jest.fn<
  Promise<boolean>,
  [Record<string, unknown>]
>();
const mockGetVerifiedTeamAuthActor = jest.fn(
  (input: Record<string, unknown>) => ({
    type: "human" as const,
    id: input["memberId"],
    role: input["roleSlug"],
    sessionId: input["sessionId"],
    authMethod: input["authMethod"],
  }),
);
jest.mock("@/lib/team-auth", () => ({
  exchangeTeamLoginToken: mockExchangeTeamLoginToken,
  requireTeamSession: mockRequireTeamSession,
  revokeTeamSession: mockRevokeTeamSession,
  setTeamMemberPassword: mockSetTeamMemberPassword,
}));

jest.mock("@/lib/team-auth-audit", () => ({
  getTeamAuthCorrelationId: () => "auth-correlation-1",
  getVerifiedTeamAuthActor: mockGetVerifiedTeamAuthActor,
  recordTeamAuthAuditEventSafely: mockRecordTeamAuthAuditEventSafely,
}));

import { POST as exchangeRoute } from "../../app/api/public/team/exchange/route";
import { POST as logoutRoute } from "../../app/api/team/logout/route";
import { POST as passwordRoute } from "../../app/api/team/password/route";

function request(body: unknown, token?: string): NextRequest {
  return {
    headers: new Headers(token ? { authorization: `Bearer ${token}` } : {}),
    json: jest.fn(() => Promise.resolve(body)),
  } as unknown as NextRequest;
}

function activeSession(
  passwordSet: boolean,
): Extract<SessionResult, { ok: true }> {
  return {
    ok: true,
    sessionId: "session-1",
    authMethod: "team_session",
    teamMember: {
      id: "member-1",
      name: "Staff Member",
      email: "staff@example.com",
      roleSlug: "office",
      passwordSet,
      permissions: ["settings.manage"],
    },
  };
}

describe("team authentication route audit outcomes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRecordTeamAuthAuditEventSafely.mockResolvedValue(true);
    mockRevokeTeamSession.mockResolvedValue();
  });

  it("binds magic-link success auditing to the exchange transaction without exposing either token", async () => {
    mockExchangeTeamLoginToken.mockResolvedValue({
      sessionToken: "new-private-session-token",
      sessionId: "session-1",
      teamMember: {
        id: "member-1",
        name: "Staff Member",
        email: "staff@example.com",
        roleSlug: "office",
        passwordSet: true,
      },
      needsPasswordSetup: false,
    });

    const response = await exchangeRoute(
      request({ token: "private-one-time-token" }),
    );

    expect(response.status).toBe(200);
    expect(mockExchangeTeamLoginToken).toHaveBeenCalledWith(
      "private-one-time-token",
      expect.anything(),
      30,
      { correlationId: "auth-correlation-1", surface: "/team/auth" },
    );
    expect(
      mockRecordTeamAuthAuditEventSafely.mock.calls.some(
        ([event]) => event["outcome"] === "succeeded",
      ),
    ).toBe(false);
    const auditPayload = JSON.stringify(
      mockRecordTeamAuthAuditEventSafely.mock.calls,
    );
    expect(auditPayload).not.toContain("private-one-time-token");
    expect(auditPayload).not.toContain("new-private-session-token");
    expect(auditPayload).not.toContain("staff@example.com");
  });

  it("records invalid or replayed magic links as denied", async () => {
    mockExchangeTeamLoginToken.mockResolvedValue(null);

    const response = await exchangeRoute(request({ token: "expired-token" }));

    expect(response.status).toBe(401);
    expect(mockRecordTeamAuthAuditEventSafely).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "team.auth.magic_link.consume",
        outcome: "denied",
        metadata: { reasonCode: "invalid_or_expired" },
      }),
    );
    expect(
      JSON.stringify(mockRecordTeamAuthAuditEventSafely.mock.calls),
    ).not.toContain("expired-token");
  });

  it("records both magic-link operations as failed when exchange cannot complete", async () => {
    mockExchangeTeamLoginToken.mockRejectedValue(
      new Error("database unavailable"),
    );

    const response = await exchangeRoute(
      request({ token: "private-one-time-token" }),
    );

    expect(response.status).toBe(503);
    const failedActions = mockRecordTeamAuthAuditEventSafely.mock.calls
      .map(([event]) => event)
      .filter((event) => event["outcome"] === "failed")
      .map((event) => event["action"]);
    expect(failedActions).toEqual(
      expect.arrayContaining([
        "team.auth.magic_link.consume",
        "team.auth.magic_link.exchange",
      ]),
    );
    expect(
      JSON.stringify(mockRecordTeamAuthAuditEventSafely.mock.calls),
    ).not.toContain("private-one-time-token");
  });

  it("binds password setup success auditing to the password transaction", async () => {
    mockRequireTeamSession.mockResolvedValue(activeSession(false));
    mockSetTeamMemberPassword.mockResolvedValue({
      revokedSessionCount: 2,
      passwordMode: "setup",
    });

    const response = await passwordRoute(
      request({ password: "private-password" }, "current-session-token"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      revokedSessionCount: 2,
    });
    expect(mockSetTeamMemberPassword).toHaveBeenCalledWith(
      "member-1",
      "private-password",
      "session-1",
      { correlationId: "auth-correlation-1", surface: "/team/settings" },
    );
    expect(
      mockRecordTeamAuthAuditEventSafely.mock.calls.some(
        ([event]) => event["outcome"] === "succeeded",
      ),
    ).toBe(false);
    const auditPayload = JSON.stringify(
      mockRecordTeamAuthAuditEventSafely.mock.calls,
    );
    expect(auditPayload).not.toContain("private-password");
    expect(auditPayload).not.toContain("current-session-token");
    expect(auditPayload).not.toContain("staff@example.com");
  });

  it("records a denied password change without reading the password first", async () => {
    mockRequireTeamSession.mockResolvedValue({
      ok: false,
      status: 401,
      error: "session_revoked",
    });
    const json = jest.fn(() =>
      Promise.resolve({ password: "private-password" }),
    );
    const deniedRequest = {
      headers: new Headers({
        authorization: "Bearer revoked-session-token",
      }),
      json,
    } as unknown as NextRequest;

    const response = await passwordRoute(deniedRequest);

    expect(response.status).toBe(401);
    expect(json).not.toHaveBeenCalled();
    expect(mockSetTeamMemberPassword).not.toHaveBeenCalled();
    expect(mockRecordTeamAuthAuditEventSafely).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "team.auth.password.update",
        outcome: "denied",
        metadata: { reasonCode: "session_revoked" },
      }),
    );
  });

  it("returns a password change only after its transaction-bound audit succeeds", async () => {
    mockRequireTeamSession.mockResolvedValue(activeSession(true));
    mockSetTeamMemberPassword.mockResolvedValue({
      revokedSessionCount: 1,
      passwordMode: "change",
    });

    const response = await passwordRoute(
      request({ password: "replacement-password" }, "current-session-token"),
    );

    expect(response.status).toBe(200);
    expect(mockSetTeamMemberPassword).toHaveBeenCalledWith(
      "member-1",
      "replacement-password",
      "session-1",
      { correlationId: "auth-correlation-1", surface: "/team/settings" },
    );
    expect(
      JSON.stringify(mockRecordTeamAuthAuditEventSafely.mock.calls),
    ).not.toContain("replacement-password");
  });

  it("records a failed password update without claiming success", async () => {
    mockRequireTeamSession.mockResolvedValue(activeSession(true));
    mockSetTeamMemberPassword.mockRejectedValue(
      new Error("database unavailable"),
    );

    const response = await passwordRoute(
      request({ password: "replacement-password" }, "current-session-token"),
    );

    expect(response.status).toBe(503);
    const terminalAudits = mockRecordTeamAuthAuditEventSafely.mock.calls
      .map(([event]) => event)
      .filter((event) => event["action"] === "team.auth.password.change");
    expect(terminalAudits.some((event) => event["outcome"] === "failed")).toBe(
      true,
    );
    expect(
      terminalAudits.some((event) => event["outcome"] === "succeeded"),
    ).toBe(false);
    expect(JSON.stringify(terminalAudits)).not.toContain(
      "replacement-password",
    );
  });

  it("returns logout success only after transaction-bound revocation auditing", async () => {
    mockRequireTeamSession.mockResolvedValue(activeSession(true));

    const response = await logoutRoute(
      request(null, "private-current-session-token"),
    );

    expect(response.status).toBe(200);
    expect(mockRevokeTeamSession).toHaveBeenCalledWith(
      "private-current-session-token",
      { correlationId: "auth-correlation-1", surface: "/team" },
    );
    expect(
      mockRecordTeamAuthAuditEventSafely.mock.calls.some(
        ([event]) => event["outcome"] === "succeeded",
      ),
    ).toBe(false);
    const auditPayload = JSON.stringify(
      mockRecordTeamAuthAuditEventSafely.mock.calls,
    );
    expect(auditPayload).not.toContain("private-current-session-token");
    expect(auditPayload).not.toContain("staff@example.com");
  });

  it("records a failed logout when session revocation cannot commit", async () => {
    mockRequireTeamSession.mockResolvedValue(activeSession(true));
    mockRevokeTeamSession.mockRejectedValue(new Error("database unavailable"));

    const response = await logoutRoute(
      request(null, "private-current-session-token"),
    );

    expect(response.status).toBe(503);
    const failedAudit = mockRecordTeamAuthAuditEventSafely.mock.calls
      .map(([event]) => event)
      .find(
        (event) =>
          event["action"] === "team.auth.logout" &&
          event["outcome"] === "failed",
      );
    expect(failedAudit?.["metadata"]).toEqual(
      expect.objectContaining({ reasonCode: "session_revocation_failed" }),
    );
  });
});
