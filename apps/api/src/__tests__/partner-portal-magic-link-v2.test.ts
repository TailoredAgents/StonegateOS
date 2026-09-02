import { NextRequest } from "next/server";

const jest = import.meta.jest;
const mockModule = jest.unstable_mockModule as unknown as (
  moduleName: string,
  factory: () => Record<string, unknown>,
) => void;

const mockExchangePartnerLoginToken = jest.fn();
const mockMarkPartnerEmailVerified = jest.fn();
const mockConsumeTeamAuthRateLimit = jest.fn();

mockModule("@/lib/partner-portal-auth", () => ({
  exchangePartnerLoginToken: mockExchangePartnerLoginToken,
  resolvePublicSiteBaseUrl: () => null,
}));
mockModule("@/lib/partner-portal-onboarding", () => ({
  markPartnerEmailVerified: mockMarkPartnerEmailVerified,
}));
mockModule("@/lib/team-auth-rate-limit", () => ({
  consumeTeamAuthRateLimit: mockConsumeTeamAuthRateLimit,
}));
mockModule("@/lib/partner-portal-feature-flags", () => ({
  isPartnerRoutineMagicLinkLoginEnabled: () => true,
}));

const { POST: consumeMagicLink } = await import(
  "../../app/api/portal/v2/auth/magic-link/consume/route"
);

const TOKEN = "a".repeat(43);
const CORRELATION_ID = "portal-magic-link-test-0001";

function request(token = TOKEN, rememberMe = false): NextRequest {
  return new NextRequest(
    "https://api.stonegate.example/api/portal/v2/auth/magic-link/consume",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-correlation-id": CORRELATION_ID,
      },
      body: JSON.stringify({ token, rememberMe }),
    },
  );
}

describe("partner portal V2 magic-link consumption", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockConsumeTeamAuthRateLimit.mockResolvedValue({
      limited: false,
      retryAfterSeconds: 0,
    });
    mockMarkPartnerEmailVerified.mockResolvedValue(undefined);
  });

  it("exchanges once, verifies the application email, and returns no-store", async () => {
    mockExchangePartnerLoginToken.mockResolvedValue({
      sessionToken: "session-secret",
      partnerUserId: "11111111-1111-4111-8111-111111111111",
      orgContactId: "22222222-2222-4222-8222-222222222222",
      needsPasswordSetup: true,
      expiresAt: new Date("2026-08-31T00:00:00.000Z"),
    });

    const response = await consumeMagicLink(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mockExchangePartnerLoginToken).toHaveBeenCalledTimes(1);
    expect(mockExchangePartnerLoginToken).toHaveBeenCalledWith(
      TOKEN,
      expect.any(NextRequest),
      0.5,
    );
    expect(mockMarkPartnerEmailVerified).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
    );
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        sessionToken: "session-secret",
        needsPasswordSetup: true,
        expiresAt: "2026-08-31T00:00:00.000Z",
        persistent: false,
        correlationId: CORRELATION_ID,
      }),
    );
  });

  it("rate-limits by a token fingerprint before exchange", async () => {
    mockConsumeTeamAuthRateLimit.mockResolvedValue({
      limited: true,
      retryAfterSeconds: 45,
    });
    const response = await consumeMagicLink(request());
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("45");
    expect(mockExchangePartnerLoginToken).not.toHaveBeenCalled();
  });

  it("does not strand a consumed token when verification projection fails", async () => {
    mockExchangePartnerLoginToken.mockResolvedValue({
      sessionToken: "session-secret",
      partnerUserId: "11111111-1111-4111-8111-111111111111",
      orgContactId: "22222222-2222-4222-8222-222222222222",
      needsPasswordSetup: false,
      expiresAt: new Date("2026-08-31T00:00:00.000Z"),
    });
    mockMarkPartnerEmailVerified.mockRejectedValue(
      new Error("temporary projection failure"),
    );

    const response = await consumeMagicLink(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ sessionToken: "session-secret" }),
    );
  });

  it("creates a 30-day session only after explicit remember-me opt in", async () => {
    mockExchangePartnerLoginToken.mockResolvedValue({
      sessionToken: "persistent-session-secret",
      partnerUserId: "11111111-1111-4111-8111-111111111111",
      orgContactId: "22222222-2222-4222-8222-222222222222",
      needsPasswordSetup: false,
      expiresAt: new Date("2026-09-29T12:00:00.000Z"),
    });

    const response = await consumeMagicLink(request(TOKEN, true));

    expect(response.status).toBe(200);
    expect(mockExchangePartnerLoginToken).toHaveBeenCalledWith(
      TOKEN,
      expect.any(NextRequest),
      30,
    );
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ persistent: true }),
    );
  });

  it("does not distinguish malformed or expired tokens beyond authorization", async () => {
    mockExchangePartnerLoginToken.mockResolvedValue(null);
    const response = await consumeMagicLink(request());
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ ok: false, error: "unauthorized" }),
    );
    expect(mockMarkPartnerEmailVerified).not.toHaveBeenCalled();
  });
});
