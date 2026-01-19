import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, asc, eq, ilike, isNotNull } from "drizzle-orm";
import { getDb, contacts, crmTasks, policySettings, teamMembers } from "@/db";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { isAdminRequest } from "../../../web/admin";
import { normalizePhone } from "../../../web/utils";
import { getSalesScorecardConfig } from "@/lib/sales-scorecard";
import { completeNextFollowupTaskOnTouch } from "@/lib/sales-followups";

type StartCallPayload = {
  contactId?: string;
  taskId?: string;
  agentPhone?: string;
  toPhone?: string;
};

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readPhoneMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const phonesRaw = value["phones"];
  if (!isRecord(phonesRaw)) return {};
  const phones: Record<string, string> = {};
  for (const [key, raw] of Object.entries(phonesRaw)) {
    if (typeof raw === "string" && raw.trim().length > 0) {
      phones[key] = raw.trim();
    }
  }
  return phones;
}

async function resolveFallbackDefaultAssigneeMemberId(): Promise<string | null> {
  try {
    const config = await getSalesScorecardConfig();
    return config.defaultAssigneeMemberId ?? null;
  } catch {
    const db = getDb();
    const [member] = await db
      .select({ id: teamMembers.id })
      .from(teamMembers)
      .orderBy(asc(teamMembers.createdAt))
      .limit(1);
    return member?.id ?? null;
  }
}

function resolveApiBaseUrl(request: NextRequest): string {
  const candidates = [
    process.env["NEXT_PUBLIC_API_BASE_URL"],
    process.env["API_BASE_URL"]
  ]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value.length > 0);

  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      if (url.protocol !== "https:" && url.protocol !== "http:") continue;
      const host = url.hostname.toLowerCase();
      const isLocalhost =
        host === "localhost" ||
        host === "0.0.0.0" ||
        host === "127.0.0.1" ||
        host.endsWith(".internal");
      if (isLocalhost) continue;
      return url.toString().replace(/\/$/, "");
    } catch {
      continue;
    }
  }

  return request.nextUrl.origin.replace(/\/$/, "");
}

