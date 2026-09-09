import React from "react";
import type * as ReactPDF from "@react-pdf/renderer";
import type { PartnerServiceReport } from "@/lib/partner-service-reports";
const styles = {
  page: {
    padding: 36,
    fontFamily: "Helvetica",
    fontSize: 9,
    lineHeight: 1.4,
    color: "#1f2937",
  },
  title: { fontSize: 20, marginBottom: 8, color: "#173f2b" },
  meta: { color: "#475569", marginBottom: 8 },
  row: { borderBottom: "1 solid #cbd5e1", paddingVertical: 9 },
  name: { fontSize: 11, marginBottom: 3 },
  footer: {
    position: "absolute",
    left: 36,
    right: 36,
    bottom: 16,
    fontSize: 7,
    color: "#475569",
  },
} satisfies Parameters<typeof ReactPDF.StyleSheet.create>[0];
const money = (amount: number, currency: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
    amount / 100,
  );
export async function renderPartnerServiceReportPdf(
  report: PartnerServiceReport,
): Promise<Buffer> {
  const { Document, Page, Text, View, renderToBuffer } = await import(
    "@react-pdf/renderer"
  );
  if (report.items.length !== report.count || report.items.length > 1_000)
    throw new Error("partner_report_pdf_too_large");
  return renderToBuffer(
    <Document
      title={`Stonegate ${report.kind === "financial" ? "billing" : "job"} report`}
      author="Stonegate Junk Removal"
      creator="Stonegate"
      producer="Stonegate"
      creationDate={new Date(report.asOf)}
      modificationDate={new Date(report.asOf)}
    >
      <Page size="LETTER" style={styles.page}>
        <Text style={styles.title}>
          {report.kind === "financial" ? "Billing report" : "Job report"}
        </Text>
        <Text style={styles.meta}>
          Stonegate Junk Removal · {report.filters.from} through{" "}
          {report.filters.to} · {report.count} records
        </Text>
        <Text style={styles.meta}>
          Snapshot: {report.asOf} · Display timezone: {report.timezone}
        </Text>
        {Object.entries(report.filters)
          .filter(([k]) => !["kind", "format", "from", "to"].includes(k))
          .map(([key, value]) => (
            <Text key={key} style={styles.meta}>
              {key}: {value}
            </Text>
          ))}
        {report.summary.map((s) => (
          <Text key={s.currency} style={styles.meta}>
            {s.currency}: invoiced {money(s.totalMinor, s.currency)} · net paid{" "}
            {money(s.paidMinor, s.currency)} · credits{" "}
            {money(s.creditedMinor, s.currency)} · balance{" "}
            {money(s.balanceMinor, s.currency)}
          </Text>
        ))}
        {report.items.map((r) => (
          <View key={r.id} style={styles.row} wrap={false}>
            <Text style={styles.name}>
              {r.location} · {r.service?.replace(/_/gu, " ") ?? "Service"}
            </Text>
            <Text>
              {new Intl.DateTimeFormat("en-US", {
                dateStyle: "medium",
                timeZone: report.timezone,
              }).format(new Date(r.date))}{" "}
              · {r.status?.replace(/_/gu, " ") ?? "Job"} · proof{" "}
              {r.proof.replace(/_/gu, " ")}
            </Text>
            {r.jobId ? <Text>Job: {r.jobId}</Text> : null}
            {r.requester ? <Text>Requested by: {r.requester}</Text> : null}
            {r.po || r.costCenter ? (
              <Text>
                PO: {r.po ?? "—"} · cost center: {r.costCenter ?? "—"}
              </Text>
            ) : null}
            {r.financial ? (
              <Text>
                {r.financial.number} · {r.financial.status.replace(/_/gu, " ")}{" "}
                · total {money(r.financial.totalMinor, r.financial.currency)} ·
                net paid {money(r.financial.paidMinor, r.financial.currency)} ·
                credits {money(r.financial.creditedMinor, r.financial.currency)}{" "}
                · balance{" "}
                {money(r.financial.balanceMinor, r.financial.currency)}
              </Text>
            ) : null}
          </View>
        ))}
        {!report.items.length ? <Text>No matching records.</Text> : null}
        <Text
          style={styles.footer}
          fixed
          render={({ pageNumber, totalPages }) =>
            `Stonegate · sales@stonegatejunkremoval.com · 404-777-2631 · ${pageNumber}/${totalPages}`
          }
        />
      </Page>
    </Document>,
  );
}
