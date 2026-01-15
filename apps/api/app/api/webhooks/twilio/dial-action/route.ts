import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, eq, ilike, isNotNull, or } from "drizzle-orm";
import { getDb, crmTasks } from "@/db";
import { recordAuditEvent } from "@/lib/audit";

export const dynamic = "force-dynamic";

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function twimlResponse(xml: string, status = 200): Response {
  return new NextResponse(xml, {
    status,
    headers: {
      "Content-Type": "text/xml; charset=utf-8"
    }
  });
}

function readString(value: FormDataEntryValue | null): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(value: FormDataEntryValue | null): number | null {
  const raw = readString(value);
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function POST(request: NextRequest): Promise<Response> {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return twimlResponse(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Say>We could not complete the call.</Say><Hangup/></Response>`,
      200
    );
  }

  const leg = request.nextUrl.searchParams.get("leg")?.trim() || "unknown";
  const mode = request.nextUrl.searchParams.get("mode")?.trim() || null;
  const taskId = request.nextUrl.searchParams.get("taskId")?.trim() || null;

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
    dialCallQuality: readString(formData.get("DialCallQuality"))
  };

  console.info("[twilio.dial_action]", payload);

  let agentMessage: string | null = null;
  if (mode === "sales_escalation" && leg === "customer") {
    const status = (payload.dialCallStatus ?? payload.callStatus ?? "").toLowerCase();
    if (status.includes("busy")) agentMessage = "Their line is busy. Please try again.";
    else if (status.includes("no-answer") || status.includes("noanswer")) agentMessage = "No answer. Please try again.";
    else if (status.includes("failed")) agentMessage = "That call could not be completed. Please try again.";
  }

  if (mode === "sales_escalation" && taskId && leg === "customer") {
    try {
      const duration = payload.dialCallDuration ?? 0;
      const status = payload.dialCallStatus ?? null;
      const answered = duration > 0 && (status === null || status === "completed");
      if (answered) {
        const db = getDb();
        const [row] = await db
          .select({
            contactId: crmTasks.contactId,
            assignedTo: crmTasks.assignedTo
          })
          .from(crmTasks)
          .where(eq(crmTasks.id, taskId))
          .limit(1);

        if (row?.contactId && row.assignedTo) {
          const now = new Date();
          await db
            .update(crmTasks)
            .set({ status: "completed", updatedAt: now })
            .where(
              and(
                eq(crmTasks.contactId, row.contactId),
                eq(crmTasks.assignedTo, row.assignedTo),
                eq(crmTasks.status, "open"),
                isNotNull(crmTasks.notes),
                or(ilike(crmTasks.notes, "%kind=speed_to_lead%"), ilike(crmTasks.notes, "%kind=follow_up%"))
              )
            );

          await recordAuditEvent({
            actor: { type: "system", id: row.assignedTo, label: "sales_escalation" },
            action: "sales.escalation.call.connected",
            entityType: "crm_task",
            entityId: taskId,
            meta: {
              contactId: row.contactId,
              dialCallDuration: duration,
              dialCallStatus: status
            }
          });
        }
      }
    } catch (error) {
      console.warn("[twilio.dial_action] sales_escalation_update_failed", { taskId, error: String(error) });
    }
  }

  if (agentMessage) {
    const safe = escapeXml(agentMessage);
    return twimlResponse(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${safe}</Say><Hangup/></Response>`,
      200
    );
  }

  return twimlResponse(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`, 200);
}
