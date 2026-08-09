import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, asc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import { auditLogs, conversationMessages, getDb } from "@/db";
import { sanitizeAuditMetadata } from "@/lib/audit-metadata";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import {
  buildConversationJsonl,
  CONVERSATION_EXPORT_MAX_BODY_BYTES,
  CONVERSATION_EXPORT_MAX_BYTES,
  CONVERSATION_EXPORT_MAX_LINE_BYTES,
  CONVERSATION_EXPORT_MAX_MESSAGES,
  CONVERSATION_EXPORT_MAX_THREADS,
  conversationExportFilterEvidence,
  isConversationMessageExportEligible,
  parseConversationExportQuery,
  readConversationExportConfirmation,
  readConversationExportFinalization,
  type ConversationExportBuildResult,
  type ConversationExportFinalizationInput,
  type ConversationExportQuery,
} from "@/lib/conversation-export";
import { requirePermission } from "@/lib/permissions";
import {
  getVerifiedRequestActor,
  type VerifiedRequestActor,
} from "@/lib/verified-actor-context";
import { isAdminRequest } from "../../../../web/admin";

export const dynamic = "force-dynamic";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const EXPORT_PERMISSION = "messages.export" as const;

type ExportFailure = Extract<ConversationExportBuildResult, { ok: false }>;
type FinalizeResult =
  | { ok: true; exportId: string; idempotent: boolean }
  | { ok: false; code: "missing" | "conflict" };

function errorResponse(
  status: number,
  error: string,
  message: string,
  correlationId: string,
  retryable: boolean,
  extra: Record<string, unknown> = {},
): NextResponse {
  return NextResponse.json(
    {
      ...extra,
      error,
      message,
      correlationId,
      supportId: correlationId,
      retryable,
      truncated: false,
    },
    {
      status,
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Cross-Origin-Resource-Policy": "same-origin",
        "X-Audit-Correlation-Id": correlationId,
      },
    },
  );
}

function limitFailureMessage(failure: ExportFailure): string {
  switch (failure.reason) {
    case "message_limit":
      return `The export contains more than ${failure.maximum.toLocaleString("en-US")} eligible messages. Choose a shorter range or one channel; no partial file was released.`;
    case "thread_limit":
      return `The export contains more than ${failure.maximum.toLocaleString("en-US")} conversations. Choose a shorter range or one channel; no partial file was released.`;
    case "body_limit":
      return `At least one message exceeds the ${failure.maximum.toLocaleString("en-US")} byte body limit. No partial file was released.`;
    case "line_limit":
      return `At least one conversation exceeds the ${failure.maximum.toLocaleString("en-US")} byte JSONL line limit. Choose a shorter range; no partial file was released.`;
    case "byte_limit":
      return `The export exceeds the ${failure.maximum.toLocaleString("en-US")} byte file limit. Choose a shorter range or one channel; no partial file was released.`;
    default:
      return "The conversation data could not be represented safely as JSONL. No file was released.";
  }
}

function correlationIdForRequest(request: NextRequest): string {
  const requested = request.headers.get("x-request-id")?.trim() ?? "";
  return UUID_PATTERN.test(requested) ? requested.toLowerCase() : randomUUID();
}

function easternDateStamp(value = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: "year" | "month" | "day") =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function isPostgresStatementTimeout(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "57014",
  );
}

function isVerifiedHumanActor(
  actor: VerifiedRequestActor | null,
): actor is VerifiedRequestActor & {
  type: "human";
  id: string;
  sessionId: string;
  authMethod: "team_session" | "break_glass";
} {
  return Boolean(
    actor &&
      actor.type === "human" &&
      actor.id &&
      actor.sessionId &&
      (actor.authMethod === "team_session" ||
        actor.authMethod === "break_glass"),
  );
}

