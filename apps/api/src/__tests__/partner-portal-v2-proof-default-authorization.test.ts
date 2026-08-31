import { NextRequest } from "next/server";

const jest = import.meta.jest;
const mockModule = jest.unstable_mockModule as unknown as (
  moduleName: string,
  factory: () => Record<string, unknown>,
) => void;

const mockRequirePartnerCapability = jest.fn<
  Promise<unknown>,
  [unknown, string]
>();

mockModule("@/lib/partner-account-authorization", () => ({
  requirePartnerCapability: mockRequirePartnerCapability,
}));
mockModule("@/lib/partner-portal-feature-flags", () => ({
  arePartnerPortalV2ReadsEnabled: () => true,
  arePartnerPortalV2WritesEnabled: () => true,
}));
mockModule("@/lib/partner-portal-v2-security", () => ({
  isAllowedPartnerPortalMutationOrigin: () => true,
}));

const { PATCH: updateAccountProofDefaults } = await import(
  "../../app/api/portal/v2/proof-requirements/route"
);

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const MEMBERSHIP_ID = "22222222-2222-4222-8222-222222222222";
const CORRELATION_ID = "proof-default-authorization-test";

describe("partner V2 account proof-default authorization", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockRequirePartnerCapability.mockResolvedValue({
      ok: true,
      principal: {
        accountId: ACCOUNT_ID,
        membershipId: MEMBERSHIP_ID,
        accessLevel: "scoped",
      },
    });
  });

  it("rejects scoped account-default mutations before parsing the body", async () => {
    const request = new NextRequest(
      "http://localhost/api/portal/v2/proof-requirements",
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-correlation-id": CORRELATION_ID,
        },
        body: "not-json",
      },
    );

    const response = await updateAccountProofDefaults(request);

    expect(mockRequirePartnerCapability).toHaveBeenCalledWith(
      request,
      "account.update",
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        error: "forbidden",
        correlationId: CORRELATION_ID,
      }),
    );
  });
});
