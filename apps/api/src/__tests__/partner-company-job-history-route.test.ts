import { NextRequest } from "next/server";

const jest = import.meta.jest;
const mockModule = jest.unstable_mockModule as unknown as (
  name: string,
  factory: () => Record<string, unknown>,
) => void;
const requirePermission = jest.fn<
  Promise<Response | null>,
  [NextRequest, string]
>();
const listReviews = jest.fn<Promise<unknown>, [URLSearchParams]>();
mockModule("@/lib/permissions", () => ({ requirePermission }));
mockModule("@/lib/partner-service-review-queue", () => ({
  listPartnerServiceReviews: listReviews,
}));
const { GET } = await import(
  "../../app/api/admin/partner-management/v1/service-requests/route"
);
const accountId = "11111111-1111-4111-8111-111111111111";
const request = () =>
  new NextRequest(
    `http://localhost/api/admin/partner-management/v1/service-requests?accountId=${accountId}&includeScheduled=true`,
  );

describe("staff company job history authorization", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    requirePermission.mockResolvedValue(null);
    listReviews.mockResolvedValue({
      ok: true,
      requests: [],
      page: { nextCursor: null },
    });
  });

  it.each(["partners.accounts.read", "appointments.read"])(
    "requires %s before querying jobs",
    async (missing) => {
      requirePermission.mockImplementation((_request, permission) =>
        Promise.resolve(
          permission === missing ? new Response(null, { status: 403 }) : null,
        ),
      );
      expect((await GET(request())).status).toBe(403);
      expect(listReviews).not.toHaveBeenCalled();
    },
  );

  it("passes explicit company and history filters and keeps the response private", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(requirePermission.mock.calls.map((call) => call[1])).toEqual([
      "partners.accounts.read",
      "appointments.read",
    ]);
    expect(listReviews.mock.calls[0]![0].get("accountId")).toBe(accountId);
    expect(listReviews.mock.calls[0]![0].get("includeScheduled")).toBe("true");
  });

  it("rejects invalid filters without claiming an empty job history", async () => {
    listReviews.mockResolvedValue(null);
    const response = await GET(request());
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      ok: false,
      error: "invalid_fields",
    });
  });
});
