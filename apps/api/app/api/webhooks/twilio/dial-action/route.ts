import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { callRecords, contacts, getDb } from "@/db";
import { eq } from "drizzle-orm";
import {
  enqueueOpenAiAdsPhoneInquiry,
  isOpenAiAdsPhoneInquiry,
} from "@/lib/openai-ads-capture";
import { normalizePhone } from "../../../web/utils";
import {
  handleManualCallDialActionCallback,
  ManualCallCallbackError,
} from "@/lib/manual-call-callbacks";
import {
  adoptLegacySalesEscalationCallback,
  handleSalesEscalationDialActionCallback,
  SalesEscalationCallbackError,
} from "@/lib/sales-escalation-call-operations";
import { verifyTwilioWebhookRequest } from "@/lib/twilio-webhook-auth";
import { escapeTwilioXmlText } from "@/lib/twilio-xml";

export const dynamic = "force-dynamic";

function twimlResponse(xml: string, status = 200): Response {
  return new NextResponse(xml, {
    status,
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
    },
  });
}

function readString(value: FormDataEntryValue | null): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function readNumber(value: FormDataEntryValue | null): number | null {
  const raw = readString(value);
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function readBoolean(value: FormDataEntryValue | null): boolean | null {
  const raw = readString(value)?.toLowerCase();
  if (raw === "true") return true;
  if (raw === "false") return false;
  return null;
}

export async function POST(request: NextRequest): Promise<Response> {
  const verified = await verifyTwilioWebhookRequest(request);
  if (!verified.ok) return verified.response;
  const { formData } = verified;

  const leg = request.nextUrl.searchParams.get("leg")?.trim() || "unknown";
  const mode = request.nextUrl.searchParams.get("mode")?.trim() || null;
  let eventKey = request.nextUrl.searchParams.get("eventKey")?.trim() || "";
  let operationKey =
    request.nextUrl.searchParams.get("operationKey")?.trim() || "";
  const requestKey =
    request.nextUrl.searchParams.get("requestKey")?.trim() || null;

  const payload = {
    leg,
    callSid: readString(formData.get("CallSid")),
    parentCallSid: readString(formData.get("ParentCallSid")),
    callStatus: readString(formData.get("CallStatus")),
    from: readString(formData.get("From")),
    to: readString(formData.get("To")),
    dialCallSid: readString(formData.get("DialCallSid")),
    dialCallStatus: readString(formData.get("DialCallStatus")),
    dialCallDuration: readNumber(formData.get("DialCallDuration")),
    dialBridged: readString(formData.get("DialBridged")),
    dialSipResponseCode: readString(formData.get("DialSipResponseCode")),
    dialHangupCause: readString(formData.get("DialHangupCause")),
    dialCallQuality: readString(formData.get("DialCallQuality")),
  };

  console.info("[twilio.dial_action]", {
    leg: payload.leg,
    hasCallSid: Boolean(payload.callSid),
    hasParentCallSid: Boolean(payload.parentCallSid),
    callStatus: payload.callStatus,
    hasDialCallSid: Boolean(payload.dialCallSid),
    dialCallStatus: payload.dialCallStatus,
    dialCallDuration: payload.dialCallDuration,
    dialBridged: payload.dialBridged,
    dialSipResponseCode: payload.dialSipResponseCode,
    dialHangupCause: payload.dialHangupCause,
    dialCallQuality: payload.dialCallQuality,
    hasFrom: Boolean(payload.from),
    hasTo: Boolean(payload.to),
  });

  if (requestKey) {
    if (leg !== "customer") {
      return twimlResponse(
        `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`,
        400,
      );
    }
    try {
      await handleManualCallDialActionCallback({
        db: getDb(),
        requestKey,
        parentCallSid: payload.callSid ?? payload.parentCallSid,
        customerCallSid: payload.dialCallSid,
        dialCallStatus: payload.dialCallStatus,
        dialCallDuration: payload.dialCallDuration,
        dialBridged: readBoolean(formData.get("DialBridged")),
      });
      return twimlResponse(
        `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`,
        200,
      );
    } catch (error) {
      return twimlResponse(
        `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`,
        error instanceof ManualCallCallbackError ? error.status : 500,
      );
    }
  }

  if (mode === "sales_escalation") {
    if (leg !== "customer") {
      return twimlResponse(
        `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`,
        400,
      );
    }
    if (!eventKey && !operationKey) {
      try {
        const adopted = await adoptLegacySalesEscalationCallback({
          db: getDb(),
          parentCallSid: payload.callSid ?? payload.parentCallSid,
        });
        eventKey = adopted.eventKey;
        operationKey = adopted.operationKey;
      } catch (error) {
        return twimlResponse(
          `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`,
          error instanceof SalesEscalationCallbackError ? error.status : 500,
        );
      }
    }
    try {
      const result = await handleSalesEscalationDialActionCallback({
        db: getDb(),
        eventKey,
        operationKey,
        parentCallSid: payload.callSid ?? payload.parentCallSid,
        customerCallSid: payload.dialCallSid,
        status: payload.dialCallStatus ?? payload.callStatus,
        durationSec: payload.dialCallDuration,
        bridged: readBoolean(formData.get("DialBridged")),
      });
      const agentMessage =
        result.outcome === "connected"
          ? null
          : result.outcome === "not_connected"
            ? "The customer did not connect. Please try again later."
            : "The call result needs review before another attempt.";
      return agentMessage
        ? twimlResponse(
            `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${escapeTwilioXmlText(agentMessage)}</Say><Hangup/></Response>`,
            200,
          )
        : twimlResponse(
            `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`,
            200,
          );
    } catch (error) {
      console.warn("[twilio.dial_action] sales_escalation_callback_failed", {
        hasEventKey: true,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      return twimlResponse(
        `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`,
        error instanceof SalesEscalationCallbackError ? error.status : 500,
      );
    }
  }

  if (mode === "inbound" && payload.callSid && payload.from) {
    const inquiry = {
      callSid: payload.callSid,
      direction: readString(formData.get("Direction")),
      status: payload.dialCallStatus,
      duration: payload.dialCallDuration,
      dialCallStatus: payload.dialCallStatus,
      dialCallDuration: payload.dialCallDuration,
      dialBridged: readBoolean(formData.get("DialBridged")),
      answeredBy: readString(formData.get("AnsweredBy")),
    };
    if (isOpenAiAdsPhoneInquiry(inquiry)) {
      try {
        const phone = normalizePhone(payload.from).e164;
        const db = getDb();
        await db.transaction(async (tx) => {
          const [contact] = await tx
            .select({ id: contacts.id })
            .from(contacts)
            .where(eq(contacts.phoneE164, phone))
            .limit(1);
          const now = new Date();
          await tx
            .insert(callRecords)
            .values({
              callSid: payload.callSid!,
              direction: "inbound",
              mode: "inbound",
              from: phone,
              to: payload.to,
              contactId: contact?.id ?? null,
              callStatus: "completed",
              callDurationSec: payload.dialCallDuration,
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: callRecords.callSid,
              set: {
                callStatus: "completed",
                callDurationSec: payload.dialCallDuration,
                updatedAt: now,
              },
            });
          const result = await enqueueOpenAiAdsPhoneInquiry(tx, {
            ...inquiry,
            contactId: contact?.id ?? null,
            phone,
            now,
          });
          if (result === "no_measurement_context") {
            console.info("[openai_ads.phone] skipped", { reason: result });
          }
        });
      } catch (error) {
        console.warn(
          "[twilio.dial_action] inbound_conversion_persistence_failed",
          {
            errorName: error instanceof Error ? error.name : "UnknownError",
          },
        );
        return twimlResponse(
          `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`,
          500,
        );
      }
    }
  }

  return twimlResponse(
    `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`,
    200,
  );
}
