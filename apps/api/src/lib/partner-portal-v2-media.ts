import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  auditLogs,
  getDb,
  mediaAssets,
  partnerAccountLocations,
  partnerBookingDrafts,
  partnerBookings,
  partnerDraftMedia,
  partnerJobEvidence,
  type DatabaseClient,
} from "@/db";
import {
  MAX_APPOINTMENT_IMAGE_BYTES,
  normalizeAppointmentImage,
  validateDeclaredAppointmentImage,
} from "@/lib/appointment-image";
import type { PartnerPrincipal } from "@/lib/partner-account-authorization";
import {
  canAccessPartnerDraftResource,
  canAccessPartnerJobResource,
} from "@/lib/partner-portal-v2-resource-authorization";
import {
  createMediaReadUrl,
  createMediaUploadUrl,
  deleteMediaObject,
  getMediaObject,
  getMediaStorageBucket,
  getMediaStorageProvider,
  headMediaObject,
  putImmutableMediaObject,
  tryHeadMediaObject,
} from "@/lib/media-storage";

export const PARTNER_MEDIA_CATEGORIES = [
  "intake",
  "before",
  "after",
  "completion",
  "issue",
] as const;
export type PartnerMediaCategory = (typeof PARTNER_MEDIA_CATEGORIES)[number];
export type PartnerMediaParentKind = "draft" | "job";

const MAX_PARTNER_MEDIA_COUNT = 40;
const MAX_PARTNER_MEDIA_BATCH = 10;
const STAGING_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const DOWNLOAD_INTENT_SECONDS = 300;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PARTNER_JOB_EVIDENCE_CATEGORIES = new Set([
  ...PARTNER_MEDIA_CATEGORIES,
  "document",
]);

const OptionalChecksumSchema = z
  .string()
  .trim()
  .regex(/^[0-9a-f]{64}$/iu)
  .transform((value) => value.toLowerCase())
  .nullable()
  .optional();

export const PartnerMediaUploadIntentSchema = z
  .object({
    files: z
      .array(
        z
          .object({
            clientId: z
              .string()
              .trim()
              .regex(/^[A-Za-z0-9_-]{8,100}$/u),
            filename: z.string().trim().min(1).max(180),
            contentType: z.string().trim().min(3).max(100),
            byteLength: z
              .number()
              .int()
              .min(1)
              .max(MAX_APPOINTMENT_IMAGE_BYTES),
            checksumSha256: OptionalChecksumSchema,
            category: z.enum(PARTNER_MEDIA_CATEGORIES).default("intake"),
            caption: z
              .string()
              .trim()
              .max(500)
              .transform((value) => value || null)
              .nullable()
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_PARTNER_MEDIA_BATCH),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<string>();
    for (const [index, file] of value.files.entries()) {
      if (ids.has(file.clientId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["files", index, "clientId"],
          message: "Client IDs must be unique within an upload batch.",
        });
      }
      ids.add(file.clientId);
      try {
        validateDeclaredAppointmentImage({
          contentType: file.contentType,
          byteLength: file.byteLength,
          checksumSha256: file.checksumSha256,
        });
      } catch {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["files", index],
          message: "The image type, size, or checksum is invalid.",
        });
      }
    }
  });

export const PartnerMediaFinalizeSchema = z
  .object({ checksumSha256: OptionalChecksumSchema })
  .strict();

export class PartnerPortalMediaError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message = code,
  ) {
    super(message);
    this.name = "PartnerPortalMediaError";
  }
}

export function orderPartnerMediaAssociations<T extends { id: string }>(
  orderedIds: readonly string[],
  rows: readonly T[],
): T[] {
  const byId = new Map(rows.map((row) => [row.id, row] as const));
  const ordered = orderedIds.map((id) => byId.get(id));
  if (ordered.some((row) => !row)) {
    throw new Error("partner_media_association_reload_failed");
  }
  return ordered.filter((row): row is T => Boolean(row));
}

type PublicMediaValue<T> = T extends readonly (infer Item)[]
  ? PublicMediaValue<Item>[]
  : T extends Record<string, unknown>
    ? {
        [Key in keyof T as Key extends "assetId" | "mediaAssetId"
          ? never
          : Key]: PublicMediaValue<T[Key]>;
      }
    : T;

/**
 * Defense-in-depth serializer for portal media payloads. Storage identifiers
 * are implementation details; association IDs are the only public handles.
 */
export function sanitizePartnerMediaPublicValue<T>(
  value: T,
): PublicMediaValue<T> {
  if (Array.isArray(value)) {
    return value.map((item) =>
      sanitizePartnerMediaPublicValue(item),
    ) as PublicMediaValue<T>;
  }
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== "assetId" && key !== "mediaAssetId")
        .map(([key, item]) => [key, sanitizePartnerMediaPublicValue(item)]),
    ) as PublicMediaValue<T>;
  }
  return value as PublicMediaValue<T>;
}

type TransactionClient = Parameters<DatabaseClient["transaction"]>[0] extends (
  tx: infer Tx,
) => Promise<unknown>
  ? Tx
  : never;
