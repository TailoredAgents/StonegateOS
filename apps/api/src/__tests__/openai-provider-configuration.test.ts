import {
  DEFAULT_OPENAI_API_BASE_URL,
  getOpenAiApiBaseUrl,
  resolveOpenAiApiEndpoint,
} from "@myst-os/sdk";

describe("OpenAI provider endpoint safety", () => {
  it("preserves the production provider as the normal default", () => {
    expect(getOpenAiApiBaseUrl({}).toString()).toBe(
      DEFAULT_OPENAI_API_BASE_URL,
    );
    expect(resolveOpenAiApiEndpoint("responses", {})).toBe(
      "https://api.openai.com/v1/responses",
    );
    expect(resolveOpenAiApiEndpoint("audio/transcriptions", {})).toBe(
      "https://api.openai.com/v1/audio/transcriptions",
    );
    expect(
      resolveOpenAiApiEndpoint("responses", { NODE_ENV: "production" }),
    ).toBe("https://api.openai.com/v1/responses");
  });

  it("preserves a configured provider path when resolving both active endpoints", () => {
    const environment = {
      OPENAI_API_BASE_URL: "https://gateway.example.test/openai/v1/",
    };

    expect(resolveOpenAiApiEndpoint("responses", environment)).toBe(
      "https://gateway.example.test/openai/v1/responses",
    );
    expect(resolveOpenAiApiEndpoint("audio/transcriptions", environment)).toBe(
      "https://gateway.example.test/openai/v1/audio/transcriptions",
    );
  });

  it.each([
    ["not a URL", "valid absolute URL"],
    ["ftp://provider.example/v1", "must use HTTPS"],
    ["http://provider.example/v1", "must use HTTPS"],
    ["https://user:secret@provider.example/v1", "must not contain credentials"],
    ["https://provider.example/v1?secret=value", "query parameters"],
    ["https://provider.example/v1#fragment", "fragment"],
  ])("rejects unsafe base URL %s", (baseUrl, message) => {
    expect(() => getOpenAiApiBaseUrl({ OPENAI_API_BASE_URL: baseUrl })).toThrow(
      message,
    );
  });

  it("allows HTTP only for loopback development providers", () => {
    expect(
      resolveOpenAiApiEndpoint("responses", {
        NODE_ENV: "development",
        OPENAI_API_BASE_URL: "http://127.25.0.9:4011/v1",
      }),
    ).toBe("http://127.25.0.9:4011/v1/responses");
    expect(() =>
      resolveOpenAiApiEndpoint("responses", {
        NODE_ENV: "development",
        OPENAI_API_BASE_URL: "http://openai-fake:4011/v1",
      }),
    ).toThrow("must use HTTPS");
  });

  it("rejects every loopback provider in production", () => {
    expect(() =>
      getOpenAiApiBaseUrl({
        NODE_ENV: "production",
        OPENAI_API_BASE_URL: "https://localhost:4011/v1",
      }),
    ).toThrow("cannot target a loopback host in production");
  });

  it("allows the loopback fake for a controlled production-build E2E run", () => {
    expect(
      getOpenAiApiBaseUrl({
        NODE_ENV: "production",
        E2E_RUN_ID: "production-build-audit",
        TEAM_CRM_AUDIT_MODE: "1",
        OPENAI_API_BASE_URL: "http://127.0.0.1:4011/v1",
      }).toString(),
    ).toBe("http://127.0.0.1:4011/v1");
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
      getOpenAiApiBaseUrl({
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
      OPENAI_API_BASE_URL: "https://api.openai.com/v1",
    },
  ])("fails closed for a non-loopback E2E/audit provider", (environment) => {
    expect(() => getOpenAiApiBaseUrl(environment)).toThrow(
      "must target a loopback service during E2E or CRM audit runs",
    );
  });

  it.each([
    "http://localhost:4011/v1",
    "http://127.0.0.1:4011/v1",
    "http://[::1]:4011/v1",
  ])("accepts loopback provider %s during E2E", (baseUrl) => {
    expect(
      resolveOpenAiApiEndpoint("responses", {
        E2E_RUN_ID: "audit-1",
        OPENAI_API_BASE_URL: baseUrl,
      }),
    ).toContain("/v1/responses");
  });
});