function isValidMutationOrigin(request: NextRequest): boolean {
  const rawOrigin = request.headers.get("origin")?.trim() ?? "";
  if (!rawOrigin || rawOrigin === "null") return false;
  try {
    const origin = new URL(rawOrigin);
    const target = new URL(request.url);
    return (
      !origin.username &&
      !origin.password &&
      origin.pathname === "/" &&
      !origin.search &&
      !origin.hash &&
      (origin.protocol === "http:" || origin.protocol === "https:") &&
      origin.origin.toLowerCase() === target.origin.toLowerCase()
    );
  } catch {
    return false;
  }
}

async function permissionErrorResponse(
  request: NextRequest,
  correlationId: string,
  permissionError: Response,
): Promise<Response> {
  const actor = getVerifiedRequestActor(request);
  if (isVerifiedHumanActor(actor)) {
    try {
      await recordAuditEvent({
        actor,
        action: "conversation.export.denied",
        entityType: "conversation_export",
        entityId: randomUUID(),
        correlationId,
        requiredPermissions: [EXPORT_PERMISSION],
        outcome: "denied",
        surface: "settings",
        meta: {
          format: "jsonl",
          sensitive: true,
          boundary: "permission",
          upstreamStatus: permissionError.status,
          truncated: false,
        },
      });
    } catch {
      return errorResponse(
        500,
        "conversation_export_audit_failed",
        "The denied export request could not be audited. No file was released.",
        correlationId,
        true,
      );
    }
  }

  if (permissionError.status === 401) {
    return errorResponse(
      401,
      "unauthorized",
      "A verified team session is required for this export.",
      correlationId,
      false,
    );
  }
  if (permissionError.status === 403) {
    return errorResponse(
      403,
      "forbidden",
      "You do not have permission to export conversation data.",
      correlationId,
      false,
    );
  }
  if (permissionError.status === 503) {
    return errorResponse(
      503,
      "operation_disabled",
      "Conversation exports are temporarily disabled by a safety control.",
      correlationId,
      false,
    );
  }
  return errorResponse(
    500,
    "conversation_export_authorization_failed",
    "Export authorization could not be verified. No file was released.",
    correlationId,
    true,
  );
}

