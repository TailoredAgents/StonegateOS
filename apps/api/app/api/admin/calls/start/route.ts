import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, contacts } from "@/db";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { isAdminRequest } from "../../../web/admin";
import { normalizePhone } from "../../../web/utils";

type StartCallPayload = {
  contactId?: string;
  agentPhone?: string;
  toPhone?: string;
};

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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

async function createTwilioCall(input: { agentPhone: string; toPhone: string; request: NextRequest }) {
  const sid = process.env["TWILIO_ACCOUNT_SID"];
  const token = process.env["TWILIO_AUTH_TOKEN"];
  const from = process.env["TWILIO_FROM"];
  const baseUrl = (process.env["TWILIO_API_BASE_URL"] ?? "https://api.twilio.com").replace(/\/$/, "");

  if (!sid || !token || !from) {
    return { ok: false as const, error: "twilio_not_configured" };
  }

  const callbackUrl = new URL(`${resolveApiBaseUrl(input.request)}/api/webhooks/twilio/connect`);
  callbackUrl.searchParams.set("to", input.toPhone);

  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  const form = new URLSearchParams({
    To: input.agentPhone,
    From: from,
    Url: callbackUrl.toString(),
    Method: "POST"
  }).toString();

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
    return { ok: false as const, error: `twilio_call_failed:${response.status}:${text}` };
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
  const agentPhoneRaw = readString(json.agentPhone);
  const toPhoneRaw = readString(json.toPhone);

  if (!agentPhoneRaw) {
    return NextResponse.json({ error: "missing_agent_phone" }, { status: 400 });
  }

  let agentPhone: string;
  try {
    agentPhone = normalizePhone(agentPhoneRaw).e164;
  } catch {
    return NextResponse.json({ error: "invalid_agent_phone" }, { status: 400 });
  }

  const db = getDb();

  let toPhone: string | null = null;
  let resolvedContactId: string | null = null;
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
        phoneE164: contacts.phoneE164
      })
      .from(contacts)
      .where(eq(contacts.id, contactId))
      .limit(1);

    if (!row?.id) {
      return NextResponse.json({ error: "contact_not_found" }, { status: 404 });
    }

    resolvedContactId = row.id;
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

  const result = await createTwilioCall({ agentPhone, toPhone, request });
  if (!result.ok) {
    console.warn("[calls.start] twilio_call_failed", {
      contactId: resolvedContactId ?? contactId ?? null,
      agentPhone,
      toPhone,
      detail: result.error
    });
    return NextResponse.json({ error: result.error }, { status: 500 });
  }

  const actor = getAuditActorFromRequest(request);
  await recordAuditEvent({
    actor,
    action: "call.started",
    entityType: "contact",
    entityId: resolvedContactId ?? contactId ?? null,
    meta: {
      agentPhone,
      toPhone,
      callSid: result.callSid
    }
  });

  return NextResponse.json({ ok: true, callSid: result.callSid });
}
