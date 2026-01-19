import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";
import {
  computeConversionForMember,
  computeCallQualityForMember,
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

function computeCallQualityScore(params: { weight: number; avgScore: number | null; count: number }): { score: number; effectiveAvg: number; counted: boolean } {
  const weight = params.weight;
  const avg = params.avgScore;
  const count = params.count;

  const counted = count >= 3 && avg !== null;
  const effectiveAvg = counted ? avg : 85;
  const ratio = effectiveAvg / 100;
  return { score: Math.round(weight * ratio), effectiveAvg, counted };
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
  const requestedSince = new Date(now.getTime() - rangeDays * 24 * 60_000 * 60);
  const trackingStartAt =
    config.trackingStartAt && Number.isFinite(Date.parse(config.trackingStartAt)) ? new Date(config.trackingStartAt) : null;
  const since =
    trackingStartAt && trackingStartAt.getTime() > requestedSince.getTime() ? trackingStartAt : requestedSince;
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

  const callQuality = await computeCallQualityForMember({ db, memberId, since, until });
  const callQualityScoreDetails = computeCallQualityScore({
    weight: config.weights.callQuality ?? 0,
    avgScore: callQuality.avgScore,
    count: callQuality.count
  });

  const totalScore = Math.min(
    100,
    speedScore + followupScore + conversionScore + callQualityScoreDetails.score
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
      trackingStartAt: config.trackingStartAt,
      weights: config.weights
    },
    score: {
      total: totalScore,
      speedToLead: speedScore,
      followupCompliance: followupScore,
      conversion: conversionScore,
      callQuality: callQualityScoreDetails.score,
      responseTime: 0
    },
    metrics: {
      speedToLead: {
        totalLeads: speedTotal,
        met: speedMet,
        missed: speedTotal - speedMet
      },
      followups,
      conversion,
      callQuality: {
        avgScore: callQuality.avgScore,
        effectiveAvg: callQualityScoreDetails.effectiveAvg,
        counted: callQualityScoreDetails.counted,
        count: callQuality.count
      }
    }
  });
}
