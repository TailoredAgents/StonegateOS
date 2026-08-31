import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import {
  getDb,
  partnerDocuments,
  partnerInvoices,
  partnerQuotes,
  partnerStatements,
} from "@/db";
import {
  encodePortalV2Cursor,
  parsePortalV2Pagination,
  parsePortalV2Rfc3339,
} from "@/lib/portal-v2-contract";
import { isPortalV2Uuid } from "@/lib/partner-portal-v2-security";

type CommercialFormat = "json" | "csv";
type CommercialCursor = {
  accountId: string;
  filter: string | null;
  lastAt: string;
  lastId: string;
};

export type PartnerCommercialListResult =
  | {
      ok: true;
      format: CommercialFormat;
      resource: string;
      items: Array<Record<string, unknown>>;
      limit: number;
      nextCursor: string | null;
      csv: string;
      summary?: Array<Record<string, unknown>>;
    }
  | {
      ok: false;
      error: "invalid_cursor" | "invalid_fields" | "service_unavailable";
      status: number;
      fieldErrors?: Record<string, string>;
    };

const QUOTE_STATUSES = new Set([
  "draft",
  "sent",
  "accepted",
  "declined",
  "expired",
  "superseded",
]);
const INVOICE_STATUSES = new Set([
  "draft",
  "issued",
  "partially_paid",
  "paid",
  "overdue",
  "void",
]);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const CURRENCY_PATTERN = /^[A-Z]{3}$/u;

function safeText(value: string | null, maximum = 240): string | null {
  if (value === null) return null;
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const safe = [...normalized]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 32 && codePoint !== 127;
    })
    .join("");
  return safe.slice(0, maximum) || null;
}

function safeFilename(value: string): string {
  const basename = value.normalize("NFKC").split(/[\\/]/u).pop() ?? "document";
  return safeText(basename, 240) ?? "document";
}

function money(amountMinor: number, currency: string) {
  if (!Number.isSafeInteger(amountMinor) || !CURRENCY_PATTERN.test(currency)) {
    throw new TypeError("partner_commercial_money_invalid");
  }
  return { amountMinor, currency, minorUnit: 2 };
}

function exactCursorPayload(
  value: unknown,
  accountId: string,
  filter: string | null,
  validateLastAt: (value: string) => boolean,
): value is CommercialCursor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).sort().join(",") === "accountId,filter,lastAt,lastId" &&
    record["accountId"] === accountId &&
    record["filter"] === filter &&
    typeof record["lastAt"] === "string" &&
    validateLastAt(record["lastAt"]) &&
    isPortalV2Uuid(record["lastId"])
  );
}

function parseFormat(params: URLSearchParams): CommercialFormat | null {
  const values = params.getAll("format");
  if (values.length === 0) return "json";
  if (values.length !== 1 || !["json", "csv"].includes(values[0] ?? "")) {
    return null;
  }
  return values[0] as CommercialFormat;
}

function parseFilter(input: {
  params: URLSearchParams;
  name: "status" | "currency" | "type";
  validate: (value: string) => boolean;
}): string | null | undefined {
  const values = input.params.getAll(input.name);
  if (values.length === 0) return null;
  const value = values[0]?.trim() ?? "";
  return values.length === 1 && input.validate(value) ? value : undefined;
}

function parseOptions(input: {
  params: URLSearchParams;
  accountId: string;
  cursorKind: string;
  filterName: "status" | "currency" | "type";
  validateFilter: (value: string) => boolean;
  validateLastAt?: (value: string) => boolean;
}):
  | {
      ok: true;
      format: CommercialFormat;
      filter: string | null;
      limit: number;
      cursor: CommercialCursor | null;
    }
  | Extract<PartnerCommercialListResult, { ok: false }> {
  const format = parseFormat(input.params);
  const filter = parseFilter({
    params: input.params,
    name: input.filterName,
    validate: input.validateFilter,
  });
  if (!format || filter === undefined) {
    return {
      ok: false,
      error: "invalid_fields",
      status: 422,
      fieldErrors: {
        query: "Use one supported filter and format=json or format=csv.",
      },
    };
  }
  const validateLastAt =
    input.validateLastAt ??
    ((value) => {
      const parsed = parsePortalV2Rfc3339(value);
      return parsed !== null && parsed.toISOString() === value;
    });
  const pagination = parsePortalV2Pagination(input.params, {
    cursorKind: input.cursorKind,
    validateCursorPayload: (value): value is CommercialCursor =>
      exactCursorPayload(value, input.accountId, filter, validateLastAt),
    allowedQueryKeys: new Set(["format", input.filterName]),
  });
  if (!pagination.ok) {
    return {
      ok: false,
      error: pagination.fieldErrors["cursor"]
        ? "invalid_cursor"
        : "invalid_fields",
      status: 422,
      fieldErrors: { ...pagination.fieldErrors },
    };
  }
  return {
    ok: true,
    format,
    filter,
    limit: pagination.limit,
    cursor: pagination.cursor?.payload ?? null,
  };
}

