import { resolveDatabaseSslOptions } from "@/db/ssl";

describe("database TLS configuration", () => {
  it("uses no TLS override for private/internal URLs", () => {
    expect(
      resolveDatabaseSslOptions("postgres://user:pass@internal/db", {
        NODE_ENV: "production",
      }),
    ).toBeUndefined();
  });

  it("verifies external TLS connections by default", () => {
    expect(
      resolveDatabaseSslOptions(
        "postgres://user:pass@external/db?sslmode=require",
        { NODE_ENV: "production" },
      ),
    ).toEqual({ rejectUnauthorized: true });
  });

  it("decodes and supplies a configured CA", () => {
    const ca = "-----BEGIN CERTIFICATE-----\nexample\n-----END CERTIFICATE-----";
    expect(
      resolveDatabaseSslOptions("postgres://user:pass@external/db", {
        NODE_ENV: "production",
        DATABASE_SSL: "true",
        DATABASE_SSL_CA_BASE64: Buffer.from(ca).toString("base64"),
      }),
    ).toEqual({ rejectUnauthorized: true, ca });
  });

  it("never permits certificate-verification bypass in production", () => {
    expect(() =>
      resolveDatabaseSslOptions(
        "postgres://user:pass@external/db?sslmode=require",
        {
          NODE_ENV: "production",
          DATABASE_SSL_ALLOW_INSECURE: "true",
        },
      ),
    ).toThrow("cannot be enabled in production");
  });

  it("allows an explicit local-development compatibility escape hatch", () => {
    expect(
      resolveDatabaseSslOptions(
        "postgres://user:pass@external/db?sslmode=require",
        {
          NODE_ENV: "development",
          DATABASE_SSL_ALLOW_INSECURE: "1",
        },
      ),
    ).toEqual({ rejectUnauthorized: false });
  });
});
