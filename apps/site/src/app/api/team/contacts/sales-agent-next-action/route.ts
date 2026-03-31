import { callAdminApi } from "@/app/team/lib/api";
import { NextResponse } from "next/server";

function readContactId(url: URL): string {
  return url.searchParams.get("contactId")?.trim() ?? "";
}

type NextActionProxyPayload = {
  ok?: boolean;
  nextAction?: {
    channel?: string | null;
  } | null;
  executionState?: {
    code?: string | null;
    label?: string | null;
    detail?: string | null;
    tone?: "good" | "warn" | "bad" | "neutral" | null;
  } | null;
  latestDraft?: {
    id?: string | null;
    threadId?: string | null;
    channel?: string | null;
    createdAt?: string | null;
  } | null;
  liveContext?: {
    latestLead?: {
      id?: string | null;
    } | null;
    automation?: Array<{
      channel?: string | null;
      paused?: boolean;
      dnc?: boolean;
      humanTakeover?: boolean;
      followupState?: string | null;
      followupStep?: number | null;
      nextFollowupAt?: string | null;
    }> | null;
  } | null;
};

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const contactId = readContactId(url);
  if (!contactId) {
    return NextResponse.json({ ok: false, error: "contact_id_required" }, { status: 400 });
  }

  const includeQuotePrice = url.searchParams.get("includeQuotePrice") === "1";
  const upstream = await callAdminApi(
    `/api/admin/contacts/${encodeURIComponent(contactId)}/sales-agent-next-action${includeQuotePrice ? "?includeQuotePrice=1" : ""}`,
    {
      headers: { Accept: "application/json" },
    },
  );

  const body = await upstream.json().catch(() => null);
  return NextResponse.json(body ?? { ok: false, error: "upstream_error" }, { status: upstream.status });
}

