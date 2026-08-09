import {
  DEFAULT_META_GRAPH_API_BASE_URL,
  getMetaGraphApiBaseUrl,
  resolveMetaGraphApiEndpoint,
  validateMetaGraphPaginationUrl,
} from "@myst-os/sdk";

describe("Meta Graph provider endpoint safety", () => {
  it("preserves the real Graph API as the normal production default", () => {
    expect(getMetaGraphApiBaseUrl({}).toString()).toBe(
      `${DEFAULT_META_GRAPH_API_BASE_URL}/`,
    );
    expect(resolveMetaGraphApiEndpoint(["me", "messages"], {})).toBe(
      "https://graph.facebook.com/v24.0/me/messages",
    );
    expect(
      resolveMetaGraphApiEndpoint(["debug_token"], {}, { versioned: false }),
    ).toBe("https://graph.facebook.com/debug_token");
    expect(
      resolveMetaGraphApiEndpoint(["act_123", "insights"], {
        NODE_ENV: "production",
      }),
    ).toBe("https://graph.facebook.com/v24.0/act_123/insights");
  });

  it("preserves a configured gateway path and safely encodes identifiers", () => {
    const environment = {
      FACEBOOK_GRAPH_API_BASE_URL: "https://gateway.example.test/meta/",
    };
    expect(
      resolveMetaGraphApiEndpoint(["page/id", "subscribed_apps"], environment),
    ).toBe("https://gateway.example.test/meta/v24.0/page%2Fid/subscribed_apps");
  });

  it.each([
    ["not a URL", "valid absolute URL"],
    ["ftp://provider.example/meta", "must use HTTPS"],
    ["http://provider.example/meta", "must use HTTPS"],
    [
      "https://user:secret@provider.example/meta",
      "must not contain credentials",
    ],
    ["https://provider.example/meta?secret=value", "query parameters"],
    ["https://provider.example/meta#fragment", "fragment"],
  ])("rejects unsafe base URL %s", (baseUrl, message) => {
    expect(() =>
      getMetaGraphApiBaseUrl({ FACEBOOK_GRAPH_API_BASE_URL: baseUrl }),
    ).toThrow(message);
  });

  it("allows HTTP only for loopback development providers", () => {
    expect(
      resolveMetaGraphApiEndpoint(["me", "messages"], {
        NODE_ENV: "development",
        FACEBOOK_GRAPH_API_BASE_URL: "http://127.25.0.9:4013",
      }),
    ).toBe("http://127.25.0.9:4013/v24.0/me/messages");
    expect(() =>
      getMetaGraphApiBaseUrl({
        NODE_ENV: "development",
        FACEBOOK_GRAPH_API_BASE_URL: "http://meta-fake:4013",
      }),
    ).toThrow("must use HTTPS");
  });

  it.each([
    "https://localhost:4013",
    "https://127.0.0.1:4013",
    "https://[::1]:4013",
    "https://[0:0:0:0:0:0:0:1]:4013",
    "https://[::ffff:127.0.0.1]:4013",
  ])("rejects loopback provider %s in production", (baseUrl) => {
    expect(() =>
      getMetaGraphApiBaseUrl({
        NODE_ENV: "production",
        FACEBOOK_GRAPH_API_BASE_URL: baseUrl,
      }),
    ).toThrow("cannot target a loopback host in production");
  });

  it("allows the loopback fake for a controlled production-build E2E run", () => {
    expect(
      getMetaGraphApiBaseUrl({
        NODE_ENV: "production",
        E2E_RUN_ID: "production-build-audit",
        TEAM_CRM_AUDIT_MODE: "1",
        FACEBOOK_GRAPH_API_BASE_URL: "http://127.0.0.1:4013",
      }).origin,
    ).toBe("http://127.0.0.1:4013");
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
      getMetaGraphApiBaseUrl({
        NODE_ENV: "production",
        ...sentinels,
      }),
    ).toThrow("Production provider-test runtime requires both");
  });

  it.each([
    { E2E_RUN_ID: "audit-1" },
    { TEAM_CRM_AUDIT_MODE: "true" },
    {
      E2E_RUN_ID: "audit-1",
      FACEBOOK_GRAPH_API_BASE_URL: "https://graph.facebook.com",
    },
  ])("fails closed for a non-loopback E2E/audit provider", (environment) => {
    expect(() => getMetaGraphApiBaseUrl(environment)).toThrow(
      "must target a loopback service during E2E or CRM audit runs",
    );
  });

  it.each([
    "http://localhost:4013",
    "http://127.0.0.1:4013",
    "http://[::1]:4013",
  ])("accepts loopback provider %s during E2E", (baseUrl) => {
    expect(
      resolveMetaGraphApiEndpoint(["page-e2e"], {
        E2E_RUN_ID: "audit-1",
        FACEBOOK_GRAPH_API_BASE_URL: baseUrl,
      }),
    ).toContain("/v24.0/page-e2e");
  });

  it("allows provider pagination only on the configured versioned origin", () => {
    const environment = {
      E2E_RUN_ID: "audit-1",
      FACEBOOK_GRAPH_API_BASE_URL: "http://127.0.0.1:4013/meta",
    };
    expect(
      validateMetaGraphPaginationUrl(
        "http://127.0.0.1:4013/meta/v24.0/act_1/insights?after=next",
        environment,
      ),
    ).toBe("http://127.0.0.1:4013/meta/v24.0/act_1/insights?after=next");

    for (const candidate of [
      "https://graph.facebook.com/v24.0/act_1/insights?after=next",
      "http://127.0.0.1:4014/meta/v24.0/act_1/insights",
      "http://user:secret@127.0.0.1:4013/meta/v24.0/act_1/insights",
      "http://127.0.0.1:4013/other/v24.0/act_1/insights",
      "http://127.0.0.1:4013/meta/v23.0/act_1/insights",
      "http://127.0.0.1:4013/meta/v24.0/act_1/insights#fragment",
    ]) {
      expect(() =>
        validateMetaGraphPaginationUrl(candidate, environment),
      ).toThrow("must remain on the configured versioned provider origin");
    }
  });
});
