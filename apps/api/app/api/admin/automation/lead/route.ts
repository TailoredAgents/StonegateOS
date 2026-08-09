import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  and,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import {
  contacts,
  getDb,
  leadAutomationStates,
  leads,
} from "@/db";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../../web/admin";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";

const CHANNELS = ["sms", "email", "dm", "call", "web"] as const;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const FOLLOWUP_STATE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;

type AutomationChannel = (typeof CHANNELS)[number];

function isChannel(value: string): value is AutomationChannel {
  return (CHANNELS as readonly string[]).includes(value);
}

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function parseLimit(value: string | null): number | null {
  if (value === null || value.trim() === "") return 12;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 20
    ? parsed
    : null;
}

function searchPattern(value: string): string {
  return `%${value.replace(/[\\%_]/gu, "\\$&")}%`;
}

function serializeState(row: {
  id: string;
  leadId: string;
  channel: string;
  paused: boolean | null;
  dnc: boolean | null;
  humanTakeover: boolean | null;
  followupState: string | null;
  followupStep: number | null;
  nextFollowupAt: Date | null;
  pausedAt: Date | null;
  pausedBy: string | null;
  updatedAt: Date | null;
}) {
  return {
    id: row.id,
    leadId: row.leadId,
    channel: row.channel,
    paused: row.paused ?? false,
    dnc: row.dnc ?? false,
    humanTakeover: row.humanTakeover ?? false,
    followupState: row.followupState ?? null,
    followupStep: row.followupStep ?? 0,
    nextFollowupAt: row.nextFollowupAt?.toISOString() ?? null,
    pausedAt: row.pausedAt?.toISOString() ?? null,
    pausedBy: row.pausedBy ?? null,
    updatedAt: row.updatedAt?.toISOString() ?? null,
  };
}

