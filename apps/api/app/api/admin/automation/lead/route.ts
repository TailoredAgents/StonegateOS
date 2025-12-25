import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDb, leadAutomationStates } from "@/db";
import { isAdminRequest } from "../../../web/admin";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";

const CHANNELS = ["sms", "email", "dm", "call", "web"] as const;

type AutomationChannel = (typeof CHANNELS)[number];

function isChannel(value: string): value is AutomationChannel {
  return (CHANNELS as readonly string[]).includes(value);
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const leadId = request.nextUrl.searchParams.get("leadId");
  const channel = request.nextUrl.searchParams.get("channel");

  if (!leadId) {
    return NextResponse.json({ error: "lead_id_required" }, { status: 400 });
  }

  if (channel && !isChannel(channel)) {
    return NextResponse.json({ error: "invalid_channel" }, { status: 400 });
  }

  const db = getDb();
  const rows = await db
    .select({
      id: leadAutomationStates.id,
      leadId: leadAutomationStates.leadId,
      channel: leadAutomationStates.channel,
      paused: leadAutomationStates.paused,
      dnc: leadAutomationStates.dnc,
      humanTakeover: leadAutomationStates.humanTakeover,
      followupState: leadAutomationStates.followupState,
      followupStep: leadAutomationStates.followupStep,
      nextFollowupAt: leadAutomationStates.nextFollowupAt,
      pausedAt: leadAutomationStates.pausedAt,
      pausedBy: leadAutomationStates.pausedBy,
      updatedAt: leadAutomationStates.updatedAt
    })
    .from(leadAutomationStates)
    .where(
      channel ? and(eq(leadAutomationStates.leadId, leadId), eq(leadAutomationStates.channel, channel)) : eq(leadAutomationStates.leadId, leadId)
    );

  const states = rows.map((row) => ({
    id: row.id,
    leadId: row.leadId,
    channel: row.channel,
    paused: row.paused ?? false,
    dnc: row.dnc ?? false,
    humanTakeover: row.humanTakeover ?? false,
    followupState: row.followupState ?? null,
    followupStep: row.followupStep ?? 0,
    nextFollowupAt: row.nextFollowupAt ? row.nextFollowupAt.toISOString() : null,
    pausedAt: row.pausedAt ? row.pausedAt.toISOString() : null,
    pausedBy: row.pausedBy ?? null,
    updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null
  }));

  return NextResponse.json({ states });
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = (await request.json().catch(() => null)) as {
    leadId?: string;
    channel?: string;
    paused?: boolean;
    dnc?: boolean;
    humanTakeover?: boolean;
    followupState?: string | null;
    followupStep?: number;
    nextFollowupAt?: string | null;
  } | null;

  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  if (typeof payload.leadId !== "string" || payload.leadId.trim().length === 0) {
    return NextResponse.json({ error: "lead_id_required" }, { status: 400 });
  }

  if (typeof payload.channel !== "string" || !isChannel(payload.channel)) {
    return NextResponse.json({ error: "invalid_channel" }, { status: 400 });
  }

  const nextFollowupAt = parseDate(payload.nextFollowupAt);
  if (payload.nextFollowupAt && !nextFollowupAt) {
    return NextResponse.json({ error: "invalid_next_followup_at" }, { status: 400 });
  }

  const actor = getAuditActorFromRequest(request);
  const now = new Date();
  const paused = payload.paused ?? false;

  const updates = {
    leadId: payload.leadId,
    channel: payload.channel,
    paused,
    dnc: payload.dnc ?? false,
    humanTakeover: payload.humanTakeover ?? false,
    followupState: payload.followupState ?? null,
    followupStep: typeof payload.followupStep === "number" ? payload.followupStep : 0,
    nextFollowupAt,
    pausedAt: paused ? now : null,
    pausedBy: paused ? actor.id ?? null : null,
    updatedAt: now,
    createdAt: now
  };

  const db = getDb();

  await db
    .insert(leadAutomationStates)
    .values(updates)
    .onConflictDoUpdate({
      target: [leadAutomationStates.leadId, leadAutomationStates.channel],
      set: {
        paused: updates.paused,
        dnc: updates.dnc,
        humanTakeover: updates.humanTakeover,
        followupState: updates.followupState,
        followupStep: updates.followupStep,
        nextFollowupAt: updates.nextFollowupAt,
        pausedAt: updates.pausedAt,
        pausedBy: updates.pausedBy,
        updatedAt: updates.updatedAt
      }
    });

  await recordAuditEvent({
    actor,
    action: "automation.lead.update",
    entityType: "lead_automation_state",
    entityId: payload.leadId,
    meta: {
      channel: payload.channel,
      paused: updates.paused,
      dnc: updates.dnc,
      humanTakeover: updates.humanTakeover,
      followupState: updates.followupState,
      nextFollowupAt: updates.nextFollowupAt ? updates.nextFollowupAt.toISOString() : null
    }
  });

  return NextResponse.json({ ok: true });
}
