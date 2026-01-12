import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";
import {
  computeConversionForMember,
  computeFollowupComplianceForMember,
  computeSpeedToLeadForMember,
  getSalesScorecardConfig
} from "@/lib/sales-scorecard";

function clampInt(value: string | null, fallback: number, { min, max }: { min: number; max: number }): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.round(parsed);
  return Math.min(max, Math.max(min, rounded));
}

function computeResponseTimeScore(params: {
  weight: number;
  medianMinutes: number | null;
}): { score: number; label: string } {
  const weight = params.weight;
  const median = params.medianMinutes;
  if (median === null) return { score: weight, label: "no inbound messages" };
  if (median <= 5) return { score: weight, label: "excellent" };
  if (median <= 15) return { score: Math.round(weight * 0.7), label: "good" };
  if (median <= 60) return { score: Math.round(weight * 0.4), label: "slow" };
  return { score: 0, label: "very slow" };
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const a = sorted[mid - 1];
  const b = sorted[mid];
  return typeof a === "number" && typeof b === "number" ? (a + b) / 2 : null;
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "appointments.read");
  if (permissionError) return permissionError;

  const db = getDb();
  const config = await getSalesScorecardConfig(db);

  const url = new URL(request.url);
  const memberId = url.searchParams.get("memberId")?.trim() || config.defaultAssigneeMemberId;
  const rangeDays = clampInt(url.searchParams.get("rangeDays"), 7, { min: 1, max: 60 });

  const now = new Date();
  const since = new Date(now.getTime() - rangeDays * 24 * 60_000 * 60);
  const until = now;

  const speed = await computeSpeedToLeadForMember({ db, memberId, since, until });
  const speedCountable = speed.filter((row) => row.hasPhone);
  const speedTotal = speedCountable.length;
  const speedMet = speedCountable.filter((row) => row.met).length;
  const speedRatio = speedTotal > 0 ? speedMet / speedTotal : 1;
  const speedScore = Math.round(config.weights.speedToLead * speedRatio);

  const followups = await computeFollowupComplianceForMember({
    db,
    memberId,
    since,
    until,
    graceMinutes: config.followupGraceMinutes
  });
  const followupRatio = followups.totalDue > 0 ? followups.completedOnTime / followups.totalDue : 1;
  const followupScore = Math.round(config.weights.followupCompliance * followupRatio);

  const conversion = await computeConversionForMember({ db, memberId, since, until });
  const convRatio =
    conversion.totalLeads > 0
      ? 0.7 * (conversion.booked / conversion.totalLeads) + 0.3 * (conversion.won / conversion.totalLeads)
      : 1;
  const conversionScore = Math.round(config.weights.conversion * convRatio);

  // Lightweight response time: computed from speed records that have message timestamps (outbound reply).
  // We intentionally avoid expensive deep joins here; the queue view surfaces per-contact response needs.
  const responseSamples = speed
    .map((row) => {
      if (!row.firstOutboundMessageAt) return null;
      const createdAt = Date.parse(row.createdAt);
      const firstOutbound = Date.parse(row.firstOutboundMessageAt);
      if (!Number.isFinite(createdAt) || !Number.isFinite(firstOutbound)) return null;
      const minutes = (firstOutbound - createdAt) / 60_000;
      return minutes >= 0 ? minutes : null;
    })
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const responseMedian = median(responseSamples);
  const responseScoreDetails = computeResponseTimeScore({
    weight: config.weights.responseTime,
    medianMinutes: responseMedian
  });

  const totalScore = Math.min(
    100,
    speedScore + followupScore + conversionScore + responseScoreDetails.score
  );

  return NextResponse.json({
    ok: true,
    memberId,
    rangeDays,
    config: {
      timezone: config.timezone,
      businessStartHour: config.businessStartHour,
      businessEndHour: config.businessEndHour,
      speedToLeadMinutes: config.speedToLeadMinutes,
      followupGraceMinutes: config.followupGraceMinutes,
      weights: config.weights
    },
    score: {
      total: totalScore,
      speedToLead: speedScore,
      followupCompliance: followupScore,
      conversion: conversionScore,
      responseTime: responseScoreDetails.score
    },
    metrics: {
      speedToLead: {
        totalLeads: speedTotal,
        met: speedMet,
        missed: speedTotal - speedMet
      },
      followups,
      conversion,
      responseTime: {
        medianMinutes: responseMedian,
        label: responseScoreDetails.label
      }
    }
  });
}