async function prepareSnapshotExport(
  db: ReturnType<typeof getDb>,
  query: ConversationExportQuery,
): Promise<ConversationExportBuildResult> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`set transaction isolation level repeatable read read only`,
    );
    await tx.execute(sql`set local statement_timeout = '15s'`);

    const effectiveAt = sql<Date>`coalesce(
      ${conversationMessages.sentAt},
      ${conversationMessages.receivedAt},
      ${conversationMessages.createdAt}
    )`;
    const draftExpression = sql<boolean>`coalesce(${conversationMessages.metadata}->>'draft', 'false') = 'true'`;
    const filters = [
      gte(effectiveAt, query.fromInclusive),
      lt(effectiveAt, query.toExclusive),
      sql`${conversationMessages.body} !~ E'^[\\t\\n\\v\\f\\r ]*$'`,
      or(
        eq(conversationMessages.direction, "inbound"),
        and(
          eq(conversationMessages.direction, "outbound"),
          inArray(conversationMessages.deliveryStatus, ["sent", "delivered"]),
          sql`not (${draftExpression})`,
        ),
      ),
    ];
    if (query.channel) {
      filters.push(eq(conversationMessages.channel, query.channel));
    }

    // Refuse an oversized export before any sensitive message body is loaded.
    const preflight = await tx
      .select({
        id: conversationMessages.id,
        threadId: conversationMessages.threadId,
        bodyBytes: sql<number>`octet_length(${conversationMessages.body})`,
      })
      .from(conversationMessages)
      .where(and(...filters))
      .orderBy(
        asc(effectiveAt),
        asc(conversationMessages.createdAt),
        asc(conversationMessages.id),
      )
      .limit(CONVERSATION_EXPORT_MAX_MESSAGES + 1);

    if (preflight.length > CONVERSATION_EXPORT_MAX_MESSAGES) {
      return {
        ok: false,
        reason: "message_limit",
        observed: preflight.length,
        maximum: CONVERSATION_EXPORT_MAX_MESSAGES,
      };
    }

    const threadCount = new Set(preflight.map((row) => row.threadId)).size;
    if (threadCount > CONVERSATION_EXPORT_MAX_THREADS) {
      return {
        ok: false,
        reason: "thread_limit",
        observed: threadCount,
        maximum: CONVERSATION_EXPORT_MAX_THREADS,
      };
    }

    let rawBodyBytes = 0;
    for (const row of preflight) {
      const bodyBytes = Number(row.bodyBytes);
      if (!Number.isSafeInteger(bodyBytes) || bodyBytes < 0) {
        return { ok: false, reason: "invalid_row", observed: 1, maximum: 0 };
      }
      if (bodyBytes > CONVERSATION_EXPORT_MAX_BODY_BYTES) {
        return {
          ok: false,
          reason: "body_limit",
          observed: bodyBytes,
          maximum: CONVERSATION_EXPORT_MAX_BODY_BYTES,
        };
      }
      rawBodyBytes += bodyBytes;
      if (rawBodyBytes > CONVERSATION_EXPORT_MAX_BYTES) {
        return {
          ok: false,
          reason: "byte_limit",
          observed: rawBodyBytes,
          maximum: CONVERSATION_EXPORT_MAX_BYTES,
        };
      }
    }

    if (preflight.length === 0) return buildConversationJsonl([]);
    const messageIds = preflight.map((row) => row.id);
    const rows = await tx
      .select({
        threadId: conversationMessages.threadId,
        direction: conversationMessages.direction,
        deliveryStatus: conversationMessages.deliveryStatus,
        draft: draftExpression,
        body: conversationMessages.body,
      })
      .from(conversationMessages)
      .where(inArray(conversationMessages.id, messageIds))
      .orderBy(
        asc(effectiveAt),
        asc(conversationMessages.createdAt),
        asc(conversationMessages.id),
      );
    if (rows.length !== preflight.length) {
      return { ok: false, reason: "invalid_row", observed: 1, maximum: 0 };
    }

    const sourceRows = [];
    for (const row of rows) {
      if (!isConversationMessageExportEligible(row)) {
        return { ok: false, reason: "invalid_row", observed: 1, maximum: 0 };
      }
      sourceRows.push({
        threadKey: row.threadId,
        role:
          row.direction === "inbound"
            ? ("user" as const)
            : ("assistant" as const),
        content: row.body,
      });
    }
    return buildConversationJsonl(sourceRows);
  });
}

async function recordExportFailure(input: {
  request: NextRequest;
  exportId: string;
  correlationId: string;
  reason: string;
  filters?: Record<string, unknown>;
  observed?: number;
  maximum?: number;
}): Promise<void> {
  await recordAuditEvent({
    actor: getAuditActorFromRequest(input.request),
    action: "conversation.export.failed",
    entityType: "conversation_export",
    entityId: input.exportId,
    correlationId: input.correlationId,
    requiredPermissions: [EXPORT_PERMISSION],
    outcome: "failed",
    surface: "settings",
    meta: {
      format: "jsonl",
      sensitive: true,
      reason: input.reason,
      filters: input.filters ?? null,
      observed: input.observed ?? null,
      maximum: input.maximum ?? null,
      truncated: false,
    },
  });
}

