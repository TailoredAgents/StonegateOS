import { NextRequest } from "next/server";

const jest = import.meta.jest;
const mockModule = jest.unstable_mockModule as unknown as (
  moduleName: string,
  factory: () => Record<string, unknown>,
) => void;

const mockRequirePartnerCapability = jest.fn();
const mockChangePartnerPassword = jest.fn();
const mockConsumeRateLimit = jest.fn();

mockModule("@/lib/partner-account-authorization", () => ({
  requirePartnerCapability: mockRequirePartnerCapability,
}));
mockModule("@/lib/partner-password-management", () => ({
  PARTNER_PASSWORD_MIN_LENGTH: 15,
  PARTNER_PASSWORD_MAX_LENGTH: 128,
  changePartnerPassword: mockChangePartnerPassword,
}));
mockModule("@/lib/partner-portal-feature-flags", () => ({
  arePartnerPortalV2WritesEnabled: () => true,
  isPartnerRoutineMagicLinkLoginEnabled: () => false,
}));
mockModule("@/lib/team-auth-rate-limit", () => ({
  consumeTeamAuthRateLimit: mockConsumeRateLimit,
}));

const { POST } = await import(
  "../../app/api/portal/v2/security/password/route"
);

const CORRELATION_ID = "partner-password-route-test-0001";
const principal = {
  partnerUserId: "11111111-1111-4111-8111-111111111111",
  email: "partner@example.com",
  roleKey: "scheduler",
  accountId: "22222222-2222-4222-8222-222222222222",
  membershipId: "33333333-3333-4333-8333-333333333333",
  session: { id: "44444444-4444-4444-8444-444444444444" },
};

function request(body: unknown): NextRequest {
  return new NextRequest(
    "https://api.stonegate.example/api/portal/v2/security/password",
    {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        origin: "https://api.stonegate.example",
        "x-correlation-id": CORRELATION_ID,
      },
      body: JSON.stringify(body),
    },
  );
}

describe("partner V2 password route", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockRequirePartnerCapability.mockResolvedValue({ ok: true, principal });
    mockConsumeRateLimit.mockResolvedValue({
      limited: false,
      retryAfterSeconds: 0,
    });
  });

  it("changes the credential without returning credential material", async () => {
    mockChangePartnerPassword.mockResolvedValue({
      kind: "success",
      passwordPreviouslySet: true,
      otherSessionsRevoked: 2,
      changedAt: new Date("2026-08-30T16:00:00.000Z"),
    });
    const response = await POST(
      request({
        currentPassword: "old-secure-password",
        newPassword: "new-secure-password",
        confirmPassword: "new-secure-password",
      }),
    );
    expect(response.status).toBe(200);
    expect(mockChangePartnerPassword).toHaveBeenCalledWith(
      expect.objectContaining({
        currentPassword: "old-secure-password",
        newPassword: "new-secure-password",
      }),
    );
    const body: unknown = await response.json();
    expect(body).toEqual(
      expect.objectContaining({
        ok: true,
        passwordSet: true,
        otherSessionsRevoked: 2,
      }),
    );
    expect(JSON.stringify(body)).not.toContain("new-secure-password");
  });

  it("rejects a mismatched confirmation before mutation", async () => {
    const response = await POST(
      request({
        newPassword: "new-secure-password",
        confirmPassword: "different-secure-password",
      }),
    );
    expect(response.status).toBe(422);
    expect(mockChangePartnerPassword).not.toHaveBeenCalled();
    const body: unknown = await response.json();
    expect(body).toEqual(
      expect.objectContaining({
        error: "invalid_fields",
        fieldErrors: {
          confirmPassword: "Enter the same new password again.",
        },
      }),
    );
  });

  it("returns a field-safe current-password failure", async () => {
    mockChangePartnerPassword.mockResolvedValue({
      kind: "invalid_current_password",
    });
    const response = await POST(
      request({
        currentPassword: "wrong-secure-password",
        newPassword: "new-secure-password",
        confirmPassword: "new-secure-password",
      }),
    );
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        error: "invalid_fields",
        fieldErrors: { currentPassword: "The current password is incorrect." },
      }),
    );
  });

  it("requires recent authentication for first-time setup", async () => {
    mockChangePartnerPassword.mockResolvedValue({
      kind: "recent_authentication_required",
    });
    const response = await POST(
      request({
        newPassword: "new-secure-password",
        confirmPassword: "new-secure-password",
      }),
    );
    expect(response.status).toBe(403);
    const body: unknown = await response.json();
    expect(body).toEqual(
      expect.objectContaining({ error: "mfa_step_up_required" }),
    );
    expect(body).toEqual(
      expect.objectContaining({
        alternatives: [
          expect.objectContaining({
            action: "reauthenticate",
            label: "Sign in again with your password",
          }),
        ],
      }),
    );
  });

  it("rate-limits before reading or changing credentials", async () => {
    mockConsumeRateLimit.mockResolvedValue({
      limited: true,
      retryAfterSeconds: 120,
    });
    const response = await POST(
      request({
        newPassword: "new-secure-password",
        confirmPassword: "new-secure-password",
      }),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("120");
    expect(mockChangePartnerPassword).not.toHaveBeenCalled();
  });
});
