import { NextRequest } from "next/server";

const jest = import.meta.jest;
const mockModule = jest.unstable_mockModule as unknown as (
  moduleName: string,
  factory: () => Record<string, unknown>,
) => void;

const mockCompletePartnerActivation = jest.fn();
const mockConsumeRateLimit = jest.fn();

mockModule("@/lib/partner-purpose-auth", () => ({
  completePartnerActivation: mockCompletePartnerActivation,
}));
mockModule("@/lib/partner-portal-feature-flags", () => ({
  arePartnerPurposeAuthTokensEnabled: () => true,
}));
mockModule("@/lib/partner-portal-v2-security", () => ({
  isAllowedPartnerPortalMutationOrigin: () => true,
}));
mockModule("@/lib/team-auth-rate-limit", () => ({
  consumeTeamAuthRateLimit: mockConsumeRateLimit,
}));

const { POST } = await import(
  "../../app/api/portal/v2/onboarding/activation/complete/route"
);

const TOKEN = "t".repeat(43);

function request(body: unknown): NextRequest {
  return new NextRequest(
    "https://api.stonegate.example/api/portal/v2/onboarding/activation/complete",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "partner-activation-test-1",
        origin: "https://stonegate.example",
        "x-correlation-id": "partner-activation-test",
      },
      body: JSON.stringify(body),
    },
  );
}

describe("partner password activation without an MFA branch", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockConsumeRateLimit.mockResolvedValue({
      limited: false,
      retryAfterSeconds: 0,
    });
  });

  it("returns the portal session directly after password activation", async () => {
    mockCompletePartnerActivation.mockResolvedValue({
      kind: "success",
      sessionToken: "s".repeat(43),
      expiresAt: new Date("2026-09-05T12:00:00.000Z"),
    });

    const response = await POST(
      request({
        token: TOKEN,
        password: "correct horse battery staple",
        confirmPassword: "correct horse battery staple",
        rememberMe: true,
      }),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      sessionToken: "s".repeat(43),
      expiresAt: "2026-09-05T12:00:00.000Z",
      nextAction: "portal_ready",
      authority: "portal",
      persistent: true,
      correlationId: "partner-activation-test",
    });
    expect(JSON.stringify(body)).not.toMatch(/mfa|transactionToken/iu);
    expect(mockCompletePartnerActivation).toHaveBeenCalledWith(
      expect.objectContaining({
        rawToken: TOKEN,
        password: "correct horse battery staple",
        rememberMe: true,
        correlationId: "partner-activation-test",
      }),
    );
  });

  it("preserves activation rate limiting before credential mutation", async () => {
    mockConsumeRateLimit.mockResolvedValue({
      limited: true,
      retryAfterSeconds: 60,
    });

    const response = await POST(
      request({
        token: TOKEN,
        password: "correct horse battery staple",
        confirmPassword: "correct horse battery staple",
      }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(mockCompletePartnerActivation).not.toHaveBeenCalled();
  });
});
