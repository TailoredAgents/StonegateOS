import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { recordInboundMessage } from "@/lib/inbox";

export const dynamic = "force-dynamic";

type Payload = {
  from?: string;
  body?: string;
  source?: string;
  name?: string;
  to?: string;
  externalId?: string;
  phone?: string;
  email?: string;
};

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function POST(request: NextRequest): Promise<Response> {
  const payload = (await request.json().catch(() => null)) as Payload | null;
  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const from = readString(payload.from);
  const body = readString(payload.body) ?? "";
  const source = readString(payload.source) ?? "dm_webhook";
  const to = readString(payload.to);
  const externalId = readString(payload.externalId);
  const name = readString(payload.name);
  const phone = readString(payload.phone);
  const email = readString(payload.email);

  if (!from) {
    return NextResponse.json({ error: "missing_from" }, { status: 400 });
  }

  try {
    await recordInboundMessage({
      channel: "dm",
      body,
      subject: null,
      fromAddress: from,
      toAddress: to,
      provider: source,
      providerMessageId: externalId ?? null,
      senderName: name ?? null,
      contactPhone: phone ?? null,
      contactEmail: email ?? null,
      metadata: {
        source
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "inbound_dm_failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
