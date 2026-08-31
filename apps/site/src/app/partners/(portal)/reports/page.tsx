import type { Metadata } from "next";
import { BarChart3, CalendarRange, FileSpreadsheet } from "lucide-react";
import { PartnerReportExportButton } from "@/app/partners/components/PartnerReportExportButton";
import {
  PartnerEmptyState,
  PartnerNotice,
  PartnerPageHeader,
  PartnerPanel,
  PartnerStatCard,
} from "@/app/partners/components/PartnerPortalUi";
import {
  formatPartnerDate,
  formatPartnerMoney,
  isPartnerReportSummary,
  isPartnerStatement,
  loadPartnerCommercial,
} from "@/app/partners/lib/portal-commercial";

export const metadata: Metadata = { title: "Reports" };

export default async function PartnerReportsPage() {
  const reports = await loadPartnerCommercial("reports", "reports", isPartnerStatement);
  const readyReports = reports.status === "ready" ? reports : null;
  const summary =
    readyReports
      ? readyReports.summary.filter(isPartnerReportSummary)
      : [];

  return (
    <div className="space-y-5 sm:space-y-6">
      <PartnerPageHeader
        eyebrow="Account financial activity"
        title="Reports"
        description="Review invoice totals and generated period summaries by currency. These reports are account-scoped and separate from job estimates."
        actions={readyReports ? <PartnerReportExportButton /> : undefined}
        breadcrumbs={[
          { label: "Overview", href: "/partners" },
          { label: "Reports", href: "/partners/reports" },
        ]}
      />

      {reports.status === "forbidden" ? (
        <PartnerPanel>
          <PartnerEmptyState
            title="Reports are not included in your role"
            description="Ask an account administrator for report access, or contact Stonegate for a specific statement."
            action={{ href: "/partners/help", label: "Contact Stonegate" }}
            icon={<BarChart3 className="h-6 w-6" aria-hidden="true" />}
          />
        </PartnerPanel>
      ) : reports.status === "unavailable" ? (
        <PartnerPanel>
          <PartnerEmptyState
            title="Account reports are not available yet"
            description="No totals have been estimated or substituted. Use Billing & documents for available invoices and statements, or contact Stonegate for a report."
            action={{ href: "/partners/billing", label: "Open billing records" }}
            icon={<FileSpreadsheet className="h-6 w-6" aria-hidden="true" />}
          />
        </PartnerPanel>
      ) : reports.status === "error" ? (
        <PartnerPanel>
          <PartnerNotice tone="error">
            We could not load a complete account report. Refresh this page before relying on any totals.
          </PartnerNotice>
        </PartnerPanel>
      ) : !readyReports ? null : readyReports.items.length === 0 && summary.length === 0 ? (
        <PartnerPanel>
          <PartnerEmptyState
            title="No report activity yet"
            description="Account summaries will appear after invoices or statement periods are recorded."
            action={{ href: "/partners/book", label: "Schedule a job" }}
            icon={<BarChart3 className="h-6 w-6" aria-hidden="true" />}
          />
        </PartnerPanel>
      ) : (
        <>
          {summary.length ? (
            <section aria-labelledby="partner-report-summary-heading">
              <div className="mb-3 flex items-center gap-2">
                <BarChart3 className="h-5 w-5 text-primary-700" aria-hidden="true" />
                <h2 id="partner-report-summary-heading" className="text-lg font-semibold text-slate-950">Invoice summary by currency</h2>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {summary.flatMap((item) => [
                  <PartnerStatCard key={`${item.currency}-count`} label={`${item.currency} invoices`} value={item.invoiceCount} />,
                  <PartnerStatCard key={`${item.currency}-total`} label={`${item.currency} invoiced`} value={formatPartnerMoney(item.total)} />,
                  <PartnerStatCard key={`${item.currency}-paid`} label={`${item.currency} paid`} value={formatPartnerMoney(item.paid)} />,
                  <PartnerStatCard key={`${item.currency}-balance`} label={`${item.currency} balance`} value={formatPartnerMoney(item.balance)} detail="Read-only account balance" />,
                ])}
              </div>
            </section>
          ) : (
            <PartnerNotice tone="warning">
              Period reports are available, but the account invoice summary was not returned. No total has been inferred.
            </PartnerNotice>
          )}

          <PartnerPanel>
            <div className="flex items-start gap-3">
              <CalendarRange className="mt-0.5 h-5 w-5 shrink-0 text-primary-700" aria-hidden="true" />
              <div>
                <h2 className="font-semibold text-slate-950">Period summaries</h2>
                <p className="mt-1 text-sm leading-6 text-slate-600">Generated statement activity for the latest account periods.</p>
              </div>
            </div>
            {readyReports.items.length ? (
              <ul className="mt-5 grid gap-3 lg:grid-cols-2">
                {readyReports.items.map((report) => (
                  <li key={report.id} className="rounded-2xl border border-slate-200 bg-slate-50/60 p-4">
                    <p className="font-semibold text-slate-950">{formatPartnerDate(report.periodStart)} – {formatPartnerDate(report.periodEnd)}</p>
                    <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
                      <div><dt className="text-slate-500">Invoices</dt><dd className="mt-1 font-semibold text-slate-950">{formatPartnerMoney(report.amounts.invoices)}</dd></div>
                      <div><dt className="text-slate-500">Payments</dt><dd className="mt-1 font-semibold text-slate-950">{formatPartnerMoney(report.amounts.payments)}</dd></div>
                      <div><dt className="text-slate-500">Credits</dt><dd className="mt-1 text-slate-800">{formatPartnerMoney(report.amounts.credits)}</dd></div>
                      <div><dt className="text-slate-500">Closing balance</dt><dd className="mt-1 text-slate-800">{formatPartnerMoney(report.amounts.closingBalance)}</dd></div>
                    </dl>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-5 text-sm leading-6 text-slate-600">No statement periods have been generated yet.</p>
            )}
            {readyReports.page.hasMore ? (
              <PartnerNotice tone="info" className="mt-4">
                This page shows the 100 latest periods. Export the report or contact Stonegate for older history.
              </PartnerNotice>
            ) : null}
          </PartnerPanel>

          <PartnerNotice tone="info">
            Report totals come from account invoices and statements. They are not payment receipts, tax advice, or a substitute for the issued document.
          </PartnerNotice>
        </>
      )}
    </div>
  );
}
