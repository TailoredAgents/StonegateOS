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
const mockListPartnerServiceCatalog = jest.fn<Promise<unknown>, [unknown]>();
const mockLoadPartnerAgreementPresentation = jest.fn<
  Promise<unknown>,
  [unknown]
>();
const mockReadsEnabled = jest.fn<boolean, [string]>();

mockModule("@/lib/partner-account-authorization", () => ({
  requirePartnerCapability: mockRequirePartnerCapability,
}));
mockModule("@/lib/partner-portal-feature-flags", () => ({
  arePartnerPortalV2ReadsEnabled: mockReadsEnabled,
}));
mockModule("@/lib/partner-portal-v2-service-catalog", () => ({
  listPartnerServiceCatalog: mockListPartnerServiceCatalog,
}));
mockModule("@/lib/partner-account-service-agreement-service", () => ({
  loadPartnerAgreementPresentation: mockLoadPartnerAgreementPresentation,
}));

const { GET } = await import("../../app/api/portal/v2/service-catalog/route");

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const CORRELATION_ID = "partner-service-catalog-route";

function request(): NextRequest {
  return new NextRequest("http://localhost/api/portal/v2/service-catalog", {
    headers: { "x-correlation-id": CORRELATION_ID },
  });
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

describe("partner portal V2 service catalog route", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockReadsEnabled.mockReturnValue(true);
    mockRequirePartnerCapability.mockResolvedValue({
      ok: true,
      principal: {
        accountId: ACCOUNT_ID,
        capabilities: ["bookings.create", "rates.read"],
      },
    });
    mockListPartnerServiceCatalog.mockResolvedValue([
      {
        key: "junk-removal",
        baseOptions: [{ tierKey: "half" }],
        addOns: [{ key: "mattress_disposal", minimumQuantity: 1 }],
      },
    ]);
    mockLoadPartnerAgreementPresentation.mockResolvedValue({
      label: "2026 commercial agreement",
      currency: "USD",
      active: true,
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      effectiveTo: null,
      inclusions: [],
      exclusions: [],
      quoteRules: null,
      services: [],
      document: null,
      revision: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("loads exactly the selected account and reveals prices only with rates.read", async () => {
    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mockRequirePartnerCapability).toHaveBeenCalledWith(
      expect.anything(),
      "portal.session.read",
    );
    expect(mockListPartnerServiceCatalog).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID,
      revealPrices: true,
    });
    expect(mockLoadPartnerAgreementPresentation).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID,
    });
    const body: unknown = await response.json();
    const payload = record(body);
    const services = Array.isArray(payload?.["services"])
      ? payload["services"]
      : [];
    const service = record(services[0]);
    const addOns = Array.isArray(service?.["addOns"]) ? service["addOns"] : [];
    const agreement = record(payload?.["agreement"]);
    expect(payload?.["ok"]).toBe(true);
    expect(service?.["key"]).toBe("junk-removal");
    expect(record(addOns[0])?.["key"]).toBe("mattress_disposal");
    expect(agreement?.["label"]).toBe("2026 commercial agreement");
    expect(agreement?.["currency"]).toBe("USD");
  });

  it("keeps the same account-scoped choices but hides negotiated prices for limited users", async () => {
    mockRequirePartnerCapability.mockResolvedValue({
      ok: true,
      principal: {
        accountId: ACCOUNT_ID,
        capabilities: ["bookings.create"],
      },
    });

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(mockListPartnerServiceCatalog).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID,
      revealPrices: false,
    });
  });

  it("allows a rates-only account member to read the selected account catalog", async () => {
    mockRequirePartnerCapability.mockResolvedValue({
      ok: true,
      principal: {
        accountId: ACCOUNT_ID,
        capabilities: ["rates.read"],
      },
    });

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(mockListPartnerServiceCatalog).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID,
      revealPrices: true,
    });
  });

  it("rejects an authenticated member without scheduling or rate access", async () => {
    mockRequirePartnerCapability.mockResolvedValue({
      ok: true,
      principal: {
        accountId: ACCOUNT_ID,
        capabilities: ["portal.session.read"],
      },
    });

    const response = await GET(request());

    expect(response.status).toBe(403);
    expect(mockListPartnerServiceCatalog).not.toHaveBeenCalled();
  });

  it("returns tenant-safe authorization failure without loading catalog data", async () => {
    mockRequirePartnerCapability.mockResolvedValue({
      ok: false,
      status: 404,
      error: "not_found",
    });

    const response = await GET(request());

    expect(response.status).toBe(404);
    expect(mockListPartnerServiceCatalog).not.toHaveBeenCalled();
  });
});
