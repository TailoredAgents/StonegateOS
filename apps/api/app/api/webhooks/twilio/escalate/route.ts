import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getDb, crmTasks } from "@/db";
import { recordAuditEvent } from "@/lib/audit";
import { and, eq } from "drizzle-orm";
import { normalizePhone } from "../../../web/utils";

export const dynamic = "force-dynamic";

function resolveFallbackOrigin(request: NextRequest): string {
  const proto = (request.headers.get("x-forwarded-proto") ?? "https").split(",")[0]?.trim() || "https";
  const host = (request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "")
    .split(",")[0]
    ?.trim();
  if (host) {
    return `${proto}://${host}`;
  }
  return request.nextUrl.origin;
}

function resolvePublicApiBaseUrl(fallbackOrigin: string): string {
  const raw = (process.env["API_BASE_URL"] ?? process.env["NEXT_PUBLIC_API_BASE_URL"] ?? "").trim();
  if (raw) {
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    try {
      const url = new URL(withScheme);
      const lowered = url.hostname.toLowerCase();
      const isLocalhost =
        lowered === "localhost" ||
        lowered === "0.0.0.0" ||
        lowered === "127.0.0.1" ||
        lowered.endsWith(".internal");
      if (process.env["NODE_ENV"] === "production" && isLocalhost) {
        return fallbackOrigin;
      }
      return url.toString().replace(/\/$/, "");
    } catch {
      return fallbackOrigin;
    }
  }

  return fallbackOrigin;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function resolveDialTarget(request: NextRequest): string | null {
  const to = request.nextUrl.searchParams.get("to");
  if (!to) return null;
  try {
    return normalizePhone(to).e164;
  } catch {
    return null;
  }
}

function twimlResponse(xml: string, status = 200): Response {
  return new NextResponse(xml, {
    status,
    headers: {
      "Content-Type": "text/xml; charset=utf-8"
    }
  });
}

function buildGatherTwiML(input: { actionUrl: string; leadName: string | null }): string {
  const actionUrl = escapeXml(input.actionUrl);
  const leadName = typeof input.leadName === "string" && input.leadName.trim().length > 0 ? escapeXml(input.leadName.trim()) : null;
  const intro = leadName ? `New lead: ${leadName}.` : "New lead waiting.";
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" timeout="8" action="${actionUrl}" method="POST">
    <Say>${intro} Press 1 to connect.</Say>
  </Gather>
  <Say>No input received. Goodbye.</Say>
</Response>`;
}

function buildConnectTwiML(input: {
  to: string;
  callerId: string;
  statusCallbackUrl: string;
  dialActionUrl: string;
  noticeUrl: string;
}): string {
  const to = escapeXml(input.to);
  const callerId = escapeXml(input.callerId);
  const statusCallbackUrl = escapeXml(input.statusCallbackUrl);
  const dialActionUrl = escapeXml(input.dialActionUrl);
  const noticeUrl = escapeXml(input.noticeUrl);
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial callerId="${callerId}" action="${dialActionUrl}" method="POST" answerOnBridge="true" record="record-from-answer">
    <Number url="${noticeUrl}" statusCallbackEvent="initiated ringing answered completed" statusCallback="${statusCallbackUrl}" statusCallbackMethod="POST">${to}</Number>
  </Dial>
</Response>`;
}

async function resolveTaskContext(taskId: string): Promise<{ contactId: string; assignedTo: string } | null> {
  const db = getDb();
  const [row] = await db
    .select({
      contactId: crmTasks.contactId,
      assignedTo: crmTasks.assignedTo,
      status: crmTasks.status
    })
    .from(crmTasks)
    .where(eq(crmTasks.id, taskId))
    .limit(1);

  if (!row?.contactId || !row.assignedTo) return null;
  return { contactId: row.contactId, assignedTo: row.assignedTo };
}

async function readDigits(request: NextRequest): Promise<string | null> {
  try {
    const formData = await request.formData();
    const digits = formData.get("Digits");
    return typeof digits === "string" ? digits.trim() : null;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  const publicApiBaseUrl = resolvePublicApiBaseUrl(resolveFallbackOrigin(request));
  const to = resolveDialTarget(request);
  const callerId = process.env["TWILIO_FROM"] ?? null;
  if (!to || !callerId) {
    console.warn("[twilio.escalate] missing_to_or_from", {
      hasTo: Boolean(to),
      hasCallerId: Boolean(callerId),
      url: request.nextUrl.toString()
    });
    return twimlResponse(
      `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>We could not connect the call. Please try again.</Say>
</Response>`,
      200
    );
  }

  const digits = await readDigits(request);
  if (!digits) {
    const leadName = request.nextUrl.searchParams.get("name");
    const actionUrl = new URL(`${request.nextUrl.pathname}${request.nextUrl.search}`, publicApiBaseUrl).toString();
    return twimlResponse(buildGatherTwiML({ actionUrl, leadName }));
  }

  if (digits !== "1") {
    return twimlResponse(
      `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Not recognized. Goodbye.</Say>
</Response>`,
      200
    );
  }

  const taskId = request.nextUrl.searchParams.get("taskId")?.trim() || null;
  const contactIdFromQuery = request.nextUrl.searchParams.get("contactId")?.trim() || null;
  if (taskId) {
    try {
      const context = await resolveTaskContext(taskId);
      if (context) {
        const resolvedContactId = contactIdFromQuery && contactIdFromQuery.length > 0 ? contactIdFromQuery : context.contactId;
        const now = new Date();
        const db = getDb();
        await db
          .update(crmTasks)
          .set({ status: "completed", updatedAt: now })
          .where(and(eq(crmTasks.id, taskId), eq(crmTasks.status, "open")));
        await recordAuditEvent({
          actor: { type: "system", id: context.assignedTo, label: "sales_escalation" },
          action: "call.started",
          entityType: "contact",
          entityId: resolvedContactId,
          meta: {
            via: "sales_escalation",
            taskId
          }
        });
      }
    } catch (error) {
      console.warn("[twilio.escalate] touch_record_failed", { taskId, error: String(error) });
    }
  }

  const statusCallbackUrl = new URL("/api/webhooks/twilio/call-status", publicApiBaseUrl);
  statusCallbackUrl.searchParams.set("leg", "customer");
  statusCallbackUrl.searchParams.set("mode", "sales_escalation");
  const dialActionUrl = new URL("/api/webhooks/twilio/dial-action", publicApiBaseUrl);
  dialActionUrl.searchParams.set("leg", "customer");
  dialActionUrl.searchParams.set("mode", "sales_escalation");
  const noticeUrl = new URL("/api/webhooks/twilio/notice", publicApiBaseUrl);
  noticeUrl.searchParams.set("kind", "outbound");
  if (taskId) {
    statusCallbackUrl.searchParams.set("taskId", taskId);
    dialActionUrl.searchParams.set("taskId", taskId);
  }
  if (contactIdFromQuery) {
    statusCallbackUrl.searchParams.set("contactId", contactIdFromQuery);
    dialActionUrl.searchParams.set("contactId", contactIdFromQuery);
  }

  return twimlResponse(
    buildConnectTwiML({
      to,
      callerId,
      statusCallbackUrl: statusCallbackUrl.toString(),
      dialActionUrl: dialActionUrl.toString(),
      noticeUrl: noticeUrl.toString()
    })
  );
}

export async function GET(request: NextRequest): Promise<Response> {
  const publicApiBaseUrl = resolvePublicApiBaseUrl(resolveFallbackOrigin(request));
  const leadName = request.nextUrl.searchParams.get("name");
  const actionUrl = new URL(`${request.nextUrl.pathname}${request.nextUrl.search}`, publicApiBaseUrl).toString();
  return twimlResponse(buildGatherTwiML({ actionUrl, leadName }));
}
