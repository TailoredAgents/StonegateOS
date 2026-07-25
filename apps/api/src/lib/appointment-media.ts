import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent } from "undici";
import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import {
  appointmentAttachments,
  appointmentMedia,
  appointments,
  conversationMessages,
  conversationThreads,
  getDb,
  instantQuoteMedia,
  instantQuotes,
  leads,
  mediaAssets,
  type DatabaseClient,
} from "@/db";
import {
  MAX_APPOINTMENT_IMAGE_BYTES,
  normalizeAppointmentImage,
  validateDeclaredAppointmentImage,
} from "@/lib/appointment-image";
import {
  createMediaReadUrl,
  createMediaUploadUrl,
  deleteMediaObject,
  getMediaObject,
  getMediaStorageBucket,
  getMediaStorageProvider,
  headMediaObject,
  putMediaObject,
} from "@/lib/media-storage";
import { recordAuditEvent } from "@/lib/audit";

export const MAX_APPOINTMENT_MEDIA_BATCH = 10;
export const MAX_APPOINTMENT_MEDIA_COUNT = 50;
export const MAX_QUOTED_SCOPE_LENGTH = 4_000;
export const MAX_MEDIA_CAPTION_LENGTH = 500;
export const AUTOMATIC_BOOKING_MEDIA_STATUSES = [
  "staging",
  "processing",
  "failed",
  "ready",
] as const;
const STAGING_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const RECENT_UNASSIGNED_MEDIA_MS = 30 * 24 * 60 * 60 * 1_000;
export const MEDIA_RESTORE_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
export const REMOTE_MEDIA_FETCH_TIMEOUT_MS = 20_000;

export type RemoteMediaProvider = "twilio" | "facebook";

const RETRYABLE_REMOTE_MEDIA_SOURCES = new Set([
  "twilio_mms",
  "facebook_messenger",
  "instant_quote",
  "legacy_attachment",
]);

export function shouldExpireIncompleteMediaAsset(input: {
  status: string;
  stagingExpiresAt: Date | null;
  now: Date;
}): boolean {
  return (
    ["staging", "processing", "failed"].includes(input.status) &&
    input.stagingExpiresAt !== null &&
    input.stagingExpiresAt <= input.now
  );
}

export function canRetryExpiredImportedMediaAsset(input: {
  source: string;
  status: string;
  deletedAt: Date | null;
  hasActiveAppointmentLink: boolean;
  hasDeletedAppointmentLink: boolean;
}): boolean {
  return (
    RETRYABLE_REMOTE_MEDIA_SOURCES.has(input.source) &&
    ["expired", "deleted"].includes(input.status) &&
    input.deletedAt !== null &&
    (input.hasActiveAppointmentLink || !input.hasDeletedAppointmentLink)
  );
}

export type AppointmentMediaSummary = {
  readyCount: number;
  pendingCount: number;
  coverMediaId: string | null;
  needsScope: boolean;
};

export type AppointmentMediaItem = {
  id: string;
  assetId: string;
  status: string;
  caption: string | null;
  sortOrder: number;
  isCover: boolean;
  purpose: string;
  source: string;
  filename: string | null;
  contentType: string | null;
  width: number | null;
  height: number | null;
  byteSize: number | null;
  createdAt: string;
  readyAt: string | null;
  thumbnailUrl: string | null;
  displayUrl: string | null;
  originalUrl: string | null;
  error?: string | null;
};

export type CreateUploadIntentInput = {
  clientId: string;
  filename: string;
  contentType: string;
  byteLength: number;
  checksumSha256?: string | null;
  caption?: string | null;
};

export type MediaImportResult = {
  assetId: string;
  mediaId: string | null;
  status: string;
  alreadyExists: boolean;
};

export class AppointmentMediaError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message = code,
  ) {
    super(message);
    this.name = "AppointmentMediaError";
  }
}

type TransactionClient = Parameters<DatabaseClient["transaction"]>[0] extends (
  tx: infer Tx,
) => Promise<unknown>
  ? Tx
  : never;

type MediaDatabase = DatabaseClient | TransactionClient;

type LockedAppointment = {
  id: string;
  contactId: string | null;
  status: string;
  quotedScopeText: string | null;
};

/**
 * Returns a complete, gap-free order with `mediaId` at its requested final
 * index. The destination is intentionally interpreted as an array index rather
 * than a raw database sort value.
 */
export function moveMediaIdToIndex(
  orderedIds: readonly string[],
  mediaId: string,
  destinationIndex: number,
): string[] {
  const withoutMoved = orderedIds.filter((id) => id !== mediaId);
  const clampedIndex = Math.min(
    Math.max(0, Math.trunc(destinationIndex)),
    withoutMoved.length,
  );
  return [
    ...withoutMoved.slice(0, clampedIndex),
    mediaId,
    ...withoutMoved.slice(clampedIndex),
  ];
}

export function isWithinMediaRestoreWindow(
  deletedAt: Date,
  now = new Date(),
): boolean {
  return now.getTime() - deletedAt.getTime() < MEDIA_RESTORE_WINDOW_MS;
}

export function sortAppointmentIdsForMediaLock(
  appointmentIds: readonly string[],
): string[] {
  return [...new Set(appointmentIds)].sort((left, right) =>
    left.localeCompare(right),
  );
}

/**
 * Automatic media must never rewrite an existing appointment's lifecycle
 * status. A missing scope is a blocking review state surfaced by mediaSummary,
 * not a reason to silently move a confirmed job back to Requested.
 */
export function evaluateAutomaticMediaScopePolicy(input: {
  currentStatus: string;
  needsScope: boolean;
}): { nextStatus: string; shouldRecordWarning: boolean } {
  return {
    nextStatus: input.currentStatus,
    shouldRecordWarning: input.needsScope,
  };
}

export function appointmentStatusRequiresQuotedScope(status: string): boolean {
  return status === "confirmed" || status === "completed";
}

export function resolveAutomaticBookingStatusForQuotedWork<
  TStatus extends string,
>(input: {
  proposedStatus: TStatus;
  quotedScopeText: string | null | undefined;
  hasQuotedWorkMedia: boolean;
}): TStatus | "requested" {
  if (
    appointmentStatusRequiresQuotedScope(input.proposedStatus) &&
    input.hasQuotedWorkMedia &&
    cleanScope(input.quotedScopeText) === null
  ) {
    return "requested";
  }
  return input.proposedStatus;
}

export function canAutoAttachMediaToNearestAppointment(
  sourceCreatedAt: Date | null | undefined,
  now = new Date(),
): boolean {
  if (!sourceCreatedAt) return true;
  const timestamp = sourceCreatedAt.getTime();
  return (
    Number.isFinite(timestamp) &&
    timestamp >= now.getTime() - RECENT_UNASSIGNED_MEDIA_MS
  );
}

function cleanScope(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function sanitizeFilename(value: string): string {
  const normalized = Array.from(value.normalize("NFKC"))
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? "_" : character;
    })
    .join("");
  const name = normalized.replace(/[/\\]/g, "_").trim().slice(0, 180);
  return name || "photo";
}

function stringError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 1_000) : "unknown";
}

function isMissingObjectError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as {
    name?: unknown;
    Code?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  return (
    value.name === "NotFound" ||
    value.name === "NoSuchKey" ||
    value.Code === "NoSuchKey" ||
    value.$metadata?.httpStatusCode === 404
  );
}

async function getAppointmentOrThrow(db: MediaDatabase, appointmentId: string) {
  const [appointment] = await db
    .select({
      id: appointments.id,
      contactId: appointments.contactId,
      status: appointments.status,
      quotedScopeText: appointments.quotedScopeText,
    })
    .from(appointments)
    .where(eq(appointments.id, appointmentId))
    .limit(1);
  if (!appointment) {
    throw new AppointmentMediaError("appointment_not_found", 404);
  }
  return appointment;
}

async function lockAppointmentsForMedia(
  db: MediaDatabase,
  appointmentIds: readonly string[],
): Promise<Map<string, LockedAppointment>> {
  const rows = new Map<string, LockedAppointment>();
  const orderedIds = sortAppointmentIdsForMediaLock(appointmentIds);
  for (const appointmentId of orderedIds) {
    const [appointment] = await db
      .select({
        id: appointments.id,
        contactId: appointments.contactId,
        status: appointments.status,
        quotedScopeText: appointments.quotedScopeText,
      })
      .from(appointments)
      .where(eq(appointments.id, appointmentId))
      .limit(1)
      .for("update");
    if (!appointment) {
      throw new AppointmentMediaError("appointment_not_found", 404);
    }
    rows.set(appointment.id, appointment);
  }
  return rows;
}

async function listOrderedActiveMediaIds(
  db: MediaDatabase,
  appointmentId: string,
): Promise<string[]> {
  const rows = await db
    .select({ id: appointmentMedia.id })
    .from(appointmentMedia)
    .innerJoin(mediaAssets, eq(mediaAssets.id, appointmentMedia.mediaAssetId))
    .where(
      and(
        eq(appointmentMedia.appointmentId, appointmentId),
        isNull(appointmentMedia.deletedAt),
        isNull(mediaAssets.deletedAt),
      ),
    )
    .orderBy(
      asc(appointmentMedia.sortOrder),
      asc(appointmentMedia.createdAt),
      asc(appointmentMedia.id),
    );
  return rows.map((row) => row.id);
}

async function persistGapFreeMediaOrder(
  db: MediaDatabase,
  appointmentId: string,
  orderedIds?: readonly string[],
  now = new Date(),
): Promise<string[]> {
  const ids = orderedIds
    ? [...orderedIds]
    : await listOrderedActiveMediaIds(db, appointmentId);
  for (const [sortOrder, id] of ids.entries()) {
    await db
      .update(appointmentMedia)
      .set({ sortOrder, updatedAt: now })
      .where(
        and(
          eq(appointmentMedia.id, id),
          eq(appointmentMedia.appointmentId, appointmentId),
          isNull(appointmentMedia.deletedAt),
        ),
      );
  }
  return ids;
}

export async function createAppointmentMediaUploadIntents(input: {
  appointmentId: string;
  actorId?: string | null;
  quotedScopeText?: string | null;
  source?: "direct_upload" | "offline_mobile";
  files: CreateUploadIntentInput[];
}) {
  if (
    input.files.length < 1 ||
    input.files.length > MAX_APPOINTMENT_MEDIA_BATCH
  ) {
    throw new AppointmentMediaError("invalid_batch_size", 400);
  }

  const clientIds = new Set<string>();
  for (const file of input.files) {
    if (clientIds.has(file.clientId)) {
      throw new AppointmentMediaError("duplicate_client_id", 400);
    }
    clientIds.add(file.clientId);
    validateDeclaredAppointmentImage(file);
    if (!file.filename.trim()) {
      throw new AppointmentMediaError("filename_required", 400);
    }
    if ((file.caption?.trim().length ?? 0) > MAX_MEDIA_CAPTION_LENGTH) {
      throw new AppointmentMediaError("caption_too_long", 400);
    }
  }

  const db = getDb();
  const bucket = getMediaStorageBucket();
  const stagingExpiresAt = new Date(Date.now() + STAGING_LIFETIME_MS);
  const sourceKeys = input.files.map(
    (file) => `manual:${input.appointmentId}:${file.clientId}`,
  );
  type UploadIntentRow = {
    assetId: string;
    mediaId: string;
    status: string;
    objectKey: string;
    alreadyExists: boolean;
  };
  const intentRows = await db.transaction(async (tx) => {
    const appointment = (
      await lockAppointmentsForMedia(tx, [input.appointmentId])
    ).get(input.appointmentId);
    if (!appointment) {
      throw new AppointmentMediaError("appointment_not_found", 404);
    }
    const requestedScope =
      input.quotedScopeText === undefined
        ? cleanScope(appointment.quotedScopeText)
        : cleanScope(input.quotedScopeText);
    if (
      input.quotedScopeText !== undefined &&
      ((input.quotedScopeText?.length ?? 0) > MAX_QUOTED_SCOPE_LENGTH ||
        !requestedScope)
    ) {
      throw new AppointmentMediaError("quoted_scope_invalid", 400);
    }
    if (
      ["confirmed", "completed"].includes(appointment.status) &&
      !requestedScope
    ) {
      throw new AppointmentMediaError(
        "quoted_scope_required",
        409,
        "Add the quoted-to-remove summary before adding photos to this appointment.",
      );
    }

    const existingRows = await tx
      .select({
        sourceKey: mediaAssets.sourceKey,
        assetId: mediaAssets.id,
        status: mediaAssets.status,
        objectKey: mediaAssets.originalObjectKey,
        storageProvider: mediaAssets.storageProvider,
        storageBucket: mediaAssets.storageBucket,
        mediaId: appointmentMedia.id,
        assetDeletedAt: mediaAssets.deletedAt,
        linkDeletedAt: appointmentMedia.deletedAt,
      })
      .from(mediaAssets)
      .innerJoin(
        appointmentMedia,
        eq(appointmentMedia.mediaAssetId, mediaAssets.id),
      )
      .where(
        and(
          inArray(mediaAssets.sourceKey, sourceKeys),
          eq(appointmentMedia.appointmentId, input.appointmentId),
        ),
      );
    if (existingRows.some((row) => row.linkDeletedAt !== null)) {
      throw new AppointmentMediaError("media_removed", 410);
    }
    for (const row of existingRows) {
      assertAssetStorageLocation(row);
    }
    const existingBySourceKey = new Map(
      existingRows.flatMap((row) =>
        row.sourceKey ? ([[row.sourceKey, row]] as const) : [],
      ),
    );
    const newFiles = input.files.filter(
      (file) =>
        !existingBySourceKey.has(
          `manual:${input.appointmentId}:${file.clientId}`,
        ),
    );
    const now = new Date();
    const orderedIds = await persistGapFreeMediaOrder(
      tx,
      input.appointmentId,
      undefined,
      now,
    );
    const activeIds = new Set(orderedIds);
    const revivableRows = existingRows.filter(
      (row) =>
        (row.status === "expired" || row.assetDeletedAt !== null) &&
        !activeIds.has(row.mediaId),
    );
    if (
      orderedIds.length + newFiles.length + revivableRows.length >
      MAX_APPOINTMENT_MEDIA_COUNT
    ) {
      throw new AppointmentMediaError("appointment_media_limit_reached", 409);
    }

    if (requestedScope !== cleanScope(appointment.quotedScopeText)) {
      await tx
        .update(appointments)
        .set({ quotedScopeText: requestedScope, updatedAt: now })
        .where(eq(appointments.id, input.appointmentId));
    }

    const rowsBySourceKey = new Map<string, UploadIntentRow>();
    for (const row of existingRows) {
      if (!row.sourceKey) continue;
      const shouldRevive =
        row.status === "expired" || row.assetDeletedAt !== null;
      if (shouldRevive) {
        await tx
          .update(mediaAssets)
          .set({
            status: "staging",
            deletedAt: null,
            stagingExpiresAt,
            processingError: null,
            updatedAt: now,
          })
          .where(eq(mediaAssets.id, row.assetId));
      }
      rowsBySourceKey.set(row.sourceKey, {
        assetId: row.assetId,
        mediaId: row.mediaId,
        status: shouldRevive ? "staging" : row.status,
        objectKey: row.objectKey,
        alreadyExists: true,
      });
    }

    const finalOrder = [...orderedIds];
    if (finalOrder.length === 0) {
      await tx
        .update(appointmentMedia)
        .set({ isCover: false, updatedAt: now })
        .where(
          and(
            eq(appointmentMedia.appointmentId, input.appointmentId),
            isNull(appointmentMedia.deletedAt),
          ),
        );
    }
    for (const row of revivableRows) {
      finalOrder.push(row.mediaId);
      await tx
        .update(appointmentMedia)
        .set({
          sortOrder: finalOrder.length - 1,
          isCover: finalOrder.length === 1,
          updatedAt: now,
        })
        .where(eq(appointmentMedia.id, row.mediaId));
    }

    for (const file of newFiles) {
      const assetId = randomUUID();
      const mediaId = randomUUID();
      const safeFilename = sanitizeFilename(file.filename);
      const objectKey = `staging/appointments/${input.appointmentId}/${assetId}/${encodeURIComponent(safeFilename)}`;
      const sourceKey = `manual:${input.appointmentId}:${file.clientId}`;
      await tx.insert(mediaAssets).values({
        id: assetId,
        storageProvider: getMediaStorageProvider(),
        storageBucket: bucket,
        originalObjectKey: objectKey,
        source: input.source ?? "direct_upload",
        sourceKey,
        status: "staging",
        originalFilename: safeFilename,
        contentType: file.contentType,
        byteSize: file.byteLength,
        sha256: file.checksumSha256?.toLowerCase() ?? null,
        uploadedByMemberId: input.actorId ?? null,
        contactId: appointment.contactId,
        sourceMetadata: { clientId: file.clientId },
        stagingExpiresAt,
      });
      finalOrder.push(mediaId);
      await tx.insert(appointmentMedia).values({
        id: mediaId,
        appointmentId: input.appointmentId,
        mediaAssetId: assetId,
        purpose: "quoted_work",
        caption: cleanScope(file.caption),
        sortOrder: finalOrder.length - 1,
        isCover: finalOrder.length === 1,
        attachedByMemberId: input.actorId ?? null,
        attachmentSource: input.source ?? "direct_upload",
      });
      rowsBySourceKey.set(sourceKey, {
        assetId,
        mediaId,
        status: "staging",
        objectKey,
        alreadyExists: false,
      });
    }
    await persistGapFreeMediaOrder(tx, input.appointmentId, finalOrder, now);
    return rowsBySourceKey;
  });

  const intents = await Promise.all(
    input.files.map(async (file) => {
      const sourceKey = `manual:${input.appointmentId}:${file.clientId}`;
      const row = intentRows.get(sourceKey);
      if (!row) {
        throw new AppointmentMediaError("upload_intent_creation_failed", 500);
      }

      if (row.status === "ready" || row.status === "processing") {
        return {
          mediaId: row.mediaId,
          assetId: row.assetId,
          status: row.status,
          uploadUrl: null,
          uploadHeaders: {},
          uploadExpiresAt: null,
          alreadyExists: true,
        };
      }
      const signed = await createMediaUploadUrl({
        key: row.objectKey,
        contentType: file.contentType,
        byteLength: file.byteLength,
        checksumSha256Hex: file.checksumSha256,
      });
      return {
        mediaId: row.mediaId,
        assetId: row.assetId,
        status: row.status,
        uploadUrl: signed.url,
        uploadHeaders: signed.headers,
        uploadExpiresAt: signed.expiresAt.toISOString(),
        alreadyExists: row.alreadyExists,
      };
    }),
  );

  return intents;
}

