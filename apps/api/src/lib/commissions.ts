import { DateTime } from "luxon";
import type { MutationResult } from "@myst-os/sdk";
import { and, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { DatabaseClient } from "@/db";
import {
  appointmentCommissions,
  appointmentCrewMembers,
  appointments,
  auditLogs,
  commissionCrewSplitRules,
  commissionManagementSplits,
  commissionSettings,
  expenses,
  payoutRunAdjustments,
  payoutRunLines,
  payoutRuns,
  teamMembers,
} from "@/db";
import type { AuditActor } from "@/lib/audit";
import {
  attachApprovedReimbursementClaimsToDraftPayout,
  markAttachedReimbursementClaimsPaid,
} from "@/lib/expense-submissions";
import {
  resolveLockedCrewPayout,
  type ConfiguredCrewPayoutRule,
  type LockedCrewPayoutResolution,
} from "@/lib/locked-crew-payout";
import { savePayoutRunReportHtml } from "@/lib/payout-run-report";
import {
  completeTeamMutationIdempotency,
  type TeamMutationIdempotencyClaim,
} from "@/lib/team-mutation-idempotency";
import {
  assertTeamMutationExpectedVersion,
  TeamMutationFailure,
  type TeamMutationContext,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";

type TransactionExecutor = Parameters<
  DatabaseClient["transaction"]
>[0] extends (tx: infer Transaction) => Promise<unknown>
  ? Transaction
  : never;

export type PayoutRunTransitionData = {
  payoutRunId: string;
  status: "draft" | "locked" | "paid";
  changed: boolean;
  version: string;
};

export type PayoutRunTransitionResult = PayoutRunTransitionData & {
  mutationResult?: PayoutRunMutationSuccess<PayoutRunTransitionData>;
};

export type PayoutRunMutationSuccess<T extends Record<string, unknown>> =
  Extract<MutationResult<T>, { ok: true }> & T;

export type PayoutRunMutationExecution = {
  mutation: TeamMutationContext;
  claim: TeamMutationIdempotencyClaim;
  responseStatus?: number;
};

export function payoutRunVersion(updatedAt: Date): string {
  return updatedAt.toISOString();
}

export function nextPayoutRunVersionDate(
  current: Date,
  now = new Date(),
): Date {
  return new Date(Math.max(now.getTime(), current.getTime() + 1));
}

export function requirePayoutRunExpectedVersion(
  mutation: Pick<TeamMutationContext, "expectedVersion">,
): void {
  const expectedVersion = mutation.expectedVersion;
  const parsedVersion = expectedVersion ? new Date(expectedVersion) : null;
  if (
    expectedVersion === null ||
    expectedVersion === "*" ||
    !parsedVersion ||
    Number.isNaN(parsedVersion.getTime()) ||
    parsedVersion.toISOString() !== expectedVersion
  ) {
    throw new TeamMutationFailure(
      "invalid",
      "The current payout-run version is required. Refresh and try again.",
      { fieldErrors: { version: "Use the latest payout-run version." } },
    );
  }
}

export function decidePayoutRunTransition(
  current: "draft" | "locked" | "paid",
  requested: "locked" | "paid",
): { status: "locked" | "paid"; changed: boolean } {
  if (requested === "locked") {
    if (current === "draft") return { status: "locked", changed: true };
    if (current === "locked") return { status: "locked", changed: false };
    throw new Error("payout_run_already_paid");
  }

  if (current === "draft") {
    throw new Error("payout_run_must_be_locked");
  }
  return { status: "paid", changed: current === "locked" };
}

export type PayoutPayrollExpenseSnapshot = {
  payoutRunId: string | null;
  amount: number;
  currency: string;
  category: string | null;
  vendor: string | null;
  memo: string | null;
  source: string;
  lifecycleStatus: "draft" | "posted" | "voided" | "corrected";
  paidAt: Date;
  postedAt: Date | null;
  postedBy: string | null;
  coverageStartAt: Date | null;
  coverageEndAt: Date | null;
};

export function getPayoutPayrollExpenseMismatches(
  expense: PayoutPayrollExpenseSnapshot,
  expected: {
    payoutRunId: string;
    amount: number;
    paidAt: Date;
    coverageStartAt: Date;
    coverageEndAt: Date;
  },
): string[] {
  const mismatches: string[] = [];
  if (expected.amount <= 0) mismatches.push("unexpected_for_nonpositive_total");
  if (
    expense.payoutRunId !== null &&
    expense.payoutRunId !== expected.payoutRunId
  ) {
    mismatches.push("payout_run_id");
  }
  if (expense.amount !== expected.amount) mismatches.push("amount");
  if (expense.currency !== "USD") mismatches.push("currency");
  if (expense.category !== "Commissions") mismatches.push("category");
  if (expense.vendor !== "Payouts") mismatches.push("vendor");
  if (expense.memo !== `payout_run:${expected.payoutRunId}`) {
    mismatches.push("memo");
  }
  if (expense.source !== "payout_run") mismatches.push("source");
  if (expense.lifecycleStatus !== "posted") {
    mismatches.push("lifecycle_status");
  }
  if (!expense.postedAt) mismatches.push("posted_at");
  if (!expense.postedBy) mismatches.push("posted_by");
  if (expense.paidAt.getTime() !== expected.paidAt.getTime()) {
    mismatches.push("paid_at");
  }
  if (
    expense.coverageStartAt?.getTime() !== expected.coverageStartAt.getTime()
  ) {
    mismatches.push("coverage_start");
  }
  if (expense.coverageEndAt?.getTime() !== expected.coverageEndAt.getTime()) {
    mismatches.push("coverage_end");
  }
  return mismatches;
}

function resolveCommissionActor(input: {
  actor?: AuditActor;
  actorId?: string | null;
}): AuditActor {
  return input.actor ?? { id: input.actorId ?? null };
}

async function insertPayoutRunAudit(
  tx: TransactionExecutor,
  input: {
    actor: AuditActor;
    action: string;
    payoutRunId: string;
    meta: Record<string, unknown>;
  },
): Promise<void> {
  await tx.insert(auditLogs).values({
    actorType: input.actor.type ?? "system",
    actorId: input.actor.id ?? null,
    actorRole: input.actor.role ?? null,
    actorLabel: input.actor.label ?? null,
    action: input.action,
    entityType: "payout_run",
    entityId: input.payoutRunId,
    meta: input.meta,
    createdAt: new Date(),
  });
}

async function finalizePayoutRunMutation<
  T extends {
    payoutRunId: string;
    version: string;
  },
>(
  tx: TransactionExecutor,
  input: {
    actor: AuditActor;
    action: string;
    data: T;
    metadata: Record<string, unknown>;
    execution?: PayoutRunMutationExecution;
  },
): Promise<PayoutRunMutationSuccess<T> | undefined> {
  if (!input.execution) {
    await insertPayoutRunAudit(tx, {
      actor: input.actor,
      action: input.action,
      payoutRunId: input.data.payoutRunId,
      meta: input.metadata,
    });
    return undefined;
  }

  const { mutation, claim } = input.execution;
  const audit = await mutation.audit.insertSuccess(tx, {
    entityType: "payout_run",
    entityId: input.data.payoutRunId,
    after: {
      status:
        "status" in input.data && typeof input.data.status === "string"
          ? input.data.status
          : undefined,
      version: input.data.version,
    },
    metadata: input.metadata,
  });
  const baseResult = teamMutationSuccessResult(mutation, input.data, {
    auditEventId: audit.auditEventId,
    committedAt: audit.committedAt,
    entityType: "payout_run",
    entityId: input.data.payoutRunId,
    version: input.data.version,
  });
  // Preserve the established top-level payout fields while exposing the
  // shared MutationResult data/receipt contract to new callers.
  const result = Object.assign(
    baseResult,
    input.data,
  ) as PayoutRunMutationSuccess<T>;
  await completeTeamMutationIdempotency(
    tx,
    mutation,
    claim,
    result,
    input.execution.responseStatus ?? 200,
  );
  return result;
}

export type CommissionSettingsRow = {
  key: string;
  timezone: string;
  payoutWeekday: 1 | 2 | 3 | 4 | 5 | 6 | 7; // ISO: 1=Mon ... 7=Sun
  payoutHour: number;
  payoutMinute: number;
  salesRateBps: number;
  marketingRateBps: number;
  crewPoolRateBps: number;
  marketingMemberId: string | null;
};

const SETTINGS_KEY = "default";
const DEFAULT_SALES_RATE_BPS = 0;
const DEFAULT_MANAGEMENT_RATE_BPS = 1700;
const DEFAULT_CREW_POOL_RATE_BPS = 2000;

export type CommissionManagementSplit = {
  memberId: string;
  splitBps: number;
};

export type CommissionRecipientMember = {
  id: string;
  active: boolean;
};

export type CommissionManagementRecipientStatus = CommissionManagementSplit & {
  name: string | null;
  active: boolean;
};

export type CommissionManagementConfigurationStatus = {
  ready: boolean;
  totalSplitBps: number;
  recipients: CommissionManagementRecipientStatus[];
};

export type CommissionCrewSplitRuleStatus = ConfiguredCrewPayoutRule & {
  recipients: Array<{
    memberId: string;
    name: string | null;
    active: boolean;
    splitBps: number;
  }>;
  ready: boolean;
};

export type CommissionCrewSplitConfigurationStatus = {
  ready: boolean;
  rules: CommissionCrewSplitRuleStatus[];
};

function commissionRecipientConfigurationFailure(
  fieldMessage: string,
): TeamMutationFailure {
  return new TeamMutationFailure(
    "conflict",
    "Commission recipient setup is incomplete. No appointment or commission changes were saved. Ask a system administrator to configure active commission recipients, then refresh and submit a new request.",
    {
      fieldErrors: { commissionRecipients: fieldMessage },
      retryable: false,
    },
  );
}

/**
 * Pure validation shared by the database path and focused tests. Management
 * split values are relative weights rather than percentages; the established
 * 12,000/5,000 allocation must remain valid even though one weight is greater
 * than 10,000.
 */
export function validateCommissionManagementSplits(
  managementRateBps: number,
  splits: readonly CommissionManagementSplit[],
): void {
  if (managementRateBps <= 0) return;
  if (splits.length === 0) {
    throw commissionRecipientConfigurationFailure(
      "Configure at least one active management recipient.",
    );
  }

  const memberIds = new Set<string>();
  let totalSplitBps = 0;
  for (const split of splits) {
    if (
      !split.memberId ||
      !Number.isInteger(split.splitBps) ||
      split.splitBps <= 0 ||
      split.splitBps > 1_000_000 ||
      memberIds.has(split.memberId)
    ) {
      throw commissionRecipientConfigurationFailure(
        "Management recipients must be unique and have a positive allocation weight.",
      );
    }
    memberIds.add(split.memberId);
    totalSplitBps += split.splitBps;
  }
  if (!Number.isSafeInteger(totalSplitBps) || totalSplitBps <= 0) {
    throw commissionRecipientConfigurationFailure(
      "Management allocation weights must have a safe positive total.",
    );
  }
}

export function validateCommissionRecipientMembers(
  recipientIds: readonly string[],
  members: readonly CommissionRecipientMember[],
): void {
  const requiredIds = new Set(recipientIds.filter(Boolean));
  if (requiredIds.size === 0) return;
  const eligibleIds = new Set(
    members.filter((member) => member.active).map((member) => member.id),
  );
  if ([...requiredIds].some((memberId) => !eligibleIds.has(memberId))) {
    throw commissionRecipientConfigurationFailure(
      "Every sales, management, and crew recipient must be an active team member.",
    );
  }
}

export async function getCommissionManagementConfigurationStatus(
  db: Pick<DatabaseClient, "select">,
  managementRateBps: number,
): Promise<CommissionManagementConfigurationStatus> {
  if (managementRateBps <= 0) {
    return { ready: true, totalSplitBps: 0, recipients: [] };
  }

  const recipients = await db
    .select({
      memberId: commissionManagementSplits.memberId,
      splitBps: commissionManagementSplits.splitBps,
      name: teamMembers.name,
      active: teamMembers.active,
    })
    .from(commissionManagementSplits)
    .leftJoin(
      teamMembers,
      eq(teamMembers.id, commissionManagementSplits.memberId),
    )
    .where(
      and(
        eq(commissionManagementSplits.settingsKey, SETTINGS_KEY),
        eq(commissionManagementSplits.enabled, true),
      ),
    )
    .orderBy(commissionManagementSplits.memberId);
  const totalSplitBps = recipients.reduce(
    (sum, recipient) => sum + recipient.splitBps,
    0,
  );
  const ready =
    recipients.length > 0 &&
    totalSplitBps > 0 &&
    recipients.every(
      (recipient) =>
        recipient.active === true &&
        Number.isInteger(recipient.splitBps) &&
        recipient.splitBps > 0,
    );

  return {
    ready,
    totalSplitBps,
    recipients: recipients.map((recipient) => ({
      memberId: recipient.memberId,
      splitBps: recipient.splitBps,
      name: recipient.name ?? null,
      active: recipient.active ?? false,
    })),
  };
}

function groupCommissionCrewSplitRules(
  rows: ReadonlyArray<{
    ruleKey: string;
    memberId: string;
    splitBps: number;
    name: string | null;
    active: boolean | null;
  }>,
): CommissionCrewSplitRuleStatus[] {
  const grouped = new Map<string, CommissionCrewSplitRuleStatus>();
  for (const row of rows) {
    const existing = grouped.get(row.ruleKey) ?? {
      ruleKey: row.ruleKey,
      splits: [],
      recipients: [],
      ready: true,
    };
    existing.splits.push({
      memberId: row.memberId,
      splitBps: row.splitBps,
    });
    existing.recipients.push({
      memberId: row.memberId,
      name: row.name,
      active: row.active === true,
      splitBps: row.splitBps,
    });
    if (
      row.active !== true ||
      !Number.isInteger(row.splitBps) ||
      row.splitBps <= 0
    ) {
      existing.ready = false;
    }
    grouped.set(row.ruleKey, existing);
  }

  const rules = [...grouped.values()]
    .map((rule) => ({
      ...rule,
      splits: [...rule.splits].sort((left, right) =>
        left.memberId.localeCompare(right.memberId),
      ),
      recipients: [...rule.recipients].sort((left, right) =>
        left.memberId.localeCompare(right.memberId),
      ),
      ready: rule.ready && rule.splits.length >= 2,
    }))
    .sort((left, right) => left.ruleKey.localeCompare(right.ruleKey));
  const combinationCounts = new Map<string, number>();
  for (const rule of rules) {
    const combination = rule.splits.map((split) => split.memberId).join("|");
    combinationCounts.set(
      combination,
      (combinationCounts.get(combination) ?? 0) + 1,
    );
  }
  return rules.map((rule) => {
    const combination = rule.splits.map((split) => split.memberId).join("|");
    return {
      ...rule,
      ready: rule.ready && combinationCounts.get(combination) === 1,
    };
  });
}

export async function getCommissionCrewSplitConfigurationStatus(
  db: Pick<DatabaseClient, "select">,
): Promise<CommissionCrewSplitConfigurationStatus> {
  const rows = await db
    .select({
      ruleKey: commissionCrewSplitRules.ruleKey,
      memberId: commissionCrewSplitRules.memberId,
      splitBps: commissionCrewSplitRules.splitBps,
      name: teamMembers.name,
      active: teamMembers.active,
    })
    .from(commissionCrewSplitRules)
    .leftJoin(
      teamMembers,
      eq(teamMembers.id, commissionCrewSplitRules.memberId),
    )
    .where(
      and(
        eq(commissionCrewSplitRules.settingsKey, SETTINGS_KEY),
        eq(commissionCrewSplitRules.enabled, true),
      ),
    )
    .orderBy(
      commissionCrewSplitRules.ruleKey,
      commissionCrewSplitRules.memberId,
    );
  const rules = groupCommissionCrewSplitRules(rows);
  return {
    ready: rules.every((rule) => rule.ready),
    rules,
  };
}

/** Resolve current crew payout configuration at the server boundary. */
export async function resolveConfiguredCrewPayout(
  db: Pick<DatabaseClient, "select">,
  memberIds: string[],
): Promise<LockedCrewPayoutResolution> {
  try {
    const status = await getCommissionCrewSplitConfigurationStatus(db);
    if (!status.ready) {
      return {
        ok: false,
        normalizedMemberIds: [...new Set(memberIds.map((id) => id.trim()))]
          .filter(Boolean)
          .sort(),
        reason: "invalid_rule",
      };
    }
    const resolved = resolveLockedCrewPayout(memberIds, status.rules);
    if (!resolved.ok || resolved.splits.length === 0) return resolved;

    const members = await db
      .select({
        memberId: teamMembers.id,
        fixedJobRateBps: teamMembers.fixedCrewJobRateBps,
      })
      .from(teamMembers)
      .where(
        inArray(
          teamMembers.id,
          resolved.splits.map((split) => split.memberId),
        ),
      );
    const fixedRateByMemberId = new Map(
      members.map((member) => [member.memberId, member.fixedJobRateBps]),
    );
    const fixedRateTotalBps = members.reduce(
      (sum, member) => sum + (member.fixedJobRateBps ?? 0),
      0,
    );
    if (
      members.length !== resolved.splits.length ||
      members.some(
        (member) =>
          member.fixedJobRateBps !== null &&
          (!Number.isInteger(member.fixedJobRateBps) ||
            member.fixedJobRateBps < 0),
      ) ||
      fixedRateTotalBps > DEFAULT_CREW_POOL_RATE_BPS
    ) {
      return {
        ok: false,
        normalizedMemberIds: resolved.splits.map((split) => split.memberId),
        reason: "invalid_rule",
      };
    }

    return {
      ...resolved,
      splits: resolved.splits.map((split) => {
        const fixedJobRateBps = fixedRateByMemberId.get(split.memberId);
        return fixedJobRateBps === null || fixedJobRateBps === undefined
          ? split
          : { ...split, fixedJobRateBps };
      }),
    };
  } catch (error) {
    const code = extractPgCode(error);
    if (code === "42P01" || code === "42703") {
      throw commissionRecipientConfigurationFailure(
        "Apply the latest crew payout configuration migration before completing financial work.",
      );
    }
    throw error;
  }
}

function asWeekday(value: number): 1 | 2 | 3 | 4 | 5 | 6 | 7 {
  if (
    value === 1 ||
    value === 2 ||
    value === 3 ||
    value === 4 ||
    value === 5 ||
    value === 6 ||
    value === 7
  ) {
    return value;
  }
  return 5;
}

export function bpsFromPercent(percent: number): number {
  return Math.round(percent * 100);
}

export function percentFromBps(bps: number): number {
  return bps / 100;
}

export async function getOrCreateCommissionSettings(
  db: DatabaseClient,
): Promise<CommissionSettingsRow> {
  const [existing] = await db
    .select({
      key: commissionSettings.key,
      timezone: commissionSettings.timezone,
      payoutWeekday: commissionSettings.payoutWeekday,
      payoutHour: commissionSettings.payoutHour,
      payoutMinute: commissionSettings.payoutMinute,
      salesRateBps: commissionSettings.salesRateBps,
      marketingRateBps: commissionSettings.marketingRateBps,
      crewPoolRateBps: commissionSettings.crewPoolRateBps,
      marketingMemberId: commissionSettings.marketingMemberId,
    })
    .from(commissionSettings)
    .where(eq(commissionSettings.key, SETTINGS_KEY))
    .limit(1);

  if (existing)
    return {
      ...existing,
      payoutWeekday: asWeekday(existing.payoutWeekday),
      salesRateBps: DEFAULT_SALES_RATE_BPS,
      marketingRateBps: DEFAULT_MANAGEMENT_RATE_BPS,
      crewPoolRateBps: DEFAULT_CREW_POOL_RATE_BPS,
      marketingMemberId: null,
    };

  await db
    .insert(commissionSettings)
    .values({
      key: SETTINGS_KEY,
      timezone: "America/New_York",
      payoutWeekday: 1,
      payoutHour: 12,
      payoutMinute: 0,
      salesRateBps: DEFAULT_SALES_RATE_BPS,
      marketingRateBps: DEFAULT_MANAGEMENT_RATE_BPS,
      crewPoolRateBps: DEFAULT_CREW_POOL_RATE_BPS,
      marketingMemberId: null,
      updatedBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing({ target: commissionSettings.key });

  const [created] = await db
    .select({
      key: commissionSettings.key,
      timezone: commissionSettings.timezone,
      payoutWeekday: commissionSettings.payoutWeekday,
      payoutHour: commissionSettings.payoutHour,
      payoutMinute: commissionSettings.payoutMinute,
      salesRateBps: commissionSettings.salesRateBps,
      marketingRateBps: commissionSettings.marketingRateBps,
      crewPoolRateBps: commissionSettings.crewPoolRateBps,
      marketingMemberId: commissionSettings.marketingMemberId,
    })
    .from(commissionSettings)
    .where(eq(commissionSettings.key, SETTINGS_KEY))
    .limit(1);

  if (!created) {
    throw new Error("commission_settings_missing");
  }

  return {
    ...created,
    payoutWeekday: asWeekday(created.payoutWeekday),
    salesRateBps: DEFAULT_SALES_RATE_BPS,
    marketingRateBps: DEFAULT_MANAGEMENT_RATE_BPS,
    crewPoolRateBps: DEFAULT_CREW_POOL_RATE_BPS,
    marketingMemberId: null,
  };
}

export function resolveCurrentPayoutPeriod(
  now: Date,
  settings: Pick<
    CommissionSettingsRow,
    "timezone" | "payoutHour" | "payoutMinute"
  >,
) {
  const zoned = DateTime.fromJSDate(now).setZone(settings.timezone);
  const periodStart = zoned.startOf("week");
  const periodEnd = periodStart.plus({ weeks: 1 });
  const scheduledPayoutAt = periodEnd.set({
    hour: settings.payoutHour,
    minute: settings.payoutMinute,
    second: 0,
    millisecond: 0,
  });

  return {
    timezone: settings.timezone,
    periodStart: periodStart.toJSDate(),
    periodEnd: periodEnd.toJSDate(),
    scheduledPayoutAt: scheduledPayoutAt.toJSDate(),
  };
}

export type CompletedAppointmentPayoutPeriodRun = {
  id: string;
  status: "draft" | "locked" | "paid";
};

export type CompletedAppointmentPayoutPeriodDecision =
  | { ok: true; payoutRunIds: string[] }
  | {
      ok: false;
      finalizedRunId: string;
      finalizedRunStatus: "locked" | "paid";
    };

/**
 * A historical duplicate which was locked or paid is still financial truth,
 * even if it is not the row currently marked canonical. Never rewrite the
 * underlying commission source while any run for that period is finalized.
 */
export function decideCompletedAppointmentPayoutPeriod(
  runs: readonly CompletedAppointmentPayoutPeriodRun[],
): CompletedAppointmentPayoutPeriodDecision {
  const ordered = [...runs].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const finalized = ordered.find(
    (
      run,
    ): run is CompletedAppointmentPayoutPeriodRun & {
      status: "locked" | "paid";
    } => run.status === "locked" || run.status === "paid",
  );
  if (finalized) {
    return {
      ok: false,
      finalizedRunId: finalized.id,
      finalizedRunStatus: finalized.status,
    };
  }
  return {
    ok: true,
    payoutRunIds: ordered.map((run) => run.id),
  };
}

export type CompletedAppointmentPayoutPeriodLock =
  | {
      ok: true;
      timezone: string;
      periodStart: Date;
      periodEnd: Date;
      payoutRunIds: string[];
    }
  | {
      ok: false;
      reason: "completion_time_missing" | "payout_period_finalized";
      timezone: string | null;
      periodStart: Date | null;
      periodEnd: Date | null;
      finalizedRunId?: string;
      finalizedRunStatus?: "locked" | "paid";
    };

function payoutPeriodLockKey(input: {
  timezone: string;
  periodStart: Date;
  periodEnd: Date;
}): string {
  return [
    "payout_run_period",
    input.timezone,
    input.periodStart.toISOString(),
    input.periodEnd.toISOString(),
  ].join(":");
}

async function acquirePayoutReportAdvisoryLock(
  tx: TransactionExecutor,
  payoutRunId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext('payout_run_report'), hashtext(${payoutRunId}))`,
  );
}

/**
 * Resolve a completed appointment against a settings row locked for the
 * caller's full transaction, then serialize that period against payout-run
 * creation, report materialization, and finalization. Locks are intentionally
 * ordered period -> report IDs -> payout rows to avoid cross-route deadlocks.
 */
export async function lockCompletedAppointmentPayoutPeriodInTransaction(
  tx: TransactionExecutor,
  completedAt: Date | null,
): Promise<CompletedAppointmentPayoutPeriodLock> {
  if (!completedAt || !Number.isFinite(completedAt.getTime())) {
    return {
      ok: false,
      reason: "completion_time_missing",
      timezone: null,
      periodStart: null,
      periodEnd: null,
    };
  }

  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext('commission_settings'), hashtext(${SETTINGS_KEY}))`,
  );
  const transactionDb = tx as unknown as DatabaseClient;
  await getOrCreateCommissionSettings(transactionDb);
  const [settings] = await tx
    .select({
      timezone: commissionSettings.timezone,
      payoutHour: commissionSettings.payoutHour,
      payoutMinute: commissionSettings.payoutMinute,
    })
    .from(commissionSettings)
    .where(eq(commissionSettings.key, SETTINGS_KEY))
    .for("update")
    .limit(1);
  if (!settings) throw new Error("commission_settings_missing");

  const completed = DateTime.fromJSDate(completedAt, {
    zone: settings.timezone,
  });
  if (!completed.isValid)
    throw new Error("payout_period_configuration_invalid");
  const period = resolveCurrentPayoutPeriod(completedAt, settings);
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${payoutPeriodLockKey(period)}))`,
  );

  // Discover stable IDs under the period lock, then acquire per-report locks
  // before row locks. All affected rows are re-read after those locks.
  const discoveredRuns = await tx
    .select({ id: payoutRuns.id })
    .from(payoutRuns)
    .where(
      and(
        eq(payoutRuns.timezone, period.timezone),
        eq(payoutRuns.periodStart, period.periodStart),
        eq(payoutRuns.periodEnd, period.periodEnd),
      ),
    )
    .orderBy(payoutRuns.id);
  for (const payoutRunId of discoveredRuns.map((run) => run.id)) {
    await acquirePayoutReportAdvisoryLock(tx, payoutRunId);
  }

  const periodRuns = await tx
    .select({ id: payoutRuns.id, status: payoutRuns.status })
    .from(payoutRuns)
    .where(
      and(
        eq(payoutRuns.timezone, period.timezone),
        eq(payoutRuns.periodStart, period.periodStart),
        eq(payoutRuns.periodEnd, period.periodEnd),
      ),
    )
    .orderBy(payoutRuns.id)
    .for("update");
  const decision = decideCompletedAppointmentPayoutPeriod(periodRuns);
  if (!decision.ok) {
    return {
      ok: false,
      reason: "payout_period_finalized",
      timezone: period.timezone,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      finalizedRunId: decision.finalizedRunId,
      finalizedRunStatus: decision.finalizedRunStatus,
    };
  }
  return {
    ok: true,
    timezone: period.timezone,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    payoutRunIds: decision.payoutRunIds,
  };
}

function roundCents(amount: number): number {
  return Math.round(amount);
}

function computeBpsAmount(baseCents: number, rateBps: number): number {
  return roundCents((baseCents * rateBps) / 10000);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractPgCode(error: unknown): string | null {
  const direct = isRecord(error) ? error : null;
  const directCode =
    direct && typeof direct["code"] === "string" ? direct["code"] : null;
  if (directCode) return directCode;
  const cause = direct && isRecord(direct["cause"]) ? direct["cause"] : null;
  const causeCode =
    cause && typeof cause["code"] === "string" ? cause["code"] : null;
  return causeCode;
}

export function isDemoServicesRequested(
  servicesRequested: string[] | null | undefined,
): boolean {
  if (!Array.isArray(servicesRequested) || servicesRequested.length === 0) {
    return false;
  }

  return servicesRequested.some((service) => {
    if (typeof service !== "string") return false;
    const normalized = service.trim().toLowerCase();
    return (
      normalized === "demo-hauloff" ||
      normalized.startsWith("demo_") ||
      normalized.startsWith("demo-")
    );
  });
}

export function isDemoBookingDetails(bookingDetails: unknown): boolean {
  if (!isRecord(bookingDetails)) {
    return false;
  }

  const serviceType = bookingDetails["serviceType"];
  return (
    typeof serviceType === "string" &&
    serviceType.trim().toLowerCase() === "demolition"
  );
}

export function isDemoCommissionJob(input: {
  servicesRequested?: string[] | null;
  bookingDetails?: unknown;
}): boolean {
  return (
    isDemoServicesRequested(input.servicesRequested) ||
    isDemoBookingDetails(input.bookingDetails)
  );
}

export function allocateCrewPoolCents(
  poolCents: number,
  crew: Array<{ memberId: string; splitBps: number }>,
): Array<{
  memberId: string;
  splitBps: number;
  cents: number;
  remainder: number;
}> {
  const totalSplitBps = crew.reduce(
    (sum, entry) => sum + Math.max(0, entry.splitBps ?? 0),
    0,
  );

  if (poolCents <= 0 || totalSplitBps <= 0 || crew.length === 0) {
    return [];
  }

  const allocations = crew.map((entry) => {
    const numerator = poolCents * entry.splitBps;
    const quotient = Math.floor(numerator / totalSplitBps);
    const remainder = numerator % totalSplitBps;
    return {
      memberId: entry.memberId,
      splitBps: entry.splitBps,
      cents: quotient,
      remainder,
    };
  });

  const allocated = allocations.reduce((sum, entry) => sum + entry.cents, 0);
  let remaining = poolCents - allocated;
  allocations.sort((a, b) => {
    if (b.remainder !== a.remainder) return b.remainder - a.remainder;
    return a.memberId.localeCompare(b.memberId);
  });

  for (let i = 0; i < allocations.length && remaining > 0; i += 1) {
    allocations[i]!.cents += 1;
    remaining -= 1;
  }

  return allocations;
}

export function allocateCrewCompensationCents(
  baseCents: number,
  poolCents: number,
  crew: Array<{
    memberId: string;
    splitBps: number;
    fixedJobRateBps?: number | null;
  }>,
): Array<{
  memberId: string;
  splitBps: number;
  fixedJobRateBps: number | null;
  cents: number;
  remainder: number;
}> {
  if (baseCents <= 0 || poolCents <= 0 || crew.length === 0) return [];

  const fixed = crew
    .filter(
      (entry) =>
        entry.fixedJobRateBps !== null && entry.fixedJobRateBps !== undefined,
    )
    .map((entry) => ({
      memberId: entry.memberId,
      splitBps: entry.splitBps,
      fixedJobRateBps: entry.fixedJobRateBps!,
      cents: computeBpsAmount(baseCents, entry.fixedJobRateBps!),
      remainder: 0,
    }));
  const fixedCents = fixed.reduce((sum, entry) => sum + entry.cents, 0);
  if (fixedCents > poolCents) {
    throw commissionRecipientConfigurationFailure(
      "Guaranteed crew labor rates exceed the configured crew pool.",
    );
  }

  const flexible = crew.filter(
    (entry) =>
      entry.fixedJobRateBps === null || entry.fixedJobRateBps === undefined,
  );
  const flexibleAllocations = allocateCrewPoolCents(
    poolCents - fixedCents,
    flexible,
  ).map((entry) => ({ ...entry, fixedJobRateBps: null }));

  return [...fixed, ...flexibleAllocations].sort((left, right) =>
    left.memberId.localeCompare(right.memberId),
  );
}

function getEffectiveCrewPoolRateBps(
  _tx: Pick<DatabaseClient, "select">,
  input: {
    defaultCrewPoolRateBps: number;
  },
): {
  crewPoolRateBps: number;
  overrideLocalDate: string | null;
  source: "default";
} {
  return {
    crewPoolRateBps: input.defaultCrewPoolRateBps,
    overrideLocalDate: null,
    source: "default",
  };
}

async function savePayoutRunReportHtmlSerialized(
  tx: TransactionExecutor,
  payoutRunId: string,
  options: { draftOnly?: boolean } = {},
): Promise<Awaited<ReturnType<typeof savePayoutRunReportHtml>> | null> {
  await acquirePayoutReportAdvisoryLock(tx, payoutRunId);
  const [run] = await tx
    .select({ id: payoutRuns.id, status: payoutRuns.status })
    .from(payoutRuns)
    .where(eq(payoutRuns.id, payoutRunId))
    .for("update")
    .limit(1);
  if (!run) throw new Error("payout_run_not_found");
  if (options.draftOnly && run.status !== "draft") return null;
  return savePayoutRunReportHtml(tx, payoutRunId);
}

async function refreshDraftPayoutReports(
  db: DatabaseClient,
  options: { payoutRunIds?: readonly string[] } = {},
): Promise<void> {
  const payoutRunIds = options.payoutRunIds
    ? [...new Set(options.payoutRunIds)].sort()
    : (
        await db
          .select({ id: payoutRuns.id })
          .from(payoutRuns)
          .where(eq(payoutRuns.status, "draft"))
          .orderBy(payoutRuns.id)
      ).map((run) => run.id);

  for (const payoutRunId of payoutRunIds) {
    await db.transaction(async (tx) => {
      await savePayoutRunReportHtmlSerialized(tx, payoutRunId, {
        draftOnly: true,
      });
    });
  }
}

async function readCommissionManagementSplits(
  tx: TransactionExecutor,
  managementRateBps: number,
): Promise<CommissionManagementSplit[]> {
  if (managementRateBps <= 0) return [];

  let splits: CommissionManagementSplit[];
  try {
    splits = await tx
      .select({
        memberId: commissionManagementSplits.memberId,
        splitBps: commissionManagementSplits.splitBps,
      })
      .from(commissionManagementSplits)
      .where(
        and(
          eq(commissionManagementSplits.settingsKey, SETTINGS_KEY),
          eq(commissionManagementSplits.enabled, true),
        ),
      )
      .orderBy(commissionManagementSplits.memberId)
      .for("share");
  } catch (error) {
    const code = extractPgCode(error);
    if (code === "42P01" || code === "42703") {
      throw commissionRecipientConfigurationFailure(
        "Apply the latest commission configuration migration before completing financial work.",
      );
    }
    throw error;
  }

  validateCommissionManagementSplits(managementRateBps, splits);
  return splits;
}

async function validateCommissionRowsBeforeWrite(
  tx: TransactionExecutor,
  rows: ReadonlyArray<{ memberId?: string | null }>,
): Promise<void> {
  const recipientIds = Array.from(
    new Set(
      rows.flatMap((row) =>
        typeof row.memberId === "string" && row.memberId.length > 0
          ? [row.memberId]
          : [],
      ),
    ),
  ).sort();
  if (recipientIds.length === 0) return;

  let members: CommissionRecipientMember[];
  try {
    members = await tx
      .select({ id: teamMembers.id, active: teamMembers.active })
      .from(teamMembers)
      .where(inArray(teamMembers.id, recipientIds))
      // Hold eligibility stable until the appointment, commission rows,
      // payout report, audit event, and idempotency receipt all commit.
      .for("share");
  } catch (error) {
    const code = extractPgCode(error);
    if (code === "42P01" || code === "42703") {
      throw commissionRecipientConfigurationFailure(
        "Team-member eligibility storage is unavailable. Apply the latest database migrations.",
      );
    }
    throw error;
  }
  validateCommissionRecipientMembers(recipientIds, members);
}

export async function recalculateAppointmentCommissions(
  db: DatabaseClient,
  appointmentId: string,
  options: { failClosedOnSchemaMismatch?: boolean } = {},
): Promise<void> {
  let settings: CommissionSettingsRow;
  try {
    settings = await getOrCreateCommissionSettings(db);
  } catch (error) {
    const code = extractPgCode(error);
    if (
      !options.failClosedOnSchemaMismatch &&
      (code === "42P01" || code === "42703")
    ) {
      return;
    }
    if (code === "42P01" || code === "42703") {
      throw commissionRecipientConfigurationFailure(
        "Apply the latest commission database migrations before completing financial work.",
      );
    }
    throw error;
  }

  try {
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext('appointment_commissions'), hashtext(${appointmentId}))`,
      );

      let row:
        | {
            id: string;
            status: string | null;
            finalTotalCents: number | null;
            soldByMemberId: string | null;
            marketingMemberId: string | null;
          }
        | undefined;

      try {
        const [full] = await tx
          .select({
            id: appointments.id,
            status: appointments.status,
            finalTotalCents: appointments.finalTotalCents,
            soldByMemberId: appointments.soldByMemberId,
            marketingMemberId: appointments.marketingMemberId,
          })
          .from(appointments)
          .where(eq(appointments.id, appointmentId))
          .limit(1);
        row = full;
      } catch (error) {
        const code = extractPgCode(error);
        if (code !== "42703" || options.failClosedOnSchemaMismatch) {
          throw error;
        }

        const [fallback] = await tx
          .select({
            id: appointments.id,
            status: appointments.status,
            finalTotalCents: appointments.finalTotalCents,
          })
          .from(appointments)
          .where(eq(appointments.id, appointmentId))
          .limit(1);

        row = fallback
          ? {
              ...fallback,
              soldByMemberId: null,
              marketingMemberId: null,
            }
          : undefined;
      }

      if (!row) {
        throw new Error("appointment_not_found");
      }

      const baseCents =
        row.status === "completed" && typeof row.finalTotalCents === "number"
          ? row.finalTotalCents
          : null;

      if (baseCents === null) {
        try {
          await tx
            .delete(appointmentCommissions)
            .where(eq(appointmentCommissions.appointmentId, appointmentId));
        } catch (error) {
          const code = extractPgCode(error);
          if (
            !options.failClosedOnSchemaMismatch &&
            (code === "42P01" || code === "42703")
          ) {
            return;
          }
          if (code === "42P01" || code === "42703") {
            throw commissionRecipientConfigurationFailure(
              "Apply the latest commission database migrations before changing completed financial work.",
            );
          }
          throw error;
        }
        return;
      }

      const commissionRows: Array<typeof appointmentCommissions.$inferInsert> =
        [];

      const soldBy = row.soldByMemberId ?? null;
      if (soldBy && settings.salesRateBps > 0) {
        commissionRows.push({
          appointmentId,
          memberId: soldBy,
          role: "sales",
          baseCents,
          amountCents: computeBpsAmount(baseCents, settings.salesRateBps),
          meta: { rateBps: settings.salesRateBps },
        });
      }

      const managementPoolCents = computeBpsAmount(
        baseCents,
        settings.marketingRateBps,
      );
      const managementSplits = await readCommissionManagementSplits(
        tx,
        settings.marketingRateBps,
      );
      const managementTotalSplitBps = managementSplits.reduce(
        (sum, entry) => sum + entry.splitBps,
        0,
      );
      for (const entry of allocateCrewPoolCents(
        managementPoolCents,
        managementSplits,
      )) {
        commissionRows.push({
          appointmentId,
          memberId: entry.memberId,
          role: "marketing",
          baseCents,
          amountCents: entry.cents,
          meta: {
            rateBps: settings.marketingRateBps,
            totalRateBps: settings.marketingRateBps,
            splitBps: entry.splitBps,
            totalSplitBps: managementTotalSplitBps,
            poolLabel: "management",
          },
        });
      }

      let crew: Array<{
        memberId: string;
        splitBps: number;
        fixedJobRateBps: number | null;
      }> = [];
      try {
        crew = await tx
          .select({
            memberId: appointmentCrewMembers.memberId,
            splitBps: appointmentCrewMembers.splitBps,
            fixedJobRateBps: appointmentCrewMembers.fixedJobRateBps,
          })
          .from(appointmentCrewMembers)
          .where(eq(appointmentCrewMembers.appointmentId, appointmentId));
      } catch (error) {
        const code = extractPgCode(error);
        if (
          options.failClosedOnSchemaMismatch ||
          (code !== "42P01" && code !== "42703")
        ) {
          throw error;
        }
        crew = [];
      }

      const totalSplitBps = crew.reduce(
        (sum, entry) => sum + (entry.splitBps ?? 0),
        0,
      );
      if (crew.length > 0 && totalSplitBps > 0) {
        const effectiveCrewPool = getEffectiveCrewPoolRateBps(tx, {
          defaultCrewPoolRateBps: settings.crewPoolRateBps,
        });
        const poolCents = computeBpsAmount(
          baseCents,
          effectiveCrewPool.crewPoolRateBps,
        );
        const allocations = allocateCrewCompensationCents(
          baseCents,
          poolCents,
          crew,
        );

        for (const entry of allocations) {
          commissionRows.push({
            appointmentId,
            memberId: entry.memberId,
            role: "crew",
            baseCents,
            amountCents: entry.cents,
            meta: {
              poolRateBps: effectiveCrewPool.crewPoolRateBps,
              splitBps: entry.splitBps,
              fixedJobRateBps: entry.fixedJobRateBps,
              totalSplitBps,
              poolSource: effectiveCrewPool.source,
              ...(effectiveCrewPool.overrideLocalDate
                ? { poolOverrideLocalDate: effectiveCrewPool.overrideLocalDate }
                : {}),
            },
          });
        }
      }

      // Do not delete or replace existing commission rows until every target
      // member has been proved present and active under a row lock. A missing
      // configuration is therefore a deterministic conflict, not a late FK
      // exception after the appointment mutation has started.
      await validateCommissionRowsBeforeWrite(tx, [
        ...commissionRows,
        ...managementSplits,
        ...(soldBy && settings.salesRateBps > 0 ? [{ memberId: soldBy }] : []),
        ...(totalSplitBps > 0 && settings.crewPoolRateBps > 0 ? crew : []),
      ]);

      try {
        await tx
          .delete(appointmentCommissions)
          .where(eq(appointmentCommissions.appointmentId, appointmentId));
      } catch (error) {
        const code = extractPgCode(error);
        if (
          !options.failClosedOnSchemaMismatch &&
          (code === "42P01" || code === "42703")
        ) {
          return;
        }
        if (code === "42P01" || code === "42703") {
          throw commissionRecipientConfigurationFailure(
            "Apply the latest commission database migrations before completing financial work.",
          );
        }
        throw error;
      }

      if (commissionRows.length > 0) {
        const now = new Date();
        try {
          await tx
            .insert(appointmentCommissions)
            .values(
              commissionRows.map((rowInsert) => ({
                ...rowInsert,
                createdAt: now,
                updatedAt: now,
              })),
            )
            .onConflictDoUpdate({
              target: [
                appointmentCommissions.appointmentId,
                appointmentCommissions.role,
                appointmentCommissions.memberId,
              ],
              set: {
                baseCents: sql`excluded.base_cents`,
                amountCents: sql`excluded.amount_cents`,
                meta: sql`excluded.meta`,
                updatedAt: now,
              },
            });
        } catch (error) {
          const code = extractPgCode(error);
          if (code === "23503") {
            throw commissionRecipientConfigurationFailure(
              "A configured commission recipient is no longer an eligible team member.",
            );
          }
          if (
            options.failClosedOnSchemaMismatch ||
            (code !== "42P01" && code !== "42703")
          ) {
            throw error;
          }
        }
      }
    });
  } catch (error) {
    const code = extractPgCode(error);
    if (
      !options.failClosedOnSchemaMismatch &&
      (code === "42P01" || code === "42703")
    ) {
      return;
    }
    if (code === "42P01" || code === "42703") {
      throw commissionRecipientConfigurationFailure(
        "Apply the latest commission database migrations before completing financial work.",
      );
    }
    throw error;
  }
}

