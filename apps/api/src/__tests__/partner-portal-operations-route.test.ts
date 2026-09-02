import { NextRequest } from "next/server";

const jest = import.meta.jest;
const mockModule = jest.unstable_mockModule as unknown as (
  moduleName: string,
  factory: () => Record<string, unknown>,
) => void;

const mockRequirePermission = jest.fn<
  Promise<Response | null>,
  [NextRequest, string]
>();
const mockLoadReport = jest.fn<Promise<unknown>, [unknown]>();

mockModule("@/lib/permissions", () => ({
  requirePermission: mockRequirePermission,
}));
mockModule("@/lib/partner-portal-operations-reporting", () => ({
  PARTNER_OPERATIONS_RANGE_DAYS: [1, 7, 14, 30],
  loadPartnerPortalOperationsReport: mockLoadReport,
}));

const { GET } = await import(
  "../../app/api/admin/partner-management/v1/operations/route"
);

const CORRELATION_ID = "portal_operations_route_12345678";

function request(query = "rangeDays=7"): NextRequest {
  return new NextRequest(
    `https://api.stonegate.example/api/admin/partner-management/v1/operations?${query}`,
    { headers: { "x-correlation-id": CORRELATION_ID } },
  );
}

describe("Partner Portal operations route", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockRequirePermission.mockResolvedValue(null);
    mockLoadReport.mockResolvedValue({
      generatedAt: "2026-09-02T14:00:00.000Z",
      rangeDays: 7,
      stages: [],
      personas: [],
      rates: {},
    });
  });

  it("requires the granular account-read permission and returns no-store aggregates", async () => {
    const response = await GET(request());

    expect(mockRequirePermission).toHaveBeenCalledWith(
      expect.any(NextRequest),
      "partners.accounts.read",
    );
    expect(mockLoadReport).toHaveBeenCalledWith({ rangeDays: 7 });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    expect(response.headers.get("x-correlation-id")).toBe(CORRELATION_ID);
  });

  it.each([
    "rangeDays=365",
    "rangeDays=7&rangeDays=30",
    "rangeDays=7&accountId=private",
  ])("rejects unsupported or unbounded report query %s", async (query) => {
    const response = await GET(request(query));

    expect(response.status).toBe(422);
    expect(mockLoadReport).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "invalid_query",
      correlationId: CORRELATION_ID,
    });
  });

  it("fails closed with the same support reference when reporting storage is unavailable", async () => {
    const log = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mockLoadReport.mockRejectedValue(new Error("database unavailable"));

    try {
      const response = await GET(request("rangeDays=30"));

      expect(response.status).toBe(503);
      expect(response.headers.get("x-correlation-id")).toBe(CORRELATION_ID);
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        error: "partner_operations_unavailable",
        retryable: true,
        correlationId: CORRELATION_ID,
      });
      expect(log).toHaveBeenCalledWith(
        "[partner.portal.operations] report_failed",
        {
          correlationId: CORRELATION_ID,
          errorName: "Error",
        },
      );
    } finally {
      log.mockRestore();
    }
  });
});