type MediaRow = {
  id: string;
  appointmentId: string;
  assetId: string;
  storageProvider: string;
  storageBucket: string;
  contactId: string | null;
  status: string;
  caption: string | null;
  sortOrder: number;
  isCover: boolean;
  purpose: string;
  source: string;
  filename: string | null;
  contentType: string | null;
  width: number | null;
  height: number | null;
  byteSize: number | null;
  createdAt: Date;
  readyAt: Date | null;
  originalObjectKey: string;
  displayObjectKey: string | null;
  thumbnailObjectKey: string | null;
  processingError: string | null;
  sourceMetadata: Record<string, unknown> | null;
  expectedSha256: string | null;
};

async function getMediaRow(
  mediaId: string,
  db: MediaDatabase = getDb(),
): Promise<MediaRow | null> {
  const [row] = await db
    .select({
      id: appointmentMedia.id,
      appointmentId: appointmentMedia.appointmentId,
      assetId: mediaAssets.id,
      storageProvider: mediaAssets.storageProvider,
      storageBucket: mediaAssets.storageBucket,
      contactId: mediaAssets.contactId,
      status: mediaAssets.status,
      caption: appointmentMedia.caption,
      sortOrder: appointmentMedia.sortOrder,
      isCover: appointmentMedia.isCover,
      purpose: appointmentMedia.purpose,
      source: mediaAssets.source,
      filename: mediaAssets.originalFilename,
      contentType: mediaAssets.contentType,
      width: mediaAssets.width,
      height: mediaAssets.height,
      byteSize: mediaAssets.byteSize,
      createdAt: appointmentMedia.createdAt,
      readyAt: mediaAssets.readyAt,
      originalObjectKey: mediaAssets.originalObjectKey,
      displayObjectKey: mediaAssets.displayObjectKey,
      thumbnailObjectKey: mediaAssets.thumbnailObjectKey,
      processingError: mediaAssets.processingError,
      sourceMetadata: mediaAssets.sourceMetadata,
      expectedSha256: mediaAssets.sha256,
    })
    .from(appointmentMedia)
    .innerJoin(mediaAssets, eq(mediaAssets.id, appointmentMedia.mediaAssetId))
    .where(
      and(
        eq(appointmentMedia.id, mediaId),
        isNull(appointmentMedia.deletedAt),
        isNull(mediaAssets.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

function assertAssetStorageLocation(input: {
  storageProvider: string;
  storageBucket: string;
}): void {
  if (
    input.storageProvider !== getMediaStorageProvider() ||
    input.storageBucket !== getMediaStorageBucket()
  ) {
    throw new AppointmentMediaError(
      "media_storage_location_mismatch",
      503,
      "This photo belongs to a different object-storage location. No storage operation was attempted.",
    );
  }
}

async function toMediaItem(row: MediaRow): Promise<AppointmentMediaItem> {
  const ready = row.status === "ready";
  if (ready) assertAssetStorageLocation(row);
  const [originalUrl, displayUrl, thumbnailUrl] = ready
    ? await Promise.all([
        createMediaReadUrl(row.originalObjectKey, 300),
        row.displayObjectKey
          ? createMediaReadUrl(row.displayObjectKey, 300)
          : Promise.resolve(null),
        row.thumbnailObjectKey
          ? createMediaReadUrl(row.thumbnailObjectKey, 300)
          : Promise.resolve(null),
      ])
    : [null, null, null];
  return {
    id: row.id,
    assetId: row.assetId,
    status: row.status,
    caption: row.caption,
    sortOrder: row.sortOrder,
    isCover: row.isCover,
    purpose: row.purpose,
    source: row.source,
    filename: row.filename,
    contentType: row.contentType,
    width: row.width,
    height: row.height,
    byteSize: row.byteSize,
    createdAt: row.createdAt.toISOString(),
    readyAt: row.readyAt?.toISOString() ?? null,
    thumbnailUrl,
    displayUrl,
    originalUrl,
    ...(row.status === "failed"
      ? {
          error:
            "This photo could not be processed. Retry it or choose another image.",
        }
      : {}),
  };
}

export async function finalizeAppointmentMedia(input: {
  mediaId: string;
  checksumSha256?: string | null;
}): Promise<AppointmentMediaItem> {
  const db = getDb();
  let row = await getMediaRow(input.mediaId);
  if (!row) throw new AppointmentMediaError("media_not_found", 404);
  assertAssetStorageLocation(row);
  if (row.status === "ready") return toMediaItem(row);
  if (row.status === "processing") {
    throw new AppointmentMediaError("media_processing", 409);
  }
  if (!["staging", "failed"].includes(row.status)) {
    throw new AppointmentMediaError("media_not_finalizable", 409);
  }
  if (input.checksumSha256 && !/^[a-f0-9]{64}$/i.test(input.checksumSha256)) {
    throw new AppointmentMediaError("image_checksum_invalid", 400);
  }

  const [claimed] = await db
    .update(mediaAssets)
    .set({
      status: "processing",
      processingError: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(mediaAssets.id, row.assetId),
        inArray(mediaAssets.status, ["staging", "failed"]),
      ),
    )
    .returning({ id: mediaAssets.id });
  if (!claimed) {
    row = await getMediaRow(input.mediaId);
    if (row?.status === "ready") return toMediaItem(row);
    throw new AppointmentMediaError("media_processing", 409);
  }

  const stagingKey = row.originalObjectKey;
  const finalPrefix = `appointments/${row.appointmentId}/${row.assetId}`;
  const originalKey = `${finalPrefix}/original.jpg`;
  const displayKey = `${finalPrefix}/display.jpg`;
  const thumbnailKey = `${finalPrefix}/thumbnail.jpg`;
  await db
    .update(mediaAssets)
    .set({
      sourceMetadata: {
        ...(row.sourceMetadata ?? {}),
        pendingVariantObjectKeys: [originalKey, displayKey, thumbnailKey],
      },
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(mediaAssets.id, row.assetId),
        eq(mediaAssets.status, "processing"),
      ),
    );

  try {
    let head;
    try {
      head = await headMediaObject(stagingKey);
    } catch (error) {
      if (isMissingObjectError(error)) {
        throw new AppointmentMediaError("upload_not_found", 409);
      }
      throw error;
    }
    if (
      head.byteLength === null ||
      head.byteLength <= 0 ||
      head.byteLength > MAX_APPOINTMENT_IMAGE_BYTES
    ) {
      throw new AppointmentMediaError("uploaded_image_size_invalid", 400);
    }
    if (row.byteSize !== null && head.byteLength !== row.byteSize) {
      throw new AppointmentMediaError("uploaded_image_size_mismatch", 400);
    }
    const bytes = await getMediaObject(stagingKey, MAX_APPOINTMENT_IMAGE_BYTES);
    const actualSha256 = createHash("sha256").update(bytes).digest("hex");
    const expectedSha256 =
      input.checksumSha256?.toLowerCase() ?? row.expectedSha256?.toLowerCase();
    if (expectedSha256 && expectedSha256 !== actualSha256) {
      throw new AppointmentMediaError("image_checksum_mismatch", 400);
    }

    const normalized = await normalizeAppointmentImage(
      bytes,
      head.contentType ?? row.contentType,
    );
    await Promise.all([
      putMediaObject({
        key: originalKey,
        body: normalized.original,
        contentType: normalized.contentType,
      }),
      putMediaObject({
        key: displayKey,
        body: normalized.display,
        contentType: normalized.contentType,
      }),
      putMediaObject({
        key: thumbnailKey,
        body: normalized.thumbnail,
        contentType: normalized.contentType,
      }),
    ]);
    const storedHeads = await Promise.all([
      headMediaObject(originalKey),
      headMediaObject(displayKey),
      headMediaObject(thumbnailKey),
    ]);
    const expectedVariantSizes = [
      normalized.original.byteLength,
      normalized.display.byteLength,
      normalized.thumbnail.byteLength,
    ];
    if (
      storedHeads.some(
        (stored, index) => stored.byteLength !== expectedVariantSizes[index],
      )
    ) {
      throw new AppointmentMediaError("media_storage_verification_failed", 502);
    }

    await db
      .update(mediaAssets)
      .set({
        status: "ready",
        originalObjectKey: originalKey,
        displayObjectKey: displayKey,
        thumbnailObjectKey: thumbnailKey,
        contentType: normalized.contentType,
        byteSize: normalized.original.byteLength,
        width: normalized.width,
        height: normalized.height,
        sha256: normalized.sha256,
        sourceMetadata: {
          ...(row.sourceMetadata ?? {}),
          inputContentType: normalized.inputContentType,
          inputByteSize: bytes.byteLength,
          inputSha256: normalized.inputSha256,
        },
        stagingExpiresAt: null,
        readyAt: new Date(),
        processingError: null,
        updatedAt: new Date(),
      })
      .where(eq(mediaAssets.id, row.assetId));
    await db.transaction(async (tx) => {
      await lockAppointmentsForMedia(tx, [row.appointmentId]);
      await ensureAppointmentCover(tx, row.appointmentId);
    });
    if (stagingKey !== originalKey) {
      await deleteMediaObject(stagingKey).catch(() => undefined);
    }
  } catch (error) {
    await db
      .update(mediaAssets)
      .set({
        status: "failed",
        processingError: stringError(error),
        updatedAt: new Date(),
      })
      .where(eq(mediaAssets.id, row.assetId));
    if (error instanceof AppointmentMediaError) throw error;
    throw new AppointmentMediaError(
      "media_processing_failed",
      422,
      stringError(error),
    );
  }

  const completed = await getMediaRow(input.mediaId);
  if (!completed) {
    throw new AppointmentMediaError("media_finalize_read_failed", 500);
  }
  return toMediaItem(completed);
}

export async function listAppointmentMedia(appointmentId: string) {
  const db = getDb();
  const appointment = await getAppointmentOrThrow(db, appointmentId);
  const rows = await db
    .select({
      id: appointmentMedia.id,
      appointmentId: appointmentMedia.appointmentId,
      assetId: mediaAssets.id,
      storageProvider: mediaAssets.storageProvider,
      storageBucket: mediaAssets.storageBucket,
      contactId: mediaAssets.contactId,
      status: mediaAssets.status,
      caption: appointmentMedia.caption,
      sortOrder: appointmentMedia.sortOrder,
      isCover: appointmentMedia.isCover,
      purpose: appointmentMedia.purpose,
      source: mediaAssets.source,
      filename: mediaAssets.originalFilename,
      contentType: mediaAssets.contentType,
      width: mediaAssets.width,
      height: mediaAssets.height,
      byteSize: mediaAssets.byteSize,
      createdAt: appointmentMedia.createdAt,
      readyAt: mediaAssets.readyAt,
      originalObjectKey: mediaAssets.originalObjectKey,
      displayObjectKey: mediaAssets.displayObjectKey,
      thumbnailObjectKey: mediaAssets.thumbnailObjectKey,
      processingError: mediaAssets.processingError,
      sourceMetadata: mediaAssets.sourceMetadata,
      expectedSha256: mediaAssets.sha256,
    })
    .from(appointmentMedia)
    .innerJoin(mediaAssets, eq(mediaAssets.id, appointmentMedia.mediaAssetId))
    .where(
      and(
        eq(appointmentMedia.appointmentId, appointmentId),
        isNull(appointmentMedia.deletedAt),
        isNull(mediaAssets.deletedAt),
      ),
    )
    .orderBy(asc(appointmentMedia.sortOrder), asc(appointmentMedia.createdAt));
  const legacyAttachments = await db
    .select({
      id: appointmentAttachments.id,
      filename: appointmentAttachments.filename,
      contentType: appointmentAttachments.contentType,
      url: appointmentAttachments.url,
      createdAt: appointmentAttachments.createdAt,
    })
    .from(appointmentAttachments)
    .where(eq(appointmentAttachments.appointmentId, appointmentId))
    .orderBy(asc(appointmentAttachments.createdAt));
  const summary = summarizeRows(
    rows.map((row) => ({
      mediaId: row.id,
      status: row.status,
      isCover: row.isCover,
      purpose: row.purpose,
    })),
    appointment.quotedScopeText,
  );
  return {
    appointmentId,
    quotedScopeText: appointment.quotedScopeText,
    mediaSummary: summary,
    items: await Promise.all(rows.map(toMediaItem)),
    legacyAttachments: legacyAttachments.map((attachment) => ({
      ...attachment,
      createdAt: attachment.createdAt.toISOString(),
    })),
  };
}

export async function getAppointmentMediaManageOptions(
  appointmentId: string,
): Promise<{
  deletedItems: Array<{
    id: string;
    caption: string | null;
    filename: string | null;
    source: string;
    deletedAt: string;
  }>;
  reassignmentOptions: Array<{
    appointmentId: string;
    startAt: string | null;
    status: string;
    type: string;
  }>;
}> {
  const db = getDb();
  const appointment = await getAppointmentOrThrow(db, appointmentId);
  const recoverableAfter = new Date(Date.now() - MEDIA_RESTORE_WINDOW_MS);
  const [deletedRows, destinationRows] = await Promise.all([
    db
      .select({
        id: appointmentMedia.id,
        caption: appointmentMedia.caption,
        filename: mediaAssets.originalFilename,
        source: mediaAssets.source,
        deletedAt: appointmentMedia.deletedAt,
      })
      .from(appointmentMedia)
      .innerJoin(mediaAssets, eq(mediaAssets.id, appointmentMedia.mediaAssetId))
      .where(
        and(
          eq(appointmentMedia.appointmentId, appointmentId),
          isNotNull(appointmentMedia.deletedAt),
          gte(appointmentMedia.deletedAt, recoverableAfter),
          isNull(mediaAssets.deletedAt),
          ne(mediaAssets.status, "deleted"),
          ne(mediaAssets.status, "expired"),
        ),
      )
      .orderBy(asc(appointmentMedia.deletedAt), asc(appointmentMedia.id)),
    appointment.contactId
      ? db
          .select({
            appointmentId: appointments.id,
            startAt: appointments.startAt,
            status: appointments.status,
            type: appointments.type,
          })
          .from(appointments)
          .where(
            and(
              eq(appointments.contactId, appointment.contactId),
              ne(appointments.id, appointmentId),
            ),
          )
          .orderBy(
            sql`${appointments.startAt} asc nulls last`,
            asc(appointments.createdAt),
            asc(appointments.id),
          )
      : Promise.resolve([]),
  ]);
  return {
    deletedItems: deletedRows.flatMap((row) =>
      row.deletedAt
        ? [
            {
              id: row.id,
              caption: row.caption,
              filename: row.filename,
              source: row.source,
              deletedAt: row.deletedAt.toISOString(),
            },
          ]
        : [],
    ),
    reassignmentOptions: destinationRows.map((row) => ({
      appointmentId: row.appointmentId,
      startAt: row.startAt?.toISOString() ?? null,
      status: row.status,
      type: row.type,
    })),
  };
}

function summarizeRows(
  rows: Array<{
    mediaId: string;
    status: string;
    isCover: boolean;
    purpose: string;
  }>,
  quotedScopeText: string | null | undefined,
): AppointmentMediaSummary {
  const quoted = rows.filter((row) => row.purpose === "quoted_work");
  const ready = quoted.filter((row) => row.status === "ready");
  const pending = quoted.filter((row) =>
    ["staging", "processing", "failed"].includes(row.status),
  );
  return {
    readyCount: ready.length,
    pendingCount: pending.length,
    coverMediaId:
      ready.find((row) => row.isCover)?.mediaId ?? ready[0]?.mediaId ?? null,
    needsScope: quoted.length > 0 && cleanScope(quotedScopeText) === null,
  };
}

export async function getAppointmentMediaSummaryMap(
  appointmentIds: string[],
  quotedScopeByAppointmentId?: ReadonlyMap<string, string | null>,
  database?: MediaDatabase,
): Promise<Map<string, AppointmentMediaSummary>> {
  const summaries = new Map<string, AppointmentMediaSummary>();
  for (const id of appointmentIds) {
    summaries.set(id, {
      readyCount: 0,
      pendingCount: 0,
      coverMediaId: null,
      needsScope: false,
    });
  }
  if (appointmentIds.length === 0) return summaries;

  const db = database ?? getDb();
  const rows = await db
    .select({
      appointmentId: appointmentMedia.appointmentId,
      mediaId: appointmentMedia.id,
      status: mediaAssets.status,
      isCover: appointmentMedia.isCover,
      purpose: appointmentMedia.purpose,
    })
    .from(appointmentMedia)
    .innerJoin(mediaAssets, eq(mediaAssets.id, appointmentMedia.mediaAssetId))
    .where(
      and(
        inArray(appointmentMedia.appointmentId, appointmentIds),
        isNull(appointmentMedia.deletedAt),
        isNull(mediaAssets.deletedAt),
      ),
    );
  const byAppointment = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byAppointment.get(row.appointmentId) ?? [];
    list.push(row);
    byAppointment.set(row.appointmentId, list);
  }
  for (const appointmentId of appointmentIds) {
    summaries.set(
      appointmentId,
      summarizeRows(
        byAppointment.get(appointmentId) ?? [],
        quotedScopeByAppointmentId?.get(appointmentId),
      ),
    );
  }
  return summaries;
}

export async function getAppointmentScopeState(
  appointmentId: string,
  database?: MediaDatabase,
): Promise<AppointmentMediaSummary & { quotedScopeText: string | null }> {
  const db = database ?? getDb();
  const appointment = await getAppointmentOrThrow(db, appointmentId);
  const map = await getAppointmentMediaSummaryMap(
    [appointmentId],
    new Map([[appointmentId, appointment.quotedScopeText]]),
    db,
  );
  return {
    ...(map.get(appointmentId) ?? {
      readyCount: 0,
      pendingCount: 0,
      coverMediaId: null,
      needsScope: false,
    }),
    quotedScopeText: appointment.quotedScopeText,
  };
}

/**
 * Enforces the quoted-work scope invariant while holding the appointment row
 * lock. Call this from the same transaction that writes the next status so a
 * concurrent media attachment cannot slip between validation and the update.
 */
export async function assertAppointmentStatusTransitionAllowed(input: {
  appointmentId: string;
  nextStatus: string;
  database?: MediaDatabase;
}): Promise<void> {
  if (!appointmentStatusRequiresQuotedScope(input.nextStatus)) return;

  const db = input.database ?? getDb();
  const appointment = (
    await lockAppointmentsForMedia(db, [input.appointmentId])
  ).get(input.appointmentId);
  if (!appointment) {
    throw new AppointmentMediaError("appointment_not_found", 404);
  }

  const summaries = await getAppointmentMediaSummaryMap(
    [input.appointmentId],
    new Map([[input.appointmentId, appointment.quotedScopeText]]),
    db,
  );
  if (summaries.get(input.appointmentId)?.needsScope) {
    throw new AppointmentMediaError(
      "quoted_scope_required",
      409,
      "Add the quoted-to-remove summary before confirming or completing this appointment.",
    );
  }
}

/**
 * Automatic booking flows call this before inserting or confirming an
 * appointment. Recent unassigned customer media will be attached by the media
 * worker, so a booking without usable scope must remain Requested.
 */
export async function resolveAutomaticAppointmentStatusForMedia<
  TStatus extends string,
>(input: {
  proposedStatus: TStatus;
  quotedScopeText: string | null | undefined;
  contactId: string | null | undefined;
  appointmentId?: string | null;
  database?: MediaDatabase;
  now?: Date;
}): Promise<TStatus | "requested"> {
  if (
    !appointmentStatusRequiresQuotedScope(input.proposedStatus) ||
    cleanScope(input.quotedScopeText) !== null
  ) {
    return input.proposedStatus;
  }

  const db = input.database ?? getDb();
  let hasQuotedWorkMedia = false;

  if (input.appointmentId) {
    const appointment = (
      await lockAppointmentsForMedia(db, [input.appointmentId])
    ).get(input.appointmentId);
    if (appointment) {
      const summaries = await getAppointmentMediaSummaryMap(
        [input.appointmentId],
        new Map([[input.appointmentId, input.quotedScopeText ?? null]]),
        db,
      );
      const summary = summaries.get(input.appointmentId);
      hasQuotedWorkMedia =
        (summary?.readyCount ?? 0) + (summary?.pendingCount ?? 0) > 0;
    }
  }

  if (!hasQuotedWorkMedia && input.contactId) {
    const cutoff = new Date(
      (input.now ?? new Date()).getTime() - RECENT_UNASSIGNED_MEDIA_MS,
    );
    const [candidate] = await db
      .select({ id: mediaAssets.id })
      .from(mediaAssets)
      .leftJoin(
        appointmentMedia,
        eq(appointmentMedia.mediaAssetId, mediaAssets.id),
      )
      .where(
        and(
          eq(mediaAssets.contactId, input.contactId),
          inArray(mediaAssets.status, [...AUTOMATIC_BOOKING_MEDIA_STATUSES]),
          isNull(mediaAssets.deletedAt),
          isNull(appointmentMedia.id),
          gte(mediaAssets.createdAt, cutoff),
        ),
      )
      .limit(1);
    hasQuotedWorkMedia = Boolean(candidate);
  }

  return resolveAutomaticBookingStatusForQuotedWork({
    proposedStatus: input.proposedStatus,
    quotedScopeText: input.quotedScopeText,
    hasQuotedWorkMedia,
  });
}

export async function updateAppointmentQuotedScope(input: {
  appointmentId: string;
  quotedScopeText: string | null;
}): Promise<string | null> {
  const scope = cleanScope(input.quotedScopeText);
  if ((input.quotedScopeText?.length ?? 0) > MAX_QUOTED_SCOPE_LENGTH) {
    throw new AppointmentMediaError("quoted_scope_too_long", 400);
  }
  const db = getDb();
  return db.transaction(async (tx) => {
    const [appointment] = await tx
      .select({ id: appointments.id })
      .from(appointments)
      .where(eq(appointments.id, input.appointmentId))
      .limit(1)
      .for("update");
    if (!appointment) {
      throw new AppointmentMediaError("appointment_not_found", 404);
    }
    if (!scope) {
      const summary = await getAppointmentScopeState(input.appointmentId, tx);
      if (summary.readyCount + summary.pendingCount > 0) {
        throw new AppointmentMediaError("quoted_scope_required", 409);
      }
    }
    await tx
      .update(appointments)
      .set({ quotedScopeText: scope, updatedAt: new Date() })
      .where(eq(appointments.id, input.appointmentId));
    return scope;
  });
}

async function chooseReplacementCover(
  db: MediaDatabase,
  appointmentId: string,
  excludedMediaId?: string,
): Promise<void> {
  const [candidate] = await db
    .select({ id: appointmentMedia.id })
    .from(appointmentMedia)
    .innerJoin(mediaAssets, eq(mediaAssets.id, appointmentMedia.mediaAssetId))
    .where(
      and(
        eq(appointmentMedia.appointmentId, appointmentId),
        isNull(appointmentMedia.deletedAt),
        isNull(mediaAssets.deletedAt),
        eq(mediaAssets.status, "ready"),
        ...(excludedMediaId ? [ne(appointmentMedia.id, excludedMediaId)] : []),
      ),
    )
    .orderBy(asc(appointmentMedia.sortOrder), asc(appointmentMedia.createdAt))
    .limit(1);
  if (candidate) {
    await db
      .update(appointmentMedia)
      .set({ isCover: true, updatedAt: new Date() })
      .where(eq(appointmentMedia.id, candidate.id));
  }
}

async function ensureAppointmentCover(
  db: MediaDatabase,
  appointmentId: string,
): Promise<void> {
  const coverRows = await db
    .select({
      id: appointmentMedia.id,
      status: mediaAssets.status,
    })
    .from(appointmentMedia)
    .innerJoin(mediaAssets, eq(mediaAssets.id, appointmentMedia.mediaAssetId))
    .where(
      and(
        eq(appointmentMedia.appointmentId, appointmentId),
        eq(appointmentMedia.isCover, true),
        isNull(appointmentMedia.deletedAt),
        isNull(mediaAssets.deletedAt),
      ),
    );
  if (coverRows.some((row) => row.status === "ready")) return;
  if (coverRows.length > 0) {
    await db
      .update(appointmentMedia)
      .set({ isCover: false, updatedAt: new Date() })
      .where(
        and(
          eq(appointmentMedia.appointmentId, appointmentId),
          eq(appointmentMedia.isCover, true),
          isNull(appointmentMedia.deletedAt),
        ),
      );
  }
  await chooseReplacementCover(db, appointmentId);
}

export async function updateAppointmentMedia(input: {
  mediaId: string;
  caption?: string | null;
  sortOrder?: number;
  isCover?: boolean;
  appointmentId?: string;
}): Promise<AppointmentMediaItem> {
  if ((input.caption?.trim().length ?? 0) > MAX_MEDIA_CAPTION_LENGTH) {
    throw new AppointmentMediaError("caption_too_long", 400);
  }
  if (
    input.sortOrder !== undefined &&
    (!Number.isInteger(input.sortOrder) ||
      input.sortOrder < 0 ||
      input.sortOrder > 100_000)
  ) {
    throw new AppointmentMediaError("sort_order_invalid", 400);
  }
  const db = getDb();
  const hint = await getMediaRow(input.mediaId);
  if (!hint) throw new AppointmentMediaError("media_not_found", 404);
  const requestedDestinationId = input.appointmentId ?? hint.appointmentId;
  let destinationAppointmentId = requestedDestinationId;
  await db.transaction(async (tx) => {
    const now = new Date();
    const locked = await lockAppointmentsForMedia(tx, [
      hint.appointmentId,
      requestedDestinationId,
    ]);
    const existing = await getMediaRow(input.mediaId, tx);
    if (!existing) {
      throw new AppointmentMediaError("media_not_found", 404);
    }
    if (existing.appointmentId !== hint.appointmentId) {
      throw new AppointmentMediaError(
        "media_concurrent_update",
        409,
        "This photo changed while it was being updated. Refresh and try again.",
      );
    }
    destinationAppointmentId = input.appointmentId ?? existing.appointmentId;
    const source = locked.get(existing.appointmentId);
    const destination = locked.get(destinationAppointmentId);
    if (!source || !destination) {
      throw new AppointmentMediaError("appointment_not_found", 404);
    }
    const isMoving = destinationAppointmentId !== existing.appointmentId;
    if (
      isMoving &&
      (source.contactId !== destination.contactId ||
        existing.contactId !== destination.contactId)
    ) {
      throw new AppointmentMediaError("cross_contact_media_forbidden", 409);
    }
    if (
      isMoving &&
      ["confirmed", "completed"].includes(destination.status) &&
      !cleanScope(destination.quotedScopeText)
    ) {
      throw new AppointmentMediaError("quoted_scope_required", 409);
    }

    const sourceOrder = await persistGapFreeMediaOrder(
      tx,
      existing.appointmentId,
      undefined,
      now,
    );
    const destinationOrder = isMoving
      ? await persistGapFreeMediaOrder(
          tx,
          destinationAppointmentId,
          undefined,
          now,
        )
      : sourceOrder;
    if (isMoving && destinationOrder.length >= MAX_APPOINTMENT_MEDIA_COUNT) {
      throw new AppointmentMediaError("appointment_media_limit_reached", 409);
    }

    if (input.isCover === true) {
      await tx
        .update(appointmentMedia)
        .set({ isCover: false, updatedAt: now })
        .where(
          and(
            eq(appointmentMedia.appointmentId, destinationAppointmentId),
            isNull(appointmentMedia.deletedAt),
          ),
        );
    }
    await tx
      .update(appointmentMedia)
      .set({
        ...(input.caption !== undefined
          ? { caption: cleanScope(input.caption) }
          : {}),
        ...(input.sortOrder !== undefined || isMoving
          ? { sortOrder: 100_001 }
          : {}),
        ...(input.isCover !== undefined ? { isCover: input.isCover } : {}),
        ...(isMoving && input.isCover === undefined ? { isCover: false } : {}),
        ...(destinationAppointmentId !== existing.appointmentId
          ? { appointmentId: destinationAppointmentId }
          : {}),
        updatedAt: now,
      })
      .where(eq(appointmentMedia.id, input.mediaId));

    if (isMoving) {
      const destinationIndex = input.sortOrder ?? destinationOrder.length;
      await persistGapFreeMediaOrder(
        tx,
        existing.appointmentId,
        sourceOrder.filter((id) => id !== input.mediaId),
        now,
      );
      await persistGapFreeMediaOrder(
        tx,
        destinationAppointmentId,
        moveMediaIdToIndex(destinationOrder, input.mediaId, destinationIndex),
        now,
      );
    } else if (input.sortOrder !== undefined) {
      await persistGapFreeMediaOrder(
        tx,
        destinationAppointmentId,
        moveMediaIdToIndex(sourceOrder, input.mediaId, input.sortOrder),
        now,
      );
    }

    if (existing.isCover && (input.isCover === false || isMoving)) {
      await ensureAppointmentCover(tx, existing.appointmentId);
    }
    if (isMoving || input.isCover !== undefined) {
      await ensureAppointmentCover(tx, destinationAppointmentId);
    }
  });
  const updated = await getMediaRow(input.mediaId);
  if (!updated) throw new AppointmentMediaError("media_update_failed", 500);
  return toMediaItem(updated);
}

export async function deleteAppointmentMedia(
  mediaId: string,
): Promise<{ deletedId: string; appointmentId: string }> {
  const db = getDb();
  const hint = await getMediaRow(mediaId);
  if (!hint) throw new AppointmentMediaError("media_not_found", 404);
  let appointmentId = hint.appointmentId;
  await db.transaction(async (tx) => {
    const now = new Date();
    await lockAppointmentsForMedia(tx, [hint.appointmentId]);
    const row = await getMediaRow(mediaId, tx);
    if (!row) throw new AppointmentMediaError("media_not_found", 404);
    if (row.appointmentId !== hint.appointmentId) {
      throw new AppointmentMediaError(
        "media_concurrent_update",
        409,
        "This photo changed while it was being removed. Refresh and try again.",
      );
    }
    appointmentId = row.appointmentId;
    await tx
      .update(appointmentMedia)
      .set({ deletedAt: now, isCover: false, updatedAt: now })
      .where(eq(appointmentMedia.id, mediaId));
    await persistGapFreeMediaOrder(tx, row.appointmentId, undefined, now);
    if (row.isCover) {
      await ensureAppointmentCover(tx, row.appointmentId);
    }
  });
  return { deletedId: mediaId, appointmentId };
}

export async function restoreAppointmentMedia(
  mediaId: string,
): Promise<AppointmentMediaItem> {
  const db = getDb();
  const getLifecycleRow = async (database: MediaDatabase) => {
    const [row] = await database
      .select({
        id: appointmentMedia.id,
        appointmentId: appointmentMedia.appointmentId,
        assetId: mediaAssets.id,
        sortOrder: appointmentMedia.sortOrder,
        deletedAt: appointmentMedia.deletedAt,
        assetDeletedAt: mediaAssets.deletedAt,
        assetStatus: mediaAssets.status,
      })
      .from(appointmentMedia)
      .innerJoin(mediaAssets, eq(mediaAssets.id, appointmentMedia.mediaAssetId))
      .where(eq(appointmentMedia.id, mediaId))
      .limit(1);
    return row ?? null;
  };
  const hint = await getLifecycleRow(db);
  if (!hint) {
    throw new AppointmentMediaError("media_not_found", 404);
  }
  if (!hint.deletedAt) {
    const active = await getMediaRow(mediaId);
    if (!active) {
      throw new AppointmentMediaError("media_asset_unavailable", 410);
    }
    return toMediaItem(active);
  }

  await db.transaction(async (tx) => {
    const now = new Date();
    const appointment = (
      await lockAppointmentsForMedia(tx, [hint.appointmentId])
    ).get(hint.appointmentId);
    if (!appointment) {
      throw new AppointmentMediaError("appointment_not_found", 404);
    }
    await tx
      .select({ id: mediaAssets.id })
      .from(mediaAssets)
      .where(eq(mediaAssets.id, hint.assetId))
      .limit(1)
      .for("update");
    const deletedRow = await getLifecycleRow(tx);
    if (!deletedRow) {
      throw new AppointmentMediaError("media_not_found", 404);
    }
    if (deletedRow.appointmentId !== hint.appointmentId) {
      throw new AppointmentMediaError(
        "media_concurrent_update",
        409,
        "This photo changed while it was being restored. Refresh and try again.",
      );
    }
    if (!deletedRow.deletedAt) return;
    if (
      deletedRow.assetDeletedAt ||
      ["deleted", "expired", "deleting"].includes(deletedRow.assetStatus)
    ) {
      throw new AppointmentMediaError("media_asset_purged", 410);
    }
    if (!isWithinMediaRestoreWindow(deletedRow.deletedAt, now)) {
      throw new AppointmentMediaError("media_restore_window_expired", 410);
    }
    if (
      ["confirmed", "completed"].includes(appointment.status) &&
      !cleanScope(appointment.quotedScopeText)
    ) {
      throw new AppointmentMediaError("quoted_scope_required", 409);
    }
    const activeOrder = await persistGapFreeMediaOrder(
      tx,
      deletedRow.appointmentId,
      undefined,
      now,
    );
    if (activeOrder.length >= MAX_APPOINTMENT_MEDIA_COUNT) {
      throw new AppointmentMediaError("appointment_media_limit_reached", 409);
    }
    await tx
      .update(appointmentMedia)
      .set({
        deletedAt: null,
        isCover: false,
        sortOrder: 100_001,
        updatedAt: now,
      })
      .where(eq(appointmentMedia.id, mediaId));
    await persistGapFreeMediaOrder(
      tx,
      deletedRow.appointmentId,
      moveMediaIdToIndex(activeOrder, mediaId, deletedRow.sortOrder),
      now,
    );
    await ensureAppointmentCover(tx, deletedRow.appointmentId);
  });
  const restored = await getMediaRow(mediaId);
  if (!restored) {
    throw new AppointmentMediaError("media_restore_failed", 500);
  }
  return toMediaItem(restored);
}

export async function getAppointmentMediaContentUrl(input: {
  mediaId: string;
  variant: "original" | "display" | "thumbnail";
}): Promise<string> {
  const row = await getMediaRow(input.mediaId);
  if (!row) throw new AppointmentMediaError("media_not_found", 404);
  assertAssetStorageLocation(row);
  if (row.status !== "ready") {
    throw new AppointmentMediaError("media_not_ready", 409);
  }
  const key =
    input.variant === "thumbnail"
      ? row.thumbnailObjectKey
      : input.variant === "display"
        ? row.displayObjectKey
        : row.originalObjectKey;
  if (!key) throw new AppointmentMediaError("media_variant_not_found", 404);
  return createMediaReadUrl(key);
}

function parseIpv4(value: string): number | null {
  const parts = value.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 0xff)
  ) {
    return null;
  }
  return (
    (((parts[0] ?? 0) << 24) |
      ((parts[1] ?? 0) << 16) |
      ((parts[2] ?? 0) << 8) |
      (parts[3] ?? 0)) >>>
    0
  );
}

function ipv4InCidr(
  value: number,
  base: string,
  prefixLength: number,
): boolean {
  const baseValue = parseIpv4(base);
  if (baseValue === null) return false;
  const mask =
    prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  return (value & mask) === (baseValue & mask);
}

const NON_GLOBAL_IPV4_CIDRS = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const;

function isNonGlobalIpv4(value: string): boolean {
  const address = parseIpv4(value);
  return (
    address === null ||
    NON_GLOBAL_IPV4_CIDRS.some(([base, prefixLength]) =>
      ipv4InCidr(address, base, prefixLength),
    )
  );
}

function parseIpv6Section(section: string): number[] | null {
  if (!section) return [];
  const values: number[] = [];
  for (const [index, part] of section.split(":").entries()) {
    if (part.includes(".")) {
      if (index !== section.split(":").length - 1) return null;
      const ipv4 = parseIpv4(part);
      if (ipv4 === null) return null;
      values.push((ipv4 >>> 16) & 0xffff, ipv4 & 0xffff);
      continue;
    }
    if (!/^[a-f0-9]{1,4}$/iu.test(part)) return null;
    values.push(Number.parseInt(part, 16));
  }
  return values;
}

function parseIpv6(value: string): bigint | null {
  const sections = value.toLowerCase().split("::");
  if (sections.length > 2) return null;
  const left = parseIpv6Section(sections[0] ?? "");
  const right = parseIpv6Section(sections[1] ?? "");
  if (!left || !right) return null;
  const omitted = 8 - left.length - right.length;
  if (
    (sections.length === 1 && omitted !== 0) ||
    (sections.length === 2 && omitted < 1)
  ) {
    return null;
  }
  const parts =
    sections.length === 1
      ? left
      : [...left, ...Array.from({ length: omitted }, () => 0), ...right];
  if (parts.length !== 8) return null;
  return parts.reduce((result, part) => (result << 16n) | BigInt(part), 0n);
}

function ipv6InCidr(
  value: bigint,
  base: string,
  prefixLength: number,
): boolean {
  const baseValue = parseIpv6(base);
  if (baseValue === null) return false;
  const shift = BigInt(128 - prefixLength);
  return value >> shift === baseValue >> shift;
}

function isNonGlobalIpv6(value: string): boolean {
  const address = parseIpv6(value);
  if (address === null) return true;
  // IPv6 global unicast is allocated from 2000::/3. Reject transition,
  // translation, local, multicast, and future/reserved space conservatively.
  if (!ipv6InCidr(address, "2000::", 3)) return true;
  return [
    ["2001::", 23],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["3fff::", 20],
  ].some(([base, prefixLength]) =>
    ipv6InCidr(address, String(base), Number(prefixLength)),
  );
}

function isPrivateAddress(value: string): boolean {
  const version = isIP(value);
  if (version === 4) return isNonGlobalIpv4(value);
  if (version === 6) return isNonGlobalIpv6(value);
  return true;
}

type ResolvedRemoteMediaTarget = {
  url: URL;
  pinnedAddress: { address: string; family: number } | null;
};

export function createPinnedRemoteMediaAgent(pinnedAddress: {
  address: string;
  family: number;
}): Agent {
  return new Agent({
    connect: {
      // Node 20 enables address-family auto-selection by default. Undici then
      // requests an array from custom DNS lookups; this importer intentionally
      // pins one pre-validated address, so keep the scalar lookup contract.
      autoSelectFamily: false,
      lookup: (_hostname, _options, callback) => {
        callback(null, pinnedAddress.address, pinnedAddress.family);
      },
    },
  });
}

async function resolveSafeRemoteMediaTarget(
  value: string,
  provider?: string | null,
): Promise<ResolvedRemoteMediaTarget> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppointmentMediaError("remote_media_url_invalid", 400);
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const localDevelopment =
    process.env["NODE_ENV"] !== "production" &&
    ["localhost", "127.0.0.1", "::1"].includes(hostname);
  if (
    (url.protocol !== "https:" &&
      !(localDevelopment && url.protocol === "http:")) ||
    url.username ||
    url.password
  ) {
    throw new AppointmentMediaError("remote_media_url_forbidden", 400);
  }
  const normalizedProvider = normalizeRemoteMediaProvider(provider);
  if (
    normalizedProvider &&
    !localDevelopment &&
    !isAllowedRemoteMediaProviderHost(hostname, normalizedProvider)
  ) {
    throw new AppointmentMediaError(
      "remote_media_provider_host_forbidden",
      400,
    );
  }
  let pinnedAddress: ResolvedRemoteMediaTarget["pinnedAddress"] = null;
  if (!localDevelopment) {
    let addresses: Array<{ address: string; family: number }>;
    try {
      const literalFamily = isIP(hostname);
      addresses = literalFamily
        ? [{ address: hostname, family: literalFamily }]
        : await lookup(hostname, { all: true });
    } catch {
      throw new AppointmentMediaError("remote_media_host_unresolvable", 400);
    }
    if (
      addresses.length === 0 ||
      addresses.some((entry) => isPrivateAddress(entry.address))
    ) {
      throw new AppointmentMediaError("remote_media_host_forbidden", 400);
    }
    pinnedAddress = addresses[0] ?? null;
  }
  return { url, pinnedAddress };
}

