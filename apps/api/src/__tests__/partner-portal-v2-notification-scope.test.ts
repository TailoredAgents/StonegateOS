import { NextRequest } from "next/server";
import { encodePortalV2Cursor } from "@/lib/portal-v2-contract";

const jest = import.meta.jest;
const mockModule = jest.unstable_mockModule as unknown as (
  moduleName: string,
  factory: () => Record<string, unknown>,
) => void;
const mockRequirePartnerCapability = jest.fn();

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const MEMBERSHIP_ID = "22222222-2222-4222-8222-222222222222";
const NOTIFICATION_ID = "33333333-3333-4333-8333-333333333333";
const LOCATION_ID = "44444444-4444-4444-8444-444444444444";
const JOB_ID = "55555555-5555-4555-8555-555555555555";
const CORRELATION_ID = "notification-scope-cursor-test";

mockModule("@/lib/partner-account-authorization", () => ({
  requirePartnerCapability: mockRequirePartnerCapability,
}));
mockModule("@/lib/partner-portal-feature-flags", () => ({
  arePartnerPortalV2ReadsEnabled: () => true,
}));

const { GET: listNotifications } = await import(
  "../../app/api/portal/v2/notifications/route"
);

describe("partner notification scope-bound pagination", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockRequirePartnerCapability.mockResolvedValue({
      ok: true,
      principal: {
        accountId: ACCOUNT_ID,
        membershipId: MEMBERSHIP_ID,
        accessLevel: "scoped",
        accessScope: { locationIds: [LOCATION_ID], propertyIds: [] },
      },
    });
  });

  it("rejects a cursor issued for an older location/property scope", async () => {
    const cursor = encodePortalV2Cursor({
      kind: "partner_notifications",
      limit: 25,
      payload: {
        accessScopeKey: `scoped:${"A".repeat(43)}`,
        accountId: ACCOUNT_ID,
        jobId: null,
        membershipId: MEMBERSHIP_ID,
        state: "all",
        createdAt: "2026-08-31T12:00:00.000Z",
        id: NOTIFICATION_ID,
      },
    });
    const response = await listNotifications(
      new NextRequest(
        `http://localhost/api/portal/v2/notifications?state=all&cursor=${encodeURIComponent(cursor)}`,
        { headers: { "x-correlation-id": CORRELATION_ID } },
      ),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        error: "invalid_cursor",
        correlationId: CORRELATION_ID,
      }),
    );
  });

  it("binds pagination cursors to the selected opaque job", async () => {
    const cursor = encodePortalV2Cursor({
      kind: "partner_notifications",
      limit: 25,
      payload: {
        accessScopeKey: `scoped:${"A".repeat(43)}`,
        accountId: ACCOUNT_ID,
        jobId: JOB_ID,
        membershipId: MEMBERSHIP_ID,
        state: "all",
        createdAt: "2026-08-31T12:00:00.000Z",
        id: NOTIFICATION_ID,
      },
    });
    const response = await listNotifications(
      new NextRequest(
        `http://localhost/api/portal/v2/notifications?state=all&cursor=${encodeURIComponent(cursor)}`,
        { headers: { "x-correlation-id": CORRELATION_ID } },
      ),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        error: "invalid_cursor",
        correlationId: CORRELATION_ID,
      }),
    );
  });
});
