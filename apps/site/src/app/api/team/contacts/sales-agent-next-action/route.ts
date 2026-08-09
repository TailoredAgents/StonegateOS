import { callAdminApiAs } from "@/app/team/lib/api";
import { requireTeamPrincipal } from "@/app/api/team/auth";
import type { TeamRequestPrincipal } from "@/lib/team-principal";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

function readContactId(url: URL): string {
  return url.searchParams.get("contactId")?.trim() ?? "";
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readReviewNote(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 1000) : null;
}

function buildReviewNoteTitle(action: string): string {
  return action === "resume" ? "Agent review handoff" : "Agent review note";
}

async function createReviewNote(input: {
  principal: TeamRequestPrincipal;
  contactId: string;
  action: string;
  reviewNote: string;
}): Promise<Response | null> {
  const noteResponse = await callAdminApiAs(
    input.principal,
    "/api/admin/crm/tasks",
    {
      method: "POST",
      body: JSON.stringify({
        contactId: input.contactId,
        title: buildReviewNoteTitle(input.action),
        notes: input.reviewNote,
        status: "completed",
      }),
      headers: { Accept: "application/json" },
    },
  );

  if (noteResponse.ok) return null;

  const noteBody: unknown = await noteResponse.json().catch(() => null);
  return NextResponse.json(
    noteBody ?? { ok: false, error: "review_note_create_failed" },
    { status: noteResponse.status || 502 },
  );
}

type AutomationState = {
  channel: string | null;
  paused: boolean;
  dnc: boolean;
  humanTakeover: boolean;
  followupState: string | null;
  followupStep: number | null;
  nextFollowupAt: string | null;
};

type ParsedNextAction = {
  ok: boolean;
  channel: string | null;
  leadId: string | null;
  automation: AutomationState[];
  liveContext: Record<string, unknown> | null;
};

function readNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseNextAction(value: unknown): ParsedNextAction | null {
  if (!isJsonObject(value)) return null;

  const nextAction = isJsonObject(value["nextAction"])
    ? value["nextAction"]
    : null;
  const liveContext = isJsonObject(value["liveContext"])
    ? value["liveContext"]
    : null;
  const latestLead =
    liveContext && isJsonObject(liveContext["latestLead"])
      ? liveContext["latestLead"]
      : null;
  const rawAutomation = liveContext?.["automation"];
  const automation = Array.isArray(rawAutomation)
    ? rawAutomation.filter(isJsonObject).map((state): AutomationState => {
        const followupStep = state["followupStep"];
        return {
          channel: readNullableString(state["channel"]),
          paused: state["paused"] === true,
          dnc: state["dnc"] === true,
          humanTakeover: state["humanTakeover"] === true,
          followupState: readNullableString(state["followupState"]),
          followupStep:
            typeof followupStep === "number" && Number.isFinite(followupStep)
              ? followupStep
              : null,
          nextFollowupAt: readNullableString(state["nextFollowupAt"]),
        };
      })
    : [];

  return {
    ok: value["ok"] === true,
    channel: readNullableString(nextAction?.["channel"]),
    leadId: readNullableString(latestLead?.["id"]),
    automation,
    liveContext,
  };
}

export async function GET(request: NextRequest): Promise<Response> {
  const auth = await requireTeamPrincipal(request, {
    permissions: "contacts.read",
    returnJson: true,
  });
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const contactId = readContactId(url);
  if (!contactId) {
    return NextResponse.json(
      { ok: false, error: "contact_id_required" },
      { status: 400 },
    );
  }

  const includeQuotePrice = url.searchParams.get("includeQuotePrice") === "1";
  const upstream = await callAdminApiAs(
    auth.principal,
    `/api/admin/contacts/${encodeURIComponent(contactId)}/sales-agent-next-action${includeQuotePrice ? "?includeQuotePrice=1" : ""}`,
    {
      headers: { Accept: "application/json" },
    },
  );

  const body: unknown = await upstream.json().catch(() => null);
  return NextResponse.json(body ?? { ok: false, error: "upstream_error" }, {
    status: upstream.status,
  });
}