type MediaDatabase = DatabaseClient | TransactionClient;

export type PartnerJobMessageAttachmentHandle = Readonly<{
  id: string;
  category: string;
  caption: string | null;
  filename: string | null;
  contentType: string;
  byteSize: number;
  width: number;
  height: number;
  sha256: string;
  createdAt: string;
  readyAt: string;
}>;

type PartnerJobMessageAttachmentRow = Readonly<{
  id: string;
  partnerAccountId: string;
  partnerBookingId: string;
  category: string;
  caption: string | null;
  evidenceDeletedAt: Date | null;
  assetDeletedAt: Date | null;
  assetStatus: string;
  storageBucket: string;
  originalObjectKey: string;
  filename: string | null;
  contentType: string | null;
  byteSize: number | null;
  width: number | null;
  height: number | null;
  sha256: string | null;
  createdAt: Date;
  readyAt: Date | null;
}>;

export function normalizePartnerJobMessageAttachmentIds(
  value: unknown,
): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== "string") continue;
    const id = candidate.trim().toLowerCase();
    if (!UUID_PATTERN.test(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length === MAX_PARTNER_MEDIA_BATCH) break;
  }
  return ids;
}

function isUsablePartnerJobMessageAttachment(
  row: PartnerJobMessageAttachmentRow,
  accountId: string,
  jobId: string,
): boolean {
  return Boolean(
    UUID_PATTERN.test(row.id) &&
      row.partnerAccountId === accountId &&
      row.partnerBookingId === jobId &&
      PARTNER_JOB_EVIDENCE_CATEGORIES.has(row.category) &&
      row.evidenceDeletedAt === null &&
      row.assetDeletedAt === null &&
      row.assetStatus === "ready" &&
      row.storageBucket.trim().length > 0 &&
      row.originalObjectKey.trim().length > 0 &&
      typeof row.contentType === "string" &&
      row.contentType.trim().length > 0 &&
      row.contentType.length <= 100 &&
      Number.isInteger(row.byteSize) &&
      (row.byteSize ?? 0) > 0 &&
      (row.byteSize ?? 0) <= MAX_APPOINTMENT_IMAGE_BYTES &&
      Number.isInteger(row.width) &&
      (row.width ?? 0) > 0 &&
      Number.isInteger(row.height) &&
      (row.height ?? 0) > 0 &&
      typeof row.sha256 === "string" &&
      /^[0-9a-f]{64}$/iu.test(row.sha256) &&
      row.createdAt instanceof Date &&
      Number.isFinite(row.createdAt.getTime()) &&
      row.readyAt instanceof Date &&
      Number.isFinite(row.readyAt.getTime()),
  );
}

/**
 * Converts internal evidence/media rows to bounded association handles. The
 * projection intentionally excludes media-asset IDs, object-store coordinates,
 * processing details, and any row outside the current account/job.
 */
export function projectPartnerJobMessageAttachmentHandles(input: {
  accountId: string;
  jobId: string;
  requestedIds: unknown;
  rows: readonly PartnerJobMessageAttachmentRow[];
}): PartnerJobMessageAttachmentHandle[] {
  const requestedIds = normalizePartnerJobMessageAttachmentIds(
    input.requestedIds,
  );
  const byId = new Map(
    input.rows
      .filter((row) =>
        isUsablePartnerJobMessageAttachment(row, input.accountId, input.jobId),
      )
      .map((row) => [row.id, row] as const),
  );
  return requestedIds.flatMap((id) => {
    const row = byId.get(id);
    if (!row || !row.readyAt || !row.contentType || !row.sha256) return [];
    const caption = row.caption?.trim().slice(0, 500) || null;
    const filename = row.filename
      ? cleanFilename(row.filename).trim().slice(0, 180) || null
      : null;
    return [
      sanitizePartnerMediaPublicValue({
        id: row.id,
        category: row.category,
        caption,
        filename,
        contentType: row.contentType.trim().toLowerCase(),
        byteSize: row.byteSize!,
        width: row.width!,
        height: row.height!,
        sha256: row.sha256.toLowerCase(),
        createdAt: row.createdAt.toISOString(),
        readyAt: row.readyAt.toISOString(),
      }),
    ];
  });
}