async function finalizePreparedExport(
  db: ReturnType<typeof getDb>,
  actor: VerifiedRequestActor & {
    type: "human";
    id: string;
    sessionId: string;
    authMethod: "team_session" | "break_glass";
  },
  input: ConversationExportFinalizationInput,
): Promise<FinalizeResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local statement_timeout = '5s'`);
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${input.correlationId}, 0))`,
    );
    const events = await tx
      .select({
        id: auditLogs.id,
        action: auditLogs.action,
        entityId: auditLogs.entityId,
        actorId: auditLogs.actorId,
        sessionId: auditLogs.sessionId,
      })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.correlationId, input.correlationId),
          eq(auditLogs.entityType, "conversation_export"),
        ),
      )
      .orderBy(asc(auditLogs.createdAt), asc(auditLogs.id))
      .limit(11);

    // A normal lifecycle has two or three rows. Refuse an unexpectedly reused
    // correlation rather than scanning without a bound or risking ambiguity.
    if (events.length > 10) return { ok: false, code: "conflict" };

    const prepared = events.filter(
      (event) =>
        event.action === "conversation.export.prepared" &&
        event.actorId === actor.id &&
        event.sessionId === actor.sessionId &&
        (input.exportId === null || event.entityId === input.exportId),
    );
    if (prepared.length !== 1 || !prepared[0]?.entityId) {
      return { ok: false, code: "missing" };
    }

    const exportId = prepared[0].entityId;
    const terminalEvents = events.filter(
      (event) =>
        event.entityId === exportId &&
        (event.action === "conversation.export.released" ||
          event.action === "conversation.export.failed"),
    );
    const requestedAction =
      input.outcome === "released"
        ? "conversation.export.released"
        : "conversation.export.failed";
    if (terminalEvents.length > 0) {
      return terminalEvents.every((event) => event.action === requestedAction)
        ? { ok: true, exportId, idempotent: true }
        : { ok: false, code: "conflict" };
    }

    await tx.insert(auditLogs).values({
      actorType: actor.type,
      actorId: actor.id,
      actorRole: actor.role ?? null,
      actorLabel: actor.label ?? null,
      sessionId: actor.sessionId,
      authMethod: actor.authMethod,
      correlationId: input.correlationId,
      requiredPermissions: [EXPORT_PERMISSION],
      outcome: input.outcome === "released" ? "succeeded" : "failed",
      surface: "settings",
      action: requestedAction,
      entityType: "conversation_export",
      entityId: exportId,
      meta: sanitizeAuditMetadata({
        format: "jsonl",
        sensitive: true,
        reason: input.reason,
        preparedAuditEventId: prepared[0].id,
        releaseBoundary:
          input.outcome === "released" ? "authenticated_site_proxy" : null,
        truncated: false,
      }),
      createdAt: new Date(),
    });
    return { ok: true, exportId, idempotent: false };
  });
}

