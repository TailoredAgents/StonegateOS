import {
  DEFAULT_GOOGLE_ADS_API_BASE_URL,
  DEFAULT_GOOGLE_ADS_TOKEN_URL,
  getGoogleAdsProviderEndpoints,
  resolveGoogleAdsApiEndpoint,
  resolveGoogleAdsTokenEndpoint,
} from "@myst-os/sdk";
import { getGoogleAdsConfiguredIds } from "@/lib/google-ads-insights";

const loopbackEnvironment = {
  E2E_RUN_ID: "google-ads-audit",
  GOOGLE_ADS_API_BASE_URL: "http://127.0.0.1:4014",
  GOOGLE_ADS_TOKEN_URL: "http://127.0.0.1:4014/token",
};

describe("Google Ads provider endpoint safety", () => {
  it("defaults production calls to the current non-sunset v25 endpoint", () => {
    const previous = process.env["GOOGLE_ADS_API_VERSION"];
    delete process.env["GOOGLE_ADS_API_VERSION"];
    try {
      expect(getGoogleAdsConfiguredIds().apiVersion).toBe("v25");
    } finally {
      if (previous === undefined) delete process.env["GOOGLE_ADS_API_VERSION"];
      else process.env["GOOGLE_ADS_API_VERSION"] = previous;
    }
  });

  it("preserves the official HTTPS endpoints as normal production defaults", () => {
    const endpoints = getGoogleAdsProviderEndpoints({});
    expect(endpoints.apiBaseUrl.toString()).toBe(
      new URL(DEFAULT_GOOGLE_ADS_API_BASE_URL).toString(),
    );
    expect(endpoints.tokenUrl.toString()).toBe(DEFAULT_GOOGLE_ADS_TOKEN_URL);
    expect(
      resolveGoogleAdsApiEndpoint(
        { kind: "accessible_customers", apiVersion: "v25" },
        { NODE_ENV: "production" },
      ),
    ).toBe(
      "https://googleads.googleapis.com/v25/customers:listAccessibleCustomers",
    );
    expect(resolveGoogleAdsTokenEndpoint({ NODE_ENV: "production" })).toBe(
      "https://oauth2.googleapis.com/token",
    );
  });

  it("resolves every active API operation through one typed base", () => {
    expect(
      resolveGoogleAdsApiEndpoint(
        { kind: "accessible_customers", apiVersion: "v25" },
        loopbackEnvironment,
      ),
    ).toBe("http://127.0.0.1:4014/v25/customers:listAccessibleCustomers");
    expect(
      resolveGoogleAdsApiEndpoint(
        {
          kind: "search_stream",
          apiVersion: "v25",
          customerId: "123-456-7890",
        },
        loopbackEnvironment,
      ),
    ).toBe(
      "http://127.0.0.1:4014/v25/customers/1234567890/googleAds:searchStream",
    );
    expect(
      resolveGoogleAdsApiEndpoint(
        {
          kind: "mutate_customer_negative_criteria",
          apiVersion: "v25",
          customerId: "1234567890",
        },
        loopbackEnvironment,
      ),
    ).toBe(
      "http://127.0.0.1:4014/v25/customers/1234567890/customerNegativeCriteria:mutate",
    );
    expect(resolveGoogleAdsTokenEndpoint(loopbackEnvironment)).toBe(
      "http://127.0.0.1:4014/token",
    );
  });

  it("preserves configured gateway base paths", () => {
    expect(
      resolveGoogleAdsApiEndpoint(
        { kind: "accessible_customers", apiVersion: "v22" },
        {
          GOOGLE_ADS_API_BASE_URL:
            "https://gateway.example.test/providers/google-ads/",
          GOOGLE_ADS_TOKEN_URL:
            "https://auth.example.test/providers/google/token",
        },
      ),
    ).toBe(
      "https://gateway.example.test/providers/google-ads/v22/customers:listAccessibleCustomers",
    );
  });

  it.each([
    ["not a URL", "valid absolute URL"],
    ["ftp://provider.example/google-ads", "must use HTTPS"],
    ["http://provider.example/google-ads", "must use HTTPS"],
    ["https://user:secret@provider.example", "credentials"],
    ["https://provider.example?secret=value", "query parameters"],
    ["https://provider.example#fragment", "fragment"],
  ])("rejects unsafe API base %s", (apiBaseUrl, message) => {
    expect(() =>
      getGoogleAdsProviderEndpoints({
        GOOGLE_ADS_API_BASE_URL: apiBaseUrl,
      }),
    ).toThrow(message);
  });

  it.each([
    ["not a URL", "valid absolute URL"],
    ["http://provider.example/token", "must use HTTPS"],
    ["https://user:secret@provider.example/token", "credentials"],
    ["https://provider.example/token?secret=value", "query parameters"],
  ])("rejects unsafe token endpoint %s", (tokenUrl, message) => {
    expect(() =>
      getGoogleAdsProviderEndpoints({ GOOGLE_ADS_TOKEN_URL: tokenUrl }),
    ).toThrow(message);
  });

  it("permits HTTP only for loopback development providers", () => {
    expect(
      getGoogleAdsProviderEndpoints(loopbackEnvironment).apiBaseUrl.origin,
    ).toBe("http://127.0.0.1:4014");
    expect(() =>
      getGoogleAdsProviderEndpoints({
        GOOGLE_ADS_API_BASE_URL: "http://google-ads-fake:4014",
        GOOGLE_ADS_TOKEN_URL: "http://google-ads-fake:4014/token",
      }),
    ).toThrow("must use HTTPS");
  });

  it("rejects loopback endpoints in production", () => {
    expect(() =>
      getGoogleAdsProviderEndpoints({
        ...loopbackEnvironment,
        E2E_RUN_ID: undefined,
        NODE_ENV: "production",
      }),
    ).toThrow("cannot target a loopback host in production");
  });

  it("allows loopback endpoints for a controlled production-build E2E run", () => {
    const endpoints = getGoogleAdsProviderEndpoints({
      ...loopbackEnvironment,
      NODE_ENV: "production",
      TEAM_CRM_AUDIT_MODE: "1",
    });
    expect(endpoints.apiBaseUrl.origin).toBe("http://127.0.0.1:4014");
    expect(endpoints.tokenUrl.origin).toBe("http://127.0.0.1:4014");
  });

  it.each([
    { E2E_RUN_ID: "production-build-audit" },
    { TEAM_CRM_AUDIT_MODE: "1" },
    {
      E2E_RUN_ID: "production-build-audit",
      TEAM_CRM_AUDIT_MODE: "true",
    },
  ])("rejects a partial production-build sentinel %j", (sentinels) => {
    expect(() =>
      getGoogleAdsProviderEndpoints({
        NODE_ENV: "production",
        ...sentinels,
      }),
    ).toThrow("Production provider-test runtime requires both");
  });

  it("fails closed unless both audit endpoints use one loopback origin", () => {
    expect(() =>
      getGoogleAdsProviderEndpoints({ E2E_RUN_ID: "google-ads-audit" }),
    ).toThrow("must target a loopback service");
    expect(() =>
      getGoogleAdsProviderEndpoints({
        ...loopbackEnvironment,
        GOOGLE_ADS_TOKEN_URL: "http://127.0.0.1:4999/token",
      }),
    ).toThrow("must share one loopback origin");
  });

  it.each(["20", "v0", "v20beta", "v 20", ""])(
    "rejects invalid API version %s",
    (apiVersion) => {
      expect(() =>
        resolveGoogleAdsApiEndpoint(
          { kind: "accessible_customers", apiVersion },
          loopbackEnvironment,
        ),
      ).toThrow("apiVersion");
    },
  );

  it.each([
    "123",
    "12345678901",
    "customer",
    "abc1234567890",
    "123/456/7890",
    "",
  ])("rejects invalid customer ID %s", (customerId) => {
    expect(() =>
      resolveGoogleAdsApiEndpoint(
        { kind: "search_stream", apiVersion: "v25", customerId },
        loopbackEnvironment,
      ),
    ).toThrow("exactly ten digits");
  });
});