export async function loadReadyPartnerJobMessageAttachments(input: {
  db: MediaDatabase;
  accountId: string;
  jobId: string;
  requestedIds: unknown;
}): Promise<PartnerJobMessageAttachmentHandle[]> {
  const requestedIds = normalizePartnerJobMessageAttachmentIds(
    input.requestedIds,
  );
  if (requestedIds.length === 0) return [];
  const rows = await input.db
    .select({
      id: partnerJobEvidence.id,
      partnerAccountId: partnerJobEvidence.partnerAccountId,
      partnerBookingId: partnerJobEvidence.partnerBookingId,
      category: partnerJobEvidence.category,
      caption: partnerJobEvidence.caption,
      evidenceDeletedAt: partnerJobEvidence.deletedAt,
      assetDeletedAt: mediaAssets.deletedAt,
      assetStatus: mediaAssets.status,
      storageBucket: mediaAssets.storageBucket,
      originalObjectKey: mediaAssets.originalObjectKey,
      filename: mediaAssets.originalFilename,
      contentType: mediaAssets.contentType,
      byteSize: mediaAssets.byteSize,
      width: mediaAssets.width,
      height: mediaAssets.height,
      sha256: mediaAssets.sha256,
      createdAt: partnerJobEvidence.createdAt,
      readyAt: mediaAssets.readyAt,
    })
    .from(partnerJobEvidence)
    .innerJoin(mediaAssets, eq(partnerJobEvidence.mediaAssetId, mediaAssets.id))
    .where(
      and(
        eq(partnerJobEvidence.partnerAccountId, input.accountId),
        eq(partnerJobEvidence.partnerBookingId, input.jobId),
        inArray(partnerJobEvidence.id, requestedIds),
        isNull(partnerJobEvidence.deletedAt),
        isNull(mediaAssets.deletedAt),
        eq(mediaAssets.status, "ready"),
        isNotNull(mediaAssets.readyAt),
        sql`char_length(btrim(${mediaAssets.storageBucket})) > 0`,
        sql`char_length(btrim(${mediaAssets.originalObjectKey})) > 0`,
      ),
    );
  return projectPartnerJobMessageAttachmentHandles({
    accountId: input.accountId,
    jobId: input.jobId,
    requestedIds,
    rows,
  });
}

type AssociationRow = {
  id: string;
  partnerAccountId: string;
  parentId: string;
  assetId: string;
  category: string;
  caption: string | null;
  sortOrder: number;
  createdAt: Date;
  deletedAt: Date | null;
  assetStatus: string;
  originalObjectKey: string;
  displayObjectKey: string | null;
  thumbnailObjectKey: string | null;
  storageBucket: string;
  contentType: string | null;
  byteSize: number | null;
  width: number | null;
  height: number | null;
  sha256: string | null;
  originalFilename: string | null;
  sourceKey: string | null;
  sourceMetadata: Record<string, unknown> | null;
  stagingExpiresAt: Date | null;
  readyAt: Date | null;
};

function cleanFilename(value: string): string {
  const normalized = Array.from(value.normalize("NFKC"))
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127 ? "_" : character;
    })
    .join("")
    .replace(/[/\\]/gu, "_")
    .trim();
  return normalized.slice(0, 180) || "photo";
}

function safeProcessingError(error: unknown): string {
  return error instanceof Error
    ? `${error.name}:${error.message}`.slice(0, 1_000)
    : "media_processing_failed";
}

function metadataString(
  metadata: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = metadata?.[key];
  return typeof value === "string" ? value : null;
}

function metadataNumber(
  metadata: Record<string, unknown> | null,
  key: string,
): number | null {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : null;
}

async function assertParentAvailable(
  db: MediaDatabase,
  input: {
    parentKind: PartnerMediaParentKind;
    parentId: string;
    principal: PartnerPrincipal;
    forUpload?: boolean;
  },
): Promise<void> {
  const accountId = input.principal.accountId;
  if (!accountId) throw new PartnerPortalMediaError("not_found", 404);
  if (input.parentKind === "draft") {
    const [draft] = await db
      .select({
        id: partnerBookingDrafts.id,
        partnerAccountId: partnerBookingDrafts.partnerAccountId,
        createdByMembershipId: partnerBookingDrafts.createdByMembershipId,
        locationId: partnerBookingDrafts.locationId,
        state: partnerBookingDrafts.state,
      })
      .from(partnerBookingDrafts)
      .where(
        and(
          eq(partnerBookingDrafts.id, input.parentId),
          eq(partnerBookingDrafts.partnerAccountId, accountId),
        ),
      )
      .for("share")
      .limit(1);
    if (!draft) throw new PartnerPortalMediaError("not_found", 404);
    const [location] = draft.locationId
      ? await db
          .select({
            propertyId: partnerAccountLocations.propertyId,
            active: partnerAccountLocations.active,
          })
          .from(partnerAccountLocations)
          .where(
            and(
              eq(partnerAccountLocations.partnerAccountId, accountId),
              eq(partnerAccountLocations.id, draft.locationId),
            ),
          )
          .for("share")
          .limit(1)
      : [];
    if (
      !canAccessPartnerDraftResource(input.principal, {
        partnerAccountId: draft.partnerAccountId,
        createdByMembershipId: draft.createdByMembershipId,
        locationId: draft.locationId,
        propertyId: location?.propertyId ?? null,
        locationActive: location?.active ?? false,
      })
    ) {
      throw new PartnerPortalMediaError("not_found", 404);
    }
    if (input.forUpload && !["draft", "ready"].includes(draft.state)) {
      throw new PartnerPortalMediaError("conflict", 409);
    }
    return;
  }
  const [job] = await db
    .select({
      id: partnerBookings.id,
      partnerAccountId: partnerBookings.partnerAccountId,
      propertyId: partnerBookings.propertyId,
      status: partnerBookings.publicStatus,
    })
    .from(partnerBookings)
    .where(
      and(
        eq(partnerBookings.id, input.parentId),
        eq(partnerBookings.partnerAccountId, accountId),
      ),
    )
    .for("share")
    .limit(1);
  if (!job) throw new PartnerPortalMediaError("not_found", 404);
  const [location] = job.propertyId
    ? await db
        .select({ id: partnerAccountLocations.id })
        .from(partnerAccountLocations)
        .where(
          and(
            eq(partnerAccountLocations.partnerAccountId, accountId),
            eq(partnerAccountLocations.propertyId, job.propertyId),
          ),
        )
        .for("share")
        .limit(1)
    : [];
  if (
    !canAccessPartnerJobResource(input.principal, {
      partnerAccountId: accountId,
      propertyId: job.propertyId,
      locationId: location?.id ?? null,
    })
  ) {
    throw new PartnerPortalMediaError("not_found", 404);
  }
  if (input.forUpload && ["canceled", "declined"].includes(job.status)) {
    throw new PartnerPortalMediaError("conflict", 409);
  }
}