export async function POST(request: NextRequest): Promise<Response> {
  const correlationId = correlationIdForRequest(request);
  if (!isAdminRequest(request)) {
    return errorResponse(
      401,
      "unauthorized",
      "A verified team session is required for this export.",
      correlationId,
      false,
    );
  }
  const permissionError = await requirePermission(request, "messages.export");
  if (permissionError) {
    return permissionErrorResponse(request, correlationId, permissionError);
  }

  const verifiedActor = getVerifiedRequestActor(request);
  if (!isVerifiedHumanActor(verifiedActor)) {
    return errorResponse(
      403,
      "verified_actor_required",
      "A verified human team session is required for this export.",
      correlationId,
      false,
    );
  }

  const exportId = randomUUID();
  const actor = getAuditActorFromRequest(request);
  try {
    await recordAuditEvent({
      actor,
      action: "conversation.export.attempted",
      entityType: "conversation_export",
      entityId: exportId,
      correlationId,
      requiredPermissions: [EXPORT_PERMISSION],
      outcome: "attempted",
      surface: "settings",
      meta: { format: "jsonl", sensitive: true, truncated: false },
    });
  } catch {
    return errorResponse(
      500,
      "conversation_export_audit_failed",
      "The export attempt could not be audited. No file was released.",
      correlationId,
      true,
    );
  }

  if (!isValidMutationOrigin(request)) {
    try {
      await recordExportFailure({
        request,
        exportId,
        correlationId,
        reason: "invalid_origin",
      });
    } catch {
      return errorResponse(
        500,
        "conversation_export_audit_failed",
        "The rejected export could not be audited. No file was released.",
        correlationId,
        true,
      );
    }
    return errorResponse(
      403,
      "invalid_origin",
      "The export request origin could not be verified.",
      correlationId,
      false,
    );
  }

  if (!(await readConversationExportConfirmation(request))) {
    try {
      await recordExportFailure({
        request,
        exportId,
        correlationId,
        reason: "invalid_confirmation",
      });
    } catch {
      return errorResponse(
        500,
        "conversation_export_audit_failed",
        "The rejected export could not be audited. No file was released.",
        correlationId,
        true,
      );
    }
    return errorResponse(
      422,
      "confirmation_required",
      "Confirm the sensitive export before requesting it.",
      correlationId,
      false,
    );
  }

  const parsed = parseConversationExportQuery(request.nextUrl.searchParams);
  if (!parsed.ok) {
    try {
      await recordExportFailure({
        request,
        exportId,
        correlationId,
        reason: `invalid_${parsed.field}`,
      });
    } catch {
      return errorResponse(
        500,
        "conversation_export_audit_failed",
        "The invalid export request could not be audited. No file was released.",
        correlationId,
        true,
      );
    }
    return errorResponse(
      422,
      "invalid_filter",
      parsed.message,
      correlationId,
      false,
      { field: parsed.field },
    );
  }

  const filterEvidence = conversationExportFilterEvidence(parsed.query);
  let prepared: ConversationExportBuildResult;
  try {
    prepared = await prepareSnapshotExport(getDb(), parsed.query);
  } catch (error) {
    const timedOut = isPostgresStatementTimeout(error);
    console.error("[conversation-export] preparation_failed", {
      correlationId,
      errorName: error instanceof Error ? error.name : "UnknownError",
      timedOut,
    });
    let failureAudited = true;
    try {
      await recordExportFailure({
        request,
        exportId,
        correlationId,
        reason: timedOut ? "preparation_timeout" : "preparation_failed",
        filters: filterEvidence,
      });
    } catch {
      failureAudited = false;
    }
    if (!failureAudited) {
      return errorResponse(
        500,
        "conversation_export_audit_failed",
        "The failed export could not be fully audited. No file was released.",
        correlationId,
        true,
      );
    }
    return errorResponse(
      timedOut ? 504 : 500,
      timedOut ? "conversation_export_timeout" : "conversation_export_failed",
      timedOut
        ? "The conversation query exceeded its 15-second safety deadline. Choose a shorter range or one channel; no file was released."
        : "The sensitive conversation export could not be prepared or fully audited. No file was released.",
      correlationId,
      true,
    );
  }

  if (!prepared.ok) {
    try {
      await recordExportFailure({
        request,
        exportId,
        correlationId,
        reason: prepared.reason,
        filters: filterEvidence,
        observed: prepared.observed,
        maximum: prepared.maximum,
      });
    } catch {
      return errorResponse(
        500,
        "conversation_export_audit_failed",
        "The rejected export could not be fully audited. No file was released.",
        correlationId,
        true,
      );
    }
    const status = prepared.reason === "invalid_row" ? 500 : 413;
    return errorResponse(
      status,
      status === 413 ? "conversation_export_too_large" : "invalid_export_data",
      limitFailureMessage(prepared),
      correlationId,
      false,
      {
        reason: prepared.reason,
        observed: prepared.observed,
        maximum: prepared.maximum,
      },
    );
  }

  try {
    await recordAuditEvent({
      actor,
      action: "conversation.export.prepared",
      entityType: "conversation_export",
      entityId: exportId,
      correlationId,
      requiredPermissions: [EXPORT_PERMISSION],
      outcome: "attempted",
      surface: "settings",
      meta: {
        format: "jsonl",
        sensitive: true,
        filters: filterEvidence,
        rowCount: prepared.rowCount,
        threadCount: prepared.threadCount,
        messageCount: prepared.messageCount,
        byteCount: prepared.byteCount,
        truncated: false,
      },
    });
  } catch {
    try {
      await recordExportFailure({
        request,
        exportId,
        correlationId,
        reason: "prepared_audit_failed",
        filters: filterEvidence,
      });
    } catch {
      // The attempted event is durable. No sensitive bytes are released.
    }
    return errorResponse(
      500,
      "conversation_export_audit_failed",
      "The prepared export could not be audited. No file was released.",
      correlationId,
      true,
    );
  }

  const responseBody = new ArrayBuffer(prepared.bytes.byteLength);
  new Uint8Array(responseBody).set(prepared.bytes);
  const date = easternDateStamp();
  return new Response(responseBody, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Content-Disposition": `attachment; filename="stonegate-conversations-${date}.jsonl"`,
      "Content-Length": String(prepared.byteCount),
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Export-Format-Version": "1",
      "X-Export-Receipt-Id": exportId,
      "X-Export-Row-Count": String(prepared.rowCount),
      "X-Export-Thread-Count": String(prepared.threadCount),
      "X-Export-Message-Count": String(prepared.messageCount),
      "X-Export-Byte-Count": String(prepared.byteCount),
      "X-Export-Maximum-Messages": String(CONVERSATION_EXPORT_MAX_MESSAGES),
      "X-Export-Maximum-Threads": String(CONVERSATION_EXPORT_MAX_THREADS),
      "X-Export-Maximum-Body-Bytes": String(CONVERSATION_EXPORT_MAX_BODY_BYTES),
      "X-Export-Maximum-Line-Bytes": String(CONVERSATION_EXPORT_MAX_LINE_BYTES),
      "X-Export-Maximum-Bytes": String(CONVERSATION_EXPORT_MAX_BYTES),
      "X-Export-Truncated": "false",
      "X-Export-Audit-State": "prepared",
      "X-Audit-Correlation-Id": correlationId,
    },
  });
}

