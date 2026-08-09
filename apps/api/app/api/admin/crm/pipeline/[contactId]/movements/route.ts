import type { NextRequest } from "next/server";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { auditLogs, contacts, getDb, outboxEvents } from "@/db";
import { requirePermission } from "@/lib/permissions";
import { teamMutationErrorResponse } from "@/lib/team-mutation";
import { PIPELINE_STAGE_SET, type PipelineStage } from "../../stages";

type RouteContext = { params: Promise<{ contactId?: string }> };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PIPELINE_MOVEMENT_LIMIT = 10;

type PipelineMovement = {
  id: string;
  actorLabel: string;
  occurredAt: string;
  fromStage: PipelineStage | null;
  toStage: PipelineStage;
  source: "manual" | "automation";
  sourceLabel: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeLabel(value: unknown, fallback: string, maximum = 80): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  const unsafe = Array.from(normalized).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint <= 31 ||
      codePoint === 127 ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    );
  });
  return !normalized || normalized.length > maximum || unsafe
    ? fallback
    : normalized;
}

function stage(value: unknown): PipelineStage | null {
  return typeof value === "string" && PIPELINE_STAGE_SET.has(value)
    ? (value as PipelineStage)
    : null;
}

function automationSourceLabel(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 48 ||
    !/^[a-z0-9_-]+$/u.test(value)
  ) {
    return "Automated workflow";
  }
  const raw = value;
  const readable = raw.replace(/[_-]+/gu, " ").replace(/\s+/gu, " ");
  return readable.charAt(0).toUpperCase() + readable.slice(1);
}

export async function GET(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const permissionError = await requirePermission(request, "pipeline.read");
  if (permissionError) return permissionError;

  const { contactId: rawContactId } = await context.params;
  const contactId = rawContactId?.trim() ?? "";
  if (!UUID_PATTERN.test(contactId)) {
    return teamMutationErrorResponse(
      "invalid",
      "Choose a valid contact to load pipeline movement history.",
      { fieldErrors: { contactId: "Select a valid contact." } },
    );
  }

  try {
    const db = getDb();
    const [contactRows, auditRows, automationRows] = await Promise.all([
      db
        .select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.id, contactId), isNull(contacts.deletedAt)))
        .limit(1),
      db
        .select({
          id: auditLogs.id,
          actorLabel: auditLogs.actorLabel,
          actorRole: auditLogs.actorRole,
          meta: auditLogs.meta,
          createdAt: auditLogs.createdAt,
        })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.action, "pipeline.updated"),
            eq(auditLogs.entityType, "crm_pipeline"),
            eq(auditLogs.entityId, contactId),
            eq(auditLogs.outcome, "succeeded"),
          ),
        )
        .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
        .limit(PIPELINE_MOVEMENT_LIMIT),
      db
        .select({
          id: outboxEvents.id,
          payload: outboxEvents.payload,
          createdAt: outboxEvents.createdAt,
        })
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.type, "pipeline.auto_stage_change"),
            sql`${outboxEvents.payload}->>'contactId' = ${contactId}`,
          ),
        )
        .orderBy(desc(outboxEvents.createdAt), desc(outboxEvents.id))
        .limit(PIPELINE_MOVEMENT_LIMIT),
    ]);

    if (!contactRows[0]) {
      return teamMutationErrorResponse(
        "invalid",
        "That contact no longer exists.",
        { status: 404, fieldErrors: { contactId: "Select another contact." } },
      );
    }

    const movements: PipelineMovement[] = [];
    for (const row of auditRows) {
      const meta = record(row.meta);
      const toStage = stage(meta?.["stage"]);
      if (!toStage) continue;
      movements.push({
        id: `audit:${row.id}`,
        actorLabel: safeLabel(
          row.actorLabel,
          safeLabel(row.actorRole, "Team member", 40),
        ),
        occurredAt: row.createdAt.toISOString(),
        fromStage: stage(meta?.["fromStage"]),
        toStage,
        source: "manual",
        sourceLabel: "Manual update",
      });
    }
    for (const row of automationRows) {
      const payload = record(row.payload);
      const toStage = stage(payload?.["toStage"]);
      if (!toStage) continue;
      movements.push({
        id: `automation:${row.id}`,
        actorLabel: "Automation",
        occurredAt: row.createdAt.toISOString(),
        fromStage: stage(payload?.["fromStage"]),
        toStage,
        source: "automation",
        sourceLabel: automationSourceLabel(payload?.["reason"]),
      });
    }

    movements.sort((left, right) => {
      const time = Date.parse(right.occurredAt) - Date.parse(left.occurredAt);
      return time === 0 ? right.id.localeCompare(left.id) : time;
    });
    return Response.json(
      {
        movements: movements.slice(0, PIPELINE_MOVEMENT_LIMIT),
        limit: PIPELINE_MOVEMENT_LIMIT,
      },
      {
        headers: { "Cache-Control": "private, no-store, max-age=0" },
      },
    );
  } catch {
    return teamMutationErrorResponse(
      "internal",
      "Recent pipeline movements could not be loaded. Retry this section.",
      { retryable: true },
    );
  }
}
