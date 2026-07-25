import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import {
  getDb,
  inboxMediaUploads,
  instantQuoteMedia,
  mediaAssets,
  type DatabaseClient,
} from "@/db";
import {
  MAX_APPOINTMENT_IMAGE_BYTES,
  normalizeAppointmentImage,
} from "@/lib/appointment-image";
import { arePublicQuoteMediaUploadsEnabled } from "@/lib/feature-flags";
import {
  createMediaReadUrl,
  getMediaStorageBucket,
  getMediaStorageProvider,
  headMediaObject,
  putMediaObject,
} from "@/lib/media-storage";

const PUBLIC_UPLOAD_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const CLAIMED_PUBLIC_READ_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const PUBLIC_UPLOAD_TOKEN_METADATA_KEY = "publicUploadTokenSha256";
const PUBLIC_READ_EXPIRES_METADATA_KEY = "publicReadExpiresAt";
const NEW_UPLOAD_PATH =
  /^\/api\/public\/junk-quote\/uploads\/([0-9a-f-]{36})\/?$/iu;
const LEGACY_UPLOAD_PATH =
  /^\/api\/public\/inbox\/uploads\/([0-9a-f-]{36})\/?$/iu;

type TransactionClient = Parameters<DatabaseClient["transaction"]>[0] extends (
  tx: infer Tx,
) => Promise<unknown>
  ? Tx
  : never;

export type PublicQuoteMediaDatabase = DatabaseClient | TransactionClient;

export type PreparedPublicQuoteMediaReference = {
  kind: "object_storage" | "legacy_database";
  assetId: string;
  sortOrder: number;
  referenceUrl: string;
  analysisUrl: string;
};

export class PublicQuoteMediaError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message = code,
  ) {
    super(message);
    this.name = "PublicQuoteMediaError";
  }
}

function sanitizeFilename(value: string | null | undefined): string {
  const normalized = Array.from((value ?? "").normalize("NFKC"))
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? "_" : character;
    })
    .join("");
  return (
    normalized.replace(/[/\\]/gu, "_").trim().slice(0, 180) || "customer-photo"
  );
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function tokenMatches(expectedHash: unknown, token: string): boolean {
  if (
    typeof expectedHash !== "string" ||
    !/^[a-f0-9]{64}$/iu.test(expectedHash)
  ) {
    return false;
  }
  const expected = Buffer.from(expectedHash.toLowerCase(), "hex");
  const actual = Buffer.from(sha256(token), "hex");
  return (
    expected.byteLength === actual.byteLength &&
    timingSafeEqual(expected, actual)
  );
}

function plaintextTokenMatches(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected, "utf8");
  const actualBytes = Buffer.from(actual, "utf8");
  return (
    expectedBytes.byteLength === actualBytes.byteLength &&
    timingSafeEqual(expectedBytes, actualBytes)
  );
}

export function resolvePublicMediaApiBaseUrl(
  fallbackOrigin: string,
): string | null {
  const configured = (
    process.env["API_BASE_URL"] ??
    process.env["NEXT_PUBLIC_API_BASE_URL"] ??
    ""
  ).trim();
  for (const candidate of [configured, fallbackOrigin]) {
    if (!candidate.trim()) continue;
    const withScheme = /^https?:\/\//iu.test(candidate)
      ? candidate
      : `https://${candidate}`;
    try {
      const url = new URL(withScheme);
      const hostname = url.hostname.toLowerCase();
      const local =
        hostname === "localhost" ||
        hostname === "0.0.0.0" ||
        hostname === "127.0.0.1" ||
        hostname.endsWith(".internal");
      if (process.env["NODE_ENV"] === "production" && local) continue;
      return url.toString().replace(/\/+$/u, "");
    } catch {
      // Try the next configured origin.
    }
  }
  return null;
}

export function buildPublicInstantQuoteMediaReferenceUrl(input: {
  baseUrl: string;
  assetId: string;
  token: string;
}): string {
  const url = new URL(
    `/api/public/junk-quote/uploads/${input.assetId}`,
    input.baseUrl,
  );
  url.searchParams.set("token", input.token);
  return url.toString();
}

export function parsePublicInstantQuoteMediaReference(value: string): {
  kind: "object_storage" | "legacy_database";
  id: string;
  token: string;
} | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol)) return null;
  const token = url.searchParams.get("token")?.trim() ?? "";
  if (!token || token.length > 256) return null;
  const objectStorageMatch = NEW_UPLOAD_PATH.exec(url.pathname);
  if (objectStorageMatch?.[1]) {
    return {
      kind: "object_storage",
      id: objectStorageMatch[1].toLowerCase(),
      token,
    };
  }
  const legacyMatch = LEGACY_UPLOAD_PATH.exec(url.pathname);
  if (legacyMatch?.[1]) {
    return {
      kind: "legacy_database",
      id: legacyMatch[1].toLowerCase(),
      token,
    };
  }
  return null;
}

