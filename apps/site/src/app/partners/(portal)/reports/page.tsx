import type { Metadata } from "next";
import Link from "next/link";
import { PartnerReportExportButton } from "@/app/partners/components/PartnerReportExportButton";
import { PartnerCollectionPagination } from "@/app/partners/components/PartnerCollectionPagination";
import {
  PartnerNotice,
  PartnerPageHeader,
  PartnerPanel,
  partnerPrimaryButtonClass,
  partnerSecondaryButtonClass,
} from "@/app/partners/components/PartnerPortalUi";
import { getPartnerPortalContext } from "@/app/partners/lib/portal-context";
import { loadPartnerServiceReport } from "@/app/partners/lib/portal-service-reports";
export const metadata: Metadata = { title: "Reports" };
const inputClass =
  "min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-700";
const labels = { operational: "Job report", financial: "Billing report" };
const money = (minor: number, currency: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
    minor / 100,
  );
const friendly = (value: string | null) => value?.replace(/_/gu, " ") ?? "—";
const filterKeys = [
  "kind",
  "from",
  "to",
  "locationId",
  "service",
  "status",
  "requesterId",
  "po",
  "costCenter",
  "proof",
  "financialStatus",
  "currency",
  "cursor",
];
export default async function PartnerReportsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [raw, context] = await Promise.all([
    searchParams,
    getPartnerPortalContext(),
  ]);
  if (context.status !== "authenticated" || !context.availability.reads)
    return null;
  if (!context.capabilities.reports || context.tools?.["reports"] !== true)
    return (
      <div className="space-y-5">
        <PartnerPageHeader
          title="Reports"
          description="View job and billing records shared with your role."
        />
        <PartnerNotice tone="info">
          {!context.capabilities.reports
            ? "Your role does not include reports. Ask your company administrator for access."
            : "Reports are turned off for your company. Contact Stonegate if you need a report."}
        </PartnerNotice>
      </div>
    );
  const params: Record<string, string> = {};
  for (const key of filterKeys)
    if (
      typeof raw?.[key] === "string" &&
      raw[key].length <= (key === "cursor" ? 8192 : 200) &&
      raw[key]
    )
      params[key] = raw[key];
  const mayOperational =
    context.status === "authenticated" &&
    context.permissions.readOperationalReports === true;
  const mayFinancial =
    context.status === "authenticated" &&
    context.permissions.readFinancialReports === true;
  params["kind"] ??= mayOperational ? "operational" : "financial";
  const { report, error } = await loadPartnerServiceReport(
    new URLSearchParams(params),
  );
  const kind =
    report?.kind ??
    (params["kind"] === "financial" ? "financial" : "operational");
  const from = report?.filters.from ?? params["from"] ?? "";
  const to = report?.filters.to ?? params["to"] ?? "";
  const exportParams = new URLSearchParams({ ...params, from, to });
  exportParams.delete("cursor");
  const select = (
    name: string,
    title: string,
    choices: Array<{ id: string; label: string }>,
  ) => (
    <label className="space-y-1 text-sm font-medium" key={name}>
      {title}
      <select
        name={name}
        defaultValue={params[name] ?? ""}
        className={inputClass}
      >
        <option value="">All</option>
        {choices.map((choice) => (
          <option key={choice.id} value={choice.id}>
            {choice.label}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <div className="space-y-5">
      <PartnerPageHeader
        title="Reports"
        description="Find the job or billing records you need. Downloads contain one complete snapshot of your selected records."
        breadcrumbs={[
          { label: "Home", href: "/partners/overview" },
          { label: "Reports", href: "/partners/reports" },
        ]}
        actions={
          report?.permissions.export ? (
            <PartnerReportExportButton query={exportParams.toString()} />
          ) : undefined
        }
      />
      <PartnerPanel>
        <form action="/partners/reports" className="space-y-4">
          <input type="hidden" name="kind" value={kind} />
          <nav aria-label="Report type" className="flex flex-wrap gap-2">
            {mayOperational ? (
              <Link
                href="/partners/reports?kind=operational"
                className={
                  kind === "operational"
                    ? partnerPrimaryButtonClass
                    : partnerSecondaryButtonClass
                }
                aria-current={kind === "operational" ? "page" : undefined}
              >
                Job report
              </Link>
            ) : null}
            {mayFinancial ? (
              <Link
                href="/partners/reports?kind=financial"
                className={
                  kind === "financial"
                    ? partnerPrimaryButtonClass
                    : partnerSecondaryButtonClass
                }
                aria-current={kind === "financial" ? "page" : undefined}
              >
                Billing report
              </Link>
            ) : null}
          </nav>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm font-medium">
              From
              <input
                name="from"
                type="date"
                defaultValue={from}
                className={inputClass}
                required
              />
            </label>
            <label className="space-y-1 text-sm font-medium">
              Through
              <input
                name="to"
                type="date"
                defaultValue={to}
                className={inputClass}
                required
              />
            </label>
          </div>
          <p className="text-sm text-slate-600">
            {kind === "financial"
              ? "Billing dates use the invoice issue date."
              : "Job dates use the arrival date, or the request date when no visit is confirmed."}{" "}
            Dates are shown in Eastern time.
          </p>
          <details className="rounded-lg border border-slate-200 px-3">
            <summary className="min-h-11 cursor-pointer py-3 text-sm font-semibold">
              More filters
            </summary>
            <div className="grid gap-3 pb-4 sm:grid-cols-2 lg:grid-cols-3">
              {select(
                "locationId",
                "Location",
                report?.options.locations ?? [],
              )}
              {select(
                "service",
                "Service",
                (report?.options.services ?? []).map((s) => ({
                  ...s,
                  label: friendly(s.label),
                })),
              )}
              {select(
                "requesterId",
                "Requested by",
                report?.options.requesters ?? [],
              )}
              {select(
                "status",
                "Job status",
                [
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
                ].map((id) => ({ id, label: friendly(id) })),
              )}
              {select("proof", "Proof", [
                { id: "complete", label: "Complete" },
                { id: "missing", label: "Still needed" },
                { id: "not_required", label: "Not required" },
              ])}
              <label className="space-y-1 text-sm font-medium">
                Purchase order
                <input
                  name="po"
                  defaultValue={params["po"]}
                  maxLength={160}
                  className={inputClass}
                />
              </label>
              <label className="space-y-1 text-sm font-medium">
                Cost center
                <input
                  name="costCenter"
                  defaultValue={params["costCenter"]}
                  maxLength={160}
                  className={inputClass}
                />
              </label>
              {kind === "financial"
                ? select(
                    "financialStatus",
                    "Invoice status",
                    ["issued", "partially_paid", "paid", "overdue", "void"].map(
                      (id) => ({ id, label: friendly(id) }),
                    ),
                  )
                : null}
              {kind === "financial" ? (
                <label className="space-y-1 text-sm font-medium">
                  Currency
                  <input
                    name="currency"
                    defaultValue={params["currency"]}
                    placeholder="All currencies"
                    pattern="[A-Z]{3}"
                    maxLength={3}
                    className={inputClass}
                  />
                </label>
              ) : null}
            </div>
          </details>
          <div className="flex flex-wrap gap-2">
            <button className={partnerPrimaryButtonClass} type="submit">
              Apply filters
            </button>
            <Link
              className={partnerSecondaryButtonClass}
              href={`/partners/reports?kind=${kind}`}
            >
              Clear filters
            </Link>
          </div>
        </form>
      </PartnerPanel>
      {error ? (
        <PartnerNotice tone="warning">
          {error}{" "}
          <Link
            href={`/partners/reports?${exportParams}`}
            className="underline"
          >
            Open the first page
          </Link>{" "}
          ·{" "}
          <Link href="/partners/help" className="underline">
            Contact Stonegate
          </Link>
        </PartnerNotice>
      ) : null}
      {report ? (
        <PartnerPanel>
          <h2 className="text-lg font-semibold">
            {labels[report.kind]} · {report.count}{" "}
            {report.count === 1 ? "record" : "records"}
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Snapshot{" "}
            {new Intl.DateTimeFormat("en-US", {
              dateStyle: "medium",
              timeStyle: "short",
              timeZone: report.timezone,
            }).format(new Date(report.asOf))}
            .{" "}
            {report.kind === "financial"
              ? "Net paid includes settled payments less refunds. Credits reduce the amount owed. Voided invoices are excluded from totals."
              : "This report contains job information only, without billing amounts."}
          </p>
          {report.summary.map((s) => (
            <p
              className="mt-3 border-y border-slate-200 py-3 text-sm"
              key={s.currency}
            >
              {s.currency} · Invoiced {money(s.totalMinor, s.currency)} · Net
              paid {money(s.paidMinor, s.currency)} · Credits{" "}
              {money(s.creditedMinor, s.currency)} · Balance{" "}
              {money(s.balanceMinor, s.currency)}
            </p>
          ))}
          <ul className="divide-y divide-slate-200">
            {report.items.map((row) => (
              <li key={row.id} className="space-y-2 py-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <h3 className="font-semibold">
                    {row.jobId ? (
                      <Link
                        href={`/partners/bookings/${row.jobId}`}
                        className="underline decoration-slate-300 underline-offset-4"
                      >
                        {row.location}
                      </Link>
                    ) : (
                      row.location
                    )}{" "}
                    · {friendly(row.service)}
                  </h3>
                  <span className="text-sm text-slate-600">
                    {new Intl.DateTimeFormat("en-US", {
                      dateStyle: "medium",
                      timeZone: report.timezone,
                    }).format(new Date(row.date))}
                  </span>
                </div>
                <p className="text-sm text-slate-600">
                  {friendly(row.status)} · Proof:{" "}
                  {row.proof === "missing"
                    ? "still needed"
                    : friendly(row.proof)}
                  {row.requester ? ` · Requested by ${row.requester}` : ""}
                </p>
                {row.po || row.costCenter ? (
                  <p className="break-words text-sm text-slate-600">
                    PO: {row.po ?? "—"} · Cost center: {row.costCenter ?? "—"}
                  </p>
                ) : null}
                {row.financial ? (
                  <div className="text-sm">
                    <p className="break-words">
                      {row.financial.number} · {friendly(row.financial.status)}
                    </p>
                    <p className="mt-1">
                      Total{" "}
                      {money(row.financial.totalMinor, row.financial.currency)}{" "}
                      · Net paid{" "}
                      {money(row.financial.paidMinor, row.financial.currency)} ·
                      Credits{" "}
                      {money(
                        row.financial.creditedMinor,
                        row.financial.currency,
                      )}{" "}
                      · Balance{" "}
                      {money(
                        row.financial.balanceMinor,
                        row.financial.currency,
                      )}
                    </p>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
          {!report.items.length ? (
            <p className="py-5 text-slate-600">
              No records match these filters.
            </p>
          ) : null}
          <PartnerCollectionPagination
            basePath="/partners/reports"
            cursorKey="cursor"
            nextCursor={report.page.nextCursor}
            params={{ ...params, from, to }}
            label="records"
          />
        </PartnerPanel>
      ) : null}
    </div>
  );
}
