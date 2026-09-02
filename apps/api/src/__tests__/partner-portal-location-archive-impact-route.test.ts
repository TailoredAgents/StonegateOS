import { NextRequest } from "next/server";

const jest = import.meta.jest;
const mockModule = jest.unstable_mockModule as unknown as (
  moduleName: string,
  factory: () => Record<string, unknown>,
) => void;

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const LOCATION_ID = "22222222-2222-4222-8222-222222222222";
const mockRequireCapability = jest.fn();
const mockArchiveImpact = jest.fn();
const mockLockDirectory = jest.fn();
const mockTransaction = jest.fn();

mockModule("@/db", () => ({
  getDb: () => ({ transaction: mockTransaction }),
  partnerAccountLocations: {},
}));
mockModule("@/lib/partner-account-authorization", () => ({
  requirePartnerCapability: mockRequireCapability,
}));
mockModule("@/lib/partner-portal-feature-flags", () => ({
  arePartnerPortalV2ReadsEnabled: () => true,
}));
mockModule("@/lib/partner-location-portfolio", () => ({
  getPartnerLocationArchiveImpact: mockArchiveImpact,
  lockPartnerLocationDirectory: mockLockDirectory,
  partnerLocationDirectoryEtag: () => '"directory-etag"',
}));
mockModule("@/lib/partner-portal-v2-locations", () => ({
  partnerLocationEtag: () => '"location-etag"',
}));
mockModule("@/lib/partner-portal-v2-resource-authorization", () => ({
  createPartnerLocationAccessCondition: () => ({ scope: "account-location" }),
}));
mockModule("@/lib/partner-portal-v2-security", () => ({
  isPortalV2Uuid: () => true,
}));

const archiveImpactRoute = await import(
  "../../app/api/portal/v2/locations/[locationId]/archive-impact/route"
);

describe("Partner location archive impact route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireCapability.mockResolvedValue({
      ok: true,
      principal: {
        accountId: ACCOUNT_ID,
        membershipId: "33333333-3333-4333-8333-333333333333",
      },
    });
    mockLockDirectory.mockResolvedValue({
      defaultLocationId: LOCATION_ID,
      version: 4,
    });
    mockArchiveImpact.mockResolvedValue({
      isDefault: true,
      activeChildCount: 0,
      activeAlternativeCount: 1,
      openDraftCount: 0,
      activeTemplateCount: 0,
      jobHistoryCount: 2,
      canonicalQuoteV2Count: 2,
      issuedActionableQuoteV2Count: 1,
    });
    mockTransaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          select: () => ({
            from: () => ({
              where: () => ({
                limit: () =>
                  Promise.resolve([
                    {
                      id: LOCATION_ID,
                      partnerAccountId: ACCOUNT_ID,
                      active: true,
                      version: 1,
                      updatedAt: new Date("2026-09-01T12:00:00.000Z"),
                    },
                  ]),
              }),
            }),
          }),
        }),
    );
  });

  it("returns canonical and issued-actionable Quote V2 impact evidence", async () => {
    const request = new NextRequest(
      `https://api.test/api/portal/v2/locations/${LOCATION_ID}/archive-impact`,
    );
    const response = await archiveImpactRoute.GET(request, {
      params: Promise.resolve({ locationId: LOCATION_ID }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      impact: {
        canonicalQuoteV2Count: 2,
        issuedActionableQuoteV2Count: 1,
      },
    });
    expect(mockArchiveImpact).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ accountId: ACCOUNT_ID }),
    );
    expect(response.headers.get("etag")).toBe('"location-etag"');
  });
});
