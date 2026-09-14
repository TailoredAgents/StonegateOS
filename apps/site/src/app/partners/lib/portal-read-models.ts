import { z } from "zod";
import type {
  PartnerJobSummary,
  PartnerProof,
  PartnerProofMedia,
} from "./portal-v2";
import type { PartnerDashboardNotification } from "../components/PartnerNotificationList";
import { isPortalRecord, parsePortalCollection } from "./portal-load";

const text = z.string();
const nullableText = text.nullable();
const date = text.refine((value) => Number.isFinite(Date.parse(value)));
const timezone = text.refine((value) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
});
const money = z.object({
  amountMinor: z.number().int().safe(),
  currency: text.regex(/^[A-Z]{3}$/u),
  minorUnit: z.number().int().min(0).max(6),
});
const jobSchema = z.object({
  id: text.min(1),
  status: text.min(1),
  confirmationMode: text,
  service: z.object({
    key: nullableText,
    tierKey: nullableText,
    addOns: z.array(
      z.object({
        key: text,
        label: text,
        unitLabel: text,
        quantity: z.number(),
        requiresReview: z.boolean(),
      }),
    ),
  }),
  schedule: z.object({
    arrivalWindow: z
      .object({ startAt: date, endAt: date, timezone })
      .nullable(),
    completedAt: date.nullable(),
  }),
  location: z.object({
    id: nullableText,
    name: nullableText,
    address: z
      .object({ line1: text, city: text, state: text, postalCode: text })
      .nullable(),
  }),
  references: z.object({
    poNumber: nullableText,
    costCenter: nullableText,
    project: nullableText,
  }),
  financial: money.nullable(),
  allowedActions: z.array(text),
  createdAt: date,
  updatedAt: date,
});
export function isPortalJobSummary(value: unknown): value is PartnerJobSummary {
  return jobSchema.safeParse(value).success;
}
export function parsePortalJobs(payload: unknown) {
  return parsePortalCollection(payload, "jobs", isPortalJobSummary);
}
export function parsePortalJob(payload: unknown): PartnerJobSummary | null {
  return isPortalRecord(payload) && isPortalJobSummary(payload["job"])
    ? payload["job"]
    : null;
}

const notificationSchema = z.object({
  id: text.min(1),
  title: text,
  body: text,
  actionPath: nullableText,
  createdAt: date,
  readAt: date.nullable().optional(),
});
export function isPortalNotification(
  value: unknown,
): value is PartnerDashboardNotification {
  return notificationSchema.safeParse(value).success;
}
export function parsePortalNotifications(payload: unknown) {
  return parsePortalCollection(payload, "notifications", isPortalNotification);
}

const overviewSchema = z.object({
  ok: z.literal(true),
  nextJob: z
    .object({
      id: text.min(1),
      status: text,
      locationName: nullableText,
      startAt: date.nullable(),
      endAt: date.nullable(),
      timezone,
    })
    .nullable(),
  savedRequest: z
    .object({ id: text.min(1), locationName: nullableText, updatedAt: date })
    .nullable(),
  outstandingBalances: z.array(money).nullable(),
});
export type PartnerHomeOverview = z.infer<typeof overviewSchema>;
export function parsePortalOverview(
  payload: unknown,
): PartnerHomeOverview | null {
  const result = overviewSchema.safeParse(payload);
  return result.success ? result.data : null;
}

const proofSchema = z.object({
  status: text,
  documentUploadsAvailable: z.boolean().optional(),
  requirements: z.array(
    z.object({
      category: text,
      required: z.boolean(),
      minimumCount: z.number(),
      readyCount: z.number(),
      satisfied: z.boolean(),
      source: text,
    }),
  ),
  outstanding: z.array(text),
  media: z.array(
    z.object({
      id: text,
      category: text,
      caption: nullableText,
      sortOrder: z.number(),
      status: text,
      filename: nullableText,
      contentType: nullableText,
      byteSize: z.number().nullable(),
      width: z.number().nullable(),
      height: z.number().nullable(),
      sha256: nullableText,
      createdAt: date,
      readyAt: date.nullable(),
      error: nullableText,
      downloadIntent: z
        .object({
          thumbnailUrl: nullableText,
          displayUrl: nullableText,
          originalUrl: nullableText,
          expiresAt: date,
        })
        .nullable(),
    }),
  ),
  deletedMedia: z
    .array(
      z.object({
        id: text,
        filename: nullableText,
        category: text,
        deletedAt: date,
        recoverableUntil: date,
      }),
    )
    .optional(),
  packages: z.array(
    z.object({
      id: text,
      version: z.number(),
      checksumSha256: text,
      documents: z.object({
        pdfId: nullableText,
        originalMediaZipId: nullableText,
      }),
      generatedAt: date,
    }),
  ),
  shareLinks: z.array(
    z.object({
      id: text,
      proofPackageId: text,
      expiresAt: date,
      revokedAt: date.nullable(),
      accessCount: z.number(),
      createdAt: date,
    }),
  ),
});
export function isPortalProofMedia(value: unknown): value is PartnerProofMedia {
  return proofSchema.shape.media.element.safeParse(value).success;
}
export function parsePortalProof(payload: unknown): PartnerProof | null {
  if (!isPortalRecord(payload)) return null;
  const result = proofSchema.safeParse(payload["proof"]);
  return result.success ? result.data : null;
}
