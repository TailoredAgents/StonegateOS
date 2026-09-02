import type { NextRequest } from "next/server";

const jest = import.meta.jest;
const mockModule = jest.unstable_mockModule as unknown as (
  moduleName: string,
  factory: () => Record<string, unknown>,
) => void;

const mockIsAdminRequest = jest.fn<boolean, [NextRequest]>();
const mockRequirePermission = jest.fn<
  Promise<Response | null>,
  [NextRequest]
>();
const mockRequireTeamSession = jest.fn();

mockModule("../../app/api/web/admin", () => ({
  isAdminRequest: mockIsAdminRequest,
}));
mockModule("@/lib/permissions", () => ({
  requirePermission: mockRequirePermission,
}));
mockModule("@/lib/team-auth", () => ({
  requireTeamSession: mockRequireTeamSession,
}));
mockModule("@/lib/team-auth-rate-limit", () => ({
  consumeTeamAuthRateLimit: jest.fn(),
}));

const { resolveTeamMfaActor } = await import("@/lib/team-mfa-route");

function request(): NextRequest {
  return {
    headers: new Headers({
      authorization: "Bearer verified-session",
      "x-api-key": "internal-key",
      "x-actor-id": "spoofed-member",
      "x-actor-role": "owner",
    }),
  } as NextRequest;
}

describe("Team MFA route authentication", () => {
  beforeEach(() => {
    mockIsAdminRequest.mockReset().mockReturnValue(true);
    mockRequirePermission.mockReset().mockResolvedValue(null);
    mockRequireTeamSession.mockReset().mockResolvedValue({
      ok: true,
      sessionId: "11111111-1111-4111-8111-111111111111",
      authMethod: "team_session",
      assuranceLevel: "aal1",
      mfaVerifiedAt: null,
      teamMember: {
        id: "22222222-2222-4222-8222-222222222222",
        name: "Verified Team User",
        email: "verified@example.test",
        roleSlug: "office",
        passwordSet: true,
        permissions: ["sessions.manage_self"],
      },
    });
  });

  it("requires both the private API credential and self-session permission", async () => {
    mockIsAdminRequest.mockReturnValue(false);
    const missingPrivateCredential = await resolveTeamMfaActor(request());
    expect(missingPrivateCredential.ok).toBe(false);
    if (!missingPrivateCredential.ok) {
      expect(missingPrivateCredential.response.status).toBe(401);
    }
    expect(mockRequirePermission).not.toHaveBeenCalled();

    mockIsAdminRequest.mockReturnValue(true);
    mockRequirePermission.mockResolvedValue(
      Response.json({ error: "forbidden" }, { status: 403 }),
    );
    const missingPermission = await resolveTeamMfaActor(request());
    expect(missingPermission.ok).toBe(false);
    if (!missingPermission.ok)
      expect(missingPermission.response.status).toBe(403);
  });

  it("derives the actor only from the persisted session", async () => {
    const result = await resolveTeamMfaActor(request());
    expect(result).toEqual({
      ok: true,
      authMethod: "team_session",
      actor: {
        teamMemberId: "22222222-2222-4222-8222-222222222222",
        email: "verified@example.test",
        roleSlug: "office",
        sessionId: "11111111-1111-4111-8111-111111111111",
        correlationId: expect.any(String) as unknown,
      },
    });
  });

  it("does not allow break-glass to configure or step up MFA", async () => {
    mockRequireTeamSession.mockResolvedValue({
      ok: true,
      sessionId: "11111111-1111-4111-8111-111111111111",
      authMethod: "break_glass",
      assuranceLevel: "aal1",
      mfaVerifiedAt: null,
      teamMember: {
        id: "22222222-2222-4222-8222-222222222222",
        name: "Recovery Owner",
        email: "owner@example.test",
        roleSlug: "owner",
        passwordSet: true,
        permissions: ["sessions.manage_self"],
      },
    });
    const denied = await resolveTeamMfaActor(request());
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.response.status).toBe(403);
      await expect(denied.response.json()).resolves.toEqual(
        expect.objectContaining({ code: "break_glass_not_allowed" }),
      );
    }

    const readOnlyStatus = await resolveTeamMfaActor(request(), {
      allowBreakGlass: true,
      requireEmail: false,
    });
    expect(readOnlyStatus.ok).toBe(true);
  });
});
