import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, desc, eq, ilike, isNotNull, sql } from "drizzle-orm";
import { auditLogs, crmTasks, getDb } from "@/db";
import { recordAuditEvent } from "@/lib/audit";

export const dynamic = "force-dynamic";

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
    return NextResponse.json({ error: "invalid_form" }, { status: 400 });
  }

  const leg = request.nextUrl.searchParams.get("leg")?.trim() || "unknown";
  const mode = request.nextUrl.searchParams.get("mode")?.trim() || null;

  const payload = {
    leg,
    callSid: readString(formData.get("CallSid")),
    parentCallSid: readString(formData.get("ParentCallSid")),
    callStatus: readString(formData.get("CallStatus")),
    direction: readString(formData.get("Direction")),
    from: readString(formData.get("From")),
    to: readString(formData.get("To")),
    caller: readString(formData.get("Caller")),
    called: readString(formData.get("Called")),
    apiVersion: readString(formData.get("ApiVersion")),
    errorCode: readNumber(formData.get("ErrorCode")),
    dialCallSid: readString(formData.get("DialCallSid")),
    dialCallStatus: readString(formData.get("DialCallStatus")),
    dialCallDuration: readNumber(formData.get("DialCallDuration")),
    callDuration: readNumber(formData.get("CallDuration"))
  };

  console.info("[twilio.call_status]", payload);

  if (mode === "sales_escalation" && leg === "agent" && payload.callSid && payload.callStatus === "in-progress") {
    try {
      const db = getDb();

      const [escalation] = await db
        .select({
          taskId: auditLogs.entityId,
          meta: auditLogs.meta
        })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.action, "sales.escalation.call.started"),
            eq(auditLogs.entityType, "crm_task"),
            isNotNull(auditLogs.meta),
            sql`${auditLogs.meta} ->> 'callSid' = ${payload.callSid}`
          )
        )
        .orderBy(desc(auditLogs.createdAt))
        .limit(1);

      const taskId = typeof escalation?.taskId === "string" && escalation.taskId.trim().length > 0 ? escalation.taskId.trim() : null;
      const meta = typeof escalation?.meta === "object" && escalation.meta !== null ? (escalation.meta as Record<string, unknown>) : null;
      let contactId = meta && typeof meta["contactId"] === "string" ? meta["contactId"].trim() : "";
      let assignedTo = meta && typeof meta["assignedTo"] === "string" ? meta["assignedTo"].trim() : "";

      if (taskId && (!contactId || !assignedTo)) {
        const [task] = await db
          .select({ contactId: crmTasks.contactId, assignedTo: crmTasks.assignedTo })
          .from(crmTasks)
          .where(eq(crmTasks.id, taskId))
          .limit(1);
        if (!contactId && typeof task?.contactId === "string") contactId = task.contactId;
        if (!assignedTo && typeof task?.assignedTo === "string") assignedTo = task.assignedTo;
      }

      if (taskId && contactId && assignedTo) {
        const now = new Date();
        await db
          .update(crmTasks)
          .set({ status: "completed", updatedAt: now })
          .where(
            and(
              eq(crmTasks.id, taskId),
              eq(crmTasks.status, "open"),
              isNotNull(crmTasks.notes),
              ilike(crmTasks.notes, "%kind=speed_to_lead%")
            )
          );

        await recordAuditEvent({
          actor: { type: "system", id: assignedTo, label: "sales_escalation" },
          action: "call.started",
          entityType: "contact",
          entityId: contactId,
          meta: {
            via: "sales_escalation",
            stage: "agent_answered",
            taskId,
            callSid: payload.callSid
          }
        });
      }
    } catch (error) {
      console.warn("[twilio.call_status] sales_escalation_touch_failed", { callSid: payload.callSid, error: String(error) });
    }
  }

  return new NextResponse("ok", { status: 200 });
}
