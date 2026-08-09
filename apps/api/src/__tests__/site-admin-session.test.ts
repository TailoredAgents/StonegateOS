import {
  adminSessionMatches,
  getAdminSessionSecret,
} from "../../../site/src/lib/admin-session";

describe("transitional admin browser session", () => {
  const originalAdminApiKey = process.env["ADMIN_API_KEY"];
  const originalAdminSessionSecret = process.env["ADMIN_SESSION_SECRET"];

  afterEach(() => {
    if (originalAdminApiKey === undefined) {
      delete process.env["ADMIN_API_KEY"];
    } else {
      process.env["ADMIN_API_KEY"] = originalAdminApiKey;
    }
    if (originalAdminSessionSecret === undefined) {
      delete process.env["ADMIN_SESSION_SECRET"];
    } else {
      process.env["ADMIN_SESSION_SECRET"] = originalAdminSessionSecret;
    }
  });

  it("never falls back to the internal API service credential", () => {
    process.env["ADMIN_API_KEY"] = "internal-service-key";
    delete process.env["ADMIN_SESSION_SECRET"];

    expect(getAdminSessionSecret()).toBeNull();
    expect(adminSessionMatches("internal-service-key")).toBe(false);
  });

  it("accepts only the independently configured browser secret", () => {
    process.env["ADMIN_API_KEY"] = "internal-service-key";
    process.env["ADMIN_SESSION_SECRET"] = "browser-session-secret";

    expect(adminSessionMatches("browser-session-secret")).toBe(true);
    expect(adminSessionMatches("internal-service-key")).toBe(false);
    expect(adminSessionMatches("browser-session-secreu")).toBe(false);
  });

  it("fails closed for empty or unreasonably large values", () => {
    process.env["ADMIN_SESSION_SECRET"] = " ";
    expect(getAdminSessionSecret()).toBeNull();
    expect(adminSessionMatches("")).toBe(false);

    process.env["ADMIN_SESSION_SECRET"] = "x".repeat(513);
    expect(getAdminSessionSecret()).toBeNull();
    expect(adminSessionMatches("x".repeat(513))).toBe(false);
  });
});
