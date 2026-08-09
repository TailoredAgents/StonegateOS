import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertGoogleAdsReviewTransition,
  classifyGoogleAdsProviderMutationFailure,
  planGoogleAdsOperationDispatch,
} from "@/lib/google-ads-recommendation-operations";
import {
  applyCustomerNegativeKeyword,
  GoogleAdsMutationDispatchError,
} from "@/lib/google-ads-insights";

const API_ROOT = process.cwd();
const REPO_ROOT = join(API_ROOT, "../..");

function apiSource(relativePath: string): string {
  return readFileSync(join(API_ROOT, relativePath), "utf8");
}

function repoSource(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

describe("Google Ads recommendation state safety", () => {
  it("never redispatches a durable dispatched operation", () => {
    expect(planGoogleAdsOperationDispatch("requested")).toBe("dispatch");
    expect(planGoogleAdsOperationDispatch("dispatched")).toBe("uncertain");
    for (const state of [
      "succeeded",
      "failed",
      "reconciliation_required",
    ] as const) {
      expect(planGoogleAdsOperationDispatch(state)).toBe("terminal");
    }
  });

  it("keeps in-flight, applied, and reconciliation states out of review", () => {
    expect(() =>
      assertGoogleAdsReviewTransition("proposed", "approved"),
    ).not.toThrow();
    expect(() =>
      assertGoogleAdsReviewTransition("failed", "approved"),
    ).not.toThrow();
    expect(() =>
      assertGoogleAdsReviewTransition("applying", "ignored"),
    ).toThrow(/current apply operation/iu);
    expect(() => assertGoogleAdsReviewTransition("applied", "ignored")).toThrow(
      /immutable/iu,
    );
    expect(() =>
      assertGoogleAdsReviewTransition("reconciliation_required", "approved"),
    ).toThrow(/reconcile/iu);
  });

  it("classifies only confirmed provider rejection as failed", () => {
    expect(
      classifyGoogleAdsProviderMutationFailure(
        new GoogleAdsMutationDispatchError({
          certainty: "confirmed_failed",
          failureCode: "google_ads_mutation_rejected:400",
          providerStatus: 400,
        }),
      ),
    ).toEqual(
      expect.objectContaining({
        state: "failed",
        providerStatus: 400,
        failureCode: "google_ads_mutation_rejected:400",
      }),
    );
    expect(
      classifyGoogleAdsProviderMutationFailure(
        new GoogleAdsMutationDispatchError({
          certainty: "uncertain",
          failureCode: "google_ads_mutation_transport_uncertain",
        }),
      ),
    ).toEqual(
      expect.objectContaining({
        state: "reconciliation_required",
        providerOperationId: null,
      }),
    );
    expect(
      classifyGoogleAdsProviderMutationFailure(new Error("unexpected")),
    ).toEqual(
      expect.objectContaining({
        state: "reconciliation_required",
        failureCode: "google_ads_mutation_unclassified_uncertainty",
      }),
    );
  });
});

describe("Google Ads mutate delivery certainty", () => {
  const originalFetch = global.fetch;
  const originalDeveloperToken = process.env["GOOGLE_ADS_DEVELOPER_TOKEN"];
  const originalApiVersion = process.env["GOOGLE_ADS_API_VERSION"];

  beforeEach(() => {
    process.env["GOOGLE_ADS_DEVELOPER_TOKEN"] = "test-developer-token";
    process.env["GOOGLE_ADS_API_VERSION"] = "v25";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalDeveloperToken === undefined) {
      delete process.env["GOOGLE_ADS_DEVELOPER_TOKEN"];
    } else {
      process.env["GOOGLE_ADS_DEVELOPER_TOKEN"] = originalDeveloperToken;
    }
    if (originalApiVersion === undefined) {
      delete process.env["GOOGLE_ADS_API_VERSION"];
    } else {
      process.env["GOOGLE_ADS_API_VERSION"] = originalApiVersion;
    }
    jest.restoreAllMocks();
  });

  it("returns provider operation evidence only for a valid success response", async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            results: [
              {
                resourceName:
                  "customers/1234567890/customerNegativeCriteria/321",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    ) as typeof fetch;

    await expect(
      applyCustomerNegativeKeyword({
        customerId: "1234567890",
        accessToken: "test-access-token",
        term: '"free pickup"',
      }),
    ).resolves.toEqual({
      resourceName: "customers/1234567890/customerNegativeCriteria/321",
      term: "free pickup",
      matchType: "PHRASE",
      providerStatus: 200,
    });
  });

  it("treats a provider 4xx as a confirmed rejection", async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve(new Response("bad request", { status: 400 })),
    ) as typeof fetch;
    await expect(
      applyCustomerNegativeKeyword({
        customerId: "1234567890",
        accessToken: "test-access-token",
        term: "invalid",
      }),
    ).rejects.toMatchObject({
      certainty: "confirmed_failed",
      failureCode: "google_ads_mutation_rejected:400",
      providerStatus: 400,
    });
  });

  it.each([
    ["transport exception", () => Promise.reject(new Error("socket closed"))],
    [
      "provider 503",
      () => Promise.resolve(new Response("down", { status: 503 })),
    ],
    [
      "malformed success",
      () => Promise.resolve(new Response("{}", { status: 200 })),
    ],
  ])("quarantines an uncertain %s", async (_label, implementation) => {
    global.fetch = jest.fn(implementation) as typeof fetch;
    const error = await applyCustomerNegativeKeyword({
      customerId: "1234567890",
      accessToken: "test-access-token",
      term: "free",
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GoogleAdsMutationDispatchError);
    expect(error).toMatchObject({ certainty: "uncertain" });
  });
});

