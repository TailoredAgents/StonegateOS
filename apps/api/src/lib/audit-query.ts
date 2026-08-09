import {
  and,
  eq,
  gte,
  lt,
  or,
  type SQL,
} from "drizzle-orm";
import { auditLogs } from "@/db";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_FILTER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const OUTCOMES = new Set(["attempted", "succeeded", "denied", "failed"]);

export type AuditCursor = { createdAt: string; id: string };

export type ParsedAuditQuery = {
  entityType: string | null;
  entityId: string | null;
  actorId: string | null;
  actorType: "human" | "ai" | "system" | "worker" | null;
  action: string | null;
  outcome: "attempted" | "succeeded" | "denied" | "failed" | null;
  correlationId: string | null;
  from: Date | null;
  to: Date | null;
  cursor: AuditCursor | null;
  limit: number;
};

export type AuditQueryResult =
  | { ok: true; query: ParsedAuditQuery }
  | { ok: false; field: string; message: string };

function parseLimit(
  value: string | null,
  defaultLimit: number,
  maxLimit: number,
): number {
  if (!value) return defaultLimit;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultLimit;
  return Math.min(Math.floor(parsed), maxLimit);
}

function readFilter(
  searchParams: URLSearchParams,
  key: string,
  maxLength = 160,
): string | null {
  const value = searchParams.get(key)?.normalize("NFKC").trim() ?? "";
  return value.length > 0 && value.length <= maxLength ? value : null;
}

function parseDateFilter(
  value: string | null,
  boundary: "start" | "exclusive_end",
): Date | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  if (boundary === "exclusive_end" && /^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return date;
}

export function encodeAuditCursor(cursor: AuditCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeAuditCursor(value: string | null): AuditCursor | null {
  if (!value || value.length > 500) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<AuditCursor>;
    const date = new Date(parsed.createdAt ?? "");
    if (
      !UUID_PATTERN.test(parsed.id ?? "") ||
      Number.isNaN(date.getTime()) ||
      date.toISOString() !== parsed.createdAt
    ) {
      return null;
    }
    return { createdAt: parsed.createdAt, id: parsed.id } as AuditCursor;
  } catch {
    return null;
  }
}

export function parseAuditQuery(
  searchParams: URLSearchParams,
  options: {
    allowCursor?: boolean;
    defaultLimit?: number;
    maxLimit?: number;
  } = {},
): AuditQueryResult {
  for (const [field, maxLength] of [
    ["entityType", 80],
    ["entityId", 200],
    ["actorId", 80],
    ["actorType", 32],
    ["action", 160],
    ["outcome", 32],
    ["correlationId", 160],
    ["from", 80],
    ["to", 80],
  ] as const) {
    const value = searchParams.get(field)?.normalize("NFKC").trim() ?? "";
    if (value.length > maxLength) {
      return {
        ok: false,
        field,
        message: `${field} is longer than the supported limit.`,
      };
    }
  }
  const entityType = readFilter(searchParams, "entityType", 80);
  const entityId = readFilter(searchParams, "entityId", 200);
  const actorId = readFilter(searchParams, "actorId", 80);
  const actorType = readFilter(searchParams, "actorType", 32);
  const action = readFilter(searchParams, "action", 160);
  const outcome = readFilter(searchParams, "outcome", 32);
  const correlationId = readFilter(searchParams, "correlationId", 160);
  const fromRaw = readFilter(searchParams, "from", 80);
  const toRaw = readFilter(searchParams, "to", 80);
  const cursorRaw = searchParams.get("cursor");

  if (actorId && !UUID_PATTERN.test(actorId)) {
    return { ok: false, field: "actorId", message: "Actor ID must be a UUID." };
  }
  if (actorType && !["human", "ai", "system", "worker"].includes(actorType)) {
    return {
      ok: false,
      field: "actorType",
      message: "Actor type is not supported.",
    };
  }
  for (const [field, value] of [
    ["entityType", entityType],
    ["action", action],
    ["outcome", outcome],
    ["correlationId", correlationId],
  ] as const) {
    if (value && !SAFE_FILTER_PATTERN.test(value)) {
      return {
        ok: false,
        field,
        message: `${field} contains unsupported characters.`,
      };
    }
  }
  if (outcome && !OUTCOMES.has(outcome)) {
    return { ok: false, field: "outcome", message: "Outcome is not supported." };
  }

  const from = parseDateFilter(fromRaw, "start");
  const to = parseDateFilter(toRaw, "exclusive_end");
  if (fromRaw && !from) {
    return { ok: false, field: "from", message: "From date is invalid." };
  }
  if (toRaw && !to) {
    return { ok: false, field: "to", message: "To date is invalid." };
  }
  if (from && to && from > to) {
    return {
      ok: false,
      field: "to",
      message: "To date must be on or after From date.",
    };
  }

  if (cursorRaw && options.allowCursor === false) {
    return {
      ok: false,
      field: "cursor",
      message: "Cursor pagination is not supported for exports.",
    };
  }
  const cursor = decodeAuditCursor(cursorRaw);
  if (cursorRaw && !cursor) {
    return {
      ok: false,
      field: "cursor",
      message: "The audit cursor is invalid or expired.",
    };
  }

  return {
    ok: true,
    query: {
      entityType,
      entityId,
      actorId,
      actorType: actorType as ParsedAuditQuery["actorType"],
      action,
      outcome: outcome as ParsedAuditQuery["outcome"],
      correlationId,
      from,
      to,
      cursor,
      limit: parseLimit(
        searchParams.get("limit"),
        options.defaultLimit ?? DEFAULT_LIMIT,
        options.maxLimit ?? MAX_LIMIT,
      ),
    },
  };
}

export function buildAuditWhere(query: ParsedAuditQuery): SQL[] {
  return [
    query.entityType ? eq(auditLogs.entityType, query.entityType) : undefined,
    query.entityId ? eq(auditLogs.entityId, query.entityId) : undefined,
    query.actorId ? eq(auditLogs.actorId, query.actorId) : undefined,
    query.actorType ? eq(auditLogs.actorType, query.actorType) : undefined,
    query.action ? eq(auditLogs.action, query.action) : undefined,
    query.outcome ? eq(auditLogs.outcome, query.outcome) : undefined,
    query.correlationId
      ? eq(auditLogs.correlationId, query.correlationId)
      : undefined,
    query.from ? gte(auditLogs.createdAt, query.from) : undefined,
    query.to ? lt(auditLogs.createdAt, query.to) : undefined,
    query.cursor
      ? or(
          lt(auditLogs.createdAt, new Date(query.cursor.createdAt)),
          and(
            eq(auditLogs.createdAt, new Date(query.cursor.createdAt)),
            lt(auditLogs.id, query.cursor.id),
          ),
        )
      : undefined,
  ].filter((filter): filter is SQL => filter !== undefined);
}
