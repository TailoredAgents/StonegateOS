import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, conversationMessages, messageDeliveryEvents } from "@/db";
import { recordInboundMessage } from "@/lib/inbox";
import { recordProviderFailure, recordProviderSuccess } from "@/lib/provider-health";

export const dynamic = "force-dynamic";

function readString(value: FormDataEntryValue | null): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function mapTwilioStatus(status: string): "queued" | "sent" | "delivered" | "failed" | null {
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
  detail: string | null
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
    console.warn("[twilio] provider_health_failed", { error: String(error) });
  }
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
  const body = readString(formData.get("Body")) ?? "";
  const messageSid = readString(formData.get("MessageSid")) ?? readString(formData.get("SmsSid"));
  const smsStatus = readString(formData.get("SmsStatus"));
  const messageStatus = readString(formData.get("MessageStatus")) ?? smsStatus;
  const numMediaValue = readString(formData.get("NumMedia"));
  const numMedia = numMediaValue ? Number(numMediaValue) : 0;

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
          deliveryStatus: conversationMessages.deliveryStatus
        })
        .from(conversationMessages)
        .where(eq(conversationMessages.providerMessageId, messageSid))
        .limit(1);

      if (message && shouldUpdateDeliveryStatus(message.deliveryStatus, mappedStatus)) {
        await db
          .update(conversationMessages)
          .set({
            deliveryStatus: mappedStatus,
            provider: "twilio"
          })
          .where(eq(conversationMessages.id, message.id));

        await db.insert(messageDeliveryEvents).values({
          messageId: message.id,
          status: mappedStatus,
          detail: messageStatus,
          provider: "twilio",
          occurredAt: new Date()
        });

        await recordProviderHealth(mappedStatus, messageStatus);
      }
    }

    return new NextResponse("ok", { status: 200 });
  }

  const mediaUrls: string[] = [];
  if (!Number.isNaN(numMedia) && numMedia > 0) {
    for (let index = 0; index < numMedia; index += 1) {
      const url = readString(formData.get(`MediaUrl${index}`));
      if (url) {
        mediaUrls.push(url);
      }
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
      mediaUrls,
      metadata: {
        smsStatus: smsStatus ?? null,
        numMedia: Number.isNaN(numMedia) ? null : numMedia
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "inbound_sms_failed";
    const status = message === "invalid_phone" ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }

  return new NextResponse("ok", { status: 200 });
}