async function lockParentForMediaMutation(
  tx: TransactionClient,
  input: {
    parentKind: PartnerMediaParentKind;
    parentId: string;
    principal: PartnerPrincipal;
    allowSubmittedDraftFinalize?: boolean;
  },
): Promise<{ state: string }> {
  const accountId = input.principal.accountId;
  if (!accountId) throw new PartnerPortalMediaError("not_found", 404);
  if (input.parentKind === "draft") {
    const [draft] = await tx
      .select({
        id: partnerBookingDrafts.id,
        partnerAccountId: partnerBookingDrafts.partnerAccountId,
        createdByMembershipId: partnerBookingDrafts.createdByMembershipId,
        locationId: partnerBookingDrafts.locationId,
        state: partnerBookingDrafts.state,
      })
      .from(partnerBookingDrafts)
      .where(
        and(
          eq(partnerBookingDrafts.id, input.parentId),
          eq(partnerBookingDrafts.partnerAccountId, accountId),
        ),
      )
      .for("update")
      .limit(1);
    if (!draft) throw new PartnerPortalMediaError("not_found", 404);
    const [location] = draft.locationId
      ? await tx
          .select({
            propertyId: partnerAccountLocations.propertyId,
            active: partnerAccountLocations.active,
          })
          .from(partnerAccountLocations)
          .where(
            and(
              eq(partnerAccountLocations.partnerAccountId, accountId),
              eq(partnerAccountLocations.id, draft.locationId),
            ),
          )
          .for("share")
          .limit(1)
      : [];
    if (
      !canAccessPartnerDraftResource(input.principal, {
        partnerAccountId: draft.partnerAccountId,
        createdByMembershipId: draft.createdByMembershipId,
        locationId: draft.locationId,
        propertyId: location?.propertyId ?? null,
        locationActive: location?.active ?? false,
      })
    ) {
      throw new PartnerPortalMediaError("not_found", 404);
    }
    if (
      !["draft", "ready"].includes(draft.state) &&
      !(input.allowSubmittedDraftFinalize && draft.state === "submitted")
    ) {
      throw new PartnerPortalMediaError("conflict", 409);
    }
    return { state: draft.state };
  }
  const [job] = await tx
    .select({
      id: partnerBookings.id,
      partnerAccountId: partnerBookings.partnerAccountId,
      propertyId: partnerBookings.propertyId,
      status: partnerBookings.publicStatus,
    })
    .from(partnerBookings)
    .where(
      and(
        eq(partnerBookings.id, input.parentId),
        eq(partnerBookings.partnerAccountId, accountId),
      ),
    )
    .for("update")
    .limit(1);
  if (!job) throw new PartnerPortalMediaError("not_found", 404);
  const [location] = job.propertyId
    ? await tx
        .select({ id: partnerAccountLocations.id })
        .from(partnerAccountLocations)
        .where(
          and(
            eq(partnerAccountLocations.partnerAccountId, accountId),
            eq(partnerAccountLocations.propertyId, job.propertyId),
          ),
        )
        .for("share")
        .limit(1)
    : [];
  if (
    !canAccessPartnerJobResource(input.principal, {
      partnerAccountId: accountId,
      propertyId: job.propertyId,
      locationId: location?.id ?? null,
    })
  ) {
    throw new PartnerPortalMediaError("not_found", 404);
  }
  if (["canceled", "declined"].includes(job.status)) {
    throw new PartnerPortalMediaError("conflict", 409);
  }
  return { state: job.status };
}

async function assertSubmittedDraftAssetTransferred(
  tx: TransactionClient,
  input: {
    parentKind: PartnerMediaParentKind;
    parentState: string;
    accountId: string;
    assetId: string;
  },
): Promise<void> {
  if (input.parentKind !== "draft" || input.parentState !== "submitted") return;
  const [evidence] = await tx
    .select({ id: partnerJobEvidence.id })
    .from(partnerJobEvidence)
    .where(
      and(
        eq(partnerJobEvidence.partnerAccountId, input.accountId),
        eq(partnerJobEvidence.mediaAssetId, input.assetId),
        isNull(partnerJobEvidence.deletedAt),
      ),
    )
    .limit(1);
  if (!evidence) throw new PartnerPortalMediaError("conflict", 409);
}

