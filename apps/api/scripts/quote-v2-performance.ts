import "dotenv/config";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { resolveDatabaseSslOptions } from "../src/db/ssl";
import type { DatabaseClient } from "../src/db";
import {
  listQuoteV2Staff,
  parseQuoteV2ListQuery,
} from "../src/lib/quote-v2-management";
import {
  buildQuoteV2PublicEnvelope,
  canonicalQuoteV2PublicValue,
} from "../src/lib/quote-v2-public";
import {
  assertQuoteV2PerformanceReleaseAuthorized,
  buildQuoteV2LatencyMetric,
  createQuoteV2PerformanceFixture,
  measureQuoteV2Operation,
  parseQuoteV2PerformanceArgs,
  quoteV2DatabaseMetric,
  quoteV2PerformanceReportPassed,
  QUOTE_V2_LIST_P95_THRESHOLD_MS,
  QUOTE_V2_MAX_LIST_QUERIES_PER_SAMPLE,
  QUOTE_V2_PDF_P95_THRESHOLD_MS,
  QUOTE_V2_PDF_WARMUPS,
  QUOTE_V2_PERFORMANCE_ROW_COUNT,
  QUOTE_V2_PERFORMANCE_SCHEMA_VERSION,
  QUOTE_V2_PUBLIC_RENDER_P95_THRESHOLD_MS,
  QUOTE_V2_SEARCH_P95_THRESHOLD_MS,
  QUOTE_V2_STANDARD_PDF_MAX_BYTES,
  QUOTE_V2_STANDARD_PDF_MIN_BYTES,
  QuoteV2PerformanceError,
  type QuoteV2DatabaseMetric,
  type QuoteV2LatencyMetric,
  type QuoteV2PerformanceOptions,
} from "./quote-v2-performance-core";

const DATABASE_WARMUPS = 5;
const PUBLIC_RENDER_WARMUPS = 20;
const BENCHMARK_SOURCE_PREFIX = "quote_v2_performance_harness";
const execFileAsync = promisify(execFile);
const moduleRequire = createRequire(import.meta.url);
const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const API_DIRECTORY = resolve(SCRIPT_DIRECTORY, "..");

type BenchmarkSql = postgres.TransactionSql<Record<string, unknown>>;

type QueryCounter = {
  begin(): void;
  finish(): number;
  observe(): void;
};

/**
 * postgres.js transaction clients do not expose the root client's parser and
 * serializer options, while Drizzle reads that metadata when it wraps a
 * client. Install the exact root options object without making it enumerable
 * or replaceable so the transaction-scoped adapter behaves like the root
 * client without allowing queries to escape the rollback boundary.
 */
export function installQuoteV2TransactionClientOptions(
  transaction: object,
  rootOptions: unknown,
): void {
  const existing = Reflect.get(transaction, "options") as unknown;
  if (existing !== undefined) {
    if (existing !== rootOptions) {
      throw new QuoteV2PerformanceError(
        "performance_transaction_options_conflict",
      );
    }
    return;
  }
  Object.defineProperty(transaction, "options", {
    enumerable: false,
    value: rootOptions,
    writable: false,
  });
}

type DatabaseBenchmarkResult = {
  metrics: QuoteV2DatabaseMetric[];
  transactionRolledBack: true;
  seeded: {
    contacts: number;
    properties: number;
    opportunities: number;
    quotes: number;
    versions: number;
  };
};

type RenderBenchmarkResult = {
  metrics: QuoteV2LatencyMetric[];
  standardPdfBytes: number;
  canonicalPublicBytes: number;
};

class RollbackBenchmarkTransaction extends Error {
  constructor() {
    super("rollback_quote_v2_performance_transaction");
    this.name = "RollbackBenchmarkTransaction";
  }
}

function safeCount(value: unknown, field: string): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new QuoteV2PerformanceError(
      "performance_database_count_invalid",
      field,
    );
  }
  return count;
}

function quotePrefix(seed: string): string {
  return `QV2-PERF-${createHash("sha256")
    .update(seed, "utf8")
    .digest("hex")
    .slice(0, 8)
    .toUpperCase()}`;
}