export async function assertSafeRemoteMediaUrl(
  value: string,
  provider?: string | null,
): Promise<URL> {
  return (await resolveSafeRemoteMediaTarget(value, provider)).url;
}

function normalizeRemoteMediaProvider(
  provider: string | null | undefined,
): RemoteMediaProvider | null {
  const normalized = provider?.trim().toLowerCase();
  if (normalized === "twilio" || normalized === "facebook") {
    return normalized;
  }
  return null;
}

function hostnameMatchesDomain(hostname: string, domain: string): boolean {
  const normalizedHostname = hostname.toLowerCase().replace(/\.$/u, "");
  return (
    normalizedHostname === domain || normalizedHostname.endsWith(`.${domain}`)
  );
}

export function isAllowedRemoteMediaProviderHost(
  hostname: string,
  provider: RemoteMediaProvider,
): boolean {
  const normalizedHostname = hostname.toLowerCase().replace(/\.$/u, "");
  // Twilio documents this exact legacy host for unsecured Programmable
  // Messaging media. Keep the exception exact rather than allowing the shared
  // amazonaws.com suffix.
  if (
    provider === "twilio" &&
    normalizedHostname === "s3-external-1.amazonaws.com"
  ) {
    return true;
  }
  const domains =
    provider === "twilio"
      ? ["twilio.com", "twiliocdn.com"]
      : ["facebook.com", "facebook.net", "fbcdn.net", "fbsbx.com"];
  return domains.some((domain) =>
    hostnameMatchesDomain(normalizedHostname, domain),
  );
}

