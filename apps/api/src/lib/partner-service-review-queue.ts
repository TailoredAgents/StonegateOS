import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  lt,
  or,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  appointments,
  getDb,
  mediaAssets,
  partnerAccounts,
  partnerBookings,
  partnerJobEvidence,
  partnerServiceCatalog,
} from "@/db";
import { readPartnerJobLocationSnapshot } from "./partner-job-location";
import { createMediaReadUrl } from "./media-storage";
import {
  encodePortalV2Cursor,
  parsePortalV2Pagination,
} from "./portal-v2-contract";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const originalJob = alias(partnerBookings, "service_review_original_job");
const text = (value: unknown, limit = 2000) =>
  typeof value === "string" ? value.slice(0, limit) : "";
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const proofCount = (value: unknown) =>
  value === false
    ? 0
    : typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= 0 &&
        value <= 20
      ? value
      : 1;
function preferredWindows(scope: unknown) {
  const windows = record(scope)["preferredWindows"];
  return Array.isArray(windows)
    ? windows.slice(0, 3).flatMap((value) => {
        const window = record(value),
          localDate = text(window["localDate"], 10),
          timeOfDay = text(window["timeOfDay"], 30);
        return /^\d{4}-\d{2}-\d{2}$/u.test(localDate)
          ? [{ localDate, timeOfDay }]
          : [];
      })
    : [];
}
const fields = {
  id: partnerBookings.id,
  accountId: partnerBookings.partnerAccountId,
  accountName: partnerAccounts.name,
  status: partnerBookings.publicStatus,
  createdAt: partnerBookings.createdAt,
  serviceKey: partnerBookings.serviceKey,
  serviceLabel: partnerServiceCatalog.label,
  scope: partnerBookings.scopeSnapshot,
  reasons: partnerBookings.requestedReviewReasons,
  originalId: originalJob.id,
  originalStatus: originalJob.publicStatus,
  originalServiceKey: originalJob.serviceKey,
  originalCreatedAt: originalJob.createdAt,
};
function summary(row: {
  id: string;
  accountId: string | null;
  accountName: string;
  status: string;
  createdAt: Date;
  serviceKey: string | null;
  serviceLabel: string | null;
  scope: unknown;
  reasons: string[];
  originalId: string | null;
  originalStatus: string | null;
  originalServiceKey: string | null;
  originalCreatedAt: Date | null;
}) {
  return {
    id: row.id,
    accountId: row.accountId,
    accountName: row.accountName,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    service:
      row.serviceLabel ??
      row.serviceKey?.replaceAll("_", " ") ??
      "Service request",
    siteName:
      readPartnerJobLocationSnapshot(row.scope)?.name ??
      "Site details in request",
    preferredWindows: preferredWindows(row.scope),
    reasons: row.reasons.slice(0, 30).map((reason) => reason.slice(0, 120)),
    originalJob:
      row.originalId && row.originalStatus && row.originalCreatedAt
        ? {
            id: row.originalId,
            status: row.originalStatus,
            serviceKey: row.originalServiceKey,
            createdAt: row.originalCreatedAt.toISOString(),
          }
        : null,
  };
}