export async function POST(request: NextRequest): Promise<Response> {
  const auth = await requireTeamPrincipal(request, {
    permissions: "contacts.write",
    returnJson: true,
  });
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const contactId = readContactId(url);
  if (!contactId) {
    return NextResponse.json(
      { ok: false, error: "contact_id_required" },
      { status: 400 },
    );
  }

  const includeQuotePrice = url.searchParams.get("includeQuotePrice") === "1";
  const upstreamPath = `/api/admin/contacts/${encodeURIComponent(contactId)}/sales-agent-next-action/rebuild${includeQuotePrice ? "?includeQuotePrice=1" : ""}`;
  const upstream = await callAdminApiAs(auth.principal, upstreamPath, {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  if (!upstream.ok) {
    const body: unknown = await upstream.json().catch(() => null);
    return NextResponse.json(body ?? { ok: false, error: "upstream_error" }, {
      status: upstream.status,
    });
  }
  const refreshRes = await callAdminApiAs(
    auth.principal,
    `/api/admin/contacts/${encodeURIComponent(contactId)}/sales-agent-next-action${includeQuotePrice ? "?includeQuotePrice=1" : ""}`,
    {
      headers: { Accept: "application/json" },
    },
  );
  const refreshBody: unknown = await refreshRes.json().catch(() => null);
  return NextResponse.json(
    refreshBody ?? { ok: false, error: "upstream_error" },
    { status: refreshRes.status },
  );
}

export async function PATCH(request: NextRequest): Promise<Response> {
  const auth = await requireTeamPrincipal(request, {
    permissions: "contacts.write",
    returnJson: true,
  });
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const contactId = readContactId(url);
  if (!contactId) {
    return NextResponse.json(
      { ok: false, error: "contact_id_required" },
      { status: 400 },
    );
  }

  const requestPayload: unknown = await request.json().catch(() => null);
  const payload = isJsonObject(requestPayload) ? requestPayload : null;
  const actionValue = payload?.["action"];
  const action = typeof actionValue === "string" ? actionValue.trim() : "";
  const reviewNote = readReviewNote(payload?.["reviewNote"]);
  if (!action) {
    return NextResponse.json(
      { ok: false, error: "action_required" },
      { status: 400 },
    );
  }

  let currentBody: ParsedNextAction | null = null;

  if (action === "dismiss") {
    const currentRes = await callAdminApiAs(
      auth.principal,
      `/api/admin/contacts/${encodeURIComponent(contactId)}/sales-agent-next-action`,
      {
        headers: { Accept: "application/json" },
      },
    );
    const currentRaw: unknown = await currentRes.json().catch(() => null);
    currentBody = parseNextAction(currentRaw);
    if (!currentRes.ok || !currentBody?.ok) {
      return NextResponse.json(
        currentRaw ?? { ok: false, error: "next_action_unavailable" },
        { status: currentRes.status || 502 },
      );
    }

    if (reviewNote) {
      const reviewNoteError = await createReviewNote({
        principal: auth.principal,
        contactId,
        action,
        reviewNote,
      });
      if (reviewNoteError) return reviewNoteError;
    }

    const upstream = await callAdminApiAs(
      auth.principal,
      `/api/admin/contacts/${encodeURIComponent(contactId)}/sales-agent-next-action`,
      {
        method: "PATCH",
        body: JSON.stringify({ status: "dismissed" }),
        headers: { Accept: "application/json" },
      },
    );
    if (!upstream.ok) {
      const body: unknown = await upstream.json().catch(() => null);
      const errorBody = isJsonObject(body) ? body : null;
      return NextResponse.json(
        errorBody
          ? {
              ...errorBody,
              liveContext: currentBody.liveContext,
            }
          : { ok: false, error: "upstream_error" },
        { status: upstream.status },
      );
    }
    const refreshRes = await callAdminApiAs(
      auth.principal,
      `/api/admin/contacts/${encodeURIComponent(contactId)}/sales-agent-next-action`,
      {
        headers: { Accept: "application/json" },
      },
    );
    const refreshBody: unknown = await refreshRes.json().catch(() => null);
    return NextResponse.json(
      refreshBody ?? { ok: false, error: "upstream_error" },
      { status: refreshRes.status },
    );
  }

  const includeQuotePrice = url.searchParams.get("includeQuotePrice") === "1";
  const currentRes = await callAdminApiAs(
    auth.principal,
    `/api/admin/contacts/${encodeURIComponent(contactId)}/sales-agent-next-action${includeQuotePrice ? "?includeQuotePrice=1" : ""}`,
    {
      headers: { Accept: "application/json" },
    },
  );
  const currentRaw: unknown = await currentRes.json().catch(() => null);
  currentBody = parseNextAction(currentRaw);
  if (!currentRes.ok || !currentBody?.ok) {
    return NextResponse.json(
      currentRaw ?? { ok: false, error: "next_action_unavailable" },
      { status: currentRes.status || 502 },
    );
  }

  const leadId = currentBody.leadId;
  const requestedChannel = payload?.["channel"];
  const channel =
    typeof requestedChannel === "string" && requestedChannel.trim().length > 0
      ? requestedChannel.trim()
      : currentBody.channel;

  if (!leadId) {
    return NextResponse.json(
      { ok: false, error: "lead_id_unavailable" },
      { status: 400 },
    );
  }
  if (!channel) {
    return NextResponse.json(
      { ok: false, error: "channel_unavailable" },
      { status: 400 },
    );
  }

  if (reviewNote && action === "resume") {
    const reviewNoteError = await createReviewNote({
      principal: auth.principal,
      contactId,
      action,
      reviewNote,
    });
    if (reviewNoteError) return reviewNoteError;
  }

  const existingState =
    currentBody.automation.find((state) => state.channel === channel) ?? null;
  const baseState = {
    paused: existingState?.paused === true,
    dnc: existingState?.dnc === true,
    humanTakeover: existingState?.humanTakeover === true,
    followupState: existingState?.followupState ?? null,
    followupStep:
      typeof existingState?.followupStep === "number"
        ? existingState.followupStep
        : 0,
    nextFollowupAt: existingState?.nextFollowupAt ?? null,
  };

  let automationPayload: Record<string, unknown> | null = null;
  if (action === "pause") {
    automationPayload = {
      leadId,
      channel,
      paused: true,
      dnc: baseState.dnc,
      humanTakeover: false,
      followupState: baseState.followupState,
      followupStep: baseState.followupStep,
      nextFollowupAt: baseState.nextFollowupAt,
    };
  } else if (action === "human_takeover") {
    automationPayload = {
      leadId,
      channel,
      paused: false,
      dnc: baseState.dnc,
      humanTakeover: true,
      followupState: baseState.followupState,
      followupStep: baseState.followupStep,
      nextFollowupAt: baseState.nextFollowupAt,
    };
  } else if (action === "resume") {
    automationPayload = {
      leadId,
      channel,
      paused: false,
      dnc: baseState.dnc,
      humanTakeover: false,
      followupState: baseState.followupState,
      followupStep: baseState.followupStep,
      nextFollowupAt: baseState.nextFollowupAt,
    };
  } else {
    return NextResponse.json(
      { ok: false, error: "unsupported_action" },
      { status: 400 },
    );
  }

  const automationRes = await callAdminApiAs(
    auth.principal,
    "/api/admin/automation/lead",
    {
      method: "POST",
      body: JSON.stringify(automationPayload),
      headers: { Accept: "application/json" },
    },
  );
  const automationBody: unknown = await automationRes.json().catch(() => null);
  if (!automationRes.ok) {
    return NextResponse.json(
      automationBody ?? { ok: false, error: "automation_update_failed" },
      { status: automationRes.status },
    );
  }

  const rebuildRes = await callAdminApiAs(
    auth.principal,
    `/api/admin/contacts/${encodeURIComponent(contactId)}/sales-agent-next-action/rebuild${includeQuotePrice ? "?includeQuotePrice=1" : ""}`,
    {
      method: "POST",
      headers: { Accept: "application/json" },
    },
  );
  if (!rebuildRes.ok) {
    const rebuildBody: unknown = await rebuildRes.json().catch(() => null);
    return NextResponse.json(
      rebuildBody ?? { ok: false, error: "upstream_error" },
      { status: rebuildRes.status },
    );
  }
  const refreshRes = await callAdminApiAs(
    auth.principal,
    `/api/admin/contacts/${encodeURIComponent(contactId)}/sales-agent-next-action${includeQuotePrice ? "?includeQuotePrice=1" : ""}`,
    {
      headers: { Accept: "application/json" },
    },
  );
  const refreshBody: unknown = await refreshRes.json().catch(() => null);
  return NextResponse.json(
    refreshBody ?? { ok: false, error: "upstream_error" },
    { status: refreshRes.status },
  );
}
