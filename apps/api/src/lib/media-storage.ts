import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { isControlledProviderTestRuntime } from "@myst-os/sdk";
import {
  recordProviderFailure,
  recordProviderSuccess,
} from "@/lib/provider-health";

const DEFAULT_BUCKET = "stonegate-appointment-media";
const DEFAULT_REGION = "us-east-1";
const MAX_BUFFERED_OBJECT_BYTES = 11 * 1024 * 1024;

export type MediaStorageConfig = {
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle: boolean;
  autoCreateBucket: boolean;
};

export type StoredObjectHead = {
  byteLength: number | null;
  contentType: string | null;
  checksumSha256: string | null;
};

let cached:
  | {
      signature: string;
      client: S3Client;
      config: MediaStorageConfig;
      bucketReady: Promise<void> | null;
    }
  | undefined;

function storageFailureDetail(operation: string, error: unknown): string {
  const name =
    error && typeof error === "object" && "name" in error
      ? String(error.name)
      : "Error";
  const message =
    error instanceof Error
      ? error.message
          .replace(/https?:\/\/\S+/gi, "[redacted-url]")
          .replace(/\s+/g, " ")
          .trim()
      : "Object storage request failed";
  return `${operation}:${name}:${message}`.slice(0, 500);
}

async function recordStorageSuccess(): Promise<void> {
  try {
    await recordProviderSuccess("object_storage");
  } catch (error) {
    console.warn("[object_storage] provider health success update failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}

async function recordStorageFailure(
  operation: string,
  error: unknown,
): Promise<void> {
  try {
    await recordProviderFailure(
      "object_storage",
      storageFailureDetail(operation, error),
    );
  } catch (healthError) {
    console.warn("[object_storage] provider health failure update failed", {
      operation,
      error: healthError instanceof Error ? healthError.name : "unknown",
    });
  }
}

async function runStorageRequest<T>(
  operation: string,
  request: () => Promise<T>,
): Promise<T> {
  try {
    const result = await request();
    await recordStorageSuccess();
    return result;
  } catch (error) {
    await recordStorageFailure(operation, error);
    throw error;
  }
}

function firstNonEmpty(
  ...values: Array<string | undefined>
): string | undefined {
  return values.find((value) => value?.trim())?.trim();
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function isLocalStorageEndpoint(endpoint: string | undefined): boolean {
  if (!endpoint) return false;
  try {
    const hostname = new URL(endpoint).hostname
      .trim()
      .toLowerCase()
      .replace(/^\[|\]$/gu, "");
    if (
      hostname === "localhost" ||
      hostname === "::1" ||
      hostname === "localstack" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".localstack")
    ) {
      return true;
    }
    const parts = hostname.split(".");
    return (
      parts.length === 4 &&
      parts[0] === "127" &&
      parts.every(
        (part) => /^\d{1,3}$/u.test(part) && Number.parseInt(part, 10) <= 255,
      )
    );
  } catch {
    return false;
  }
}

export function readMediaStorageConfig(): MediaStorageConfig {
  const accountId = firstNonEmpty(process.env["R2_ACCOUNT_ID"]);
  const endpoint = firstNonEmpty(
    process.env["MEDIA_OBJECT_ENDPOINT"],
    process.env["R2_ENDPOINT"],
    process.env["LOCALSTACK_ENDPOINT"],
    accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined,
  );
  const isLocalEndpoint = isLocalStorageEndpoint(endpoint);
  const production =
    process.env["NODE_ENV"]?.trim().toLowerCase() === "production";
  const controlledProviderTest = isControlledProviderTestRuntime(process.env);
  const autoCreateBucket = parseBoolean(
    process.env["MEDIA_OBJECT_AUTO_CREATE_BUCKET"],
    !production && isLocalEndpoint,
  );

  if (production && isLocalEndpoint && !controlledProviderTest) {
    throw new Error("media_storage_local_endpoint_forbidden_in_production");
  }
  if (production && autoCreateBucket && !controlledProviderTest) {
    throw new Error("media_storage_auto_create_forbidden_in_production");
  }
  if (controlledProviderTest && !isLocalEndpoint) {
    throw new Error("media_storage_test_runtime_requires_local_endpoint");
  }

  return {
    bucket:
      firstNonEmpty(
        process.env["MEDIA_OBJECT_BUCKET"],
        process.env["R2_BUCKET_NAME"],
      ) ?? DEFAULT_BUCKET,
    region:
      firstNonEmpty(
        process.env["MEDIA_OBJECT_REGION"],
        process.env["AWS_DEFAULT_REGION"],
      ) ?? (accountId ? "auto" : DEFAULT_REGION),
    endpoint,
    forcePathStyle: parseBoolean(
      process.env["MEDIA_OBJECT_FORCE_PATH_STYLE"],
      Boolean(endpoint),
    ),
    autoCreateBucket,
  };
}

function buildClient(): {
  client: S3Client;
  config: MediaStorageConfig;
  bucketReady: Promise<void> | null;
} {
  const config = readMediaStorageConfig();
  const isLocalEndpoint = isLocalStorageEndpoint(config.endpoint);
  const accessKeyId = firstNonEmpty(
    process.env["MEDIA_OBJECT_ACCESS_KEY_ID"],
    process.env["R2_ACCESS_KEY_ID"],
    process.env["AWS_ACCESS_KEY_ID"],
    isLocalEndpoint ? "test" : undefined,
  );
  const secretAccessKey = firstNonEmpty(
    process.env["MEDIA_OBJECT_SECRET_ACCESS_KEY"],
    process.env["R2_SECRET_ACCESS_KEY"],
    process.env["AWS_SECRET_ACCESS_KEY"],
    isLocalEndpoint ? "test" : undefined,
  );

  if (!accessKeyId || !secretAccessKey) {
    throw new Error("media_storage_credentials_missing");
  }

  const client = new S3Client({
    region: config.region,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    forcePathStyle: config.forcePathStyle,
    // Presigning a PutObject without a Body otherwise makes current AWS SDK
    // versions add an empty-body CRC32 query parameter. Only use checksums
    // when Stonegate explicitly supplies one for a compatible provider.
    requestChecksumCalculation: "WHEN_REQUIRED",
    credentials: { accessKeyId, secretAccessKey },
  });
  return { client, config, bucketReady: null };
}

function getStorage(): {
  client: S3Client;
  config: MediaStorageConfig;
  bucketReady: Promise<void> | null;
} {
  const signature = [
    process.env["MEDIA_OBJECT_ENDPOINT"],
    process.env["R2_ENDPOINT"],
    process.env["LOCALSTACK_ENDPOINT"],
    process.env["MEDIA_OBJECT_BUCKET"],
    process.env["R2_BUCKET_NAME"],
    process.env["MEDIA_OBJECT_REGION"],
    process.env["MEDIA_OBJECT_AUTO_CREATE_BUCKET"],
    process.env["MEDIA_OBJECT_ACCESS_KEY_ID"],
    process.env["R2_ACCESS_KEY_ID"],
    process.env["AWS_ACCESS_KEY_ID"],
    process.env["NODE_ENV"],
    process.env["E2E_RUN_ID"],
    process.env["TEAM_CRM_AUDIT_MODE"],
  ].join("|");
  if (!cached || cached.signature !== signature) {
    cached = { signature, ...buildClient() };
  }
  return cached;
}

async function ensureBucket(): Promise<void> {
  const storage = getStorage();
  if (!storage.config.autoCreateBucket) return;
  if (!storage.bucketReady) {
    storage.bucketReady = (async () => {
      try {
        await runStorageRequest("head_bucket", () =>
          storage.client.send(
            new HeadBucketCommand({ Bucket: storage.config.bucket }),
          ),
        );
      } catch {
        await runStorageRequest("create_bucket", () =>
          storage.client.send(
            new CreateBucketCommand({ Bucket: storage.config.bucket }),
          ),
        );
      }
      const configuredSiteUrl =
        process.env["NEXT_PUBLIC_SITE_URL"] ??
        process.env["SITE_URL"] ??
        "http://localhost:3000";
      let siteOrigin = "http://localhost:3000";
      try {
        siteOrigin = new URL(configuredSiteUrl).origin;
      } catch {
        // Local auto-created buckets are only used in development and E2E.
      }
      await runStorageRequest("put_bucket_cors", () =>
        storage.client.send(
          new PutBucketCorsCommand({
            Bucket: storage.config.bucket,
            CORSConfiguration: {
              CORSRules: [
                {
                  AllowedHeaders: ["*"],
                  AllowedMethods: ["GET", "HEAD", "PUT"],
                  AllowedOrigins: [siteOrigin],
                  ExposeHeaders: ["ETag", "x-amz-checksum-sha256"],
                  MaxAgeSeconds: 3_600,
                },
              ],
            },
          }),
        ),
      );
    })();
  }
  await storage.bucketReady;
}

export function getMediaStorageBucket(): string {
  return getStorage().config.bucket;
}

export function getMediaStorageProvider(): "r2" | "s3" {
  const endpoint = getStorage().config.endpoint ?? "";
  return process.env["R2_ACCOUNT_ID"] ||
    /(?:r2\.cloudflarestorage\.com|cloudflare)/i.test(endpoint)
    ? "r2"
    : "s3";
}

export async function verifyMediaStorageBucketAccess(
  timeoutMs = 5_000,
): Promise<{ bucket: string; provider: "r2" | "s3" }> {
  const boundedTimeoutMs = Math.min(Math.max(timeoutMs, 500), 15_000);
  try {
    const storage = getStorage();
    await storage.client.send(
      new HeadBucketCommand({ Bucket: storage.config.bucket }),
      { abortSignal: AbortSignal.timeout(boundedTimeoutMs) },
    );
    return {
      bucket: storage.config.bucket,
      provider: getMediaStorageProvider(),
    };
  } catch (error) {
    throw new Error(storageFailureDetail("head_bucket", error));
  }
}

export async function createMediaUploadUrl(input: {
  key: string;
  contentType: string;
  byteLength: number;
  checksumSha256Hex?: string | null;
  expiresInSeconds?: number;
}): Promise<{ url: string; headers: Record<string, string>; expiresAt: Date }> {
  await ensureBucket();
  const storage = getStorage();
  const provider = getMediaStorageProvider();
  // R2 does not support a full-object SHA-256 checksum on a single PutObject.
  // Keep the client digest in PostgreSQL and verify it from the downloaded
  // staging bytes during finalization instead of signing an unsupported R2
  // request header. Browser JavaScript also cannot control Content-Length, so
  // requiring it in R2's signed headers breaks uploads on Safari. Finalization
  // verifies both the byte length and checksum after the staging upload.
  // S3-compatible development storage can still validate both at upload time.
  const checksum =
    provider === "s3" && input.checksumSha256Hex
      ? Buffer.from(input.checksumSha256Hex, "hex").toString("base64")
      : undefined;
  const command = new PutObjectCommand({
    Bucket: storage.config.bucket,
    Key: input.key,
    ContentType: input.contentType,
    ...(provider === "s3" ? { ContentLength: input.byteLength } : {}),
    ...(checksum ? { ChecksumSHA256: checksum } : {}),
  });
  const expiresInSeconds = Math.min(
    Math.max(input.expiresInSeconds ?? 600, 30),
    900,
  );
  const url = await getSignedUrl(storage.client, command, {
    expiresIn: expiresInSeconds,
  });
  return {
    url,
    headers: {
      "content-type": input.contentType,
      ...(checksum ? { "x-amz-checksum-sha256": checksum } : {}),
    },
    expiresAt: new Date(Date.now() + expiresInSeconds * 1_000),
  };
}

export async function createMediaReadUrl(
  key: string,
  expiresInSeconds = 60,
): Promise<string> {
  await ensureBucket();
  const storage = getStorage();
  return getSignedUrl(
    storage.client,
    new GetObjectCommand({ Bucket: storage.config.bucket, Key: key }),
    { expiresIn: Math.min(Math.max(expiresInSeconds, 15), 300) },
  );
}

export async function headMediaObject(key: string): Promise<StoredObjectHead> {
  await ensureBucket();
  const storage = getStorage();
  const result = await runStorageRequest("head_object", () =>
    storage.client.send(
      new HeadObjectCommand({ Bucket: storage.config.bucket, Key: key }),
    ),
  );
  return {
    byteLength:
      typeof result.ContentLength === "number" ? result.ContentLength : null,
    contentType: result.ContentType ?? null,
    checksumSha256: result.ChecksumSHA256 ?? null,
  };
}

export async function getMediaObject(
  key: string,
  maxBytes = MAX_BUFFERED_OBJECT_BYTES,
): Promise<Buffer> {
  await ensureBucket();
  const storage = getStorage();
  const result = await runStorageRequest("get_object", () =>
    storage.client.send(
      new GetObjectCommand({ Bucket: storage.config.bucket, Key: key }),
    ),
  );
  if (
    typeof result.ContentLength === "number" &&
    result.ContentLength > maxBytes
  ) {
    throw new Error("media_object_too_large");
  }
  if (!result.Body) throw new Error("media_object_empty");
  const bytes = await result.Body.transformToByteArray();
  if (bytes.byteLength > maxBytes) throw new Error("media_object_too_large");
  return Buffer.from(bytes);
}

export async function putMediaObject(input: {
  key: string;
  body: Buffer;
  contentType: string;
  cacheControl?: string;
}): Promise<void> {
  await ensureBucket();
  const storage = getStorage();
  await runStorageRequest("put_object", () =>
    storage.client.send(
      new PutObjectCommand({
        Bucket: storage.config.bucket,
        Key: input.key,
        Body: input.body,
        ContentLength: input.body.byteLength,
        ContentType: input.contentType,
        CacheControl:
          input.cacheControl ?? "private, max-age=31536000, immutable",
      }),
    ),
  );
}

export async function deleteMediaObject(key: string): Promise<void> {
  await ensureBucket();
  const storage = getStorage();
  await runStorageRequest("delete_object", () =>
    storage.client.send(
      new DeleteObjectCommand({ Bucket: storage.config.bucket, Key: key }),
    ),
  );
}

export function resetMediaStorageForTests(): void {
  cached?.client.destroy();
  cached = undefined;
}
