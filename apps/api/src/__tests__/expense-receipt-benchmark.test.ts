import {
  assertExpenseReceiptBenchmarkLiveAuthorized,
  ExpenseReceiptBenchmarkError,
  expenseReceiptBenchmarkFailureReport,
  expenseReceiptBenchmarkValidationReport,
  parseExpenseReceiptBenchmarkArgs,
  parseExpenseReceiptBenchmarkManifest,
  scoreExpenseReceiptBenchmark,
  type ExpenseReceiptBenchmarkManifest,
  type ExpenseReceiptBenchmarkResult,
} from "../../scripts/expense-receipt-benchmark-core";

function manifestInput(count = 100): unknown {
  return {
    schemaVersion: 2,
    representativeCorpusReviewed: true,
    groundTruthReviewed: true,
    receipts: Array.from({ length: count }, (_, index) => ({
      id: `receipt-${String(index + 1).padStart(3, "0")}`,
      file: `receipts/${String(index + 1).padStart(3, "0")}.jpg`,
      contentType: "image/jpeg",
      layout: index % 2 === 0 ? "portrait" : "landscape",
      documentType: index < 25 ? "scale_ticket" : "standard_receipt",
      expected: {
        totalCents: 1_000 + index,
        transactionDate: "2026-08-01",
        vendor: `Vendor ${index + 1}`,
        netWeightPounds: index < 25 ? 2_000 + index : null,
      },
    })),
  };
}

function exactResults(
  manifest: ExpenseReceiptBenchmarkManifest,
): ExpenseReceiptBenchmarkResult[] {
  return manifest.receipts.map((receipt) => ({
    id: receipt.id,
    extraction: {
      ...receipt.expected,
      documentType: receipt.documentType,
    },
  }));
}

describe("expense receipt benchmark manifest", () => {
  it("requires at least 100 reviewed, representative receipts", () => {
    expect(parseExpenseReceiptBenchmarkManifest(manifestInput())).toMatchObject(
      {
        schemaVersion: 2,
        representativeCorpusReviewed: true,
        groundTruthReviewed: true,
      },
    );
    expect(() =>
      parseExpenseReceiptBenchmarkManifest(manifestInput(99)),
    ).toThrow(ExpenseReceiptBenchmarkError);
  });

  it("rejects duplicate identities, duplicate files, unsafe paths, and inexact labels", () => {
    const duplicate = manifestInput() as {
      receipts: Array<{
        id: string;
        file: string;
        expected: { vendor: string };
      }>;
    };
    duplicate.receipts[1]!.id = duplicate.receipts[0]!.id;
    duplicate.receipts[2]!.file = duplicate.receipts[0]!.file;
    expect(() => parseExpenseReceiptBenchmarkManifest(duplicate)).toThrow(
      ExpenseReceiptBenchmarkError,
    );

    const unsafe = manifestInput() as {
      receipts: Array<{ file: string; expected: { vendor: string } }>;
    };
    unsafe.receipts[0]!.file = "../private.jpg";
    expect(() => parseExpenseReceiptBenchmarkManifest(unsafe)).toThrow(
      ExpenseReceiptBenchmarkError,
    );

    const whitespace = manifestInput() as {
      receipts: Array<{ expected: { vendor: string } }>;
    };
    whitespace.receipts[0]!.expected.vendor = " Vendor 1";
    expect(() => parseExpenseReceiptBenchmarkManifest(whitespace)).toThrow(
      ExpenseReceiptBenchmarkError,
    );
  });
});

describe("expense receipt benchmark authorization", () => {
  it("defaults to validation and requires count-bound confirmation plus an explicit model", () => {
    expect(
      parseExpenseReceiptBenchmarkArgs(["--manifest=/private/manifest.json"]),
    ).toEqual({
      manifestPath: "/private/manifest.json",
      executeLive: false,
      confirmation: null,
      model: null,
    });
    expect(() =>
      assertExpenseReceiptBenchmarkLiveAuthorized({
        receiptCount: 100,
        confirmation: "RUN_PRIVATE_RECEIPT_BENCHMARK_99",
        model: "gpt-4.1-mini-2025-04-14",
      }),
    ).toThrow(ExpenseReceiptBenchmarkError);
    expect(
      assertExpenseReceiptBenchmarkLiveAuthorized({
        receiptCount: 100,
        confirmation: "RUN_PRIVATE_RECEIPT_BENCHMARK_100",
        model: "gpt-4.1-mini-2025-04-14",
      }),
    ).toEqual({ model: "gpt-4.1-mini-2025-04-14" });
  });

  it("does not permit live-only arguments on a validation run", () => {
    expect(() =>
      parseExpenseReceiptBenchmarkArgs([
        "--manifest=manifest.json",
        "--model=gpt-4.1-mini",
      ]),
    ).toThrow(ExpenseReceiptBenchmarkError);
  });
});

