import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { recordInboundMessage } from "@/lib/inbox";

export const dynamic = "force-dynamic";

type Payload = Record<string, unknown>;

function readString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function pickString(payload: Payload, keys: string[]): string | null {
  for (const key of keys) {
    const value = readString(payload[key]);
    if (value) {
      return value;
    }
  }
  return null;
}

function stripHtml(input: string): string {
  return input.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

async function parsePayload(request: NextRequest): Promise<Payload> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const json = (await request.json().catch(() => null)) as Payload | null;
    return json ?? {};
  }

  const formData = await request.formData();
  const payload: Payload = {};
  formData.forEach((value, key) => {
    if (typeof value === "string") {
      payload[key] = value;
    }
  });
  return payload;
}

export async function POST(request: NextRequest): Promise<Response> {
  let payload: Payload = {};
  try {
    payload = await parsePayload(request);
  } catch {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  let from = pickString(payload, ["from", "sender", "From"]);
  let to = pickString(payload, ["to", "recipient", "To"]);
  const subject = pickString(payload, ["subject", "Subject"]) ?? null;
  const text = pickString(payload, ["text", "body-plain", "stripped-text", "Text"]);
  const html = pickString(payload, ["html", "body-html", "stripped-html"]);
  const messageId = pickString(payload, ["Message-Id", "message-id", "messageId", "MessageID"]);

  const envelope = pickString(payload, ["envelope"]);
  if (envelope) {
    try {
      const parsed = JSON.parse(envelope) as { from?: string; to?: string[] | string };
      if (!from && parsed.from) {
        from = parsed.from;
      }
      if (!to && parsed.to) {
        to = Array.isArray(parsed.to) ? parsed.to.join(",") : parsed.to;
      }
    } catch {
      // ignore malformed envelope
    }
  }

  if (!from) {
    return NextResponse.json({ error: "missing_from" }, { status: 400 });
  }

  const body = text ?? (html ? stripHtml(html) : "") ?? "";

  try {
    const result = await recordInboundMessage({
      channel: "email",
      body,
      subject,
      fromAddress: from,
      toAddress: to,
      provider: "email_webhook",
      providerMessageId: messageId ?? null,
      metadata: {
        rawSubject: subject ?? null
      }
    });

    return NextResponse.json({ ok: true, duplicate: result.duplicate });
  } catch (error) {
    const message = error instanceof Error ? error.message : "inbound_email_failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
