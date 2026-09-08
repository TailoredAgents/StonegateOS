import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workspaceRoot = resolve(process.cwd(), "../..");

function source(path: string): string {
  return readFileSync(resolve(workspaceRoot, "apps/api", path), "utf8");
}

function occurrenceCount(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

describe("payout appointment-kind contract", () => {
  it("uses the canonical service-work classification for commission generation", () => {
    const commissions = source("src/lib/commissions.ts");

    expect(commissions).toContain("resolveAppointmentCommissionBaseCents(row)");
    expect(commissions).toContain("isServiceWorkAppointmentType(input.type)");
    expect(commissions).toContain(
      "serviceWorkAppointmentTypePredicate(appointments.type)",
    );
  });

  it("filters both live totals and report detail through the same classification", () => {
    const report = source("src/lib/payout-run-report.ts");

    expect(
      occurrenceCount(
        report,
        "serviceWorkAppointmentTypePredicate(appointments.type)",
      ),
    ).toBe(2);
  });
});
