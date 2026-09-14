import { NextRequest } from "next/server";
import { PartnerAddressSuggestionsUnavailableError } from "@/lib/partner-address-suggestions";
const jest = import.meta.jest;
const mockModule = jest.unstable_mockModule as unknown as (
  name: string,
  factory: () => Record<string, unknown>,
) => void;
const authorization = jest.fn();
const rateLimit = jest.fn();
const provider = jest.fn();
const realProvider = await import("@/lib/partner-address-suggestions");
mockModule("@/lib/partner-account-authorization", () => ({
  requirePartnerCapability: authorization,
}));
mockModule("@/lib/team-auth-rate-limit", () => ({
  consumeTeamAuthRateLimit: rateLimit,
}));
mockModule("@/lib/partner-address-suggestions", () => ({
  ...realProvider,
  suggestPartnerAddresses: provider,
}));
const { POST } = await import(
  "../../app/api/portal/v2/address-suggestions/route"
);
const envKeys = [
  "NODE_ENV",
  "PARTNER_PORTAL_V2_READS_ENABLED",
  "PARTNER_PORTAL_V2_WRITES_ENABLED",
  "PARTNER_PORTAL_INTERNAL_TEST_MODE",
];
const prior = new Map(envKeys.map((key) => [key, process.env[key]]));
const principal = {
  accountId: "22222222-2222-4222-8222-222222222222",
  membershipId: "33333333-3333-4333-8333-333333333333",
  partnerUserId: "11111111-1111-4111-8111-111111111111",
  accessLevel: "account",
};
const request = (
  body: unknown = { query: "225 Baker St NW" },
  headers: Record<string, string> = {},
  search = "",
) =>
  new NextRequest(
    `http://localhost/api/portal/v2/address-suggestions${search}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-correlation-id": "address-test-correlation",
        ...headers,
      },
      body: JSON.stringify(body),
    },
  );

describe("authenticated partner address suggestions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env["NODE_ENV"] = "production";
    process.env["PARTNER_PORTAL_V2_READS_ENABLED"] = "true";
    process.env["PARTNER_PORTAL_V2_WRITES_ENABLED"] = "true";
    process.env["PARTNER_PORTAL_INTERNAL_TEST_MODE"] = "false";
    authorization.mockResolvedValue({ ok: true, principal });
    rateLimit.mockResolvedValue({ limited: false, retryAfterSeconds: 0 });
    provider.mockResolvedValue([]);
  });
  afterAll(() => {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("returns valid empty suggestions without caching and scopes rate limits to the authenticated user", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      suggestions: [],
      attribution: "© Mapbox",
      correlationId: "address-test-correlation",
    });
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(authorization).toHaveBeenCalledWith(
      expect.any(NextRequest),
      "properties.manage",
    );
    expect(rateLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "partner_address_suggestions",
        identity: { kind: "partner_user", value: principal.partnerUserId },
      }),
    );
    expect(provider).toHaveBeenCalledWith(
      "225 Baker St NW",
      expect.any(AbortSignal),
    );
  });

  it.each([401, 403])(
    "rejects authentication/capability status %s before calling the provider",
    async (status) => {
      authorization.mockResolvedValue({
        ok: false,
        status,
        error: status === 401 ? "unauthorized" : "forbidden",
      });
      expect((await POST(request())).status).toBe(status);
      expect(provider).not.toHaveBeenCalled();
      expect(rateLimit).not.toHaveBeenCalled();
    },
  );

  it("requires account-wide location-create authority and an active account membership", async () => {
    for (const restricted of [
      { ...principal, accessLevel: "scoped" },
      { ...principal, membershipId: null },
    ]) {
      authorization.mockResolvedValue({ ok: true, principal: restricted });
      expect((await POST(request())).status).toBe(
        restricted.membershipId ? 403 : 409,
      );
    }
    expect(provider).not.toHaveBeenCalled();
  });

  it.each([
    "PARTNER_PORTAL_V2_READS_ENABLED",
    "PARTNER_PORTAL_V2_WRITES_ENABLED",
  ])("honors disabled or missing production %s", async (key) => {
    for (const value of ["false", undefined]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
      expect((await POST(request())).status).toBe(503);
    }
    expect(provider).not.toHaveBeenCalled();
  });

  it("rejects cross-origin, unsupported, duplicate, and overlong input before provider work", async () => {
    expect(
      (await POST(request(undefined, { origin: "https://untrusted.example" })))
        .status,
    ).toBe(403);
    for (const body of [
      { query: "12" },
      { query: "x".repeat(201) },
      { query: "a; b" },
      { query: "225 Baker", limit: 99 },
      {},
    ])
      expect((await POST(request(body))).status).toBe(422);
    expect(
      (await POST(request({ query: "225 Baker" }, {}, "?q=disallowed"))).status,
    ).toBe(422);
    expect((await POST(request({ query: "x".repeat(3000) }))).status).toBe(413);
    const duplicate = new NextRequest(
      "http://localhost/api/portal/v2/address-suggestions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"query":"225 Baker","query":"another"}',
      },
    );
    expect((await POST(duplicate)).status).toBe(400);
    expect(provider).not.toHaveBeenCalled();
  });

  it("returns a retry time when rate limited without contacting Mapbox", async () => {
    rateLimit.mockResolvedValue({ limited: true, retryAfterSeconds: 27 });
    const response = await POST(request());
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("27");
    expect(provider).not.toHaveBeenCalled();
  });

  it("keeps provider failures separate from no matches and does not log provider content", async () => {
    const logger = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    try {
      provider.mockRejectedValue(
        new PartnerAddressSuggestionsUnavailableError("http_error", 429),
      );
      const response = await POST(request());
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: "service_unavailable",
      });
      expect(logger).toHaveBeenCalledWith(
        "[partner-portal-v2] address suggestions unavailable",
        {
          correlationId: "address-test-correlation",
          operation: "address_suggestions.read",
          reason: "http_error",
          providerStatus: 429,
        },
      );
    } finally {
      logger.mockRestore();
    }
  });

  it("catches auth/storage exceptions without logging address text or credentials", async () => {
    const logger = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      authorization.mockRejectedValue(
        new Error("secret credential and 225 Baker submitted address"),
      );
      expect((await POST(request())).status).toBe(500);
      expect(JSON.stringify(logger.mock.calls)).not.toContain("Baker");
      expect(JSON.stringify(logger.mock.calls)).not.toContain("secret");
    } finally {
      logger.mockRestore();
    }
  });
});