function nextCursor(input: {
  kind: string;
  limit: number;
  accountId: string;
  filter: string | null;
  lastAt: string;
  lastId: string;
  hasMore: boolean;
}): string | null {
  return input.hasMore
    ? encodePortalV2Cursor({
        kind: input.kind,
        limit: input.limit,
        payload: {
          accountId: input.accountId,
          filter: input.filter,
          lastAt: input.lastAt,
          lastId: input.lastId,
        } satisfies CommercialCursor,
      })
    : null;
}

function csvText(value: unknown): string {
  let text = "";
  if (typeof value === "string") text = value;
  else if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    text = String(value);
  } else if (value !== null && value !== undefined) {
    throw new TypeError("partner_commercial_csv_value_invalid");
  }
  const protectedText = /^[=+\-@\t\r]/u.test(text) ? `'${text}` : text;
  return `"${protectedText.replace(/"/gu, '""')}"`;
}

export function createPartnerCommercialCsv(
  columns: readonly string[],
  rows: readonly (readonly unknown[])[],
): string {
  return [
    columns.map(csvText).join(","),
    ...rows.map((row) => row.map(csvText).join(",")),
  ].join("\r\n");
}

export async function listPartnerQuotes(input: {
  accountId: string;
  params: URLSearchParams;
}): Promise<PartnerCommercialListResult> {
  const kind = "commercial.quotes";
  const options = parseOptions({
    params: input.params,
    accountId: input.accountId,
    cursorKind: kind,
    filterName: "status",
    validateFilter: (value) => QUOTE_STATUSES.has(value),
  });
  if (!options.ok) return options;
  const cursorAt = options.cursor ? new Date(options.cursor.lastAt) : null;
  const rows = await getDb()
    .select({
      id: partnerQuotes.id,
      bookingId: partnerQuotes.partnerBookingId,
      bookingDraftId: partnerQuotes.bookingDraftId,
      quoteNumber: partnerQuotes.quoteNumber,
      version: partnerQuotes.version,
      status: partnerQuotes.status,
      currency: partnerQuotes.currency,
      subtotalCents: partnerQuotes.subtotalCents,
      taxCents: partnerQuotes.taxCents,
      discountCents: partnerQuotes.discountCents,
      totalCents: partnerQuotes.totalCents,
      lines: partnerQuotes.lines,
      expiresAt: partnerQuotes.expiresAt,
      sentAt: partnerQuotes.sentAt,
      acceptedAt: partnerQuotes.acceptedAt,
      declinedAt: partnerQuotes.declinedAt,
      supersededAt: partnerQuotes.supersededAt,
      documentId: partnerQuotes.documentId,
      createdAt: partnerQuotes.createdAt,
      updatedAt: partnerQuotes.updatedAt,
    })
    .from(partnerQuotes)
    .where(
      and(
        eq(partnerQuotes.partnerAccountId, input.accountId),
        options.filter ? eq(partnerQuotes.status, options.filter) : undefined,
        cursorAt && options.cursor
          ? or(
              lt(partnerQuotes.createdAt, cursorAt),
              and(
                eq(partnerQuotes.createdAt, cursorAt),
                lt(partnerQuotes.id, options.cursor.lastId),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(partnerQuotes.createdAt), desc(partnerQuotes.id))
    .limit(options.limit + 1);
  const page = rows.slice(0, options.limit);
  const items = page.map((row) => ({
    id: row.id,
    quoteNumber: safeText(row.quoteNumber, 120),
    version: row.version,
    status: row.status,
    bookingId: row.bookingId,
    bookingDraftId: row.bookingDraftId,
    amounts: {
      subtotal: money(row.subtotalCents, row.currency),
      tax: money(row.taxCents, row.currency),
      discount: money(row.discountCents, row.currency),
      total: money(row.totalCents, row.currency),
    },
    lineCount: Math.min(
      Array.isArray(row.lines) ? row.lines.length : 0,
      10_000,
    ),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    sentAt: row.sentAt?.toISOString() ?? null,
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    declinedAt: row.declinedAt?.toISOString() ?? null,
    supersededAt: row.supersededAt?.toISOString() ?? null,
    documentId: row.documentId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
  const last = page.at(-1);
  return {
    ok: true,
    format: options.format,
    resource: "quotes",
    items,
    limit: options.limit,
    nextCursor: last
      ? nextCursor({
          kind,
          limit: options.limit,
          accountId: input.accountId,
          filter: options.filter,
          lastAt: last.createdAt.toISOString(),
          lastId: last.id,
          hasMore: rows.length > options.limit,
        })
      : null,
    csv: createPartnerCommercialCsv(
      [
        "quote_number",
        "version",
        "status",
        "currency",
        "subtotal_minor",
        "tax_minor",
        "discount_minor",
        "total_minor",
        "line_count",
        "created_at",
      ],
      page.map((row) => [
        safeText(row.quoteNumber, 120),
        row.version,
        row.status,
        row.currency,
        row.subtotalCents,
        row.taxCents,
        row.discountCents,
        row.totalCents,
        Array.isArray(row.lines) ? row.lines.length : 0,
        row.createdAt.toISOString(),
      ]),
    ),
  };
}

export async function listPartnerInvoices(input: {
  accountId: string;
  params: URLSearchParams;
}): Promise<PartnerCommercialListResult> {
  const kind = "commercial.invoices";
  const options = parseOptions({
    params: input.params,
    accountId: input.accountId,
    cursorKind: kind,
    filterName: "status",
    validateFilter: (value) => INVOICE_STATUSES.has(value),
  });
  if (!options.ok) return options;
  const cursorAt = options.cursor ? new Date(options.cursor.lastAt) : null;
  const rows = await getDb()
    .select({
      id: partnerInvoices.id,
      bookingId: partnerInvoices.partnerBookingId,
      invoiceNumber: partnerInvoices.invoiceNumber,
      status: partnerInvoices.status,
      currency: partnerInvoices.currency,
      subtotalCents: partnerInvoices.subtotalCents,
      taxCents: partnerInvoices.taxCents,
      discountCents: partnerInvoices.discountCents,
      depositCents: partnerInvoices.depositCents,
      totalCents: partnerInvoices.totalCents,
      paidCents: partnerInvoices.paidCents,
      balanceCents: partnerInvoices.balanceCents,
      poNumber: partnerInvoices.poNumber,
      costCenter: partnerInvoices.costCenter,
      dueDate: partnerInvoices.dueDate,
      issuedAt: partnerInvoices.issuedAt,
      paidAt: partnerInvoices.paidAt,
      voidedAt: partnerInvoices.voidedAt,
      documentId: partnerInvoices.documentId,
      version: partnerInvoices.version,
      createdAt: partnerInvoices.createdAt,
      updatedAt: partnerInvoices.updatedAt,
    })
    .from(partnerInvoices)
    .where(
      and(
        eq(partnerInvoices.partnerAccountId, input.accountId),
        options.filter ? eq(partnerInvoices.status, options.filter) : undefined,
        cursorAt && options.cursor
          ? or(
              lt(partnerInvoices.createdAt, cursorAt),
              and(
                eq(partnerInvoices.createdAt, cursorAt),
                lt(partnerInvoices.id, options.cursor.lastId),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(partnerInvoices.createdAt), desc(partnerInvoices.id))
    .limit(options.limit + 1);
  const page = rows.slice(0, options.limit);
  const items = page.map((row) => ({
    id: row.id,
    invoiceNumber: safeText(row.invoiceNumber, 120),
    status: row.status,
    bookingId: row.bookingId,
    poNumber: safeText(row.poNumber, 120),
    costCenter: safeText(row.costCenter, 120),
    amounts: {
      subtotal: money(row.subtotalCents, row.currency),
      tax: money(row.taxCents, row.currency),
      discount: money(row.discountCents, row.currency),
      deposit: money(row.depositCents, row.currency),
      total: money(row.totalCents, row.currency),
      paid: money(row.paidCents, row.currency),
      balance: money(row.balanceCents, row.currency),
    },
    dueDate: row.dueDate,
    issuedAt: row.issuedAt?.toISOString() ?? null,
    paidAt: row.paidAt?.toISOString() ?? null,
    voidedAt: row.voidedAt?.toISOString() ?? null,
    documentId: row.documentId,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
  const last = page.at(-1);
  return {
    ok: true,
    format: options.format,
    resource: "invoices",
    items,
    limit: options.limit,
    nextCursor: last
      ? nextCursor({
          kind,
          limit: options.limit,
          accountId: input.accountId,
          filter: options.filter,
          lastAt: last.createdAt.toISOString(),
          lastId: last.id,
          hasMore: rows.length > options.limit,
        })
      : null,
    csv: createPartnerCommercialCsv(
      [
        "invoice_number",
        "status",
        "currency",
        "subtotal_minor",
        "tax_minor",
        "discount_minor",
        "deposit_minor",
        "total_minor",
        "paid_minor",
        "balance_minor",
        "po_number",
        "cost_center",
        "due_date",
        "issued_at",
      ],
      page.map((row) => [
        safeText(row.invoiceNumber, 120),
        row.status,
        row.currency,
        row.subtotalCents,
        row.taxCents,
        row.discountCents,
        row.depositCents,
        row.totalCents,
        row.paidCents,
        row.balanceCents,
        safeText(row.poNumber, 120),
        safeText(row.costCenter, 120),
        row.dueDate,
        row.issuedAt?.toISOString() ?? null,
      ]),
    ),
  };
}

export async function listPartnerStatements(input: {
  accountId: string;
  params: URLSearchParams;
  cursorKind?: string;
  resource?: "statements" | "reports";
}): Promise<PartnerCommercialListResult> {
  const kind = input.cursorKind ?? "commercial.statements";
  const options = parseOptions({
    params: input.params,
    accountId: input.accountId,
    cursorKind: kind,
    filterName: "currency",
    validateFilter: (value) => CURRENCY_PATTERN.test(value),
    validateLastAt: (value) => DATE_PATTERN.test(value),
  });
  if (!options.ok) return options;
  const rows = await getDb()
    .select()
    .from(partnerStatements)
    .where(
      and(
        eq(partnerStatements.partnerAccountId, input.accountId),
        options.filter
          ? eq(partnerStatements.currency, options.filter)
          : undefined,
        options.cursor
          ? or(
              lt(partnerStatements.periodEnd, options.cursor.lastAt),
              and(
                eq(partnerStatements.periodEnd, options.cursor.lastAt),
                lt(partnerStatements.id, options.cursor.lastId),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(partnerStatements.periodEnd), desc(partnerStatements.id))
    .limit(options.limit + 1);
  const page = rows.slice(0, options.limit);
  const items = page.map((row) => ({
    id: row.id,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    amounts: {
      openingBalance: money(row.openingBalanceCents, row.currency),
      invoices: money(row.invoiceCents, row.currency),
      payments: money(row.paymentCents, row.currency),
      refunds: money(row.refundCents, row.currency),
      credits: money(row.creditCents, row.currency),
      closingBalance: money(row.closingBalanceCents, row.currency),
    },
    documentId: row.documentId,
    generatedAt: row.generatedAt.toISOString(),
  }));
  const last = page.at(-1);
  return {
    ok: true,
    format: options.format,
    resource: input.resource ?? "statements",
    items,
    limit: options.limit,
    nextCursor: last
      ? nextCursor({
          kind,
          limit: options.limit,
          accountId: input.accountId,
          filter: options.filter,
          lastAt: last.periodEnd,
          lastId: last.id,
          hasMore: rows.length > options.limit,
        })
      : null,
    csv: createPartnerCommercialCsv(
      [
        "period_start",
        "period_end",
        "currency",
        "opening_balance_minor",
        "invoice_minor",
        "payment_minor",
        "refund_minor",
        "credit_minor",
        "closing_balance_minor",
        "generated_at",
      ],
      page.map((row) => [
        row.periodStart,
        row.periodEnd,
        row.currency,
        row.openingBalanceCents,
        row.invoiceCents,
        row.paymentCents,
        row.refundCents,
        row.creditCents,
        row.closingBalanceCents,
        row.generatedAt.toISOString(),
      ]),
    ),
  };
}

export async function listPartnerDocuments(input: {
  accountId: string;
  params: URLSearchParams;
}): Promise<PartnerCommercialListResult> {
  const kind = "commercial.documents";
  const options = parseOptions({
    params: input.params,
    accountId: input.accountId,
    cursorKind: kind,
    filterName: "type",
    validateFilter: (value) => /^[a-z][a-z0-9_.-]{0,79}$/u.test(value),
  });
  if (!options.ok) return options;
  const cursorAt = options.cursor ? new Date(options.cursor.lastAt) : null;
  const rows = await getDb()
    .select({
      id: partnerDocuments.id,
      bookingId: partnerDocuments.partnerBookingId,
      documentType: partnerDocuments.documentType,
      version: partnerDocuments.version,
      filename: partnerDocuments.filename,
      contentType: partnerDocuments.contentType,
      byteSize: partnerDocuments.byteSize,
      generatedAt: partnerDocuments.generatedAt,
      createdAt: partnerDocuments.createdAt,
    })
    .from(partnerDocuments)
    .where(
      and(
        eq(partnerDocuments.partnerAccountId, input.accountId),
        options.filter
          ? eq(partnerDocuments.documentType, options.filter)
          : undefined,
        cursorAt && options.cursor
          ? or(
              lt(partnerDocuments.generatedAt, cursorAt),
              and(
                eq(partnerDocuments.generatedAt, cursorAt),
                lt(partnerDocuments.id, options.cursor.lastId),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(partnerDocuments.generatedAt), desc(partnerDocuments.id))
    .limit(options.limit + 1);
  const page = rows.slice(0, options.limit);
  const items = page.map((row) => ({
    id: row.id,
    bookingId: row.bookingId,
    documentType: safeText(row.documentType, 80),
    version: row.version,
    filename: safeFilename(row.filename),
    contentType: safeText(row.contentType, 100),
    byteSize: row.byteSize,
    generatedAt: row.generatedAt.toISOString(),
  }));
  const last = page.at(-1);
  return {
    ok: true,
    format: options.format,
    resource: "documents",
    items,
    limit: options.limit,
    nextCursor: last
      ? nextCursor({
          kind,
          limit: options.limit,
          accountId: input.accountId,
          filter: options.filter,
          lastAt: last.generatedAt.toISOString(),
          lastId: last.id,
          hasMore: rows.length > options.limit,
        })
      : null,
    csv: createPartnerCommercialCsv(
      [
        "document_type",
        "version",
        "filename",
        "content_type",
        "byte_size",
        "generated_at",
      ],
      page.map((row) => [
        safeText(row.documentType, 80),
        row.version,
        safeFilename(row.filename),
        safeText(row.contentType, 100),
        row.byteSize,
        row.generatedAt.toISOString(),
      ]),
    ),
  };
}

function safeAggregate(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(numeric)) {
    throw new TypeError("partner_report_aggregate_invalid");
  }
  return numeric;
}

export async function listPartnerReports(input: {
  accountId: string;
  params: URLSearchParams;
}): Promise<PartnerCommercialListResult> {
  const statements = await listPartnerStatements({
    ...input,
    cursorKind: "commercial.reports",
    resource: "reports",
  });
  if (!statements.ok) return statements;
  const currencyValues = input.params.getAll("currency");
  const currency = currencyValues.length === 1 ? currencyValues[0] : null;
  const aggregates = await getDb()
    .select({
      currency: partnerInvoices.currency,
      invoiceCount: sql<string>`count(*)::text`,
      totalCents: sql<string>`coalesce(sum(${partnerInvoices.totalCents}), 0)::text`,
      paidCents: sql<string>`coalesce(sum(${partnerInvoices.paidCents}), 0)::text`,
      balanceCents: sql<string>`coalesce(sum(${partnerInvoices.balanceCents}), 0)::text`,
    })
    .from(partnerInvoices)
    .where(
      and(
        eq(partnerInvoices.partnerAccountId, input.accountId),
        currency ? eq(partnerInvoices.currency, currency) : undefined,
      ),
    )
    .groupBy(partnerInvoices.currency)
    .orderBy(partnerInvoices.currency);
  const summary = aggregates.map((row) => ({
    currency: row.currency,
    invoiceCount: safeAggregate(row.invoiceCount),
    total: money(safeAggregate(row.totalCents), row.currency),
    paid: money(safeAggregate(row.paidCents), row.currency),
    balance: money(safeAggregate(row.balanceCents), row.currency),
  }));
  const items = statements.items.map((statement) => ({
    reportType: "statement_summary",
    ...statement,
  }));
  return {
    ...statements,
    resource: "reports",
    items,
    summary,
  };
}
