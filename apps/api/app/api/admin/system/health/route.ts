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
  paymentAttempts,
  paymentProviderEvents,
  paymentRefunds,
  payments,
  providerHealth,
} from "@/db";
import { resolvePublicSiteBaseUrl } from "@/lib/public-site-url";
import { isGoogleCalendarEnabled } from "@/lib/calendar";
import { isSquarePosEnabled } from "@/lib/payment-feature-flags";
import {
  isExpenseReceiptCaptureApiEnabled,
  isExpenseReceiptCaptureEnabled,
  isExpenseReceiptWorkerEnabled,
} from "@/lib/expense-feature-flags";
import { isPaymentLedgerSchemaAvailable } from "@/lib/payment-schema";
import { SQUARE_PROVIDER_EVENT_LEASE_MS } from "@/lib/square-payments";
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
  inspectEmailProviderConfiguration,
  inspectObjectStorageConfiguration,
  inspectSquareConfiguration,
  isProviderConfigurationBlocking,
  type ProviderConfigurationInspection,
} from "@/lib/provider-configuration";
import { requirePermission } from "@/lib/permissions";

const PROVIDERS = [
  "sms",
  "email",
  "calendar",
  "meta_ads",
  "google_ads",
  "traccar",
  "square",
  "object_storage",
  "openai_expense_receipts",
  "worker:outbox",
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

function getSquareBlocker(
  configuration: ProviderConfigurationInspection,
): HealthFinding | null {
  if (
    !isProviderConfigurationBlocking({
      enabled: isSquarePosEnabled(),
      configuration,
    })
  ) {
    return null;
  }
  const issues = [
    ...configuration.missing.map((key) => `missing ${key}`),
    ...configuration.invalid,
  ];
  return {
    id: "square_not_configured",
    severity: "blocker",
    title: "Square Tap to Pay is enabled but incomplete",
    detail: `Square payment collection is blocked because its configuration is incomplete: ${issues.join(", ")}.`,
    fix: [
      "Configure the missing Square production credentials and exact callback/webhook URLs.",
      "Redeploy the API and verify the Square provider health check before enabling employees.",
    ],
  };
}

function isObjectStorageFeatureEnabled(): boolean {
  return (
    areAppointmentMediaWritesEnabled() ||
    arePublicQuoteMediaUploadsEnabled() ||
    isMediaAutoImportEnabled() ||
    isExpenseReceiptCaptureEnabled()
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
    title: "Private media storage is enabled but incomplete",
    detail: `Private object storage cannot accept enabled appointment or receipt uploads because the following configuration is missing: ${configuration.missing.join(", ")}.`,
    fix: [
      "Configure the private R2 bucket, endpoint, and scoped object-storage credentials on the API and worker.",
      "Verify bucket CORS and lifecycle rules, redeploy, then complete a test photo upload.",
    ],
  };
}

export async function GET(request: NextRequest): Promise<Response> {
  const permissionError = await requirePermission(request, "access.manage");
  if (permissionError) return permissionError;

  const blockers: HealthFinding[] = [];
  const warnings: HealthFinding[] = [];
  const calendarEnabled = isGoogleCalendarEnabled();
  const receiptApiEnabled = isExpenseReceiptCaptureApiEnabled();
  const receiptWorkerEnabled = isExpenseReceiptWorkerEnabled();
  const receiptCaptureEnabled = isExpenseReceiptCaptureEnabled();
  const squareConfiguration = inspectSquareConfiguration();
  const emailConfiguration = inspectEmailProviderConfiguration();
  const objectStorageConfiguration = inspectObjectStorageConfiguration();

  if (receiptApiEnabled !== receiptWorkerEnabled) {
    blockers.push({
      id: "expense_receipt_flag_mismatch",
      severity: "blocker",
      title: "Receipt capture API and worker flags do not match",
      detail:
        "Receipt uploads remain unavailable because API intake and worker analysis must be enabled together.",
      fix: [
        "Set `EXPENSE_RECEIPT_CAPTURE_ENABLED` and `EXPENSE_RECEIPT_WORKER_ENABLED` to the same value on both the API and outbox worker.",
        "Redeploy both services before running the owner receipt canary.",
      ],
    });
  }
  if (receiptCaptureEnabled && !(process.env["OPENAI_API_KEY"] ?? "").trim()) {
    blockers.push({
      id: "expense_receipt_openai_not_configured",
      severity: "blocker",
      title: "Receipt extraction is enabled without OpenAI credentials",
      detail:
        "Receipt images can be stored, but asynchronous extraction cannot run without OPENAI_API_KEY.",
      fix: [
        "Configure `OPENAI_API_KEY` on the outbox worker and API.",
        "Redeploy, then complete a reviewed receipt canary before employee rollout.",
      ],
    });
  }

  if (!emailConfiguration.configured) {
    const issues = [
      ...emailConfiguration.missing.map((key) => `missing ${key}`),
      ...emailConfiguration.invalid,
    ];
    warnings.push({
      id: "email_not_configured",
      severity: "warning",
      title: "Outbound email is unavailable",
      detail: `Email delivery is disabled or unsafe: ${issues.join(", ")}.`,
      fix: [
        "Configure the bounded SMTP settings on both the API and outbox worker, then send a provider sandbox canary.",
      ],
    });
  }

  const siteUrlBlocker = getPublicSiteUrlBlocker();
  if (siteUrlBlocker) blockers.push(siteUrlBlocker);

  const twilioBlocker = getTwilioBlocker();
  if (twilioBlocker) blockers.push(twilioBlocker);
  const squareBlocker = getSquareBlocker(squareConfiguration);
  if (squareBlocker) blockers.push(squareBlocker);
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
        title: "Private media bucket could not be verified",
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
  const paymentLedgerAvailable = await isPaymentLedgerSchemaAvailable(db);
  const emptyCountRows = Promise.resolve([{ count: 0 }]);
  const staleAttemptCutoff = new Date(Date.now() - 35 * 60 * 1_000);
  const staleProviderEventLeaseCutoff = new Date(
    Date.now() - SQUARE_PROVIDER_EVENT_LEASE_MS,
  );
  const stuckMediaProcessingCutoff = new Date(Date.now() - 30 * 60 * 1_000);
  const staleOfflineMediaQueueCutoff = new Date(
    Date.now() - 24 * 60 * 60 * 1_000,
  );
  const [
    rows,
    stuckAttemptRows,
    unmatchedPaymentRows,
    failedEventRows,
    refundReviewRows,
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
    paymentLedgerAvailable
      ? db
          .select({ count: sql<number>`count(*)` })
          .from(paymentAttempts)
          .where(
            and(
              eq(paymentAttempts.provider, "square"),
              or(
                inArray(paymentAttempts.status, ["needs_review", "expired"]),
                and(
                  inArray(paymentAttempts.status, [
                    "created",
                    "launched",
                    "pending_verification",
                  ]),
                  lt(paymentAttempts.updatedAt, staleAttemptCutoff),
                ),
              ),
            ),
          )
      : emptyCountRows,
    paymentLedgerAvailable
      ? db
          .select({ count: sql<number>`count(*)` })
          .from(payments)
          .where(
            and(
              inArray(payments.provider, ["square", "stripe"]),
              or(
                isNull(payments.appointmentId),
                eq(payments.canonicalStatus, "needs_review"),
              ),
            ),
          )
      : emptyCountRows,
    paymentLedgerAvailable
      ? db
          .select({ count: sql<number>`count(*)` })
          .from(paymentProviderEvents)
          .where(
            and(
              eq(paymentProviderEvents.provider, "square"),
              or(
                inArray(paymentProviderEvents.processingStatus, [
                  "failed",
                  "needs_review",
                ]),
                and(
                  inArray(paymentProviderEvents.processingStatus, [
                    "processing",
                    "received",
                  ]),
                  or(
                    lte(
                      paymentProviderEvents.processedAt,
                      staleProviderEventLeaseCutoff,
                    ),
                    and(
                      isNull(paymentProviderEvents.processedAt),
                      lte(
                        paymentProviderEvents.receivedAt,
                        staleProviderEventLeaseCutoff,
                      ),
                    ),
                  ),
                ),
              ),
            ),
          )
      : emptyCountRows,
    paymentLedgerAvailable
      ? db
          .select({ count: sql<number>`count(*)` })
          .from(paymentRefunds)
          .where(
            and(
              eq(paymentRefunds.provider, "square"),
              or(
                eq(paymentRefunds.canonicalStatus, "needs_review"),
                and(
                  sql`${paymentRefunds.metadata}->>'commissionReviewRequired' = 'true'`,
                  sql`${paymentRefunds.metadata}->>'commissionReviewAcknowledgedAt' is null`,
                ),
              ),
            ),
          )
      : emptyCountRows,
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
  if (receiptCaptureEnabled) {
    const worker = rowMap.get("worker:outbox");
    const workerSuccessAt = worker?.lastSuccessAt?.getTime() ?? 0;
    const workerFailureAt = worker?.lastFailureAt?.getTime() ?? 0;
    const workerHeartbeatHealthy =
      workerSuccessAt > 0 &&
      Date.now() - workerSuccessAt <= 90_000 &&
      workerSuccessAt >= workerFailureAt;
    if (!workerHeartbeatHealthy) {
      blockers.push({
        id: "expense_receipt_worker_unavailable",
        severity: "blocker",
        title: "Receipt analysis worker is unavailable",
        detail:
          workerSuccessAt > 0
            ? "The outbox worker heartbeat is stale or its latest loop failed."
            : "No outbox worker heartbeat has been recorded.",
        fix: [
          "Verify the outbox worker is deployed with the receipt and R2 settings.",
          "Keep receipt capture disabled until its heartbeat is current.",
        ],
      });
    }

    const receiptProvider = rowMap.get("openai_expense_receipts");
    const providerSuccessAt = receiptProvider?.lastSuccessAt?.getTime() ?? 0;
    const providerFailureAt = receiptProvider?.lastFailureAt?.getTime() ?? 0;
    if (providerSuccessAt === 0 || providerFailureAt > providerSuccessAt) {
      blockers.push({
        id: "expense_receipt_canary_required",
        severity: "blocker",
        title: "Receipt extraction canary has not passed",
        detail:
          providerSuccessAt === 0
            ? "No successful receipt extraction has been recorded."
            : "The latest receipt extraction provider event is a failure.",
        fix: [
          "Run one owner-only receipt through upload, extraction, human review, and confirmation.",
          "Verify the posted expense and private receipt before widening the rollout.",
        ],
      });
    }
  }
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

  const paymentAlertCounts = {
    stuckAttempts: Number(stuckAttemptRows[0]?.count ?? 0),
    unmatchedPayments: Number(unmatchedPaymentRows[0]?.count ?? 0),
    failedEvents: Number(failedEventRows[0]?.count ?? 0),
    refundReviews: Number(refundReviewRows[0]?.count ?? 0),
  };
  if (paymentAlertCounts.stuckAttempts > 0) {
    warnings.push({
      id: "square_attempts_stuck",
      severity: "warning",
      title: "Square payments awaiting reconciliation",
      detail: `${paymentAlertCounts.stuckAttempts} Square payment attempt(s) are stale, expired, or need review.`,
      fix: [
        "Open the owner payment reconciliation view and run a Square sweep.",
        "Do not collect the same balance again until the provider result is resolved.",
      ],
    });
  }
  if (paymentAlertCounts.unmatchedPayments > 0) {
    warnings.push({
      id: "provider_payments_unmatched",
      severity: "warning",
      title: "Provider payments need owner review",
      detail: `${paymentAlertCounts.unmatchedPayments} Square or historical Stripe payment(s) are unmatched or need owner review.`,
      fix: [
        "Open owner payment reconciliation and compare the provider record before attaching any payment.",
      ],
    });
  }
  if (paymentAlertCounts.failedEvents > 0) {
    warnings.push({
      id: "square_events_failed",
      severity: "warning",
      title: "Square webhook or reconciliation failures",
      detail: `${paymentAlertCounts.failedEvents} Square provider event(s) failed, stalled, or need review.`,
      fix: [
        "Verify the exact Square webhook notification URL and signature key, then retry reconciliation.",
      ],
    });
  }
  if (paymentAlertCounts.refundReviews > 0) {
    warnings.push({
      id: "square_refunds_review",
      severity: "warning",
      title: "Square refund and commission review",
      detail: `${paymentAlertCounts.refundReviews} refund(s) need financial or commission-impact review.`,
      fix: [
        "Review the refund against completed-job commissions and locked payouts, then acknowledge the reconciliation item.",
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
      detail: `${mediaAlertCounts.needsScopeAppointments} active appointment(s) have quoted-work photos but no “Quoted to remove” summary. Confirmation, payment, and completion remain blocked until staff adds the scope.`,
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
      emailConfigured: emailConfiguration.configured,
      emailConfigurationIssues: [
        ...emailConfiguration.missing.map((key) => `missing ${key}`),
        ...emailConfiguration.invalid,
      ],
      squarePosEnabled: isSquarePosEnabled(),
      squareConfigured: squareConfiguration.configured,
      squareConfigurationIssues: [
        ...squareConfiguration.missing.map((key) => `missing ${key}`),
        ...squareConfiguration.invalid,
      ],
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
    paymentAlerts: paymentAlertCounts,
    mediaAlerts: mediaAlertCounts,
  });
}
