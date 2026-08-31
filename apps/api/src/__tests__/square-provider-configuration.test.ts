import {
  DEFAULT_SQUARE_PRODUCTION_API_BASE_URL,
  DEFAULT_SQUARE_SANDBOX_API_BASE_URL,
  getSquareApiBaseUrl,
  resolveSquareApiEndpoint,
} from "@myst-os/sdk";

const loopbackEnvironment = {
  E2E_RUN_ID: "square-audit",
  SQUARE_ENVIRONMENT: "sandbox",
  SQUARE_API_BASE_URL: "http://127.0.0.1:4015",
};

describe("Square provider endpoint safety", () => {
  it("preserves official HTTPS production and sandbox defaults", () => {
    expect(getSquareApiBaseUrl({}).toString()).toBe(
      new URL(DEFAULT_SQUARE_PRODUCTION_API_BASE_URL).toString(),
    );
    expect(
      getSquareApiBaseUrl({ SQUARE_ENVIRONMENT: "sandbox" }).toString(),
    ).toBe(new URL(DEFAULT_SQUARE_SANDBOX_API_BASE_URL).toString());
  });

  it("resolves every active server-side operation through one typed base", () => {
    expect(
      resolveSquareApiEndpoint(
        { kind: "order", orderId: "order/with spaces" },
        loopbackEnvironment,
      ),
    ).toBe("http://127.0.0.1:4015/v2/orders/order%2Fwith%20spaces");
    expect(
      resolveSquareApiEndpoint(
        { kind: "payment", paymentId: "payment-e2e" },
        loopbackEnvironment,
      ),
    ).toBe("http://127.0.0.1:4015/v2/payments/payment-e2e");
    expect(
      resolveSquareApiEndpoint(
        { kind: "refund", refundId: "refund-e2e" },
        loopbackEnvironment,
      ),
    ).toBe("http://127.0.0.1:4015/v2/refunds/refund-e2e");
    expect(
      resolveSquareApiEndpoint({ kind: "payments" }, loopbackEnvironment),
    ).toBe("http://127.0.0.1:4015/v2/payments");
    expect(
      resolveSquareApiEndpoint({ kind: "refunds" }, loopbackEnvironment),
    ).toBe("http://127.0.0.1:4015/v2/refunds");
    expect(
      resolveSquareApiEndpoint({ kind: "paymentLinks" }, loopbackEnvironment),
    ).toBe("http://127.0.0.1:4015/v2/online-checkout/payment-links");
  });

  it("preserves a configured gateway base path", () => {
    expect(
      resolveSquareApiEndpoint(
        { kind: "payment", paymentId: "payment-e2e" },
        { SQUARE_API_BASE_URL: "https://gateway.example.test/square/" },
      ),
    ).toBe("https://gateway.example.test/square/v2/payments/payment-e2e");
  });

  it.each([
    ["not a URL", "valid absolute URL"],
    ["ftp://provider.example/square", "must use HTTPS"],
    ["http://provider.example/square", "must use HTTPS"],
    ["https://user:secret@provider.example", "credentials"],
    ["https://provider.example?secret=value", "query parameters"],
    ["https://provider.example#fragment", "fragment"],
  ])("rejects unsafe API base %s", (apiBaseUrl, message) => {
    expect(() =>
      getSquareApiBaseUrl({ SQUARE_API_BASE_URL: apiBaseUrl }),
    ).toThrow(message);
  });

  it("permits loopback HTTP only outside production", () => {
    expect(getSquareApiBaseUrl(loopbackEnvironment).origin).toBe(
      "http://127.0.0.1:4015",
    );
    expect(() =>
      getSquareApiBaseUrl({
        ...loopbackEnvironment,
        E2E_RUN_ID: undefined,
        NODE_ENV: "production",
      }),
    ).toThrow("cannot target a loopback host in production");
    expect(() =>
      getSquareApiBaseUrl({
        SQUARE_API_BASE_URL: "http://square-fake:4015",
      }),
    ).toThrow("must use HTTPS");
  });

  it("allows the loopback fake for a controlled production-build E2E run", () => {
    expect(
      getSquareApiBaseUrl({
        ...loopbackEnvironment,
        NODE_ENV: "production",
        TEAM_CRM_AUDIT_MODE: "1",
      }).origin,
    ).toBe("http://127.0.0.1:4015");
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
      getSquareApiBaseUrl({
        NODE_ENV: "production",
        ...sentinels,
      }),
    ).toThrow("Production provider-test runtime requires both");
  });

  it("fails closed before public-provider fallback in audit mode", () => {
    expect(() => getSquareApiBaseUrl({ E2E_RUN_ID: "square-audit" })).toThrow(
      "must target a loopback service",
    );
    expect(() =>
      getSquareApiBaseUrl({
        TEAM_CRM_AUDIT_MODE: "true",
        SQUARE_API_BASE_URL: "https://connect.squareupsandbox.com",
      }),
    ).toThrow("must target a loopback service");
  });

  it.each(["", "   ", "\u0000unsafe", "x".repeat(256)])(
    "rejects unsafe provider identifier %j",
    (paymentId) => {
      expect(() =>
        resolveSquareApiEndpoint(
          { kind: "payment", paymentId },
          loopbackEnvironment,
        ),
      ).toThrow("provider identifier");
    },
  );
});
