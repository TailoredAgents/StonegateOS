import type { NextRequest } from "next/server";

type Member = {
  id: string;
  name: string;
  email: string | null;
  phoneE164: string | null;
};

type LoginAuditContext = {
  correlationId: string;
  surface: "/team/login";
};

const mockConsumeTeamAuthRateLimit = jest.fn<
  Promise<{ limited: boolean; retryAfterSeconds: number }>,
  [unknown]
>();
const mockCreateTeamLoginToken = jest.fn<
  Promise<{ rawToken: string; expiresAt: Date }>,
  [string, NextRequest, number]
>();
const mockFindActiveTeamMemberByEmail = jest.fn<
  Promise<Member | null>,
  [string]
>();
const mockFindActiveTeamMemberByPhone = jest.fn<
  Promise<Member | null>,
  [string]
>();
const mockLoginWithPassword = jest.fn<
  Promise<null | {
    sessionToken: string;
    sessionId: string;
    teamMember: {
      id: string;
      name: string;
      roleSlug: string | null;
      passwordSet: boolean;
    };
  }>,
  [string, string, NextRequest, number, LoginAuditContext]
>();
const mockRecordTeamAuthAuditEventSafely = jest.fn<
  Promise<boolean>,
  [Record<string, unknown>]
>();
const mockSendEmailMessage = jest.fn<
  Promise<{ ok: boolean }>,
  [string, string, string]
>();
const mockSendSmsMessage = jest.fn<
  Promise<{ ok: boolean }>,
  [string, string]
>();

jest.mock("@/lib/team-auth-rate-limit", () => ({
  consumeTeamAuthRateLimit: mockConsumeTeamAuthRateLimit,
}));

jest.mock("@/lib/team-auth", () => ({
  createTeamLoginToken: mockCreateTeamLoginToken,
  findActiveTeamMemberByEmail: mockFindActiveTeamMemberByEmail,
  findActiveTeamMemberByPhone: mockFindActiveTeamMemberByPhone,
  loginWithPassword: mockLoginWithPassword,
  normalizeEmail: (value: unknown) => {
    if (typeof value !== "string" || !value.trim()) return null;
    return value.trim().toLowerCase();
  },
  normalizePhoneE164: (value: unknown) => {
    if (typeof value !== "string") return null;
    const digits = value.replace(/\D/gu, "");
    return digits.length === 10 ? `+1${digits}` : null;
  },
  resolvePublicSiteBaseUrl: () => "https://staff.example.com",
}));

jest.mock("@/lib/team-auth-audit", () => ({
  getTeamAuthCorrelationId: () => "auth-correlation-1",
  recordTeamAuthAuditEventSafely: mockRecordTeamAuthAuditEventSafely,
}));

jest.mock("@/lib/messaging", () => ({
  sendEmailMessage: mockSendEmailMessage,
  sendSmsMessage: mockSendSmsMessage,
}));

import { POST as loginWithPasswordRoute } from "../../app/api/public/team/login-password/route";
import { POST as requestLinkRoute } from "../../app/api/public/team/request-link/route";

function request(body: unknown): NextRequest {
  return {
    headers: new Headers({ "x-forwarded-for": "203.0.113.9" }),
    json: () => Promise.resolve(body),
  } as unknown as NextRequest;
}

