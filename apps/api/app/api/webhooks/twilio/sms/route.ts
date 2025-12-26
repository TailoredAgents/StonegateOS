import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { recordInboundMessage } from "@/lib/inbox";

export const dynamic = "force-dynamic";

function readString(value: FormDataEntryValue | null): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
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
  const numMediaValue = readString(formData.get("NumMedia"));
  const numMedia = numMediaValue ? Number(numMediaValue) : 0;

  if (!from) {
    return NextResponse.json({ error: "missing_from" }, { status: 400 });
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
