import { NextRequest } from "next/server";

const jest = import.meta.jest;
const mockModule = jest.unstable_mockModule as unknown as (
  moduleName: string,
  factory: () => Record<string, unknown>,
) => void;

const mockLoginWithPassword = jest.fn<
  Promise<unknown>,
  [unknown, unknown, unknown, unknown]
>();
const mockCompletePartnerPasswordMfa = jest.fn<Promise<unknown>, [unknown]>();
const mockConsumeRateLimit = jest.fn<Promise<unknown>, [unknown]>();
const mockOriginAllowed = jest.fn<boolean, [unknown]>();

mockModule("@/lib/partner-portal-auth", () => ({
  loginWithPassword: (
    email: unknown,
    password: unknown,
    request: unknown,
    options: unknown,
  ) => mockLoginWithPassword(email, password, request, options),
  normalizeEmail: (value: unknown) =>
    typeof value === "string" ? value.trim().toLowerCase() : null,
  resolvePartnerAuthCorrelationId: () => "correlation-partner-mfa-test",
}));
mockModule("@/lib/partner-password-mfa-auth", () => ({
  completePartnerPasswordMfa: (input: unknown) =>
    mockCompletePartnerPasswordMfa(input),
}));
mockModule("@/lib/team-auth-rate-limit", () => ({
  consumeTeamAuthRateLimit: (input: unknown) => mockConsumeRateLimit(input),
}));
mockModule("@/lib/partner-portal-v2-security", () => ({
  isAllowedPartnerPortalMutationOrigin: (input: unknown) =>
    mockOriginAllowed(input),
}));

const { POST: passwordLogin } = await import(
  "../../app/api/public/partners/login-password/route"
);
const { POST: completeMfa } = await import(
  "../../app/api/public/partners/login-password/mfa/route"
);

function jsonRequest(pathname: string, body: unknown, token?: string) {
  return new NextRequest(`https://api.stonegate.test${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://stonegate.test",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("partner password MFA routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConsumeRateLimit.mockResolvedValue({
      limited: false,
      retryAfterSeconds: 0,
    });
    mockOriginAllowed.mockReturnValue(true);
  });

  it("returns only a pre-auth transaction when password login requires MFA", async () => {
    mockLoginWithPassword.mockResolvedValue({
      kind: "mfa_required",
      transactionToken: "a".repeat(43),
      expiresAt: new Date("2026-09-01T12:05:00.000Z"),
      mfaRequired: true,
    });
    const result = await passwordLogin(
      jsonRequest("/api/public/partners/login-password", {
        email: "Partner@Example.test",
        password: "correct horse battery staple",
        rememberMe: true,
      }),
    );
    expect(result.status).toBe(202);
    const payload = (await result.json()) as Record<string, unknown>;
    expect(payload["status"]).toBe("mfa_required");
    expect(payload["transactionToken"]).toBe("a".repeat(43));
    expect(payload["sessionToken"]).toBeUndefined();
    expect(mockLoginWithPassword).toHaveBeenCalledWith(
      "partner@example.test",
      "correct horse battery staple",
      expect.any(NextRequest),
      expect.objectContaining({ rememberMe: true }),
    );
  });

  it("fails closed for a privileged identity without an enrolled method", async () => {
    mockLoginWithPassword.mockResolvedValue({
      kind: "mfa_enrollment_required",
      mfaRequired: true,
    });
    const result = await passwordLogin(
      jsonRequest("/api/public/partners/login-password", {
        email: "admin@example.test",
        password: "correct horse battery staple",
      }),
    );
    expect(result.status).toBe(409);
    expect(await result.json()).toEqual(
      expect.objectContaining({
        ok: false,
        error: "mfa_enrollment_required",
        recovery: "contact_support",
      }),
    );
  });

  it("rejects MFA completion before parsing the bearer when origin fails", async () => {
    mockOriginAllowed.mockReturnValue(false);
    const result = await completeMfa(
      jsonRequest(
        "/api/public/partners/login-password/mfa",
        { code: "123456" },
        "b".repeat(43),
      ),
    );
    expect(result.status).toBe(403);
    expect(mockCompletePartnerPasswordMfa).not.toHaveBeenCalled();
    expect(mockConsumeRateLimit).not.toHaveBeenCalled();
  });

  it("rate-limits completion by the transaction bearer", async () => {
    mockConsumeRateLimit.mockResolvedValue({
      limited: true,
      retryAfterSeconds: 45,
    });
    const result = await completeMfa(
      jsonRequest(
        "/api/public/partners/login-password/mfa",
        { code: "123456" },
        "c".repeat(43),
      ),
    );
    expect(result.status).toBe(429);
    expect(result.headers.get("Retry-After")).toBe("45");
    expect(mockCompletePartnerPasswordMfa).not.toHaveBeenCalled();
  });

  it("returns an AAL2 session only after successful completion", async () => {
    mockCompletePartnerPasswordMfa.mockResolvedValue({
      kind: "success",
      sessionToken: "d".repeat(43),
      expiresAt: new Date("2026-09-02T00:00:00.000Z"),
      recoveryCodeUsed: false,
    });
    const result = await completeMfa(
      jsonRequest(
        "/api/public/partners/login-password/mfa",
        { code: "123456" },
        "e".repeat(43),
      ),
    );
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual(
      expect.objectContaining({
        ok: true,
        status: "authenticated",
        assuranceLevel: "aal2",
        sessionToken: "d".repeat(43),
      }),
    );
    expect(mockCompletePartnerPasswordMfa).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionToken: "e".repeat(43),
        code: "123456",
      }),
    );
  });
});
