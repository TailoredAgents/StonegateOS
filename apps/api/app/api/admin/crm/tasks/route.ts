import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getDb, crmTasks, contacts } from "@/db";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { isAdminRequest } from "../../../web/admin";
import { and, eq, sql, asc, desc } from "drizzle-orm";

type TaskStatus = "open" | "completed";
const TASK_STATUS_SET = new Set<TaskStatus>(["open", "completed"]);

function parseStatusParam(value: string | null): TaskStatus | "all" {
  if (!value) return "open";
  const normalized = value.trim().toLowerCase();
  if (normalized === "all") return "all";
  return normalized === "completed" ? "completed" : "open";
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { searchParams } = request.nextUrl;
  const contactId = searchParams.get("contactId");
  const statusParam = parseStatusParam(searchParams.get("status"));

  const db = getDb();
  let whereClause;

  if (contactId && statusParam === "all") {
    whereClause = eq(crmTasks.contactId, contactId);
  } else if (contactId && statusParam !== "all") {
    whereClause = and(eq(crmTasks.contactId, contactId), eq(crmTasks.status, statusParam));
  } else if (!contactId && statusParam !== "all") {
    whereClause = eq(crmTasks.status, statusParam);
  }

  const baseQuery = db
    .select({
      id: crmTasks.id,
      contactId: crmTasks.contactId,
      title: crmTasks.title,
      dueAt: crmTasks.dueAt,
      assignedTo: crmTasks.assignedTo,
      status: crmTasks.status,
      notes: crmTasks.notes,
      createdAt: crmTasks.createdAt,
      updatedAt: crmTasks.updatedAt
    })
    .from(crmTasks);

  const tasks = await (whereClause
    ? baseQuery
        .where(whereClause)
        .orderBy(
          sql`case when ${crmTasks.status} = 'open' then 0 else 1 end`,
          asc(crmTasks.dueAt),
          desc(crmTasks.createdAt)
        )
    : baseQuery.orderBy(
        sql`case when ${crmTasks.status} = 'open' then 0 else 1 end`,
        asc(crmTasks.dueAt),
        desc(crmTasks.createdAt)
      ));

  return NextResponse.json({
    tasks: tasks.map((task) => ({
      id: task.id,
      contactId: task.contactId,
      title: task.title,
      dueAt: task.dueAt ? task.dueAt.toISOString() : null,
      assignedTo: task.assignedTo,
      status: task.status,
      notes: task.notes,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString()
    }))
  });
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = (await request.json().catch(() => null)) as unknown;
  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const {
    contactId,
    title,
    dueAt,
    assignedTo,
    notes,
    status
  } = payload as Record<string, unknown>;

  if (typeof contactId !== "string" || contactId.trim().length === 0) {
    return NextResponse.json({ error: "contact_id_required" }, { status: 400 });
  }

  if (typeof title !== "string" || title.trim().length === 0) {
    return NextResponse.json({ error: "title_required" }, { status: 400 });
  }

  let dueDate: Date | null = null;
  if (typeof dueAt === "string" && dueAt.trim().length > 0) {
    const parsed = new Date(dueAt);
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json({ error: "invalid_due_date" }, { status: 400 });
    }
    dueDate = parsed;
  }

  const db = getDb();
  const actor = getAuditActorFromRequest(request);

  let taskStatus: TaskStatus = "open";
  if (status !== undefined) {
    if (typeof status !== "string") {
      return NextResponse.json({ error: "invalid_status" }, { status: 400 });
    }
    const normalized = status.trim().toLowerCase() as TaskStatus;
    if (!TASK_STATUS_SET.has(normalized)) {
      return NextResponse.json({ error: "invalid_status" }, { status: 400 });
    }
    taskStatus = normalized;
  }

  const [contact] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);

  if (!contact) {
    return NextResponse.json({ error: "contact_not_found" }, { status: 404 });
  }

  const [task] = await db
    .insert(crmTasks)
    .values({
      contactId,
      title: title.trim(),
      dueAt: dueDate,
      assignedTo:
        typeof assignedTo === "string" && assignedTo.trim().length > 0 ? assignedTo.trim() : null,
      notes: typeof notes === "string" && notes.trim().length > 0 ? notes.trim() : null,
      status: taskStatus
    })
    .returning({
      id: crmTasks.id,
      contactId: crmTasks.contactId,
      title: crmTasks.title,
      dueAt: crmTasks.dueAt,
      assignedTo: crmTasks.assignedTo,
      status: crmTasks.status,
      notes: crmTasks.notes,
      createdAt: crmTasks.createdAt,
      updatedAt: crmTasks.updatedAt
    });

  if (!task) {
    return NextResponse.json({ error: "task_insert_failed" }, { status: 500 });
  }

  await recordAuditEvent({
    actor,
    action: "crm.task.created",
    entityType: "crm_task",
    entityId: task.id,
    meta: {
      contactId: task.contactId,
      status: task.status,
      assignedTo: task.assignedTo ?? null
    }
  });

  return NextResponse.json({
    task: {
      id: task.id,
      contactId: task.contactId,
      title: task.title,
      dueAt: task.dueAt ? task.dueAt.toISOString() : null,
      assignedTo: task.assignedTo,
      status: task.status,
      notes: task.notes,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString()
    }
  });
}