export async function PUT(request: NextRequest): Promise<Response> {
  const correlationId = correlationIdForRequest(request);
  if (!isAdminRequest(request)) {
    return errorResponse(
      401,
      "unauthorized",
      "A verified team session is required to finalize this export.",
      correlationId,
      false,
    );
  }
  const permissionError = await requirePermission(request, "messages.export");
  if (permissionError) {
    return permissionErrorResponse(request, correlationId, permissionError);
  }
  const verifiedActor = getVerifiedRequestActor(request);
  if (!isVerifiedHumanActor(verifiedActor)) {
    return errorResponse(
      403,
      "verified_actor_required",
      "A verified human team session is required to finalize this export.",
      correlationId,
      false,
    );
  }
  if (!isValidMutationOrigin(request)) {
    return errorResponse(
      403,
      "invalid_origin",
      "The export finalization origin could not be verified.",
      correlationId,
      false,
    );
  }

  const input = await readConversationExportFinalization(
    request,
    correlationId,
  );
  if (!input) {
    return errorResponse(
      422,
      "invalid_finalization",
      "The export finalization receipt is invalid.",
      correlationId,
      false,
    );
  }

  let result: FinalizeResult;
  try {
    result = await finalizePreparedExport(getDb(), verifiedActor, input);
  } catch (error) {
    console.error("[conversation-export] finalization_failed", {
      correlationId,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return errorResponse(
      500,
      "conversation_export_finalization_failed",
      "The export receipt could not be finalized. No file should be released.",
      correlationId,
      true,
    );
  }

  if (!result.ok) {
    return errorResponse(
      409,
      result.code === "missing"
        ? "prepared_export_not_found"
        : "export_already_finalized",
      result.code === "missing"
        ? "No matching prepared export exists for this session."
        : "The prepared export already has a different terminal outcome.",
      correlationId,
      false,
    );
  }

  return NextResponse.json(
    {
      ok: true,
      correlationId,
      exportId: result.exportId,
      outcome: input.outcome,
      idempotent: result.idempotent,
    },
    {
      status: 200,
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Cross-Origin-Resource-Policy": "same-origin",
        "X-Audit-Correlation-Id": correlationId,
      },
    },
  );
}