function benchmarkSource(seed: string): string {
  return `${BENCHMARK_SOURCE_PREFIX}:${createHash("sha256")
    .update(seed, "utf8")
    .digest("hex")
    .slice(0, 16)}`;
}

async function assertDisposableMigratedDatabase(sql: BenchmarkSql) {
  const [tables] = await sql<
    Array<{
      contacts: string | null;
      quotes: string | null;
      versions: string | null;
      opportunities: string | null;
    }>
  >`
    select
      to_regclass('public.contacts')::text as contacts,
      to_regclass('public.quotes')::text as quotes,
      to_regclass('public.quote_versions')::text as versions,
      to_regclass('public.sales_opportunities')::text as opportunities
  `;
  if (
    !tables?.contacts ||
    !tables.quotes ||
    !tables.versions ||
    !tables.opportunities
  ) {
    throw new QuoteV2PerformanceError(
      "performance_quote_v2_migrations_required",
      "DATABASE_URL",
    );
  }
  const [baseline] = await sql<Array<{ contacts: string; quotes: string }>>`
    select
      (select count(*)::text from contacts) as contacts,
      (select count(*)::text from quotes) as quotes
  `;
  const contactCount = safeCount(baseline?.contacts, "contacts");
  const quoteCount = safeCount(baseline?.quotes, "quotes");
  if (contactCount !== 0 || quoteCount !== 0) {
    throw new QuoteV2PerformanceError(
      "performance_disposable_empty_database_required",
      `contacts=${contactCount},quotes=${quoteCount}`,
    );
  }
}

async function createDeterministicUuidFunction(
  sql: BenchmarkSql,
): Promise<void> {
  await sql`
    create or replace function pg_temp.quote_v2_performance_uuid(
      seed text,
      kind text,
      ordinal integer
    ) returns uuid
    language sql
    immutable
    strict
    as $function$
      select (
        substr(value, 1, 12) || '4' || substr(value, 14, 3) ||
        '8' || substr(value, 18, 15)
      )::uuid
      from (select md5(seed || ':' || kind || ':' || ordinal::text) as value) digest
    $function$
  `;
}