export function parseUniquePublicInstantQuoteMediaReferences(
  values: readonly string[],
): Array<{
  kind: "object_storage" | "legacy_database";
  id: string;
  token: string;
}> {
  const parsedReferences = values.map((value) => {
    const parsed = parsePublicInstantQuoteMediaReference(value);
    if (!parsed) {
      throw new PublicQuoteMediaError("unrecognized_photo_reference", 400);
    }
    return parsed;
  });
  const seen = new Set<string>();
  for (const reference of parsedReferences) {
    const key = `${reference.kind}:${reference.id}`;
    if (seen.has(key)) {
      throw new PublicQuoteMediaError("duplicate_photo_reference", 400);
    }
    seen.add(key);
  }
  return parsedReferences;
}

export async function createPublicInstantQuoteMediaUpload(input: {
  bytes: Buffer;
  declaredContentType?: string | null;
  originalFilename?: string | null;
}): Promise<{ assetId: string; token: string }> {
  if (!arePublicQuoteMediaUploadsEnabled()) {
    throw new PublicQuoteMediaError("media_writes_disabled", 503);
  }
  if (
    input.bytes.byteLength <= 0 ||
    input.bytes.byteLength > MAX_APPOINTMENT_IMAGE_BYTES
  ) {
    throw new PublicQuoteMediaError("image_size_invalid", 400);
  }

  let normalized;
  try {
    normalized = await normalizeAppointmentImage(
      input.bytes,
      input.declaredContentType,
    );
  } catch (error) {
    throw new PublicQuoteMediaError(
      "invalid_image",
      422,
      error instanceof Error ? error.message : "invalid_image",
    );
  }

  const db = getDb();
  const assetId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const prefix = `instant-quotes/${assetId}`;
  const originalObjectKey = `${prefix}/original.jpg`;
  const displayObjectKey = `${prefix}/display.jpg`;
  const thumbnailObjectKey = `${prefix}/thumbnail.jpg`;
  const stagingExpiresAt = new Date(Date.now() + PUBLIC_UPLOAD_LIFETIME_MS);
  const sourceMetadata = {
    [PUBLIC_UPLOAD_TOKEN_METADATA_KEY]: sha256(token),
    inputContentType: normalized.inputContentType,
    inputByteSize: input.bytes.byteLength,
    inputSha256: normalized.inputSha256,
  };

  await db.insert(mediaAssets).values({
    id: assetId,
    storageProvider: getMediaStorageProvider(),
    storageBucket: getMediaStorageBucket(),
    originalObjectKey,
    displayObjectKey,
    thumbnailObjectKey,
    source: "instant_quote_upload",
    sourceKey: `instant_quote_upload:${assetId}`,
    status: "processing",
    originalFilename: sanitizeFilename(input.originalFilename),
    contentType: normalized.contentType,
    byteSize: normalized.original.byteLength,
    width: normalized.width,
    height: normalized.height,
    sha256: normalized.sha256,
    sourceMetadata,
    stagingExpiresAt,
  });

  try {
    await Promise.all([
      putMediaObject({
        key: originalObjectKey,
        body: normalized.original,
        contentType: normalized.contentType,
      }),
      putMediaObject({
        key: displayObjectKey,
        body: normalized.display,
        contentType: normalized.contentType,
      }),
      putMediaObject({
        key: thumbnailObjectKey,
        body: normalized.thumbnail,
        contentType: normalized.contentType,
      }),
    ]);
    const heads = await Promise.all([
      headMediaObject(originalObjectKey),
      headMediaObject(displayObjectKey),
      headMediaObject(thumbnailObjectKey),
    ]);
    const expectedSizes = [
      normalized.original.byteLength,
      normalized.display.byteLength,
      normalized.thumbnail.byteLength,
    ];
    if (heads.some((head, index) => head.byteLength !== expectedSizes[index])) {
      throw new Error("media_storage_verification_failed");
    }
    await db
      .update(mediaAssets)
      .set({
        status: "staging",
        readyAt: new Date(),
        processingError: null,
        updatedAt: new Date(),
      })
      .where(eq(mediaAssets.id, assetId));
  } catch (error) {
    await db
      .update(mediaAssets)
      .set({
        status: "failed",
        processingError:
          error instanceof Error ? error.message.slice(0, 1_000) : "unknown",
        updatedAt: new Date(),
      })
      .where(eq(mediaAssets.id, assetId))
      .catch(() => undefined);
    throw new PublicQuoteMediaError("media_storage_failed", 502);
  }

  return { assetId, token };
}

