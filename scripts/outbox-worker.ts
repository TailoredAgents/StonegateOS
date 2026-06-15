import "dotenv/config";
import Module from "node:module";
import path from "node:path";

function registerAliases() {
  const originalResolve = (Module as unknown as { _resolveFilename: Module["_resolveFilename"] })._resolveFilename;
  (Module as unknown as { _resolveFilename: Module["_resolveFilename"] })._resolveFilename = function (
    request: string,
    parent: any,
    isMain: boolean,
    options: any
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

async function runOnce(limit: number) {
  const { processOutboxBatch } = await import("../apps/api/src/lib/outbox-processor");
  const stats = await processOutboxBatch({ limit });
  console.log(JSON.stringify({ ok: true, ...stats }, null, 2));
  return stats;
}

async function runSeoOnce() {
  const { maybeAutopublishBlogPost } = await import("../apps/api/src/lib/seo/agent");
  const result = await maybeAutopublishBlogPost({ invokedBy: "worker" });
  console.log(JSON.stringify({ ok: true, seo: result }, null, 2));
}

async function runGoogleAdsQueueOnce() {
  const { queueGoogleAdsSyncIfNeeded } = await import("../apps/api/src/lib/google-ads-scheduler");
  const result = await queueGoogleAdsSyncIfNeeded({ invokedBy: "worker" });
  if (result.queued) {
    console.log(JSON.stringify({ ok: true, googleAds: result }, null, 2));
  }
}

async function runGoogleAdsAnalystQueueOnce() {
  const { queueGoogleAdsAnalystIfNeeded } = await import("../apps/api/src/lib/google-ads-analyst-scheduler");
  const result = await queueGoogleAdsAnalystIfNeeded({ invokedBy: "worker" });
  if (result.queued) {
    console.log(JSON.stringify({ ok: true, googleAdsAnalyst: result }, null, 2));
  }
}

async function runSalesDraftPrepOnce() {
  const { prepareDueSalesQueueDrafts } = await import("../apps/api/src/lib/sales-draft-prep-scheduler");
  const result = await prepareDueSalesQueueDrafts();
  if (result.prepared > 0 || result.reused > 0 || result.autosent > 0 || result.error) {
    console.log(JSON.stringify({ ok: !result.error, salesDraftPrep: result }, null, 2));
  }
}

async function runFacebookDmNameBackfillOnce() {
  const { backfillFacebookDmContactNames } = await import("../apps/api/src/lib/facebook-dm-name-backfill");
  const result = await backfillFacebookDmContactNames({
    limit: Number(process.env["FACEBOOK_DM_NAME_BACKFILL_LIMIT"] ?? 25)
  });
  if (result.candidates > 0 || result.updated > 0 || result.unresolved > 0 || result.missingMessage > 0) {
    console.log(JSON.stringify({ ok: true, facebookDmNameBackfill: result }, null, 2));
  }
}

async function runTraccarSyncOnce() {
  const { syncTraccarPositions } = await import("../apps/api/src/lib/eta-agent");
  const result = await syncTraccarPositions();
  if (result.configured && (result.stored > 0 || !result.ok)) {
    console.log(JSON.stringify({ ok: result.ok, traccar: result }, null, 2));
  }
}

async function main() {
  registerAliases();
  const limit = Number(process.env["OUTBOX_BATCH_SIZE"] ?? 10);
  const pollIntervalMs = Number(process.env["OUTBOX_POLL_INTERVAL_MS"] ?? 0);
  const seoIntervalMs = Number(process.env["SEO_AUTOPUBLISH_INTERVAL_MS"] ?? 6 * 60 * 60 * 1000);
  const googleAdsIntervalMs = Number(
    process.env["GOOGLE_ADS_SYNC_INTERVAL_MS"] ?? 24 * 60 * 60 * 1000
  );
  const salesDraftPrepIntervalMs = Number(
    process.env["SALES_DRAFT_PREP_INTERVAL_MS"] ?? 3 * 60 * 1000
  );
  const facebookDmNameBackfillIntervalMs = Number(
    process.env["FACEBOOK_DM_NAME_BACKFILL_INTERVAL_MS"] ?? 2 * 60 * 60 * 1000
  );
  const traccarSyncIntervalMs = Number(
    process.env["TRACCAR_SYNC_INTERVAL_MS"] ?? 60 * 1000
  );
  let nextSeoAt = Date.now();
  let nextGoogleAdsAt = Date.now();
  let nextSalesDraftPrepAt = Date.now();
  let nextFacebookDmNameBackfillAt = Date.now();
  let nextTraccarSyncAt = Date.now();

  if (pollIntervalMs > 0) {
    // Continuous polling loop
    while (true) {
      const stats = await runOnce(limit);
      if (Date.now() >= nextSeoAt) {
        try {
          await runSeoOnce();
        } catch (error) {
          console.warn("[seo] autopublish.loop_failed", String(error));
        }
        nextSeoAt = Date.now() + (Number.isFinite(seoIntervalMs) && seoIntervalMs > 60_000 ? seoIntervalMs : 6 * 60 * 60 * 1000);
      }
      if (Date.now() >= nextGoogleAdsAt) {
        try {
          await runGoogleAdsQueueOnce();
          await runGoogleAdsAnalystQueueOnce();
        } catch (error) {
          console.warn("[google_ads] sync.loop_failed", String(error));
        }
        nextGoogleAdsAt =
          Date.now() +
          (Number.isFinite(googleAdsIntervalMs) && googleAdsIntervalMs > 60_000
            ? googleAdsIntervalMs
            : 24 * 60 * 60 * 1000);
      }
      if (Date.now() >= nextSalesDraftPrepAt) {
        try {
          await runSalesDraftPrepOnce();
        } catch (error) {
          console.warn("[sales_draft_prep] loop_failed", String(error));
        }
        nextSalesDraftPrepAt =
          Date.now() +
          (Number.isFinite(salesDraftPrepIntervalMs) && salesDraftPrepIntervalMs > 30_000
            ? salesDraftPrepIntervalMs
            : 3 * 60 * 1000);
      }
      if (Date.now() >= nextFacebookDmNameBackfillAt) {
        try {
          await runFacebookDmNameBackfillOnce();
        } catch (error) {
          console.warn("[facebook_dm_name_backfill] loop_failed", String(error));
        }
        nextFacebookDmNameBackfillAt =
          Date.now() +
          (Number.isFinite(facebookDmNameBackfillIntervalMs) && facebookDmNameBackfillIntervalMs > 60_000
            ? facebookDmNameBackfillIntervalMs
            : 2 * 60 * 60 * 1000);
      }
      if (Date.now() >= nextTraccarSyncAt) {
        try {
          await runTraccarSyncOnce();
        } catch (error) {
          console.warn("[traccar] sync.loop_failed", String(error));
        }
        nextTraccarSyncAt =
          Date.now() +
          (Number.isFinite(traccarSyncIntervalMs) && traccarSyncIntervalMs > 15_000
            ? traccarSyncIntervalMs
            : 60 * 1000);
      }
      if (stats.total === 0) {
        await sleep(pollIntervalMs);
      }
    }
  } else {
    await runOnce(limit);
    await runSeoOnce();
    await runGoogleAdsQueueOnce();
    await runSalesDraftPrepOnce();
    await runFacebookDmNameBackfillOnce();
    await runTraccarSyncOnce();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