describe("public team authentication routes", () => {
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    mockConsumeTeamAuthRateLimit.mockResolvedValue({
      limited: false,
      retryAfterSeconds: 0,
    });
    mockCreateTeamLoginToken.mockResolvedValue({
      rawToken: "one-time-token",
      expiresAt: new Date("2026-08-08T13:00:00.000Z"),
    });
    mockSendEmailMessage.mockResolvedValue({ ok: true });
    mockSendSmsMessage.mockResolvedValue({ ok: true });
    mockRecordTeamAuthAuditEventSafely.mockResolvedValue(true);
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it("returns the same public success response for known and unknown accounts", async () => {
    mockFindActiveTeamMemberByEmail
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "member-1",
        name: "Staff Member",
        email: "staff@example.com",
        phoneE164: null,
      });

    const unknownResponse = await requestLinkRoute(
      request({ email: "unknown@example.com" }),
    );
    const knownResponse = await requestLinkRoute(
      request({ email: "staff@example.com" }),
    );

    await expect(unknownResponse.json()).resolves.toEqual({ ok: true });
    await expect(knownResponse.json()).resolves.toEqual({ ok: true });
    expect(unknownResponse.status).toBe(200);
    expect(knownResponse.status).toBe(200);
    expect(mockCreateTeamLoginToken).toHaveBeenCalledTimes(1);
    const auditPayload = JSON.stringify(
      mockRecordTeamAuthAuditEventSafely.mock.calls,
    );
    expect(auditPayload).not.toContain("unknown@example.com");
    expect(auditPayload).not.toContain("staff@example.com");
    const successAudit = mockRecordTeamAuthAuditEventSafely.mock.calls
      .map(([event]) => event)
      .find(
        (event) =>
          event["action"] === "team.auth.magic_link.request" &&
          event["outcome"] === "succeeded",
      );
    expect(successAudit?.["metadata"]).toEqual(
      expect.objectContaining({ identityKind: "email" }),
    );
  });

  it("normalizes a generic phone identifier before lookup and rate limiting", async () => {
    mockFindActiveTeamMemberByPhone.mockResolvedValue(null);

    await requestLinkRoute(request({ identifier: "(555) 867-5309" }));

    expect(mockConsumeTeamAuthRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "request_link",
        identity: { kind: "phone", value: "+15558675309" },
      }),
    );
    expect(mockFindActiveTeamMemberByPhone).toHaveBeenCalledWith(
      "+15558675309",
    );
    expect(mockFindActiveTeamMemberByEmail).not.toHaveBeenCalled();
  });

  it("keeps a generic unknown identifier non-enumerating", async () => {
    mockFindActiveTeamMemberByEmail.mockResolvedValue(null);

    const response = await requestLinkRoute(
      request({ identifier: "unknown-user" }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mockFindActiveTeamMemberByEmail).toHaveBeenCalledWith(
      "unknown-user",
    );
  });

  it("keeps lookup failures non-enumerating and records a correlated failure", async () => {
    mockFindActiveTeamMemberByEmail.mockRejectedValue(
      new Error("identity store unavailable"),
    );

    const response = await requestLinkRoute(
      request({ email: "staff@example.com" }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    const failedAudit = mockRecordTeamAuthAuditEventSafely.mock.calls
      .map(([event]) => event)
      .find(
        (event) =>
          event["action"] === "team.auth.magic_link.request" &&
          event["outcome"] === "failed",
      );
    expect(failedAudit?.["metadata"]).toEqual(
      expect.objectContaining({ reasonCode: "request_processing_failed" }),
    );
    expect(
      JSON.stringify(mockRecordTeamAuthAuditEventSafely.mock.calls),
    ).not.toContain("staff@example.com");
  });

  it("returns a non-enumerating 429 with Retry-After before account lookup", async () => {
    mockConsumeTeamAuthRateLimit.mockResolvedValue({
      limited: true,
      retryAfterSeconds: 420,
    });

    const response = await requestLinkRoute(
      request({ email: "staff@example.com" }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("420");
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "rate_limited",
    });
    expect(mockFindActiveTeamMemberByEmail).not.toHaveBeenCalled();
  });

  it("normalizes password-login email for both rate limiting and lookup", async () => {
    mockLoginWithPassword.mockResolvedValue(null);

    const response = await loginWithPasswordRoute(
      request({ email: "  STAFF@Example.COM ", password: "incorrect" }),
    );

    expect(response.status).toBe(401);
    expect(mockConsumeTeamAuthRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "password_login",
        identity: { kind: "email", value: "staff@example.com" },
      }),
    );
    expect(mockLoginWithPassword).toHaveBeenCalledWith(
      "staff@example.com",
      "incorrect",
      expect.anything(),
      30,
      { correlationId: "auth-correlation-1", surface: "/team/login" },
    );
  });

  it("returns 429 with Retry-After before password verification", async () => {
    mockConsumeTeamAuthRateLimit.mockResolvedValue({
      limited: true,
      retryAfterSeconds: 300,
    });

    const response = await loginWithPasswordRoute(
      request({ email: "staff@example.com", password: "incorrect" }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("300");
    expect(mockLoginWithPassword).not.toHaveBeenCalled();
    const deniedAudit = mockRecordTeamAuthAuditEventSafely.mock.calls
      .map(([event]) => event)
      .find(
        (event) =>
          event["action"] === "team.auth.password.login" &&
          event["outcome"] === "denied",
      );
    expect(deniedAudit?.["metadata"]).toEqual(
      expect.objectContaining({ reasonCode: "rate_limited" }),
    );
  });

  it("binds password-login success auditing to the session transaction", async () => {
    mockLoginWithPassword.mockResolvedValue({
      sessionToken: "raw-session-secret",
      sessionId: "session-1",
      teamMember: {
        id: "member-1",
        name: "Staff Member",
        roleSlug: "office",
        passwordSet: true,
      },
    });

    const response = await loginWithPasswordRoute(
      request({ email: "staff@example.com", password: "private-password" }),
    );

    expect(response.status).toBe(200);
    expect(mockLoginWithPassword).toHaveBeenCalledWith(
      "staff@example.com",
      "private-password",
      expect.anything(),
      30,
      { correlationId: "auth-correlation-1", surface: "/team/login" },
    );
    expect(
      mockRecordTeamAuthAuditEventSafely.mock.calls.some(
        ([event]) => event["outcome"] === "succeeded",
      ),
    ).toBe(false);
    const auditPayload = JSON.stringify(
      mockRecordTeamAuthAuditEventSafely.mock.calls,
    );
    expect(auditPayload).not.toContain("staff@example.com");
    expect(auditPayload).not.toContain("private-password");
    expect(auditPayload).not.toContain("raw-session-secret");
    expect(auditPayload).not.toContain("203.0.113.9");
  });

  it("records a failed password login when session creation is unavailable", async () => {
    mockLoginWithPassword.mockRejectedValue(new Error("database unavailable"));

    const response = await loginWithPasswordRoute(
      request({ email: "staff@example.com", password: "private-password" }),
    );

    expect(response.status).toBe(503);
    const failedAudit = mockRecordTeamAuthAuditEventSafely.mock.calls
      .map(([event]) => event)
      .find(
        (event) =>
          event["action"] === "team.auth.password.login" &&
          event["outcome"] === "failed",
      );
    expect(failedAudit?.["metadata"]).toEqual(
      expect.objectContaining({ reasonCode: "session_creation_failed" }),
    );
    const auditPayload = JSON.stringify(
      mockRecordTeamAuthAuditEventSafely.mock.calls,
    );
    expect(auditPayload).not.toContain("staff@example.com");
    expect(auditPayload).not.toContain("private-password");
  });

  it("fails closed without account lookup when the limiter is unavailable", async () => {
    mockConsumeTeamAuthRateLimit.mockRejectedValue(
      new Error("rate limit storage unavailable"),
    );

    const response = await requestLinkRoute(
      request({ email: "staff@example.com" }),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(mockFindActiveTeamMemberByEmail).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      "[team.auth] request_link_rate_limit_unavailable",
      {
        errorName: "Error",
        errorCode: null,
        causeName: null,
        causeCode: null,
      },
    );
  });

  it("fails password login closed without leaking limiter SQL or parameters", async () => {
    const cause = Object.assign(new Error("staff@example.com"), {
      name: "PostgresError",
      code: "42P10",
    });
    mockConsumeTeamAuthRateLimit.mockRejectedValue(
      Object.assign(
        new Error("Failed query with private-password and staff@example.com"),
        { name: "DrizzleQueryError", cause },
      ),
    );

    const response = await loginWithPasswordRoute(
      request({ email: "staff@example.com", password: "private-password" }),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(mockLoginWithPassword).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      "[team.auth] password_rate_limit_unavailable",
      {
        errorName: "DrizzleQueryError",
        errorCode: null,
        causeName: "PostgresError",
        causeCode: "42P10",
      },
    );
    const logged = JSON.stringify(consoleError.mock.calls);
    expect(logged).not.toContain("staff@example.com");
    expect(logged).not.toContain("private-password");
    expect(logged).not.toContain("Failed query");
  });
});