export async function resolvePublicInstantQuoteMediaReferences(input: {
  urls: readonly string[];
  baseUrl: string;
  now?: Date;
  database?: PublicQuoteMediaDatabase;
}): Promise<PreparedPublicQuoteMediaReference[]> {
  if (input.urls.length > 10) {
    throw new PublicQuoteMediaError("too_many_files", 400);
  }
  const db = input.database ?? getDb();
  const now = input.now ?? new Date();
  const prepared: PreparedPublicQuoteMediaReference[] = [];
  const parsedReferences = parseUniquePublicInstantQuoteMediaReferences(
    input.urls,
  );

  for (const [sortOrder, parsed] of parsedReferences.entries()) {
    if (parsed.kind === "legacy_database") {
      const [legacy] = await db
        .select({
          id: inboxMediaUploads.id,
          token: inboxMediaUploads.token,
          expiresAt: inboxMediaUploads.expiresAt,
        })
        .from(inboxMediaUploads)
        .where(eq(inboxMediaUploads.id, parsed.id))
        .limit(1);
      if (!legacy || !plaintextTokenMatches(legacy.token, parsed.token)) {
        throw new PublicQuoteMediaError("photo_reference_unauthorized", 401);
      }
      if (legacy.expiresAt <= now) {
        throw new PublicQuoteMediaError("photo_reference_expired", 410);
      }
      const referenceUrl = new URL(
        `/api/public/inbox/uploads/${legacy.id}`,
        input.baseUrl,
      );
      referenceUrl.searchParams.set("token", parsed.token);
      prepared.push({
        kind: "legacy_database",
        assetId: legacy.id,
        sortOrder,
        referenceUrl: referenceUrl.toString(),
        analysisUrl: referenceUrl.toString(),
      });
      continue;
    }

    const [asset] = await db
      .select({
        id: mediaAssets.id,
        status: mediaAssets.status,
        displayObjectKey: mediaAssets.displayObjectKey,
        originalObjectKey: mediaAssets.originalObjectKey,
        sourceMetadata: mediaAssets.sourceMetadata,
        stagingExpiresAt: mediaAssets.stagingExpiresAt,
        contactId: mediaAssets.contactId,
        deletedAt: mediaAssets.deletedAt,
      })
      .from(mediaAssets)
      .where(eq(mediaAssets.id, parsed.id))
      .limit(1);
    if (
      !asset ||
      asset.deletedAt ||
      !tokenMatches(
        asset.sourceMetadata?.[PUBLIC_UPLOAD_TOKEN_METADATA_KEY],
        parsed.token,
      )
    ) {
      throw new PublicQuoteMediaError("photo_reference_unauthorized", 401);
    }
    if (
      asset.status !== "staging" ||
      asset.contactId ||
      !asset.stagingExpiresAt
    ) {
      throw new PublicQuoteMediaError("photo_reference_already_claimed", 409);
    }
    if (asset.stagingExpiresAt <= now) {
      throw new PublicQuoteMediaError("photo_reference_expired", 410);
    }
    const objectKey = asset.displayObjectKey ?? asset.originalObjectKey;
    prepared.push({
      kind: "object_storage",
      assetId: asset.id,
      sortOrder,
      referenceUrl: buildPublicInstantQuoteMediaReferenceUrl({
        baseUrl: input.baseUrl,
        assetId: asset.id,
        token: parsed.token,
      }),
      analysisUrl: await createMediaReadUrl(objectKey, 300),
    });
  }

  return prepared;
}

