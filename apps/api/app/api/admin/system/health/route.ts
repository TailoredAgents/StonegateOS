import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import {
  appointmentMedia,
  appointments,
  getDb,
  mediaAssets,
  mobileOfflineMediaQueueHealth,
  outboxEvents,
  providerHealth,
} from "@/db";
import { resolvePublicSiteBaseUrl } from "@/lib/public-site-url";
import { isGoogleCalendarEnabled } from "@/lib/calendar";
import {
  areAppointmentMediaWritesEnabled,
  arePublicQuoteMediaUploadsEnabled,
  isMediaAutoImportEnabled,
} from "@/lib/feature-flags";
import {
  getMediaStorageBucket,
  getMediaStorageProvider,
  verifyMediaStorageBucketAccess,
} from "@/lib/media-storage";
import {
  inspectObjectStorageConfiguration,
  isProviderConfigurationBlocking,
  type ProviderConfigurationInspection,
} from "@/lib/provider-configuration";
import { isAdminRequest } from "../../../web/admin";

const PROVIDERS = [
  "sms",
  "email",
  "calendar",
  "meta_ads",
  "google_ads",
  "traccar",
  "object_storage",
] as const;

type ProviderStatus = "healthy" | "degraded" | "unknown";

type HealthFinding = {
  id: string;
  severity: "blocker" | "warning";
  title: string;
  detail: string;
  fix: string[];
};

function resolveStatus(row?: {
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
}): ProviderStatus {
  if (!row?.lastSuccessAt && !row?.lastFailureAt) return "unknown";
  if (
    row?.lastFailureAt &&
    (!row.lastSuccessAt || row.lastFailureAt > row.lastSuccessAt)
  ) {
    return "degraded";
  }
  return "healthy";
}

function readSiteUrlEnv(): string {
  return (
    process.env["NEXT_PUBLIC_SITE_URL"] ??
    process.env["SITE_URL"] ??
    ""
  ).trim();
}

function getPublicSiteUrlBlocker(): HealthFinding | null {
  const configured = resolvePublicSiteBaseUrl();
  if (configured) return null;

  const raw = readSiteUrlEnv();
  const hint = raw ? `Current value: ${raw}` : "No value set";
  return {
    id: "public_site_url",
    severity: "blocker",
    title: "Public website URL not configured",
    detail: `Customer-facing links (quotes, partner portal, reschedules) require a valid HTTPS site URL. ${hint}.`,
    fix: [
      "Set `SITE_URL=https://your-domain.com` (or `NEXT_PUBLIC_SITE_URL`) on Render for `stonegate-api` and `stonegate-outbox-worker`.",
      "Redeploy both services.",
      "Re-try the customer-facing action (send quote / invite partner).",
    ],
  };
}

function getTwilioBlocker(): HealthFinding | null {
  const required = [
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_FROM",
  ] as const;
  const missing = required.filter((key) => !(process.env[key] ?? "").trim());
  if (missing.length === 0) return null;

  return {
    id: "twilio_not_configured",
    severity: "blocker",
    title: "Twilio not configured",
    detail: `Outbound calls/SMS are disabled because these env vars are missing: ${missing.join(", ")}.`,
    fix: [
      "Set the missing Twilio env vars on Render for `stonegate-api` and `stonegate-outbox-worker`.",
      "Redeploy both services.",
      "Re-try the call/SMS action.",
    ],
  };
}

function isObjectStorageFeatureEnabled(): boolean {
  return (
    areAppointmentMediaWritesEnabled() ||
    arePublicQuoteMediaUploadsEnabled() ||
    isMediaAutoImportEnabled()
  );
}