export async function fetchRemoteImage(input: {
  url: string;
  provider?: string | null;
}): Promise<{ bytes: Buffer; contentType: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    REMOTE_MEDIA_FETCH_TIMEOUT_MS,
  );
  try {
    let target = await resolveSafeRemoteMediaTarget(input.url, input.provider);
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      const current = target.url;
      const hostname = current.hostname.toLowerCase();
      const auth =
        hostname === "api.twilio.com" &&
        process.env["TWILIO_ACCOUNT_SID"] &&
        process.env["TWILIO_AUTH_TOKEN"]
          ? `Basic ${Buffer.from(
              `${process.env["TWILIO_ACCOUNT_SID"]}:${process.env["TWILIO_AUTH_TOKEN"]}`,
            ).toString("base64")}`
          : null;
      const pinnedAddress = target.pinnedAddress;
      const dispatcher = pinnedAddress
        ? createPinnedRemoteMediaAgent(pinnedAddress)
        : null;
      try {
        const response = await fetch(current, {
          redirect: "manual",
          headers: auth ? { Authorization: auth } : {},
          signal: controller.signal,
          ...(dispatcher ? { dispatcher } : {}),
        } as RequestInit & { dispatcher?: Agent });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          await response.body?.cancel();
          if (!location || redirects === 3) {
            throw new AppointmentMediaError(
              "remote_media_redirect_invalid",
              502,
            );
          }
          target = await resolveSafeRemoteMediaTarget(
            new URL(location, current).toString(),
            input.provider,
          );
          continue;
        }
        if (!response.ok || !response.body) {
          throw new AppointmentMediaError("remote_media_fetch_failed", 502);
        }
        const declaredLength = Number(response.headers.get("content-length"));
        if (
          Number.isFinite(declaredLength) &&
          declaredLength > MAX_APPOINTMENT_IMAGE_BYTES
        ) {
          await response.body.cancel();
          throw new AppointmentMediaError("remote_media_too_large", 413);
        }
        const reader = response.body.getReader();
        const chunks: Buffer[] = [];
        let total = 0;
        while (true) {
          const result = await reader.read();
          if (result.done) break;
          total += result.value.byteLength;
          if (total > MAX_APPOINTMENT_IMAGE_BYTES) {
            await reader.cancel();
            throw new AppointmentMediaError("remote_media_too_large", 413);
          }
          chunks.push(Buffer.from(result.value));
        }
        return {
          bytes: Buffer.concat(chunks, total),
          contentType:
            response.headers.get("content-type") ?? "application/octet-stream",
        };
      } finally {
        await dispatcher?.close().catch(() => undefined);
      }
    }
    throw new AppointmentMediaError("remote_media_redirect_invalid", 502);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new AppointmentMediaError("remote_media_fetch_timeout", 504);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveUpcomingAppointment(
  input: {
    contactId: string;
    exactLeadId?: string | null;
    sourceCreatedAt?: Date | null;
  },
  db: MediaDatabase = getDb(),
): Promise<string | null> {
  if (input.exactLeadId) {
    const [exact] = await db
      .select({ id: appointments.id })
      .from(appointments)
      .where(
        and(
          eq(appointments.leadId, input.exactLeadId),
          eq(appointments.contactId, input.contactId),
        ),
      )
      .orderBy(
        asc(appointments.startAt),
        asc(appointments.createdAt),
        asc(appointments.id),
      )
      .limit(1);
    if (exact) return exact.id;
  }
  if (!canAutoAttachMediaToNearestAppointment(input.sourceCreatedAt)) {
    return null;
  }
  const [nearest] = await db
    .select({ id: appointments.id })
    .from(appointments)
    .where(
      and(
        eq(appointments.contactId, input.contactId),
        inArray(appointments.status, ["requested", "confirmed"]),
        isNotNull(appointments.startAt),
        gte(appointments.startAt, new Date()),
      ),
    )
    .orderBy(
      sql`${appointments.startAt} asc nulls last`,
      asc(appointments.createdAt),
      asc(appointments.id),
    )
    .limit(1);
  return nearest?.id ?? null;
}

function redactRemoteMediaUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "invalid";
  }
}

async function attachReadyMediaAssetToBestAppointment(input: {
  assetId: string;
  contactId: string;
  exactLeadId?: string | null;
  sourceCreatedAt?: Date | null;
}): Promise<{ mediaId: string | null; appointmentId: string | null }> {
  const db = getDb();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidateId = await resolveUpcomingAppointment({
      contactId: input.contactId,
      exactLeadId: input.exactLeadId,
      sourceCreatedAt: input.sourceCreatedAt,
    });
    if (!candidateId) return { mediaId: null, appointmentId: null };

    const result = await db.transaction(async (tx) => {
      await lockAppointmentsForMedia(tx, [candidateId]);
      const currentCandidateId = await resolveUpcomingAppointment(
        {
          contactId: input.contactId,
          exactLeadId: input.exactLeadId,
          sourceCreatedAt: input.sourceCreatedAt,
        },
        tx,
      );
      if (currentCandidateId !== candidateId) {
        return { retry: true as const, mediaId: null, appointmentId: null };
      }

      const [asset] = await tx
        .select({
          id: mediaAssets.id,
          contactId: mediaAssets.contactId,
          status: mediaAssets.status,
          deletedAt: mediaAssets.deletedAt,
          sourceMetadata: mediaAssets.sourceMetadata,
        })
        .from(mediaAssets)
        .where(eq(mediaAssets.id, input.assetId))
        .limit(1)
        .for("update");
      if (
        !asset ||
        asset.contactId !== input.contactId ||
        asset.status !== "ready" ||
        asset.deletedAt
      ) {
        return { retry: false as const, mediaId: null, appointmentId: null };
      }
      const [existingLink] = await tx
        .select({
          id: appointmentMedia.id,
          appointmentId: appointmentMedia.appointmentId,
          deletedAt: appointmentMedia.deletedAt,
        })
        .from(appointmentMedia)
        .where(eq(appointmentMedia.mediaAssetId, input.assetId))
        .orderBy(asc(appointmentMedia.createdAt), asc(appointmentMedia.id))
        .limit(1);
      if (existingLink) {
        return {
          retry: false as const,
          mediaId: existingLink.deletedAt ? null : existingLink.id,
          appointmentId: existingLink.deletedAt
            ? null
            : existingLink.appointmentId,
        };
      }

      const order = await persistGapFreeMediaOrder(tx, candidateId);
      if (order.length >= MAX_APPOINTMENT_MEDIA_COUNT) {
        return { retry: false as const, mediaId: null, appointmentId: null };
      }
      const mediaId = randomUUID();
      await tx.insert(appointmentMedia).values({
        id: mediaId,
        appointmentId: candidateId,
        mediaAssetId: input.assetId,
        purpose: "quoted_work",
        sortOrder: order.length,
        isCover: false,
        attachmentSource: "automatic",
      });
      if (asset.sourceMetadata?.["orphanDetectedAt"] !== undefined) {
        const { orphanDetectedAt: _removed, ...sourceMetadata } =
          asset.sourceMetadata;
        await tx
          .update(mediaAssets)
          .set({ sourceMetadata, updatedAt: new Date() })
          .where(eq(mediaAssets.id, input.assetId));
      }
      await persistGapFreeMediaOrder(tx, candidateId, [...order, mediaId]);
      await ensureAppointmentCover(tx, candidateId);
      return {
        retry: false as const,
        mediaId,
        appointmentId: candidateId,
      };
    });
    if (!result.retry) {
      return {
        mediaId: result.mediaId,
        appointmentId: result.appointmentId,
      };
    }
  }
  return { mediaId: null, appointmentId: null };
}

async function processRemoteMediaAsset(input: {
  assetId: string;
  mediaId: string | null;
  appointmentId: string | null;
  contactId: string;
  exactLeadId?: string | null;
  sourceCreatedAt?: Date | null;
  url: string;
  provider?: string | null;
  alreadyExists?: boolean;
}): Promise<MediaImportResult> {
  const db = getDb();
  try {
    const fetched = await fetchRemoteImage({
      url: input.url,
      provider: input.provider,
    });
    const normalized = await normalizeAppointmentImage(
      fetched.bytes,
      fetched.contentType,
    );
    const prefix = input.appointmentId
      ? `appointments/${input.appointmentId}/${input.assetId}`
      : `contacts/${input.contactId}/${input.assetId}`;
    const originalKey = `${prefix}/original.jpg`;
    const displayKey = `${prefix}/display.jpg`;
    const thumbnailKey = `${prefix}/thumbnail.jpg`;
    await db
      .update(mediaAssets)
      .set({
        sourceMetadata: {
          remoteUrl: redactRemoteMediaUrl(input.url),
          provider: input.provider ?? null,
          sourceCreatedAt: input.sourceCreatedAt?.toISOString() ?? null,
          pendingVariantObjectKeys: [originalKey, displayKey, thumbnailKey],
        },
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(mediaAssets.id, input.assetId),
          eq(mediaAssets.status, "processing"),
        ),
      );
    await Promise.all([
      putMediaObject({
        key: originalKey,
        body: normalized.original,
        contentType: normalized.contentType,
      }),
      putMediaObject({
        key: displayKey,
        body: normalized.display,
        contentType: normalized.contentType,
      }),
      putMediaObject({
        key: thumbnailKey,
        body: normalized.thumbnail,
        contentType: normalized.contentType,
      }),
    ]);
    const storedHeads = await Promise.all([
      headMediaObject(originalKey),
      headMediaObject(displayKey),
      headMediaObject(thumbnailKey),
    ]);
    const expectedVariantSizes = [
      normalized.original.byteLength,
      normalized.display.byteLength,
      normalized.thumbnail.byteLength,
    ];
    if (
      storedHeads.some(
        (head, index) => head.byteLength !== expectedVariantSizes[index],
      )
    ) {
      throw new AppointmentMediaError("media_storage_verification_failed", 502);
    }
    await db
      .update(mediaAssets)
      .set({
        status: "ready",
        originalObjectKey: originalKey,
        displayObjectKey: displayKey,
        thumbnailObjectKey: thumbnailKey,
        contentType: normalized.contentType,
        byteSize: normalized.original.byteLength,
        width: normalized.width,
        height: normalized.height,
        sha256: normalized.sha256,
        sourceMetadata: {
          remoteUrl: redactRemoteMediaUrl(input.url),
          provider: input.provider ?? null,
          sourceCreatedAt: input.sourceCreatedAt?.toISOString() ?? null,
          inputContentType: normalized.inputContentType,
          inputByteSize: fetched.bytes.byteLength,
          inputSha256: normalized.inputSha256,
        },
        readyAt: new Date(),
        processingError: null,
        updatedAt: new Date(),
      })
      .where(eq(mediaAssets.id, input.assetId));
    const lateAttachment = input.appointmentId
      ? { mediaId: input.mediaId, appointmentId: input.appointmentId }
      : await attachReadyMediaAssetToBestAppointment({
          assetId: input.assetId,
          contactId: input.contactId,
          exactLeadId: input.exactLeadId,
          sourceCreatedAt: input.sourceCreatedAt,
        });
    if (lateAttachment.appointmentId) {
      await db.transaction(async (tx) => {
        await lockAppointmentsForMedia(tx, [lateAttachment.appointmentId!]);
        await ensureAppointmentCover(tx, lateAttachment.appointmentId!);
      });
    }
    return {
      assetId: input.assetId,
      mediaId: lateAttachment.mediaId,
      status: "ready",
      alreadyExists: input.alreadyExists ?? false,
    };
  } catch (error) {
    await db
      .update(mediaAssets)
      .set({
        status: "failed",
        processingError: stringError(error),
        updatedAt: new Date(),
      })
      .where(eq(mediaAssets.id, input.assetId));
    const detail = stringError(error);
    if (
      !(error instanceof AppointmentMediaError) &&
      /(?:image|heic|heif|unsupported|corrupt|checksum|dimension)/i.test(detail)
    ) {
      throw new AppointmentMediaError("remote_media_invalid", 422, detail);
    }
    throw error;
  }
}

