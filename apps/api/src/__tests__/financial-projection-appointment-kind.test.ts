import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.cwd(), "../..");

function source(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

describe("financial projection appointment eligibility", () => {
  it("uses the shared service-work predicate for revenue and current payroll", () => {
    const revenue = source("apps/api/app/api/revenue/summary/route.ts");
    const commissionSummary = source(
      "apps/api/app/api/admin/commissions/summary/route.ts",
    );
    const payrollSummary = source(
      "apps/api/app/api/admin/commissions/payroll-summary/route.ts",
    );

    for (const route of [revenue, commissionSummary, payrollSummary]) {
      expect(route).toContain(
        'import { serviceWorkAppointmentTypePredicate } from "@/lib/appointment-kind";',
      );
    }

    expect(
      occurrences(
        revenue,
        "serviceWorkAppointmentTypePredicate(appointments.type)",
      ),
    ).toBe(4);
    expect(
      occurrences(
        commissionSummary,
        "serviceWorkAppointmentTypePredicate(appointments.type)",
      ),
    ).toBe(2);
    expect(
      occurrences(
        payrollSummary,
        "serviceWorkAppointmentTypePredicate(appointments.type)",
      ),
    ).toBe(1);
    expect(payrollSummary).toContain(
      "eq(payoutRuns.timezone, currentPeriod.timezone)",
    );
    expect(
      occurrences(payrollSummary, "eq(payoutRuns.periodCanonical, true)"),
    ).toBeGreaterThanOrEqual(2);
  });

  it("adds manual payout adjustments to payroll but keeps reimbursements separate", () => {
    const commissionSummary = source(
      "apps/api/app/api/admin/commissions/summary/route.ts",
    );

    expect(commissionSummary).toContain(
      "calculatePayoutPeriodPayrollAdjustmentTotalCents(db, period)",
    );
    expect(commissionSummary).toContain(
      "totals.adjustments = payrollAdjustmentsCents",
    );
    expect(commissionSummary).not.toContain('row.role === "adjustments"');

    const payoutReport = source("apps/api/src/lib/payout-run-report.ts");
    expect(payoutReport).toContain(
      "export async function calculatePayoutPeriodPayrollAdjustmentTotalCents",
    );
    expect(payoutReport).toContain(
      'ne(payoutRunAdjustments.kind, "reimbursement")',
    );
  });
});
