import type { NextRequest } from "next/server";
import type { VerifiedRequestActor } from "@/lib/verified-actor-context";

const mockRequirePermission = jest.fn<
  Promise<Response | null>,
  [NextRequest, unknown, unknown?]
>();
const mockGetVerifiedRequestActor = jest.fn<
  VerifiedRequestActor | null,
  [NextRequest]
>();
const mockConsumeTeamAuthRateLimit = jest.fn<
  Promise<{ limited: boolean; retryAfterSeconds: number }>,
  [unknown]
>();
const mockCreateBreakGlassTeamSession = jest.fn<Promise<unknown>, [unknown]>();

jest.mock("@/lib/permissions", () => ({
  requirePermission: mockRequirePermission,
}));

jest.mock("@/lib/verified-actor-context", () => ({
  getVerifiedRequestActor: mockGetVerifiedRequestActor,
}));

jest.mock("@/lib/team-auth-rate-limit", () => ({
  consumeTeamAuthRateLimit: mockConsumeTeamAuthRateLimit,
}));

jest.mock("@/lib/team-auth", () => ({
  createBreakGlassTeamSession: mockCreateBreakGlassTeamSession,
  getClientIp: (request: NextRequest) =>
    request.headers.get("x-forwarded-for") ?? null,
}));

import { POST } from "../../app/api/admin/team/break-glass/exchange/route";

function request(body: unknown): NextRequest & { json: jest.Mock } {
  const json = jest.fn(() => Promise.resolve(body));
  return {
    headers: new Headers({
      host: "api.example.test",
      "x-forwarded-for": "203.0.113.42",
      "x-team-client-user-agent": "Recovery browser",
    }),
    nextUrl: new URL(
      "https://api.example.test/api/admin/team/break-glass/exchange",
    ),
    json,
  } as unknown as NextRequest & { json: jest.Mock };
}

describe("break-glass session exchange route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequirePermission.mockResolvedValue(null);
    mockGetVerifiedRequestActor.mockReturnValue({
      type: "worker",
      label: "team-break-glass-exchange",
      sessionId: null,
      authMethod: "service",
    });
    mockConsumeTeamAuthRateLimit.mockResolvedValue({
      limited: false,
      retryAfterSeconds: 0,
    });
  });

  it("authorizes the narrow service before parsing any input", async () => {
    mockRequirePermission.mockResolvedValue(
      Response.json({ error: "unauthorized" }, { status: 401 }),
    );
    const input = request({ legacyType: "owner" });

    const response = await POST(input);

    expect(response.status).toBe(401);
    expect(input.json).not.toHaveBeenCalled();
    expect(mockConsumeTeamAuthRateLimit).not.toHaveBeenCalled();
    expect(mockCreateBreakGlassTeamSession).not.toHaveBeenCalled();
  });

  it("rate-limits invalid cookie attempts without selecting a member", async () => {
    const response = await POST(request({ legacyType: "invalid" }));

    expect(response.status).toBe(401);
    expect(mockConsumeTeamAuthRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "break_glass_exchange",
        identity: { kind: "break_glass", value: "invalid" },
      }),
    );
    expect(mockCreateBreakGlassTeamSession).not.toHaveBeenCalled();
  });

  it("returns retry guidance before attempting session creation", async () => {
    mockConsumeTeamAuthRateLimit.mockResolvedValue({
      limited: true,
      retryAfterSeconds: 600,
    });

    const response = await POST(request({ legacyType: "crew" }));

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("600");
    expect(mockCreateBreakGlassTeamSession).not.toHaveBeenCalled();
  });

  it("returns only the new opaque session after the atomic audited write", async () => {
    mockCreateBreakGlassTeamSession.mockResolvedValue({
      sessionToken: "opaque-new-session",
      sessionId: "11111111-1111-4111-8111-111111111111",
      teamMemberId: "22222222-2222-4222-8222-222222222222",
      expiresAt: new Date("2026-08-08T13:00:00.000Z"),
      auditEventId: "33333333-3333-4333-8333-333333333333",
      committedAt: "2026-08-08T12:00:00.000Z",
    });

    const response = await POST(request({ legacyType: "owner" }));
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(201);
    expect(mockCreateBreakGlassTeamSession).toHaveBeenCalledTimes(1);
    const exchangeInput = mockCreateBreakGlassTeamSession.mock.calls[0]?.[0] as
      | {
          sessionType?: unknown;
          clientIp?: unknown;
          userAgent?: unknown;
          audit?: { insertSuccess?: unknown };
        }
      | undefined;
    expect(exchangeInput).toMatchObject({
      sessionType: "owner",
      clientIp: "203.0.113.42",
      userAgent: "Recovery browser",
    });
    expect(typeof exchangeInput?.audit?.insertSuccess).toBe("function");
    expect(body).toEqual(
      expect.objectContaining({
        ok: true,
        data: {
          sessionToken: "opaque-new-session",
          expiresAt: "2026-08-08T13:00:00.000Z",
        },
      }),
    );
    expect(JSON.stringify(body)).not.toContain("legacyType");
    expect(JSON.stringify(body)).not.toContain("ADMIN_API_KEY");
  });
});
