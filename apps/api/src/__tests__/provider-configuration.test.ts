import {
  inspectObjectStorageConfiguration,
  isProviderConfigurationBlocking,
} from "@/lib/provider-configuration";

describe("provider rollout configuration", () => {
  it("blocks enabled media writes when object storage is incomplete", () => {
    const inspection = inspectObjectStorageConfiguration({});

    expect(inspection.configured).toBe(false);
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
