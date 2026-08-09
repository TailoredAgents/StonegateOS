import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DatabaseClient } from "@/db";
import {
  allocateCrewPoolCents,
  validateCommissionManagementSplits,
  validateCommissionRecipientMembers,
} from "@/lib/commissions";
import {
  settleTeamMutationIdempotencyFailure,
  type TeamMutationIdempotencyClaim,
} from "@/lib/team-mutation-idempotency";
import {
  TeamMutationFailure,
  type TeamMutationContext,
} from "@/lib/team-mutation";

const workspaceRoot = resolve(__dirname, "../../../..");
const commissionSource = readFileSync(
  resolve(workspaceRoot, "apps/api/src/lib/commissions.ts"),
  "utf8",
);
const migrationSource = readFileSync(
  resolve(
    workspaceRoot,
    "apps/api/src/db/migrations/0094_commission_management_split_configuration.sql",
  ),
  "utf8",
);
const crewRuleMigrationSource = readFileSync(
  resolve(
    workspaceRoot,
    "apps/api/src/db/migrations/0095_commission_crew_split_rule_configuration.sql",
  ),
  "utf8",
);
const crewRuleSource = readFileSync(
  resolve(workspaceRoot, "apps/api/src/lib/locked-crew-payout.ts"),
  "utf8",
);
const teamStatusProxySource = readFileSync(
  resolve(
    workspaceRoot,
    "apps/site/src/app/api/team/appointments/status/route.ts",
  ),
  "utf8",
);
const e2eDbSource = readFileSync(
  resolve(workspaceRoot, "tests/e2e/support/db.ts"),
  "utf8",
);
const auditSpecSource = readFileSync(
  resolve(workspaceRoot, "tests/e2e/audit/team-console-audit.spec.ts"),
  "utf8",
);
const settingsRouteSource = readFileSync(
  resolve(
    workspaceRoot,
    "apps/api/app/api/admin/commissions/settings/route.ts",
  ),
  "utf8",
);
const commissionsUiSource = readFileSync(
  resolve(
    workspaceRoot,
    "apps/site/src/app/team/components/CommissionsSection.tsx",
  ),
  "utf8",
);

const jeffreyId = "5ac5217e-3905-4ea3-bdeb-65456982f5e3";
const austinId = "239ca36d-e618-4c5c-a283-b6e5d4ccb704";
const legacyManagementSplits = [
  { memberId: jeffreyId, splitBps: 12_000 },
  { memberId: austinId, splitBps: 5_000 },
] as const;

function expectConfigurationConflict(run: () => void): TeamMutationFailure {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(TeamMutationFailure);
    const failure = error as TeamMutationFailure;
    expect(failure.code).toBe("conflict");
    expect(failure.status).toBe(409);
    expect(failure.retryable).toBe(false);
    expect(failure.message).toContain("No appointment or commission changes");
    return failure;
  }
  throw new Error("Expected commission configuration to fail closed.");
}

