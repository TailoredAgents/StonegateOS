import "server-only";
import { z } from "zod";
import { callPartnerApi } from "./api";
import {
  loadPartnerPortalResource,
  portalLoadErrorMessage,
} from "./portal-load";
const nullableText = z.string().max(200).nullable();
const choice = z.object({
  id: z.string().max(100),
  label: z.string().max(200),
});
const minor = z.number().int().nonnegative().safe();
const reportSchema = z.object({
  ok: z.literal(true),
  kind: z.enum(["operational", "financial"]),
  asOf: z.string().datetime(),
  timezone: z.string().max(64),
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/u),
  count: z.number().int().min(0).max(5000),
  filters: z
    .object({ from: z.string().date(), to: z.string().date() })
    .passthrough(),
  items: z
    .array(
      z.object({
        id: z.string().uuid(),
        jobId: z.string().uuid().nullable(),
        date: z.string().datetime(),
        locationId: z.string().uuid().nullable(),
        location: z.string().max(200),
        service: nullableText,
        status: nullableText,
        requesterId: z.string().uuid().nullable(),
        requester: nullableText,
        po: nullableText,
        costCenter: nullableText,
        proof: z.enum(["complete", "missing", "not_required"]),
        financial: z
          .object({
            number: z.string().max(120),
            status: z.string().max(40),
            currency: z.string().regex(/^[A-Z]{3}$/u),
            totalMinor: minor,
            paidMinor: minor,
            creditedMinor: minor,
            balanceMinor: minor,
          })
          .optional(),
      }),
    )
    .max(100),
  summary: z
    .array(
      z.object({
        currency: z.string().regex(/^[A-Z]{3}$/u),
        invoices: minor,
        totalMinor: minor,
        paidMinor: minor,
        creditedMinor: minor,
        balanceMinor: minor,
      }),
    )
    .max(100),
  permissions: z.object({
    export: z.boolean(),
    operational: z.boolean(),
    financial: z.boolean(),
  }),
  page: z.object({
    limit: z.number().int().min(1).max(100),
    nextCursor: z.string().max(8192).nullable(),
    hasMore: z.boolean(),
  }),
  options: z.object({
    locations: z.array(choice).max(5000),
    requesters: z.array(choice).max(5000),
    services: z.array(choice).max(5000),
  }),
});
export type PartnerServiceReportView = z.infer<typeof reportSchema>;
export async function loadPartnerServiceReport(
  params: URLSearchParams,
): Promise<
  | { report: PartnerServiceReportView; error: null }
  | { report: null; error: string }
> {
  const result = await loadPartnerPortalResource(
    () =>
      callPartnerApi(`/api/portal/v2/reports?${params}`, { timeoutMs: 20_000 }),
    (payload) => {
      const parsed = reportSchema.safeParse(payload);
      if (
        !parsed.success ||
        (parsed.data.kind === "operational" &&
          (parsed.data.summary.length > 0 ||
            parsed.data.items.some((row) => row.financial)))
      )
        return null;
      return parsed.data;
    },
  );
  if (result.status === "ok") return { report: result.value, error: null };
  const message =
    result.reason === "invalid_response"
      ? "The report could not be verified. Try again before relying on its totals."
      : result.code === "report_changed" || result.code === "invalid_cursor"
        ? "The report has changed or this page link has expired. Open the first page to see current records."
        : result.code === "report_too_large"
          ? "This report contains too many records. Choose a shorter date range."
          : result.code === "invalid_fields"
            ? "Check the report dates and filters, then try again."
            : "The complete report could not be loaded. Please try again.";
  return { report: null, error: portalLoadErrorMessage(result, message) };
}
