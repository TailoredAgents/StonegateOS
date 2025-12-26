import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { inArray } from "drizzle-orm";
import { getDb, policySettings } from "@/db";
import { DEFAULT_SERVICE_AREA_POLICY, DEFAULT_TEMPLATES_POLICY } from "@/lib/policy";
import { isAdminRequest } from "../../web/admin";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";

const POLICY_KEYS = [
  "business_hours",
  "quiet_hours",
  "service_area",
  "booking_rules",
  "standard_job",
  "item_policies",
  "templates"
] as const;

type PolicyKey = (typeof POLICY_KEYS)[number];

const DEFAULT_POLICY_VALUES: Record<PolicyKey, Record<string, unknown>> = {
  business_hours: {
    timezone: process.env["APPOINTMENT_TIMEZONE"] ?? "America/New_York",
    weekly: {
      monday: [{ start: "08:00", end: "18:00" }],
      tuesday: [{ start: "08:00", end: "18:00" }],
      wednesday: [{ start: "08:00", end: "18:00" }],
      thursday: [{ start: "08:00", end: "18:00" }],
      friday: [{ start: "08:00", end: "18:00" }],
      saturday: [{ start: "09:00", end: "14:00" }],
      sunday: []
    }
  },
  quiet_hours: {
    channels: {
      sms: { start: "20:00", end: "08:00" },
      email: { start: "19:00", end: "07:00" },
      dm: { start: "20:00", end: "08:00" }
    }
  },
  service_area: DEFAULT_SERVICE_AREA_POLICY,
  booking_rules: {
    bookingWindowDays: 30,
    bufferMinutes: 30,
    maxJobsPerDay: 6,
    maxJobsPerCrew: 3
  },
  standard_job: {
    allowedServices: ["junk_removal_primary"],
    maxVolumeCubicYards: 12,
    maxItemCount: 20,
    notes: "Standard jobs only. Oversize/hazard items require approval."
  },
  item_policies: {
    declined: ["hazmat", "paint", "oil"],
    extraFees: [{ item: "mattress", fee: 25 }]
  },
  templates: DEFAULT_TEMPLATES_POLICY
};

function isPolicyKey(value: string): value is PolicyKey {
  return (POLICY_KEYS as readonly string[]).includes(value);
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = getDb();
  const keys = POLICY_KEYS;

  const rows = await db
    .select({
      key: policySettings.key,
      value: policySettings.value,
      updatedAt: policySettings.updatedAt,
      updatedBy: policySettings.updatedBy
    })
    .from(policySettings)
    .where(inArray(policySettings.key, keys));

  const rowMap = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    rowMap.set(row.key, row);
  }

  const settings = keys.map((key) => {
    const row = rowMap.get(key);
    return {
      key,
      value: row?.value ?? DEFAULT_POLICY_VALUES[key],
      updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
      updatedBy: row?.updatedBy ?? null
    };
  });

  return NextResponse.json({ settings });
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = (await request.json().catch(() => null)) as {
    key?: string;
    value?: unknown;
  } | null;

  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  if (typeof payload.key !== "string" || !isPolicyKey(payload.key)) {
    return NextResponse.json({ error: "invalid_key" }, { status: 400 });
  }

  if (!payload.value || typeof payload.value !== "object") {
    return NextResponse.json({ error: "invalid_value" }, { status: 400 });
  }

  const actor = getAuditActorFromRequest(request);
  const db = getDb();

  await db
    .insert(policySettings)
    .values({
      key: payload.key,
      value: payload.value as Record<string, unknown>,
      updatedBy: actor.id ?? null,
      createdAt: new Date(),
      updatedAt: new Date()
    })
    .onConflictDoUpdate({
      target: policySettings.key,
      set: {
        value: payload.value as Record<string, unknown>,
        updatedBy: actor.id ?? null,
        updatedAt: new Date()
      }
    });

  await recordAuditEvent({
    actor,
    action: "policy.update",
    entityType: "policy_setting",
    entityId: payload.key,
    meta: { key: payload.key }
  });

  return NextResponse.json({
    ok: true,
    key: payload.key
  });
}