async function loadAssociationRows(input: {
  parentKind: PartnerMediaParentKind;
  parentId: string;
  accountId: string;
  associationIds?: readonly string[];
  includeDeleted?: boolean;
  db?: MediaDatabase;
}): Promise<AssociationRow[]> {
  const db = input.db ?? getDb();
  const association =
    input.parentKind === "draft" ? partnerDraftMedia : partnerJobEvidence;
  const parentColumn =
    input.parentKind === "draft"
      ? partnerDraftMedia.bookingDraftId
      : partnerJobEvidence.partnerBookingId;
  const rows = await db
    .select({
      id: association.id,
      partnerAccountId: association.partnerAccountId,
      parentId: parentColumn,
      assetId: association.mediaAssetId,
      category: association.category,
      caption: association.caption,
      sortOrder: association.sortOrder,
      createdAt: association.createdAt,
      deletedAt: association.deletedAt,
      assetStatus: mediaAssets.status,
      originalObjectKey: mediaAssets.originalObjectKey,
      displayObjectKey: mediaAssets.displayObjectKey,
      thumbnailObjectKey: mediaAssets.thumbnailObjectKey,
      storageBucket: mediaAssets.storageBucket,
      contentType: mediaAssets.contentType,
      byteSize: mediaAssets.byteSize,
      width: mediaAssets.width,
      height: mediaAssets.height,
      sha256: mediaAssets.sha256,
      originalFilename: mediaAssets.originalFilename,
      sourceKey: mediaAssets.sourceKey,
      sourceMetadata: mediaAssets.sourceMetadata,
      stagingExpiresAt: mediaAssets.stagingExpiresAt,
      readyAt: mediaAssets.readyAt,
    })
    .from(association)
    .innerJoin(mediaAssets, eq(association.mediaAssetId, mediaAssets.id))
    .where(
      and(
        eq(association.partnerAccountId, input.accountId),
        eq(parentColumn, input.parentId),
        input.includeDeleted ? undefined : isNull(association.deletedAt),
        input.associationIds?.length
          ? inArray(association.id, [...input.associationIds])
          : undefined,
      ),
    )
    .orderBy(
      asc(association.sortOrder),
      asc(association.createdAt),
      asc(association.id),
    );
  return rows;
}

async function createMediaDto(row: AssociationRow) {
  const expiresAt = new Date(Date.now() + DOWNLOAD_INTENT_SECONDS * 1_000);
  const [thumbnailUrl, displayUrl, originalUrl] =
    row.assetStatus === "ready"
      ? await Promise.all([
          row.thumbnailObjectKey
            ? createMediaReadUrl(
                row.thumbnailObjectKey,
                DOWNLOAD_INTENT_SECONDS,
              )
            : Promise.resolve(null),
          row.displayObjectKey
            ? createMediaReadUrl(row.displayObjectKey, DOWNLOAD_INTENT_SECONDS)
            : Promise.resolve(null),
          createMediaReadUrl(row.originalObjectKey, DOWNLOAD_INTENT_SECONDS),
        ])
      : [null, null, null];
  return sanitizePartnerMediaPublicValue({
    id: row.id,
    category: row.category,
    caption: row.caption,
    sortOrder: row.sortOrder,
    status: row.assetStatus,
    filename: row.originalFilename,
    contentType: row.contentType,
    byteSize: row.byteSize,
    width: row.width,
    height: row.height,
    sha256: row.assetStatus === "ready" ? row.sha256 : null,
    createdAt: row.createdAt.toISOString(),
    readyAt: row.readyAt?.toISOString() ?? null,
    downloadIntent:
      row.assetStatus === "ready"
        ? {
            thumbnailUrl,
            displayUrl,
            originalUrl,
            expiresAt: expiresAt.toISOString(),
          }
        : null,
    error:
      row.assetStatus === "failed"
        ? "Upload processing failed. Retry finalization or upload a new file."
        : null,
  });
}

export async function listPartnerMedia(input: {
  parentKind: PartnerMediaParentKind;
  parentId: string;
  principal: PartnerPrincipal;
}) {
  const accountId = input.principal.accountId;
  if (!accountId) throw new PartnerPortalMediaError("not_found", 404);
  const db = getDb();
  const rows = await db.transaction(async (tx) => {
    await assertParentAvailable(tx, input);
    return loadAssociationRows({
      parentKind: input.parentKind,
      parentId: input.parentId,
      accountId,
      db: tx,
    });
  });
  return Promise.all(rows.map(createMediaDto));
}