async function seedQuoteV2PerformanceRows(
  sql: BenchmarkSql,
  seed: string,
): Promise<DatabaseBenchmarkResult["seeded"]> {
  await createDeterministicUuidFunction(sql);
  const source = benchmarkSource(seed);
  const prefix = quotePrefix(seed);
  const rows = QUOTE_V2_PERFORMANCE_ROW_COUNT;

  await sql`
    insert into contacts (
      id, first_name, last_name, company, email, preferred_contact_method,
      source, created_at, updated_at
    )
    select
      pg_temp.quote_v2_performance_uuid(${seed}, 'contact', ordinal),
      'Benchmark' || lpad(ordinal::text, 5, '0'),
      'Contact' || lpad(ordinal::text, 5, '0'),
      'QV2 Performance Company ' || lpad(ordinal::text, 5, '0'),
      'qv2-performance-' || lpad(ordinal::text, 5, '0') || '@example.test',
      case when ordinal % 2 = 0 then 'email' else 'phone' end,
      ${source},
      timestamptz '2026-01-01 00:00:00+00' + ordinal * interval '1 millisecond',
      timestamptz '2026-01-01 00:00:00+00' + ordinal * interval '1 millisecond'
    from generate_series(1, ${rows}) ordinal
  `;

  await sql`
    insert into properties (
      id, contact_id, address_line1, city, state, postal_code, created_at,
      updated_at
    )
    select
      pg_temp.quote_v2_performance_uuid(${seed}, 'property', ordinal),
      pg_temp.quote_v2_performance_uuid(${seed}, 'contact', ordinal),
      lpad(ordinal::text, 5, '0') || ' Performance Avenue',
      case when ordinal % 2 = 0 then 'Atlanta' else 'Decatur' end,
      'GA',
      lpad((30000 + ordinal % 999)::text, 5, '0'),
      timestamptz '2026-01-01 00:00:00+00' + ordinal * interval '1 millisecond',
      timestamptz '2026-01-01 00:00:00+00' + ordinal * interval '1 millisecond'
    from generate_series(1, ${rows}) ordinal
  `;

  await sql`
    insert into sales_opportunities (
      id, contact_id, property_id, name, status, pipeline_stage, currency,
      estimated_value_cents, revision, metadata, created_at, updated_at
    )
    select
      pg_temp.quote_v2_performance_uuid(${seed}, 'opportunity', ordinal),
      pg_temp.quote_v2_performance_uuid(${seed}, 'contact', ordinal),
      pg_temp.quote_v2_performance_uuid(${seed}, 'property', ordinal),
      'QV2 Performance Project ' || lpad(ordinal::text, 5, '0'),
      'open',
      'quoted',
      'USD',
      100000 + ordinal,
      1,
      jsonb_build_object('performanceHarness', true, 'ordinal', ordinal),
      timestamptz '2026-01-01 00:00:00+00' + ordinal * interval '1 millisecond',
      timestamptz '2026-01-01 00:00:00+00' + ordinal * interval '1 millisecond'
    from generate_series(1, ${rows}) ordinal
  `;

  await sql`
    insert into quotes (
      id, sales_opportunity_id, engine_version, aggregate_state,
      aggregate_revision, contact_id, property_id, status, services, add_ons,
      zone_id, travel_fee, discounts, add_ons_total, subtotal, total,
      deposit_due, deposit_rate, balance_due, line_items, quote_number,
      job_duration_minutes, revision, created_at, updated_at
    )
    select
      pg_temp.quote_v2_performance_uuid(${seed}, 'quote', ordinal),
      pg_temp.quote_v2_performance_uuid(${seed}, 'opportunity', ordinal),
      'v2',
      'draft',
      1,
      pg_temp.quote_v2_performance_uuid(${seed}, 'contact', ordinal),
      pg_temp.quote_v2_performance_uuid(${seed}, 'property', ordinal),
      'pending',
      '[]'::jsonb,
      null,
      'performance-zone',
      0,
      0,
      0,
      1000,
      1000,
      0,
      0,
      1000,
      '[]'::jsonb,
      ${prefix} || '-' || lpad(ordinal::text, 5, '0'),
      120,
      1,
      timestamptz '2026-01-01 00:00:00+00' + ordinal * interval '1 millisecond',
      timestamptz '2026-01-01 00:00:00+00' + ordinal * interval '1 millisecond'
    from generate_series(1, ${rows}) ordinal
  `;

  await sql`
    insert into quote_versions (
      id, quote_id, version_number, draft_revision, state, provenance,
      schema_version, document_type, audience, scheduling_mode, currency,
      document_snapshot, party_snapshot, issuer_snapshot, terms_snapshot,
      client_name, client_company, client_email, project_name,
      purchase_order_number, reference_number, subtotal_min_cents,
      subtotal_max_cents, total_min_cents, total_max_cents, balance_min_cents,
      balance_max_cents, scope, created_at, updated_at
    )
    select
      pg_temp.quote_v2_performance_uuid(${seed}, 'version', ordinal),
      pg_temp.quote_v2_performance_uuid(${seed}, 'quote', ordinal),
      1,
      1,
      'draft',
      'native',
      1,
      'fixed_quote',
      case when ordinal % 2 = 0 then 'commercial' else 'residential' end,
      case when ordinal % 2 = 0 then 'staff_followup' else 'self_schedule' end,
      'USD',
      '{}'::jsonb,
      '{}'::jsonb,
      '{}'::jsonb,
      '{}'::jsonb,
      'Benchmark' || lpad(ordinal::text, 5, '0') || ' Contact' || lpad(ordinal::text, 5, '0'),
      'QV2 Performance Company ' || lpad(ordinal::text, 5, '0'),
      'qv2-performance-' || lpad(ordinal::text, 5, '0') || '@example.test',
      'QV2 Performance Project ' || lpad(ordinal::text, 5, '0'),
      'PERF-PO-' || lpad(ordinal::text, 5, '0'),
      'PERF-REF-' || lpad(ordinal::text, 5, '0'),
      100000 + ordinal,
      100000 + ordinal,
      100000 + ordinal,
      100000 + ordinal,
      100000 + ordinal,
      100000 + ordinal,
      'Synthetic benchmark scope ' || lpad(ordinal::text, 5, '0'),
      timestamptz '2026-01-01 00:00:00+00' + ordinal * interval '1 millisecond',
      timestamptz '2026-01-01 00:00:00+00' + ordinal * interval '1 millisecond'
    from generate_series(1, ${rows}) ordinal
  `;

  await sql`
    update quotes
    set current_version_id = pg_temp.quote_v2_performance_uuid(
      ${seed},
      'version',
      substring(quote_number from '[0-9]{5}$')::integer
    )
    where quote_number like ${`${prefix}-%`}
  `;

  await sql`analyze contacts, properties, sales_opportunities, quotes, quote_versions`;

  const [counts] = await sql<
    Array<{
      contacts: string;
      properties: string;
      opportunities: string;
      quotes: string;
      versions: string;
    }>
  >`
    select
      (select count(*)::text from contacts where source = ${source}) as contacts,
      (select count(*)::text from properties) as properties,
      (select count(*)::text from sales_opportunities where metadata->>'performanceHarness' = 'true') as opportunities,
      (select count(*)::text from quotes where quote_number like ${`${prefix}-%`}) as quotes,
      (select count(*)::text from quote_versions) as versions
  `;
  const seeded = {
    contacts: safeCount(counts?.contacts, "contacts"),
    properties: safeCount(counts?.properties, "properties"),
    opportunities: safeCount(counts?.opportunities, "opportunities"),
    quotes: safeCount(counts?.quotes, "quotes"),
    versions: safeCount(counts?.versions, "versions"),
  };
  if (
    Object.values(seeded).some(
      (count) => count !== QUOTE_V2_PERFORMANCE_ROW_COUNT,
    )
  ) {
    throw new QuoteV2PerformanceError(
      "performance_seed_count_mismatch",
      JSON.stringify(seeded),
    );
  }
  return seeded;
}