async function searchLeads(request: NextRequest): Promise<Response> {
  const query = request.nextUrl.searchParams.get("q")?.trim() ?? "";
  const limit = parseLimit(request.nextUrl.searchParams.get("limit"));
  if (query.length < 2 || query.length > 100) {
    return NextResponse.json(
      {
        error: "invalid_query",
        message: "Enter between 2 and 100 characters.",
      },
      { status: 422 },
    );
  }
  if (limit === null) {
    return NextResponse.json(
      { error: "invalid_limit", message: "Limit must be from 1 to 20." },
      { status: 422 },
    );
  }

  const db = getDb();
  const pattern = searchPattern(query);
  const fullName = sql<string>`concat_ws(' ', ${contacts.firstName}, ${contacts.lastName})`;
  const rows = await db
    .select({
      id: leads.id,
      contactId: leads.contactId,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      company: contacts.company,
      email: contacts.email,
      phone: contacts.phone,
      phoneE164: contacts.phoneE164,
      status: leads.status,
      source: leads.source,
      updatedAt: leads.updatedAt,
    })
    .from(leads)
    .innerJoin(contacts, eq(leads.contactId, contacts.id))
    .where(
      and(
        isNull(contacts.deletedAt),
        or(
          ilike(fullName, pattern),
          ilike(contacts.firstName, pattern),
          ilike(contacts.lastName, pattern),
          ilike(contacts.company, pattern),
          ilike(contacts.email, pattern),
          ilike(contacts.phone, pattern),
          ilike(contacts.phoneE164, pattern),
        ),
      ),
    )
    .orderBy(desc(leads.updatedAt))
    .limit(limit);

  const leadIds = rows.map((row) => row.id);
  const stateRows =
    leadIds.length === 0
      ? []
      : await db
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
            updatedAt: leadAutomationStates.updatedAt,
          })
          .from(leadAutomationStates)
          .where(inArray(leadAutomationStates.leadId, leadIds));

  const statesByLead = new Map<string, ReturnType<typeof serializeState>[]>();
  for (const stateRow of stateRows) {
    const existing = statesByLead.get(stateRow.leadId) ?? [];
    existing.push(serializeState(stateRow));
    statesByLead.set(stateRow.leadId, existing);
  }

  return NextResponse.json({
    ok: true,
    searchComplete: true,
    leads: rows.map((row) => ({
      id: row.id,
      contactId: row.contactId,
      name:
        `${row.firstName ?? ""} ${row.lastName ?? ""}`.trim() ||
        "Unnamed contact",
      company: row.company ?? null,
      email: row.email ?? null,
      phone: row.phoneE164 ?? row.phone ?? null,
      status: row.status,
      source: row.source ?? null,
      updatedAt: row.updatedAt.toISOString(),
      automationStates: statesByLead.get(row.id) ?? [],
    })),
  });
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "automation.read");
  if (permissionError) return permissionError;

  if (request.nextUrl.searchParams.has("q")) {
    return searchLeads(request);
  }

  const leadId = request.nextUrl.searchParams.get("leadId")?.trim() ?? "";
  const channel = request.nextUrl.searchParams.get("channel");

  if (!isUuid(leadId)) {
    return NextResponse.json(
      { error: "invalid_lead_id", message: "Choose a valid lead." },
      { status: 422 },
    );
  }

  let channelFilter: AutomationChannel | null = null;
  if (channel) {
    if (!isChannel(channel)) {
      return NextResponse.json({ error: "invalid_channel" }, { status: 422 });
    }
    channelFilter = channel;
  }

  const db = getDb();
  const [lead] = await db
    .select({ id: leads.id })
    .from(leads)
    .innerJoin(contacts, eq(leads.contactId, contacts.id))
    .where(and(eq(leads.id, leadId), isNull(contacts.deletedAt)))
    .limit(1);
  if (!lead) {
    return NextResponse.json(
      { error: "lead_not_found", message: "That lead is no longer available." },
      { status: 404 },
    );
  }

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
      updatedAt: leadAutomationStates.updatedAt,
    })
    .from(leadAutomationStates)
    .where(
      channelFilter
        ? and(
            eq(leadAutomationStates.leadId, leadId),
            eq(leadAutomationStates.channel, channelFilter),
          )
        : eq(leadAutomationStates.leadId, leadId),
    );

  return NextResponse.json({ states: rows.map(serializeState) });
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "automation.write");
  if (permissionError) return permissionError;

  const payload = (await request.json().catch(() => null)) as {
    leadId?: unknown;
    channel?: unknown;
    paused?: unknown;
    dnc?: unknown;
    humanTakeover?: unknown;
    followupState?: unknown;
    followupStep?: unknown;
    nextFollowupAt?: unknown;
  } | null;

  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const leadId =
    typeof payload.leadId === "string" ? payload.leadId.trim() : "";
  if (!isUuid(leadId)) {
    return NextResponse.json(
      {
        error: "invalid_lead_id",
        fieldErrors: { leadId: "Choose a valid lead from search results." },
      },
      { status: 422 },
    );
  }

  if (typeof payload.channel !== "string" || !isChannel(payload.channel)) {
    return NextResponse.json(
      { error: "invalid_channel", fieldErrors: { channel: "Choose a channel." } },
      { status: 422 },
    );
  }

  for (const key of ["paused", "dnc", "humanTakeover"] as const) {
    if (key in payload && typeof payload[key] !== "boolean") {
      return NextResponse.json(
        {
          error: "invalid_boolean",
          fieldErrors: { [key]: "Use true or false." },
        },
        { status: 422 },
      );
    }
  }

  let followupState: string | null = null;
  if (payload.followupState !== undefined && payload.followupState !== null) {
    if (typeof payload.followupState !== "string") {
      return NextResponse.json(
        { error: "invalid_followup_state" },
        { status: 422 },
      );
    }
    const value = payload.followupState.trim().toLowerCase();
    if (value && !FOLLOWUP_STATE_PATTERN.test(value)) {
      return NextResponse.json(
        {
          error: "invalid_followup_state",
          fieldErrors: {
            followupState:
              "Use a short lowercase state such as qualifying or booked.",
          },
        },
        { status: 422 },
      );
    }
    followupState = value || null;
  }

  const followupStep = payload.followupStep ?? 0;
  if (
    typeof followupStep !== "number" ||
    !Number.isInteger(followupStep) ||
    followupStep < 0 ||
    followupStep > 100
  ) {
    return NextResponse.json(
      {
        error: "invalid_followup_step",
        fieldErrors: { followupStep: "Use a whole number from 0 to 100." },
      },
      { status: 422 },
    );
  }

  let nextFollowupAt: Date | null = null;
  if (payload.nextFollowupAt !== undefined && payload.nextFollowupAt !== null) {
    if (typeof payload.nextFollowupAt !== "string") {
      return NextResponse.json(
        { error: "invalid_next_followup_at" },
        { status: 422 },
      );
    }
    const value = payload.nextFollowupAt.trim();
    if (value) {
      nextFollowupAt = new Date(value);
      if (Number.isNaN(nextFollowupAt.getTime())) {
        return NextResponse.json(
          { error: "invalid_next_followup_at" },
          { status: 422 },
        );
      }
    }
  }

  const actor = getAuditActorFromRequest(request);
  const now = new Date();
  const paused = payload.paused === true;
  const channel = payload.channel;
  const updates = {
    leadId,
    channel,
    paused,
    dnc: payload.dnc === true,
    humanTakeover: payload.humanTakeover === true,
    followupState,
    followupStep,
    nextFollowupAt,
    pausedAt: paused ? now : null,
    pausedBy: paused ? actor.id ?? null : null,
    updatedAt: now,
    createdAt: now,
  };

  const db = getDb();
  const [lead] = await db
    .select({ id: leads.id })
    .from(leads)
    .innerJoin(contacts, eq(leads.contactId, contacts.id))
    .where(and(eq(leads.id, leadId), isNull(contacts.deletedAt)))
    .limit(1);
  if (!lead) {
    return NextResponse.json(
      { error: "lead_not_found", message: "That lead is no longer available." },
      { status: 404 },
    );
  }

  const [before] = await db
    .select({
      paused: leadAutomationStates.paused,
      dnc: leadAutomationStates.dnc,
      humanTakeover: leadAutomationStates.humanTakeover,
      followupState: leadAutomationStates.followupState,
      followupStep: leadAutomationStates.followupStep,
      nextFollowupAt: leadAutomationStates.nextFollowupAt,
    })
    .from(leadAutomationStates)
    .where(
      and(
        eq(leadAutomationStates.leadId, leadId),
        eq(leadAutomationStates.channel, channel),
      ),
    )
    .limit(1);

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
        updatedAt: updates.updatedAt,
      },
    });

  await recordAuditEvent({
    actor,
    action: "automation.lead.update",
    entityType: "lead_automation_state",
    entityId: leadId,
    meta: {
      requiredPermission: "automation.write",
      outcome: "succeeded",
      channel,
      before: before
        ? {
            ...before,
            nextFollowupAt: before.nextFollowupAt?.toISOString() ?? null,
          }
        : null,
      after: {
        paused: updates.paused,
        dnc: updates.dnc,
        humanTakeover: updates.humanTakeover,
        followupState: updates.followupState,
        followupStep: updates.followupStep,
        nextFollowupAt: updates.nextFollowupAt?.toISOString() ?? null,
      },
    },
  });

  return NextResponse.json({ ok: true, leadId, channel });
}
