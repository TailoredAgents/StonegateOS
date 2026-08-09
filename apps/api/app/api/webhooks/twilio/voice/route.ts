import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, conversationThreads, leads, outboxEvents } from "@/db";
import { recordInboundMessage } from "@/lib/inbox";
import { resolveOrCreateContactProperty } from "@/lib/property-write";
import { verifyTwilioWebhookRequest } from "@/lib/twilio-webhook-auth";

export const dynamic = "force-dynamic";

const DEFAULT_SERVICES = ["junk_removal_primary"];

function readString(value: FormDataEntryValue | null): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
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
        propertyId: conversationThreads.propertyId,
      })
      .from(conversationThreads)
      .where(eq(conversationThreads.id, input.threadId))
      .limit(1);

    if (!thread?.contactId || thread.leadId) {
      return;
    }

    const shortId = input.threadId.split("-")[0] ?? input.threadId.slice(0, 8);
    const { property } = await resolveOrCreateContactProperty(tx, {
      contactId: thread.contactId,
      // The thread-derived token intentionally keeps each unknown location
      // distinct until staff replace it with a real physical address.
      addressLine1: `[Missed Call ${shortId}] Address pending`,
      city: "Unknown",
      state: "NA",
      postalCode: "00000",
      gated: false,
      now,
    });

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
          from: input.from,
        },
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: leads.id });

    if (!lead?.id) {
      throw new Error("missed_call_lead_failed");
    }

    await tx.insert(outboxEvents).values({
      type: "lead.alert",
      payload: {
        leadId: lead.id,
        source: "missed_call",
      },
    });

    await tx
      .update(conversationThreads)
      .set({
        leadId: lead.id,
        propertyId: property.id,
        updatedAt: now,
      })
      .where(eq(conversationThreads.id, input.threadId));
  });
}

export async function POST(request: NextRequest): Promise<Response> {
  const verified = await verifyTwilioWebhookRequest(request);
  if (!verified.ok) return verified.response;
  const { formData } = verified;

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
        callDuration: duration,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "inbound_call_failed";
    const status = message === "invalid_phone" ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }

  if (!result.leadId && result.threadId) {
    try {
      await ensureLeadForThread({ threadId: result.threadId, callSid, from });
    } catch (error) {
      console.warn("[twilio] missed_call_lead_failed", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }

  return new NextResponse("ok", { status: 200 });
}
