import "dotenv/config";
import Module from "node:module";
import path from "node:path";
import {
  formatOutboxWorkerLog,
  outboxWorkerErrorDetail,
  parseOutboxWorkerConfiguration,
  shouldLogOutboxBatch,
  startOutboxWorkerHeartbeat,
} from "../apps/api/src/lib/outbox-worker-runtime";

type ModuleResolver = (
  request: string,
  parent: unknown,
  isMain: boolean,
  options: unknown,
) => string;

function registerAliases() {
  const moduleInternals = Module as unknown as {
    _resolveFilename: ModuleResolver;
  };
  const originalResolve = moduleInternals._resolveFilename;
  moduleInternals._resolveFilename = function (
    request: string,
    parent: unknown,
    isMain: boolean,
    options: unknown,
  ) {
    if (request.startsWith("@/")) {
      const absolute = path.resolve("apps/api/src", request.slice(2));
      return originalResolve.call(this, absolute, parent, isMain, options);
    }
    return originalResolve.call(this, request, parent, isMain, options);
  };
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function recordWorkerHeartbeat(
  ok: boolean,
  detail?: string | null,
): Promise<void> {
  const { recordOutboxWorkerHeartbeat } = await import(
    "../apps/api/src/lib/readiness"
  );
  await recordOutboxWorkerHeartbeat({ ok, detail });
}

function logWorkerEvent(
  level: "info" | "warn" | "error",
  event: string,
  fields: Readonly<Record<string, unknown>> = {},
): void {
  const entry = formatOutboxWorkerLog(event, fields);
  if (level === "error") {
    console.error(entry);
  } else if (level === "warn") {
    console.warn(entry);
  } else {
    console.log(entry);
  }
}

async function runOnce(limit: number, options: { logIdle?: boolean } = {}) {
  const { processOutboxBatch } = await import(
    "../apps/api/src/lib/outbox-processor"
  );
  const stats = await processOutboxBatch({ limit });
  if (options.logIdle || shouldLogOutboxBatch(stats)) {
    logWorkerEvent(
      stats.errors > 0 ? "error" : "info",
      "outbox.batch.completed",
      { ok: stats.errors === 0, ...stats },
    );
  }
  return stats;
}

async function recordAndLogWorkerHeartbeat(
  ok: boolean,
  detail?: string | null,
): Promise<void> {
  await recordWorkerHeartbeat(ok, detail);
  logWorkerEvent(ok ? "info" : "error", "outbox.worker.heartbeat", {
    ok,
    ...(detail ? { detail } : {}),
  });
}

async function runSeoOnce() {
  const { maybeGenerateSeoDraft } = await import(
    "../apps/api/src/lib/seo/agent"
  );
  const result = await maybeGenerateSeoDraft({ invokedBy: "worker" });
  logWorkerEvent("info", "seo.draft.checked", { ok: true, result });
}

async function runGoogleAdsQueueOnce() {
  const { queueGoogleAdsSyncIfNeeded } = await import(
    "../apps/api/src/lib/google-ads-scheduler"
  );
  const result = await queueGoogleAdsSyncIfNeeded({ invokedBy: "worker" });
  if (result.queued) {
    logWorkerEvent("info", "google_ads.sync.queued", { ok: true, result });
  }
}

async function runGoogleAdsAnalystQueueOnce() {
  const { queueGoogleAdsAnalystIfNeeded } = await import(
    "../apps/api/src/lib/google-ads-analyst-scheduler"
  );
  const result = await queueGoogleAdsAnalystIfNeeded({ invokedBy: "worker" });
  if (result.queued) {
    logWorkerEvent("info", "google_ads.analyst.queued", { ok: true, result });
  }
}

async function runSalesDraftPrepOnce() {
  const { prepareDueSalesQueueDrafts } = await import(
    "../apps/api/src/lib/sales-draft-prep-scheduler"
  );
  const result = await prepareDueSalesQueueDrafts();
  if (
    result.prepared > 0 ||
    result.reused > 0 ||
    result.autosent > 0 ||
    result.error
  ) {
    logWorkerEvent(
      result.error ? "error" : "info",
      "sales_draft_prep.completed",
      { ok: !result.error, result },
    );
  }
}

async function runFacebookDmNameBackfillOnce() {
  const { backfillFacebookDmContactNames } = await import(
    "../apps/api/src/lib/facebook-dm-name-backfill"
  );
  const result = await backfillFacebookDmContactNames({
    limit: Number(process.env["FACEBOOK_DM_NAME_BACKFILL_LIMIT"] ?? 25),
  });
  if (
    result.candidates > 0 ||
    result.updated > 0 ||
    result.unresolved > 0 ||
    result.missingMessage > 0
  ) {
    logWorkerEvent("info", "facebook_dm_name_backfill.completed", {
      ok: true,
      result,
    });
  }
}

async function runTraccarSyncOnce() {
  const { syncTraccarPositions } = await import(
    "../apps/api/src/lib/eta-agent"
  );
  const result = await syncTraccarPositions();
  if (result.configured && (result.stored > 0 || !result.ok)) {
    logWorkerEvent(result.ok ? "info" : "error", "traccar.sync.completed", {
      ok: result.ok,
      result,
    });
  }
}

async function runAppointmentMediaCleanupOnce() {
  const { cleanupExpiredAppointmentMedia } = await import(
    "../apps/api/src/lib/appointment-media"
  );
  const result = await cleanupExpiredAppointmentMedia();
  if (
    result.expiredStaging > 0 ||
    result.purgedAssets > 0 ||
    result.failures > 0
  ) {
    logWorkerEvent(
      result.failures === 0 ? "info" : "error",
      "appointment_media.cleanup.completed",
      { ok: result.failures === 0, result },
    );
  }
}

async function runSquareReconciliationOnce() {
  // The launch kill switch must not stop verification of a charge that may
  // already have happened. Keep reconciliation running whenever provider
  // credentials remain configured.
  if (
    !process.env["SQUARE_ACCESS_TOKEN"]?.trim() ||
    !process.env["SQUARE_LOCATION_ID"]?.trim()
  ) {
    return;
  }
  const { reconcilePendingSquareAttempts } = await import(
    "../apps/api/src/lib/square-payments"
  );
  const result = await reconcilePendingSquareAttempts();
  if (
    result.verified > 0 ||
    result.pending > 0 ||
    result.needsReview > 0 ||
    result.unmatched > 0 ||
    result.refundsReconciled > 0
  ) {
    logWorkerEvent("info", "square.reconciliation.completed", {
      ok: true,
      result,
    });
  }
}

async function runPartnerInviteRecoveryOnce() {
  const { recoverStalePartnerInviteOperations } = await import(
    "../apps/api/src/lib/partner-invite-recovery"
  );
  const result = await recoverStalePartnerInviteOperations({
    limit: Number(process.env["PARTNER_INVITE_RECOVERY_BATCH_SIZE"] ?? 50),
    requestedStaleMs: Number(
      process.env["PARTNER_INVITE_REQUESTED_STALE_MS"] ?? 2 * 60 * 1000,
    ),
    dispatchedStaleMs: Number(
      process.env["PARTNER_INVITE_DISPATCHED_STALE_MS"] ?? 10 * 60 * 1000,
    ),
  });
  if (
    result.requestedQuarantined > 0 ||
    result.dispatchedReconciled > 0 ||
    result.errors > 0
  ) {
    logWorkerEvent(
      result.errors === 0 ? "info" : "error",
      "partners.invite_recovery.completed",
      { ok: result.errors === 0, result },
    );
  }
}

async function runPartnerRecurringHorizonOnce() {
  const { evaluateDuePartnerRecurringOccurrences } = await import(
    "../apps/api/src/lib/partner-recurring-horizon-scheduler"
  );
  const result = await evaluateDuePartnerRecurringOccurrences({
    limit: Number(process.env["PARTNER_RECURRING_HORIZON_BATCH_SIZE"] ?? 20),
  });
  if (
    result.claimed > 0 ||
    result.review > 0 ||
    result.failed > 0 ||
    result.staffTasksCreated > 0
  ) {
    logWorkerEvent(
      result.failed > 0 ? "warn" : "info",
      "partners.recurring_horizon.completed",
      { ok: result.failed === 0, result },
    );
  }
}

async function runPartnerAuthRetentionOnce() {
  const {
    parsePartnerAuthRetentionBatchSize,
    prunePartnerAuthenticationMetadata,
  } = await import("../apps/api/src/lib/partner-auth-retention");
  const result = await prunePartnerAuthenticationMetadata({
    limit: parsePartnerAuthRetentionBatchSize(
      process.env["PARTNER_AUTH_RETENTION_BATCH_SIZE"],
    ),
  });
  if (
    result.challengesExpired > 0 ||
    result.challengesSanitized > 0 ||
    result.applicantSessionsSanitized > 0 ||
    result.authTransactionsDeleted > 0 ||
    result.sessionsSanitized > 0 ||
    result.loginTokensDeleted > 0
  ) {
    logWorkerEvent("info", "partners.auth_retention.completed", {
      ok: true,
      result,
    });
  }
}

async function main() {
  registerAliases();
  const { batchSize, pollIntervalMs, heartbeatIntervalMs } =
    parseOutboxWorkerConfiguration();
  const seoIntervalMs = Number(
    process.env["SEO_AUTOPUBLISH_INTERVAL_MS"] ?? 6 * 60 * 60 * 1000,
  );
  const googleAdsIntervalMs = Number(
    process.env["GOOGLE_ADS_SYNC_INTERVAL_MS"] ?? 24 * 60 * 60 * 1000,
  );
  const salesDraftPrepIntervalMs = Number(
    process.env["SALES_DRAFT_PREP_INTERVAL_MS"] ?? 3 * 60 * 1000,
  );
  const facebookDmNameBackfillIntervalMs = Number(
    process.env["FACEBOOK_DM_NAME_BACKFILL_INTERVAL_MS"] ?? 2 * 60 * 60 * 1000,
  );
  const traccarSyncIntervalMs = Number(
    process.env["TRACCAR_SYNC_INTERVAL_MS"] ?? 60 * 1000,
  );
  const appointmentMediaCleanupIntervalMs = Number(
    process.env["APPOINTMENT_MEDIA_CLEANUP_INTERVAL_MS"] ?? 60 * 60 * 1000,
  );
  const squareReconciliationIntervalMs = Number(
    process.env["SQUARE_RECONCILIATION_INTERVAL_MS"] ?? 2 * 60 * 1000,
  );
  const partnerInviteRecoveryIntervalMs = Number(
    process.env["PARTNER_INVITE_RECOVERY_INTERVAL_MS"] ?? 60 * 1000,
  );
  const partnerRecurringHorizonIntervalMs = Number(
    process.env["PARTNER_RECURRING_HORIZON_INTERVAL_MS"] ?? 5 * 60 * 1000,
  );
  const partnerAuthRetentionIntervalMs = Number(
    process.env["PARTNER_AUTH_RETENTION_INTERVAL_MS"] ?? 24 * 60 * 60 * 1000,
  );
  let nextSeoAt = Date.now();
  let nextGoogleAdsAt = Date.now();
  let nextSalesDraftPrepAt = Date.now();
  let nextFacebookDmNameBackfillAt = Date.now();
  let nextTraccarSyncAt = Date.now();
  let nextAppointmentMediaCleanupAt = Date.now();
  let nextSquareReconciliationAt = Date.now();
  let nextPartnerInviteRecoveryAt = Date.now();
  let nextPartnerRecurringHorizonAt = Date.now();
  let nextPartnerAuthRetentionAt = Date.now();

  logWorkerEvent("info", "outbox.worker.started", {
    ok: true,
    mode: pollIntervalMs > 0 ? "continuous" : "once",
    batchSize,
    pollIntervalMs,
    heartbeatIntervalMs,
  });

  if (pollIntervalMs > 0) {
    const heartbeat = startOutboxWorkerHeartbeat({
      intervalMs: heartbeatIntervalMs,
      record: () => recordAndLogWorkerHeartbeat(true),
      onError: (error) => {
        logWorkerEvent("error", "outbox.worker.heartbeat_failed", {
          ok: false,
          detail: outboxWorkerErrorDetail(error),
        });
      },
    });

    try {
      // Continuous polling loop
      while (true) {
        const stats = await runOnce(batchSize);
        if (Date.now() >= nextSeoAt) {
          try {
            await runSeoOnce();
          } catch (error) {
            logWorkerEvent("warn", "seo.draft.loop_failed", {
              ok: false,
              detail: outboxWorkerErrorDetail(error),
            });
          }
          nextSeoAt =
            Date.now() +
            (Number.isFinite(seoIntervalMs) && seoIntervalMs > 60_000
              ? seoIntervalMs
              : 6 * 60 * 60 * 1000);
        }
        if (Date.now() >= nextGoogleAdsAt) {
          try {
            await runGoogleAdsQueueOnce();
            await runGoogleAdsAnalystQueueOnce();
          } catch (error) {
            logWorkerEvent("warn", "google_ads.loop_failed", {
              ok: false,
              detail: outboxWorkerErrorDetail(error),
            });
          }
          nextGoogleAdsAt =
            Date.now() +
            (Number.isFinite(googleAdsIntervalMs) &&
            googleAdsIntervalMs > 60_000
              ? googleAdsIntervalMs
              : 24 * 60 * 60 * 1000);
        }
        if (Date.now() >= nextSalesDraftPrepAt) {
          try {
            await runSalesDraftPrepOnce();
          } catch (error) {
            logWorkerEvent("warn", "sales_draft_prep.loop_failed", {
              ok: false,
              detail: outboxWorkerErrorDetail(error),
            });
          }
          nextSalesDraftPrepAt =
            Date.now() +
            (Number.isFinite(salesDraftPrepIntervalMs) &&
            salesDraftPrepIntervalMs > 30_000
              ? salesDraftPrepIntervalMs
              : 3 * 60 * 1000);
        }
        if (Date.now() >= nextFacebookDmNameBackfillAt) {
          try {
            await runFacebookDmNameBackfillOnce();
          } catch (error) {
            logWorkerEvent("warn", "facebook_dm_name_backfill.loop_failed", {
              ok: false,
              detail: outboxWorkerErrorDetail(error),
            });
          }
          nextFacebookDmNameBackfillAt =
            Date.now() +
            (Number.isFinite(facebookDmNameBackfillIntervalMs) &&
            facebookDmNameBackfillIntervalMs > 60_000
              ? facebookDmNameBackfillIntervalMs
              : 2 * 60 * 60 * 1000);
        }
        if (Date.now() >= nextTraccarSyncAt) {
          try {
            await runTraccarSyncOnce();
          } catch (error) {
            logWorkerEvent("warn", "traccar.sync.loop_failed", {
              ok: false,
              detail: outboxWorkerErrorDetail(error),
            });
          }
          nextTraccarSyncAt =
            Date.now() +
            (Number.isFinite(traccarSyncIntervalMs) &&
            traccarSyncIntervalMs > 15_000
              ? traccarSyncIntervalMs
              : 60 * 1000);
        }
        if (Date.now() >= nextAppointmentMediaCleanupAt) {
          try {
            await runAppointmentMediaCleanupOnce();
          } catch (error) {
            logWorkerEvent("warn", "appointment_media.cleanup.loop_failed", {
              ok: false,
              detail: outboxWorkerErrorDetail(error),
            });
          }
          nextAppointmentMediaCleanupAt =
            Date.now() +
            (Number.isFinite(appointmentMediaCleanupIntervalMs) &&
            appointmentMediaCleanupIntervalMs > 5 * 60_000
              ? appointmentMediaCleanupIntervalMs
              : 60 * 60 * 1000);
        }
        if (Date.now() >= nextSquareReconciliationAt) {
          try {
            await runSquareReconciliationOnce();
          } catch (error) {
            logWorkerEvent("warn", "square.reconciliation.loop_failed", {
              ok: false,
              detail: outboxWorkerErrorDetail(error),
            });
          }
          nextSquareReconciliationAt =
            Date.now() +
            (Number.isFinite(squareReconciliationIntervalMs) &&
            squareReconciliationIntervalMs > 30_000
              ? squareReconciliationIntervalMs
              : 2 * 60 * 1000);
        }
        if (Date.now() >= nextPartnerInviteRecoveryAt) {
          try {
            await runPartnerInviteRecoveryOnce();
          } catch (error) {
            logWorkerEvent("warn", "partners.invite_recovery.loop_failed", {
              ok: false,
              detail: outboxWorkerErrorDetail(error),
            });
          }
          nextPartnerInviteRecoveryAt =
            Date.now() +
            (Number.isFinite(partnerInviteRecoveryIntervalMs) &&
            partnerInviteRecoveryIntervalMs >= 30_000
              ? partnerInviteRecoveryIntervalMs
              : 60 * 1000);
        }
        if (Date.now() >= nextPartnerRecurringHorizonAt) {
          try {
            await runPartnerRecurringHorizonOnce();
          } catch (error) {
            logWorkerEvent("warn", "partners.recurring_horizon.loop_failed", {
              ok: false,
              detail: outboxWorkerErrorDetail(error),
            });
          }
          nextPartnerRecurringHorizonAt =
            Date.now() +
            (Number.isFinite(partnerRecurringHorizonIntervalMs) &&
            partnerRecurringHorizonIntervalMs >= 60_000
              ? partnerRecurringHorizonIntervalMs
              : 5 * 60 * 1000);
        }
        if (Date.now() >= nextPartnerAuthRetentionAt) {
          try {
            await runPartnerAuthRetentionOnce();
          } catch (error) {
            logWorkerEvent("warn", "partners.auth_retention.loop_failed", {
              ok: false,
              detail: outboxWorkerErrorDetail(error),
            });
          }
          nextPartnerAuthRetentionAt =
            Date.now() +
            (Number.isFinite(partnerAuthRetentionIntervalMs) &&
            partnerAuthRetentionIntervalMs >= 60 * 60 * 1000
              ? partnerAuthRetentionIntervalMs
              : 24 * 60 * 60 * 1000);
        }
        if (stats.total === 0) {
          await sleep(pollIntervalMs);
        }
      }
    } finally {
      await heartbeat.stop();
    }
  } else {
    await runOnce(batchSize, { logIdle: true });
    await runSeoOnce();
    await runGoogleAdsQueueOnce();
    await runSalesDraftPrepOnce();
    await runFacebookDmNameBackfillOnce();
    await runTraccarSyncOnce();
    await runAppointmentMediaCleanupOnce();
    await runSquareReconciliationOnce();
    await runPartnerInviteRecoveryOnce();
    await runPartnerRecurringHorizonOnce();
    await runPartnerAuthRetentionOnce();
    await recordAndLogWorkerHeartbeat(true);
    logWorkerEvent("info", "outbox.worker.completed", { ok: true });
  }
}

main().catch(async (error) => {
  const detail = outboxWorkerErrorDetail(error);
  try {
    await recordAndLogWorkerHeartbeat(false, detail);
  } catch (heartbeatError) {
    logWorkerEvent("error", "outbox.worker.heartbeat_failed", {
      ok: false,
      detail: outboxWorkerErrorDetail(heartbeatError),
    });
  }
  logWorkerEvent("error", "outbox.worker.failed", { ok: false, detail });
  process.exitCode = 1;
});
