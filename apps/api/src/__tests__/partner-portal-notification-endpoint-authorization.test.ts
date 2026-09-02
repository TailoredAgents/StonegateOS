import { NextRequest } from "next/server";

const jest = import.meta.jest;
const mockModule = jest.unstable_mockModule as unknown as (
  moduleName: string,
  factory: () => Record<string, unknown>,
) => void;
const mockRequirePartnerCapability = jest.fn();

mockModule("@/lib/partner-account-authorization", () => ({
  requirePartnerCapability: mockRequirePartnerCapability,
}));

const { requirePartnerNotificationEndpointMutationAccess } = await import(
  "@/lib/partner-notification-endpoint-authorization"
);

const request = new NextRequest(
  "https://api.stonegate.example/api/portal/v2/notification-endpoints",
  { method: "POST" },
);

function privilegedPrincipal(input: {
  assuranceLevel: "aal1" | "aal2";
  mfaVerifiedAt: Date | null;
}) {
  return {
    security: { mfaRequired: true },
    session: input,
  };
}

describe("partner portal notification endpoint mutation authorization", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("denies an AAL1 privileged partner before endpoint mutation", async () => {
    mockRequirePartnerCapability.mockResolvedValue({
      ok: true,
      principal: privilegedPrincipal({
        assuranceLevel: "aal1",
        mfaVerifiedAt: null,
      }),
    });

    await expect(
      requirePartnerNotificationEndpointMutationAccess(request),
    ).resolves.toEqual({
      ok: false,
      status: 403,
      error: "mfa_step_up_required",
    });
    expect(mockRequirePartnerCapability).toHaveBeenCalledWith(
      request,
      "account.security.manage",
    );
  });

  it("accepts an explicitly authorized partner with recent AAL2", async () => {
    const principal = privilegedPrincipal({
      assuranceLevel: "aal2",
      mfaVerifiedAt: new Date(),
    });
    mockRequirePartnerCapability.mockResolvedValue({ ok: true, principal });

    await expect(
      requirePartnerNotificationEndpointMutationAccess(request),
    ).resolves.toEqual({ ok: true, principal });
    expect(mockRequirePartnerCapability).toHaveBeenCalledWith(
      request,
      "account.security.manage",
    );
  });

  it("denies stale AAL2 instead of treating a long-lived session as recent", async () => {
    mockRequirePartnerCapability.mockResolvedValue({
      ok: true,
      principal: privilegedPrincipal({
        assuranceLevel: "aal2",
        mfaVerifiedAt: new Date(Date.now() - 16 * 60 * 1_000),
      }),
    });

    await expect(
      requirePartnerNotificationEndpointMutationAccess(request),
    ).resolves.toEqual({
      ok: false,
      status: 403,
      error: "mfa_step_up_required",
    });
  });
});
