import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertQuoteV2PerformanceReleaseAuthorized,
  buildQuoteV2LatencyMetric,
  createQuoteV2PerformanceFixture,
  measureQuoteV2Operation,
  nearestRankPercentile,
  parseQuoteV2PerformanceArgs,
  quoteV2DatabaseMetric,
  quoteV2PerformanceReportPassed,
  QUOTE_V2_PERFORMANCE_CONFIRMATION,
  QUOTE_V2_PERFORMANCE_ROW_COUNT,
  QuoteV2PerformanceError,
} from "../../scripts/quote-v2-performance-core";
import { installQuoteV2TransactionClientOptions } from "../../scripts/quote-v2-performance";

function errorCode(action: () => unknown): string | null {
  try {
    action();
    return null;
  } catch (error) {
    return error instanceof QuoteV2PerformanceError ? error.code : null;
  }
}

describe("Quote V2 performance release harness", () => {
  it("requires an explicit bounded mode and rejects ambiguous arguments", () => {
    expect(errorCode(() => parseQuoteV2PerformanceArgs([]))).toBe(
      "performance_mode_required",
    );
    expect(
      errorCode(() =>
        parseQuoteV2PerformanceArgs(["--mode=render", "--execute"]),
      ),
    ).toBe("performance_release_argument_in_render_mode");
    expect(
      errorCode(() =>
        parseQuoteV2PerformanceArgs([
          "--mode=release",
          "--database-samples=101",
        ]),
      ),
    ).toBe("performance_argument_out_of_range");
    expect(
      errorCode(() =>
        parseQuoteV2PerformanceArgs(["--mode=release", "--surprise"]),
      ),
    ).toBe("performance_argument_unknown");
  });

  it("makes the 10,000-row database release gate opt-in and DATABASE_URL mandatory", () => {
    const options = parseQuoteV2PerformanceArgs([
      "--mode=release",
      "--execute",
      `--confirm=${QUOTE_V2_PERFORMANCE_CONFIRMATION}`,
      "--seed=release-v1",
    ]);
    expect(options.databaseSamples).toBe(30);
    expect(options.publicRenderSamples).toBe(200);
    expect(options.pdfSamples).toBe(20);
    expect(QUOTE_V2_PERFORMANCE_ROW_COUNT).toBe(10_000);
    expect(
      errorCode(() => assertQuoteV2PerformanceReleaseAuthorized(options, {})),
    ).toBe("performance_database_url_required");
    expect(
      errorCode(() =>
        assertQuoteV2PerformanceReleaseAuthorized(options, {
          DATABASE_URL: "postgresql://localhost/benchmark",
          NODE_ENV: "production",
        }),
      ),
    ).toBe("performance_production_database_forbidden");
    expect(
      assertQuoteV2PerformanceReleaseAuthorized(options, {
        DATABASE_URL: "postgresql://localhost/benchmark",
        NODE_ENV: "test",
      }),
    ).toBe("postgresql://localhost/benchmark");
  });

  it("uses nearest-rank p95 and fails a strict under-threshold gate", () => {
    const samples = Array.from({ length: 20 }, (_, index) => index + 1);
    expect(nearestRankPercentile(samples, 0.5)).toBe(10);
    expect(nearestRankPercentile(samples, 0.95)).toBe(19);
    expect(
      buildQuoteV2LatencyMetric({
        name: "passing",
        durationsMs: samples,
        warmups: 2,
        thresholdMs: 20,
      }),
    ).toMatchObject({ p95Ms: 19, passed: true });
    expect(
      buildQuoteV2LatencyMetric({
        name: "strict",
        durationsMs: [20],
        warmups: 0,
        thresholdMs: 20,
      }).passed,
    ).toBe(false);
  });

  it("detects per-page query fan-out independently of latency", () => {
    const latency = buildQuoteV2LatencyMetric({
      name: "quote-list",
      durationsMs: [1, 2, 3],
      warmups: 1,
      thresholdMs: 500,
    });
    expect(
      quoteV2DatabaseMetric({ metric: latency, queryCounts: [1, 1, 1] }),
    ).toMatchObject({
      observedMaximumQueriesPerSample: 1,
      queryCountPassed: true,
      passed: true,
    });
    const fanout = quoteV2DatabaseMetric({
      metric: latency,
      queryCounts: [1, 2, 1],
    });
    expect(fanout).toMatchObject({
      observedMaximumQueriesPerSample: 2,
      queryCountPassed: false,
      passed: false,
    });
    expect(quoteV2PerformanceReportPassed([latency, fanout])).toBe(false);
  });

  it("runs exact warmup and measured counts without timing validation work", async () => {
    let operations = 0;
    let validations = 0;
    const durations = await measureQuoteV2Operation({
      samples: 4,
      warmups: 2,
      operation: () => {
        operations += 1;
        return operations;
      },
      validate: () => {
        validations += 1;
      },
    });
    expect(durations).toHaveLength(4);
    expect(operations).toBe(6);
    expect(validations).toBe(6);
  });

  it("uses deterministic canonical customer evidence with no bearer or internal fields", () => {
    const first = createQuoteV2PerformanceFixture();
    const second = createQuoteV2PerformanceFixture();
    expect(first.canonicalPublicValue).toBe(second.canonicalPublicValue);
    expect(first.renderModel.contentHash).toBe(second.renderModel.contentHash);
    expect(first.renderModel.totals.totalMinCents).toBeGreaterThan(0);
    expect(first.renderModel.totals.totalMinCents).toBe(
      first.renderModel.totals.totalMaxCents,
    );
    expect(first.canonicalPublicValue).not.toMatch(
      /shareToken|tokenHash|internalNotes/u,
    );
  });

  it("keeps seeding rollback-only, deterministic, bounded, and single-query gated", () => {
    const source = readFileSync(
      join(process.cwd(), "scripts/quote-v2-performance.ts"),
      "utf8",
    );
    for (const required of [
      "generate_series",
      "RollbackBenchmarkTransaction",
      "performance_disposable_empty_database_required",
      "analyze contacts",
      "QUOTE_V2_MAX_LIST_QUERIES_PER_SAMPLE",
      "quote_list_cursor_page",
      "quote_contact_project_search",
      "standard_proposal_pdf",
      "installQuoteV2TransactionClientOptions(sql, client.options)",
      "lpad(ordinal::text, 5, '0') || ' Performance Avenue'",
      '"09995 Performance Avenue"',
    ]) {
      expect(source).toContain(required);
    }
    expect(source).not.toMatch(/delete from|truncate /iu);
    expect(source).not.toContain("ordinal::text || ' Performance Avenue'");
  });

  it("adapts transaction clients with the exact immutable root options object", () => {
    const transaction = () => undefined;
    const rootOptions = Object.freeze({ serializers: Object.freeze({}) });

    installQuoteV2TransactionClientOptions(transaction, rootOptions);

    expect(Object.getOwnPropertyDescriptor(transaction, "options")).toEqual({
      configurable: false,
      enumerable: false,
      value: rootOptions,
      writable: false,
    });
    expect(Reflect.set(transaction, "options", {})).toBe(false);
    expect(() =>
      installQuoteV2TransactionClientOptions(transaction, rootOptions),
    ).not.toThrow();
    expect(
      errorCode(() => installQuoteV2TransactionClientOptions(transaction, {})),
    ).toBe("performance_transaction_options_conflict");
  });
});
