import { NextRequest } from "next/server";

const jest = import.meta.jest;
const mockModule = jest.unstable_mockModule as unknown as (
  moduleName: string,
  factory: () => Record<string, unknown>,
) => void;

const mockRequireCapability = jest.fn();
const mockReadBody = jest.fn();

mockModule("@/lib/partner-account-authorization", () => ({
  requirePartnerCapability: mockRequireCapability,
}));
mockModule("@/lib/bounded-json-request", () => ({
  BoundedJsonRequestError: class BoundedJsonRequestError extends Error {
    readonly status = 400;
  },
  readBoundedJsonRequest: mockReadBody,
}));

const dryRunRoute = await import(
  "../../app/api/portal/v2/locations/imports/dry-run/route"
);

describe("Partner location portfolio route boundary", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("denies an unauthorized dry-run before reading CSV or account state", async () => {
    mockRequireCapability.mockResolvedValue({
      ok: false,
      error: "forbidden",
      status: 403,
    });
    const request = new NextRequest(
      "https://api.test/api/portal/v2/locations/imports/dry-run",
      {
        method: "POST",
        headers: { Origin: "https://api.test" },
        body: JSON.stringify({ csv: "not read" }),
      },
    );
    const response = await dryRunRoute.POST(request);

    expect(response.status).toBe(403);
    expect(mockRequireCapability).toHaveBeenCalledWith(
      request,
      "properties.manage",
    );
    expect(mockReadBody).not.toHaveBeenCalled();
  });

  it("rejects a cross-site dry-run before resolving authorization", async () => {
    const request = new NextRequest(
      "https://api.test/api/portal/v2/locations/imports/dry-run",
      {
        method: "POST",
        headers: { Origin: "https://attacker.test" },
        body: JSON.stringify({ csv: "not read" }),
      },
    );
    const response = await dryRunRoute.POST(request);

    expect(response.status).toBe(403);
    expect(mockRequireCapability).not.toHaveBeenCalled();
    expect(mockReadBody).not.toHaveBeenCalled();
  });
});
