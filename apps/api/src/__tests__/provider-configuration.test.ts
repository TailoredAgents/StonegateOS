import {
  inspectObjectStorageConfiguration,
  inspectSquareConfiguration,
  isProviderConfigurationBlocking,
} from "@/lib/provider-configuration";

describe("provider rollout configuration", () => {
  it("reports missing Square values while the launch flag is irrelevant", () => {
    const inspection = inspectSquareConfiguration({});

    expect(inspection.configured).toBe(false);
    expect(inspection.missing).toContain("SQUARE_ACCESS_TOKEN");
    expect(inspection.missing).toContain("SQUARE_POS_CALLBACK_URL");
    expect(
      isProviderConfigurationBlocking({
        enabled: false,
        configuration: inspection,
      }),
    ).toBe(false);
    expect(
      isProviderConfigurationBlocking({
        enabled: true,
        configuration: inspection,
      }),
    ).toBe(true);
  });

  it("rejects a short Square state secret", () => {
    const inspection = inspectSquareConfiguration({
      SQUARE_APPLICATION_ID: "application",
      SQUARE_ACCESS_TOKEN: "token",
      SQUARE_LOCATION_ID: "location",
      SQUARE_POS_CALLBACK_URL: "https://site.test/mobile/payment-return",
      SQUARE_POS_FALLBACK_URL: "https://site.test/mobile/square-setup",
      SQUARE_POS_STATE_SECRET: "too-short",
      SQUARE_WEBHOOK_SIGNATURE_KEY: "signature",
      SQUARE_WEBHOOK_NOTIFICATION_URL: "https://api.test/api/webhooks/square",
    });

    expect(inspection.configured).toBe(false);
    expect(inspection.missing).toEqual([]);
    expect(inspection.invalid).toEqual([
      "SQUARE_POS_STATE_SECRET must contain at least 32 bytes",
    ]);
  });

  it("recognizes complete object-storage aliases", () => {
    const inspection = inspectObjectStorageConfiguration({
      R2_ACCOUNT_ID: "account",
      R2_BUCKET_NAME: "bucket",
      R2_ACCESS_KEY_ID: "key",
      R2_SECRET_ACCESS_KEY: "secret",
    });

    expect(inspection).toEqual({
      configured: true,
      missing: [],
      invalid: [],
    });
  });
});