export async function importRemoteAppointmentMedia(input: {
  url: string;
  source:
    | "twilio_mms"
    | "facebook_messenger"
    | "instant_quote"
    | "legacy_attachment";
  sourceKey: string;
  originalFilename?: string | null;
  contactId: string;
  appointmentId?: string | null;
  exactLeadId?: string | null;
  instantQuoteId?: string | null;
  sourceMessageId?: string | null;
  sourceMediaIndex?: number | null;
  provider?: string | null;
  sourceCreatedAt?: Date | null;
}): Promise<MediaImportResult> {
  const db = getDb();
  const sourceCreatedAt =
    input.sourceCreatedAt && Number.isFinite(input.sourceCreatedAt.getTime())
      ? input.sourceCreatedAt
      : new Date();
  const remoteProvider: RemoteMediaProvider | null =
    input.source === "twilio_mms"
      ? "twilio"
      : input.source === "facebook_messenger"
        ? "facebook"
        : normalizeRemoteMediaProvider(input.provider);
  const [existing] = await db
    .select({
      id: mediaAssets.id,
      source: mediaAssets.source,
      status: mediaAssets.status,
      updatedAt: mediaAssets.updatedAt,
      storageProvider: mediaAssets.storageProvider,
      storageBucket: mediaAssets.storageBucket,
      contactId: mediaAssets.contactId,
      stagingExpiresAt: mediaAssets.stagingExpiresAt,
      deletedAt: mediaAssets.deletedAt,
      createdAt: mediaAssets.createdAt,
    })
    .from(mediaAssets)
    .where(eq(mediaAssets.sourceKey, input.sourceKey))
    .limit(1);
  if (existing) {
    if (existing.contactId !== input.contactId) {
      throw new AppointmentMediaError("cross_contact_media_forbidden", 409);
    }
    const [link] = await db
      .select({
        id: appointmentMedia.id,
        appointmentId: appointmentMedia.appointmentId,
      })
      .from(appointmentMedia)
      .where(
        and(
          eq(appointmentMedia.mediaAssetId, existing.id),
          isNull(appointmentMedia.deletedAt),
        ),
      )
      .limit(1);
    const [deletedLink] = await db
      .select({ id: appointmentMedia.id })
      .from(appointmentMedia)
      .where(
        and(
          eq(appointmentMedia.mediaAssetId, existing.id),
          isNotNull(appointmentMedia.deletedAt),
        ),
      )
      .limit(1);
    const processingIsStale =
      existing.status === "processing" &&
      existing.updatedAt.getTime() < Date.now() - 30 * 60 * 1_000;
    const expiredImportCanRetry = canRetryExpiredImportedMediaAsset({
      source: existing.source,
      status: existing.status,
      deletedAt: existing.deletedAt,
      hasActiveAppointmentLink: Boolean(link),
      hasDeletedAppointmentLink: Boolean(deletedLink),
    });
    if (
      existing.status === "failed" ||
      processingIsStale ||
      expiredImportCanRetry
    ) {
      assertAssetStorageLocation(existing);
      const staleCutoff = new Date(Date.now() - 30 * 60 * 1_000);
      const [claimed] = await db
        .update(mediaAssets)
        .set({
          status: "processing",
          stagingExpiresAt: null,
          deletedAt: null,
          processingError: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(mediaAssets.id, existing.id),
            or(
              eq(mediaAssets.status, "failed"),
              and(
                eq(mediaAssets.status, "processing"),
                lte(mediaAssets.updatedAt, staleCutoff),
              ),
              ...(expiredImportCanRetry
                ? [
                    and(
                      inArray(mediaAssets.status, ["expired", "deleted"]),
                      isNotNull(mediaAssets.deletedAt),
                    ),
                  ]
                : []),
            ),
          ),
        )
        .returning({ id: mediaAssets.id });
      if (!claimed) {
        const [current] = await db
          .select({ status: mediaAssets.status })
          .from(mediaAssets)
          .where(eq(mediaAssets.id, existing.id))
          .limit(1);
        return {
          assetId: existing.id,
          mediaId: link?.id ?? null,
          status: current?.status ?? existing.status,
          alreadyExists: true,
        };
      }
      return processRemoteMediaAsset({
        assetId: existing.id,
        mediaId: link?.id ?? null,
        appointmentId: link?.appointmentId ?? null,
        contactId: input.contactId,
        exactLeadId: input.exactLeadId,
        sourceCreatedAt: existing.createdAt,
        url: input.url,
        provider: remoteProvider,
        alreadyExists: true,
      });
    }
    if (existing.status === "ready" && !link) {
      const attachment = await attachReadyMediaAssetToBestAppointment({
        assetId: existing.id,
        contactId: input.contactId,
        exactLeadId: input.exactLeadId,
        sourceCreatedAt: existing.createdAt,
      });
      return {
        assetId: existing.id,
        mediaId: attachment.mediaId,
        status: "ready",
        alreadyExists: true,
      };
    }
    return {
      assetId: existing.id,
      mediaId: link?.id ?? null,
      status: existing.status,
      alreadyExists: true,
    };
  }

  const requestedAppointmentId =
    input.appointmentId ??
    (await resolveUpcomingAppointment({
      contactId: input.contactId,
      exactLeadId: input.exactLeadId,
      sourceCreatedAt,
    }));
  let appointmentId: string | null = null;
  const assetId = randomUUID();
  let mediaId: string | null = null;
  const bucket = getMediaStorageBucket();
  const placeholderKey = `imports/pending/${assetId}`;
  try {
    await db.transaction(async (tx) => {
      let order: string[] = [];
      if (requestedAppointmentId) {
        const appointment = (
          await lockAppointmentsForMedia(tx, [requestedAppointmentId])
        ).get(requestedAppointmentId);
        if (!appointment) {
          throw new AppointmentMediaError("appointment_not_found", 404);
        }
        if (appointment.contactId !== input.contactId) {
          throw new AppointmentMediaError("cross_contact_media_forbidden", 409);
        }
        const stillBestMatch = input.appointmentId
          ? requestedAppointmentId
          : await resolveUpcomingAppointment(
              {
                contactId: input.contactId,
                exactLeadId: input.exactLeadId,
                sourceCreatedAt,
              },
              tx,
            );
        if (stillBestMatch === requestedAppointmentId) {
          order = await persistGapFreeMediaOrder(tx, requestedAppointmentId);
          if (order.length < MAX_APPOINTMENT_MEDIA_COUNT) {
            appointmentId = requestedAppointmentId;
            mediaId = randomUUID();
          }
        }
      }
      await tx.insert(mediaAssets).values({
        id: assetId,
        storageProvider: getMediaStorageProvider(),
        storageBucket: bucket,
        originalObjectKey: placeholderKey,
        source: input.source,
        sourceKey: input.sourceKey,
        status: "processing",
        originalFilename: sanitizeFilename(
          input.originalFilename ?? "customer-photo",
        ),
        contactId: input.contactId,
        sourceMessageId: input.sourceMessageId ?? null,
        sourceMediaIndex: input.sourceMediaIndex ?? null,
        sourceMetadata: {
          remoteUrl: redactRemoteMediaUrl(input.url),
          provider: remoteProvider,
          sourceCreatedAt: sourceCreatedAt.toISOString(),
        },
        createdAt: sourceCreatedAt,
      });
      if (appointmentId && mediaId) {
        await tx.insert(appointmentMedia).values({
          id: mediaId,
          appointmentId,
          mediaAssetId: assetId,
          purpose: "quoted_work",
          sortOrder: order.length,
          isCover: false,
          attachmentSource: "automatic",
        });
        await persistGapFreeMediaOrder(tx, appointmentId, [...order, mediaId]);
      }
      if (input.instantQuoteId) {
        await tx.insert(instantQuoteMedia).values({
          instantQuoteId: input.instantQuoteId,
          mediaAssetId: assetId,
          sortOrder: input.sourceMediaIndex ?? 0,
        });
      }
    });
  } catch (error) {
    // A concurrent import with the same stable source key wins.
    const [winner] = await db
      .select({ id: mediaAssets.id, status: mediaAssets.status })
      .from(mediaAssets)
      .where(eq(mediaAssets.sourceKey, input.sourceKey))
      .limit(1);
    if (winner) {
      const [link] = await db
        .select({ id: appointmentMedia.id })
        .from(appointmentMedia)
        .where(eq(appointmentMedia.mediaAssetId, winner.id))
        .limit(1);
      return {
        assetId: winner.id,
        mediaId: link?.id ?? null,
        status: winner.status,
        alreadyExists: true,
      };
    }
    throw error;
  }

  return processRemoteMediaAsset({
    assetId,
    mediaId,
    appointmentId,
    contactId: input.contactId,
    exactLeadId: input.exactLeadId,
    sourceCreatedAt,
    url: input.url,
    provider: remoteProvider,
  });
}