export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const contactId = readContactId(url);
  if (!contactId) {
    return NextResponse.json({ ok: false, error: "contact_id_required" }, { status: 400 });
  }

  const includeQuotePrice = url.searchParams.get("includeQuotePrice") === "1";
  const upstreamPath =
    `/api/admin/contacts/${encodeURIComponent(contactId)}/sales-agent-next-action/rebuild${includeQuotePrice ? "?includeQuotePrice=1" : ""}`;
  const upstream = await callAdminApi(upstreamPath, {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  if (!upstream.ok) {
    const body = await upstream.json().catch(() => null);
    return NextResponse.json(body ?? { ok: false, error: "upstream_error" }, { status: upstream.status });
  }
  const refreshRes = await callAdminApi(
    `/api/admin/contacts/${encodeURIComponent(contactId)}/sales-agent-next-action${includeQuotePrice ? "?includeQuotePrice=1" : ""}`,
    {
      headers: { Accept: "application/json" },
    },
  );
  const refreshBody = await refreshRes.json().catch(() => null);
  return NextResponse.json(refreshBody ?? { ok: false, error: "upstream_error" }, { status: refreshRes.status });
}

export async function PATCH(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const contactId = readContactId(url);
  if (!contactId) {
    return NextResponse.json({ ok: false, error: "contact_id_required" }, { status: 400 });
  }

  const payload = (await request.json().catch(() => null)) as
    | { action?: string; channel?: string | null }
    | null;
  const action = typeof payload?.action === "string" ? payload.action.trim() : "";
  if (!action) {
    return NextResponse.json({ ok: false, error: "action_required" }, { status: 400 });
  }

  let currentBody: NextActionProxyPayload | null = null;

  if (action === "dismiss") {
    const currentRes = await callAdminApi(
      `/api/admin/contacts/${encodeURIComponent(contactId)}/sales-agent-next-action`,
      {
        headers: { Accept: "application/json" },
      },
    );
    currentBody = (await currentRes.json().catch(() => null)) as NextActionProxyPayload | null;
    if (!currentRes.ok || !currentBody?.ok) {
      return NextResponse.json(
        currentBody ?? { ok: false, error: "next_action_unavailable" },
        { status: currentRes.status || 502 },
      );
    }

    const upstream = await callAdminApi(
      `/api/admin/contacts/${encodeURIComponent(contactId)}/sales-agent-next-action`,
      {
        method: "PATCH",
        body: JSON.stringify({ status: "dismissed" }),
        headers: { Accept: "application/json" },
      },
    );
    if (!upstream.ok) {
      const body = await upstream.json().catch(() => null);
      return NextResponse.json(
        body
          ? {
              ...body,
              liveContext: currentBody.liveContext ?? null,
            }
          : { ok: false, error: "upstream_error" },
        { status: upstream.status },
      );
    }
    const refreshRes = await callAdminApi(
      `/api/admin/contacts/${encodeURIComponent(contactId)}/sales-agent-next-action`,
      {
        headers: { Accept: "application/json" },
      },
    );
    const refreshBody = await refreshRes.json().catch(() => null);
    return NextResponse.json(refreshBody ?? { ok: false, error: "upstream_error" }, { status: refreshRes.status });
  }

  const includeQuotePrice = url.searchParams.get("includeQuotePrice") === "1";
  const currentRes = await callAdminApi(
    `/api/admin/contacts/${encodeURIComponent(contactId)}/sales-agent-next-action${includeQuotePrice ? "?includeQuotePrice=1" : ""}`,
    {
      headers: { Accept: "application/json" },
    },
  );
  currentBody = (await currentRes.json().catch(() => null)) as NextActionProxyPayload | null;
  if (!currentRes.ok || !currentBody?.ok) {
    return NextResponse.json(
      currentBody ?? { ok: false, error: "next_action_unavailable" },
      { status: currentRes.status || 502 },
    );
  }

  const leadId = currentBody.liveContext?.latestLead?.id ?? null;
  const channel =
    (typeof payload?.channel === "string" && payload.channel.trim().length > 0
      ? payload.channel.trim()
      : currentBody.nextAction?.channel ?? null);

  if (!leadId) {
    return NextResponse.json({ ok: false, error: "lead_id_unavailable" }, { status: 400 });
  }
  if (!channel) {
    return NextResponse.json({ ok: false, error: "channel_unavailable" }, { status: 400 });
  }

  const existingState =
    currentBody.liveContext?.automation?.find((state) => state?.channel === channel) ?? null;
  const baseState = {
    paused: existingState?.paused === true,
    dnc: existingState?.dnc === true,
    humanTakeover: existingState?.humanTakeover === true,
    followupState: existingState?.followupState ?? null,
    followupStep: typeof existingState?.followupStep === "number" ? existingState.followupStep : 0,
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
    return NextResponse.json({ ok: false, error: "unsupported_action" }, { status: 400 });
  }

  const automationRes = await callAdminApi("/api/admin/automation/lead", {
    method: "POST",
    body: JSON.stringify(automationPayload),
    headers: { Accept: "application/json" },
  });
  const automationBody = await automationRes.json().catch(() => null);
  if (!automationRes.ok) {
    return NextResponse.json(
      automationBody ?? { ok: false, error: "automation_update_failed" },
      { status: automationRes.status },
    );
  }

  const rebuildRes = await callAdminApi(
    `/api/admin/contacts/${encodeURIComponent(contactId)}/sales-agent-next-action/rebuild${includeQuotePrice ? "?includeQuotePrice=1" : ""}`,
    {
      method: "POST",
      headers: { Accept: "application/json" },
    },
  );
  if (!rebuildRes.ok) {
    const rebuildBody = await rebuildRes.json().catch(() => null);
    return NextResponse.json(
      rebuildBody ?? { ok: false, error: "upstream_error" },
      { status: rebuildRes.status },
    );
  }
  const refreshRes = await callAdminApi(
    `/api/admin/contacts/${encodeURIComponent(contactId)}/sales-agent-next-action${includeQuotePrice ? "?includeQuotePrice=1" : ""}`,
    {
      headers: { Accept: "application/json" },
    },
  );
  const refreshBody = await refreshRes.json().catch(() => null);
  return NextResponse.json(
    refreshBody ?? { ok: false, error: "upstream_error" },
    { status: refreshRes.status },
  );
}