describe("commission recipient integrity", () => {
  it("preserves the established 12%/5% management math as configuration", () => {
    validateCommissionManagementSplits(1_700, legacyManagementSplits);

    const allocation = allocateCrewPoolCents(17_000, [
      ...legacyManagementSplits,
    ]);
    expect(
      Object.fromEntries(
        allocation.map((entry) => [entry.memberId, entry.cents]),
      ),
    ).toEqual({
      [jeffreyId]: 12_000,
      [austinId]: 5_000,
    });
  });

  it("rejects absent, duplicate, and invalid management configuration", () => {
    expectConfigurationConflict(() =>
      validateCommissionManagementSplits(1_700, []),
    );
    expectConfigurationConflict(() =>
      validateCommissionManagementSplits(1_700, [
        { memberId: jeffreyId, splitBps: 12_000 },
        { memberId: jeffreyId, splitBps: 5_000 },
      ]),
    );
    expectConfigurationConflict(() =>
      validateCommissionManagementSplits(1_700, [
        { memberId: jeffreyId, splitBps: 0 },
      ]),
    );
  });

  it("requires every calculated recipient to exist and remain active", () => {
    validateCommissionRecipientMembers(
      [jeffreyId, austinId],
      [
        { id: jeffreyId, active: true },
        { id: austinId, active: true },
      ],
    );

    const missing = expectConfigurationConflict(() =>
      validateCommissionRecipientMembers(
        [jeffreyId, austinId],
        [{ id: jeffreyId, active: true }],
      ),
    );
    expect(missing.fieldErrors?.["commissionRecipients"]).toContain(
      "active team member",
    );
    expectConfigurationConflict(() =>
      validateCommissionRecipientMembers(
        [jeffreyId],
        [{ id: jeffreyId, active: false }],
      ),
    );
  });

  it("settles an incomplete-recipient idempotency claim as a terminal replay", async () => {
    let settledValues: Record<string, unknown> | null = null;
    const db = {
      update: () => ({
        set: (values: Record<string, unknown>) => {
          settledValues = values;
          return { where: () => Promise.resolve([]) };
        },
      }),
    } as unknown as DatabaseClient;
    const mutation = {
      operationId: "22222222-2222-4222-8222-222222222222",
    } as TeamMutationContext;
    const claim = {
      id: "11111111-1111-4111-8111-111111111111",
      operationId: mutation.operationId,
      principalHash: "a".repeat(64),
      keyHash: "b".repeat(64),
      scopeHash: "c".repeat(64),
      requestHash: "d".repeat(64),
      attemptCount: 1,
    } satisfies TeamMutationIdempotencyClaim;
    const failure = expectConfigurationConflict(() =>
      validateCommissionManagementSplits(1_700, []),
    );

    await settleTeamMutationIdempotencyFailure(
      db,
      mutation,
      claim,
      failure,
      new Date("2026-08-09T12:00:00.000Z"),
    );

    expect(settledValues).toMatchObject({
      status: "failed",
      responseStatus: 409,
      lastErrorCode: "conflict",
      responseBody: {
        ok: false,
        code: "conflict",
        retryable: false,
      },
    });
  });

  it("validates configuration and member rows before replacing commissions", () => {
    const calculationStart = commissionSource.indexOf("const commissionRows:");
    const configurationRead = commissionSource.indexOf(
      "await readCommissionManagementSplits(",
      calculationStart,
    );
    const eligibilityCheck = commissionSource.indexOf(
      "await validateCommissionRowsBeforeWrite(tx",
      configurationRead,
    );
    const destructiveReplace = commissionSource.indexOf(
      ".delete(appointmentCommissions)",
      eligibilityCheck,
    );

    expect(configurationRead).toBeGreaterThan(calculationStart);
    expect(eligibilityCheck).toBeGreaterThan(configurationRead);
    expect(destructiveReplace).toBeGreaterThan(eligibilityCheck);
    expect(commissionSource).toContain('.for("share")');
    expect(commissionSource).toContain('if (code === "23503")');
    expect(commissionSource).toContain(
      "A configured commission recipient is no longer an eligible team member.",
    );
    expect(commissionSource).not.toContain("const MANAGEMENT_SPLITS");
    expect(commissionSource).not.toMatch(
      /239ca36d-e618-4c5c-a283-b6e5d4ccb704|5ac5217e-3905-4ea3-bdeb-65456982f5e3/u,
    );
  });

  it("uses an additive, conditional migration and leaves historical money untouched", () => {
    expect(migrationSource).toContain(
      'CREATE TABLE IF NOT EXISTS "commission_management_splits"',
    );
    expect(migrationSource).toContain('JOIN "team_members" AS member');
    expect(migrationSource).toContain('member."active" = true');
    expect(migrationSource).not.toContain('INSERT INTO "team_members"');
    expect(migrationSource).not.toMatch(
      /UPDATE\s+"?(appointment_commissions|payout_runs|payout_run_lines)"?/iu,
    );
  });

  it("moves reachable crew overrides from runtime UUID constants into configuration", () => {
    expect(crewRuleMigrationSource).toContain(
      'CREATE TABLE IF NOT EXISTS "commission_crew_split_rules"',
    );
    expect(crewRuleMigrationSource).toContain("complete_rule");
    expect(crewRuleMigrationSource).not.toMatch(
      /UPDATE\s+"?(appointment_commissions|payout_runs|payout_run_lines)"?/iu,
    );
    expect(crewRuleSource).not.toMatch(
      /239ca36d-e618-4c5c-a283-b6e5d4ccb704|5ac5217e-3905-4ea3-bdeb-65456982f5e3|b45988bb-7417-48c5-af6d-fcdf71088282/u,
    );
    expect(commissionSource).toContain("resolveConfiguredCrewPayout(");
    expect(commissionSource).toContain("combinationCounts");
    expect(teamStatusProxySource).toContain(
      "weights are deliberately non-authoritative",
    );
    expect(commissionsUiSource).not.toContain("Jeffrey + Austin + Devon labor");
  });

  it("reports configured recipients instead of hard-coding names in the UI", () => {
    expect(settingsRouteSource).toContain(
      "getCommissionManagementConfigurationStatus(",
    );
    expect(settingsRouteSource).toContain("managementReady:");
    expect(settingsRouteSource).toContain("managementSplits:");
    expect(commissionsUiSource).toContain(
      "commissionSettings?.managementReady === true",
    );
    expect(commissionsUiSource).toContain(
      "Recipient setup is incomplete. Completed-job financial",
    );
    expect(commissionsUiSource).not.toContain(
      "Split 12% to Jeffrey and 5% to Austin.",
    );
  });

  it("provisions exact E2E recipients before both financial journeys", () => {
    expect(e2eDbSource).toContain("commission_management_splits");
    expect(e2eDbSource).toContain("split_bps = EXCLUDED.split_bps");
    expect(e2eDbSource).toContain("active = true");

    const journeyStart = auditSpecSource.indexOf(
      'test("day-of-service completion through payment and crew attribution"',
    );
    const fixtureSetup = auditSpecSource.indexOf(
      "await ensureE2ECommissionPrincipals();",
      journeyStart,
    );
    const appointmentSetup = auditSpecSource.indexOf(
      "await createDayOfServiceFixture();",
      journeyStart,
    );
    expect(fixtureSetup).toBeGreaterThan(journeyStart);
    expect(appointmentSetup).toBeGreaterThan(fixtureSetup);
  });
});
