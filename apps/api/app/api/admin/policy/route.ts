import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { inArray } from "drizzle-orm";
import { getDb, policySettings } from "@/db";
import {
  DEFAULT_BUSINESS_HOURS_POLICY,
  DEFAULT_BOOKING_RULES_POLICY,
  DEFAULT_COMPANY_PROFILE_POLICY,
  DEFAULT_CONVERSATION_PERSONA_POLICY,
  DEFAULT_CONFIRMATION_LOOP_POLICY,
  DEFAULT_FOLLOW_UP_SEQUENCE_POLICY,
  DEFAULT_INBOX_ALERTS_POLICY,
  DEFAULT_QUIET_HOURS_POLICY,
  DEFAULT_SERVICE_AREA_POLICY,
  DEFAULT_ITEM_POLICIES,
  DEFAULT_STANDARD_JOB_POLICY,
  DEFAULT_TEMPLATES_POLICY
} from "@/lib/policy";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../web/admin";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";

const POLICY_KEYS = [
  "business_hours",
  "quiet_hours",
  "service_area",
  "company_profile",
  "conversation_persona",
  "inbox_alerts",
  "booking_rules",
  "confirmation_loop",
  "follow_up_sequence",
  "standard_job",
  "item_policies",
  "templates"
] as const;

type PolicyKey = (typeof POLICY_KEYS)[number];

const DEFAULT_POLICY_VALUES: Record<PolicyKey, Record<string, unknown>> = {
  business_hours: DEFAULT_BUSINESS_HOURS_POLICY,
  quiet_hours: DEFAULT_QUIET_HOURS_POLICY,
  service_area: DEFAULT_SERVICE_AREA_POLICY,
  company_profile: DEFAULT_COMPANY_PROFILE_POLICY,
  conversation_persona: DEFAULT_CONVERSATION_PERSONA_POLICY,
  inbox_alerts: DEFAULT_INBOX_ALERTS_POLICY,
  booking_rules: DEFAULT_BOOKING_RULES_POLICY,
  confirmation_loop: DEFAULT_CONFIRMATION_LOOP_POLICY,
  follow_up_sequence: DEFAULT_FOLLOW_UP_SEQUENCE_POLICY,
  standard_job: DEFAULT_STANDARD_JOB_POLICY,
  item_policies: DEFAULT_ITEM_POLICIES,
  templates: DEFAULT_TEMPLATES_POLICY
};

function isPolicyKey(value: string): value is PolicyKey {
  return (POLICY_KEYS as readonly string[]).includes(value);
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "policy.read");
  if (permissionError) return permissionError;

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
  const permissionError = await requirePermission(request, "policy.write");
  if (permissionError) return permissionError;

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
