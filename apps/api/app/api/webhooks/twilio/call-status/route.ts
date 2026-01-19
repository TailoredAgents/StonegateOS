import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, desc, eq, ilike, isNotNull, isNull, or, sql } from "drizzle-orm";
import { auditLogs, callRecords, contacts, crmTasks, getDb, outboxEvents, conversationThreads, leads, properties } from "@/db";
import { recordAuditEvent } from "@/lib/audit";
import { recordInboundMessage } from "@/lib/inbox";
import { getDefaultSalesAssigneeMemberId } from "@/lib/sales-scorecard";
import { normalizePhone } from "../../../web/utils";

export const dynamic = "force-dynamic";

const DEFAULT_SERVICES = ["junk_removal_primary"];
const OUTBOUND_CONNECTED_MIN_DURATION_SEC = 12;

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function parseNoteField(notes: string, key: string): string | null {
  const match = notes.match(new RegExp(`(?:^|\\n)${key}=([^\\n]+)`, "i"));
  const value = match?.[1]?.trim();
  return value && value.length ? value : null;
}

function upsertNoteField(notes: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const re = new RegExp(`(^|\\n)${key}=[^\\n]*`, "i");
  if (re.test(notes)) {
    return notes.replace(re, `$1${line}`);
  }
  return notes.length ? `${notes}\n${line}` : line;
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

    await tx.insert(outboxEvents).values({
      type: "lead.alert",
      payload: {
        leadId: lead.id,
        source: "missed_call"
      },
      createdAt: now
    });

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

function resolveCallDirection(direction: string | null): "inbound" | "outbound" {
  const normalized = (direction ?? "").toLowerCase();
  return normalized.startsWith("inbound") ? "inbound" : "outbound";
}

function parseRecordMeta(meta: unknown): Record<string, unknown> | null {
  return typeof meta === "object" && meta !== null ? (meta as Record<string, unknown>) : null;
}

async function ensureInboundContact(input: {
  db: ReturnType<typeof getDb>;
  from: string;
}): Promise<string | null> {
  const now = new Date();
  let phoneE164: string | null = null;
  try {
    phoneE164 = normalizePhone(input.from).e164;
  } catch {
    return null;
  }

  const [existing] = await input.db
    .select({ id: contacts.id })
    .from(contacts)
    .where(or(eq(contacts.phoneE164, phoneE164), eq(contacts.phone, input.from)))
    .limit(1);
  if (existing?.id) return existing.id;

  const salespersonMemberId = await getDefaultSalesAssigneeMemberId(input.db).catch(() => null);

  const [created] = await input.db
    .insert(contacts)
    .values({
      firstName: "Unknown",
      lastName: "Caller",
      phone: input.from,
      phoneE164,
      salespersonMemberId: salespersonMemberId && salespersonMemberId.length > 0 ? salespersonMemberId : null,
      source: "inbound_call",
      createdAt: now,
      updatedAt: now
    })
    .returning({ id: contacts.id });

  return created?.id ?? null;
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
  const taskIdRaw = request.nextUrl.searchParams.get("taskId")?.trim() || "";
  const taskId = taskIdRaw && isUuid(taskIdRaw) ? taskIdRaw : null;
  const inboundMode = mode === "inbound" || leg === "inbound";

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

  if (inboundMode && payload.from) {
    const missed = isMissedCall(payload.callStatus, payload.callDuration);
    if (missed) {
      try {
        const result = await recordInboundMessage({
          channel: "call",
          body: "Missed call",
          subject: "Missed call",
          fromAddress: payload.from,
          toAddress: payload.to,
          provider: "twilio",
          providerMessageId: payload.callSid ?? null,
          metadata: {
            callStatus: payload.callStatus ?? null,
            callDuration: payload.callDuration
          }
        });

        if (!result.leadId && result.threadId) {
          try {
            await ensureLeadForThread({
              threadId: result.threadId,
              callSid: payload.callSid,
              from: payload.from
            });
          } catch (error) {
            console.warn("[twilio] missed_call_lead_failed", { error: String(error) });
          }
        }
      } catch (error) {
        console.warn("[twilio] inbound_call_record_failed", { error: String(error) });
      }
    }
  }

  const callSid = payload.callSid;
  if (callSid) {
    const db = getDb();
    const now = new Date();
    const direction = resolveCallDirection(payload.direction);

    let resolvedContactId: string | null = null;
    let resolvedAssignedTo: string | null = null;

    if (direction === "inbound" && payload.from) {
      try {
        const normalized = normalizePhone(payload.from).e164;
        const [match] = await db
          .select({ id: contacts.id })
          .from(contacts)
          .where(or(eq(contacts.phoneE164, normalized), eq(contacts.phone, payload.from)))
          .limit(1);
        resolvedContactId = match?.id ?? null;
      } catch {
        // ignore invalid inbound caller id
      }

      if (!resolvedContactId && payload.callStatus === "completed" && (payload.callDuration ?? 0) > 0) {
        try {
          resolvedContactId = await ensureInboundContact({ db, from: payload.from });
        } catch (error) {
          console.warn("[twilio.call_status] inbound_contact_create_failed", { callSid, error: String(error) });
        }
      }

      if (resolvedContactId) {
        try {
          const [contactRow] = await db
            .select({ salespersonMemberId: contacts.salespersonMemberId })
            .from(contacts)
            .where(eq(contacts.id, resolvedContactId))
            .limit(1);
          resolvedAssignedTo = contactRow?.salespersonMemberId ?? null;
        } catch {
          resolvedAssignedTo = null;
        }
      }
    } else {
      const callSidCandidates = [payload.callSid, payload.parentCallSid].filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0
      );

      if (callSidCandidates.length > 0) {
        const callSidFilter =
          callSidCandidates.length === 1
            ? sql`${auditLogs.meta} ->> 'callSid' = ${callSidCandidates[0]!}`
            : or(
                ...callSidCandidates.map(
                  (candidate) => sql`${auditLogs.meta} ->> 'callSid' = ${candidate}`
                )
              );

        const [audit] = await db
          .select({
            action: auditLogs.action,
            entityType: auditLogs.entityType,
            entityId: auditLogs.entityId,
            actorId: auditLogs.actorId,
            meta: auditLogs.meta
          })
          .from(auditLogs)
          .where(
            and(
              isNotNull(auditLogs.meta),
              or(
                eq(auditLogs.action, "call.started"),
                eq(auditLogs.action, "sales.escalation.call.started")
              ),
              callSidFilter
            )
          )
          .orderBy(desc(auditLogs.createdAt))
          .limit(1);

        if (audit?.action === "call.started" && audit.entityType === "contact" && audit.entityId) {
          resolvedContactId = audit.entityId;
          resolvedAssignedTo = audit.actorId ?? null;
        }

        if (audit?.action === "sales.escalation.call.started") {
          const meta = parseRecordMeta(audit.meta);
          const contactId = typeof meta?.["contactId"] === "string" ? meta["contactId"].trim() : "";
          const assignedTo = typeof meta?.["assignedTo"] === "string" ? meta["assignedTo"].trim() : "";
          if (contactId) resolvedContactId = contactId;
          if (assignedTo) resolvedAssignedTo = assignedTo;
        }
      }
    }

    try {
      await db
        .insert(callRecords)
        .values({
          callSid,
          parentCallSid: payload.parentCallSid ?? null,
          direction,
          mode,
          from: payload.from ?? null,
          to: payload.to ?? null,
          contactId: resolvedContactId,
          assignedTo: resolvedAssignedTo,
          callStatus: payload.callStatus ?? null,
          callDurationSec: payload.callDuration ?? null,
          createdAt: now,
          updatedAt: now
        })
        .onConflictDoUpdate({
          target: callRecords.callSid,
          set: {
            parentCallSid: payload.parentCallSid ?? null,
            direction,
            mode,
            from: payload.from ?? null,
            to: payload.to ?? null,
            contactId: resolvedContactId,
            assignedTo: resolvedAssignedTo,
            callStatus: payload.callStatus ?? null,
            callDurationSec: payload.callDuration ?? null,
            updatedAt: now
          }
        });
    } catch (error) {
      console.warn("[twilio.call_status] call_record_upsert_failed", { callSid, error: String(error) });
    }

    const isInboundAnsweredCall =
      mode === "inbound" &&
      direction === "inbound" &&
      payload.callStatus === "completed" &&
      (payload.callDuration ?? 0) > 0 &&
      resolvedContactId &&
      resolvedAssignedTo;

    if (isInboundAnsweredCall) {
      try {
        const contactId = resolvedContactId;
        const assignedTo = resolvedAssignedTo;
        if (!contactId || !assignedTo) {
          throw new Error("inbound_touch_missing_contact_or_assignee");
        }

        await db
          .update(crmTasks)
          .set({ status: "completed", updatedAt: now })
          .where(
            and(
              eq(crmTasks.contactId, contactId),
              eq(crmTasks.assignedTo, assignedTo),
              eq(crmTasks.status, "open"),
              isNotNull(crmTasks.notes),
              or(ilike(crmTasks.notes, "%[auto] leadId=%"), ilike(crmTasks.notes, "%[auto] contactId=%")),
              or(ilike(crmTasks.notes, "%kind=speed_to_lead%"), ilike(crmTasks.notes, "%kind=follow_up%"))
            )
          );

        await recordAuditEvent({
          actor: { type: "system", id: assignedTo, label: "twilio_inbound" },
          action: "call.answered",
          entityType: "contact",
          entityId: contactId,
          meta: {
            via: "twilio",
            mode: "inbound",
            callSid,
            callDurationSec: payload.callDuration ?? null
          }
        });
      } catch (error) {
        console.warn("[twilio.call_status] inbound_touch_failed", {
          callSid,
          contactId: resolvedContactId,
          assignedTo: resolvedAssignedTo,
          error: String(error)
        });
      }
    }

    const shouldAutoStopOutboundOnAnswered =
      Boolean(taskId) &&
      leg === "customer" &&
      payload.callStatus === "completed" &&
      (payload.callDuration ?? 0) >= OUTBOUND_CONNECTED_MIN_DURATION_SEC;

    if (shouldAutoStopOutboundOnAnswered && taskId) {
      try {
        const [task] = await db
          .select({
            id: crmTasks.id,
            contactId: crmTasks.contactId,
            assignedTo: crmTasks.assignedTo,
            status: crmTasks.status,
            notes: crmTasks.notes
          })
          .from(crmTasks)
          .where(eq(crmTasks.id, taskId))
          .limit(1);

        const notes = typeof task?.notes === "string" ? task.notes : "";
        const isOutboundTask = typeof task?.id === "string" && task.status === "open" && notes.toLowerCase().includes("kind=outbound");
        if (isOutboundTask && task?.contactId) {
          const campaign = parseNoteField(notes, "campaign");
          const nowIso = now.toISOString();

          const openOutboundTasks = await db
            .select({ id: crmTasks.id, notes: crmTasks.notes })
            .from(crmTasks)
            .where(
              and(
                eq(crmTasks.contactId, task.contactId),
                eq(crmTasks.status, "open"),
                isNotNull(crmTasks.notes),
                ilike(crmTasks.notes, "%kind=outbound%"),
                campaign ? ilike(crmTasks.notes, `%campaign=${campaign}%`) : sql`true`
              )
            );

          for (const row of openOutboundTasks) {
            const rowNotes = typeof row.notes === "string" ? row.notes : "";
            let nextNotes = rowNotes;
            if (!parseNoteField(nextNotes, "startedAt")) {
              nextNotes = upsertNoteField(nextNotes, "startedAt", nowIso);
            }
            nextNotes = upsertNoteField(upsertNoteField(nextNotes, "lastDisposition", "connected"), "completedAt", nowIso);
            await db.update(crmTasks).set({ status: "completed", notes: nextNotes, updatedAt: now }).where(eq(crmTasks.id, row.id));
          }

          await db.insert(crmTasks).values({
            contactId: task.contactId,
            title: "Note",
            status: "completed",
            dueAt: null,
            assignedTo: null,
            notes: "Outbound connected via call (cadence stopped)"
          });

          await recordAuditEvent({
            actor: { type: "system", id: task.assignedTo ?? undefined, label: "twilio_outbound" },
            action: "outbound.connected_auto",
            entityType: "crm_task",
            entityId: taskId,
            meta: {
              contactId: task.contactId,
              campaign: campaign ?? null,
              callSid,
              callDurationSec: payload.callDuration ?? null
            }
          });
        }
      } catch (error) {
        console.warn("[twilio.call_status] outbound_auto_stop_failed", { taskId, callSid, error: String(error) });
      }
    }

    const shouldQueueRecording =
      payload.callStatus === "completed" &&
      (payload.callDuration ?? 0) > 0 &&
      (direction === "inbound" || inboundMode ? leg === "inbound" : leg === "customer");

    if (shouldQueueRecording) {
      try {
        const [existing] = await db
          .select({ id: outboxEvents.id })
          .from(outboxEvents)
          .where(
            and(
              eq(outboxEvents.type, "call.recording.process"),
              isNull(outboxEvents.processedAt),
              sql`(payload->>'callSid') = ${callSid}`
            )
          )
          .limit(1);

        if (!existing?.id) {
          await db.insert(outboxEvents).values({
            type: "call.recording.process",
            payload: { callSid },
            createdAt: now
          });
        }
      } catch (error) {
        console.warn("[twilio.call_status] recording_queue_failed", { callSid, error: String(error) });
      }
    }
  }

  if (
    mode === "sales_escalation" &&
    leg === "agent" &&
    payload.callSid &&
    (payload.callStatus === "in-progress" || payload.callStatus === "answered")
  ) {
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
