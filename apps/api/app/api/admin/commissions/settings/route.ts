import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveCrewLaborPoolRateBps } from "@myst-os/pricing";
import { commissionSettings, getDb } from "@/db";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { requirePermission } from "@/lib/permissions";
import {
  getCommissionManagementConfigurationStatus,
  getOrCreateCommissionSettings,
  recalculateCurrentPayoutPeriodAppointments,
} from "@/lib/commissions";
import { isAdminRequest } from "../../../web/admin";

const SettingsSchema = z.object({
  timezone: z.string().min(1),
  payoutWeekday: z.number().int().min(1).max(7),
  payoutHour: z.number().int().min(0).max(23),
  payoutMinute: z.number().int().min(0).max(59),
  salesRateBps: z.number().int().min(0).max(10000),
  marketingRateBps: z.number().int().min(0).max(10000),
  crewPoolRateBps: z.number().int().min(0).max(10000),
  marketingMemberId: z.string().uuid().nullable().optional(),
});

const crewPoolPolicy = {
  kind: "crew_count",
  split: "equal",
  tiers: [
    {
      minimumCrewSize: 1,
      maximumCrewSize: 2,
      poolRateBps: resolveCrewLaborPoolRateBps(2),
    },
    {
      minimumCrewSize: 3,
      maximumCrewSize: null,
      poolRateBps: resolveCrewLaborPoolRateBps(3),
    },
  ],
  moving: "hourly",
} as const;

function withCrewPoolPolicy<T extends object>(settings: T) {
  return {
    ...settings,
    crewPoolPolicy,
    // Older clients can still read these fields. Named percentage overrides
    // are retired; new completion pay depends only on the selected crew count.
    crewSplitRulesReady: true,
    crewSplitRules: [],
  };
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "commissions.read");
  if (permissionError) return permissionError;

  const db = getDb();
  try {
    const settings = await getOrCreateCommissionSettings(db);
    const management = await getCommissionManagementConfigurationStatus(
      db,
      settings.marketingRateBps,
    );
    return NextResponse.json({
      ok: true,
      settings: withCrewPoolPolicy({
        ...settings,
        managementReady: management.ready,
        managementTotalSplitBps: management.totalSplitBps,
        managementSplits: management.recipients,
      }),
    });
  } catch (error) {
    const code =
      error &&
      typeof error === "object" &&
      "code" in error &&
      typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : null;
    if (code === "42P01" || code === "42703") {
      return NextResponse.json({ error: "schema_not_ready" }, { status: 503 });
    }
    throw error;
  }
}

export async function PUT(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(
    request,
    "commissions.manage",
  );
  if (permissionError) return permissionError;

  const payload = (await request.json().catch(() => null)) as unknown;
  const parsed = SettingsSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", message: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const db = getDb();
  const actor = getAuditActorFromRequest(request);

  const settings = {
    ...parsed.data,
    salesRateBps: 0,
    marketingRateBps: 1700,
    crewPoolRateBps: 2000,
    marketingMemberId: null,
  };
  await db
    .insert(commissionSettings)
    .values({
      key: "default",
      timezone: settings.timezone,
      payoutWeekday: settings.payoutWeekday,
      payoutHour: settings.payoutHour,
      payoutMinute: settings.payoutMinute,
      salesRateBps: settings.salesRateBps,
      marketingRateBps: settings.marketingRateBps,
      crewPoolRateBps: settings.crewPoolRateBps,
      marketingMemberId: settings.marketingMemberId ?? null,
      updatedBy: actor.id ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: commissionSettings.key,
      set: {
        timezone: settings.timezone,
        payoutWeekday: settings.payoutWeekday,
        payoutHour: settings.payoutHour,
        payoutMinute: settings.payoutMinute,
        salesRateBps: settings.salesRateBps,
        marketingRateBps: settings.marketingRateBps,
        crewPoolRateBps: settings.crewPoolRateBps,
        marketingMemberId: settings.marketingMemberId ?? null,
        updatedBy: actor.id ?? null,
        updatedAt: new Date(),
      },
    });

  // The stored 17% baseline remains historical. Active dated policies must be
  // reflected in responses, even when an owner changes only the payout schedule.
  const effectiveSettings = withCrewPoolPolicy(
    await getOrCreateCommissionSettings(db),
  );

  await recalculateCurrentPayoutPeriodAppointments(db);

  await recordAuditEvent({
    actor,
    action: "commission.settings.updated",
    entityType: "commission_settings",
    entityId: "default",
    meta: effectiveSettings,
  });

  return NextResponse.json({ ok: true, settings: effectiveSettings });
}
