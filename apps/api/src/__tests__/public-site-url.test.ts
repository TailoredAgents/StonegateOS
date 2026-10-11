import { resolvePublicSiteBaseUrl } from "@/lib/public-site-url";

const ENV_KEYS = [
  "NEXT_PUBLIC_SITE_URL",
  "SITE_URL",
  "NODE_ENV",
  "RENDER",
] as const;

describe("public site URL resolution", () => {
  const originalEnv = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Record<(typeof ENV_KEYS)[number], string | undefined>;

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("falls through an unsafe public value to a safe server value", () => {
    process.env["NODE_ENV"] = "test";
    process.env["NEXT_PUBLIC_SITE_URL"] = "http://localhost:3000";
    process.env["SITE_URL"] = "https://stonegate.e2e.test";

    expect(resolvePublicSiteBaseUrl()).toBe("https://stonegate.e2e.test");
  });

  it("falls through an invalid or insecure production value", () => {
    process.env["NODE_ENV"] = "production";
    process.env["NEXT_PUBLIC_SITE_URL"] = "http://public.example.com";
    process.env["SITE_URL"] = "https://stonegate.example.com/path";

    expect(resolvePublicSiteBaseUrl()).toBe("https://stonegate.example.com");
  });

  it("keeps the first safe configured origin", () => {
    process.env["NODE_ENV"] = "production";
    process.env["NEXT_PUBLIC_SITE_URL"] = "https://primary.example.com/path";
    process.env["SITE_URL"] = "https://fallback.example.com";

    expect(resolvePublicSiteBaseUrl()).toBe("https://primary.example.com");
  });

  it("uses localhost only when an explicit development fallback is requested", () => {
    process.env["NODE_ENV"] = "test";
    delete process.env["NEXT_PUBLIC_SITE_URL"];
    delete process.env["SITE_URL"];

    expect(resolvePublicSiteBaseUrl()).toBeNull();
    expect(resolvePublicSiteBaseUrl({ devFallbackLocalhost: true })).toBe(
      "http://localhost:3000",
    );
  });
});
