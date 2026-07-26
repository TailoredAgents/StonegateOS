import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import {
  createMediaUploadUrl,
  getMediaStorageProvider,
  readMediaStorageConfig,
  resetMediaStorageForTests,
  verifyMediaStorageBucketAccess,
} from "@/lib/media-storage";

describe("appointment media object storage", () => {
  const keys = [
    "MEDIA_OBJECT_ENDPOINT",
    "MEDIA_OBJECT_REGION",
    "MEDIA_OBJECT_BUCKET",
    "MEDIA_OBJECT_ACCESS_KEY_ID",
    "MEDIA_OBJECT_SECRET_ACCESS_KEY",
    "MEDIA_OBJECT_FORCE_PATH_STYLE",
    "MEDIA_OBJECT_AUTO_CREATE_BUCKET",
    "LOCALSTACK_ENDPOINT",
    "R2_ACCOUNT_ID",
  ] as const;
  const original = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  ) as Record<(typeof keys)[number], string | undefined>;

  afterEach(() => {
    resetMediaStorageForTests();
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });

  it("uses path-style LocalStack storage and creates a signed upload contract", async () => {
    process.env["MEDIA_OBJECT_ENDPOINT"] = "http://localhost:4566";
    process.env["MEDIA_OBJECT_REGION"] = "us-east-1";
    process.env["MEDIA_OBJECT_BUCKET"] = "media-test";
    process.env["MEDIA_OBJECT_ACCESS_KEY_ID"] = "test";
    process.env["MEDIA_OBJECT_SECRET_ACCESS_KEY"] = "test";
    process.env["MEDIA_OBJECT_FORCE_PATH_STYLE"] = "1";
    process.env["MEDIA_OBJECT_AUTO_CREATE_BUCKET"] = "0";

    const config = readMediaStorageConfig();
    expect(config.forcePathStyle).toBe(true);
    expect(config.bucket).toBe("media-test");
    expect(getMediaStorageProvider()).toBe("s3");

    const intent = await createMediaUploadUrl({
      key: "staging/example/photo.jpg",
      contentType: "image/jpeg",
      byteLength: 123,
      checksumSha256Hex: "ab".repeat(32),
      expiresInSeconds: 600,
    });

    expect(intent.url).toContain(
      "localhost:4566/media-test/staging/example/photo.jpg",
    );
    expect(intent.url).toContain("X-Amz-Signature=");
    expect(intent.headers["content-type"]).toBe("image/jpeg");
    expect(intent.headers["x-amz-checksum-sha256"]).toBeTruthy();
  });

  it("recognizes a Cloudflare R2 endpoint", () => {
    process.env["MEDIA_OBJECT_ENDPOINT"] =
      "https://abc123.r2.cloudflarestorage.com";
    process.env["MEDIA_OBJECT_ACCESS_KEY_ID"] = "key";
    process.env["MEDIA_OBJECT_SECRET_ACCESS_KEY"] = "secret";
    process.env["MEDIA_OBJECT_AUTO_CREATE_BUCKET"] = "0";

    expect(getMediaStorageProvider()).toBe("r2");
  });

  it("does not sign R2 browser uploads with an unsupported full-object SHA-256 header", async () => {
    process.env["MEDIA_OBJECT_ENDPOINT"] =
      "https://abc123.r2.cloudflarestorage.com";
    process.env["MEDIA_OBJECT_REGION"] = "auto";
    process.env["MEDIA_OBJECT_BUCKET"] = "media-test";
    process.env["MEDIA_OBJECT_ACCESS_KEY_ID"] = "key";
    process.env["MEDIA_OBJECT_SECRET_ACCESS_KEY"] = "secret";
    process.env["MEDIA_OBJECT_FORCE_PATH_STYLE"] = "1";
    process.env["MEDIA_OBJECT_AUTO_CREATE_BUCKET"] = "0";

    const intent = await createMediaUploadUrl({
      key: "staging/example/photo.jpg",
      contentType: "image/jpeg",
      byteLength: 123,
      checksumSha256Hex: "ab".repeat(32),
      expiresInSeconds: 600,
    });

    expect(intent.headers).toEqual({ "content-type": "image/jpeg" });
    expect(
      new URL(intent.url).searchParams.get("X-Amz-SignedHeaders"),
    ).not.toContain("x-amz-checksum-sha256");
  });

  it("verifies bucket access with one read-only HEAD request", async () => {
    process.env["MEDIA_OBJECT_ENDPOINT"] = "http://localhost:4566";
    process.env["MEDIA_OBJECT_REGION"] = "us-east-1";
    process.env["MEDIA_OBJECT_BUCKET"] = "media-health-test";
    process.env["MEDIA_OBJECT_ACCESS_KEY_ID"] = "test";
    process.env["MEDIA_OBJECT_SECRET_ACCESS_KEY"] = "test";
    process.env["MEDIA_OBJECT_AUTO_CREATE_BUCKET"] = "1";
    const send = jest
      .spyOn(S3Client.prototype, "send")
      .mockResolvedValue({} as never);

    try {
      await expect(verifyMediaStorageBucketAccess()).resolves.toEqual({
        bucket: "media-health-test",
        provider: "s3",
      });
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]?.[0]).toBeInstanceOf(HeadBucketCommand);
    } finally {
      send.mockRestore();
    }
  });
});
