import {
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const mockRecordProviderFailure = jest.fn(() => Promise.resolve());
const mockRecordProviderSuccess = jest.fn(() => Promise.resolve());

jest.mock("@/lib/provider-health", () => ({
  recordProviderFailure: mockRecordProviderFailure,
  recordProviderSuccess: mockRecordProviderSuccess,
}));

import {
  createMediaUploadUrl,
  getMediaStorageProvider,
  putImmutableMediaObject,
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
    "NODE_ENV",
    "E2E_RUN_ID",
    "TEAM_CRM_AUDIT_MODE",
  ] as const;
  const original = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  ) as Record<(typeof keys)[number], string | undefined>;

  beforeEach(() => {
    process.env["NODE_ENV"] = "test";
    delete process.env["E2E_RUN_ID"];
    delete process.env["TEAM_CRM_AUDIT_MODE"];
  });

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
    expect(
      new URL(intent.url).searchParams.get("X-Amz-SignedHeaders"),
    ).toContain("content-length");
  });

  it("signs write-once uploads with a mandatory create-only precondition", async () => {
    process.env["MEDIA_OBJECT_ENDPOINT"] = "http://localhost:4566";
    process.env["MEDIA_OBJECT_REGION"] = "us-east-1";
    process.env["MEDIA_OBJECT_BUCKET"] = "media-test";
    process.env["MEDIA_OBJECT_ACCESS_KEY_ID"] = "test";
    process.env["MEDIA_OBJECT_SECRET_ACCESS_KEY"] = "test";
    process.env["MEDIA_OBJECT_FORCE_PATH_STYLE"] = "1";
    process.env["MEDIA_OBJECT_AUTO_CREATE_BUCKET"] = "0";

    const intent = await createMediaUploadUrl({
      key: "expenses/receipts/member/capture/original.jpg",
      contentType: "image/jpeg",
      byteLength: 123,
      checksumSha256Hex: "ab".repeat(32),
      expiresInSeconds: 600,
      writeOnce: true,
    });

    expect(intent.headers["if-none-match"]).toBe("*");
    expect(
      new URL(intent.url).searchParams.get("X-Amz-SignedHeaders"),
    ).toContain("if-none-match");
  });

  it("creates immutable objects with a conditional PUT and verifies the stored bytes", async () => {
    process.env["MEDIA_OBJECT_ENDPOINT"] = "http://localhost:4566";
    process.env["MEDIA_OBJECT_REGION"] = "us-east-1";
    process.env["MEDIA_OBJECT_BUCKET"] = "media-test";
    process.env["MEDIA_OBJECT_ACCESS_KEY_ID"] = "test";
    process.env["MEDIA_OBJECT_SECRET_ACCESS_KEY"] = "test";
    process.env["MEDIA_OBJECT_FORCE_PATH_STYLE"] = "1";
    process.env["MEDIA_OBJECT_AUTO_CREATE_BUCKET"] = "0";
    const body = Buffer.from("immutable receipt evidence");
    const send = jest.spyOn(S3Client.prototype, "send").mockImplementation(((
      command: unknown,
    ) => {
      if (command instanceof PutObjectCommand) {
        return Promise.resolve({} as never);
      }
      if (command instanceof HeadObjectCommand) {
        return Promise.resolve({
          ContentLength: body.byteLength,
          ContentType: "image/jpeg; charset=binary",
        } as never);
      }
      if (command instanceof GetObjectCommand) {
        return Promise.resolve({
          ContentLength: body.byteLength,
          Body: {
            transformToByteArray: () => Promise.resolve(Uint8Array.from(body)),
          },
        } as never);
      }
      return Promise.reject(new Error("unexpected storage command"));
    }) as never);

    try {
      await expect(
        putImmutableMediaObject({
          key: "expenses/receipts/member/capture/original.jpg",
          body,
          contentType: "image/jpeg",
        }),
      ).resolves.toBe("created");
      const put = send.mock.calls
        .map(([command]) => command)
        .find(
          (command): command is PutObjectCommand =>
            command instanceof PutObjectCommand,
        );
      expect(put?.input.IfNoneMatch).toBe("*");
    } finally {
      send.mockRestore();
    }
  });

  it("accepts an exact immutable retry but rejects different bytes without overwriting", async () => {
    process.env["MEDIA_OBJECT_ENDPOINT"] = "http://localhost:4566";
    process.env["MEDIA_OBJECT_REGION"] = "us-east-1";
    process.env["MEDIA_OBJECT_BUCKET"] = "media-test";
    process.env["MEDIA_OBJECT_ACCESS_KEY_ID"] = "test";
    process.env["MEDIA_OBJECT_SECRET_ACCESS_KEY"] = "test";
    process.env["MEDIA_OBJECT_FORCE_PATH_STYLE"] = "1";
    process.env["MEDIA_OBJECT_AUTO_CREATE_BUCKET"] = "0";
    const intended = Buffer.from("receipt-A");
    let stored = Buffer.from(intended);
    let putAttempts = 0;
    const preconditionFailed = Object.assign(
      new Error("object already exists"),
      { $metadata: { httpStatusCode: 412 } },
    );
    const send = jest.spyOn(S3Client.prototype, "send").mockImplementation(((
      command: unknown,
    ) => {
      if (command instanceof PutObjectCommand) {
        putAttempts += 1;
        return Promise.reject(preconditionFailed);
      }
      if (command instanceof HeadObjectCommand) {
        return Promise.resolve({
          ContentLength: stored.byteLength,
          ContentType: "image/jpeg",
        } as never);
      }
      if (command instanceof GetObjectCommand) {
        return Promise.resolve({
          ContentLength: stored.byteLength,
          Body: {
            transformToByteArray: () =>
              Promise.resolve(Uint8Array.from(stored)),
          },
        } as never);
      }
      return Promise.reject(new Error("unexpected storage command"));
    }) as never);

    try {
      const input = {
        key: "expenses/receipts/member/capture/original.jpg",
        body: intended,
        contentType: "image/jpeg",
      };
      await expect(putImmutableMediaObject(input)).resolves.toBe(
        "already_exists",
      );

      stored = Buffer.from("receipt-B");
      await expect(putImmutableMediaObject(input)).rejects.toThrow(
        "media_immutable_object_conflict",
      );
      expect(putAttempts).toBe(2);
    } finally {
      send.mockRestore();
    }
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
    const parameters = new URL(intent.url).searchParams;
    expect(parameters.get("X-Amz-SignedHeaders")).not.toContain(
      "x-amz-checksum-sha256",
    );
    expect(parameters.get("X-Amz-SignedHeaders")).not.toContain(
      "content-length",
    );
    expect(
      [...parameters.keys()].filter((key) =>
        /^x-amz-(?:checksum-|sdk-checksum)/iu.test(key),
      ),
    ).toEqual([]);
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

  it("rejects local endpoints and bucket auto-create in ordinary production", () => {
    process.env["NODE_ENV"] = "production";
    process.env["MEDIA_OBJECT_ENDPOINT"] = "http://localhost:4566";
    process.env["MEDIA_OBJECT_AUTO_CREATE_BUCKET"] = "0";
    expect(() => readMediaStorageConfig()).toThrow(
      "media_storage_local_endpoint_forbidden_in_production",
    );

    process.env["MEDIA_OBJECT_ENDPOINT"] =
      "https://account.r2.cloudflarestorage.com";
    process.env["MEDIA_OBJECT_AUTO_CREATE_BUCKET"] = "1";
    expect(() => readMediaStorageConfig()).toThrow(
      "media_storage_auto_create_forbidden_in_production",
    );
  });

  it("allows LocalStack auto-create for a dual-sentinel production-build audit", () => {
    process.env["NODE_ENV"] = "production";
    process.env["E2E_RUN_ID"] = "production-build-audit";
    process.env["TEAM_CRM_AUDIT_MODE"] = "1";
    process.env["MEDIA_OBJECT_ENDPOINT"] = "http://127.0.0.1:4566";
    process.env["MEDIA_OBJECT_AUTO_CREATE_BUCKET"] = "1";

    expect(readMediaStorageConfig()).toMatchObject({
      endpoint: "http://127.0.0.1:4566",
      autoCreateBucket: true,
    });
  });

  it.each([
    { E2E_RUN_ID: "production-build-audit", TEAM_CRM_AUDIT_MODE: undefined },
    { E2E_RUN_ID: undefined, TEAM_CRM_AUDIT_MODE: "1" },
    {
      E2E_RUN_ID: "production-build-audit",
      TEAM_CRM_AUDIT_MODE: "true",
    },
  ])("rejects partial production test sentinels %j", (sentinels) => {
    process.env["NODE_ENV"] = "production";
    if (sentinels.E2E_RUN_ID === undefined) {
      delete process.env["E2E_RUN_ID"];
    } else {
      process.env["E2E_RUN_ID"] = sentinels.E2E_RUN_ID;
    }
    if (sentinels.TEAM_CRM_AUDIT_MODE === undefined) {
      delete process.env["TEAM_CRM_AUDIT_MODE"];
    } else {
      process.env["TEAM_CRM_AUDIT_MODE"] = sentinels.TEAM_CRM_AUDIT_MODE;
    }
    process.env["MEDIA_OBJECT_ENDPOINT"] =
      "https://account.r2.cloudflarestorage.com";
    process.env["MEDIA_OBJECT_AUTO_CREATE_BUCKET"] = "0";

    expect(() => readMediaStorageConfig()).toThrow(
      "Production provider-test runtime requires both",
    );
  });

  it("refuses public object storage in a controlled provider-test runtime", () => {
    process.env["NODE_ENV"] = "production";
    process.env["E2E_RUN_ID"] = "production-build-audit";
    process.env["TEAM_CRM_AUDIT_MODE"] = "1";
    process.env["MEDIA_OBJECT_ENDPOINT"] =
      "https://account.r2.cloudflarestorage.com";
    process.env["MEDIA_OBJECT_AUTO_CREATE_BUCKET"] = "0";

    expect(() => readMediaStorageConfig()).toThrow(
      "media_storage_test_runtime_requires_local_endpoint",
    );
  });
});
