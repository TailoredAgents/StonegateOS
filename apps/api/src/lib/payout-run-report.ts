import { and, asc, eq, gte, lt } from "drizzle-orm";
import type { DatabaseClient } from "@/db";
import {
  appointmentCommissions,
  appointments,
  contacts,
  payoutRunAdjustments,
  payoutRuns,
  properties,
  teamMembers,
} from "@/db";

type PayoutRunRecord = {
  id: string;
  timezone: string;
  periodStart: Date;
  periodEnd: Date;
  scheduledPayoutAt: Date;
  status: "draft" | "locked" | "paid";
  createdAt: Date;
  lockedAt: Date | null;
  paidAt: Date | null;
  reportHtml: string | null;
  reportGeneratedAt: Date | null;
};

type CommissionDetailRow = {
  memberId: string | null;
  memberName: string | null;
  role: "sales" | "marketing" | "crew";
  amountCents: number;
  baseCents: number;
  appointmentId: string;
  scheduledAt: Date | null;
  completedAt: Date | null;
  collectedCents: number | null;
  contactFirstName: string | null;
  contactLastName: string | null;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
};

type AdjustmentDetailRow = {
  memberId: string | null;
  memberName: string | null;
  amountCents: number;
  note: string | null;
  createdAt: Date;
};

type PayoutRunMemberSummary = {
  memberKey: string;
  memberId: string | null;
  memberName: string;
  salesCents: number;
  marketingCents: number;
  crewCents: number;
  adjustmentsCents: number;
  totalCents: number;
  commissionDetails: CommissionDetailRow[];
  adjustmentDetails: AdjustmentDetailRow[];
};