describe("Google Ads durable recommendation contracts", () => {
  const migration = apiSource(
    "src/db/migrations/0075_google_ads_recommendation_operations.sql",
  );
  const schema = apiSource("src/db/schema.ts");
  const operationLib = apiSource(
    "src/lib/google-ads-recommendation-operations.ts",
  );
  const reviewRoute = apiSource(
    "app/api/admin/google/ads/analyst/recommendations/route.ts",
  );
  const bulkReviewRoute = apiSource(
    "app/api/admin/google/ads/analyst/recommendations/bulk/route.ts",
  );
  const applyRoute = apiSource(
    "app/api/admin/google/ads/analyst/recommendations/apply/route.ts",
  );
  const bulkApplyRoute = apiSource(
    "app/api/admin/google/ads/analyst/recommendations/apply/bulk/route.ts",
  );
  const statusRoute = apiSource("app/api/admin/google/ads/status/route.ts");
  const siteActions = repoSource("apps/site/src/app/team/actions.ts");
  const panel = repoSource(
    "apps/site/src/app/team/components/GoogleAdsRecommendationsPanel.tsx",
  );

  it("registers migration 0075 after the SEO workflow migration", () => {
    const journal = JSON.parse(
      apiSource("src/db/migrations/meta/_journal.json"),
    ) as { entries?: Array<{ idx?: number; tag?: string }> };
    const entries = journal.entries ?? [];
    const seoIndex = entries.findIndex(
      (entry) => entry.tag === "0074_seo_editorial_workflow",
    );
    const adsIndex = entries.findIndex(
      (entry) => entry.tag === "0075_google_ads_recommendation_operations",
    );
    expect(entries[seoIndex]).toEqual(expect.objectContaining({ idx: 71 }));
    expect(entries[adsIndex]).toEqual(expect.objectContaining({ idx: 72 }));
    expect(adsIndex).toBe(seoIndex + 1);
  });

  it("enforces one active operation and truthful terminal evidence", () => {
    expect(migration).toContain(
      "google_ads_analyst_recommendations_status_check",
    );
    expect(migration).toContain("'applying'");
    expect(migration).toContain("'reconciliation_required'");
    expect(migration).toContain(
      "google_ads_rec_operations_active_recommendation_key",
    );
    expect(migration).toContain(
      "google_ads_rec_operations_provider_request_key",
    );
    expect(migration).toContain(
      "google_ads_rec_operations_terminal_audit_event_fk",
    );
    expect(migration).toContain(
      "WHERE \"state\" IN ('requested', 'dispatched')",
    );
    expect(migration).toContain("google_ads_rec_operations_lifecycle_check");
    expect(migration).toContain("provider_idempotency_supported");
    expect(migration).toContain("provider_operation_id");
    expect(migration).toContain("terminal_audit_event_id");
    expect(migration).toContain("idempotency_key_hash");
    expect(migration).toContain(
      "enforce_google_ads_recommendation_operation_transition",
    );
    expect(migration).toContain(
      "google_ads_recommendation_operation_version_must_increment",
    );
    expect(migration).toContain(
      "google_ads_recommendation_operation_terminal_immutable",
    );
    expect(migration).toContain(
      "google_ads_recommendation_operation_invalid_initial_state",
    );
    expect(migration).toContain(
      "google_ads_recommendation_operation_invalid_dispatched_transition",
    );
    expect(schema).toContain("googleAdsRecommendationOperations");
    expect(schema).not.toContain("providerIdempotencySupported: true");
  });

  it("records requested, dispatched, and terminal state with atomic audits", () => {
    expect(operationLib).toContain('state: "requested"');
    expect(operationLib).toContain('state: "dispatched"');
    expect(operationLib).toContain("finalizeGoogleAdsOperation");
    expect(operationLib).toContain('.for("update")');
    expect(operationLib).toContain(
      "eq(googleAdsAnalystRecommendations.updatedAt",
    );
    expect(operationLib).toContain("insertOperationAudit(tx");
    expect(operationLib).toContain("providerExactlyOnceClaimed: false");
    expect(operationLib).toContain("redispatchAllowed: false");
  });

  it("makes single and bulk review atomic, current-version, and caller-key guarded", () => {
    for (const route of [reviewRoute, bulkReviewRoute]) {
      expect(route.indexOf("beginTeamMutation(")).toBeLessThan(
        route.indexOf("request.json("),
      );
      expect(route).toContain("requiresIdempotency: true");
      expect(route).toContain("claimTeamMutationIdempotency");
      expect(route).toContain('.for("update")');
      expect(route).toContain("completeTeamMutationIdempotency");
      expect(route).toContain("mutation.audit.insertSuccess(tx");
      expect(route).not.toContain('toStatus: "applied"');
    }
    expect(reviewRoute).toContain("assertTeamMutationExpectedVersion");
    expect(bulkReviewRoute).toContain("row.updatedAt.toISOString()");
    expect(bulkReviewRoute).toContain("No decisions were saved");
  });

  it("requires explicit external confirmation and never reports partial success", () => {
    for (const route of [applyRoute, bulkApplyRoute]) {
      expect(route.indexOf("beginTeamMutation(")).toBeLessThan(
        route.indexOf("request.json("),
      );
      expect(route).toContain('requiredPermissions: ["marketing.apply"]');
      expect(route).toContain('risk: "external"');
      expect(route).toContain("claimTeamMutationIdempotency");
      expect(route).toContain("claimGoogleAdsOperationDispatch");
      expect(route).toContain("reconciliation_required");
      expect(route).toContain("completeTeamMutationIdempotency");
      expect(route).toContain("settleTeamMutationIdempotencyFailure");
      expect(route).toContain("providerExactlyOnceClaimed: false");
      expect(route).toContain('"x-idempotency-receipt": "pending"');
      expect(route.indexOf("GOOGLE_ADS_DEVELOPER_TOKEN")).toBeLessThan(
        route.indexOf("await prepareGoogleAdsRecommendationOperations("),
      );
    }
    expect(applyRoute).toContain('z.literal("apply_google_ads_change")');
    expect(bulkApplyRoute).toContain('z.literal("apply_google_ads_changes")');
    expect(bulkApplyRoute).toContain("Promise.allSettled(workers)");
    expect(bulkApplyRoute).not.toContain("ok: true, applied, failed");
  });

  it("forwards keys and versions from confirmed Site controls", () => {
    expect(siteActions).toContain(
      "export async function updateGoogleAdsAnalystRecommendationAction",
    );
    expect(siteActions).toContain(
      "export async function bulkApplyGoogleAdsAnalystRecommendationsAction",
    );
    expect(siteActions).toContain('"Idempotency-Key": idempotencyKey');
    expect(siteActions).toContain('"If-Match": expectedVersion.trim()');
    expect(siteActions).toContain("parseGoogleAdsActionItems");
    expect(siteActions).toContain(
      "new Set(items.map((item) => item.id)).size !== items.length",
    );
    expect(siteActions).not.toContain("return parsed.flatMap");
    expect(panel).toContain("expectedVersion");
    expect(panel).toContain("idempotencyKey");
    expect(panel).toContain("apply_google_ads_change");
    expect(panel).toContain("apply_google_ads_changes");
    expect(panel).toContain("window.confirm");
    expect(panel).toContain("advertisingChangesDisabledMessage");
    const marketingSection = repoSource(
      "apps/site/src/app/team/components/MarketingSection.tsx",
    );
    expect(marketingSection).toContain("Advertising emergency stop is on");
    expect(marketingSection).toContain(
      "Advertising safety status is unavailable",
    );
    expect(panel).toContain("Needs reconciliation");
    expect(panel).toContain("Current:");
    expect(panel).toContain("Proposed:");
    expect(panel).toContain("canReview");
    expect(panel).toContain("canApply");
    expect(panel).not.toContain("Mark applied");
    expect(statusRoute).toContain("advertisingChangesDisabled");
  });
});