export async function recalculateAppointmentCommissionsAndRefreshDraftPayouts(
  db: DatabaseClient,
  appointmentId: string,
): Promise<void> {
  await recalculateAppointmentCommissions(db, appointmentId);
  await refreshDraftPayoutReports(db);
}

/**
 * Strict transaction-bound variant for financial mutations. Drizzle executes
 * the nested commission transaction as a savepoint owned by the caller's
 * transaction, so commission rows and draft payout materializations commit or
 * roll back with the appointment, audit event, and idempotency receipt.
 */
export async function recalculateAppointmentCommissionsAndRefreshDraftPayoutsInTransaction(
  tx: TransactionExecutor,
  appointmentId: string,
  options: { payoutRunIds?: readonly string[] } = {},
): Promise<void> {
  const transactionDb = tx as unknown as DatabaseClient;
  await recalculateAppointmentCommissions(transactionDb, appointmentId, {
    failClosedOnSchemaMismatch: true,
  });
  await refreshDraftPayoutReports(transactionDb, {
    payoutRunIds: options.payoutRunIds,
  });
}

export type CreatePayoutRunData = {
  payoutRunId: string;
  created: boolean;
  status: "draft" | "locked" | "paid";
  version: string;
  reportGeneratedAt: string | null;
};

export type CreatePayoutRunResult = CreatePayoutRunData & {
  mutationResult?: PayoutRunMutationSuccess<CreatePayoutRunData>;
};

