import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { commissionSettings, getDb } from "@/db";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { requirePermission } from "@/lib/permissions";
import { getOrCreateCommissionSettings } from "@/lib/commissions";
import { isAdminRequest } from "../../../web/admin";

const SettingsSchema = z.object({
  timezone: z.string().min(1),
  payoutWeekday: z.number().int().min(1).max(7),
  payoutHour: z.number().int().min(0).max(23),
  payoutMinute: z.number().int().min(0).max(59),
  salesRateBps: z.number().int().min(0).max(10000),
  marketingRateBps: z.number().int().min(0).max(10000),
  crewPoolRateBps: z.number().int().min(0).max(10000),
  marketingMemberId: z.string().uuid().nullable()
});

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "access.manage");
  if (permissionError) return permissionError;

  const db = getDb();
  const settings = await getOrCreateCommissionSettings(db);
  return NextResponse.json({ ok: true, settings });
}

export async function PUT(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "access.manage");
  if (permissionError) return permissionError;

  const payload = (await request.json().catch(() => null)) as unknown;
  const parsed = SettingsSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", message: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const db = getDb();
  const actor = getAuditActorFromRequest(request);

  const settings = parsed.data;
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
      marketingMemberId: settings.marketingMemberId,
      updatedBy: actor.id ?? null,
      createdAt: new Date(),
      updatedAt: new Date()
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
        marketingMemberId: settings.marketingMemberId,
        updatedBy: actor.id ?? null,
        updatedAt: new Date()
      }
    });

  const [saved] = await db
    .select({
      key: commissionSettings.key,
      timezone: commissionSettings.timezone,
      payoutWeekday: commissionSettings.payoutWeekday,
      payoutHour: commissionSettings.payoutHour,
      payoutMinute: commissionSettings.payoutMinute,
      salesRateBps: commissionSettings.salesRateBps,
      marketingRateBps: commissionSettings.marketingRateBps,
      crewPoolRateBps: commissionSettings.crewPoolRateBps,
      marketingMemberId: commissionSettings.marketingMemberId
    })
    .from(commissionSettings)
    .where(eq(commissionSettings.key, "default"))
    .limit(1);

  await recordAuditEvent({
    actor,
    action: "commission.settings.updated",
    entityType: "commission_settings",
    entityId: "default",
    meta: settings
  });

  return NextResponse.json({ ok: true, settings: saved ?? settings });
}

