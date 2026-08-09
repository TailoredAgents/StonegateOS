import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, conversationMessages, messageDeliveryEvents } from "@/db";
import { recordInboundMessage } from "@/lib/inbox";
import { handleCrewEtaSms } from "@/lib/eta-agent";
import {
  recordProviderFailure,
  recordProviderSuccess,
} from "@/lib/provider-health";
import {
  findActiveTeamMemberByPhone,
  normalizePhoneE164,
} from "@/lib/team-auth";
import { parseTwilioInboundMedia } from "@/lib/twilio-inbound-media";
import { verifyTwilioWebhookRequest } from "@/lib/twilio-webhook-auth";

export const dynamic = "force-dynamic";

const EMPTY_TWIML_RESPONSE = `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;

function twimlOk(): NextResponse {
  return new NextResponse(EMPTY_TWIML_RESPONSE, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}

function readString(value: FormDataEntryValue | null): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function mapTwilioStatus(
  status: string,
): "queued" | "sent" | "delivered" | "failed" | null {
  switch (status.toLowerCase()) {
    case "queued":
      return "queued";
    case "sending":
    case "sent":
      return "sent";
    case "delivered":
      return "delivered";
    case "undelivered":
    case "failed":
      return "failed";
    default:
      return null;
  }
}

function shouldUpdateDeliveryStatus(current: string, next: string): boolean {
  if (current === next) {
    return false;
  }
  if (current === "delivered" || current === "failed") {
    return false;
  }
  if (current === "sent" && next === "queued") {
    return false;
  }
  return true;
}

async function recordProviderHealth(
  status: "queued" | "sent" | "delivered" | "failed",
  detail: string | null,
) {
  try {
    if (status === "queued") {
      return;
    }
    if (status === "failed") {
      await recordProviderFailure("sms", detail ?? null);
    } else {
      await recordProviderSuccess("sms");
    }
  } catch (error) {
    console.warn("[twilio] provider_health_failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  const verified = await verifyTwilioWebhookRequest(request);
  if (!verified.ok) return verified.response;
  const { formData } = verified;

  const from = readString(formData.get("From"));
  const to = readString(formData.get("To"));
  const body = readString(formData.get("Body")) ?? "";
  const messageSid =
    readString(formData.get("MessageSid")) ??
    readString(formData.get("SmsSid"));
  const smsStatus = readString(formData.get("SmsStatus"));
  const messageStatus = readString(formData.get("MessageStatus")) ?? smsStatus;
  const inboundMedia = parseTwilioInboundMedia(formData);
  if (!inboundMedia.ok) {
    return NextResponse.json({ error: inboundMedia.code }, { status: 400 });
  }

  if (!from) {
    return NextResponse.json({ error: "missing_from" }, { status: 400 });
  }

  const isStatusUpdate =
    messageStatus &&
    messageStatus !== "received" &&
    messageStatus !== "inbound" &&
    (body.length === 0 || body === "");

  if (isStatusUpdate && messageSid) {
    const mappedStatus = mapTwilioStatus(messageStatus);
    if (mappedStatus) {
      const db = getDb();
      const [message] = await db
        .select({
          id: conversationMessages.id,
          deliveryStatus: conversationMessages.deliveryStatus,
        })
        .from(conversationMessages)
        .where(eq(conversationMessages.providerMessageId, messageSid))
        .limit(1);

      if (
        message &&
        shouldUpdateDeliveryStatus(message.deliveryStatus, mappedStatus)
      ) {
        await db
          .update(conversationMessages)
          .set({
            deliveryStatus: mappedStatus,
            provider: "twilio",
          })
          .where(eq(conversationMessages.id, message.id));

        await db.insert(messageDeliveryEvents).values({
          messageId: message.id,
          status: mappedStatus,
          detail: messageStatus,
          provider: "twilio",
          occurredAt: new Date(),
        });

        await recordProviderHealth(mappedStatus, messageStatus);
      }
    }

    return twimlOk();
  }

  const fromE164 = normalizePhoneE164(from);
  if (fromE164) {
    const teamMember = await findActiveTeamMemberByPhone(fromE164);
    if (teamMember) {
      await handleCrewEtaSms({
        teamMember,
        body,
        fromAddress: fromE164,
      });
      return twimlOk();
    }
  }

  try {
    await recordInboundMessage({
      channel: "sms",
      body,
      fromAddress: from,
      toAddress: to,
      provider: "twilio",
      providerMessageId: messageSid ?? null,
      mediaUrls: inboundMedia.mediaUrls,
      metadata: {
        smsStatus: smsStatus ?? null,
        numMedia: inboundMedia.count,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "inbound_sms_failed";
    const status = message === "invalid_phone" ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }

  return twimlOk();
}