export async function createOrGetCurrentPayoutRun(
  db: DatabaseClient,
  input: {
    actorId?: string | null;
    actor?: AuditActor;
    execution?: PayoutRunMutationExecution;
  },
): Promise<CreatePayoutRunResult> {
  const settings = await getOrCreateCommissionSettings(db);
  const period = resolveCurrentPayoutPeriod(new Date(), settings);
  const actor = resolveCommissionActor(input);
  await recalculatePayoutPeriodAppointments(
    db,
    period.periodStart,
    period.periodEnd,
    { refreshDraftReports: false },
  );

  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${payoutPeriodLockKey(period)}))`,
    );

    const canonicalPeriodWhere = and(
      eq(payoutRuns.timezone, period.timezone),
      eq(payoutRuns.periodStart, period.periodStart),
      eq(payoutRuns.periodEnd, period.periodEnd),
      eq(payoutRuns.periodCanonical, true),
    );
    const [existing] = await tx
      .select({
        id: payoutRuns.id,
        status: payoutRuns.status,
        updatedAt: payoutRuns.updatedAt,
        reportGeneratedAt: payoutRuns.reportGeneratedAt,
      })
      .from(payoutRuns)
      .where(canonicalPeriodWhere)
      .limit(1);

    if (existing?.id) {
      const report =
        existing.status === "draft"
          ? await savePayoutRunReportHtmlSerialized(tx, existing.id, {
              draftOnly: true,
            })
          : null;
      const data: CreatePayoutRunData = {
        payoutRunId: existing.id,
        created: false,
        status: existing.status,
        version: payoutRunVersion(existing.updatedAt),
        reportGeneratedAt:
          report?.report.generatedAt.toISOString() ??
          existing.reportGeneratedAt?.toISOString() ??
          null,
      };
      const mutationResult = await finalizePayoutRunMutation(tx, {
        actor,
        action: "commission.payout_run.created",
        data,
        metadata: {
          outcome: "idempotent",
          created: false,
          timezone: period.timezone,
          periodStart: period.periodStart.toISOString(),
          periodEnd: period.periodEnd.toISOString(),
        },
        execution: input.execution,
      });
      return { ...data, ...(mutationResult ? { mutationResult } : {}) };
    }

    const now = new Date();
    const [created] = await tx
      .insert(payoutRuns)
      .values({
        timezone: period.timezone,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        scheduledPayoutAt: period.scheduledPayoutAt,
        periodCanonical: true,
        status: "draft",
        createdBy: actor.id ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning({
        id: payoutRuns.id,
        status: payoutRuns.status,
        updatedAt: payoutRuns.updatedAt,
      });

    if (created?.id) {
      const report = await savePayoutRunReportHtmlSerialized(tx, created.id, {
        draftOnly: true,
      });
      if (!report) throw new Error("payout_run_report_state_conflict");
      const data: CreatePayoutRunData = {
        payoutRunId: created.id,
        created: true,
        status: created.status,
        version: payoutRunVersion(created.updatedAt),
        reportGeneratedAt: report.report.generatedAt.toISOString(),
      };
      const mutationResult = await finalizePayoutRunMutation(tx, {
        actor,
        action: "commission.payout_run.created",
        data,
        metadata: {
          outcome: "succeeded",
          created: true,
          timezone: period.timezone,
          periodStart: period.periodStart.toISOString(),
          periodEnd: period.periodEnd.toISOString(),
        },
        execution: input.execution,
      });
      return { ...data, ...(mutationResult ? { mutationResult } : {}) };
    }

    const [concurrent] = await tx
      .select({
        id: payoutRuns.id,
        status: payoutRuns.status,
        updatedAt: payoutRuns.updatedAt,
        reportGeneratedAt: payoutRuns.reportGeneratedAt,
      })
      .from(payoutRuns)
      .where(canonicalPeriodWhere)
      .limit(1);
    if (!concurrent?.id) throw new Error("payout_run_create_failed");
    const report =
      concurrent.status === "draft"
        ? await savePayoutRunReportHtmlSerialized(tx, concurrent.id, {
            draftOnly: true,
          })
        : null;
    const data: CreatePayoutRunData = {
      payoutRunId: concurrent.id,
      created: false,
      status: concurrent.status,
      version: payoutRunVersion(concurrent.updatedAt),
      reportGeneratedAt:
        report?.report.generatedAt.toISOString() ??
        concurrent.reportGeneratedAt?.toISOString() ??
        null,
    };
    const mutationResult = await finalizePayoutRunMutation(tx, {
      actor,
      action: "commission.payout_run.created",
      data,
      metadata: {
        outcome: "idempotent",
        created: false,
        concurrentCreate: true,
        timezone: period.timezone,
        periodStart: period.periodStart.toISOString(),
        periodEnd: period.periodEnd.toISOString(),
      },
      execution: input.execution,
    });
    return { ...data, ...(mutationResult ? { mutationResult } : {}) };
  });
  return result;
}

async function recalculatePayoutPeriodAppointments(
  db: DatabaseClient,
  periodStart: Date,
  periodEnd: Date,
  options: { refreshDraftReports?: boolean } = {},
): Promise<void> {
  const rows = await db
    .select({ id: appointments.id })
    .from(appointments)
    .where(
      and(
        eq(appointments.status, "completed"),
        gte(appointments.completedAt, periodStart),
        lt(appointments.completedAt, periodEnd),
      ),
    );

  for (const row of rows) {
    await recalculateAppointmentCommissions(db, row.id);
  }

  if (options.refreshDraftReports !== false) {
    await refreshDraftPayoutReports(db);
  }
}

export async function recalculateCurrentPayoutPeriodAppointments(
  db: DatabaseClient,
): Promise<void> {
  const settings = await getOrCreateCommissionSettings(db);
  const period = resolveCurrentPayoutPeriod(new Date(), settings);
  await recalculatePayoutPeriodAppointments(
    db,
    period.periodStart,
    period.periodEnd,
  );
}

export async function lockPayoutRun(
  db: DatabaseClient,
  input: {
    payoutRunId: string;
    actorId?: string | null;
    actor?: AuditActor;
    execution?: PayoutRunMutationExecution;
  },
): Promise<PayoutRunTransitionResult> {
  const actor = resolveCommissionActor(input);
  const [snapshot] = await db
    .select({
      id: payoutRuns.id,
      status: payoutRuns.status,
      timezone: payoutRuns.timezone,
      periodStart: payoutRuns.periodStart,
      periodEnd: payoutRuns.periodEnd,
    })
    .from(payoutRuns)
    .where(eq(payoutRuns.id, input.payoutRunId))
    .limit(1);

  if (!snapshot) throw new Error("payout_run_not_found");
  const result = await db.transaction(async (tx) => {
    // Match appointment financial mutations: period -> report -> payout row.
    // Holding the period lock while sources are recalculated prevents an
    // appointment from committing new commission truth after this snapshot is
    // finalized.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${payoutPeriodLockKey(snapshot)}))`,
    );
    await acquirePayoutReportAdvisoryLock(tx, input.payoutRunId);
    const [run] = await tx
      .select({
        id: payoutRuns.id,
        status: payoutRuns.status,
        timezone: payoutRuns.timezone,
        periodStart: payoutRuns.periodStart,
        periodEnd: payoutRuns.periodEnd,
        updatedAt: payoutRuns.updatedAt,
      })
      .from(payoutRuns)
      .where(eq(payoutRuns.id, input.payoutRunId))
      .limit(1)
      .for("update");

    if (!run) throw new Error("payout_run_not_found");
    if (input.execution) {
      requirePayoutRunExpectedVersion(input.execution.mutation);
      assertTeamMutationExpectedVersion(
        input.execution.mutation,
        payoutRunVersion(run.updatedAt),
      );
    }
    const decision = decidePayoutRunTransition(run.status, "locked");
    if (!decision.changed) {
      const data: PayoutRunTransitionData = {
        payoutRunId: run.id,
        status: decision.status,
        changed: false,
        version: payoutRunVersion(run.updatedAt),
      };
      const mutationResult = await finalizePayoutRunMutation(tx, {
        actor,
        action: "commission.payout_run.locked",
        data,
        metadata: {
          outcome: "idempotent",
          priorStatus: run.status,
          resultingStatus: decision.status,
        },
        execution: input.execution,
      });
      return { ...data, ...(mutationResult ? { mutationResult } : {}) };
    }

    const attachedReimbursements =
      await attachApprovedReimbursementClaimsToDraftPayout(tx, {
        payoutRunId: input.payoutRunId,
        actorId: actor.id ?? null,
        touchPayoutRun: false,
      });

    await recalculatePayoutPeriodAppointments(
      tx as unknown as DatabaseClient,
      run.periodStart,
      run.periodEnd,
      { refreshDraftReports: false },
    );

    await tx
      .delete(payoutRunLines)
      .where(eq(payoutRunLines.payoutRunId, input.payoutRunId));

    const commissionRows = await tx
      .select({
        memberId: appointmentCommissions.memberId,
        role: appointmentCommissions.role,
        amountCents:
          sql<number>`sum(${appointmentCommissions.amountCents})`.mapWith(
            Number,
          ),
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
      )
      .groupBy(appointmentCommissions.memberId, appointmentCommissions.role);

    const adjustmentRows = await tx
      .select({
        memberId: payoutRunAdjustments.memberId,
        amountCents:
          sql<number>`sum(${payoutRunAdjustments.amountCents})`.mapWith(Number),
      })
      .from(payoutRunAdjustments)
      .where(eq(payoutRunAdjustments.payoutRunId, input.payoutRunId))
      .groupBy(payoutRunAdjustments.memberId);

    const adjustmentMap = new Map<string, number>();
    for (const row of adjustmentRows) {
      if (row.memberId)
        adjustmentMap.set(row.memberId, Number(row.amountCents ?? 0));
    }

    const memberIds = Array.from(
      new Set(
        commissionRows
          .map((row) => row.memberId)
          .filter((id): id is string => typeof id === "string"),
      ),
    );
    const members = memberIds.length
      ? await tx
          .select({ id: teamMembers.id })
          .from(teamMembers)
          .where(inArray(teamMembers.id, memberIds))
      : [];
    const memberSet = new Set(members.map((m) => m.id));

    type Totals = {
      sales: number;
      marketing: number;
      crew: number;
      adjustments: number;
    };
    const totalsByMember = new Map<string, Totals>();
    for (const row of commissionRows) {
      const memberId = row.memberId;
      if (!memberId || !memberSet.has(memberId)) continue;
      const totals = totalsByMember.get(memberId) ?? {
        sales: 0,
        marketing: 0,
        crew: 0,
        adjustments: 0,
      };
      const cents = Number(row.amountCents ?? 0);
      if (row.role === "sales") totals.sales += cents;
      if (row.role === "marketing") totals.marketing += cents;
      if (row.role === "crew") totals.crew += cents;
      totalsByMember.set(memberId, totals);
    }

    for (const [memberId, adjustment] of adjustmentMap.entries()) {
      const totals = totalsByMember.get(memberId) ?? {
        sales: 0,
        marketing: 0,
        crew: 0,
        adjustments: 0,
      };
      totals.adjustments += adjustment;
      totalsByMember.set(memberId, totals);
    }

    const lines: Array<typeof payoutRunLines.$inferInsert> = [];
    for (const [memberId, totals] of totalsByMember.entries()) {
      const totalCents =
        totals.sales + totals.marketing + totals.crew + totals.adjustments;
      lines.push({
        payoutRunId: input.payoutRunId,
        memberId,
        salesCents: totals.sales,
        marketingCents: totals.marketing,
        crewCents: totals.crew,
        adjustmentsCents: totals.adjustments,
        totalCents,
      });
    }

    if (lines.length > 0) {
      await tx
        .insert(payoutRunLines)
        .values(lines.map((line) => ({ ...line, createdAt: new Date() })));
    }

    const nextVersion = nextPayoutRunVersionDate(run.updatedAt);
    const [transitioned] = await tx
      .update(payoutRuns)
      .set({
        status: "locked",
        lockedAt: new Date(),
        updatedAt: nextVersion,
      })
      .where(
        and(
          eq(payoutRuns.id, input.payoutRunId),
          eq(payoutRuns.status, "draft"),
        ),
      )
      .returning({ id: payoutRuns.id, updatedAt: payoutRuns.updatedAt });

    if (!transitioned?.id) {
      throw new Error("payout_run_state_conflict");
    }

    await savePayoutRunReportHtmlSerialized(tx, input.payoutRunId);
    const data: PayoutRunTransitionData = {
      payoutRunId: run.id,
      status: "locked",
      changed: true,
      version: payoutRunVersion(transitioned.updatedAt),
    };
    const mutationResult = await finalizePayoutRunMutation(tx, {
      actor,
      action: "commission.payout_run.locked",
      data,
      metadata: {
        outcome: "succeeded",
        priorStatus: "draft",
        resultingStatus: "locked",
        lineCount: lines.length,
        reimbursementClaimsAttached: attachedReimbursements.length,
      },
      execution: input.execution,
    });

    return { ...data, ...(mutationResult ? { mutationResult } : {}) };
  });
  return result;
}