export async function importBufferedAppointmentMedia(input: {
  bytes: Buffer;
  declaredContentType?: string | null;
  sourceKey: string;
  originalFilename?: string | null;
  appointmentId: string;
  contactId: string;
  sourceCreatedAt?: Date | null;
}): Promise<MediaImportResult> {
  const db = getDb();
  const sourceCreatedAt =
    input.sourceCreatedAt && Number.isFinite(input.sourceCreatedAt.getTime())
      ? input.sourceCreatedAt
      : new Date();
  const [existingHint] = await db
    .select({
      id: mediaAssets.id,
      source: mediaAssets.source,
      status: mediaAssets.status,
      updatedAt: mediaAssets.updatedAt,
      deletedAt: mediaAssets.deletedAt,
    })
    .from(mediaAssets)
    .where(eq(mediaAssets.sourceKey, input.sourceKey))
    .limit(1);
  if (existingHint?.status === "ready") {
    const [link] = await db
      .select({ id: appointmentMedia.id })
      .from(appointmentMedia)
      .where(
        and(
          eq(appointmentMedia.mediaAssetId, existingHint.id),
          isNull(appointmentMedia.deletedAt),
        ),
      )
      .limit(1);
    return {
      assetId: existingHint.id,
      mediaId: link?.id ?? null,
      status: "ready",
      alreadyExists: true,
    };
  }
  const processingIsFresh =
    existingHint?.status === "processing" &&
    existingHint.updatedAt.getTime() >= Date.now() - 30 * 60 * 1_000;
  if (processingIsFresh) {
    const [link] = await db
      .select({ id: appointmentMedia.id })
      .from(appointmentMedia)
      .where(
        and(
          eq(appointmentMedia.mediaAssetId, existingHint.id),
          isNull(appointmentMedia.deletedAt),
        ),
      )
      .limit(1);
    return {
      assetId: existingHint.id,
      mediaId: link?.id ?? null,
      status: "processing",
      alreadyExists: false,
    };
  }
  let expiredHintCanRetry = false;
  if (existingHint && ["expired", "deleted"].includes(existingHint.status)) {
    const hintLinks = await db
      .select({
        id: appointmentMedia.id,
        deletedAt: appointmentMedia.deletedAt,
      })
      .from(appointmentMedia)
      .where(eq(appointmentMedia.mediaAssetId, existingHint.id));
    expiredHintCanRetry = canRetryExpiredImportedMediaAsset({
      source: existingHint.source,
      status: existingHint.status,
      deletedAt: existingHint.deletedAt,
      hasActiveAppointmentLink: hintLinks.some((link) => !link.deletedAt),
      hasDeletedAppointmentLink: hintLinks.some((link) =>
        Boolean(link.deletedAt),
      ),
    });
  }
  if (
    existingHint &&
    existingHint.status !== "failed" &&
    existingHint.status !== "processing" &&
    !expiredHintCanRetry
  ) {
    throw new AppointmentMediaError("media_asset_unavailable", 410);
  }

  const normalized = await normalizeAppointmentImage(
    input.bytes,
    input.declaredContentType,
  );
  const bucket = getMediaStorageBucket();
  const prepared = await db.transaction(async (tx) => {
    const appointment = (
      await lockAppointmentsForMedia(tx, [input.appointmentId])
    ).get(input.appointmentId);
    if (!appointment) {
      throw new AppointmentMediaError("appointment_not_found", 404);
    }
    if (appointment.contactId !== input.contactId) {
      throw new AppointmentMediaError("cross_contact_media_forbidden", 409);
    }

    const [existing] = await tx
      .select({
        id: mediaAssets.id,
        source: mediaAssets.source,
        status: mediaAssets.status,
        updatedAt: mediaAssets.updatedAt,
        storageProvider: mediaAssets.storageProvider,
        storageBucket: mediaAssets.storageBucket,
        originalObjectKey: mediaAssets.originalObjectKey,
        displayObjectKey: mediaAssets.displayObjectKey,
        thumbnailObjectKey: mediaAssets.thumbnailObjectKey,
        contactId: mediaAssets.contactId,
        stagingExpiresAt: mediaAssets.stagingExpiresAt,
        deletedAt: mediaAssets.deletedAt,
      })
      .from(mediaAssets)
      .where(eq(mediaAssets.sourceKey, input.sourceKey))
      .limit(1)
      .for("update");

    let assetId: string;
    let originalKey: string;
    let displayKey: string;
    let thumbnailKey: string;
    if (existing) {
      if (existing.contactId !== input.contactId) {
        throw new AppointmentMediaError("cross_contact_media_forbidden", 409);
      }
      if (existing.status === "ready") {
        const [link] = await tx
          .select({ id: appointmentMedia.id })
          .from(appointmentMedia)
          .where(
            and(
              eq(appointmentMedia.mediaAssetId, existing.id),
              isNull(appointmentMedia.deletedAt),
            ),
          )
          .limit(1);
        return {
          shouldProcess: false as const,
          assetId: existing.id,
          mediaId: link?.id ?? null,
          status: "ready",
          alreadyExists: true,
          originalKey: existing.originalObjectKey,
          displayKey: existing.displayObjectKey,
          thumbnailKey: existing.thumbnailObjectKey,
        };
      }
      const stale =
        existing.status === "processing" &&
        existing.updatedAt.getTime() < Date.now() - 30 * 60 * 1_000;
      const existingLinks = await tx
        .select({
          id: appointmentMedia.id,
          deletedAt: appointmentMedia.deletedAt,
        })
        .from(appointmentMedia)
        .where(eq(appointmentMedia.mediaAssetId, existing.id));
      const expiredImportCanRetry = canRetryExpiredImportedMediaAsset({
        source: existing.source,
        status: existing.status,
        deletedAt: existing.deletedAt,
        hasActiveAppointmentLink: existingLinks.some((link) => !link.deletedAt),
        hasDeletedAppointmentLink: existingLinks.some((link) =>
          Boolean(link.deletedAt),
        ),
      });
      if (existing.status !== "failed" && !stale && !expiredImportCanRetry) {
        const [link] = await tx
          .select({ id: appointmentMedia.id })
          .from(appointmentMedia)
          .where(
            and(
              eq(appointmentMedia.mediaAssetId, existing.id),
              isNull(appointmentMedia.deletedAt),
            ),
          )
          .limit(1);
        return {
          shouldProcess: false as const,
          assetId: existing.id,
          mediaId: link?.id ?? null,
          status: existing.status,
          alreadyExists: false,
          originalKey: existing.originalObjectKey,
          displayKey: existing.displayObjectKey,
          thumbnailKey: existing.thumbnailObjectKey,
        };
      }
      assertAssetStorageLocation(existing);
      assetId = existing.id;
      const prefix = `appointments/${input.appointmentId}/${assetId}`;
      originalKey = existing.originalObjectKey || `${prefix}/original.jpg`;
      displayKey = existing.displayObjectKey || `${prefix}/display.jpg`;
      thumbnailKey = existing.thumbnailObjectKey || `${prefix}/thumbnail.jpg`;
      await tx
        .update(mediaAssets)
        .set({
          status: "processing",
          originalObjectKey: originalKey,
          displayObjectKey: displayKey,
          thumbnailObjectKey: thumbnailKey,
          stagingExpiresAt: null,
          deletedAt: null,
          processingError: null,
          updatedAt: new Date(),
        })
        .where(eq(mediaAssets.id, assetId));
    } else {
      assetId = randomUUID();
      const prefix = `appointments/${input.appointmentId}/${assetId}`;
      originalKey = `${prefix}/original.jpg`;
      displayKey = `${prefix}/display.jpg`;
      thumbnailKey = `${prefix}/thumbnail.jpg`;
      await tx.insert(mediaAssets).values({
        id: assetId,
        storageProvider: getMediaStorageProvider(),
        storageBucket: bucket,
        originalObjectKey: originalKey,
        displayObjectKey: displayKey,
        thumbnailObjectKey: thumbnailKey,
        source: "legacy_attachment",
        sourceKey: input.sourceKey,
        status: "processing",
        originalFilename: sanitizeFilename(
          input.originalFilename ?? "legacy-photo",
        ),
        contactId: input.contactId,
        sourceMetadata: {
          legacy: true,
          inputContentType: normalized.inputContentType,
          inputByteSize: input.bytes.byteLength,
          inputSha256: normalized.inputSha256,
          sourceCreatedAt: sourceCreatedAt.toISOString(),
        },
        createdAt: sourceCreatedAt,
      });
    }

    const [priorLink] = await tx
      .select({
        id: appointmentMedia.id,
        deletedAt: appointmentMedia.deletedAt,
      })
      .from(appointmentMedia)
      .where(eq(appointmentMedia.mediaAssetId, assetId))
      .orderBy(asc(appointmentMedia.createdAt), asc(appointmentMedia.id))
      .limit(1);
    let mediaId = priorLink && !priorLink.deletedAt ? priorLink.id : null;
    if (!priorLink) {
      const order = await persistGapFreeMediaOrder(tx, input.appointmentId);
      if (order.length < MAX_APPOINTMENT_MEDIA_COUNT) {
        mediaId = randomUUID();
        await tx.insert(appointmentMedia).values({
          id: mediaId,
          appointmentId: input.appointmentId,
          mediaAssetId: assetId,
          purpose: "quoted_work",
          sortOrder: order.length,
          isCover: false,
          attachmentSource: "migration",
        });
        await persistGapFreeMediaOrder(tx, input.appointmentId, [
          ...order,
          mediaId,
        ]);
      }
    }
    return {
      shouldProcess: true as const,
      assetId,
      mediaId,
      status: "processing",
      alreadyExists: false,
      originalKey,
      displayKey,
      thumbnailKey,
    };
  });

  if (!prepared.shouldProcess) {
    return {
      assetId: prepared.assetId,
      mediaId: prepared.mediaId,
      status: prepared.status,
      alreadyExists: prepared.alreadyExists,
    };
  }

  try {
    await Promise.all([
      putMediaObject({
        key: prepared.originalKey,
        body: normalized.original,
        contentType: normalized.contentType,
      }),
      putMediaObject({
        key: prepared.displayKey,
        body: normalized.display,
        contentType: normalized.contentType,
      }),
      putMediaObject({
        key: prepared.thumbnailKey,
        body: normalized.thumbnail,
        contentType: normalized.contentType,
      }),
    ]);
    const storedHeads = await Promise.all([
      headMediaObject(prepared.originalKey),
      headMediaObject(prepared.displayKey),
      headMediaObject(prepared.thumbnailKey),
    ]);
    const expectedVariantSizes = [
      normalized.original.byteLength,
      normalized.display.byteLength,
      normalized.thumbnail.byteLength,
    ];
    if (
      storedHeads.some(
        (head, index) => head.byteLength !== expectedVariantSizes[index],
      )
    ) {
      throw new AppointmentMediaError("media_storage_verification_failed", 502);
    }
    await db
      .update(mediaAssets)
      .set({
        status: "ready",
        contentType: normalized.contentType,
        byteSize: normalized.original.byteLength,
        width: normalized.width,
        height: normalized.height,
        sha256: normalized.sha256,
        sourceMetadata: {
          legacy: true,
          inputContentType: normalized.inputContentType,
          inputByteSize: input.bytes.byteLength,
          inputSha256: normalized.inputSha256,
        },
        readyAt: new Date(),
        processingError: null,
        updatedAt: new Date(),
      })
      .where(eq(mediaAssets.id, prepared.assetId));
    await db.transaction(async (tx) => {
      await lockAppointmentsForMedia(tx, [input.appointmentId]);
      await ensureAppointmentCover(tx, input.appointmentId);
    });
    return {
      assetId: prepared.assetId,
      mediaId: prepared.mediaId,
      status: "ready",
      alreadyExists: false,
    };
  } catch (error) {
    await db
      .update(mediaAssets)
      .set({
        status: "failed",
        processingError: stringError(error),
        updatedAt: new Date(),
      })
      .where(eq(mediaAssets.id, prepared.assetId));
    throw error;
  }
}

export function getConversationMediaImportSource(
  channel: string,
  provider: string | null | undefined,
): "twilio_mms" | "facebook_messenger" | null {
  const normalizedProvider = provider?.trim().toLowerCase() ?? "";
  if (channel === "sms" && normalizedProvider === "twilio") {
    return "twilio_mms";
  }
  if (channel === "dm" && normalizedProvider === "facebook") {
    return "facebook_messenger";
  }
  return null;
}

export async function importConversationMessageMedia(
  messageId: string,
): Promise<MediaImportResult[]> {
  const db = getDb();
  const [message] = await db
    .select({
      id: conversationMessages.id,
      direction: conversationMessages.direction,
      channel: conversationMessages.channel,
      provider: conversationMessages.provider,
      providerMessageId: conversationMessages.providerMessageId,
      mediaUrls: conversationMessages.mediaUrls,
      receivedAt: conversationMessages.receivedAt,
      createdAt: conversationMessages.createdAt,
      contactId: conversationThreads.contactId,
      leadId: conversationThreads.leadId,
    })
    .from(conversationMessages)
    .innerJoin(
      conversationThreads,
      eq(conversationThreads.id, conversationMessages.threadId),
    )
    .where(eq(conversationMessages.id, messageId))
    .limit(1);
  if (!message || message.direction !== "inbound" || !message.contactId) {
    return [];
  }
  const source = getConversationMediaImportSource(
    message.channel,
    message.provider,
  );
  if (!source) return [];
  const results = [];
  for (const [index, url] of (message.mediaUrls ?? []).entries()) {
    const stableMessageId = message.providerMessageId ?? message.id;
    results.push(
      await importRemoteAppointmentMedia({
        url,
        source,
        sourceKey: `${source}:${stableMessageId}:${index}`,
        contactId: message.contactId,
        exactLeadId: message.leadId,
        sourceMessageId: message.id,
        sourceMediaIndex: index,
        provider: message.provider,
        sourceCreatedAt: message.receivedAt ?? message.createdAt,
      }),
    );
  }
  return results;
}

export async function listInstantQuoteMediaReadUrls(
  instantQuoteId: string,
  expiresInSeconds = 300,
): Promise<string[]> {
  const db = getDb();
  const rows = await db
    .select({
      storageProvider: mediaAssets.storageProvider,
      storageBucket: mediaAssets.storageBucket,
      originalObjectKey: mediaAssets.originalObjectKey,
      displayObjectKey: mediaAssets.displayObjectKey,
    })
    .from(instantQuoteMedia)
    .innerJoin(mediaAssets, eq(mediaAssets.id, instantQuoteMedia.mediaAssetId))
    .where(
      and(
        eq(instantQuoteMedia.instantQuoteId, instantQuoteId),
        eq(mediaAssets.status, "ready"),
        isNull(mediaAssets.deletedAt),
      ),
    )
    .orderBy(asc(instantQuoteMedia.sortOrder), asc(instantQuoteMedia.id));
  return Promise.all(
    rows.map((row) => {
      assertAssetStorageLocation(row);
      return createMediaReadUrl(
        row.displayObjectKey ?? row.originalObjectKey,
        expiresInSeconds,
      );
    }),
  );
}

export async function importInstantQuoteMediaAssets(
  instantQuoteId: string,
): Promise<MediaImportResult[]> {
  const db = getDb();
  const [quote] = await db
    .select({
      id: instantQuotes.id,
      photoUrls: instantQuotes.photoUrls,
      createdAt: instantQuotes.createdAt,
    })
    .from(instantQuotes)
    .where(eq(instantQuotes.id, instantQuoteId))
    .limit(1);
  if (!quote) throw new AppointmentMediaError("instant_quote_not_found", 404);
  const [lead] = await db
    .select({ id: leads.id, contactId: leads.contactId })
    .from(leads)
    .where(eq(leads.instantQuoteId, instantQuoteId))
    .limit(1);
  if (!lead?.contactId) return [];

  const durableQuoteMedia = await db
    .select({
      assetId: mediaAssets.id,
      sortOrder: instantQuoteMedia.sortOrder,
      status: mediaAssets.status,
      sourceKey: mediaAssets.sourceKey,
      contactId: mediaAssets.contactId,
      deletedAt: mediaAssets.deletedAt,
    })
    .from(instantQuoteMedia)
    .innerJoin(mediaAssets, eq(mediaAssets.id, instantQuoteMedia.mediaAssetId))
    .where(eq(instantQuoteMedia.instantQuoteId, instantQuoteId))
    .orderBy(asc(instantQuoteMedia.sortOrder), asc(instantQuoteMedia.id));
  const durableByOrder = new Map<number, (typeof durableQuoteMedia)[number]>();
  for (const media of durableQuoteMedia) {
    if (!durableByOrder.has(media.sortOrder)) {
      durableByOrder.set(media.sortOrder, media);
    }
  }

  const results = [];
  for (const [index, url] of (quote.photoUrls ?? []).entries()) {
    const durable = durableByOrder.get(index);
    if (durable) {
      if (durable.contactId !== lead.contactId) {
        throw new AppointmentMediaError("cross_contact_media_forbidden", 409);
      }
      const stableSourceKey = `instant_quote:${instantQuoteId}:${index}`;
      if (
        durable.sourceKey === stableSourceKey &&
        ["failed", "processing", "expired", "deleted"].includes(durable.status)
      ) {
        results.push(
          await importRemoteAppointmentMedia({
            url,
            source: "instant_quote",
            sourceKey: stableSourceKey,
            contactId: lead.contactId,
            exactLeadId: lead.id,
            instantQuoteId,
            sourceMediaIndex: index,
            sourceCreatedAt: quote.createdAt,
          }),
        );
        continue;
      }
      const attachment =
        durable.status === "ready" && !durable.deletedAt
          ? await attachReadyMediaAssetToBestAppointment({
              assetId: durable.assetId,
              contactId: lead.contactId,
              exactLeadId: lead.id,
            })
          : { mediaId: null, appointmentId: null };
      results.push({
        assetId: durable.assetId,
        mediaId: attachment.mediaId,
        status: durable.deletedAt ? "deleted" : durable.status,
        alreadyExists: true,
      });
      continue;
    }
    results.push(
      await importRemoteAppointmentMedia({
        url,
        source: "instant_quote",
        sourceKey: `instant_quote:${instantQuoteId}:${index}`,
        contactId: lead.contactId,
        exactLeadId: lead.id,
        instantQuoteId,
        sourceMediaIndex: index,
        sourceCreatedAt: quote.createdAt,
      }),
    );
  }
  return results;
}

export async function importAppointmentRelatedMedia(
  appointmentId: string,
): Promise<{ imported: number; attached: number; needsScope: boolean }> {
  const db = getDb();
  const [row] = await db
    .select({
      id: appointments.id,
      instantQuoteId: leads.instantQuoteId,
    })
    .from(appointments)
    .leftJoin(leads, eq(leads.id, appointments.leadId))
    .where(eq(appointments.id, appointmentId))
    .limit(1);
  if (!row) throw new AppointmentMediaError("appointment_not_found", 404);

  const imported = row.instantQuoteId
    ? await importInstantQuoteMediaAssets(row.instantQuoteId)
    : [];
  const attached =
    await attachRecentUnassignedMediaToAppointment(appointmentId);
  const scope = await getAppointmentScopeState(appointmentId);
  const [appointment] = await db
    .select({ status: appointments.status })
    .from(appointments)
    .where(eq(appointments.id, appointmentId))
    .limit(1);
  const scopePolicy = evaluateAutomaticMediaScopePolicy({
    currentStatus: appointment?.status ?? "unknown",
    needsScope: scope.needsScope,
  });
  if (scopePolicy.shouldRecordWarning) {
    await recordAuditEvent({
      actor: { type: "worker", label: "appointment-media" },
      action: "appointment.scope_review.required",
      entityType: "appointment",
      entityId: appointmentId,
      meta: {
        reason: "automatic_media_without_quoted_scope",
        imported: imported.length,
        attached,
        appointmentStatus: scopePolicy.nextStatus,
        statusChanged: false,
      },
    });
  }
  return { imported: imported.length, attached, needsScope: scope.needsScope };
}

