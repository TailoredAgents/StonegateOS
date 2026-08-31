import { DateTime } from "luxon";
import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import {
  getDb,
  partnerAccountMemberships,
  partnerRecurringOccurrences,
  partnerRecurringSeries,
  partnerUsers,
} from "@/db";
import { isOperationalFeatureEnabled } from "@/lib/feature-flags";
import { arePartnerPortalV2WritesEnabled } from "@/lib/partner-portal-feature-flags";
import {
  evaluateClaimedPartnerRecurringOccurrence,
  recordRecurringOccurrenceMaintenanceFailure,
} from "@/lib/partner-repeat-work";
import type { PartnerSchedulingActor } from "@/lib/partner-portal-v2-scheduling";

const DEFAULT_BATCH_LIMIT = 20;
const MAX_BATCH_LIMIT = 100;
const HORIZON_DAYS = 30;
const EVALUATION_LEASE_MINUTES = 15;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type RecurringHorizonPosition =
  | "elapsed"
  | "inside_horizon"
  | "outside_horizon";

export function recurringHorizonPosition(input: {
  localDate: string;
  timezone: string;
  now: Date;
}): RecurringHorizonPosition {
  const today = DateTime.fromJSDate(input.now, {
    zone: input.timezone,
  }).startOf("day");
  const occurrence = DateTime.fromISO(input.localDate, {
    zone: input.timezone,
  }).startOf("day");
  if (!occurrence.isValid) return "elapsed";
  if (occurrence < today.plus({ days: 1 })) return "elapsed";
  if (occurrence > today.plus({ days: HORIZON_DAYS })) {
    return "outside_horizon";
  }
  return "inside_horizon";
}

export function normalizeRecurringHorizonBatchLimit(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(MAX_BATCH_LIMIT, Math.max(1, Math.floor(value)))
    : DEFAULT_BATCH_LIMIT;
}

function configuredCanaryAccountIds(): readonly string[] {
  return Object.freeze(
    (process.env["PARTNER_PORTAL_V2_CANARY_ACCOUNT_IDS"] ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => UUID_PATTERN.test(value)),
  );
}

type ClaimedOccurrence = Readonly<{
  id: string;
  partnerAccountId: string;
  recurringSeriesId: string;
  localDate: string;
  timezone: string;
  createdByMembershipId: string;
  priorState: string;
}>;

