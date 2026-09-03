import { DateTime } from "luxon";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { getDb, webEventCountsDaily } from "@/db";
import {
  parsePartnerFunnelKey,
  PARTNER_FUNNEL_PERSONAS,
  PARTNER_FUNNEL_STAGES,
  type PartnerFunnelPersona,
  type PartnerFunnelStage,
} from "@/lib/partner-product-analytics";

export const PARTNER_OPERATIONS_RANGE_DAYS = [1, 7, 14, 30] as const;
export type PartnerOperationsRangeDays =
  (typeof PARTNER_OPERATIONS_RANGE_DAYS)[number];

const STAGE_LABELS: Readonly<Record<PartnerFunnelStage, string>> = {
  access_request_started: "Access request started",
  verification_request_accepted: "Verification request accepted",
  booking_started: "Booking started",
  availability_requested: "Availability requested",
  availability_available: "Bookable windows returned",
  availability_slot_full: "No open window returned",
  availability_review_only: "Review-only availability",
  availability_degraded: "Availability dependency degraded",
  slot_contention: "Selected slot was taken",
  booking_submitted: "Booking submitted",
  booking_confirmed: "Booking confirmed",
  booking_review_requested: "Review request submitted",
  booking_failed: "Booking submission failed",
  booking_abandoned: "Booking abandoned",
  upload_started: "Upload started",
  upload_completed: "Upload completed",
  upload_failed: "Upload failed",
  upload_interrupted: "Upload interrupted",
};

const PERSONA_LABELS: Readonly<Record<PartnerFunnelPersona, string>> = {
  contractor: "Contractor",
  real_estate_agent: "Real-estate agent",
  property_manager: "Property manager",
  commercial_client: "Commercial client",
  other: "Other",
  unknown: "Unknown / unmapped",
};

type FunnelCountRow = { key: string; count: number | string | bigint };

function boundedCount(value: number | string | bigint): number {
  const candidate = Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < 0) return 0;
  return candidate;
}

function boundedAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Number(Math.min(100, (numerator / denominator) * 100).toFixed(1));
}

export function buildPartnerPortalOperationsReport(input: {
  rows: FunnelCountRow[];
  rangeDays: PartnerOperationsRangeDays;
  generatedAt: Date;
}) {
  const stageCounts = Object.fromEntries(
    PARTNER_FUNNEL_STAGES.map((stage) => [stage, 0]),
  ) as Record<PartnerFunnelStage, number>;
  const personaCounts = Object.fromEntries(
    PARTNER_FUNNEL_PERSONAS.map((persona) => [
      persona,
      Object.fromEntries(
        PARTNER_FUNNEL_STAGES.map((stage) => [stage, 0]),
      ) as Record<PartnerFunnelStage, number>,
    ]),
  ) as Record<PartnerFunnelPersona, Record<PartnerFunnelStage, number>>;

  for (const row of input.rows.slice(0, 200)) {
    const parsed = parsePartnerFunnelKey(row.key);
    if (!parsed) continue;
    const count = boundedCount(row.count);
    stageCounts[parsed.stage] = boundedAdd(stageCounts[parsed.stage], count);
    personaCounts[parsed.persona][parsed.stage] = boundedAdd(
      personaCounts[parsed.persona][parsed.stage],
      count,
    );
  }

  return {
    generatedAt: input.generatedAt.toISOString(),
    rangeDays: input.rangeDays,
    stages: PARTNER_FUNNEL_STAGES.map((stage) => ({
      stage,
      label: STAGE_LABELS[stage],
      count: stageCounts[stage],
    })),
    personas: PARTNER_FUNNEL_PERSONAS.map((persona) => ({
      persona,
      label: PERSONA_LABELS[persona],
      started: personaCounts[persona].booking_started,
      submitted: personaCounts[persona].booking_submitted,
      confirmed: personaCounts[persona].booking_confirmed,
      reviewRequested: personaCounts[persona].booking_review_requested,
      abandoned: personaCounts[persona].booking_abandoned,
      slotFull: personaCounts[persona].availability_slot_full,
    })),
    rates: {
      availabilitySuccessPercent: rate(
        stageCounts.availability_available,
        stageCounts.availability_requested,
      ),
      slotFullPercent: rate(
        stageCounts.availability_slot_full,
        stageCounts.availability_requested,
      ),
      bookingCompletionPercent: rate(
        stageCounts.booking_submitted,
        stageCounts.booking_started,
      ),
      bookingAbandonmentPercent: rate(
        stageCounts.booking_abandoned,
        stageCounts.booking_started,
      ),
      uploadCompletionPercent: rate(
        stageCounts.upload_completed,
        stageCounts.upload_started,
      ),
    },
  };
}

export type PartnerPortalOperationsReport = ReturnType<
  typeof buildPartnerPortalOperationsReport
>;

export async function loadPartnerPortalOperationsReport(input: {
  rangeDays: PartnerOperationsRangeDays;
  now?: Date;
  db?: ReturnType<typeof getDb>;
}): Promise<PartnerPortalOperationsReport> {
  const now = input.now ?? new Date();
  const timezone = process.env["APPOINTMENT_TIMEZONE"] ?? "America/New_York";
  const sinceDate = DateTime.fromJSDate(now)
    .setZone(timezone)
    .minus({ days: input.rangeDays - 1 })
    .toISODate();
  const throughDate = DateTime.fromJSDate(now).setZone(timezone).toISODate();
  if (!sinceDate || !throughDate) {
    throw new TypeError("Unable to resolve the reporting date.");
  }

  const db = input.db ?? getDb();
  const rows = await db
    .select({
      key: webEventCountsDaily.key,
      count:
        sql<number>`coalesce(sum(${webEventCountsDaily.count}), 0)`.mapWith(
          Number,
        ),
    })
    .from(webEventCountsDaily)
    .where(
      and(
        eq(webEventCountsDaily.event, "partner_funnel"),
        gte(webEventCountsDaily.dateStart, sinceDate),
        lte(webEventCountsDaily.dateStart, throughDate),
      ),
    )
    .groupBy(webEventCountsDaily.key)
    .limit(200);

  return buildPartnerPortalOperationsReport({
    rows,
    rangeDays: input.rangeDays,
    generatedAt: now,
  });
}
