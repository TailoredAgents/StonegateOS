import { createHash } from "node:crypto";
import { DateTime } from "luxon";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  getDb,
  mediaAssets,
  partnerAccountCostCenters,
  partnerAccountLocations,
  partnerAccountMemberships,
  partnerBookings,
  partnerEvidenceRequirements,
  partnerInvoices,
  partnerJobEvidence,
  partnerUsers,
} from "@/db";
import type { PartnerPrincipal } from "@/lib/partner-account-authorization";
import { effectivePartnerInvoiceStatusSql } from "@/lib/partner-invoice-status";
import {
  createPartnerInvoiceAccessCondition,
  createPartnerCommercialCsv,
} from "@/lib/partner-portal-v2-commercial";
import {
  createPartnerJobAccessCondition,
  createPartnerJobLocationJoinCondition,
  partnerJobAccessScopeKey,
} from "@/lib/partner-portal-v2-resource-authorization";
import {
  encodePortalV2Cursor,
  parsePortalV2Pagination,
} from "@/lib/portal-v2-contract";

const ZONE = "America/New_York";
const MAX_ROWS = 5_000;
const CATEGORIES = [
  "intake",
  "before",
  "after",
  "completion",
  "issue",
  "document",
] as const;
const STATUS = [
  "requested",
  "requested_review",
  "approval_needed",
  "under_review",
  "confirmed",
  "en_route",
  "in_progress",
  "completed",
  "canceled",
  "declined",
  "approved_needs_reschedule",
] as const;
const querySchema = z
  .object({
    kind: z.enum(["operational", "financial"]).default("operational"),
    format: z.enum(["json", "csv", "pdf"]).default("json"),
    from: z.string().date().optional(),
    to: z.string().date().optional(),
    locationId: z.string().uuid().optional(),
    requesterId: z.string().uuid().optional(),
    service: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[a-zA-Z0-9_-]+$/u)
      .optional(),
    status: z.enum(STATUS).optional(),
    po: z.string().trim().min(1).max(160).optional(),
    costCenter: z.string().trim().min(1).max(160).optional(),
    proof: z.enum(["complete", "missing", "not_required"]).optional(),
    financialStatus: z
      .enum(["issued", "partially_paid", "paid", "overdue", "void"])
      .optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/u)
      .optional(),
  })
  .strict();
export type PartnerServiceReportFilters = z.infer<typeof querySchema> & {
  from: string;
  to: string;
};
type Access = Pick<
  PartnerPrincipal,
  "accountId" | "accessLevel" | "accessScope"