export async function createPartnerMediaUploadIntents(input: {
  parentKind: PartnerMediaParentKind;
  parentId: string;
  principal: PartnerPrincipal;
  idempotencyKeyHash: string;
  files: z.infer<typeof PartnerMediaUploadIntentSchema>["files"];
}) {
  if (!input.principal.accountId || !input.principal.membershipId) {
    throw new PartnerPortalMediaError("legacy_scope_unavailable", 409);
  }
  const accountId = input.principal.accountId;
  const membershipId = input.principal.membershipId;
  const bucket = getMediaStorageBucket();
  const provider = getMediaStorageProvider();
  const db = getDb();
  const rows = await db.transaction(async (tx) => {
    await lockParentForMediaMutation(tx, {
      parentKind: input.parentKind,
      parentId: input.parentId,
      principal: input.principal,
    });
    const association =
      input.parentKind === "draft" ? partnerDraftMedia : partnerJobEvidence;
    const parentColumn =
      input.parentKind === "draft"
        ? partnerDraftMedia.bookingDraftId
        : partnerJobEvidence.partnerBookingId;
    const countRows = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(association)
      .where(
        and(
          eq(association.partnerAccountId, accountId),
          eq(parentColumn, input.parentId),
          isNull(association.deletedAt),
        ),
      );
    const count = countRows[0]?.count ?? 0;
    const sourceKeys = input.files.map(
      (file) =>
        `partner:${accountId}:${input.parentKind}:${input.parentId}:${file.clientId}`,
    );
    const existingAssets = await tx
      .select({
        sourceKey: mediaAssets.sourceKey,
        assetId: mediaAssets.id,
        sourceMetadata: mediaAssets.sourceMetadata,
      })
      .from(mediaAssets)
      .where(inArray(mediaAssets.sourceKey, sourceKeys));
    const existingByKey = new Map(
      existingAssets.flatMap((row) =>
        row.sourceKey ? ([[row.sourceKey, row]] as const) : [],
      ),
    );
    const newCount = sourceKeys.filter((key) => !existingByKey.has(key)).length;
    if (count + newCount > MAX_PARTNER_MEDIA_COUNT) {
      throw new PartnerPortalMediaError("conflict", 409);
    }
    const now = new Date();
    const stagingExpiresAt = new Date(now.getTime() + STAGING_LIFETIME_MS);
    const createdIds: string[] = [];
    const existingAssociationIds = new Set<string>();
    for (const [index, file] of input.files.entries()) {
      const sourceKey = sourceKeys[index]!;
      const requestFingerprint = createHash("sha256")
        .update(
          JSON.stringify({
            clientId: file.clientId,
            filename: cleanFilename(file.filename),
            contentType: file.contentType.split(";", 1)[0]?.toLowerCase(),
            byteLength: file.byteLength,
            checksumSha256: file.checksumSha256 ?? null,
            category: file.category,
            caption: file.caption ?? null,
          }),
          "utf8",
        )
        .digest("hex");
      const existingAsset = existingByKey.get(sourceKey);
      if (existingAsset) {
        if (
          metadataString(existingAsset.sourceMetadata, "requestFingerprint") !==
            requestFingerprint ||
          metadataString(existingAsset.sourceMetadata, "idempotencyKeyHash") !==
            input.idempotencyKeyHash
        ) {
          throw new PartnerPortalMediaError("idempotency_conflict", 409);
        }
        const associated = await loadAssociationRows({
          parentKind: input.parentKind,
          parentId: input.parentId,
          accountId,
          db: tx,
        });
        const existingAssociation = associated.find(
          (row) => row.assetId === existingAsset.assetId,
        );
        if (!existingAssociation) {
          throw new PartnerPortalMediaError("idempotency_conflict", 409);
        }
        createdIds.push(existingAssociation.id);
        existingAssociationIds.add(existingAssociation.id);
        continue;
      }
      const assetId = randomUUID();
      const stagingKey = `partner/staging/${accountId}/${assetId}/upload`;
      const [asset] = await tx
        .insert(mediaAssets)
        .values({
          id: assetId,
          storageProvider: provider,
          storageBucket: bucket,
          originalObjectKey: stagingKey,
          source: "partner_portal",
          sourceKey,
          status: "staging",
          originalFilename: cleanFilename(file.filename),
          contentType: file.contentType.split(";", 1)[0]?.toLowerCase(),
          byteSize: file.byteLength,
          sourceMetadata: {
            partnerAccountId: accountId,
            parentKind: input.parentKind,
            parentId: input.parentId,
            uploaderMembershipId: membershipId,
            declaredByteLength: file.byteLength,
            expectedSha256: file.checksumSha256 ?? null,
            requestFingerprint,
            idempotencyKeyHash: input.idempotencyKeyHash,
          },
          stagingExpiresAt,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: mediaAssets.id });
      if (!asset) throw new Error("partner_media_asset_create_failed");
      const [linked] =
        input.parentKind === "draft"
          ? await tx
              .insert(partnerDraftMedia)
              .values({
                partnerAccountId: accountId,
                bookingDraftId: input.parentId,
                mediaAssetId: asset.id,
                category: file.category,
                caption: file.caption ?? null,
                sortOrder: count + index,
                uploadedByMembershipId: membershipId,
                createdAt: now,
              })
              .returning({ id: partnerDraftMedia.id })
          : await tx
              .insert(partnerJobEvidence)
              .values({
                partnerAccountId: accountId,
                partnerBookingId: input.parentId,
                mediaAssetId: asset.id,
                category: file.category,
                caption: file.caption ?? null,
                sortOrder: count + index,
                uploadedByMembershipId: membershipId,
                createdAt: now,
              })
              .returning({ id: partnerJobEvidence.id });
      if (!linked) throw new Error("partner_media_association_create_failed");
      createdIds.push(linked.id);
    }
    const associatedRows = await loadAssociationRows({
      parentKind: input.parentKind,
      parentId: input.parentId,
      accountId,
      associationIds: createdIds,
      db: tx,
    });
    // Upload-intent responses must retain request order. The browser pairs
    // each private storage URL with the File at the same index; an unordered
    // SQL IN result could otherwise upload one customer's image under another
    // file's declared type, byte length, caption, or proof category.
    return orderPartnerMediaAssociations(createdIds, associatedRows).map(
      (row) => ({
        ...row,
        wasExisting: existingAssociationIds.has(row.id),
      }),
    );
  });

  return sanitizePartnerMediaPublicValue(
    await Promise.all(
      rows.map(async (row) => {
        if (row.assetStatus === "ready") {
          return {
            id: row.id,
            status: row.assetStatus,
            alreadyExists: true,
            requiresUpload: false,
            uploadIntent: null,
          };
        }
        const expectedSha256 = metadataString(
          row.sourceMetadata,
          "expectedSha256",
        );
        const declaredByteLength =
          metadataNumber(row.sourceMetadata, "declaredByteLength") ??
          row.byteSize;
        if (!declaredByteLength) {
          throw new PartnerPortalMediaError("conflict", 409);
        }
        let stagingObjectExists = row.assetStatus === "processing";
        if (row.wasExisting && !stagingObjectExists) {
          stagingObjectExists = Boolean(
            await tryHeadMediaObject(row.originalObjectKey),
          );
        }
        if (stagingObjectExists) {
          return {
            id: row.id,
            status: row.assetStatus,
            alreadyExists: true,
            requiresUpload: false,
            uploadIntent: null,
          };
        }
        const upload = await createMediaUploadUrl({
          key: row.originalObjectKey,
          contentType: row.contentType ?? "application/octet-stream",
          byteLength: declaredByteLength,
          checksumSha256Hex: expectedSha256,
          expiresInSeconds: DOWNLOAD_INTENT_SECONDS,
          writeOnce: true,
        });
        return {
          id: row.id,
          status: row.assetStatus,
          alreadyExists: row.wasExisting,
          requiresUpload: true,
          uploadIntent: {
            url: upload.url,
            method: "PUT",
            headers: upload.headers,
            expiresAt: upload.expiresAt.toISOString(),
          },
        };
      }),
    ),
  );
}