export async function markPayoutRunPaid(
  db: DatabaseClient,
  payoutRunId: string,
  input: {
    actorId?: string | null;
    actor?: AuditActor;
    execution?: PayoutRunMutationExecution;
  } = {},
): Promise<PayoutRunTransitionResult> {
  const now = new Date();
  const actor = resolveCommissionActor(input);
  if (!actor.id) {
    throw new TeamMutationFailure(
      "internal",
      "A verified team member is required to mark a payout paid.",
    );
  }

  return db.transaction(async (tx) => {
    const [run] = await tx
      .select({
        id: payoutRuns.id,
        status: payoutRuns.status,
        periodStart: payoutRuns.periodStart,
        periodEnd: payoutRuns.periodEnd,
        paidAt: payoutRuns.paidAt,
        updatedAt: payoutRuns.updatedAt,
      })
      .from(payoutRuns)
      .where(eq(payoutRuns.id, payoutRunId))
      .limit(1)
      .for("update");

    if (!run?.id) {
      throw new Error("payout_run_not_found");
    }
    if (input.execution) {
      requirePayoutRunExpectedVersion(input.execution.mutation);
      assertTeamMutationExpectedVersion(
        input.execution.mutation,
        payoutRunVersion(run.updatedAt),
      );
    }
    const decision = decidePayoutRunTransition(run.status, "paid");
    const changed = decision.changed;
    const actualPaidAt = changed ? now : run.paidAt;
    if (!actualPaidAt) {
      throw new Error("payout_run_paid_timestamp_missing");
    }
    let resultingVersion = run.updatedAt;
    let payrollExpenseChanged = false;
    if (changed) {
      const nextVersion = nextPayoutRunVersionDate(run.updatedAt, now);
      const [transitioned] = await tx
        .update(payoutRuns)
        .set({ status: "paid", paidAt: now, updatedAt: nextVersion })
        .where(
          and(eq(payoutRuns.id, payoutRunId), eq(payoutRuns.status, "locked")),
        )
        .returning({ id: payoutRuns.id, updatedAt: payoutRuns.updatedAt });
      if (!transitioned?.id) {
        throw new Error("payout_run_state_conflict");
      }
      resultingVersion = transitioned.updatedAt;
    }

    const expenseMemo = `payout_run:${payoutRunId}`;

    let [payrollExpense] = await tx
      .select({
        id: expenses.id,
        payoutRunId: expenses.payoutRunId,
        amount: expenses.amount,
        currency: expenses.currency,
        category: expenses.category,
        vendor: expenses.vendor,
        memo: expenses.memo,
        source: expenses.source,
        lifecycleStatus: expenses.lifecycleStatus,
        paidAt: expenses.paidAt,
        postedAt: expenses.postedAt,
        postedBy: expenses.postedBy,
        coverageStartAt: expenses.coverageStartAt,
        coverageEndAt: expenses.coverageEndAt,
      })
      .from(expenses)
      .where(
        or(
          eq(expenses.payoutRunId, payoutRunId),
          and(
            eq(expenses.source, "payout_run"),
            eq(expenses.memo, expenseMemo),
          ),
        ),
      )
      .orderBy(
        sql`case when ${expenses.payoutRunId} = ${payoutRunId} then 0 else 1 end`,
        expenses.createdAt,
      )
      .limit(1);

    const [totals] = await tx
      .select({
        totalCents: sql<number>`sum(${payoutRunLines.totalCents})`.mapWith(
          Number,
        ),
      })
      .from(payoutRunLines)
      .where(eq(payoutRunLines.payoutRunId, payoutRunId))
      .limit(1);

    const [reimbursementTotals] = await tx
      .select({
        totalCents:
          sql<number>`sum(case when ${payoutRunAdjustments.kind} = 'reimbursement' then ${payoutRunAdjustments.amountCents} else 0 end)`.mapWith(
            Number,
          ),
      })
      .from(payoutRunAdjustments)
      .where(eq(payoutRunAdjustments.payoutRunId, payoutRunId))
      .limit(1);

    const totalCents = Number(totals?.totalCents ?? 0);
    const reimbursementCents = Number(reimbursementTotals?.totalCents ?? 0);
    const payrollExpenseCents = totalCents - reimbursementCents;

    if (payrollExpense?.id) {
      const mismatches = getPayoutPayrollExpenseMismatches(payrollExpense, {
        payoutRunId,
        amount: payrollExpenseCents,
        paidAt: actualPaidAt,
        coverageStartAt: run.periodStart,
        coverageEndAt: run.periodEnd,
      });
      if (mismatches.length > 0) {
        throw new Error("payout_run_expense_reconciliation_required");
      }

      if (!payrollExpense.payoutRunId) {
        const [linkedExpense] = await tx
          .update(expenses)
          .set({ payoutRunId, updatedAt: now })
          .where(
            and(
              eq(expenses.id, payrollExpense.id),
              isNull(expenses.payoutRunId),
            ),
          )
          .returning({ id: expenses.id });
        if (!linkedExpense?.id) {
          throw new Error("payout_run_expense_reconciliation_required");
        }
        payrollExpense = { ...payrollExpense, payoutRunId };
        payrollExpenseChanged = true;
      }
    }

    if (payrollExpenseCents > 0 && !payrollExpense?.id) {
      const [createdExpense] = await tx
        .insert(expenses)
        .values({
          amount: payrollExpenseCents,
          currency: "USD",
          category: "Commissions",
          vendor: "Payouts",
          memo: expenseMemo,
          source: "payout_run",
          payoutRunId,
          lifecycleStatus: "posted",
          version: 1,
          paidAt: actualPaidAt,
          postedAt: now,
          postedBy: actor.id,
          coverageStartAt: run.periodStart,
          coverageEndAt: run.periodEnd,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: expenses.payoutRunId })
        .returning({
          id: expenses.id,
          payoutRunId: expenses.payoutRunId,
          amount: expenses.amount,
          currency: expenses.currency,
          category: expenses.category,
          vendor: expenses.vendor,
          memo: expenses.memo,
          source: expenses.source,
          lifecycleStatus: expenses.lifecycleStatus,
          paidAt: expenses.paidAt,
          postedAt: expenses.postedAt,
          postedBy: expenses.postedBy,
          coverageStartAt: expenses.coverageStartAt,
          coverageEndAt: expenses.coverageEndAt,
        });
      payrollExpense = createdExpense;
      payrollExpenseChanged = Boolean(createdExpense?.id);

      if (!payrollExpense?.id) {
        [payrollExpense] = await tx
          .select({
            id: expenses.id,
            payoutRunId: expenses.payoutRunId,
            amount: expenses.amount,
            currency: expenses.currency,
            category: expenses.category,
            vendor: expenses.vendor,
            memo: expenses.memo,
            source: expenses.source,
            lifecycleStatus: expenses.lifecycleStatus,
            paidAt: expenses.paidAt,
            postedAt: expenses.postedAt,
            postedBy: expenses.postedBy,
            coverageStartAt: expenses.coverageStartAt,
            coverageEndAt: expenses.coverageEndAt,
          })
          .from(expenses)
          .where(eq(expenses.payoutRunId, payoutRunId))
          .limit(1);
      }
      if (!payrollExpense?.id) {
        throw new Error("payout_run_expense_create_failed");
      }
    }

    if (payrollExpense?.id) {
      const mismatches = getPayoutPayrollExpenseMismatches(payrollExpense, {
        payoutRunId,
        amount: payrollExpenseCents,
        paidAt: actualPaidAt,
        coverageStartAt: run.periodStart,
        coverageEndAt: run.periodEnd,
      });
      if (mismatches.length > 0) {
        throw new Error("payout_run_expense_reconciliation_required");
      }
    }

    if (!changed && payrollExpenseChanged) {
      const nextVersion = nextPayoutRunVersionDate(run.updatedAt, now);
      const [versionedRun] = await tx
        .update(payoutRuns)
        .set({ updatedAt: nextVersion })
        .where(
          and(eq(payoutRuns.id, payoutRunId), eq(payoutRuns.status, "paid")),
        )
        .returning({ updatedAt: payoutRuns.updatedAt });
      if (!versionedRun) throw new Error("payout_run_state_conflict");
      resultingVersion = versionedRun.updatedAt;
    }

    const reimbursementClaimsPaid = await markAttachedReimbursementClaimsPaid(
      tx,
      {
        payoutRunId,
        paidAt: actualPaidAt,
      },
    );

    const data: PayoutRunTransitionData = {
      payoutRunId,
      status: "paid",
      changed,
      version: payoutRunVersion(resultingVersion),
    };
    const mutationResult = await finalizePayoutRunMutation(tx, {
      actor,
      action: "commission.payout_run.paid",
      data,
      metadata: {
        outcome: changed ? "succeeded" : "idempotent",
        priorStatus: run.status,
        resultingStatus: "paid",
        payrollExpenseId: payrollExpense?.id ?? null,
        payrollExpenseCents: Math.max(payrollExpenseCents, 0),
        payrollExpenseChanged,
        payrollExpensePostedBy: payrollExpense?.postedBy ?? null,
        payrollExpensePaidAt: payrollExpense?.paidAt.toISOString() ?? null,
        reimbursementClaimsPaid,
      },
      execution: input.execution,
    });

    return { ...data, ...(mutationResult ? { mutationResult } : {}) };
  });
}

