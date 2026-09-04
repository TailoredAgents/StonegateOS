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

function authorizedPrincipal() {
  return {
    security: { mfaRequired: false },
    session: { assuranceLevel: "aal1", mfaVerifiedAt: null },
  };
}

describe("partner portal notification endpoint mutation authorization", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("accepts an AAL1 partner with explicit endpoint-management authority", async () => {
    const principal = authorizedPrincipal();
    mockRequirePartnerCapability.mockResolvedValue({ ok: true, principal });

    await expect(
      requirePartnerNotificationEndpointMutationAccess(request),
    ).resolves.toEqual({ ok: true, principal });
    expect(mockRequirePartnerCapability).toHaveBeenCalledWith(
      request,
      "account.security.manage",
    );
  });

  it("preserves a capability denial without opening the mutation", async () => {
    const denied = { ok: false, status: 403, error: "forbidden" } as const;
    mockRequirePartnerCapability.mockResolvedValue(denied);

    await expect(
      requirePartnerNotificationEndpointMutationAccess(request),
    ).resolves.toEqual(denied);
    expect(mockRequirePartnerCapability).toHaveBeenCalledWith(
      request,
      "account.security.manage",
    );
  });
});
