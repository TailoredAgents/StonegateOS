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

  it("requires production Square settings and exact HTTPS return paths", () => {
    const inspection = inspectSquareConfiguration({
      NODE_ENV: "production",
      SQUARE_ENVIRONMENT: "sandbox",
      SQUARE_APPLICATION_ID: "application",
      SQUARE_ACCESS_TOKEN: "token",
      SQUARE_LOCATION_ID: "location",
      SQUARE_POS_CALLBACK_URL: "http://site.test/mobile/payment-return",
      SQUARE_POS_FALLBACK_URL: "https://site.test/mobile/wrong-path",
      SQUARE_POS_STATE_SECRET: "a".repeat(32),
      SQUARE_WEBHOOK_SIGNATURE_KEY: "signature",
      SQUARE_WEBHOOK_NOTIFICATION_URL:
        "https://api.test/api/webhooks/square?unexpected=1",
    });

    expect(inspection.configured).toBe(false);
    expect(inspection.missing).toEqual([]);
    expect(inspection.invalid).toEqual(
      expect.arrayContaining([
        "SQUARE_ENVIRONMENT must be production when NODE_ENV=production",
        "SQUARE_POS_CALLBACK_URL must use HTTPS in production",
        "SQUARE_POS_FALLBACK_URL must use path /mobile/square-setup",
        "SQUARE_WEBHOOK_NOTIFICATION_URL must be an origin URL without credentials, query parameters, or a fragment",
      ]),
    );
  });

  it("accepts complete production Square configuration", () => {
    const inspection = inspectSquareConfiguration({
      NODE_ENV: "production",
      SQUARE_ENVIRONMENT: "production",
      SQUARE_APPLICATION_ID: "application",
      SQUARE_ACCESS_TOKEN: "token",
      SQUARE_LOCATION_ID: "location",
      SQUARE_POS_CALLBACK_URL: "https://site.test/mobile/payment-return",
      SQUARE_POS_FALLBACK_URL: "https://site.test/mobile/square-setup",
      SQUARE_POS_STATE_SECRET: "a".repeat(32),
      SQUARE_WEBHOOK_SIGNATURE_KEY: "signature",
      SQUARE_WEBHOOK_NOTIFICATION_URL: "https://api.test/api/webhooks/square",
    });

    expect(inspection).toEqual({
      configured: true,
      missing: [],
      invalid: [],
    });
  });

  it("allows local HTTP Square return URLs outside production", () => {
    const inspection = inspectSquareConfiguration({
      NODE_ENV: "test",
      SQUARE_ENVIRONMENT: "sandbox",
      SQUARE_APPLICATION_ID: "application",
      SQUARE_ACCESS_TOKEN: "token",
      SQUARE_LOCATION_ID: "location",
      SQUARE_POS_CALLBACK_URL:
        "http://localhost:3000/mobile/payment-return",
      SQUARE_POS_FALLBACK_URL: "http://localhost:3000/mobile/square-setup",
      SQUARE_POS_STATE_SECRET: "a".repeat(32),
      SQUARE_WEBHOOK_SIGNATURE_KEY: "signature",
      SQUARE_WEBHOOK_NOTIFICATION_URL:
        "http://127.0.0.1:3001/api/webhooks/square",
    });

    expect(inspection.configured).toBe(true);
    expect(inspection.invalid).toEqual([]);
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

  it("rejects unsafe production object-storage settings", () => {
    const inspection = inspectObjectStorageConfiguration({
      NODE_ENV: "production",
      MEDIA_OBJECT_ENDPOINT: "http://account.r2.cloudflarestorage.com",
      MEDIA_OBJECT_BUCKET: "bucket",
      MEDIA_OBJECT_ACCESS_KEY_ID: "key",
      MEDIA_OBJECT_SECRET_ACCESS_KEY: "secret",
      MEDIA_OBJECT_AUTO_CREATE_BUCKET: "yes",
    });

    expect(inspection.configured).toBe(false);
    expect(inspection.missing).toEqual([]);
    expect(inspection.invalid).toEqual(
      expect.arrayContaining([
        "MEDIA_OBJECT_ENDPOINT must use HTTPS in production",
        "MEDIA_OBJECT_AUTO_CREATE_BUCKET must be disabled in production",
      ]),
    );
  });

  it("rejects malformed endpoints and production LocalStack", () => {
    const malformed = inspectObjectStorageConfiguration({
      MEDIA_OBJECT_ENDPOINT: "not a URL",
      MEDIA_OBJECT_BUCKET: "bucket",
      MEDIA_OBJECT_ACCESS_KEY_ID: "key",
      MEDIA_OBJECT_SECRET_ACCESS_KEY: "secret",
    });
    const localProduction = inspectObjectStorageConfiguration({
      NODE_ENV: "production",
      LOCALSTACK_ENDPOINT: "http://localstack:4566",
      MEDIA_OBJECT_BUCKET: "bucket",
      MEDIA_OBJECT_ACCESS_KEY_ID: "key",
      MEDIA_OBJECT_SECRET_ACCESS_KEY: "secret",
    });

    expect(malformed.invalid).toContain(
      "MEDIA_OBJECT_ENDPOINT must be a valid URL",
    );
    expect(localProduction.invalid).toEqual(
      expect.arrayContaining([
        "LOCALSTACK_ENDPOINT cannot be used when NODE_ENV=production",
        "MEDIA_OBJECT_ENDPOINT must use HTTPS in production",
      ]),
    );
  });

  it("allows local object storage outside production", () => {
    const inspection = inspectObjectStorageConfiguration({
      NODE_ENV: "test",
      MEDIA_OBJECT_ENDPOINT: "http://localhost:4566",
      MEDIA_OBJECT_BUCKET: "bucket",
      MEDIA_OBJECT_ACCESS_KEY_ID: "key",
      MEDIA_OBJECT_SECRET_ACCESS_KEY: "secret",
      MEDIA_OBJECT_AUTO_CREATE_BUCKET: "1",
    });

    expect(inspection).toEqual({
      configured: true,
      missing: [],
      invalid: [],
    });
  });
});
