import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { contacts, getDb, teamCallOperations } from "@/db";
import {
  handleManualCallConnectCallback,
  ManualCallCallbackError,
} from "@/lib/manual-call-callbacks";
import {
  buildTwilioWebhookUrl,
  verifyTwilioWebhookRequest,
} from "@/lib/twilio-webhook-auth";
import { getTwilioProviderSenderNumber } from "@/lib/twilio-provider";
import { escapeTwilioXmlText } from "@/lib/twilio-xml";
import { normalizePhone } from "../../../web/utils";

export const dynamic = "force-dynamic";

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function resolveLegacyDialTarget(request: NextRequest): string | null {
  const to = request.nextUrl.searchParams.get("to");
  if (!to) return null;
  try {
    return normalizePhone(to).e164;
  } catch {
    return null;
  }
}

async function resolveDialContext(request: NextRequest): Promise<{
  to: string;
  taskId: string | null;
  requestKey: string | null;
} | null> {
  const requestKeyRaw =
    request.nextUrl.searchParams.get("requestKey")?.trim() ?? "";
  if (requestKeyRaw && isUuid(requestKeyRaw)) {
    const db = getDb();
    const context = await db.transaction(async (tx) => {
      const [operation] = await tx
        .select({
          id: teamCallOperations.id,
          contactId: teamCallOperations.contactId,
          taskId: teamCallOperations.taskId,
          state: teamCallOperations.state,
        })
        .from(teamCallOperations)
        .where(eq(teamCallOperations.providerRequestKey, requestKeyRaw))
        .limit(1);
      if (
        !operation ||
        (operation.state !== "dispatched" && operation.state !== "succeeded")
      ) {
        return null;
      }

      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${operation.contactId}, 0))`,
      );
      const [contact] = await tx
        .select({
          phone: contacts.phone,
          phoneE164: contacts.phoneE164,
          doNotContact: contacts.doNotContact,
          deletedAt: contacts.deletedAt,
        })
        .from(contacts)
        .where(eq(contacts.id, operation.contactId))
        .for("update")
        .limit(1);
      if (!contact || contact.deletedAt || contact.doNotContact) return null;

      const candidate = contact.phoneE164 ?? contact.phone;
      if (!candidate) return null;
      try {
        return {
          to: normalizePhone(candidate).e164,
          taskId: operation.taskId,
          requestKey: requestKeyRaw,
        };
      } catch {
        return null;
      }
    });
    if (context) return context;
    return null;
  }

  // Short-lived compatibility for calls dispatched before request-key-backed
  // callback URLs were deployed. New Team calls never put a phone in a URL.
  const to = resolveLegacyDialTarget(request);
  const taskIdRaw = request.nextUrl.searchParams.get("taskId")?.trim() ?? "";
  return to
    ? {
        to,
        taskId: taskIdRaw && isUuid(taskIdRaw) ? taskIdRaw : null,
        requestKey: null,
      }
    : null;
}

function buildTwiML(input: {
  to: string;
  callerId: string;
  statusCallbackUrl: string;
  dialActionUrl: string;
  noticeUrl: string;
}): string {
  const to = escapeTwilioXmlText(input.to);
  const callerId = escapeTwilioXmlText(input.callerId);
  const statusCallbackUrl = escapeTwilioXmlText(input.statusCallbackUrl);
  const dialActionUrl = escapeTwilioXmlText(input.dialActionUrl);
  const noticeUrl = escapeTwilioXmlText(input.noticeUrl);
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial callerId="${callerId}" action="${dialActionUrl}" method="POST" answerOnBridge="true" record="record-from-answer">
    <Number url="${noticeUrl}" statusCallbackEvent="initiated ringing answered completed" statusCallback="${statusCallbackUrl}" statusCallbackMethod="POST">${to}</Number>
  </Dial>
</Response>`;
}

function twimlResponse(xml: string, status = 200): Response {
  return new NextResponse(xml, {
    status,
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
    },
  });
}

async function handleVerifiedRequest(
  request: NextRequest,
  publicApiBaseUrl: string,
  formData: FormData,
): Promise<Response> {
  const requestKey =
    request.nextUrl.searchParams.get("requestKey")?.trim() ?? "";
  let context: {
    to: string;
    taskId: string | null;
    requestKey: string | null;
  } | null = null;
  if (requestKey) {
    const callSid = formData.get("CallSid");
    try {
      const result = await handleManualCallConnectCallback({
        db: getDb(),
        requestKey,
        parentCallSid: typeof callSid === "string" ? callSid : null,
      });
      if (result.customerDialAllowed) {
        context = {
          to: result.customerPhone,
          taskId: result.taskId,
          requestKey,
        };
      }
    } catch (error) {
      const status =
        error instanceof ManualCallCallbackError ? error.status : 500;
      return twimlResponse(
        `<?xml version="1.0" encoding="UTF-8"?>
<Response><Say>We could not safely connect this call.</Say><Hangup/></Response>`,
        status,
      );
    }
  } else {
    context = await resolveDialContext(request);
  }
  const callerId = getTwilioProviderSenderNumber();
  if (!context || !callerId) {
    console.warn("[twilio.connect] missing_to_or_from", {
      hasTo: Boolean(context?.to),
      hasCallerId: Boolean(callerId),
      hasRequestKey: Boolean(
        request.nextUrl.searchParams.get("requestKey")?.trim(),
      ),
    });
    return twimlResponse(
      `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>We could not connect the call. Please try again.</Say>
</Response>`,
      200,
    );
  }

  const statusCallbackUrl = buildTwilioWebhookUrl(
    "/api/webhooks/twilio/call-status",
    publicApiBaseUrl,
  );
  statusCallbackUrl.searchParams.set("leg", "customer");
  if (context.requestKey) {
    statusCallbackUrl.searchParams.set("requestKey", context.requestKey);
  } else if (context.taskId) {
    statusCallbackUrl.searchParams.set("taskId", context.taskId);
  }
  const dialActionUrl = buildTwilioWebhookUrl(
    "/api/webhooks/twilio/dial-action",
    publicApiBaseUrl,
  );
  dialActionUrl.searchParams.set("leg", "customer");
  if (context.requestKey) {
    dialActionUrl.searchParams.set("requestKey", context.requestKey);
  } else if (context.taskId) {
    dialActionUrl.searchParams.set("taskId", context.taskId);
  }
  const noticeUrl = buildTwilioWebhookUrl(
    "/api/webhooks/twilio/notice",
    publicApiBaseUrl,
  );
  noticeUrl.searchParams.set("kind", "outbound");

  return twimlResponse(
    buildTwiML({
      to: context.to,
      callerId,
      statusCallbackUrl: statusCallbackUrl.toString(),
      dialActionUrl: dialActionUrl.toString(),
      noticeUrl: noticeUrl.toString(),
    }),
  );
}

export async function GET(request: NextRequest): Promise<Response> {
  const verified = await verifyTwilioWebhookRequest(request);
  if (!verified.ok) return verified.response;
  return handleVerifiedRequest(
    request,
    verified.publicBaseUrl,
    verified.formData,
  );
}

export async function POST(request: NextRequest): Promise<Response> {
  const verified = await verifyTwilioWebhookRequest(request);
  if (!verified.ok) return verified.response;
  return handleVerifiedRequest(
    request,
    verified.publicBaseUrl,
    verified.formData,
  );
}
