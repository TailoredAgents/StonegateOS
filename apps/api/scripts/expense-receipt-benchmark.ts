import "dotenv/config";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  DEFAULT_OPENAI_API_BASE_URL,
  resolveOpenAiApiEndpoint,
} from "@myst-os/sdk";
import { parseJsonRejectingDuplicateObjectKeys } from "../src/lib/bounded-json-request";
import {
  extractExpenseReceiptWithOpenAi,
  resolveExpenseReceiptOpenAiConfig,
} from "../src/lib/expense-receipt-openai";
import {
  MAX_EXPENSE_RECEIPT_UPLOAD_BYTES,
  verifyAndNormalizeExpenseReceiptUpload,
} from "../src/lib/expense-receipt-storage";
import {
  assertExpenseReceiptBenchmarkLiveAuthorized,
  ExpenseReceiptBenchmarkError,
  expenseReceiptBenchmarkFailureReport,
  expenseReceiptBenchmarkLiveReport,
  expenseReceiptBenchmarkValidationReport,
  parseExpenseReceiptBenchmarkArgs,
  parseExpenseReceiptBenchmarkManifest,
  scoreExpenseReceiptBenchmark,
  type ExpenseReceiptBenchmarkContentType,
  type ExpenseReceiptBenchmarkManifest,
  type ExpenseReceiptBenchmarkResult,
} from "./expense-receipt-benchmark-core";

const MAX_MANIFEST_BYTES = 1024 * 1024;
const OFFICIAL_RESPONSES_ENDPOINT = `${DEFAULT_OPENAI_API_BASE_URL}/responses`;

type PreparedReceipt = {
  id: string;
  absolutePath: string;
  contentType: ExpenseReceiptBenchmarkContentType;
  byteLength: number;
  sha256: string;
};

function fieldForReceipt(index: number, suffix = "file"): string {
  return `receipts.${index}.${suffix}`;
}

async function readManifest(manifestArgument: string): Promise<{
  manifest: ExpenseReceiptBenchmarkManifest;
  root: string;
}> {
  let manifestPath: string;
  let manifestStat;
  let bytes: Buffer;
  try {
    manifestPath = await realpath(resolve(manifestArgument));
    manifestStat = await stat(manifestPath);
    if (
      !manifestStat.isFile() ||
      manifestStat.size < 1 ||
      manifestStat.size > MAX_MANIFEST_BYTES
    ) {
      throw new ExpenseReceiptBenchmarkError("benchmark_manifest_file_invalid");
    }
    bytes = await readFile(manifestPath);
  } catch (error) {
    if (error instanceof ExpenseReceiptBenchmarkError) throw error;
    throw new ExpenseReceiptBenchmarkError("benchmark_manifest_read_failed");
  }

  let text: string;
  let decoded: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    decoded = parseJsonRejectingDuplicateObjectKeys(text);
  } catch {
    throw new ExpenseReceiptBenchmarkError("benchmark_manifest_json_invalid");
  }
  return {
    manifest: parseExpenseReceiptBenchmarkManifest(decoded),
    root: dirname(manifestPath),
  };
}

function isWithinRoot(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot.length > 0 &&
    !fromRoot.startsWith(`..${sep}`) &&
    fromRoot !== ".." &&
    !isAbsolute(fromRoot)
  );
}

async function verifiedReceipt(input: {
  absolutePath: string;
  contentType: ExpenseReceiptBenchmarkContentType;
  expectedByteLength?: number;
  expectedSha256?: string;
  field: string;
}) {
  let fileStat;
  let bytes: Buffer;
  try {
    fileStat = await stat(input.absolutePath);
    if (
      !fileStat.isFile() ||
      fileStat.size < 1 ||
      fileStat.size > MAX_EXPENSE_RECEIPT_UPLOAD_BYTES ||
      (input.expectedByteLength !== undefined &&
        fileStat.size !== input.expectedByteLength)
    ) {
      throw new ExpenseReceiptBenchmarkError(
        "benchmark_receipt_file_invalid",
        input.field,
      );
    }
    bytes = await readFile(input.absolutePath);
    if (
      bytes.byteLength !== fileStat.size ||
      bytes.byteLength > MAX_EXPENSE_RECEIPT_UPLOAD_BYTES
    ) {
      throw new ExpenseReceiptBenchmarkError(
        "benchmark_receipt_file_changed",
        input.field,
      );
    }
  } catch (error) {
    if (error instanceof ExpenseReceiptBenchmarkError) throw error;
    throw new ExpenseReceiptBenchmarkError(
      "benchmark_receipt_read_failed",
      input.field,
    );
  }

  try {
    return await verifyAndNormalizeExpenseReceiptUpload({
      bytes,
      declaredContentType: input.contentType,
      declaredByteLength: bytes.byteLength,
      expectedSha256: input.expectedSha256,
    });
  } catch {
    throw new ExpenseReceiptBenchmarkError(
      input.expectedSha256
        ? "benchmark_receipt_file_changed"
        : "benchmark_receipt_evidence_invalid",
      input.field,
    );
  }
}

