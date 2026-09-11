import type { NextRequest } from "next/server";

const mockGetDb = jest.fn();
const mockRequirePermission = jest.fn();
const mockGetSettings = jest.fn();
const mockGetManagement = jest.fn();
const mockGetLegacyCrewRules = jest.fn();
const mockRecalculate = jest.fn();
const mockRecordAudit = jest.fn();
const mockIsAdmin = jest.fn();
const mockCommissionSettings = { key: "commission_settings.key" };

jest.mock("@/db", () => ({
  commissionSettings: mockCommissionSettings,
  getDb: mockGetDb,
}));
jest.mock("@/lib/permissions", () => ({
  requirePermission: mockRequirePermission,
}));
jest.mock("@/lib/audit", () => ({
  getAuditActorFromRequest: () => ({ id: null }),
  recordAuditEvent: mockRecordAudit,
}));
jest.mock("@/lib/commissions", () => ({
  getOrCreateCommissionSettings: mockGetSettings,
  getCommissionManagementConfigurationStatus: mockGetManagement,
  getCommissionCrewSplitConfigurationStatus: mockGetLegacyCrewRules,
  recalculateCurrentPayoutPeriodAppointments: mockRecalculate,
}));
jest.mock("../../app/api/web/admin", () => ({
  isAdminRequest: mockIsAdmin,
}));

import { GET, PUT } from "../../app/api/admin/commissions/settings/route";

const effectiveSettings = {
  key: "default",
  timezone: "America/New_York",
  payoutWeekday: 5,
  payoutHour: 18,
  payoutMinute: 0,
  salesRateBps: 0,
  marketingRateBps: 500,
  crewPoolRateBps: 2000,
  marketingMemberId: null,
};
const policy = {
  kind: "crew_count",
  split: "equal",
  tiers: [
    { minimumCrewSize: 1, maximumCrewSize: 2, poolRateBps: 2000 },
    { minimumCrewSize: 3, maximumCrewSize: null, poolRateBps: 3000 },
  ],
  moving: "hourly",
};

function request(body?: object): NextRequest {
  return new Request("https://api.test/api/admin/commissions/settings", {
    method: body ? "PUT" : "GET",
    ...(body
      ? {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        }
      : {}),
  }) as NextRequest;
}

describe("dynamic labor payroll settings", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsAdmin.mockReturnValue(true);
    mockRequirePermission.mockResolvedValue(null);
    mockGetSettings.mockResolvedValue(effectiveSettings);
    mockGetManagement.mockResolvedValue({
      ready: true,
      totalSplitBps: 500,
      recipients: [],
    });
    // Retired configuration must not prevent the current policy from loading.
    mockGetLegacyCrewRules.mockRejectedValue(
      new Error("retired_configuration_unavailable"),
    );
    mockRecalculate.mockResolvedValue(undefined);
    mockRecordAudit.mockResolvedValue(undefined);
  });

  it("returns the full count-based policy without depending on retired named splits", async () => {
    mockGetDb.mockReturnValue({});
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      settings: {
        crewPoolPolicy: policy,
        crewSplitRulesReady: true,
        crewSplitRules: [],
        managementReady: true,
        marketingRateBps: 500,
      },
    });
    expect(mockGetLegacyCrewRules).not.toHaveBeenCalled();
  });

  it("preserves dynamic labor and dated management when payout schedule is saved", async () => {
    const onConflictDoUpdate = jest.fn().mockResolvedValue(undefined);
    const values = jest.fn(() => ({ onConflictDoUpdate }));
    const db = { insert: jest.fn(() => ({ values })) };
    mockGetDb.mockReturnValue(db);
    const response = await PUT(
      request({
        ...effectiveSettings,
        payoutHour: 17,
        crewPoolRateBps: 9000,
        marketingRateBps: 9000,
        salesRateBps: 9000,
      }),
    );
    expect(response.status).toBe(200);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        payoutHour: 17,
        crewPoolRateBps: 2000,
        marketingRateBps: 1700,
        salesRateBps: 0,
      }),
    );
    expect(await response.json()).toMatchObject({
      settings: { crewPoolPolicy: policy, marketingRateBps: 500 },
    });
    expect(mockRecalculate).toHaveBeenCalledWith(db);
    const expectedMeta: unknown = expect.objectContaining({
      crewPoolPolicy: policy,
    });
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expectedMeta,
      }),
    );
  });

  it("checks payroll permissions before opening the database", async () => {
    mockRequirePermission.mockResolvedValue(
      Response.json({ error: "forbidden" }, { status: 403 }),
    );
    expect((await GET(request())).status).toBe(403);
    expect((await PUT(request(effectiveSettings))).status).toBe(403);
    expect(mockGetDb).not.toHaveBeenCalled();
  });
});