export async function claimPublicInstantQuoteMediaReferences(input: {
  instantQuoteId: string;
  contactId: string;
  references: readonly PreparedPublicQuoteMediaReference[];
  database?: PublicQuoteMediaDatabase;
  now?: Date;
}): Promise<number> {
  if (
    input.references.some((reference) => reference.kind === "object_storage") &&
    !arePublicQuoteMediaUploadsEnabled()
  ) {
    throw new PublicQuoteMediaError("media_writes_disabled", 503);
  }
  const db = input.database ?? getDb();
  const now = input.now ?? new Date();
  let claimed = 0;

  for (const reference of input.references) {
    if (reference.kind !== "object_storage") continue;
    const [asset] = await db
      .select({
        id: mediaAssets.id,
        status: mediaAssets.status,
        contactId: mediaAssets.contactId,
        stagingExpiresAt: mediaAssets.stagingExpiresAt,
        sourceMetadata: mediaAssets.sourceMetadata,
        deletedAt: mediaAssets.deletedAt,
      })
      .from(mediaAssets)
      .where(eq(mediaAssets.id, reference.assetId))
      .limit(1)
      .for("update");
    if (!asset || asset.deletedAt) {
      throw new PublicQuoteMediaError("photo_reference_not_found", 404);
    }
    const [existingLink] = await db
      .select({
        id: instantQuoteMedia.id,
        instantQuoteId: instantQuoteMedia.instantQuoteId,
      })
      .from(instantQuoteMedia)
      .where(eq(instantQuoteMedia.mediaAssetId, asset.id))
      .limit(1);
    if (existingLink && existingLink.instantQuoteId !== input.instantQuoteId) {
      throw new PublicQuoteMediaError("photo_reference_already_claimed", 409);
    }
    if (asset.contactId && asset.contactId !== input.contactId) {
      throw new PublicQuoteMediaError("cross_contact_media_forbidden", 409);
    }
    if (
      !existingLink &&
      (asset.status !== "staging" ||
        !asset.stagingExpiresAt ||
        asset.stagingExpiresAt <= now)
    ) {
      throw new PublicQuoteMediaError("photo_reference_expired", 410);
    }

    if (!existingLink) {
      await db
        .update(mediaAssets)
        .set({
          source: "instant_quote",
          status: "ready",
          contactId: input.contactId,
          stagingExpiresAt: null,
          sourceMetadata: {
            ...(asset.sourceMetadata ?? {}),
            claimedInstantQuoteId: input.instantQuoteId,
            claimedAt: now.toISOString(),
            [PUBLIC_READ_EXPIRES_METADATA_KEY]: new Date(
              now.getTime() + CLAIMED_PUBLIC_READ_LIFETIME_MS,
            ).toISOString(),
          },
          readyAt: now,
          processingError: null,
          updatedAt: now,
        })
        .where(
          and(eq(mediaAssets.id, asset.id), isNull(mediaAssets.deletedAt)),
        );
      await db
        .insert(instantQuoteMedia)
        .values({
          instantQuoteId: input.instantQuoteId,
          mediaAssetId: asset.id,
          sortOrder: reference.sortOrder,
        })
        .onConflictDoNothing();
      claimed += 1;
    }
  }

  return claimed;
}

export async function resolvePublicInstantQuoteMediaRead(input: {
  assetId: string;
  token: string;
  now?: Date;
}): Promise<{
  url: string;
  contentType: string;
  byteLength: number | null;
}> {
  const db = getDb();
  const now = input.now ?? new Date();
  const [asset] = await db
    .select({
      id: mediaAssets.id,
      status: mediaAssets.status,
      displayObjectKey: mediaAssets.displayObjectKey,
      originalObjectKey: mediaAssets.originalObjectKey,
      contentType: mediaAssets.contentType,
      byteSize: mediaAssets.byteSize,
      sourceMetadata: mediaAssets.sourceMetadata,
      stagingExpiresAt: mediaAssets.stagingExpiresAt,
      deletedAt: mediaAssets.deletedAt,
    })
    .from(mediaAssets)
    .where(eq(mediaAssets.id, input.assetId))
    .limit(1);
  if (
    !asset ||
    asset.deletedAt ||
    !tokenMatches(
      asset.sourceMetadata?.[PUBLIC_UPLOAD_TOKEN_METADATA_KEY],
      input.token,
    )
  ) {
    throw new PublicQuoteMediaError("photo_reference_unauthorized", 401);
  }
  if (!["staging", "ready"].includes(asset.status)) {
    throw new PublicQuoteMediaError("photo_reference_unavailable", 409);
  }
  if (
    asset.status === "staging" &&
    (!asset.stagingExpiresAt || asset.stagingExpiresAt <= now)
  ) {
    throw new PublicQuoteMediaError("photo_reference_expired", 410);
  }
  if (asset.status === "ready") {
    const publicReadExpiresAtValue =
      asset.sourceMetadata?.[PUBLIC_READ_EXPIRES_METADATA_KEY];
    const publicReadExpiresAt =
      typeof publicReadExpiresAtValue === "string"
        ? new Date(publicReadExpiresAtValue)
        : null;
    if (
      !publicReadExpiresAt ||
      !Number.isFinite(publicReadExpiresAt.getTime()) ||
      publicReadExpiresAt <= now
    ) {
      throw new PublicQuoteMediaError("photo_reference_expired", 410);
    }
  }
  const objectKey = asset.displayObjectKey ?? asset.originalObjectKey;
  return {
    url: await createMediaReadUrl(objectKey, 60),
    contentType: asset.contentType ?? "image/jpeg",
    byteLength: asset.displayObjectKey ? null : asset.byteSize,
  };
}
