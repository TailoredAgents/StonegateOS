import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { inArray } from "drizzle-orm";
import { getDb, policySettings } from "@/db";
import { isAdminRequest } from "../../web/admin";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";

const POLICY_KEYS = [
  "business_hours",
  "quiet_hours",
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
  templates: {
    first_touch: {
      sms: "Thanks for reaching out! We can help. What items and timeframe are you thinking?",
      email: "Thanks for contacting Stonegate. Share a few details about your items and timing, and we will follow up.",
      dm: "Thanks for reaching out! Share your address and a few item details and we can help.",
      call: "Sorry we missed your call! Reply with your address and what you need hauled and we will get you scheduled.",
      web: "Thanks for reaching out! Share your address and a few item details and we can help."
    },
    follow_up: {
      sms: "Just checking in - do you want to lock in a time for your junk removal?",
      email: "Following up on your quote request. Let us know if you want to schedule."
    },
    confirmations: {
      sms: "Confirmed! We will see you at the scheduled time. Reply YES to confirm.",
      email: "Your appointment is confirmed. Reply YES if everything looks right."
    },
    reviews: {
      sms: "Thanks for choosing Stonegate! Would you leave a quick review?",
      email: "We appreciate your business. If you have a moment, please share a review."
    }
  }
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