export async function listPartnerServiceReviews(params: URLSearchParams) {
  const accountId = params.get("accountId") ?? "",
    q = (params.get("q") ?? "").trim(),
    historyParam = params.get("includeScheduled"),
    includeScheduled = historyParam === "true";
  if (
    (accountId && !UUID.test(accountId)) ||
    q.length > 100 ||
    (historyParam !== null && !["true", "false"].includes(historyParam)) ||
    (includeScheduled && !accountId)
  )
    return null;
  // History is deliberately company-bound; existing unscoped review reads keep
  // their original behavior. Different cursor kinds prevent crossing modes.
  const cursorKind = includeScheduled
    ? "staff_partner_company_jobs"
    : "staff_partner_service_reviews";
  type Cursor = { id: string; createdAt: string; accountId: string; q: string };
  const page = parsePortalV2Pagination(params, {
    cursorKind,
    allowedQueryKeys: new Set(["accountId", "q", "includeScheduled"]),
    validateCursorPayload(value: unknown): value is Cursor {
      const cursor = record(value);
      return (
        cursor["accountId"] === accountId &&
        cursor["q"] === q &&
        UUID.test(text(cursor["id"])) &&
        Number.isFinite(Date.parse(text(cursor["createdAt"])))
      );
    },
  });
  if (!page.ok) return null;
  const cursor = page.cursor?.payload;
  const rows = await getDb()
    .select({
      ...fields,
      staffAppointmentId: appointments.id,
      arrivalStartAt: partnerBookings.arrivalWindowStartAt,
      arrivalEndAt: partnerBookings.arrivalWindowEndAt,
    })
    .from(partnerBookings)
    .leftJoin(
      originalJob,
      and(
        eq(
          originalJob.id,
          partnerBookings.additionalServiceFromPartnerBookingId,
        ),
        eq(originalJob.partnerAccountId, partnerBookings.partnerAccountId),
      ),
    )
    .innerJoin(
      partnerAccounts,
      eq(partnerBookings.partnerAccountId, partnerAccounts.id),
    )
    .innerJoin(
      appointments,
      and(
        eq(partnerBookings.appointmentId, appointments.id),
        eq(appointments.partnerAccountId, partnerBookings.partnerAccountId),
      ),
    )
    .leftJoin(
      partnerServiceCatalog,
      eq(partnerBookings.serviceKey, partnerServiceCatalog.key),
    )
    .where(
      and(
        includeScheduled
          ? undefined
          : and(
              isNull(appointments.startAt),
              eq(appointments.status, "requested"),
              inArray(partnerBookings.publicStatus, [
                "requested",
                "under_review",
                "approval_needed",
              ]),
            ),
        accountId ? eq(partnerBookings.partnerAccountId, accountId) : undefined,
        q
          ? ilike(
              partnerAccounts.name,
              "%" + q.replace(/[\\%_]/gu, "\\$&") + "%",
            )
          : undefined,
        cursor
          ? or(
              lt(partnerBookings.createdAt, new Date(cursor.createdAt)),
              and(
                eq(partnerBookings.createdAt, new Date(cursor.createdAt)),
                lt(partnerBookings.id, cursor.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(partnerBookings.createdAt), desc(partnerBookings.id))
    .limit(page.limit + 1);
  const items = rows.slice(0, page.limit),
    last = items.at(-1);
  return {
    ok: true,
    requests: items.map((row) => ({
      ...summary(row),
      ...(includeScheduled
        ? {
            appointmentId: row.staffAppointmentId,
            arrivalStartAt: row.arrivalStartAt?.toISOString() ?? null,
            arrivalEndAt: row.arrivalEndAt?.toISOString() ?? null,
          }
        : {}),
    })),
    page: {
      nextCursor:
        rows.length > page.limit && last
          ? encodePortalV2Cursor({
              kind: cursorKind,
              limit: page.limit,
              payload: {
                id: last.id,
                createdAt: last.createdAt.toISOString(),
                accountId,
                q,
              },
            })
          : null,
    },
  };
}

export async function getPartnerServiceReview(
  accountId: string,
  jobId: string,
) {
  if (!UUID.test(accountId) || !UUID.test(jobId)) return null;
  const [row] = await getDb()
    .select({
      ...fields,
      appointmentId: appointments.id,
      appointmentType: appointments.type,
      appointmentStartAt: appointments.startAt,
      appointmentStatus: appointments.status,
      version: appointments.updatedAt,
      proof: partnerBookings.proofRequirementsSnapshot,
    })
    .from(partnerBookings)
    .leftJoin(
      originalJob,
      and(
        eq(
          originalJob.id,
          partnerBookings.additionalServiceFromPartnerBookingId,
        ),
        eq(originalJob.partnerAccountId, partnerBookings.partnerAccountId),
      ),
    )
    .innerJoin(
      partnerAccounts,
      eq(partnerBookings.partnerAccountId, partnerAccounts.id),
    )
    .innerJoin(
      appointments,
      and(
        eq(partnerBookings.appointmentId, appointments.id),
        eq(appointments.partnerAccountId, partnerBookings.partnerAccountId),
      ),
    )
    .leftJoin(
      partnerServiceCatalog,
      eq(partnerBookings.serviceKey, partnerServiceCatalog.key),
    )
    .where(
      and(
        eq(partnerBookings.id, jobId),
        eq(partnerBookings.partnerAccountId, accountId),
      ),
    )
    .limit(1);
  if (!row) return null;
  const scope = record(row.scope),
    contact = record(scope["onSiteContact"]),
    proof = record(row.proof);
  const media = await getDb()
    .select({
      id: partnerJobEvidence.id,
      category: partnerJobEvidence.category,
      caption: partnerJobEvidence.caption,
      status: mediaAssets.status,
      contentType: mediaAssets.contentType,
      displayKey: mediaAssets.displayObjectKey,
      thumbnailKey: mediaAssets.thumbnailObjectKey,
    })
    .from(partnerJobEvidence)
    .innerJoin(
      mediaAssets,
      and(
        eq(partnerJobEvidence.mediaAssetId, mediaAssets.id),
        eq(mediaAssets.partnerAccountId, partnerJobEvidence.partnerAccountId),
      ),
    )
    .where(
      and(
        eq(partnerJobEvidence.partnerAccountId, accountId),
        eq(partnerJobEvidence.partnerBookingId, jobId),
        isNull(partnerJobEvidence.deletedAt),
        isNull(mediaAssets.deletedAt),
      ),
    )
    .orderBy(asc(partnerJobEvidence.sortOrder), asc(partnerJobEvidence.id))
    .limit(40);
  const photos = await Promise.all(
    media.map(async (photo) => {
      const key = photo.displayKey ?? photo.thumbnailKey;
      const url =
        photo.status === "ready" &&
        /^image\/(?:jpeg|png|webp|avif)$/u.test(photo.contentType ?? "") &&
        key
          ? await createMediaReadUrl(key, 300).catch(() => null)
          : null;
      return {
        id: photo.id,
        category: photo.category,
        caption: text(photo.caption, 300),
        status: photo.status,
        url,
      };
    }),
  );
  return {
    ok: true,
    request: {
      ...summary(row),
      location: readPartnerJobLocationSnapshot(scope),
      description: text(scope["description"], 8000),
      crewInstructions: text(scope["crewInstructions"], 2000),
      onSiteContact: {
        name: text(contact["name"], 150),
        phone: text(contact["phone"], 50),
        email: text(contact["email"], 254),
      },
      scopeFields: Object.entries(record(scope["scope"]))
        .filter(
          ([key, value]) =>
            !/secret|token|password|gate|code/iu.test(key) &&
            ["string", "number", "boolean"].includes(typeof value),
        )
        .slice(0, 30)
        .map(([key, value]) => ({
          label: key.slice(0, 100).replaceAll("_", " "),
          value: String(value).slice(0, 2000),
        })),
      proof: {
        before: proofCount(proof["before"]),
        after: proofCount(proof["after"]),
      },
      photos,
      appointment: {
        id: row.appointmentId,
        type: row.appointmentType,
        startAt: row.appointmentStartAt?.toISOString() ?? null,
        status: row.appointmentStatus,
        version: row.version.toISOString(),
      },
      canSchedule:
        row.appointmentStatus === "requested" &&
        row.appointmentStartAt === null &&
        ["requested", "under_review"].includes(row.status),
    },
  };
}