async function claimDueOccurrences(input: {
  limit: number;
  now: Date;
}): Promise<{
  scanned: number;
  claimed: readonly ClaimedOccurrence[];
  skippedFeatureDisabled: number;
}> {
  const candidateUpperDate = DateTime.fromJSDate(input.now, { zone: "utc" })
    .plus({ days: HORIZON_DAYS + 2 })
    .toISODate();
  if (!candidateUpperDate) throw new Error("recurring_horizon_date_failed");
  const staleBefore = new Date(
    input.now.getTime() - EVALUATION_LEASE_MINUTES * 60_000,
  );
  const canaryAccountIds = configuredCanaryAccountIds();
  return getDb().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('partner_recurring_horizon_claim_v1'))`,
    );
    const candidates = await tx
      .select({
        id: partnerRecurringOccurrences.id,
        partnerAccountId: partnerRecurringOccurrences.partnerAccountId,
        recurringSeriesId: partnerRecurringOccurrences.recurringSeriesId,
        localDate: partnerRecurringOccurrences.localDate,
        timezone: partnerRecurringSeries.timezone,
        createdByMembershipId: partnerRecurringSeries.createdByMembershipId,
        priorState: partnerRecurringOccurrences.state,
      })
      .from(partnerRecurringOccurrences)
      .innerJoin(
        partnerRecurringSeries,
        and(
          eq(
            partnerRecurringSeries.partnerAccountId,
            partnerRecurringOccurrences.partnerAccountId,
          ),
          eq(
            partnerRecurringSeries.id,
            partnerRecurringOccurrences.recurringSeriesId,
          ),
        ),
      )
      .where(
        and(
          eq(partnerRecurringSeries.state, "active"),
          canaryAccountIds.length > 0
            ? inArray(
                partnerRecurringOccurrences.partnerAccountId,
                canaryAccountIds,
              )
            : undefined,
          lte(partnerRecurringOccurrences.localDate, candidateUpperDate),
          or(
            eq(partnerRecurringOccurrences.state, "tentative"),
            and(
              eq(partnerRecurringOccurrences.state, "evaluating"),
              or(
                isNull(partnerRecurringOccurrences.evaluatedAt),
                lt(partnerRecurringOccurrences.evaluatedAt, staleBefore),
              ),
            ),
          ),
        ),
      )
      .orderBy(
        asc(partnerRecurringOccurrences.localDate),
        asc(partnerRecurringOccurrences.id),
      )
      .limit(Math.min(MAX_BATCH_LIMIT * 4, input.limit * 4));

    const claimed: ClaimedOccurrence[] = [];
    let skippedFeatureDisabled = 0;
    for (const candidate of candidates) {
      if (claimed.length >= input.limit) break;
      const position = recurringHorizonPosition({
        localDate: candidate.localDate,
        timezone: candidate.timezone,
        now: input.now,
      });
      if (position === "outside_horizon") continue;
      if (!arePartnerPortalV2WritesEnabled(candidate.partnerAccountId)) {
        skippedFeatureDisabled += 1;
        continue;
      }
      const [updated] = await tx
        .update(partnerRecurringOccurrences)
        .set({
          state: "evaluating",
          evaluatedAt: input.now,
          evaluation: {
            reservationCreated: false,
            maintenanceLeaseAt: input.now.toISOString(),
          },
          updatedAt: input.now,
        })
        .where(
          and(
            eq(
              partnerRecurringOccurrences.partnerAccountId,
              candidate.partnerAccountId,
            ),
            eq(partnerRecurringOccurrences.id, candidate.id),
            or(
              eq(partnerRecurringOccurrences.state, "tentative"),
              and(
                eq(partnerRecurringOccurrences.state, "evaluating"),
                or(
                  isNull(partnerRecurringOccurrences.evaluatedAt),
                  lt(partnerRecurringOccurrences.evaluatedAt, staleBefore),
                ),
              ),
            ),
          ),
        )
        .returning({ id: partnerRecurringOccurrences.id });
      if (updated) claimed.push(Object.freeze(candidate));
    }
    return {
      scanned: candidates.length,
      claimed: Object.freeze(claimed),
      skippedFeatureDisabled,
    };
  });
}

async function loadMaintenanceActor(
  occurrence: ClaimedOccurrence,
): Promise<PartnerSchedulingActor | null> {
  const [row] = await getDb()
    .select({
      membershipId: partnerAccountMemberships.id,
      partnerAccountId: partnerAccountMemberships.partnerAccountId,
      partnerUserId: partnerAccountMemberships.partnerUserId,
      accessLevel: partnerAccountMemberships.accessLevel,
      accessScope: partnerAccountMemberships.accessScope,
      email: partnerUsers.email,
    })
    .from(partnerAccountMemberships)
    .innerJoin(
      partnerUsers,
      eq(partnerAccountMemberships.partnerUserId, partnerUsers.id),
    )
    .where(
      and(
        eq(partnerAccountMemberships.id, occurrence.createdByMembershipId),
        eq(
          partnerAccountMemberships.partnerAccountId,
          occurrence.partnerAccountId,
        ),
        eq(partnerAccountMemberships.status, "active"),
        eq(partnerUsers.active, true),
      ),
    )
    .limit(1);
  if (!row) return null;
  return Object.freeze({
    accountId: row.partnerAccountId,
    membershipId: row.membershipId,
    partnerUserId: row.partnerUserId,
    email: row.email,
    sessionId: null,
    accessLevel: row.accessLevel,
    canReadRates: true,
    locationIds: Object.freeze([...(row.accessScope.locationIds ?? [])]),
    propertyIds: Object.freeze([...(row.accessScope.propertyIds ?? [])]),
  });
}

export async function evaluateDuePartnerRecurringOccurrences(
  input: {
    limit?: number;
    now?: Date;
  } = {},
): Promise<{
  enabled: boolean;
  scanned: number;
  claimed: number;
  confirmed: number;
  review: number;
  failed: number;
  tentative: number;
  staffTasksCreated: number;
  recoveredStale: number;
  skippedFeatureDisabled: number;
}> {
  const empty = {
    scanned: 0,
    claimed: 0,
    confirmed: 0,
    review: 0,
    failed: 0,
    tentative: 0,
    staffTasksCreated: 0,
    recoveredStale: 0,
    skippedFeatureDisabled: 0,
  };
  if (
    !isOperationalFeatureEnabled("PARTNER_RECURRING_HORIZON_EVALUATOR_ENABLED")
  ) {
    return { enabled: false, ...empty };
  }
  if (
    !isOperationalFeatureEnabled("PARTNER_PORTAL_V2_READS_ENABLED") ||
    !isOperationalFeatureEnabled("PARTNER_PORTAL_V2_WRITES_ENABLED")
  ) {
    return { enabled: true, ...empty };
  }
  const now = input.now ?? new Date();
  const limit = normalizeRecurringHorizonBatchLimit(input.limit);
  const claim = await claimDueOccurrences({ limit, now });
  const counts = {
    ...empty,
    scanned: claim.scanned,
    claimed: claim.claimed.length,
    skippedFeatureDisabled: claim.skippedFeatureDisabled,
  };

  for (const occurrence of claim.claimed) {
    if (occurrence.priorState === "evaluating") counts.recoveredStale += 1;
    const actor = await loadMaintenanceActor(occurrence);
    if (!actor) {
      const task = await recordRecurringOccurrenceMaintenanceFailure({
        accountId: occurrence.partnerAccountId,
        seriesId: occurrence.recurringSeriesId,
        occurrenceId: occurrence.id,
        state: "review",
        reason: "recurring_owner_access_unavailable",
        now,
      });
      counts.review += 1;
      if (task.created) counts.staffTasksCreated += 1;
      continue;
    }
    try {
      const result = await evaluateClaimedPartnerRecurringOccurrence({
        actor,
        seriesId: occurrence.recurringSeriesId,
        occurrenceId: occurrence.id,
        correlationId: `partner-recurring-horizon:${occurrence.id}`,
        now,
      });
      if (result.state === "confirmed") counts.confirmed += 1;
      else if (result.state === "failed") counts.failed += 1;
      else if (result.state === "review") counts.review += 1;
      else counts.tentative += 1;
      if (result.taskCreated) counts.staffTasksCreated += 1;
    } catch {
      const task = await recordRecurringOccurrenceMaintenanceFailure({
        accountId: occurrence.partnerAccountId,
        seriesId: occurrence.recurringSeriesId,
        occurrenceId: occurrence.id,
        state: "failed",
        reason: "maintenance_evaluation_failed",
        now,
      });
      counts.failed += 1;
      if (task.created) counts.staffTasksCreated += 1;
    }
  }
  return { enabled: true, ...counts };
}
