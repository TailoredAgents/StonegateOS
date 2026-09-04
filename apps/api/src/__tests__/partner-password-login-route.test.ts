import { NextRequest } from "next/server";

const jest = import.meta.jest;
const mockModule = jest.unstable_mockModule as unknown as (
  moduleName: string,
  factory: () => Record<string, unknown>,
) => void;

const mockLoginWithPassword = jest.fn();
const mockConsumeRateLimit = jest.fn();

mockModule("@/lib/partner-portal-auth", () => ({
  loginWithPassword: mockLoginWithPassword,
  normalizeEmail: (value: unknown) =>
    typeof value === "string" ? value.trim().toLowerCase() : null,
  resolvePartnerAuthCorrelationId: () => "partner-password-login-test",
}));
mockModule("@/lib/team-auth-rate-limit", () => ({
  consumeTeamAuthRateLimit: mockConsumeRateLimit,
}));

const { POST } = await import(
  "../../app/api/public/partners/login-password/route"
);

function request(body: unknown): NextRequest {
  return new NextRequest(
    "https://api.stonegate.example/api/public/partners/login-password",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

describe("partner password login without an MFA branch", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockConsumeRateLimit.mockResolvedValue({
      limited: false,
      retryAfterSeconds: 0,
    });
  });

  it("returns the authenticated session directly after valid credentials", async () => {
    mockLoginWithPassword.mockResolvedValue({
      kind: "authenticated",
      sessionToken: "s".repeat(43),
      partnerUserId: "11111111-1111-4111-8111-111111111111",
      orgContactId: null,
      expiresAt: new Date("2026-09-05T12:00:00.000Z"),
    });

    const response = await POST(
      request({
        email: " Partner@Example.test ",
        password: "correct horse battery staple",
        rememberMe: true,
      }),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      status: "authenticated",
      sessionToken: "s".repeat(43),
      expiresAt: "2026-09-05T12:00:00.000Z",
      persistent: true,
      correlationId: "partner-password-login-test",
    });
    expect(JSON.stringify(body)).not.toMatch(/mfa|transactionToken/iu);
    expect(mockLoginWithPassword).toHaveBeenCalledWith(
      "partner@example.test",
      "correct horse battery staple",
      expect.any(NextRequest),
      { rememberMe: true },
    );
  });

  it("preserves neutral invalid-credential handling", async () => {
    mockLoginWithPassword.mockResolvedValue(null);

    const response = await POST(
      request({
        email: "unknown@example.test",
        password: "incorrect password value",
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "invalid_credentials",
    });
  });
});
