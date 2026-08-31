import { performance } from "node:perf_hooks";
import { QuoteDocumentSnapshotSchema } from "../src/lib/quote-v2-contract";
import { calculateQuoteV2Totals } from "../src/lib/quote-v2-domain";
import {
  buildQuoteV2PublicEnvelope,
  canonicalQuoteV2PublicValue,
  type QuoteV2PublicCapabilitySnapshot,
} from "../src/lib/quote-v2-public";
import {
  buildQuoteRenderModel,
  type QuoteRenderInput,
  type QuoteRenderModel,
} from "../src/lib/quote-v2-render-model";

export const QUOTE_V2_PERFORMANCE_SCHEMA_VERSION = 1 as const;
export const QUOTE_V2_PERFORMANCE_ROW_COUNT = 10_000;
export const QUOTE_V2_PERFORMANCE_CONFIRMATION =
  "QUOTE_V2_PERFORMANCE_10000_ROLLBACK";
export const QUOTE_V2_LIST_P95_THRESHOLD_MS = 500;
export const QUOTE_V2_SEARCH_P95_THRESHOLD_MS = 300;
export const QUOTE_V2_PUBLIC_RENDER_P95_THRESHOLD_MS = 100;
export const QUOTE_V2_PDF_P95_THRESHOLD_MS = 3_000;
export const QUOTE_V2_MAX_LIST_QUERIES_PER_SAMPLE = 1;
export const QUOTE_V2_PDF_WARMUPS = 2;
export const QUOTE_V2_STANDARD_PDF_MIN_BYTES = 10_000;
export const QUOTE_V2_STANDARD_PDF_MAX_BYTES = 20 * 1024 * 1024;

const DEFAULT_SEED = "stonegate-qv2-performance-v1";
const SEED_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;
const INTEGER_PATTERN = /^(?:0|[1-9][0-9]*)$/u;

export type QuoteV2PerformanceMode = "render" | "release";

export type QuoteV2PerformanceOptions = {
  mode: QuoteV2PerformanceMode;
  execute: boolean;
  confirmation: string | null;
  seed: string;
  databaseSamples: number;
  publicRenderSamples: number;
  pdfSamples: number;
};

export type QuoteV2PerformanceEnvironment = {
  DATABASE_URL?: string;
  NODE_ENV?: string;
};

export type QuoteV2LatencyMetric = {
  name: string;
  samples: number;
  warmups: number;
  thresholdMs: number;
  p50Ms: number;
  p95Ms: number;
  maximumMs: number;
  passed: boolean;
};

export type QuoteV2DatabaseMetric = QuoteV2LatencyMetric & {
  maximumQueriesPerSample: number;
  observedMaximumQueriesPerSample: number;
  queryCountPassed: boolean;
};

export class QuoteV2PerformanceError extends Error {
  constructor(
    readonly code: string,
    readonly field: string | null = null,
  ) {
    super(field ? `${code}:${field}` : code);
    this.name = "QuoteV2PerformanceError";
  }
}

function exactArgumentValue(
  args: readonly string[],
  name: string,
): string | null {
  const prefix = `${name}=`;
  const matches = args.filter((argument) => argument.startsWith(prefix));
  if (matches.length > 1) {
    throw new QuoteV2PerformanceError(
      "performance_argument_duplicate",
      name.slice(2),
    );
  }
  return matches[0]?.slice(prefix.length) ?? null;
}

function boundedIntegerArgument(input: {
  value: string | null;
  fallback: number;
  minimum: number;
  maximum: number;
  field: string;
}): number {
  if (input.value === null) return input.fallback;
  if (!INTEGER_PATTERN.test(input.value)) {
    throw new QuoteV2PerformanceError(
      "performance_argument_invalid",
      input.field,
    );
  }
  const parsed = Number(input.value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < input.minimum ||
    parsed > input.maximum
  ) {
    throw new QuoteV2PerformanceError(
      "performance_argument_out_of_range",
      input.field,
    );
  }
  return parsed;
}