export async function attachRecentUnassignedMediaToAppointment(
  appointmentId: string,
): Promise<number> {
  const db = getDb();
  const cutoff = new Date(Date.now() - RECENT_UNASSIGNED_MEDIA_MS);
  return db.transaction(async (tx) => {
    const appointment = (
      await lockAppointmentsForMedia(tx, [appointmentId])
    ).get(appointmentId);
    if (!appointment?.contactId) return 0;
    const order = await persistGapFreeMediaOrder(tx, appointmentId);
    let available = MAX_APPOINTMENT_MEDIA_COUNT - order.length;
    if (available <= 0) return 0;
    const candidates = await tx
      .select({ id: mediaAssets.id })
      .from(mediaAssets)
      .leftJoin(
        appointmentMedia,
        and(
          eq(appointmentMedia.mediaAssetId, mediaAssets.id),
          isNull(appointmentMedia.deletedAt),
        ),
      )
      .where(
        and(
          eq(mediaAssets.contactId, appointment.contactId),
          eq(mediaAssets.status, "ready"),
          isNull(mediaAssets.deletedAt),
          isNull(appointmentMedia.id),
          gte(mediaAssets.createdAt, cutoff),
        ),
      )
      .orderBy(asc(mediaAssets.createdAt), asc(mediaAssets.id));

    const finalOrder = [...order];
    let attached = 0;
    for (const candidate of candidates) {
      if (available <= 0) break;
      const [asset] = await tx
        .select({
          id: mediaAssets.id,
          contactId: mediaAssets.contactId,
          status: mediaAssets.status,
          deletedAt: mediaAssets.deletedAt,
          sourceMetadata: mediaAssets.sourceMetadata,
        })
        .from(mediaAssets)
        .where(eq(mediaAssets.id, candidate.id))
        .limit(1)
        .for("update");
      if (
        !asset ||
        asset.contactId !== appointment.contactId ||
        asset.status !== "ready" ||
        asset.deletedAt
      ) {
        continue;
      }
      const [priorLink] = await tx
        .select({ id: appointmentMedia.id })
        .from(appointmentMedia)
        .where(eq(appointmentMedia.mediaAssetId, candidate.id))
        .limit(1);
      if (priorLink) continue;

      const mediaId = randomUUID();
      await tx.insert(appointmentMedia).values({
        id: mediaId,
        appointmentId,
        mediaAssetId: candidate.id,
        purpose: "quoted_work",
        sortOrder: finalOrder.length,
        isCover: false,
        attachmentSource: "automatic",
      });
      if (asset.sourceMetadata?.["orphanDetectedAt"] !== undefined) {
        const { orphanDetectedAt: _removed, ...sourceMetadata } =
          asset.sourceMetadata;
        await tx
          .update(mediaAssets)
          .set({ sourceMetadata, updatedAt: new Date() })
          .where(eq(mediaAssets.id, candidate.id));
      }
      finalOrder.push(mediaId);
      available -= 1;
      attached += 1;
    }
    await persistGapFreeMediaOrder(tx, appointmentId, finalOrder);
    await ensureAppointmentCover(tx, appointmentId);
    return attached;
  });
}

export async function cleanupExpiredAppointmentMedia(input?: {
  now?: Date;
  limit?: number;
}): Promise<{
  expiredStaging: number;
  purgedAssets: number;
  failures: number;
}> {
  const db = getDb();
  const now = input?.now ?? new Date();
  const limit = Math.min(Math.max(input?.limit ?? 100, 1), 1_000);
  const deletedLinkCutoff = new Date(now.getTime() - MEDIA_RESTORE_WINDOW_MS);
  let expiredStaging = 0;
  let purgedAssets = 0;
  let failures = 0;

  const abandonedRows = await db
    .select({
      id: mediaAssets.id,
      processingError: mediaAssets.processingError,
    })
    .from(mediaAssets)
    .where(
      and(
        isNull(mediaAssets.deletedAt),
        or(
          and(
            inArray(mediaAssets.status, ["staging", "processing", "failed"]),
            isNotNull(mediaAssets.stagingExpiresAt),
            lte(mediaAssets.stagingExpiresAt, now),
          ),
          eq(mediaAssets.status, "deleting"),
        ),
      ),
    )
    .orderBy(asc(mediaAssets.updatedAt), asc(mediaAssets.id))
    .limit(limit);
  const deletedLinks = await db
    .select({
      assetId: mediaAssets.id,
    })
    .from(appointmentMedia)
    .innerJoin(mediaAssets, eq(mediaAssets.id, appointmentMedia.mediaAssetId))
    .where(
      and(
        isNotNull(appointmentMedia.deletedAt),
        lte(appointmentMedia.deletedAt, deletedLinkCutoff),
        isNull(mediaAssets.deletedAt),
      ),
    )
    .orderBy(asc(appointmentMedia.deletedAt))
    .limit(limit);

  const orphanRows = await db
    .select({ assetId: mediaAssets.id })
    .from(mediaAssets)
    .leftJoin(
      appointmentMedia,
      eq(appointmentMedia.mediaAssetId, mediaAssets.id),
    )
    .leftJoin(
      instantQuoteMedia,
      eq(instantQuoteMedia.mediaAssetId, mediaAssets.id),
    )
    .where(
      and(
        isNull(mediaAssets.contactId),
        isNull(mediaAssets.deletedAt),
        isNull(appointmentMedia.id),
        isNull(instantQuoteMedia.id),
        or(
          sql`${mediaAssets.sourceMetadata}->>'orphanDetectedAt' is null`,
          sql`${mediaAssets.sourceMetadata}->>'orphanDetectedAt' <= ${deletedLinkCutoff.toISOString()}`,
        ),
      ),
    )
    .orderBy(asc(mediaAssets.createdAt), asc(mediaAssets.id))
    .limit(limit);

  type CleanupMode = "expired" | "deleted";
  const candidateModes = new Map<string, CleanupMode>();
  for (const row of abandonedRows) {
    candidateModes.set(
      row.id,
      row.processingError?.startsWith("cleanup_claim:deleted")
        ? "deleted"
        : "expired",
    );
  }
  for (const row of deletedLinks) {
    if (!candidateModes.has(row.assetId)) {
      candidateModes.set(row.assetId, "deleted");
    }
  }
  for (const row of orphanRows) {
    if (!candidateModes.has(row.assetId)) {
      candidateModes.set(row.assetId, "deleted");
    }
  }

  for (const [assetId, requestedMode] of [...candidateModes].slice(0, limit)) {
    const linkHints = await db
      .select({ appointmentId: appointmentMedia.appointmentId })
      .from(appointmentMedia)
      .where(eq(appointmentMedia.mediaAssetId, assetId));
    const appointmentIds = [
      ...new Set(linkHints.map((row) => row.appointmentId)),
    ];

    const claim = await db.transaction(async (tx) => {
      if (appointmentIds.length > 0) {
        await lockAppointmentsForMedia(tx, appointmentIds);
      }
      const [asset] = await tx
        .select({
          id: mediaAssets.id,
          status: mediaAssets.status,
          storageProvider: mediaAssets.storageProvider,
          storageBucket: mediaAssets.storageBucket,
          originalObjectKey: mediaAssets.originalObjectKey,
          displayObjectKey: mediaAssets.displayObjectKey,
          thumbnailObjectKey: mediaAssets.thumbnailObjectKey,
          contactId: mediaAssets.contactId,
          stagingExpiresAt: mediaAssets.stagingExpiresAt,
          processingError: mediaAssets.processingError,
          sourceMetadata: mediaAssets.sourceMetadata,
          createdAt: mediaAssets.createdAt,
          updatedAt: mediaAssets.updatedAt,
          deletedAt: mediaAssets.deletedAt,
        })
        .from(mediaAssets)
        .where(eq(mediaAssets.id, assetId))
        .limit(1)
        .for("update");
      if (!asset || asset.deletedAt) return null;

      const mode: CleanupMode =
        asset.status === "deleting"
          ? asset.processingError?.startsWith("cleanup_claim:deleted")
            ? "deleted"
            : "expired"
          : requestedMode;
      const [activeLink] = await tx
        .select({ id: appointmentMedia.id })
        .from(appointmentMedia)
        .where(
          and(
            eq(appointmentMedia.mediaAssetId, assetId),
            isNull(appointmentMedia.deletedAt),
          ),
        )
        .limit(1);
      const [oldDeletedLink] = await tx
        .select({ id: appointmentMedia.id })
        .from(appointmentMedia)
        .where(
          and(
            eq(appointmentMedia.mediaAssetId, assetId),
            isNotNull(appointmentMedia.deletedAt),
            lte(appointmentMedia.deletedAt, deletedLinkCutoff),
          ),
        )
        .limit(1);
      const [anyLink] = await tx
        .select({ id: appointmentMedia.id })
        .from(appointmentMedia)
        .where(eq(appointmentMedia.mediaAssetId, assetId))
        .limit(1);
      const [quoteLink] = await tx
        .select({ id: instantQuoteMedia.id })
        .from(instantQuoteMedia)
        .where(eq(instantQuoteMedia.mediaAssetId, assetId))
        .limit(1);
      const unowned = !asset.contactId && !anyLink && !quoteLink;
      const orphanDetectedAtValue = asset.sourceMetadata?.["orphanDetectedAt"];
      const orphanDetectedAt =
        typeof orphanDetectedAtValue === "string"
          ? new Date(orphanDetectedAtValue)
          : null;
      const orphanDetectionIsValid =
        orphanDetectedAt !== null &&
        Number.isFinite(orphanDetectedAt.getTime());
      if (
        mode === "deleted" &&
        !oldDeletedLink &&
        unowned &&
        !orphanDetectionIsValid
      ) {
        await tx
          .update(mediaAssets)
          .set({
            sourceMetadata: {
              ...(asset.sourceMetadata ?? {}),
              orphanDetectedAt: now.toISOString(),
            },
            updatedAt: now,
          })
          .where(eq(mediaAssets.id, assetId));
        return null;
      }

      if (asset.status !== "deleting") {
        const abandoned = shouldExpireIncompleteMediaAsset({
          status: asset.status,
          stagingExpiresAt: asset.stagingExpiresAt,
          now,
        });
        const intentionallyRemoved =
          Boolean(oldDeletedLink) && !activeLink && !quoteLink;
        const cascadeOrphan =
          unowned &&
          orphanDetectionIsValid &&
          orphanDetectedAt <= deletedLinkCutoff;
        if (
          (mode === "expired" && !abandoned) ||
          (mode === "deleted" && !intentionallyRemoved && !cascadeOrphan)
        ) {
          return null;
        }
      } else if (mode === "deleted" && (activeLink || quoteLink)) {
        return null;
      }

      try {
        assertAssetStorageLocation(asset);
      } catch (error) {
        await tx
          .update(mediaAssets)
          .set({
            processingError: `cleanup_storage_location_mismatch:${stringError(error)}`,
            updatedAt: now,
          })
          .where(eq(mediaAssets.id, assetId));
        return { storageMismatch: true as const };
      }

      await tx
        .update(mediaAssets)
        .set({
          status: "deleting",
          processingError: `cleanup_claim:${mode}`,
          updatedAt: now,
        })
        .where(eq(mediaAssets.id, assetId));
      return {
        storageMismatch: false as const,
        mode,
        appointmentIds,
        keys: Array.from(
          new Set(
            [
              asset.originalObjectKey,
              asset.displayObjectKey,
              asset.thumbnailObjectKey,
              ...appointmentIds.flatMap((appointmentId) => {
                const prefix = `appointments/${appointmentId}/${assetId}`;
                return [
                  `${prefix}/original.jpg`,
                  `${prefix}/display.jpg`,
                  `${prefix}/thumbnail.jpg`,
                ];
              }),
              ...(asset.contactId
                ? [
                    `contacts/${asset.contactId}/${assetId}/original.jpg`,
                    `contacts/${asset.contactId}/${assetId}/display.jpg`,
                    `contacts/${asset.contactId}/${assetId}/thumbnail.jpg`,
                  ]
                : []),
              ...(Array.isArray(
                asset.sourceMetadata?.["pendingVariantObjectKeys"],
              )
                ? asset.sourceMetadata["pendingVariantObjectKeys"].filter(
                    (value): value is string => typeof value === "string",
                  )
                : []),
            ].filter((value): value is string => Boolean(value)),
          ),
        ),
      };
    });
    if (!claim) continue;
    if (claim.storageMismatch) {
      failures += 1;
      continue;
    }

    try {
      await Promise.all(claim.keys.map((key) => deleteMediaObject(key)));
      await db.transaction(async (tx) => {
        if (claim.appointmentIds.length > 0) {
          await lockAppointmentsForMedia(tx, claim.appointmentIds);
        }
        const [owned] = await tx
          .select({ status: mediaAssets.status })
          .from(mediaAssets)
          .where(eq(mediaAssets.id, assetId))
          .limit(1)
          .for("update");
        if (owned?.status !== "deleting") return;
        await tx
          .update(appointmentMedia)
          .set({ isCover: false, updatedAt: now })
          .where(eq(appointmentMedia.mediaAssetId, assetId));
        await tx
          .update(mediaAssets)
          .set({
            status: claim.mode,
            deletedAt: now,
            processingError:
              claim.mode === "expired" ? "staging_or_processing_expired" : null,
            updatedAt: now,
          })
          .where(eq(mediaAssets.id, assetId));
        for (const appointmentId of claim.appointmentIds) {
          await persistGapFreeMediaOrder(tx, appointmentId, undefined, now);
          await ensureAppointmentCover(tx, appointmentId);
        }
      });
      if (claim.mode === "expired") expiredStaging += 1;
      else purgedAssets += 1;
    } catch (error) {
      await db
        .update(mediaAssets)
        .set({
          processingError: `cleanup_claim:${claim.mode}:failed:${stringError(error)}`,
          updatedAt: now,
        })
        .where(
          and(eq(mediaAssets.id, assetId), eq(mediaAssets.status, "deleting")),
        );
      failures += 1;
    }
  }

  return { expiredStaging, purgedAssets, failures };
}