>;
type Cursor = {
  accountId: string;
  accessKey: string;
  filterHash: string;
  snapshotHash: string;
  offset: number;
  asOf: string;
};
export type PartnerServiceReportRow = {
  id: string;
  jobId: string | null;
  date: string;
  locationId: string | null;
  location: string;
  service: string | null;
  status: string | null;
  requesterId: string | null;
  requester: string | null;
  po: string | null;
  costCenter: string | null;
  proof: "complete" | "missing" | "not_required";
  financial?: {
    number: string;
    status: string;
    currency: string;
    totalMinor: number;
    paidMinor: number;
    creditedMinor: number;
    balanceMinor: number;
  };
};
export class PartnerReportError extends Error {
  constructor(
    public readonly code:
      | "invalid_fields"
      | "invalid_cursor"
      | "report_changed"
      | "report_too_large",
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function text(value: string | null | undefined, max = 160): string | null {
  return (
    value
      ?.normalize("NFKC")
      .split("")
      .map((character) => {
        const code = character.charCodeAt(0);
        return code <= 31 || code === 127 ? " " : character;
      })
      .join("")
      .trim()
      .slice(0, max) || null
  );
}
export function parsePartnerServiceReportQuery(
  params: URLSearchParams,
  now = new Date(),
) {
  const source: Record<string, string> = {};
  for (const [key, value] of params) {
    if (key === "limit" || key === "cursor") continue;
    if (key in source)
      throw new PartnerReportError(
        "invalid_fields",
        422,
        "Use each filter only once.",
      );
    source[key] = value;
  }
  const parsed = querySchema.safeParse(source);
  if (!parsed.success)
    throw new PartnerReportError(
      "invalid_fields",
      422,
      "Choose supported report filters and valid dates.",
    );
  const today = DateTime.fromJSDate(now).setZone(ZONE).startOf("day");
  const from = parsed.data.from ?? today.minus({ days: 90 }).toISODate()!;
  const to = parsed.data.to ?? today.plus({ days: 30 }).toISODate()!;
  const start = DateTime.fromISO(from, { zone: ZONE }).startOf("day");
  const end = DateTime.fromISO(to, { zone: ZONE })
    .plus({ days: 1 })
    .startOf("day");
  if (
    !start.isValid ||
    !end.isValid ||
    end <= start ||
    end.diff(start, "days").days > 366
  )
    throw new PartnerReportError(
      "invalid_fields",
      422,
      "Choose a date range of no more than 366 days.",
    );
  if (
    parsed.data.kind === "operational" &&
    (parsed.data.financialStatus || parsed.data.currency)
  )
    throw new PartnerReportError(
      "invalid_fields",
      422,
      "Financial filters are only available on a billing report.",
    );
  if (parsed.data.format !== "json" && params.has("cursor"))
    throw new PartnerReportError(
      "invalid_fields",
      422,
      "Exports include the complete filtered snapshot. Remove the page cursor.",
    );
  return {
    filters: { ...parsed.data, from, to } as PartnerServiceReportFilters,
    start: start.toJSDate(),
    end: end.toJSDate(),
  };
}

/** All export rows come from one bounded repeatable-read transaction, never
 * from piecemeal page totals. A changed list snapshot rejects its old cursor. */
export async function readPartnerServiceReport(input: {
  accountId: string;
  access: Access;
  params: URLSearchParams;
}) {
  if (input.access.accountId !== input.accountId)
    throw new PartnerReportError("invalid_fields", 404, "Report not found.");
  const { filters, start, end } = parsePartnerServiceReportQuery(input.params);
  const filterHash = digest({ ...filters, format: undefined });
  const accessKey = partnerJobAccessScopeKey(input.access);
  const paging = parsePortalV2Pagination(input.params, {
    cursorKind: "service.reports",
    defaultLimit: 25,
    maximumLimit: 100,
    allowedQueryKeys: new Set(Object.keys(querySchema.shape)),
    validateCursorPayload(value): value is Cursor {
      const c = value as Cursor | null;
      return (
        !!c &&
        typeof c === "object" &&
        Object.keys(c).sort().join(",") ===
          "accessKey,accountId,asOf,filterHash,offset,snapshotHash" &&
        c.accountId === input.accountId &&
        c.accessKey === accessKey &&
        c.filterHash === filterHash &&
        Number.isSafeInteger(c.offset) &&
        c.offset >= 0 &&
        c.offset <= MAX_ROWS &&
        typeof c.snapshotHash === "string" &&
        /^[a-f0-9]{64}$/u.test(c.snapshotHash) &&
        typeof c.asOf === "string" &&
        Number.isFinite(Date.parse(c.asOf)) &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(c.asOf) &&
        new Date(c.asOf).toISOString() === `${c.asOf.slice(0, 23)}Z` &&
        Date.parse(c.asOf) <= Date.now() + 5_000
      );
    },
  });
  if (!paging.ok)
    throw new PartnerReportError(
      "invalid_cursor",
      422,
      "The report page is invalid. Open the first page again.",
    );
  const cursor = paging.cursor?.payload ?? null;
  let asOf = cursor?.asOf ?? "";
  const financial = filters.kind === "financial";
  const result = await getDb().transaction(
    async (tx) => {
      if (!asOf) {
        // PostgreSQL writes have microsecond precision. A JS millisecond
        // boundary can hide a just-committed job within the same millisecond.
        const clock = await tx.execute<{ as_of: string }>(sql`select
          to_char(transaction_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as as_of`);
        asOf = clock[0]!.as_of;
      }
      const columns = {
        jobId: partnerBookings.id,
        locationId: partnerAccountLocations.id,
        location: partnerAccountLocations.siteName,
        service: sql<string>`coalesce(nullif(${partnerBookings.scopeSnapshot}->>'serviceLabel',''),${partnerBookings.serviceKey},'Service request')`,
        status: partnerBookings.publicStatus,
        requesterId: partnerBookings.requestedByMembershipId,
        requester: partnerUsers.name,
        proofSnapshot: partnerBookings.proofRequirementsSnapshot,
      };
      const date = financial
        ? sql<Date>`coalesce(${partnerInvoices.issuedAt}, ${partnerInvoices.createdAt})`
        : sql<Date>`coalesce(${partnerBookings.arrivalWindowStartAt}, ${partnerBookings.createdAt})`;
      const po = financial
        ? partnerInvoices.poNumber
        : partnerBookings.poNumber;
      const center = financial
        ? partnerInvoices.costCenter
        : partnerBookings.costCenter;
      const conditions = and(
        financial
          ? eq(partnerInvoices.partnerAccountId, input.accountId)
          : eq(partnerBookings.partnerAccountId, input.accountId),
        financial
          ? createPartnerInvoiceAccessCondition(input.access)
          : createPartnerJobAccessCondition(input.access),
        sql`${date} >= ${start.toISOString()}::timestamptz and ${date} < ${end.toISOString()}::timestamptz`,
        sql`${financial ? partnerInvoices.createdAt : partnerBookings.createdAt} <= ${asOf}::timestamptz`,
        filters.locationId
          ? eq(partnerAccountLocations.id, filters.locationId)
          : undefined,
        filters.requesterId
          ? eq(partnerBookings.requestedByMembershipId, filters.requesterId)
          : undefined,
        filters.service
          ? or(
              eq(partnerBookings.serviceKey, filters.service),
              sql`exists(select 1 from partner_booking_service_lines line where line.partner_account_id=${partnerBookings.partnerAccountId} and line.partner_booking_id=${partnerBookings.id} and line.service_key=${filters.service})`,
            )
          : undefined,
        filters.status
          ? eq(partnerBookings.publicStatus, filters.status)
          : undefined,
        filters.po ? eq(po, filters.po) : undefined,
        filters.costCenter ? eq(center, filters.costCenter) : undefined,
        financial
          ? inArray(
              effectivePartnerInvoiceStatusSql(asOf),
              filters.financialStatus
                ? [filters.financialStatus]
                : ["issued", "partially_paid", "paid", "overdue", "void"],
            )
          : undefined,
        financial && filters.currency
          ? eq(partnerInvoices.currency, filters.currency)
          : undefined,
      );
      const locationJoin = createPartnerJobLocationJoinCondition();
      const memberJoin = and(
        eq(
          partnerAccountMemberships.id,
          partnerBookings.requestedByMembershipId,
        ),
        eq(partnerAccountMemberships.partnerAccountId, input.accountId),
      );
      const rows = financial
        ? await tx
            .select({
              ...columns,
              id: partnerInvoices.id,
              date,
              po,
              costCenter: center,
              number: partnerInvoices.invoiceNumber,
              invoiceStatus: effectivePartnerInvoiceStatusSql(asOf),
              currency: partnerInvoices.currency,
              total: partnerInvoices.totalCents,
              paid: partnerInvoices.paidCents,
              credited: partnerInvoices.creditedCents,
              balance: partnerInvoices.balanceCents,
            })
            .from(partnerInvoices)
            .leftJoin(
              partnerBookings,
              and(
                eq(partnerBookings.id, partnerInvoices.partnerBookingId),
                eq(partnerBookings.partnerAccountId, input.accountId),
              ),
            )
            .leftJoin(partnerAccountLocations, locationJoin)
            .leftJoin(partnerAccountMemberships, memberJoin)
            .leftJoin(
              partnerUsers,
              eq(partnerUsers.id, partnerAccountMemberships.partnerUserId),
            )
            .leftJoin(
              partnerAccountCostCenters,
              and(
                eq(partnerAccountCostCenters.partnerAccountId, input.accountId),
                eq(partnerAccountCostCenters.code, partnerInvoices.costCenter),
              ),
            )
            .where(conditions)
            .orderBy(desc(date), desc(partnerInvoices.id))
            .limit(MAX_ROWS + 1)
        : await tx
            .select({
              ...columns,
              id: partnerBookings.id,
              date,
              po,
              costCenter: center,
              number: sql<null>`null`,
              invoiceStatus: sql<null>`null`,
              currency: sql<null>`null`,
              total: sql<null>`null`,
              paid: sql<null>`null`,
              credited: sql<null>`null`,
              balance: sql<null>`null`,
            })
            .from(partnerBookings)
            .leftJoin(partnerAccountLocations, locationJoin)
            .leftJoin(partnerAccountMemberships, memberJoin)
            .leftJoin(
              partnerUsers,
              eq(partnerUsers.id, partnerAccountMemberships.partnerUserId),
            )
            .where(conditions)
            .orderBy(desc(date), desc(partnerBookings.id))
            .limit(MAX_ROWS + 1);
      if (rows.length > MAX_ROWS)
        throw new PartnerReportError(
          "report_too_large",
          422,
          "Choose a shorter date range or a location. A complete report can include up to 5,000 records.",
        );
      const jobIds = [
        ...new Set(rows.flatMap((row) => (row.jobId ? [row.jobId] : []))),
      ];
      const requirements = await tx
        .select({
          jobId: partnerEvidenceRequirements.partnerBookingId,
          category: partnerEvidenceRequirements.category,
          required: partnerEvidenceRequirements.required,
          count: partnerEvidenceRequirements.minimumCount,
        })
        .from(partnerEvidenceRequirements)
        .where(
          and(
            eq(partnerEvidenceRequirements.partnerAccountId, input.accountId),
            or(
              isNull(partnerEvidenceRequirements.partnerBookingId),
              jobIds.length
                ? inArray(partnerEvidenceRequirements.partnerBookingId, jobIds)
                : sql`false`,
            ),
          ),
        );
      const counts = jobIds.length
        ? await tx
            .select({
              jobId: partnerJobEvidence.partnerBookingId,
              category: partnerJobEvidence.category,
              count: sql<number>`count(*)::int`,
            })
            .from(partnerJobEvidence)
            .innerJoin(
              mediaAssets,
              eq(mediaAssets.id, partnerJobEvidence.mediaAssetId),
            )
            .where(
              and(
                eq(partnerJobEvidence.partnerAccountId, input.accountId),
                eq(mediaAssets.partnerAccountId, input.accountId),
                inArray(partnerJobEvidence.partnerBookingId, jobIds),
                isNull(partnerJobEvidence.deletedAt),
                isNull(mediaAssets.deletedAt),
                eq(mediaAssets.status, "ready"),
                sql`(${partnerJobEvidence.category} <> 'document' OR ${mediaAssets.sourceMetadata}->>'scanStatus' = 'clean')`,
              ),
            )
            .groupBy(
              partnerJobEvidence.partnerBookingId,
              partnerJobEvidence.category,
            )
        : [];
      const requirementMap = new Map(
        requirements.map((r) => [`${r.jobId ?? "account"}:${r.category}`, r]),
      );
      const countMap = new Map(
        counts.map((r) => [`${r.jobId}:${r.category}`, r.count]),
      );
      const items: PartnerServiceReportRow[] = rows
        .map((r) => {
          let required = false,
            missing = false;
          for (const category of CATEGORIES) {
            const override =
              requirementMap.get(`${r.jobId}:${category}`) ??
              requirementMap.get(`account:${category}`);
            const snap = r.proofSnapshot?.[category];
            const minimum = override
              ? override.required
                ? override.count
                : 0
              : snap === true
                ? 1
                : typeof snap === "number" &&
                    Number.isSafeInteger(snap) &&
                    snap >= 0 &&
                    snap <= 40
                  ? snap
                  : 0;
            if (minimum > 0 && r.jobId) {
              required = true;
              if ((countMap.get(`${r.jobId}:${category}`) ?? 0) < minimum)
                missing = true;
            }
          }
          const item: PartnerServiceReportRow = {
            id: r.id,
            jobId: r.jobId,
            date: new Date(r.date).toISOString(),
            locationId: r.locationId,
            location: text(r.location) ?? "Job location",
            service: text(r.service),
            status: text(r.status),
            requesterId: r.requesterId,
            requester: text(r.requester),
            po: text(r.po),
            costCenter: text(r.costCenter),
            proof: missing ? "missing" : required ? "complete" : "not_required",
          };
          if (
            financial &&
            r.number &&
            r.invoiceStatus &&
            r.currency &&
            r.total !== null &&
            r.paid !== null &&
            r.credited !== null &&
            r.balance !== null
          ) {
            item.financial = {
              number: text(r.number, 120)!,
              status: r.invoiceStatus,
              currency: r.currency,
              totalMinor: r.total,
              paidMinor: r.paid,
              creditedMinor: r.credited,
              balanceMinor: r.balance,
            };
          }
          return item;
        })
        .filter((row) => !filters.proof || row.proof === filters.proof);
      return items;
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
  const snapshotHash = digest(result);
  if (cursor && cursor.snapshotHash !== snapshotHash)
    throw new PartnerReportError(
      "report_changed",
      409,
      "These records changed. Open the first page or download a new complete snapshot.",
    );
  const summaries = new Map<
    string,
    {
      currency: string;
      invoices: number;
      totalMinor: number;
      paidMinor: number;
      creditedMinor: number;
      balanceMinor: number;
    }
  >();
  for (const row of result)
    if (row.financial && row.financial.status !== "void") {
      const f = row.financial,
        s = summaries.get(f.currency) ?? {
          currency: f.currency,
          invoices: 0,
          totalMinor: 0,
          paidMinor: 0,
          creditedMinor: 0,
          balanceMinor: 0,
        };
      s.invoices += 1;
      s.totalMinor += f.totalMinor;
      s.paidMinor += f.paidMinor;
      s.creditedMinor += f.creditedMinor;
      s.balanceMinor += f.balanceMinor;
      if (
        Object.values(s).some(
          (value) => typeof value === "number" && !Number.isSafeInteger(value),
        )
      )
        throw new Error("partner_report_aggregate_invalid");
      summaries.set(f.currency, s);
    }
  const offset = cursor?.offset ?? 0;
  const items =
    filters.format === "json"
      ? result.slice(offset, offset + paging.limit)
      : result;
  const nextOffset = offset + items.length;
  const nextCursor =
    filters.format === "json" && nextOffset < result.length
      ? encodePortalV2Cursor({
          kind: "service.reports",
          limit: paging.limit,
          payload: {
            accountId: input.accountId,
            accessKey,
            filterHash,
            snapshotHash,
            offset: nextOffset,
            asOf,
          } satisfies Cursor,
        })
      : null;
  const choices = (
    key: "locationId" | "requesterId" | "service",
    label: "location" | "requester" | "service",
  ) =>
    [
      ...new Map(
        result.flatMap((row) =>
          row[key]
            ? [
                [
                  row[key],
                  { id: row[key], label: row[label] ?? row[key] },
                ] as const,
              ]
            : [],
        ),
      ).values(),
    ].sort((a, b) => a.label.localeCompare(b.label));
  return {
    kind: filters.kind,
    filters,
    items,
    summary: [...summaries.values()],
    count: result.length,
    asOf,
    snapshotHash,
    timezone: ZONE,
    page: { limit: paging.limit, nextCursor, hasMore: nextCursor !== null },
    options: {
      locations: choices("locationId", "location"),
      requesters: choices("requesterId", "requester"),
      services: choices("service", "service"),
    },
  };
}
export type PartnerServiceReport = Awaited<
  ReturnType<typeof readPartnerServiceReport>
>;
export function partnerServiceReportCsv(report: PartnerServiceReport): string {
  const financial = report.kind === "financial";
  return createPartnerCommercialCsv(
    [
      "job_id",
      "date_utc",
      "display_timezone",
      "location",
      "service",
      "job_status",
      "requested_by",
      "po",
      "cost_center",
      "proof_state",
      ...(financial
        ? [
            "invoice_number",
            "invoice_status",
            "currency",
            "total_minor",
            "net_paid_minor",
            "credited_minor",
            "balance_minor",
          ]
        : []),
    ],
    report.items.map((r) =>
      [
        r.jobId,
        r.date,
        report.timezone,
        r.location,
        r.service,
        r.status,
        r.requester,
        r.po,
        r.costCenter,
        r.proof,
        ...(financial
          ? [
              r.financial?.number,
              r.financial?.status,
              r.financial?.currency,
              r.financial?.totalMinor,
              r.financial?.paidMinor,
              r.financial?.creditedMinor,
              r.financial?.balanceMinor,
            ]
          : []),
      ].map((v) => v ?? null),
    ),
  );
}