export function parseQuoteV2PerformanceArgs(
  args: readonly string[],
): QuoteV2PerformanceOptions {
  const supported = new Set([
    "--execute",
    "--mode",
    "--confirm",
    "--seed",
    "--database-samples",
    "--public-samples",
    "--pdf-samples",
  ]);
  for (const argument of args) {
    const name = argument.split("=", 1)[0] ?? argument;
    if (!supported.has(name) || (name === "--execute" && argument !== name)) {
      throw new QuoteV2PerformanceError(
        "performance_argument_unknown",
        argument,
      );
    }
  }
  if (args.filter((argument) => argument === "--execute").length > 1) {
    throw new QuoteV2PerformanceError(
      "performance_argument_duplicate",
      "execute",
    );
  }

  const modeValue = exactArgumentValue(args, "--mode");
  if (modeValue !== "render" && modeValue !== "release") {
    throw new QuoteV2PerformanceError(
      modeValue === null
        ? "performance_mode_required"
        : "performance_mode_invalid",
      "mode",
    );
  }
  const seed = exactArgumentValue(args, "--seed") ?? DEFAULT_SEED;
  if (!SEED_PATTERN.test(seed)) {
    throw new QuoteV2PerformanceError("performance_seed_invalid", "seed");
  }
  const options: QuoteV2PerformanceOptions = {
    mode: modeValue,
    execute: args.includes("--execute"),
    confirmation: exactArgumentValue(args, "--confirm"),
    seed,
    databaseSamples: boundedIntegerArgument({
      value: exactArgumentValue(args, "--database-samples"),
      fallback: 30,
      minimum: 20,
      maximum: 100,
      field: "database-samples",
    }),
    publicRenderSamples: boundedIntegerArgument({
      value: exactArgumentValue(args, "--public-samples"),
      fallback: 200,
      minimum: 50,
      maximum: 2_000,
      field: "public-samples",
    }),
    pdfSamples: boundedIntegerArgument({
      value: exactArgumentValue(args, "--pdf-samples"),
      fallback: 20,
      minimum: 20,
      maximum: 50,
      field: "pdf-samples",
    }),
  };
  if (
    options.mode === "render" &&
    (options.execute ||
      options.confirmation !== null ||
      args.some((argument) => argument.startsWith("--database-samples=")))
  ) {
    throw new QuoteV2PerformanceError(
      "performance_release_argument_in_render_mode",
      "mode",
    );
  }
  return options;
}

export function assertQuoteV2PerformanceReleaseAuthorized(
  options: QuoteV2PerformanceOptions,
  environment: QuoteV2PerformanceEnvironment,
): string {
  if (options.mode !== "release") {
    throw new QuoteV2PerformanceError("performance_release_mode_required");
  }
  if (!options.execute) {
    throw new QuoteV2PerformanceError("performance_execute_required");
  }
  if (options.confirmation !== QUOTE_V2_PERFORMANCE_CONFIRMATION) {
    throw new QuoteV2PerformanceError(
      "performance_confirmation_required",
      "confirm",
    );
  }
  if (environment.NODE_ENV?.trim().toLowerCase() === "production") {
    throw new QuoteV2PerformanceError(
      "performance_production_database_forbidden",
      "NODE_ENV",
    );
  }
  const databaseUrl = environment.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new QuoteV2PerformanceError(
      "performance_database_url_required",
      "DATABASE_URL",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new QuoteV2PerformanceError(
      "performance_database_url_invalid",
      "DATABASE_URL",
    );
  }
  if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol)) {
    throw new QuoteV2PerformanceError(
      "performance_database_url_invalid",
      "DATABASE_URL",
    );
  }
  return databaseUrl;
}

export function nearestRankPercentile(
  values: readonly number[],
  percentile: number,
): number {
  if (
    values.length === 0 ||
    !Number.isFinite(percentile) ||
    percentile <= 0 ||
    percentile > 1 ||
    values.some((value) => !Number.isFinite(value) || value < 0)
  ) {
    throw new QuoteV2PerformanceError("performance_samples_invalid");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(percentile * sorted.length) - 1);
  return sorted[index]!;
}