export type PayoutRunReportData = {
  run: PayoutRunRecord;
  generatedAt: Date;
  memberSummaries: PayoutRunMemberSummary[];
  totalCents: number;
  commissionDetailCount: number;
  adjustmentCount: number;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtMoney(cents: number): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

function fmtWhen(date: Date | null, timezone: string): string {
  if (!date) return "Not set";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatContactName(
  firstName: string | null,
  lastName: string | null,
): string {
  const value = [firstName, lastName]
    .map((part) => (part ?? "").trim())
    .filter((part) => part.length > 0)
    .join(" ");
  return value.length > 0 ? value : "Unknown customer";
}

function formatAddress(row: {
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
}): string {
  const value = [row.addressLine1, row.city, row.state, row.postalCode]
    .map((part) => (part ?? "").trim())
    .filter((part) => part.length > 0)
    .join(", ");
  return value.length > 0 ? value : "Address unavailable";
}

function formatRoleLabel(role: CommissionDetailRow["role"]): string {
  if (role === "sales") return "Sales";
  if (role === "marketing") return "Marketing";
  return "Crew";
}

function toMemberKey(
  memberId: string | null,
  memberName: string | null,
): string {
  if (memberId) return `member:${memberId}`;
  return `unknown:${memberName ?? "unknown"}`;
}

async function getPayoutRunRecord(
  db: DatabaseClient,
  payoutRunId: string,
): Promise<PayoutRunRecord | null> {
  const [run] = await db
    .select({
      id: payoutRuns.id,
      timezone: payoutRuns.timezone,
      periodStart: payoutRuns.periodStart,
      periodEnd: payoutRuns.periodEnd,
      scheduledPayoutAt: payoutRuns.scheduledPayoutAt,
      status: payoutRuns.status,
      createdAt: payoutRuns.createdAt,
      lockedAt: payoutRuns.lockedAt,
      paidAt: payoutRuns.paidAt,
      reportHtml: payoutRuns.reportHtml,
      reportGeneratedAt: payoutRuns.reportGeneratedAt,
    })
    .from(payoutRuns)
    .where(eq(payoutRuns.id, payoutRunId))
    .limit(1);

  return run ?? null;
}

export async function calculatePayoutRunLiveTotalCents(
  db: DatabaseClient,
  run: Pick<PayoutRunRecord, "id" | "periodStart" | "periodEnd">,
): Promise<number> {
  const commissionRows = await db
    .select({
      amountCents: appointmentCommissions.amountCents,
    })
    .from(appointmentCommissions)
    .innerJoin(
      appointments,
      eq(appointmentCommissions.appointmentId, appointments.id),
    )
    .where(
      and(
        gte(appointments.completedAt, run.periodStart),
        lt(appointments.completedAt, run.periodEnd),
        eq(appointments.status, "completed"),
      ),
    );

  const adjustmentRows = await db
    .select({
      amountCents: payoutRunAdjustments.amountCents,
    })
    .from(payoutRunAdjustments)
    .where(eq(payoutRunAdjustments.payoutRunId, run.id));

  const commissionTotal = commissionRows.reduce(
    (sum, row) => sum + Number(row.amountCents ?? 0),
    0,
  );
  const adjustmentTotal = adjustmentRows.reduce(
    (sum, row) => sum + Number(row.amountCents ?? 0),
    0,
  );
  return commissionTotal + adjustmentTotal;
}

export async function buildPayoutRunReportData(
  db: DatabaseClient,
  payoutRunId: string,
): Promise<PayoutRunReportData> {
  const run = await getPayoutRunRecord(db, payoutRunId);
  if (!run) {
    throw new Error("payout_run_not_found");
  }

  const [commissionRows, adjustmentRows] = await Promise.all([
    db
      .select({
        memberId: appointmentCommissions.memberId,
        memberName: teamMembers.name,
        role: appointmentCommissions.role,
        amountCents: appointmentCommissions.amountCents,
        baseCents: appointmentCommissions.baseCents,
        appointmentId: appointments.id,
        scheduledAt: appointments.startAt,
        completedAt: appointments.completedAt,
        collectedCents: appointments.finalTotalCents,
        contactFirstName: contacts.firstName,
        contactLastName: contacts.lastName,
        addressLine1: properties.addressLine1,
        city: properties.city,
        state: properties.state,
        postalCode: properties.postalCode,
      })
      .from(appointmentCommissions)
      .innerJoin(
        appointments,
        eq(appointmentCommissions.appointmentId, appointments.id),
      )
      .leftJoin(
        teamMembers,
        eq(appointmentCommissions.memberId, teamMembers.id),
      )
      .leftJoin(contacts, eq(appointments.contactId, contacts.id))
      .leftJoin(properties, eq(appointments.propertyId, properties.id))
      .where(
        and(
          gte(appointments.completedAt, run.periodStart),
          lt(appointments.completedAt, run.periodEnd),
          eq(appointments.status, "completed"),
        ),
      )
      .orderBy(
        asc(teamMembers.name),
        asc(appointments.completedAt),
        asc(contacts.lastName),
        asc(contacts.firstName),
      ),
    db
      .select({
        memberId: payoutRunAdjustments.memberId,
        memberName: teamMembers.name,
        amountCents: payoutRunAdjustments.amountCents,
        note: payoutRunAdjustments.note,
        createdAt: payoutRunAdjustments.createdAt,
      })
      .from(payoutRunAdjustments)
      .leftJoin(teamMembers, eq(payoutRunAdjustments.memberId, teamMembers.id))
      .where(eq(payoutRunAdjustments.payoutRunId, payoutRunId))
      .orderBy(asc(teamMembers.name), asc(payoutRunAdjustments.createdAt)),
  ]);

  const summariesByMember = new Map<string, PayoutRunMemberSummary>();

  for (const row of commissionRows) {
    const memberKey = toMemberKey(row.memberId, row.memberName);
    const memberName =
      (row.memberName ?? "Unknown team member").trim() || "Unknown team member";
    const summary = summariesByMember.get(memberKey) ?? {
      memberKey,
      memberId: row.memberId,
      memberName,
      salesCents: 0,
      marketingCents: 0,
      crewCents: 0,
      adjustmentsCents: 0,
      totalCents: 0,
      commissionDetails: [],
      adjustmentDetails: [],
    };

    const amountCents = Number(row.amountCents ?? 0);
    if (row.role === "sales") summary.salesCents += amountCents;
    if (row.role === "marketing") summary.marketingCents += amountCents;
    if (row.role === "crew") summary.crewCents += amountCents;
    summary.totalCents += amountCents;
    summary.commissionDetails.push({
      ...row,
      amountCents,
      baseCents: Number(row.baseCents ?? 0),
      collectedCents:
        typeof row.collectedCents === "number" ? row.collectedCents : null,
    });
    summariesByMember.set(memberKey, summary);
  }

  for (const row of adjustmentRows) {
    const memberKey = toMemberKey(row.memberId, row.memberName);
    const memberName =
      (row.memberName ?? "Unknown team member").trim() || "Unknown team member";
    const summary = summariesByMember.get(memberKey) ?? {
      memberKey,
      memberId: row.memberId,
      memberName,
      salesCents: 0,
      marketingCents: 0,
      crewCents: 0,
      adjustmentsCents: 0,
      totalCents: 0,
      commissionDetails: [],
      adjustmentDetails: [],
    };

    const amountCents = Number(row.amountCents ?? 0);
    summary.adjustmentsCents += amountCents;
    summary.totalCents += amountCents;
    summary.adjustmentDetails.push({
      ...row,
      amountCents,
    });
    summariesByMember.set(memberKey, summary);
  }

  const memberSummaries = Array.from(summariesByMember.values()).sort((a, b) =>
    a.memberName.localeCompare(b.memberName),
  );
  const totalCents = memberSummaries.reduce(
    (sum, summary) => sum + summary.totalCents,
    0,
  );

  return {
    run,
    generatedAt: new Date(),
    memberSummaries,
    totalCents,
    commissionDetailCount: commissionRows.length,
    adjustmentCount: adjustmentRows.length,
  };
}

export function renderPayoutRunReportHtml(report: PayoutRunReportData): string {
  const summaryRows = report.memberSummaries
    .map(
      (summary) => `
        <tr>
          <td>${escapeHtml(summary.memberName)}</td>
          <td>${escapeHtml(fmtMoney(summary.salesCents))}</td>
          <td>${escapeHtml(fmtMoney(summary.marketingCents))}</td>
          <td>${escapeHtml(fmtMoney(summary.crewCents))}</td>
          <td>${escapeHtml(fmtMoney(summary.adjustmentsCents))}</td>
          <td><strong>${escapeHtml(fmtMoney(summary.totalCents))}</strong></td>
        </tr>`,
    )
    .join("");

  const memberSections = report.memberSummaries
    .map((summary) => {
      const commissionRows = summary.commissionDetails
        .map(
          (detail) => `
            <tr>
              <td>${escapeHtml(fmtWhen(detail.completedAt, report.run.timezone))}</td>
              <td>${escapeHtml(
                formatContactName(
                  detail.contactFirstName,
                  detail.contactLastName,
                ),
              )}</td>
              <td>${escapeHtml(
                formatAddress({
                  addressLine1: detail.addressLine1,
                  city: detail.city,
                  state: detail.state,
                  postalCode: detail.postalCode,
                }),
              )}</td>
              <td>${escapeHtml(formatRoleLabel(detail.role))}</td>
              <td>${escapeHtml(fmtMoney(detail.baseCents))}</td>
              <td>${escapeHtml(fmtMoney(detail.amountCents))}</td>
            </tr>`,
        )
        .join("");

      const adjustmentRows = summary.adjustmentDetails
        .map(
          (detail) => `
            <tr>
              <td>${escapeHtml(fmtWhen(detail.createdAt, report.run.timezone))}</td>
              <td>${escapeHtml(detail.note?.trim() || "Manual adjustment")}</td>
              <td>${escapeHtml(fmtMoney(detail.amountCents))}</td>
            </tr>`,
        )
        .join("");

      return `
        <section class="member-section">
          <h2>${escapeHtml(summary.memberName)}</h2>
          <div class="member-totals">
            <span>Total owed: <strong>${escapeHtml(fmtMoney(summary.totalCents))}</strong></span>
            <span>Sales ${escapeHtml(fmtMoney(summary.salesCents))}</span>
            <span>Marketing ${escapeHtml(fmtMoney(summary.marketingCents))}</span>
            <span>Crew ${escapeHtml(fmtMoney(summary.crewCents))}</span>
            <span>Adjustments ${escapeHtml(fmtMoney(summary.adjustmentsCents))}</span>
          </div>
          ${
            summary.commissionDetails.length > 0
              ? `<table>
                  <thead>
                    <tr>
                      <th>Completed</th>
                      <th>Customer</th>
                      <th>Job</th>
                      <th>Role</th>
                      <th>Base</th>
                      <th>Commission</th>
                    </tr>
                  </thead>
                  <tbody>${commissionRows}</tbody>
                </table>`
              : `<p class="muted">No job-based commission rows for this member in this run.</p>`
          }
          ${
            summary.adjustmentDetails.length > 0
              ? `<div class="adjustment-block">
                  <h3>Adjustments</h3>
                  <table>
                    <thead>
                      <tr>
                        <th>When</th>
                        <th>Note</th>
                        <th>Amount</th>
                      </tr>
                    </thead>
                    <tbody>${adjustmentRows}</tbody>
                  </table>
                </div>`
              : ""
          }
        </section>`;
    })
    .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Payout Run ${escapeHtml(report.run.id)}</title>
    <style>
      :root { color-scheme: light; }
      body {
        margin: 0;
        font-family: Georgia, "Times New Roman", serif;
        color: #0f172a;
        background: #f8fafc;
      }
      main {
        max-width: 1100px;
        margin: 0 auto;
        padding: 32px 24px 48px;
      }
      .hero, .card, .member-section {
        background: #ffffff;
        border: 1px solid #dbe3ef;
        border-radius: 18px;
        padding: 20px;
        box-shadow: 0 8px 30px rgba(15, 23, 42, 0.06);
      }
      .hero h1, .member-section h2 {
        margin: 0 0 8px;
      }
      .stack { display: grid; gap: 18px; }
      .meta {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 12px;
        margin-top: 16px;
      }
      .meta-block {
        border: 1px solid #e2e8f0;
        border-radius: 14px;
        padding: 12px 14px;
        background: #f8fafc;
      }
      .meta-label {
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: #475569;
      }
      .meta-value {
        margin-top: 4px;
        font-size: 16px;
        font-weight: 600;
      }
      .summary-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 12px;
      }
      .summary-grid .meta-value strong { font-size: 22px; }
      table {
        width: 100%;
        border-collapse: collapse;
        margin-top: 14px;
      }
      th, td {
        border-bottom: 1px solid #e2e8f0;
        padding: 10px 8px;
        text-align: left;
        vertical-align: top;
        font-size: 14px;
      }
      th {
        font-size: 12px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: #475569;
      }
      .member-totals {
        display: flex;
        flex-wrap: wrap;
        gap: 10px 16px;
        margin-top: 8px;
        color: #334155;
        font-size: 14px;
      }
      .adjustment-block { margin-top: 18px; }
      .adjustment-block h3 {
        margin: 0;
        font-size: 15px;
      }
      .muted { color: #64748b; }
      @media print {
        body { background: #ffffff; }
        main { max-width: none; padding: 0; }
        .hero, .card, .member-section {
          box-shadow: none;
          border-radius: 0;
          break-inside: avoid;
        }
      }
    </style>
  </head>
  <body>
    <main class="stack">
      <section class="hero">
        <h1>Payout Run Report</h1>
        <p class="muted">
          ${
            report.run.status === "draft"
              ? "Draft preview. This report reflects live commission data and can change until the payout run is locked."
              : "Locked payroll snapshot for printing and record keeping."
          }
        </p>
        <div class="meta">
          <div class="meta-block">
            <div class="meta-label">Status</div>
            <div class="meta-value">${escapeHtml(report.run.status.toUpperCase())}</div>
          </div>
          <div class="meta-block">
            <div class="meta-label">Period</div>
            <div class="meta-value">${escapeHtml(
              `${fmtWhen(report.run.periodStart, report.run.timezone)} → ${fmtWhen(report.run.periodEnd, report.run.timezone)}`,
            )}</div>
          </div>
          <div class="meta-block">
            <div class="meta-label">Scheduled payout</div>
            <div class="meta-value">${escapeHtml(
              fmtWhen(report.run.scheduledPayoutAt, report.run.timezone),
            )}</div>
          </div>
          <div class="meta-block">
            <div class="meta-label">Generated</div>
            <div class="meta-value">${escapeHtml(
              fmtWhen(report.generatedAt, report.run.timezone),
            )}</div>
          </div>
        </div>
      </section>

      <section class="card">
        <div class="summary-grid">
          <div class="meta-block">
            <div class="meta-label">Grand total</div>
            <div class="meta-value"><strong>${escapeHtml(
              fmtMoney(report.totalCents),
            )}</strong></div>
          </div>
          <div class="meta-block">
            <div class="meta-label">Members owed</div>
            <div class="meta-value">${escapeHtml(
              String(report.memberSummaries.length),
            )}</div>
          </div>
          <div class="meta-block">
            <div class="meta-label">Commission rows</div>
            <div class="meta-value">${escapeHtml(
              String(report.commissionDetailCount),
            )}</div>
          </div>
          <div class="meta-block">
            <div class="meta-label">Adjustments</div>
            <div class="meta-value">${escapeHtml(
              String(report.adjustmentCount),
            )}</div>
          </div>
        </div>

        ${
          report.memberSummaries.length > 0
            ? `<table>
                <thead>
                  <tr>
                    <th>Member</th>
                    <th>Sales</th>
                    <th>Marketing</th>
                    <th>Crew</th>
                    <th>Adjustments</th>
                    <th>Total owed</th>
                  </tr>
                </thead>
                <tbody>${summaryRows}</tbody>
              </table>`
            : `<p class="muted">No commission items exist for this payout run yet.</p>`
        }
      </section>

      ${memberSections}
    </main>
  </body>
</html>`;
}

export async function savePayoutRunReportHtml(
  db: DatabaseClient,
  payoutRunId: string,
): Promise<{ html: string; report: PayoutRunReportData }> {
  const report = await buildPayoutRunReportData(db, payoutRunId);
  const html = renderPayoutRunReportHtml(report);
  const generatedAt = new Date();

  await db
    .update(payoutRuns)
    .set({
      reportHtml: html,
      reportGeneratedAt: generatedAt,
    })
    .where(eq(payoutRuns.id, payoutRunId));

  return {
    html,
    report: {
      ...report,
      generatedAt,
      run: {
        ...report.run,
        reportHtml: html,
        reportGeneratedAt: generatedAt,
      },
    },
  };
}

export async function getPayoutRunReportHtml(
  db: DatabaseClient,
  payoutRunId: string,
): Promise<{ html: string; report: PayoutRunReportData }> {
  const run = await getPayoutRunRecord(db, payoutRunId);
  if (!run) {
    throw new Error("payout_run_not_found");
  }

  if (run.status !== "draft" && run.reportHtml) {
    const report = await buildPayoutRunReportData(db, payoutRunId);
    return {
      html: run.reportHtml,
      report: {
        ...report,
        generatedAt: run.reportGeneratedAt ?? report.generatedAt,
        run,
      },
    };
  }

  return savePayoutRunReportHtml(db, payoutRunId);
}