function parsedQuoteListQuery(parameters: Record<string, string>) {
  const parsed = parseQuoteV2ListQuery(new URLSearchParams(parameters));
  if (!parsed.ok) {
    throw new QuoteV2PerformanceError(
      "performance_quote_list_query_invalid",
      Object.keys(parsed.fieldErrors)[0] ?? "query",
    );
  }
  return parsed;
}

async function measureDatabaseOperation<T>(input: {
  name: string;
  samples: number;
  thresholdMs: number;
  counter: QueryCounter;
  operation: (iteration: number) => Promise<T>;
  validate: (value: T, iteration: number) => void;
}): Promise<QuoteV2DatabaseMetric> {
  for (let index = 0; index < DATABASE_WARMUPS; index += 1) {
    input.validate(await input.operation(index), index);
  }
  const durations: number[] = [];
  const queryCounts: number[] = [];
  for (let index = 0; index < input.samples; index += 1) {
    input.counter.begin();
    const startedAt = performance.now();
    let value: T;
    try {
      value = await input.operation(index);
      durations.push(performance.now() - startedAt);
    } finally {
      queryCounts.push(input.counter.finish());
    }
    input.validate(value!, index);
  }
  return quoteV2DatabaseMetric({
    metric: buildQuoteV2LatencyMetric({
      name: input.name,
      durationsMs: durations,
      warmups: DATABASE_WARMUPS,
      thresholdMs: input.thresholdMs,
    }),
    queryCounts,
    maximumQueriesPerSample: QUOTE_V2_MAX_LIST_QUERIES_PER_SAMPLE,
  });
}

