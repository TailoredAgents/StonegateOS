import { NextRequest } from "next/server";

const jest = import.meta.jest;
const mockModule = jest.unstable_mockModule as unknown as (
  moduleName: string,
  factory: () => Record<string, unknown>,
) => void;

const mockStart = jest.fn<Promise<unknown>, [unknown]>();
const mockComplete = jest.fn<Promise<unknown>, [unknown]>();
const mockConsumeRateLimit = jest.fn<Promise<unknown>, [unknown]>();
const mockOriginAllowed = jest.fn<boolean, [unknown]>();

mockModule("@/lib/partner-activation-mfa-auth", () => ({
  startPartnerActivationMfa: (input: unknown) => mockStart(input),
  completePartnerActivationMfa: (input: unknown) => mockComplete(input),
}));
mockModule("@/lib/partner-portal-feature-flags", () => ({
  arePartnerPurposeAuthTokensEnabled: () => true,
}));
mockModule("@/lib/team-auth-rate-limit", () => ({
  consumeTeamAuthRateLimit: (input: unknown) => mockConsumeRateLimit(input),
}));
mockModule("@/lib/partner-portal-v2-security", () => ({
  isAllowedPartnerPortalMutationOrigin: (input: unknown) =>
    mockOriginAllowed(input),
}));

const { POST: startEnrollment } = await import(
  "../../app/api/portal/v2/onboarding/activation/mfa/enrollment/route"
);
const { POST: confirmActivation } = await import(
  "../../app/api/portal/v2/onboarding/activation/mfa/confirm/route"
);

const TOKEN = "t".repeat(43);

function request(pathname: string, body: unknown): NextRequest {
  return new NextRequest(`https://api.stonegate.example${pathname}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      origin: "https://stonegate.example",
      "user-agent": "Stonegate activation test",
      "x-forwarded-for": "203.0.113.17",
    },
    body: JSON.stringify(body),
  });
}

describe("privileged partner activation MFA routes", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockOriginAllowed.mockReturnValue(true);
    mockConsumeRateLimit.mockResolvedValue({
      limited: false,
      retryAfterSeconds: 0,
    });
  });

  it("starts transaction-bound authenticator enrollment", async () => {
    mockStart.mockResolvedValue({
      kind: "enrollment",
      challengeId: "11111111-1111-4111-8111-111111111111",
      secret: "JBSWY3DPEHPK3PXP",
      otpauthUri: "otpauth://totp/Stonegate",
      expiresAt: new Date("2026-09-01T12:10:00.000Z"),
    });
    const response = await startEnrollment(
      request("/api/portal/v2/onboarding/activation/mfa/enrollment", {}),
    );
    expect(response.status).toBe(201);
    expect((await response.json()) as unknown).toMatchObject({
      ok: true,
      mode: "enroll",
      enrollment: {
        challengeId: "11111111-1111-4111-8111-111111111111",
      },
    });
    expect(mockStart).toHaveBeenCalledWith(
      expect.objectContaining({ transactionToken: TOKEN }),
    );
  });

  it("rejects a cross-origin start before rate limiting or service work", async () => {
    mockOriginAllowed.mockReturnValue(false);
    const response = await startEnrollment(
      request("/api/portal/v2/onboarding/activation/mfa/enrollment", {}),
    );
    expect(response.status).toBe(403);
    expect(mockConsumeRateLimit).not.toHaveBeenCalled();
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("rate-limits confirmation by the pre-authentication bearer", async () => {
    mockConsumeRateLimit.mockResolvedValue({
      limited: true,
      retryAfterSeconds: 60,
    });
    const response = await confirmActivation(
      request("/api/portal/v2/onboarding/activation/mfa/confirm", {
        code: "123456",
      }),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it("returns an AAL2 session only after atomic confirmation", async () => {
    mockComplete.mockResolvedValue({
      kind: "success",
      sessionToken: "s".repeat(43),
      expiresAt: new Date("2026-09-02T00:00:00.000Z"),
      recoveryCodes: ["AAAA-BBBB-CCCC-DDDD"],
      recoveryCodeUsed: false,
      enrolled: true,
    });
    const response = await confirmActivation(
      request("/api/portal/v2/onboarding/activation/mfa/confirm", {
        challengeId: "11111111-1111-4111-8111-111111111111",
        code: "123456",
      }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toMatchObject({
      ok: true,
      assuranceLevel: "aal2",
      sessionToken: "s".repeat(43),
      enrollment: { displayOnce: true },
    });
  });

  it("does not return a session for a rejected or exhausted code", async () => {
    mockComplete.mockResolvedValue({
      kind: "invalid_code",
      attemptsRemaining: 0,
    });
    const response = await confirmActivation(
      request("/api/portal/v2/onboarding/activation/mfa/confirm", {
        code: "123456",
      }),
    );
    expect(response.status).toBe(422);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["ok"]).toBe(false);
    expect(body["sessionToken"]).toBeUndefined();
    expect(body["attemptsRemaining"]).toBe(0);
  });
});
