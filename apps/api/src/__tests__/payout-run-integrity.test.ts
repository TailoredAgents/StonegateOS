import fs from "node:fs";
import path from "node:path";
import {
  decideCompletedAppointmentPayoutPeriod,
  decidePayoutRunTransition,
  getPayoutPayrollExpenseMismatches,
  nextPayoutRunVersionDate,
  payoutRunVersion,
  requirePayoutRunExpectedVersion,
} from "@/lib/commissions";
import {
  normalizePayoutRunMutationError,
  requirePayoutRunId,
} from "@/lib/payout-run-mutation-http";
import { TeamMutationFailure } from "@/lib/team-mutation";

const API_ROOT = path.resolve(__dirname, "../..");

function source(relativePath: string): string {
  return fs.readFileSync(path.resolve(API_ROOT, relativePath), "utf8");
}

describe("payout-run integrity", () => {
  it("blocks every legacy or canonical finalized run and orders draft refreshes", () => {
    expect(
      decideCompletedAppointmentPayoutPeriod([
        {
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          status: "draft",
        },
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          status: "draft",
        },
      ]),
    ).toEqual({
      ok: true,
      payoutRunIds: [
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      ],
    });

    expect(
      decideCompletedAppointmentPayoutPeriod([
        {
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          status: "draft",
        },
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          status: "locked",
        },
      ]),
    ).toEqual({
      ok: false,
      finalizedRunId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      finalizedRunStatus: "locked",
    });

    expect(
      decideCompletedAppointmentPayoutPeriod([
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          status: "paid",
        },
      ]),
    ).toEqual({
      ok: false,
      finalizedRunId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      finalizedRunStatus: "paid",
    });
  });

  it("allows only Draft -> Locked -> Paid and makes repeated transitions safe", () => {
    expect(decidePayoutRunTransition("draft", "locked")).toEqual({
      status: "locked",
      changed: true,
    });
    expect(decidePayoutRunTransition("locked", "locked")).toEqual({
      status: "locked",
      changed: false,
    });
    expect(() => decidePayoutRunTransition("paid", "locked")).toThrow(
      "payout_run_already_paid",
    );
    expect(
      normalizePayoutRunMutationError(new Error("payout_run_already_paid")),
    ).toMatchObject({ code: "conflict", status: 409, retryable: false });
    expect(decidePayoutRunTransition("locked", "paid")).toEqual({
      status: "paid",
      changed: true,
    });
    expect(decidePayoutRunTransition("paid", "paid")).toEqual({
      status: "paid",
      changed: false,
    });
    expect(() => decidePayoutRunTransition("draft", "paid")).toThrow(
      "payout_run_must_be_locked",
    );
  });

  it("requires an existing payroll expense to match the locked financial snapshot", () => {
    const periodStart = new Date("2026-08-03T04:00:00.000Z");
    const periodEnd = new Date("2026-08-10T04:00:00.000Z");
    const paidAt = new Date("2026-08-08T15:00:00.000Z");
    const baseline = {
      payoutRunId: "11111111-1111-4111-8111-111111111111",
      amount: 12_500,
      currency: "USD",
      category: "Commissions",
      vendor: "Payouts",
      memo: "payout_run:11111111-1111-4111-8111-111111111111",
      source: "payout_run",
      lifecycleStatus: "posted" as const,
      paidAt,
      postedAt: paidAt,
      postedBy: "22222222-2222-4222-8222-222222222222",
      coverageStartAt: periodStart,
      coverageEndAt: periodEnd,
    };
    const expected = {
      payoutRunId: baseline.payoutRunId,
      amount: baseline.amount,
      paidAt,
      coverageStartAt: periodStart,
      coverageEndAt: periodEnd,
    };

    expect(getPayoutPayrollExpenseMismatches(baseline, expected)).toEqual([]);
    expect(
      getPayoutPayrollExpenseMismatches(
        { ...baseline, amount: baseline.amount + 1 },
        expected,
      ),
    ).toContain("amount");
    expect(
      getPayoutPayrollExpenseMismatches(
        { ...baseline, coverageEndAt: new Date(periodEnd.getTime() + 1) },
        expected,
      ),
    ).toContain("coverage_end");
    expect(
      getPayoutPayrollExpenseMismatches(
        {
          ...baseline,
          lifecycleStatus: "draft",
          postedAt: null,
          postedBy: null,
        },
        expected,
      ),
    ).toEqual(
      expect.arrayContaining(["lifecycle_status", "posted_at", "posted_by"]),
    );
    expect(
      getPayoutPayrollExpenseMismatches(baseline, {
        ...expected,
        amount: 0,
      }),
    ).toEqual(
      expect.arrayContaining(["unexpected_for_nonpositive_total", "amount"]),
    );
  });

  it("advances payout versions monotonically even inside one clock millisecond", () => {
    const current = new Date("2026-08-08T12:00:00.500Z");
    expect(
      payoutRunVersion(
        nextPayoutRunVersionDate(current, new Date("2026-08-08T12:00:00.500Z")),
      ),
    ).toBe("2026-08-08T12:00:00.501Z");
    expect(
      payoutRunVersion(
        nextPayoutRunVersionDate(current, new Date("2026-08-08T12:00:02.000Z")),
      ),
    ).toBe("2026-08-08T12:00:02.000Z");
  });

  it("requires canonical record identifiers and exact timestamp versions", () => {
    expect(requirePayoutRunId("11111111-1111-4111-8111-111111111111")).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(() => requirePayoutRunId("not-a-run")).toThrow(TeamMutationFailure);
    expect(() =>
      requirePayoutRunExpectedVersion({
        expectedVersion: "2026-08-08T12:00:00.000Z",
      }),
    ).not.toThrow();
    for (const expectedVersion of [
      null,
      "*",
      "2026-08-08",
      "2026-08-08T12:00:00Z",
      "not-a-version",
    ]) {
      expect(() =>
        requirePayoutRunExpectedVersion({ expectedVersion }),
      ).toThrow(TeamMutationFailure);
    }
  });

  it("registers 0069 after the contact soft-delete migration", () => {
    const journal = JSON.parse(
      source("src/db/migrations/meta/_journal.json"),
    ) as { entries?: Array<{ idx?: number; tag?: string }> };
    const entries = journal.entries ?? [];
    const softDeleteIndex = entries.findIndex(
      (entry) => entry.tag === "0068_contact_soft_delete",
    );

    expect(entries.slice(softDeleteIndex, softDeleteIndex + 2)).toEqual([
      expect.objectContaining({
        idx: 65,
        tag: "0068_contact_soft_delete",
      }),
      expect.objectContaining({
        idx: 66,
        tag: "0069_payout_run_integrity",
      }),
    ]);
  });

  it("selects one canonical historical period without deleting financial rows", () => {
    const migration = source("src/db/migrations/0069_payout_run_integrity.sql");

    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "period_canonical"');
    expect(migration).toContain("row_number() OVER (");
    expect(migration).toContain(
      'PARTITION BY "timezone", "period_start", "period_end"',
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "payout_runs_canonical_period_key"',
    );
    expect(migration).toContain('WHERE "period_canonical" = true');
    expect(migration).not.toMatch(/DELETE\s+FROM\s+"payout_runs"/iu);
  });

  it("backfills one explicitly linked payroll expense per run", () => {
    const migration = source("src/db/migrations/0069_payout_run_integrity.sql");

    expect(migration).toContain(
      'ADD COLUMN IF NOT EXISTS "payout_run_id" uuid',
    );
    expect(migration).toContain("payroll_expense_candidates");
    expect(migration).toContain(
      'expense."memo" = (\'payout_run:\' || run."id"::text)',
    );
    expect(migration).toContain('candidate."expense_rank" = 1');
    expect(migration).toContain("ON DELETE RESTRICT ON UPDATE NO ACTION");
    expect(migration).toContain("ON UPDATE NO ACTION NOT VALID");
    expect(migration).toContain(
      'VALIDATE CONSTRAINT "expenses_payout_run_id_payout_runs_id_fk"',
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "expenses_payout_run_key"',
    );
    expect(migration).toContain("expenses_payout_run_source_check");
  });

  it("enforces immutable timelines, core run fields, lines, and adjustments", () => {
    const migration = source("src/db/migrations/0069_payout_run_integrity.sql");

    expect(migration).toContain("payout_runs_status_timeline_check");
    expect(migration).toContain("enforce_payout_run_transition");
    expect(migration).toContain("invalid payout run transition: draft -> %");
    expect(migration).toContain("paid payout runs are immutable");
    expect(migration).toContain("payout_run_lines_draft_guard");
    expect(migration).toContain("payout_run_adjustments_draft_guard");
    expect(migration).toContain(
      'ARRAY[OLD."payout_run_id", NEW."payout_run_id"]',
    );
    expect(migration).toContain('ORDER BY "id"');
    expect(migration).toContain("expenses_posted_payout_guard");
    expect(migration).toContain("posted payout payroll expenses are immutable");
    expect(migration).toContain("FOR UPDATE");
  });

  it("serializes create, lock, and pay and commits audit attribution with state", () => {
    const commissions = source("src/lib/commissions.ts");
    const createStart = commissions.indexOf(
      "export async function createOrGetCurrentPayoutRun",
    );
    const lockStart = commissions.indexOf(
      "export async function lockPayoutRun",
    );
    const payStart = commissions.indexOf(
      "export async function markPayoutRunPaid",
    );
    const createSource = commissions.slice(createStart, lockStart);
    const lockSource = commissions.slice(lockStart, payStart);
    const paySource = commissions.slice(payStart);

    expect(createSource).toContain("pg_advisory_xact_lock");
    expect(createSource).toContain("periodCanonical: true");
    expect(createSource).toContain(".onConflictDoNothing()");
    expect(createSource).toContain('action: "commission.payout_run.created"');
    expect(lockSource).toContain('.for("update")');
    expect(lockSource).toContain("payoutPeriodLockKey(snapshot)");
    expect(lockSource).toContain("tx as unknown as DatabaseClient");
    expect(lockSource.indexOf("payoutPeriodLockKey(snapshot)")).toBeLessThan(
      lockSource.indexOf("acquirePayoutReportAdvisoryLock"),
    );
    expect(lockSource).toContain('eq(payoutRuns.status, "draft")');
    expect(lockSource).toContain('action: "commission.payout_run.locked"');
    expect(paySource).toContain('.for("update")');
    expect(paySource).toContain('eq(payoutRuns.status, "locked")');
    expect(paySource).toContain("target: expenses.payoutRunId");
    expect(paySource).toContain('lifecycleStatus: "posted"');
    expect(paySource).toContain("postedBy: actor.id");
    expect(paySource).toContain("paidAt: actualPaidAt");
    expect(paySource).not.toContain("paidAt: run.scheduledPayoutAt ?? now");
    expect(paySource).toContain('action: "commission.payout_run.paid"');
    expect(commissions).toContain("actorLabel: input.actor.label ?? null");
  });

  it("maps guarded states truthfully and locks reimbursement edits", () => {
    const createRoute = source(
      "app/api/admin/commissions/payout-runs/route.ts",
    );
    const lockRoute = source(
      "app/api/admin/commissions/payout-runs/[payoutRunId]/lock/route.ts",
    );
    const paidRoute = source(
      "app/api/admin/commissions/payout-runs/[payoutRunId]/mark-paid/route.ts",
    );
    const reimbursements = source(
      "app/api/admin/commissions/payout-runs/[payoutRunId]/reimbursements/route.ts",
    );

    for (const route of [lockRoute, paidRoute, reimbursements]) {
      expect(route).toContain("beginTeamMutation(request");
      expect(route).toContain("claimTeamMutationIdempotency(");
      expect(route).toContain("requirePayoutRunExpectedVersion(mutation)");
      expect(route).toContain("teamMutationIdempotencyReplayResponse");
      expect(route).toContain("settleTeamMutationIdempotencyFailure");
    }
    for (const route of [createRoute, lockRoute, paidRoute]) {
      expect(route).toContain("recordTeamMutationFailure(mutation");
    }
    expect(lockRoute).toContain('risk: "financial"');
    expect(paidRoute).toContain('requiredPermissions: ["commissions.pay"]');
    expect(paidRoute).toContain('payload: { requestedStatus: "paid" }');
    expect(reimbursements).toContain('.for("update")');
    expect(reimbursements).toContain("completeTeamMutationIdempotency(");
    expect(reimbursements).toContain("assertTeamMutationExpectedVersion(");
  });

  it("binds the durable receipt and actor audit to the financial transaction", () => {
    const commissions = source("src/lib/commissions.ts");
    const reimbursementRoute = source(
      "app/api/admin/commissions/payout-runs/[payoutRunId]/reimbursements/route.ts",
    );

    expect(commissions).toContain("mutation.audit.insertSuccess(tx");
    expect(commissions).toContain("completeTeamMutationIdempotency(");
    expect(commissions).toContain(
      "const { mutation, claim } = input.execution",
    );
    expect(reimbursementRoute).toContain("mutation.audit.insertSuccess(tx");
    expect(reimbursementRoute).toContain("completeTeamMutationIdempotency(");
    expect(
      reimbursementRoute.indexOf("mutation.audit.insertSuccess(tx"),
    ).toBeLessThan(
      reimbursementRoute.indexOf("completeTeamMutationIdempotency("),
    );
  });

  it("keeps report and export reads side-effect free and versioned", () => {
    const reportLibrary = source("src/lib/payout-run-report.ts");
    const reportRoute = source(
      "app/api/admin/commissions/payout-runs/[payoutRunId]/report/route.ts",
    );
    const exportRoute = source(
      "app/api/admin/commissions/payout-runs/[payoutRunId]/export/route.ts",
    );
    const getStart = reportLibrary.indexOf(
      "export async function getPayoutRunReportHtml",
    );
    const getSource = reportLibrary.slice(getStart);

    expect(getSource).not.toContain("savePayoutRunReportHtml(");
    expect(getSource).toContain("renderPayoutRunReportHtml(report)");
    expect(reportRoute).toContain('"x-record-version": version');
    expect(exportRoute).toContain('"x-record-version": version');
    expect(reportRoute).toContain('"Cache-Control": "private, no-store"');
    expect(exportRoute).toContain('"Cache-Control": "private, no-store"');
  });

  it("sends stable form keys and loaded versions through Team and mobile callers", () => {
    const component = source(
      "../site/src/app/team/components/CommissionsSection.tsx",
    );
    const teamProxy = source(
      "../site/src/app/api/team/commissions/payout-runs/route.ts",
    );
    const reimbursementProxy = source(
      "../site/src/app/api/team/commissions/payout-runs/[payoutRunId]/reimbursements/route.ts",
    );
    const mobileActions = source("../site/src/app/mobile/actions.ts");
    const mobilePage = source("../site/src/app/mobile/page.tsx");

    expect(component).toContain('name="idempotencyKey"');
    expect(component).toContain('name="expectedVersion"');
    expect(teamProxy).toContain('"Idempotency-Key"');
    expect(teamProxy).toContain('"If-Match"');
    expect(teamProxy).toContain("isTeamMutationSuccessEnvelope");
    expect(teamProxy).toContain("receipt.actorId === expected.actorId");
    expect(teamProxy).toContain("timestamp.toISOString() === value");
    expect(teamProxy).toContain("UUID_PATTERN.test(receipt.operationId)");
    expect(teamProxy).toContain('secure: redirectTo.protocol === "https:"');
    expect(teamProxy).toContain(
      'formString(formData, "confirmation") !== "reviewed"',
    );
    expect(teamProxy).not.toContain("randomUUID");
    expect(teamProxy).not.toContain("supplied ||");
    expect(component).toContain('name="confirmation"');
    expect(component).toContain("I confirm these funds were paid.");
    expect(reimbursementProxy).toContain('"Idempotency-Key"');
    expect(reimbursementProxy).toContain('"If-Match"');
    expect(mobilePage).toContain('name="expectedVersion"');
    expect(mobileActions).toContain('"Idempotency-Key"');
    expect(mobileActions).toContain("mutationPayload?.ok !== true");
  });
});