async function createTwilioCall(input: { agentPhone: string; toPhone: string; request: NextRequest; taskId?: string | null }) {
  const sid = process.env["TWILIO_ACCOUNT_SID"];
  const token = process.env["TWILIO_AUTH_TOKEN"];
  const from = process.env["TWILIO_FROM"];
  const baseUrl = (process.env["TWILIO_API_BASE_URL"] ?? "https://api.twilio.com").replace(/\/$/, "");

  if (!sid || !token || !from) {
    return { ok: false as const, error: "twilio_not_configured", message: "Twilio is not configured on the API service." };
  }

  const callbackUrl = new URL(`${resolveApiBaseUrl(input.request)}/api/webhooks/twilio/connect`);
  callbackUrl.searchParams.set("to", input.toPhone);
  if (input.taskId) {
    callbackUrl.searchParams.set("taskId", input.taskId);
  }

  const statusCallbackUrl = new URL(`${resolveApiBaseUrl(input.request)}/api/webhooks/twilio/call-status`);
  statusCallbackUrl.searchParams.set("leg", "agent");

  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  const formParams = new URLSearchParams({
    To: input.agentPhone,
    From: from,
    Url: callbackUrl.toString(),
    Method: "POST",
    StatusCallback: statusCallbackUrl.toString(),
    StatusCallbackMethod: "POST"
  });

  for (const event of ["initiated", "ringing", "answered", "completed"]) {
    formParams.append("StatusCallbackEvent", event);
  }

  const form = formParams.toString();

  const response = await fetch(`${baseUrl}/2010-04-01/Accounts/${sid}/Calls.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${auth}`
    },
    body: form
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let detail = text.trim();
    try {
      const parsed = JSON.parse(text) as { message?: unknown; code?: unknown; more_info?: unknown };
      const message = typeof parsed.message === "string" ? parsed.message.trim() : "";
      const code = typeof parsed.code === "number" ? parsed.code : null;
      const moreInfo = typeof parsed.more_info === "string" ? parsed.more_info.trim() : "";

      const parts = [
        message.length ? message : null,
        code ? `code ${code}` : null,
        moreInfo.length ? moreInfo : null
      ].filter(Boolean);

      if (parts.length) {
        detail = parts.join(" - ");
      }
    } catch {
      // ignore json parsing; fall back to raw text
    }

    const message = detail.length
      ? `Twilio rejected the call request (${response.status}): ${detail}`
      : `Twilio rejected the call request (${response.status}).`;
    return { ok: false as const, error: "twilio_call_failed", message };
  }

  const payload = (await response.json().catch(() => null)) as { sid?: string } | null;
  return { ok: true as const, callSid: payload?.sid ?? null };
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let json: StartCallPayload;
  try {
    json = (await request.json()) as StartCallPayload;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const contactId = readString(json.contactId);
  const taskIdRaw = readString(json.taskId);
  const agentPhoneRaw = readString(json.agentPhone);
  const toPhoneRaw = readString(json.toPhone);
  const taskId = taskIdRaw && isUuid(taskIdRaw) ? taskIdRaw : null;

  const db = getDb();

  let toPhone: string | null = null;
  let resolvedContactId: string | null = null;
  let resolvedAssigneeMemberId: string | null = null;
  if (toPhoneRaw) {
    try {
      toPhone = normalizePhone(toPhoneRaw).e164;
    } catch {
      return NextResponse.json({ error: "invalid_to_phone" }, { status: 400 });
    }
  } else if (contactId) {
    const [row] = await db
      .select({
        id: contacts.id,
        phone: contacts.phone,
        phoneE164: contacts.phoneE164,
        salespersonMemberId: contacts.salespersonMemberId
      })
      .from(contacts)
      .where(eq(contacts.id, contactId))
      .limit(1);

    if (!row?.id) {
      return NextResponse.json({ error: "contact_not_found" }, { status: 404 });
    }

    resolvedContactId = row.id;
    resolvedAssigneeMemberId = row.salespersonMemberId ?? null;
    const phoneCandidate = row.phoneE164 ?? row.phone ?? null;
    if (!phoneCandidate) {
      return NextResponse.json({ error: "contact_missing_phone" }, { status: 400 });
    }

    try {
      toPhone = normalizePhone(phoneCandidate).e164;
    } catch {
      return NextResponse.json({ error: "contact_invalid_phone" }, { status: 400 });
    }
  }

  if (!toPhone) {
    return NextResponse.json({ error: "missing_to_phone" }, { status: 400 });
  }

  let agentPhone: string;
  let auditActorOverride: ReturnType<typeof getAuditActorFromRequest> | null = null;

  if (agentPhoneRaw) {
    try {
      agentPhone = normalizePhone(agentPhoneRaw).e164;
    } catch {
      return NextResponse.json({ error: "invalid_agent_phone" }, { status: 400 });
    }
  } else {
    const assigneeMemberId =
      resolvedAssigneeMemberId ??
      (await resolveFallbackDefaultAssigneeMemberId());

    if (!assigneeMemberId) {
      return NextResponse.json({ error: "missing_agent_phone", message: "No default salesperson is configured." }, { status: 400 });
    }

    const [phoneSetting] = await db
      .select({ value: policySettings.value })
      .from(policySettings)
      .where(eq(policySettings.key, "team_member_phones"))
      .limit(1);
    const phoneMap = readPhoneMap(phoneSetting?.value);
    const phoneCandidate = phoneMap[assigneeMemberId] ?? null;
    if (!phoneCandidate) {
      return NextResponse.json(
        {
          error: "missing_agent_phone",
          message: "No phone is configured for the assigned salesperson. Set it in Team Console: Access."
        },
        { status: 400 }
      );
    }

    try {
      agentPhone = normalizePhone(phoneCandidate).e164;
    } catch {
      return NextResponse.json({ error: "invalid_agent_phone", message: "Assigned salesperson phone is invalid." }, { status: 400 });
    }

    auditActorOverride = {
      type: "system",
      id: assigneeMemberId,
      label: "assigned_salesperson"
    };
  }

  const result = await createTwilioCall({ agentPhone, toPhone, request, taskId });
  if (!result.ok) {
    console.warn("[calls.start] twilio_call_failed", {
      contactId: resolvedContactId ?? contactId ?? null,
      agentPhone,
      toPhone,
      detail: result.error,
      message: result.message
    });
    return NextResponse.json({ error: result.error, message: result.message }, { status: 502 });
  }

  const actor = auditActorOverride ?? getAuditActorFromRequest(request);
  await recordAuditEvent({
    actor,
    action: "call.started",
    entityType: "contact",
    entityId: resolvedContactId ?? contactId ?? null,
    meta: {
      agentPhone,
      toPhone,
      callSid: result.callSid,
      taskId
    }
  });

  const contactEntityId = resolvedContactId ?? contactId ?? null;
  if (contactEntityId && actor.id) {
    try {
      const now = new Date();
      await db
        .update(crmTasks)
        .set({ status: "completed", updatedAt: now })
        .where(
          and(
            eq(crmTasks.contactId, contactEntityId),
            eq(crmTasks.assignedTo, actor.id),
            eq(crmTasks.status, "open"),
            isNotNull(crmTasks.notes),
            ilike(crmTasks.notes, "%kind=speed_to_lead%")
          )
        );

      await completeNextFollowupTaskOnTouch({
        db,
        contactId: contactEntityId,
        memberId: actor.id,
        now
      });
    } catch (error) {
      console.warn("[calls.start] task_touch_update_failed", { contactId: contactEntityId, actorId: actor.id, error: String(error) });
    }
  }

  return NextResponse.json({ ok: true, callSid: result.callSid });
}