async function prepareCorpus(input: {
  manifest: ExpenseReceiptBenchmarkManifest;
  root: string;
}): Promise<PreparedReceipt[]> {
  const realPaths = new Set<string>();
  const prepared: PreparedReceipt[] = [];

  for (const [index, receipt] of input.manifest.receipts.entries()) {
    const field = fieldForReceipt(index);
    let absolutePath: string;
    try {
      absolutePath = await realpath(resolve(input.root, receipt.file));
    } catch {
      throw new ExpenseReceiptBenchmarkError(
        "benchmark_receipt_read_failed",
        field,
      );
    }
    if (!isWithinRoot(input.root, absolutePath)) {
      throw new ExpenseReceiptBenchmarkError(
        "benchmark_receipt_outside_corpus",
        field,
      );
    }
    if (realPaths.has(absolutePath)) {
      throw new ExpenseReceiptBenchmarkError(
        "benchmark_receipt_file_duplicate",
        field,
      );
    }
    realPaths.add(absolutePath);

    const verified = await verifiedReceipt({
      absolutePath,
      contentType: receipt.contentType,
      field,
    });
    prepared.push({
      id: receipt.id,
      absolutePath,
      contentType: receipt.contentType,
      byteLength: verified.byteLength,
      sha256: verified.sha256,
    });
  }

  return prepared;
}

function assertOfficialOpenAiConfiguration(model: string): {
  environment: Readonly<Record<string, string | undefined>>;
  model: string;
} {
  const environment = {
    ...process.env,
    OPENAI_EXPENSE_MODEL: model,
  };
  let configuredModel: string;
  let endpoint: string;
  try {
    configuredModel = resolveExpenseReceiptOpenAiConfig(environment).model;
    endpoint = resolveOpenAiApiEndpoint("responses", environment);
  } catch {
    throw new ExpenseReceiptBenchmarkError(
      "benchmark_openai_configuration_invalid",
    );
  }
  if (configuredModel !== model) {
    throw new ExpenseReceiptBenchmarkError("benchmark_model_mismatch");
  }
  if (endpoint !== OFFICIAL_RESPONSES_ENDPOINT) {
    throw new ExpenseReceiptBenchmarkError(
      "benchmark_openai_endpoint_not_official",
    );
  }
  return { environment, model: configuredModel };
}

async function runLiveBenchmark(input: {
  manifest: ExpenseReceiptBenchmarkManifest;
  prepared: readonly PreparedReceipt[];
  model: string;
}): Promise<ExpenseReceiptBenchmarkResult[]> {
  const configuration = assertOfficialOpenAiConfiguration(input.model);
  const results: ExpenseReceiptBenchmarkResult[] = [];

  // Sequential execution deliberately bounds provider load and makes one
  // explicitly confirmed API request per validated receipt.
  for (const [index, receipt] of input.prepared.entries()) {
    const verified = await verifiedReceipt({
      absolutePath: receipt.absolutePath,
      contentType: receipt.contentType,
      expectedByteLength: receipt.byteLength,
      expectedSha256: receipt.sha256,
      field: fieldForReceipt(index),
    });
    const evidence = verified.normalized ?? {
      bytes: verified.originalBytes,
      contentType: verified.verifiedContentType,
    };
    try {
      const analyzed = await extractExpenseReceiptWithOpenAi({
        filename:
          evidence.contentType === "application/pdf"
            ? "benchmark-receipt.pdf"
            : "benchmark-receipt",
        contentType: evidence.contentType,
        bytes: evidence.bytes,
        environment: configuration.environment,
      });
      results.push({
        id: receipt.id,
        extraction: {
          totalCents: analyzed.extraction.totalCents,
          transactionDate: analyzed.extraction.transactionDate,
          vendor: analyzed.extraction.vendor,
        },
      });
    } catch {
      // Provider and schema failures count as incorrect for every required
      // field. Never print provider text or receipt-level diagnostics.
      results.push({ id: receipt.id, extraction: null });
    }
  }
  return results;
}

async function main(): Promise<void> {
  let mode: "validation" | "live" = "validation";
  try {
    const options = parseExpenseReceiptBenchmarkArgs(process.argv.slice(2));
    mode = options.executeLive ? "live" : "validation";
    const loaded = await readManifest(options.manifestPath);
    const prepared = await prepareCorpus(loaded);

    if (!options.executeLive) {
      console.log(
        JSON.stringify(
          expenseReceiptBenchmarkValidationReport(loaded.manifest),
        ),
      );
      return;
    }

    const authorization = assertExpenseReceiptBenchmarkLiveAuthorized({
      receiptCount: loaded.manifest.receipts.length,
      confirmation: options.confirmation,
      model: options.model,
    });
    const results = await runLiveBenchmark({
      manifest: loaded.manifest,
      prepared,
      model: authorization.model,
    });
    const score = scoreExpenseReceiptBenchmark(loaded.manifest, results);
    console.log(
      JSON.stringify(
        expenseReceiptBenchmarkLiveReport({
          model: authorization.model,
          score,
        }),
      ),
    );
    if (!score.passed) process.exitCode = 2;
  } catch (error) {
    console.log(
      JSON.stringify(expenseReceiptBenchmarkFailureReport(error, mode)),
    );
    process.exitCode = 1;
  }
}

void main();