describe("expense receipt benchmark scoring", () => {
  it("passes exactly at 98 percent total and 95 percent date/vendor", () => {
    const manifest = parseExpenseReceiptBenchmarkManifest(manifestInput());
    const results = exactResults(manifest);
    for (let index = 0; index < 2; index += 1) {
      results[index]!.extraction!.totalCents += 1;
    }
    for (let index = 0; index < 5; index += 1) {
      results[index]!.extraction!.transactionDate = "2026-08-02";
      results[index]!.extraction!.vendor = `vendor ${index + 1}`;
    }

    expect(scoreExpenseReceiptBenchmark(manifest, results)).toMatchObject({
      passed: true,
      receiptCount: 100,
      providerFailureCount: 0,
      metrics: {
        total: { exactCount: 98, accuracyPercent: 98, passed: true },
        transactionDate: {
          exactCount: 95,
          accuracyPercent: 95,
          passed: true,
        },
        vendor: { exactCount: 95, accuracyPercent: 95, passed: true },
      },
    });
  });

  it("counts provider failures as misses and rejects below-threshold exact strings", () => {
    const manifest = parseExpenseReceiptBenchmarkManifest(manifestInput());
    const results = exactResults(manifest);
    results[0]!.extraction = null;
    for (let index = 1; index < 7; index += 1) {
      results[index]!.extraction!.vendor =
        results[index]!.extraction!.vendor!.toLowerCase();
    }
    const score = scoreExpenseReceiptBenchmark(manifest, results);
    expect(score.providerFailureCount).toBe(1);
    expect(score.metrics.total.exactCount).toBe(99);
    expect(score.metrics.vendor).toMatchObject({
      exactCount: 93,
      accuracyPercent: 93,
      passed: false,
    });
    expect(score.passed).toBe(false);
  });

  it("fails on any hallucinated scale weight for a standard receipt", () => {
    const manifest = parseExpenseReceiptBenchmarkManifest(manifestInput());
    const results = exactResults(manifest);
    results[25]!.extraction!.netWeightPounds = 2_000;

    expect(scoreExpenseReceiptBenchmark(manifest, results)).toMatchObject({
      passed: false,
      metrics: {
        nonScaleWeightNull: {
          exactCount: 74,
          evaluatedCount: 75,
          passed: false,
        },
      },
    });
  });

  it("scores reviewed-null scale-ticket truth as part of net-weight accuracy", () => {
    const input = manifestInput() as {
      receipts: Array<{
        documentType: "scale_ticket" | "standard_receipt";
        expected: { netWeightPounds: number | null };
      }>;
    };
    input.receipts[25]!.documentType = "scale_ticket";
    input.receipts[25]!.expected.netWeightPounds = null;
    const manifest = parseExpenseReceiptBenchmarkManifest(input);
    const results = exactResults(manifest);
    results[25]!.extraction!.netWeightPounds = 4_000;

    expect(
      scoreExpenseReceiptBenchmark(manifest, results).metrics.netWeightPounds,
    ).toMatchObject({
      exactCount: 25,
      evaluatedCount: 26,
      passed: false,
    });
  });

  it("never includes receipt IDs, paths, or ground truth in aggregate output", () => {
    const manifest = parseExpenseReceiptBenchmarkManifest(manifestInput());
    const serialized = JSON.stringify(
      expenseReceiptBenchmarkValidationReport(manifest),
    );
    expect(serialized).not.toContain("receipt-001");
    expect(serialized).not.toContain("receipts/001.jpg");
    expect(serialized).not.toContain("Vendor 1");

    const failure = JSON.stringify(
      expenseReceiptBenchmarkFailureReport(
        new Error("/private/receipt.jpg Vendor 1"),
        "live",
      ),
    );
    expect(failure).toBe(
      '{"ok":false,"mode":"live","error":"benchmark_failed"}',
    );
  });
});