function getObjectStorageBlocker(
  configuration: ProviderConfigurationInspection,
): HealthFinding | null {
  if (
    !isProviderConfigurationBlocking({
      enabled: isObjectStorageFeatureEnabled(),
      configuration,
    })
  ) {
    return null;
  }
  return {
    id: "object_storage_not_configured",
    severity: "blocker",
    title: "Appointment media storage is enabled but incomplete",
    detail: `Private object storage cannot accept appointment photos because the following configuration is missing: ${configuration.missing.join(", ")}.`,
    fix: [
      "Configure the private R2 bucket, endpoint, and scoped object-storage credentials on the API and worker.",
      "Verify bucket CORS and lifecycle rules, redeploy, then complete a test photo upload.",
    ],
  };
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }

  const blockers: HealthFinding[] = [];
  const warnings: HealthFinding[] = [];
  const calendarEnabled = isGoogleCalendarEnabled();
  const objectStorageConfiguration = inspectObjectStorageConfiguration();

  const siteUrlBlocker = getPublicSiteUrlBlocker();
  if (siteUrlBlocker) blockers.push(siteUrlBlocker);

  const twilioBlocker = getTwilioBlocker();
  if (twilioBlocker) blockers.push(twilioBlocker);
  const objectStorageBlocker = getObjectStorageBlocker(
    objectStorageConfiguration,
  );
  if (objectStorageBlocker) blockers.push(objectStorageBlocker);
  let configuredStorage: { bucket: string; provider: "r2" | "s3" } | null =
    null;
  let objectStorageVerification:
    | {
        status: "not_configured";
        bucket: null;
        provider: null;
        error: null;
      }
    | {
        status: "verified";
        bucket: string;
        provider: "r2" | "s3";
        error: null;
      }
    | {
        status: "failed";
        bucket: string | null;
        provider: "r2" | "s3" | null;
        error: string;
      } = {
    status: "not_configured",
    bucket: null,
    provider: null,
    error: null,
  };
  if (objectStorageConfiguration.configured) {
    try {
      configuredStorage = await verifyMediaStorageBucketAccess();
      objectStorageVerification = {
        status: "verified",
        ...configuredStorage,
        error: null,
      };
    } catch (error) {
      try {
        configuredStorage = {
          bucket: getMediaStorageBucket(),
          provider: getMediaStorageProvider(),
        };
      } catch {
        configuredStorage = null;
      }
      const detail =
        error instanceof Error
          ? error.message.slice(0, 500)
          : "head_bucket_failed";
      objectStorageVerification = {
        status: "failed",
        bucket: configuredStorage?.bucket ?? null,
        provider: configuredStorage?.provider ?? null,
        error: detail,
      };
      const finding: HealthFinding = {
        id: "object_storage_bucket_unreachable",
        severity: isObjectStorageFeatureEnabled() ? "blocker" : "warning",
        title: "Private appointment-media bucket could not be verified",
        detail: `The owner health check could not complete a read-only HEAD request against the configured bucket: ${detail}.`,
        fix: [
          "Verify the R2 endpoint, private bucket name, and bucket-scoped credentials on the API.",
          "Keep media feature switches off until this check reports verified.",
        ],
      };
      if (finding.severity === "blocker") blockers.push(finding);
      else warnings.push(finding);
    }
  }

  const db = getDb();
  const stuckMediaProcessingCutoff = new Date(Date.now() - 30 * 60 * 1_000);
  const staleOfflineMediaQueueCutoff = new Date(
    Date.now() - 24 * 60 * 60 * 1_000,
  );
  const [
    rows,
    failedMediaRows,
    expiredStagingRows,
    stuckProcessingRows,
    failedMediaOutboxRows,
    storageMismatchRows,
    needsScopeAppointmentRows,
    staleOfflineMediaQueueRows,
  ] = await Promise.all([
    db
      .select({
        provider: providerHealth.provider,
        lastSuccessAt: providerHealth.lastSuccessAt,
        lastFailureAt: providerHealth.lastFailureAt,
        lastFailureDetail: providerHealth.lastFailureDetail,
      })
      .from(providerHealth)
      .where(inArray(providerHealth.provider, [...PROVIDERS])),
    db
      .select({ count: sql<number>`count(*)` })
      .from(mediaAssets)
      .where(
        and(
          or(
            eq(mediaAssets.status, "failed"),
            eq(mediaAssets.status, "deleting"),
            sql`${mediaAssets.processingError} like 'cleanup_storage_location_mismatch:%'`,
          ),
          isNull(mediaAssets.deletedAt),
        ),
      ),
    db
      .select({ count: sql<number>`count(*)` })
      .from(mediaAssets)
      .where(
        and(
          eq(mediaAssets.status, "staging"),
          isNotNull(mediaAssets.stagingExpiresAt),
          lte(mediaAssets.stagingExpiresAt, new Date()),
          isNull(mediaAssets.deletedAt),
        ),
      ),
    db
      .select({ count: sql<number>`count(*)` })
      .from(mediaAssets)
      .where(
        and(
          eq(mediaAssets.status, "processing"),
          lt(mediaAssets.updatedAt, stuckMediaProcessingCutoff),
          isNull(mediaAssets.deletedAt),
        ),
      ),
    db
      .select({ count: sql<number>`count(*)` })
      .from(outboxEvents)
      .where(
        and(
          sql`${outboxEvents.type} like 'appointment_media.%'`,
          isNotNull(outboxEvents.lastError),
          ne(outboxEvents.lastError, "media_auto_import_disabled"),
        ),
      ),
    configuredStorage
      ? db
          .select({ count: sql<number>`count(*)` })
          .from(mediaAssets)
          .where(
            and(
              isNull(mediaAssets.deletedAt),
              or(
                ne(mediaAssets.storageBucket, configuredStorage.bucket),
                ne(mediaAssets.storageProvider, configuredStorage.provider),
              ),
            ),
          )
      : Promise.resolve([{ count: 0 }]),
    db
      .select({
        count: sql<number>`count(distinct ${appointmentMedia.appointmentId})`,
      })
      .from(appointmentMedia)
      .innerJoin(
        appointments,
        eq(appointments.id, appointmentMedia.appointmentId),
      )
      .innerJoin(mediaAssets, eq(mediaAssets.id, appointmentMedia.mediaAssetId))
      .where(
        and(
          eq(appointmentMedia.purpose, "quoted_work"),
          isNull(appointmentMedia.deletedAt),
          isNull(mediaAssets.deletedAt),
          inArray(appointments.status, ["requested", "confirmed", "completed"]),
          or(
            isNull(appointments.quotedScopeText),
            sql`btrim(${appointments.quotedScopeText}) = ''`,
          ),
        ),
      ),
    db
      .select({
        queueCount: sql<number>`count(*)`,
        deviceCount: sql<number>`count(distinct ${mobileOfflineMediaQueueHealth.clientDeviceId})`,
        photoCount: sql<number>`coalesce(sum(${mobileOfflineMediaQueueHealth.queuedCount}), 0)`,
        failedPhotoCount: sql<number>`coalesce(sum(${mobileOfflineMediaQueueHealth.failedCount}), 0)`,
      })
      .from(mobileOfflineMediaQueueHealth)
      .where(
        and(
          sql`${mobileOfflineMediaQueueHealth.queuedCount} > 0`,
          lte(
            mobileOfflineMediaQueueHealth.oldestQueuedAt,
            staleOfflineMediaQueueCutoff,
          ),
        ),
      ),
  ]);

  const rowMap = new Map(rows.map((row) => [row.provider, row]));
  const providers = PROVIDERS.map((provider) => {
    const row = rowMap.get(provider);
    return {
      provider,
      status: resolveStatus(row),
      lastSuccessAt: row?.lastSuccessAt
        ? row.lastSuccessAt.toISOString()
        : null,
      lastFailureAt: row?.lastFailureAt
        ? row.lastFailureAt.toISOString()
        : null,
      lastFailureDetail: row?.lastFailureDetail ?? null,
    };
  });

  for (const provider of providers) {
    if (provider.status !== "degraded") continue;
    if (provider.provider === "calendar" && !calendarEnabled) continue;
    warnings.push({
      id: `provider_${provider.provider}`,
      severity: "warning",
      title: `${provider.provider} provider issue`,
      detail: provider.lastFailureDetail ?? "Provider is degraded.",
      fix: [
        "Open `/team?tab=inbox` or `/team?tab=google-ads` to review provider health details.",
      ],
    });
  }

  const mediaAlertCounts = {
    processingFailures: Number(failedMediaRows[0]?.count ?? 0),
    expiredStaging: Number(expiredStagingRows[0]?.count ?? 0),
    stuckProcessing: Number(stuckProcessingRows[0]?.count ?? 0),
    failedOutboxEvents: Number(failedMediaOutboxRows[0]?.count ?? 0),
    storageLocationMismatches: Number(storageMismatchRows[0]?.count ?? 0),
    needsScopeAppointments: Number(needsScopeAppointmentRows[0]?.count ?? 0),
    staleOfflineQueues: Number(staleOfflineMediaQueueRows[0]?.queueCount ?? 0),
    staleOfflineDevices: Number(
      staleOfflineMediaQueueRows[0]?.deviceCount ?? 0,
    ),
    staleOfflinePhotos: Number(staleOfflineMediaQueueRows[0]?.photoCount ?? 0),
    staleOfflineFailedPhotos: Number(
      staleOfflineMediaQueueRows[0]?.failedPhotoCount ?? 0,
    ),
  };
  if (mediaAlertCounts.processingFailures > 0) {
    warnings.push({
      id: "appointment_media_processing_failures",
      severity: "warning",
      title: "Appointment photos need attention",
      detail: `${mediaAlertCounts.processingFailures} appointment photo(s) failed to import, process, or clean up safely.`,
      fix: [
        "Open the affected appointment gallery to retry the photo or remove the failed item.",
        "Check object-storage provider health and confirm the configured bucket/provider match stored asset metadata before retrying multiple failures.",
      ],
    });
  }
  if (mediaAlertCounts.needsScopeAppointments > 0) {
    warnings.push({
      id: "appointment_media_scope_required",
      severity: "warning",
      title: "Quoted-work scope needs immediate review",
      detail: `${mediaAlertCounts.needsScopeAppointments} active appointment(s) have quoted-work photos but no “Quoted to remove” summary. Confirmation and completion remain blocked until staff adds the scope.`,
      fix: [
        "Open each affected appointment’s Quoted Work section, review the customer photos, and add the quoted-to-remove summary.",
        "Confirm Requested appointments only after the written scope matches what was quoted.",
      ],
    });
  }
  if (mediaAlertCounts.storageLocationMismatches > 0) {
    warnings.push({
      id: "appointment_media_storage_location_mismatch",
      severity: "warning",
      title: "Appointment photos reference another storage location",
      detail: `${mediaAlertCounts.storageLocationMismatches} active appointment photo asset(s) reference a bucket or provider that does not match this deployment.`,
      fix: [
        "Confirm the configured object-storage bucket and provider before reading, retrying, or purging these assets.",
        "Restore the expected configuration or migrate the objects and metadata intentionally; cleanup will not delete from a mismatched location.",
      ],
    });
  }
  if (mediaAlertCounts.expiredStaging > 0) {
    warnings.push({
      id: "appointment_media_expired_staging",
      severity: "warning",
      title: "Expired photo uploads await cleanup",
      detail: `${mediaAlertCounts.expiredStaging} staged appointment photo upload(s) have expired without cleanup.`,
      fix: [
        "Verify the media cleanup worker is running, then run the appointment-media cleanup task.",
      ],
    });
  }
  if (mediaAlertCounts.stuckProcessing > 0) {
    warnings.push({
      id: "appointment_media_processing_stuck",
      severity: "warning",
      title: "Appointment photos are stuck processing",
      detail: `${mediaAlertCounts.stuckProcessing} appointment photo(s) have remained in processing for more than 30 minutes.`,
      fix: [
        "Check object-storage health and worker logs, then retry the affected photo finalization.",
      ],
    });
  }
  if (mediaAlertCounts.failedOutboxEvents > 0) {
    warnings.push({
      id: "appointment_media_outbox_failures",
      severity: "warning",
      title: "Automatic photo imports need attention",
      detail: `${mediaAlertCounts.failedOutboxEvents} appointment-media import event(s) have recorded an error.`,
      fix: [
        "Review worker logs and the failed source message, then retry automatic media import after resolving provider or storage errors.",
      ],
    });
  }
  if (mediaAlertCounts.staleOfflineQueues > 0) {
    warnings.push({
      id: "mobile_offline_media_queues_stale",
      severity: "warning",
      title: "Offline appointment photos have not synced",
      detail: `${mediaAlertCounts.staleOfflinePhotos} photo(s) remain across ${mediaAlertCounts.staleOfflineQueues} employee queue(s) on ${mediaAlertCounts.staleOfflineDevices} device(s) whose oldest item has waited more than 24 hours. ${mediaAlertCounts.staleOfflineFailedPhotos} photo(s) currently show a failed upload state.`,
      fix: [
        "Ask the affected employee to reopen StonegateOS with a reliable connection and keep it open until every queued photo finishes.",
        "Do not clear browser storage or uninstall the PWA while unsynced photos remain.",
      ],
    });
  }

  return NextResponse.json({
    ok: true,
    generatedAt: new Date().toISOString(),
    blockers,
    warnings,
    providers,
    config: {
      publicSiteUrl: resolvePublicSiteBaseUrl(),
      twilioConfigured: !getTwilioBlocker(),
      appointmentMediaWritesEnabled: areAppointmentMediaWritesEnabled(),
      publicQuoteMediaUploadsEnabled: arePublicQuoteMediaUploadsEnabled(),
      mediaAutoImportEnabled: isMediaAutoImportEnabled(),
      objectStorageConfigured: objectStorageConfiguration.configured,
      objectStorageConfigurationIssues: [
        ...objectStorageConfiguration.missing,
        ...objectStorageConfiguration.invalid,
      ],
      objectStorageVerification,
    },
    mediaAlerts: mediaAlertCounts,
  });
}