export async function recalculateCrewPoolOverrideDay(
  db: DatabaseClient,
  input: { localDate: string },
): Promise<void> {
  const settings = await getOrCreateCommissionSettings(db);
  const start = DateTime.fromISO(input.localDate, {
    zone: settings.timezone,
  }).startOf("day");
  if (!start.isValid) {
    throw new Error("invalid_local_date");
  }
  const end = start.plus({ days: 1 });

  const rows = await db
    .select({ id: appointments.id })
    .from(appointments)
    .where(
      and(
        eq(appointments.status, "completed"),
        gte(appointments.startAt, start.toJSDate()),
        lt(appointments.startAt, end.toJSDate()),
      ),
    );

  for (const row of rows) {
    await recalculateAppointmentCommissions(db, row.id);
  }

  await refreshDraftPayoutReports(db);
}

export async function ensureCrewPoolOverrideDayEditable(
  db: DatabaseClient,
  input: { localDate: string },
): Promise<void> {
  const settings = await getOrCreateCommissionSettings(db);
  const start = DateTime.fromISO(input.localDate, {
    zone: settings.timezone,
  }).startOf("day");
  if (!start.isValid) {
    throw new Error("invalid_local_date");
  }

  const periodStart = start.startOf("week");
  const periodEnd = periodStart.plus({ weeks: 1 });

  const [existingRun] = await db
    .select({
      status: payoutRuns.status,
    })
    .from(payoutRuns)
    .where(
      and(
        eq(payoutRuns.periodStart, periodStart.toJSDate()),
        eq(payoutRuns.periodEnd, periodEnd.toJSDate()),
      ),
    )
    .limit(1);

  if (existingRun && existingRun.status !== "draft") {
    throw new Error("payout_period_locked");
  }
}