export async function finalizePartnerMedia(input: {
  parentKind: PartnerMediaParentKind;
  parentId: string;
  associationId: string;
  checksumSha256?: string | null;
  principal: PartnerPrincipal;
  correlationId: string;
}) {
  const accountId = input.principal.accountId;
  if (!accountId) throw new PartnerPortalMediaError("not_found", 404);
  const db = getDb();
  let row = await db.transaction(async (tx) => {
    const parent = await lockParentForMediaMutation(tx, {
      parentKind: input.parentKind,
      parentId: input.parentId,
      principal: input.principal,
      allowSubmittedDraftFinalize: true,
    });
    const [association] = await loadAssociationRows({
      parentKind: input.parentKind,
      parentId: input.parentId,
      accountId,
      associationIds: [input.associationId],
      db: tx,
    });
    if (!association) throw new PartnerPortalMediaError("not_found", 404);
    await assertSubmittedDraftAssetTransferred(tx, {
      parentKind: input.parentKind,
      parentState: parent.state,
      accountId,
      assetId: association.assetId,
    });
    if (association.assetStatus === "ready") return association;
    if (!["staging", "failed"].includes(association.assetStatus)) {
      throw new PartnerPortalMediaError("conflict", 409);
    }
    const [claimed] = await tx
      .update(mediaAssets)
      .set({
        status: "processing",
        processingError: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(mediaAssets.id, association.assetId),
          inArray(mediaAssets.status, ["staging", "failed"]),
        ),
      )
      .returning({ id: mediaAssets.id });
    if (!claimed) throw new PartnerPortalMediaError("conflict", 409);
    return association;
  });
  if (row.assetStatus === "ready") {
    const expected = input.checksumSha256?.toLowerCase();
    const actual = metadataString(
      row.sourceMetadata,
      "inputSha256",
    )?.toLowerCase();
    if (expected && actual && expected !== actual) {
      throw new PartnerPortalMediaError("idempotency_conflict", 409);
    }
    return createMediaDto(row);
  }

  const stagingKey = row.originalObjectKey;
  const finalPrefix = `partner/${accountId}/${input.parentKind}/${input.parentId}/${row.assetId}`;
  const originalKey = `${finalPrefix}/original.jpg`;
  const displayKey = `${finalPrefix}/display.jpg`;
  const thumbnailKey = `${finalPrefix}/thumbnail.jpg`;
  try {
    const head = await headMediaObject(stagingKey);
    const declaredLength =
      metadataNumber(row.sourceMetadata, "declaredByteLength") ?? row.byteSize;
    if (
      head.byteLength === null ||
      head.byteLength < 1 ||
      head.byteLength > MAX_APPOINTMENT_IMAGE_BYTES ||
      (declaredLength !== null && head.byteLength !== declaredLength)
    ) {
      throw new PartnerPortalMediaError("invalid_fields", 422);
    }
    const bytes = await getMediaObject(stagingKey, MAX_APPOINTMENT_IMAGE_BYTES);
    const actualSha256 = createHash("sha256").update(bytes).digest("hex");
    const expectedSha256 =
      input.checksumSha256?.toLowerCase() ??
      metadataString(row.sourceMetadata, "expectedSha256")?.toLowerCase();
    if (expectedSha256 && expectedSha256 !== actualSha256) {
      throw new PartnerPortalMediaError("invalid_fields", 422);
    }
    const normalized = await normalizeAppointmentImage(
      bytes,
      head.contentType ?? row.contentType,
    );
    await Promise.all([
      putImmutableMediaObject({
        key: originalKey,
        body: normalized.original,
        contentType: normalized.contentType,
      }),
      putImmutableMediaObject({
        key: displayKey,
        body: normalized.display,
        contentType: normalized.contentType,
      }),
      putImmutableMediaObject({
        key: thumbnailKey,
        body: normalized.thumbnail,
        contentType: normalized.contentType,
      }),
    ]);
    const now = new Date();
    await db.transaction(async (tx) => {
      const parent = await lockParentForMediaMutation(tx, {
        parentKind: input.parentKind,
        parentId: input.parentId,
        principal: input.principal,
        allowSubmittedDraftFinalize: true,
      });
      await assertSubmittedDraftAssetTransferred(tx, {
        parentKind: input.parentKind,
        parentState: parent.state,
        accountId,
        assetId: row.assetId,
      });
      const [updated] = await tx
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
          readyAt: now,
          processingError: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(mediaAssets.id, row.assetId),
            eq(mediaAssets.status, "processing"),
          ),
        )
        .returning({ id: mediaAssets.id });
      if (!updated) throw new Error("partner_media_finalize_race");
      await tx.insert(auditLogs).values({
        actorType: "human",
        actorId: input.principal.partnerUserId,
        actorLabel: input.principal.email,
        actorRole: input.principal.roleKey,
        sessionId: input.principal.session.id,
        authMethod: "partner_session",
        correlationId: input.correlationId,
        requiredPermissions: ["media.upload"],
        surface: "partner_portal_v2",
        action: "partner.media.finalized",
        entityType:
          input.parentKind === "draft"
            ? "partner_draft_media"
            : "partner_job_evidence",
        entityId: input.associationId,
        meta: {
          partnerAccountId: accountId,
          parentKind: input.parentKind,
          parentId: input.parentId,
          category: row.category,
          sha256: normalized.sha256,
        },
      });
    });
    if (stagingKey !== originalKey) {
      await deleteMediaObject(stagingKey).catch(() => undefined);
    }
  } catch (error) {
    await db
      .update(mediaAssets)
      .set({
        status: "failed",
        processingError: safeProcessingError(error),
        updatedAt: new Date(),
      })
      .where(eq(mediaAssets.id, row.assetId));
    if (error instanceof PartnerPortalMediaError) throw error;
    throw new PartnerPortalMediaError("invalid_fields", 422);
  }
  const [completed] = await loadAssociationRows({
    parentKind: input.parentKind,
    parentId: input.parentId,
    accountId,
    associationIds: [input.associationId],
  });
  if (!completed) throw new PartnerPortalMediaError("not_found", 404);
  return createMediaDto(completed);
}

