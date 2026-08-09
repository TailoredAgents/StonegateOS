import type { NextRequest } from "next/server";

const mockRecordAuditEvent = jest.fn<
  Promise<void>,
  [Record<string, unknown>]
>();

jest.mock("@/lib/audit", () => ({
  recordAuditEvent: mockRecordAuditEvent,
}));

import {
  getTeamAuthCorrelationId,
  getVerifiedTeamAuthActor,
  insertTeamAuthSuccessAuditEvent,
  recordTeamAuthAuditEventSafely,
} from "@/lib/team-auth-audit";

function request(headers: Record<string, string> = {}): NextRequest {
  return { headers: new Headers(headers) } as unknown as NextRequest;
}

describe("team authentication audit events", () => {
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRecordAuditEvent.mockResolvedValue();
    consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it("accepts opaque trace IDs but never reuses an IP address as a correlation ID", () => {
    const trustedId = "287cc8f4-3ef1-4e87-a891-29a488b5fc92";

    expect(
      getTeamAuthCorrelationId(request({ "x-correlation-id": trustedId })),
    ).toBe(trustedId);

    const generated = getTeamAuthCorrelationId(
      request({ "x-correlation-id": "203.0.113.9" }),
    );
    expect(generated).not.toBe("203.0.113.9");
    expect(generated).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    );
  });

  it("builds a human actor only from a verified member and session", () => {
    expect(
      getVerifiedTeamAuthActor({
        memberId: "member-1",
        roleSlug: "office",
        sessionId: "session-1",
        authMethod: "team_session",
      }),
    ).toEqual({
      type: "human",
      id: "member-1",
      role: "office",
      sessionId: "session-1",
      authMethod: "team_session",
    });
  });

  it("persists explicit outcomes and allowlists authentication metadata", async () => {
    await recordTeamAuthAuditEventSafely({
      action: "team.auth.password.login",
      outcome: "denied",
      correlationId: "287cc8f4-3ef1-4e87-a891-29a488b5fc92",
      surface: "/team/login",
      metadata: {
        identityKind: "email",
        reasonCode: "invalid_credentials",
        password: "must-not-be-stored",
        token: "must-not-be-stored",
        email: "person@example.com",
        ip: "203.0.113.9",
      } as never,
    });

    expect(mockRecordAuditEvent).toHaveBeenCalledWith({
      actor: undefined,
      action: "team.auth.password.login",
      entityType: "team_authentication",
      entityId: null,
      meta: {
        identityKind: "email",
        reasonCode: "invalid_credentials",
      },
      correlationId: "287cc8f4-3ef1-4e87-a891-29a488b5fc92",
      outcome: "denied",
      surface: "/team/login",
    });
    const persistedPayload = JSON.stringify(mockRecordAuditEvent.mock.calls);
    expect(persistedPayload).not.toContain("must-not-be-stored");
    expect(persistedPayload).not.toContain("person@example.com");
    expect(persistedPayload).not.toContain("203.0.113.9");
  });

  it("does not leak event metadata when audit storage is unavailable", async () => {
    mockRecordAuditEvent.mockRejectedValue(new Error("database unavailable"));

    await expect(
      recordTeamAuthAuditEventSafely({
        action: "team.auth.magic_link.consume",
        outcome: "failed",
        correlationId: "287cc8f4-3ef1-4e87-a891-29a488b5fc92",
        surface: "/team/auth",
        metadata: { reasonCode: "exchange_unavailable" },
      }),
    ).resolves.toBe(false);

    expect(consoleError).toHaveBeenCalledWith(
      "[team.auth.audit] write_failed",
      {
        action: "team.auth.magic_link.consume",
        outcome: "failed",
        correlationId: "287cc8f4-3ef1-4e87-a891-29a488b5fc92",
      },
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(
      "exchange_unavailable",
    );
  });

  it("allowlists transaction-bound success metadata before it reaches storage", async () => {
    const values = jest.fn(() => Promise.resolve());
    const tx = {
      insert: () => ({ values }),
    };

    await insertTeamAuthSuccessAuditEvent(tx as never, {
      action: "team.auth.password.login",
      correlationId: "287cc8f4-3ef1-4e87-a891-29a488b5fc92",
      surface: "/team/login",
      actor: getVerifiedTeamAuthActor({
        memberId: "11111111-1111-4111-8111-111111111111",
        roleSlug: "office",
        sessionId: "22222222-2222-4222-8222-222222222222",
        authMethod: "team_session",
      }),
      entityType: "team_session",
      entityId: "22222222-2222-4222-8222-222222222222",
      metadata: {
        identityKind: "email",
        sessionCreated: true,
        password: "private-password",
        token: "private-token",
        email: "person@example.com",
        ip: "203.0.113.9",
      } as never,
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "11111111-1111-4111-8111-111111111111",
        sessionId: "22222222-2222-4222-8222-222222222222",
        outcome: "succeeded",
        meta: { identityKind: "email", sessionCreated: true },
      }),
    );
    const stored = JSON.stringify(values.mock.calls);
    expect(stored).not.toContain("private-password");
    expect(stored).not.toContain("private-token");
    expect(stored).not.toContain("person@example.com");
    expect(stored).not.toContain("203.0.113.9");
  });
});
