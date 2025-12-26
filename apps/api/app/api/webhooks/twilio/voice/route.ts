import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, conversationThreads, leads, properties } from "@/db";
import { recordInboundMessage } from "@/lib/inbox";

export const dynamic = "force-dynamic";

const DEFAULT_SERVICES = ["junk_removal_primary"];

function readString(value: FormDataEntryValue | null): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseDuration(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isMissedCall(status: string | null, duration: number | null): boolean {
  if (!status) return false;
  const normalized = status.toLowerCase();
  if (["no-answer", "busy", "failed", "canceled"].includes(normalized)) {
    return true;
  }
  if (normalized === "completed" && (duration ?? 0) === 0) {
    return true;
  }
  return false;
}

async function ensureLeadForThread(input: {
  threadId: string;
  callSid: string | null;
  from: string;
}): Promise<void> {
  const db = getDb();
  const now = new Date();

  await db.transaction(async (tx) => {
    const [thread] = await tx
      .select({
        id: conversationThreads.id,
        leadId: conversationThreads.leadId,
        contactId: conversationThreads.contactId,
        propertyId: conversationThreads.propertyId
      })
      .from(conversationThreads)
      .where(eq(conversationThreads.id, input.threadId))
      .limit(1);

    if (!thread?.contactId || thread.leadId) {
      return;
    }

    const shortId = input.threadId.split("-")[0] ?? input.threadId.slice(0, 8);
    const [property] = await tx
      .insert(properties)
      .values({
        contactId: thread.contactId,
        addressLine1: `[Missed Call ${shortId}] Address pending`,
        city: "Unknown",
        state: "NA",
        postalCode: "00000",
        gated: false,
        createdAt: now,
        updatedAt: now
      })
      .returning({ id: properties.id });

    if (!property?.id) {
      throw new Error("missed_call_property_failed");
    }

    const [lead] = await tx
      .insert(leads)
      .values({
        contactId: thread.contactId,
        propertyId: property.id,
        servicesRequested: DEFAULT_SERVICES,
        status: "new",
        source: "missed_call",
        notes: "Missed call auto lead.",
        formPayload: {
          source: "missed_call",
          callSid: input.callSid,
          from: input.from
        },
        createdAt: now,
        updatedAt: now
      })
      .returning({ id: leads.id });

    if (!lead?.id) {
      throw new Error("missed_call_lead_failed");
    }

    await tx
      .update(conversationThreads)
      .set({
        leadId: lead.id,
        propertyId: property.id,
        updatedAt: now
      })
      .where(eq(conversationThreads.id, input.threadId));
  });
}

export async function POST(request: NextRequest): Promise<Response> {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "invalid_form" }, { status: 400 });
  }

  const from = readString(formData.get("From"));
  const to = readString(formData.get("To"));
  const callSid = readString(formData.get("CallSid"));
  const callStatus = readString(formData.get("CallStatus"));
  const duration = parseDuration(readString(formData.get("CallDuration")));

  if (!from) {
    return NextResponse.json({ error: "missing_from" }, { status: 400 });
  }

  if (!isMissedCall(callStatus, duration)) {
    return new NextResponse("ok", { status: 200 });
  }

  let result: Awaited<ReturnType<typeof recordInboundMessage>>;
  try {
    result = await recordInboundMessage({
      channel: "call",
      body: "Missed call",
      subject: "Missed call",
      fromAddress: from,
      toAddress: to,
      provider: "twilio",
      providerMessageId: callSid ?? null,
      metadata: {
        callStatus: callStatus ?? null,
        callDuration: duration
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "inbound_call_failed";
    const status = message === "invalid_phone" ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }

  if (!result.leadId && result.threadId) {
    try {
      await ensureLeadForThread({ threadId: result.threadId, callSid, from });
    } catch (error) {
      console.warn("[twilio] missed_call_lead_failed", { error: String(error) });
    }
  }

  return new NextResponse("ok", { status: 200 });
}
