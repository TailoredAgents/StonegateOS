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

async function main() {
  registerAliases();
  const limit = Number(process.env["OUTBOX_BATCH_SIZE"] ?? 10);
  const pollIntervalMs = Number(process.env["OUTBOX_POLL_INTERVAL_MS"] ?? 0);
  const seoIntervalMs = Number(process.env["SEO_AUTOPUBLISH_INTERVAL_MS"] ?? 6 * 60 * 60 * 1000);
  const googleAdsIntervalMs = Number(
    process.env["GOOGLE_ADS_SYNC_INTERVAL_MS"] ?? 24 * 60 * 60 * 1000
  );
  let nextSeoAt = Date.now();
  let nextGoogleAdsAt = Date.now();

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
      if (stats.total === 0) {
        await sleep(pollIntervalMs);
      }
    }
  } else {
    await runOnce(limit);
    await runSeoOnce();
    await runGoogleAdsQueueOnce();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