export async function softDeletePartnerMedia(input: {
  parentKind: PartnerMediaParentKind;
  parentId: string;
  associationId: string;
  principal: PartnerPrincipal;
}) {
  const accountId = input.principal.accountId;
  if (!accountId) throw new PartnerPortalMediaError("not_found", 404);
  const db = getDb();
  const association =
    input.parentKind === "draft" ? partnerDraftMedia : partnerJobEvidence;
  const parentColumn =
    input.parentKind === "draft"
      ? partnerDraftMedia.bookingDraftId
      : partnerJobEvidence.partnerBookingId;
  const now = new Date();
  const purgeEligibleAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000);
  const deleted = await db.transaction(async (tx) => {
    await lockParentForMediaMutation(tx, input);
    const [row] = await tx
      .update(association)
      .set({ deletedAt: now, purgeEligibleAt })
      .where(
        and(
          eq(association.id, input.associationId),
          eq(association.partnerAccountId, accountId),
          eq(parentColumn, input.parentId),
          isNull(association.deletedAt),
        ),
      )
      .returning({ id: association.id });
    return row;
  });
  if (!deleted) throw new PartnerPortalMediaError("not_found", 404);
  return {
    id: deleted.id,
    deletedAt: now.toISOString(),
    purgeEligibleAt: purgeEligibleAt.toISOString(),
  };
}
