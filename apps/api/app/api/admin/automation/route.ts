import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getDb, automationSettings } from "@/db";
import { isAdminRequest } from "../../web/admin";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";

const CHANNELS = ["sms", "email", "dm", "call", "web"] as const;
const MODES = new Set(["draft", "assist", "auto"]);

type AutomationChannel = (typeof CHANNELS)[number];

function isChannel(value: string): value is AutomationChannel {
  return (CHANNELS as readonly string[]).includes(value);
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = getDb();
  const rows = await db
    .select({
      channel: automationSettings.channel,
      mode: automationSettings.mode,
      updatedAt: automationSettings.updatedAt
    })
    .from(automationSettings);

  const map = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    map.set(row.channel, row);
  }

  const channels = CHANNELS.map((channel) => {
    const row = map.get(channel);
    return {
      channel,
      mode: row?.mode ?? "draft",
      updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null
    };
  });

  return NextResponse.json({ channels });
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = (await request.json().catch(() => null)) as {
    channel?: string;
    mode?: string;
  } | null;

  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  if (typeof payload.channel !== "string" || !isChannel(payload.channel)) {
    return NextResponse.json({ error: "invalid_channel" }, { status: 400 });
  }

  if (typeof payload.mode !== "string" || !MODES.has(payload.mode)) {
    return NextResponse.json({ error: "invalid_mode" }, { status: 400 });
  }

  const actor = getAuditActorFromRequest(request);
  const db = getDb();
  const now = new Date();

  await db
    .insert(automationSettings)
    .values({
      channel: payload.channel,
      mode: payload.mode,
      updatedBy: actor.id ?? null,
      updatedAt: now
    })
    .onConflictDoUpdate({
      target: automationSettings.channel,
      set: {
        mode: payload.mode,
        updatedBy: actor.id ?? null,
        updatedAt: now
      }
    });

  await recordAuditEvent({
    actor,
    action: "automation.mode.update",
    entityType: "automation_setting",
    entityId: payload.channel,
    meta: { mode: payload.mode }
  });

  return NextResponse.json({ ok: true, channel: payload.channel, mode: payload.mode });
}
