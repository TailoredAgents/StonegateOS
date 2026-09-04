import { NextRequest } from "next/server";

const jest = import.meta.jest;
const mockModule = jest.unstable_mockModule as unknown as (
  moduleName: string,
  factory: () => Record<string, unknown>,
) => void;

const mockConsumeEmailVerification = jest.fn();
const mockInspectActivation = jest.fn();
const mockRequireApplicantSession = jest.fn();
const mockGetApplication = jest.fn();
const mockConsumeRateLimit = jest.fn();

mockModule("@/lib/partner-purpose-auth", () => ({
  consumePartnerEmailVerification: mockConsumeEmailVerification,
  inspectPartnerActivationToken: mockInspectActivation,
  requirePartnerApplicantSession: mockRequireApplicantSession,
}));
mockModule("@/lib/partner-verification-onboarding", () => ({
  getPartnerApplicantApplication: mockGetApplication,
  parsePartnerApplicationDraftPatch: jest.fn(),
  savePartnerApplicantDraft: jest.fn(),
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

const { POST: consumeEmailChallenge } = await import(
  "../../app/api/portal/v2/onboarding/email-challenges/consume/route"
);
const { GET: getApplication } = await import(
  "../../app/api/portal/v2/onboarding/application/route"
);
const { POST: inspectActivation } = await import(
  "../../app/api/portal/v2/onboarding/activation/inspect/route"
);

const TOKEN = "a".repeat(43);
const PRINCIPAL = {
  sessionId: "11111111-1111-4111-8111-111111111111",
  verificationChallengeId: "22222222-2222-4222-8222-222222222222",
  normalizedEmail: "partner@verified.example",
  applicationId: null,
  draftPayload: {},
  draftVersion: 1,
  expiresAt: new Date("2026-09-02T00:00:00.000Z"),
  updatedAt: new Date("2026-09-01T00:00:00.000Z"),
};

describe("partner verification-first onboarding routes", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockConsumeRateLimit.mockResolvedValue({
      limited: false,
      retryAfterSeconds: 0,
    });
  });

  it("exchanges a one-use email challenge for an applicant bearer session", async () => {
    mockConsumeEmailVerification.mockResolvedValue({
      kind: "success",
      sessionToken: "applicant-session-secret",
      sessionId: PRINCIPAL.sessionId,
      email: PRINCIPAL.normalizedEmail,
      expiresAt: PRINCIPAL.expiresAt,
    });
    const response = await consumeEmailChallenge(
      new NextRequest(
        "https://api.stonegate.example/api/portal/v2/onboarding/email-challenges/consume",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: TOKEN }),
        },
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        sessionToken: "applicant-session-secret",
        email: PRINCIPAL.normalizedEmail,
      }),
    );
  });

  it("requires the applicant bearer principal to read the draft", async () => {
    mockRequireApplicantSession.mockResolvedValue({
      ok: false,
      status: 401,
      error: "unauthorized",
    });
    const denied = await getApplication(
      new NextRequest(
        "https://api.stonegate.example/api/portal/v2/onboarding/application",
      ),
    );
    expect(denied.status).toBe(401);
    expect(mockGetApplication).not.toHaveBeenCalled();

    mockRequireApplicantSession.mockResolvedValue({
      ok: true,
      principal: PRINCIPAL,
    });
    mockGetApplication.mockResolvedValue({
      application: {
        id: PRINCIPAL.sessionId,
        status: "draft",
        email: PRINCIPAL.normalizedEmail,
      },
      requirements: { termsVersion: "partner-terms-v1" },
      etag: '"draft-etag"',
    });
    const allowed = await getApplication(
      new NextRequest(
        "https://api.stonegate.example/api/portal/v2/onboarding/application",
        { headers: { authorization: "Bearer applicant-session-secret" } },
      ),
    );
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("etag")).toBe('"draft-etag"');
    expect(mockGetApplication).toHaveBeenCalledWith(PRINCIPAL);
  });

  it("exposes whether activation must verify an existing password without an MFA gate", async () => {
    mockInspectActivation.mockResolvedValue({
      kind: "success",
      email: PRINCIPAL.normalizedEmail,
      name: "Pat Partner",
      accountName: "Verified Property Group",
      passwordAlreadySet: true,
      expiresAt: PRINCIPAL.expiresAt,
    });
    const response = await inspectActivation(
      new NextRequest(
        "https://api.stonegate.example/api/portal/v2/onboarding/activation/inspect",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: TOKEN }),
        },
      ),
    );
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toEqual(
      expect.objectContaining({
        activation: {
          email: PRINCIPAL.normalizedEmail,
          name: "Pat Partner",
          accountName: "Verified Property Group",
          passwordAlreadySet: true,
          expiresAt: PRINCIPAL.expiresAt.toISOString(),
        },
      }),
    );
    expect(JSON.stringify(body)).not.toContain("mfaRequired");
  });
});