async function runDatabaseMeasurements(input: {
  sql: BenchmarkSql;
  options: QuoteV2PerformanceOptions;
  counter: QueryCounter;
}): Promise<DatabaseBenchmarkResult> {
  await assertDisposableMigratedDatabase(input.sql);
  const seeded = await seedQuoteV2PerformanceRows(
    input.sql,
    input.options.seed,
  );
  const db = drizzle(input.sql) as unknown as DatabaseClient;
  const firstPageQuery = parsedQuoteListQuery({
    engine: "v2",
    limit: "50",
    sort: "updated_desc",
  });
  const cursorSeed = await listQuoteV2Staff(db, firstPageQuery);
  if (!cursorSeed.nextCursor || cursorSeed.quotes.length !== 50) {
    throw new QuoteV2PerformanceError(
      "performance_cursor_seed_invalid",
      "quote-list",
    );
  }
  const cursorPageQuery = parsedQuoteListQuery({
    engine: "v2",
    limit: "50",
    sort: "updated_desc",
    cursor: cursorSeed.nextCursor,
  });
  const prefix = quotePrefix(input.options.seed);
  const searchTerms = [
    "Benchmark09991",
    "Performance Company 09992",
    "Performance Project 09993",
    "PERF-PO-09994",
    "09995 Performance Avenue",
    `${prefix}-09996`,
  ];
  const searchQueries = searchTerms.map((search) =>
    parsedQuoteListQuery({
      engine: "v2",
      limit: "20",
      sort: "updated_desc",
      search,
    }),
  );

  const metrics = [
    await measureDatabaseOperation({
      name: "quote_list_first_page",
      samples: input.options.databaseSamples,
      thresholdMs: QUOTE_V2_LIST_P95_THRESHOLD_MS,
      counter: input.counter,
      operation: () => listQuoteV2Staff(db, firstPageQuery),
      validate: (value) => {
        if (value.quotes.length !== 50 || !value.nextCursor) {
          throw new QuoteV2PerformanceError(
            "performance_quote_list_result_invalid",
            "first-page",
          );
        }
      },
    }),
    await measureDatabaseOperation({
      name: "quote_list_cursor_page",
      samples: input.options.databaseSamples,
      thresholdMs: QUOTE_V2_LIST_P95_THRESHOLD_MS,
      counter: input.counter,
      operation: () => listQuoteV2Staff(db, cursorPageQuery),
      validate: (value) => {
        if (value.quotes.length !== 50) {
          throw new QuoteV2PerformanceError(
            "performance_quote_list_result_invalid",
            "cursor-page",
          );
        }
      },
    }),
    await measureDatabaseOperation({
      name: "quote_contact_project_search",
      samples: input.options.databaseSamples,
      thresholdMs: QUOTE_V2_SEARCH_P95_THRESHOLD_MS,
      counter: input.counter,
      operation: (iteration) =>
        listQuoteV2Staff(db, searchQueries[iteration % searchQueries.length]!),
      validate: (value, iteration) => {
        const term = searchTerms[iteration % searchTerms.length] ?? "missing";
        const ordinal = term.match(/[0-9]{5}/u)?.[0] ?? "missing";
        const quoteNumber = value.quotes[0]?.["quoteNumber"];
        if (
          value.quotes.length !== 1 ||
          value.nextCursor !== null ||
          typeof quoteNumber !== "string" ||
          !quoteNumber.includes(ordinal)
        ) {
          throw new QuoteV2PerformanceError(
            "performance_quote_search_result_invalid",
            term,
          );
        }
      },
    }),
  ];
  return { metrics, transactionRolledBack: true, seeded };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parsePdfWorkerResult(
  value: unknown,
  expectedSamples: number,
): { metric: QuoteV2LatencyMetric; standardPdfBytes: number } {
  if (!isRecord(value) || !isRecord(value["metric"])) {
    throw new QuoteV2PerformanceError("performance_pdf_worker_result_invalid");
  }
  const metric = value["metric"];
  const numericKeys = [
    "samples",
    "warmups",
    "thresholdMs",
    "p50Ms",
    "p95Ms",
    "maximumMs",
  ] as const;
  if (
    metric["name"] !== "standard_proposal_pdf" ||
    metric["samples"] !== expectedSamples ||
    metric["warmups"] !== QUOTE_V2_PDF_WARMUPS ||
    metric["thresholdMs"] !== QUOTE_V2_PDF_P95_THRESHOLD_MS ||
    typeof metric["passed"] !== "boolean" ||
    numericKeys.some(
      (key) =>
        typeof metric[key] !== "number" ||
        !Number.isFinite(metric[key]) ||
        Number(metric[key]) < 0,
    ) ||
    !Number.isSafeInteger(value["standardPdfBytes"]) ||
    Number(value["standardPdfBytes"]) < QUOTE_V2_STANDARD_PDF_MIN_BYTES ||
    Number(value["standardPdfBytes"]) > QUOTE_V2_STANDARD_PDF_MAX_BYTES
  ) {
    throw new QuoteV2PerformanceError("performance_pdf_worker_result_invalid");
  }
  return {
    metric: metric as QuoteV2LatencyMetric,
    standardPdfBytes: Number(value["standardPdfBytes"]),
  };
}

async function runPdfPerformanceWorker(
  options: QuoteV2PerformanceOptions,
): Promise<{ metric: QuoteV2LatencyMetric; standardPdfBytes: number }> {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "stonegate-qv2-performance-"),
  );
  const resultPath = join(temporaryDirectory, "pdf-result.json");
  try {
    const jestBin = moduleRequire.resolve("jest/bin/jest");
    const benchmarkPath = resolve(
      API_DIRECTORY,
      "src/__benchmarks__/quote-v2-pdf-performance.benchmark.ts",
    );
    const configPath = resolve(
      API_DIRECTORY,
      "scripts/quote-v2-performance-jest.config.cjs",
    );
    try {
      await execFileAsync(
        process.execPath,
        [
          "--experimental-vm-modules",
          jestBin,
          "--config",
          configPath,
          "--runInBand",
          "--runTestsByPath",
          benchmarkPath,
        ],
        {
          cwd: API_DIRECTORY,
          env: {
            ...process.env,
            QUOTE_V2_PDF_PERFORMANCE_EXECUTE: "1",
            QUOTE_V2_PDF_PERFORMANCE_SAMPLES: String(options.pdfSamples),
            QUOTE_V2_PDF_PERFORMANCE_RESULT: resultPath,
          },
          timeout: 5 * 60 * 1_000,
          maxBuffer: 1024 * 1024,
        },
      );
    } catch {
      throw new QuoteV2PerformanceError("performance_pdf_worker_failed");
    }
    let decoded: unknown;
    try {
      const bytes = await readFile(resultPath);
      if (bytes.byteLength < 2 || bytes.byteLength > 64 * 1024) {
        throw new Error("invalid_pdf_worker_result_size");
      }
      decoded = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch {
      throw new QuoteV2PerformanceError(
        "performance_pdf_worker_result_invalid",
      );
    }
    return parsePdfWorkerResult(decoded, options.pdfSamples);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function runQuoteV2RenderPerformance(
  options: QuoteV2PerformanceOptions,
): Promise<RenderBenchmarkResult> {
  const fixture = createQuoteV2PerformanceFixture();
  const publicDurations = await measureQuoteV2Operation({
    samples: options.publicRenderSamples,
    warmups: PUBLIC_RENDER_WARMUPS,
    operation: () =>
      canonicalQuoteV2PublicValue(
        buildQuoteV2PublicEnvelope(fixture.publicRow, fixture.now),
      ),
    validate: (value) => {
      if (value !== fixture.canonicalPublicValue) {
        throw new QuoteV2PerformanceError(
          "performance_public_render_nondeterministic",
        );
      }
    },
  });
  const pdf = await runPdfPerformanceWorker(options);
  return {
    metrics: [
      buildQuoteV2LatencyMetric({
        name: "canonical_public_proposal_render",
        durationsMs: publicDurations,
        warmups: PUBLIC_RENDER_WARMUPS,
        thresholdMs: QUOTE_V2_PUBLIC_RENDER_P95_THRESHOLD_MS,
      }),
      pdf.metric,
    ],
    standardPdfBytes: pdf.standardPdfBytes,
    canonicalPublicBytes: Buffer.byteLength(
      fixture.canonicalPublicValue,
      "utf8",
    ),
  };
}

async function runQuoteV2DatabasePerformance(
  options: QuoteV2PerformanceOptions,
): Promise<DatabaseBenchmarkResult> {
  const databaseUrl = assertQuoteV2PerformanceReleaseAuthorized(
    options,
    process.env,
  );
  let recording = false;
  let currentQueryCount = 0;
  const counter: QueryCounter = {
    begin() {
      if (recording) {
        throw new QuoteV2PerformanceError(
          "performance_query_counter_already_recording",
        );
      }
      currentQueryCount = 0;
      recording = true;
    },
    finish() {
      const result = currentQueryCount;
      currentQueryCount = 0;
      recording = false;
      return result;
    },
    observe() {
      if (recording) currentQueryCount += 1;
    },
  };
  const ssl = resolveDatabaseSslOptions(databaseUrl);
  const client = postgres(databaseUrl, {
    prepare: false,
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
    debug: () => counter.observe(),
    ...(ssl ? { ssl } : {}),
  });
  let result: DatabaseBenchmarkResult | null = null;
  try {
    try {
      await client.begin(async (sql) => {
        // postgres.js transaction clients intentionally omit the root client's
        // parser/serializer options. Drizzle reads those options while wrapping
        // a postgres.js client, so expose the same immutable connection metadata
        // on this transaction-scoped client before constructing the benchmark DB.
        // Queries still execute on `sql` and therefore remain inside the rollback.
        installQuoteV2TransactionClientOptions(sql, client.options);
        result = await runDatabaseMeasurements({ sql, options, counter });
        throw new RollbackBenchmarkTransaction();
      });
    } catch (error) {
      if (!(error instanceof RollbackBenchmarkTransaction)) throw error;
    }
  } finally {
    await client.end({ timeout: 5 });
  }
  if (!result) {
    throw new QuoteV2PerformanceError("performance_database_result_missing");
  }
  return result;
}

export async function runQuoteV2Performance(
  options: QuoteV2PerformanceOptions,
) {
  const startedAt = new Date();
  const database =
    options.mode === "release"
      ? await runQuoteV2DatabasePerformance(options)
      : null;
  const render = await runQuoteV2RenderPerformance(options);
  const metrics = [...(database?.metrics ?? []), ...render.metrics];
  const completedAt = new Date();
  return {
    schemaVersion: QUOTE_V2_PERFORMANCE_SCHEMA_VERSION,
    ok: quoteV2PerformanceReportPassed(metrics),
    mode: options.mode,
    rowCount: QUOTE_V2_PERFORMANCE_ROW_COUNT,
    seedSha256: createHash("sha256").update(options.seed, "utf8").digest("hex"),
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: completedAt.getTime() - startedAt.getTime(),
    runtime: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
    },
    metrics,
    database,
    render: {
      standardPdfBytes: render.standardPdfBytes,
      canonicalPublicBytes: render.canonicalPublicBytes,
    },
    limitations: [
      "This Node harness does not measure browser LCP, INP, CLS, zoom, or network conditions.",
      "Database timings exclude HTTP authentication, BFF transport, and JSON transfer time.",
      "PDF timings exclude object-storage upload and use the standard proposal without a remote logo.",
      ...(options.mode === "render"
        ? ["Render mode does not execute the 10,000-row database gates."]
        : []),
    ],
  };
}

async function main(): Promise<void> {
  try {
    const options = parseQuoteV2PerformanceArgs(process.argv.slice(2));
    const report = await runQuoteV2Performance(options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    const failure =
      error instanceof QuoteV2PerformanceError
        ? { code: error.code, field: error.field }
        : {
            code: "performance_unexpected_failure",
            field: null,
          };
    process.stderr.write(
      `${JSON.stringify(
        {
          schemaVersion: QUOTE_V2_PERFORMANCE_SCHEMA_VERSION,
          ok: false,
          error: failure,
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : null;
if (invokedPath === import.meta.url) {
  void main();
}
