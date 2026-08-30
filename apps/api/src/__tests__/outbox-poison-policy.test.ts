import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_OUTBOX_MAX_ATTEMPTS,
  planOutboxOutcomeFinalization,
} from "@/lib/outbox-finalization";
import {
  APPOINTMENT_MEDIA_MAX_ATTEMPTS,
  isGoogleAdsInvalidResponseFailure,
} from "@/lib/outbox-poison-policy";

const API_ROOT = path.resolve(__dirname, "../..");

function source(relativePath: string): string {
  return fs.readFileSync(path.resolve(API_ROOT, relativePath), "utf8");
}

describe("outbox poison-job finalization", () => {
  const now = new Date("2026-08-30T12:00:00.000Z");

  it("keeps a generic retry pending while its attempt budget remains", () => {
    expect(
      planOutboxOutcomeFinalization(
        { attempts: DEFAULT_OUTBOX_MAX_ATTEMPTS - 2 },
        { status: "retry", error: "provider_timeout" },
        now,
      ),
    ).toEqual({
      attempts: DEFAULT_OUTBOX_MAX_ATTEMPTS - 1,
      nextAttemptAt: new Date("2026-08-30T12:15:00.000Z"),
      lastError: "provider_timeout",
    });
  });

  it("dead-letters a generic retry when its attempt budget is exhausted", () => {
    expect(
      planOutboxOutcomeFinalization(
        { attempts: DEFAULT_OUTBOX_MAX_ATTEMPTS - 1 },
        { status: "retry", error: "provider_timeout" },
        now,
      ),
    ).toEqual({
      attempts: DEFAULT_OUTBOX_MAX_ATTEMPTS,
      nextAttemptAt: null,
      lastError: "provider_timeout",
      quarantinedAt: now,
      quarantinedBy: null,
      quarantineReason: "outbox_retry_budget_exhausted",
    });
  });

  it("honors a smaller media retry budget and preserves the handler error", () => {
    expect(
      planOutboxOutcomeFinalization(
        { attempts: APPOINTMENT_MEDIA_MAX_ATTEMPTS - 1 },
        {
          status: "retry",
          error: "media_storage_unavailable",
          maxAttempts: APPOINTMENT_MEDIA_MAX_ATTEMPTS,
          quarantineReason: "appointment_media_retry_budget_exhausted",
        },
        now,
      ),
    ).toEqual({
      attempts: APPOINTMENT_MEDIA_MAX_ATTEMPTS,
      nextAttemptAt: null,
      lastError: "media_storage_unavailable",
      quarantinedAt: now,
      quarantinedBy: null,
      quarantineReason: "appointment_media_retry_budget_exhausted",
    });
  });

  it("parks disabled work immediately without marking it processed", () => {
    expect(
      planOutboxOutcomeFinalization(
        { attempts: 0 },
        {
          status: "quarantined",
          error: "media_auto_import_disabled",
          quarantineReason: "media_auto_import_disabled",
        },
        now,
      ),
    ).toEqual({
      attempts: 1,
      nextAttemptAt: null,
      lastError: "media_auto_import_disabled",
      quarantinedAt: now,
      quarantinedBy: null,
      quarantineReason: "media_auto_import_disabled",
    });
  });
});

describe("deterministic Google Ads poison classification", () => {
  it.each([
    "google_ads_invalid_response",
    "google_ads_accessible_customers_invalid_response",
  ])("classifies %s as terminal", (message) => {
    expect(isGoogleAdsInvalidResponseFailure(new Error(message))).toBe(true);
  });

  it("leaves transient provider failures on the bounded retry path", () => {
    expect(isGoogleAdsInvalidResponseFailure(new Error("fetch failed"))).toBe(
      false,
    );
  });
});

describe("outbox poison-job integration contract", () => {
  const processor = source("src/lib/outbox-processor.ts");
  const inbox = source("src/lib/inbox.ts");

  it("does not enqueue automatic media work while the feature is disabled", () => {
    expect(inbox).toMatch(
      /isMediaAutoImportEnabled\(\)[\s\S]{0,300}type: "appointment_media\.import_message"/u,
    );
    expect(processor).toMatch(
      /if \(isMediaAutoImportEnabled\(\)\)[\s\S]{0,700}type: "appointment_media\.attach_appointment"/u,
    );
  });

  it("parks legacy disabled-media jobs and bounds enabled-media failures", () => {
    const mediaHandlers = processor.slice(
      processor.indexOf('case "appointment_media.import_message"'),
      processor.indexOf('case "facebook.dm.inbound"'),
    );
    expect(mediaHandlers.match(/status: "quarantined"/gu)).toHaveLength(2);
    expect(mediaHandlers.match(/media_auto_import_disabled/gu)?.length).toBe(4);
    expect(
      mediaHandlers.match(/maxAttempts: APPOINTMENT_MEDIA_MAX_ATTEMPTS/gu),
    ).toHaveLength(2);
  });

  it("quarantines malformed Google Ads success responses", () => {
    const googleHandler = processor.slice(
      processor.indexOf('case "google.ads_insights.sync"'),
      processor.indexOf('case "google.ads_analyst.run"'),
    );
    expect(googleHandler).toContain("isGoogleAdsInvalidResponseFailure(error)");
    expect(googleHandler).toContain(
      'quarantineReason: "google_ads_invalid_response"',
    );
    expect(googleHandler).toContain(
      "maxAttempts: GOOGLE_ADS_SYNC_MAX_ATTEMPTS",
    );
  });
});