function roundedMilliseconds(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

export function buildQuoteV2LatencyMetric(input: {
  name: string;
  durationsMs: readonly number[];
  warmups: number;
  thresholdMs: number;
}): QuoteV2LatencyMetric {
  if (
    !input.name ||
    !Number.isSafeInteger(input.warmups) ||
    input.warmups < 0 ||
    !Number.isFinite(input.thresholdMs) ||
    input.thresholdMs <= 0
  ) {
    throw new QuoteV2PerformanceError("performance_metric_invalid");
  }
  const p95 = nearestRankPercentile(input.durationsMs, 0.95);
  return {
    name: input.name,
    samples: input.durationsMs.length,
    warmups: input.warmups,
    thresholdMs: input.thresholdMs,
    p50Ms: roundedMilliseconds(nearestRankPercentile(input.durationsMs, 0.5)),
    p95Ms: roundedMilliseconds(p95),
    maximumMs: roundedMilliseconds(Math.max(...input.durationsMs)),
    passed: p95 < input.thresholdMs,
  };
}

export async function measureQuoteV2Operation<T>(input: {
  samples: number;
  warmups: number;
  operation: (iteration: number) => T | Promise<T>;
  validate?: (value: T, iteration: number) => void;
}): Promise<number[]> {
  if (
    !Number.isSafeInteger(input.samples) ||
    input.samples < 1 ||
    !Number.isSafeInteger(input.warmups) ||
    input.warmups < 0
  ) {
    throw new QuoteV2PerformanceError("performance_iteration_count_invalid");
  }
  for (let index = 0; index < input.warmups; index += 1) {
    const value = await input.operation(index);
    input.validate?.(value, index);
  }
  const durations: number[] = [];
  for (let index = 0; index < input.samples; index += 1) {
    const startedAt = performance.now();
    const value = await input.operation(index);
    durations.push(performance.now() - startedAt);
    input.validate?.(value, index);
  }
  return durations;
}

export function quoteV2DatabaseMetric(input: {
  metric: QuoteV2LatencyMetric;
  queryCounts: readonly number[];
  maximumQueriesPerSample?: number;
}): QuoteV2DatabaseMetric {
  if (
    input.queryCounts.length !== input.metric.samples ||
    input.queryCounts.some((count) => !Number.isSafeInteger(count) || count < 0)
  ) {
    throw new QuoteV2PerformanceError("performance_query_counts_invalid");
  }
  const maximumQueriesPerSample =
    input.maximumQueriesPerSample ?? QUOTE_V2_MAX_LIST_QUERIES_PER_SAMPLE;
  const observedMaximumQueriesPerSample = Math.max(...input.queryCounts);
  const queryCountPassed =
    observedMaximumQueriesPerSample <= maximumQueriesPerSample;
  return {
    ...input.metric,
    maximumQueriesPerSample,
    observedMaximumQueriesPerSample,
    queryCountPassed,
    passed: input.metric.passed && queryCountPassed,
  };
}

export function quoteV2PerformanceReportPassed(
  metrics: ReadonlyArray<{ passed: boolean }>,
): boolean {
  return metrics.length > 0 && metrics.every((metric) => metric.passed);
}

const PERFORMANCE_NOW = new Date("2026-09-01T12:00:00.000Z");
const ISSUED_AT = new Date("2026-08-30T12:00:00.000Z");
const EXPIRES_AT = new Date("2026-09-29T12:00:00.000Z");

export type QuoteV2PerformanceFixture = {
  now: Date;
  renderInput: QuoteRenderInput;
  renderModel: QuoteRenderModel;
  publicRow: QuoteV2PublicCapabilitySnapshot;
  canonicalPublicValue: string;
};

export function createQuoteV2PerformanceFixture(): QuoteV2PerformanceFixture {
  const baseLines = Array.from({ length: 10 }, (_, index) => ({
    id: `base-${String(index + 1).padStart(2, "0")}`,
    catalogKey: `commercial-service-${String(index + 1).padStart(2, "0")}`,
    name: `Commercial service phase ${index + 1}`,
    description:
      "Documented labor, hauling, cleanup, and responsible disposal for this project phase.",
    quantity: index % 2 === 0 ? 1 : 2.5,
    unit: index % 2 === 0 ? "project" : "hour",
    unitPriceMinCents: 15_000 + index * 2_500,
    unitPriceMaxCents: 15_000 + index * 2_500,
    displayOrder: index,
  }));
  const document = QuoteDocumentSnapshotSchema.parse({
    schemaVersion: 1,
    documentType: "fixed_quote",
    audience: "commercial",
    schedulingMode: "staff_followup",
    parties: {
      customerName: "Performance Client",
      companyName: "Benchmark Facilities LLC",
      attentionName: "Performance Client",
      attentionTitle: "Facilities Director",
      email: "performance@example.test",
      phoneE164: "+14045550123",
      billingAddress: "100 Benchmark Way, Atlanta, GA 30301",
      serviceAddress: "200 Performance Avenue, Atlanta, GA 30302",
      projectName: "Standard commercial cleanout",
      purchaseOrder: "PERF-PO-10000",
      reference: "PERF-SITE-A",
      preparerName: "Benchmark Sales",
    },
    issuer: {
      legalName: "Stonegate Services LLC",
      displayName: "Stonegate",
      address: "1 Stonegate Way, Atlanta, GA 30301",
      email: "support@example.test",
      phoneE164: "+14045550100",
      website: "https://example.test",
      supportMessage: "Contact our team with proposal questions.",
    },
    scope:
      "Remove, haul, and responsibly dispose of the documented commercial material while preserving safe access to the active facility.",
    inclusions: Array.from(
      { length: 8 },
      (_, index) =>
        `Included phase ${index + 1}: labor, hauling, cleanup, and disposal documentation.`,
    ),
    exclusions: [
      "Hazardous or regulated materials",
      "Work outside the documented service area",
      "Unapproved change-order work",
    ],
    assumptions: [
      "Clear service access during the agreed arrival window",
      "Customer-provided loading-zone authorization",
      "Materials match the supplied scope evidence",
    ],
    pricing: {
      documentType: "fixed_quote",
      currency: "USD",
      lineItems: [
        ...baseLines,
        {
          id: "liftgate",
          name: "Liftgate support",
          description: "Additional liftgate handling for heavy material.",
          quantity: 1,
          unit: "service",
          unitPriceMinCents: 25_000,
          unitPriceMaxCents: 25_000,
          optionGroupId: "extras",
          displayOrder: 10,
        },
        {
          id: "extra-haul",
          name: "Additional haul",
          description: "One additional documented disposal haul.",
          quantity: 1,
          unit: "haul",
          unitPriceMinCents: 45_000,
          unitPriceMaxCents: 45_000,
          optionGroupId: "extras",
          displayOrder: 11,
        },
      ],
      optionGroups: [
        {
          id: "extras",
          label: "Optional site support",
          mode: "multiple",
          minimumSelections: 0,
          maximumSelections: 2,
        },
      ],
      adjustments: [
        {
          id: "bundle-discount",
          kind: "discount",
          label: "Approved bundle discount",
          calculation: "percentage",
          basis: "subtotal",
          eligibleLineItemIds: [],
          basisPoints: 500,
          displayOrder: 0,
        },
        {
          id: "travel-fee",
          kind: "travel",
          label: "Confirmed travel charge",
          calculation: "fixed",
          basis: "subtotal",
          eligibleLineItemIds: [],
          amountCents: 12_500,
          displayOrder: 1,
        },
      ],
      deposit: { mode: "fixed", amountCents: 75_000 },
    },
    terms: {
      templateVersion: "commercial-v1",
      terms:
        "This fixed proposal applies only to the documented scope and selected options.",
      paymentTerms: "The stated deposit is due after approval.",
      changeOrderRules:
        "Additional work requires written scope and price approval before service.",
      validityDays: 30,
      consentVersion: "fixed-v1",
    },
    estimatedDurationMinutes: 480,
    serviceZoneId: "atlanta-commercial",
    serviceZoneConfirmed: true,
  });
  const renderInput: QuoteRenderInput = {
    quoteId: "10000000-0000-4000-8000-000000000001",
    versionId: "20000000-0000-4000-8000-000000000001",
    quoteNumber: "QV2-PERFORMANCE-STANDARD",
    versionNumber: 1,
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    document,
    selectedOptionIds: ["extra-haul", "liftgate"],
    attachments: [
      {
        id: "30000000-0000-4000-8000-000000000001",
        fileName: "site-plan.pdf",
        caption: "Customer-approved loading plan",
        mediaType: "application/pdf",
        displayOrder: 0,
      },
      {
        id: "30000000-0000-4000-8000-000000000002",
        fileName: "loading-area.webp",
        caption: "Loading-area scope evidence",
        mediaType: "image/webp",
        displayOrder: 1,
      },
    ],
  };
  const renderModel = buildQuoteRenderModel(renderInput);
  const totals = calculateQuoteV2Totals(
    document.pricing,
    renderModel.totals.selectedOptionIds,
  );
  const publicRow: QuoteV2PublicCapabilitySnapshot = {
    capabilityId: "40000000-0000-4000-8000-000000000001",
    capabilityStatus: "active",
    recipientRole: "signer",
    allowedActions: ["view", "pdf", "change", "accept", "decline"],
    readExpiresAt: new Date("2027-09-01T12:00:00.000Z"),
    actionExpiresAt: EXPIRES_AT,
    revokedAt: null,
    quoteId: renderModel.quoteId,
    quoteNumber: renderModel.quoteNumber,
    aggregateState: "open",
    aggregateRevision: 2,
    currentVersionId: renderModel.versionId,
    publishedVersionId: renderModel.versionId,
    acceptedAppointmentId: null,
    opportunityId: "50000000-0000-4000-8000-000000000001",
    opportunityStatus: "open",
    contactId: "60000000-0000-4000-8000-000000000001",
    contactDeletedAt: null,
    versionId: renderModel.versionId,
    versionNumber: renderModel.versionNumber,
    versionState: "issued",
    documentSnapshot: document,
    selectedOptionIds: renderModel.totals.selectedOptionIds,
    subtotalMinCents: totals.subtotalMinCents,
    subtotalMaxCents: totals.subtotalMaxCents,
    discountMinCents: totals.discountMinCents,
    discountMaxCents: totals.discountMaxCents,
    feeMinCents: totals.feeMinCents,
    feeMaxCents: totals.feeMaxCents,
    totalMinCents: totals.totalMinCents,
    totalMaxCents: totals.totalMaxCents,
    depositCents: totals.depositCents,
    balanceMinCents: totals.balanceMinCents,
    balanceMaxCents: totals.balanceMaxCents,
    contentHash: renderModel.contentHash,
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    proposalPdfHash: "a".repeat(64),
    hasOpenChangeRequest: false,
    hasTerminalResponse: false,
    depositCaptured: false,
    depositRequiresStaffScheduling: false,
    acceptedResponseId: null,
    appointment: null,
    attachments: renderModel.attachments.map((attachment) => ({
      id: attachment.id,
      purpose: "scope_evidence" as const,
      caption: attachment.caption ?? null,
      fileName: attachment.fileName,
      mediaType: attachment.mediaType,
      displayOrder: attachment.displayOrder,
    })),
  };
  const canonicalPublicValue = canonicalQuoteV2PublicValue(
    buildQuoteV2PublicEnvelope(publicRow, PERFORMANCE_NOW),
  );
  return {
    now: new Date(PERFORMANCE_NOW),
    renderInput,
    renderModel,
    publicRow,
    canonicalPublicValue,
  };
}
