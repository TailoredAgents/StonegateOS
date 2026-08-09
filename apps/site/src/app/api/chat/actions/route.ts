import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import type { MutationErrorCode, MutationResult } from "@myst-os/sdk";
import { requireTeamRequestPrincipal } from "@/app/api/team/auth";
import { callAdminApiAs } from "@/app/team/lib/api";
import { agentActionTemporaryBlocker } from "@/app/team/lib/agent-action-availability";
import {
  AGENT_ACTION_PERMISSIONS,
  isAgentActionType,
  isAgentApprovalId as isAgentActionId,
  isAgentIdempotencyKey,
  isAgentVersionedAction,
  isExactAgentRecordVersion,
  parseAgentActionApprovalProof,
  parseAgentActionMutationSuccess,
  parseAgentActionPayload,
  parseAgentOperationalMutationResult,
  type AgentActionType,
} from "@/app/team/lib/agent-action-mutation";
import {
  BoundedRequestBodyError,
  readBoundedRequestBytes,
} from "@/app/team/lib/bounded-request";
import { hasTeamPermission } from "@/lib/team-principal";
import { isAgentBotRequest } from "../bot-auth";

type JsonObject = {
  [key: string]: unknown;
  contactName?: unknown;
  addressLine1?: unknown;
  city?: unknown;
  state?: unknown;
  postalCode?: unknown;
  addressLine2?: unknown;
  phone?: unknown;
  email?: unknown;
  contactId?: unknown;
  propertyId?: unknown;
  services?: unknown;
  notes?: unknown;
  note?: unknown;
  appointmentId?: unknown;
  zoneId?: unknown;
  title?: unknown;
  body?: unknown;
  dueAt?: unknown;
  assignedTo?: unknown;
  startAt?: unknown;
  durationMinutes?: unknown;
  travelBufferMinutes?: unknown;
  quotedTotalCents?: unknown;
  channel?: unknown;
  ids?: unknown;
  items?: unknown;
  confirmation?: unknown;
  status?: unknown;
  expectedVersion?: unknown;
};

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type AgentActionCandidate = JsonObject & {
  actionId?: unknown;
  approval?: unknown;
  payload?: unknown;
  type?: unknown;
};

type AgentExecutionReservation = {
  state: "reserved";
  reservationId: string;
  reservationToken: string;
  actionType: AgentActionType;
  approvalId: string;
  actionId: string;
  actorId: string;
  sessionId: string;
  correlationId: string;
  payloadHash: string;
  expectedVersion: string | null;
};

function mutationCodeForStatus(status: number): MutationErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 409) return "conflict";
  if (status === 422 || status === 400) return "invalid";
  if (status === 429) return "rate_limited";
  if (status === 408 || status === 504) return "timeout";
  if (status === 502 || status === 503) return "provider_failed";
  return "internal";
}

function mutationFailure(
  status: number,
  message: string,
  options: {
    code?: MutationErrorCode;
    retryable?: boolean;
    fieldErrors?: Record<string, string>;
  } = {},
): NextResponse<MutationResult<never>> {
  return NextResponse.json(
    {
      ok: false,
      code: options.code ?? mutationCodeForStatus(status),
      message,
      retryable:
        options.retryable ??
        (status === 408 || status === 429 || status >= 500),
      ...(options.fieldErrors ? { fieldErrors: options.fieldErrors } : {}),
    },
    { status },
  );
}

async function upstreamFailure(
  response: Response,
  fallback: string,
): Promise<NextResponse<MutationResult<never>>> {
  const body: unknown = await response.json().catch(() => null);
  if (isJsonObject(body) && body["ok"] === false) {
    const code = body["code"];
    const message = body["message"];
    const retryable = body["retryable"];
    if (
      (code === "unauthorized" ||
        code === "forbidden" ||
        code === "conflict" ||
        code === "invalid" ||
        code === "rate_limited" ||
        code === "timeout" ||
        code === "provider_failed" ||
        code === "internal") &&
      typeof message === "string" &&
      typeof retryable === "boolean"
    ) {
      return NextResponse.json(body as MutationResult<never>, {
        status: response.status,
      });
    }
  }
  const detail = isJsonObject(body)
    ? typeof body["message"] === "string"
      ? body["message"]
      : typeof body["error"] === "string"
        ? body["error"].replaceAll("_", " ")
        : null
    : null;
  return mutationFailure(response.status, detail ?? fallback);
}

function expectedVersionFromRequest(
  request: NextRequest,
  payload: JsonObject,
): string | null {
  const payloadVersion = payload.expectedVersion;
  let headerVersion = request.headers.get("if-match")?.trim() ?? "";
  if (headerVersion.startsWith('W/"') && headerVersion.endsWith('"')) {
    headerVersion = headerVersion.slice(3, -1);
  } else if (headerVersion.startsWith('"') && headerVersion.endsWith('"')) {
    headerVersion = headerVersion.slice(1, -1);
  }
  if (
    !isExactAgentRecordVersion(payloadVersion) ||
    !isExactAgentRecordVersion(headerVersion) ||
    payloadVersion !== headerVersion
  ) {
    return null;
  }
  return headerVersion;
}

function parseAgentExecutionReservation(
  value: unknown,
  expected: {
    actionType: AgentActionType;
    approvalId: string;
    actionId: string;
    actorId: string;
    sessionId: string;
    expectedVersion: string | null;
  },
): AgentExecutionReservation | null {
  const envelope = isJsonObject(value) ? value : null;
  const data = isJsonObject(envelope?.["data"]) ? envelope["data"] : null;
  const receipt = isJsonObject(envelope?.["receipt"])
    ? envelope["receipt"]
    : null;
  if (
    envelope?.["ok"] !== true ||
    !data ||
    !receipt ||
    receipt["actorId"] !== expected.actorId ||
    data["state"] !== "reserved" ||
    data["actionType"] !== expected.actionType ||
    data["approvalId"] !== expected.approvalId ||
    data["actionId"] !== expected.actionId ||
    data["actorId"] !== expected.actorId ||
    data["sessionId"] !== expected.sessionId ||
    receipt["correlationId"] !== data["correlationId"] ||
    data["expectedVersion"] !== expected.expectedVersion ||
    typeof data["reservationId"] !== "string" ||
    typeof data["reservationToken"] !== "string" ||
    typeof data["correlationId"] !== "string" ||
    typeof data["payloadHash"] !== "string"
  ) {
    return null;
  }
  return data as AgentExecutionReservation;
}

const ACTIONS_ENABLED = process.env["CHAT_ACTIONS_ENABLED"] !== "false";
const ACTION_RATE_LIMIT_MS = Number(process.env["CHAT_ACTION_RATE_MS"] ?? 0);
const lastActionByType = new Map<string, number>();

export async function POST(request: NextRequest) {
  // A bot may propose actions, but possession of the bot secret never grants
  // mutation authority. Execution requires a separately verified human team
  // session so the approval, permissions, and audit actor are unambiguous.
  if (isAgentBotRequest(request)) {
    return mutationFailure(
      403,
      "Agent and service requests may propose actions, but a verified team member must approve and execute them in /team.",
      { code: "forbidden", retryable: false },
    );
  }

  // Authenticate before parsing attacker-controlled input or doing any work.
  const auth = await requireTeamRequestPrincipal(request, { returnJson: true });
  if (!auth.ok) return auth.response;

  if (!ACTIONS_ENABLED) {
    return mutationFailure(403, "Agent actions are currently disabled.", {
      code: "forbidden",
      retryable: false,
    });
  }

  let candidate: unknown;
  try {
    const bytes = await readBoundedRequestBytes(request, 32 * 1024);
    candidate = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch (error) {
    const oversized =
      error instanceof BoundedRequestBodyError && error.reason === "too_large";
    return mutationFailure(
      oversized ? 413 : 422,
      oversized
        ? "The Agent action is too large to execute safely."
        : "Send one valid Agent action object.",
      {
        retryable: false,
        fieldErrors: { request: "Review the proposal and try again." },
      },
    );
  }
  if (!isJsonObject(candidate)) {
    return mutationFailure(422, "Send one valid Agent action object.", {
      fieldErrors: { request: "The request body is invalid." },
    });
  }

  const typedCandidate = candidate as AgentActionCandidate;

  if (
    Object.keys(typedCandidate).length !== 4 ||
    !["type", "actionId", "payload", "approval"].every(
      (key) => key in typedCandidate,
    )
  ) {
    return mutationFailure(422, "Use only the displayed Agent action fields.", {
      retryable: false,
      fieldErrors: { request: "Unknown or missing fields were rejected." },
    });
  }

  const candidateType = typedCandidate.type;
  if (!isAgentActionType(candidateType)) {
    return mutationFailure(422, "This Agent action is not supported.", {
      fieldErrors: { type: "Choose a supported proposed action." },
    });
  }

  const actionId = typedCandidate.actionId;
  const parsedPayload = parseAgentActionPayload(
    candidateType,
    typedCandidate.payload,
  );
  if (!isAgentActionId(actionId) || !parsedPayload.ok) {
    return mutationFailure(
      422,
      parsedPayload.ok
        ? "The Agent proposal identifier is invalid."
        : parsedPayload.message,
      {
        retryable: false,
        fieldErrors: parsedPayload.ok
          ? { actionId: "Refresh the proposal and review it again." }
          : parsedPayload.fieldErrors,
      },
    );
  }

  const approval = parseAgentActionApprovalProof(typedCandidate.approval);
  const approvalHeader = request.headers.get("x-agent-approval-id");
  if (!approval || approvalHeader !== approval.approvalId) {
    return mutationFailure(
      403,
      "This action is not bound to a current server-issued approval. Review it and choose Approve and execute.",
      {
        code: "forbidden",
        retryable: false,
        fieldErrors: { approval: "A valid approval proof is required." },
      },
    );
  }

  const idempotencyKey = request.headers.get("idempotency-key");
  if (!isAgentIdempotencyKey(idempotencyKey)) {
    return mutationFailure(
      422,
      "A stable request key is required before this action can execute.",
      {
        retryable: false,
        fieldErrors: {
          idempotencyKey: "Refresh the Agent suggestion and approve it again.",
        },
      },
    );
  }

  const requiredPermissions = AGENT_ACTION_PERMISSIONS[candidateType];
  const missingPermissions = requiredPermissions.filter(
    (permission) => !hasTeamPermission(auth.principal, permission),
  );
  if (missingPermissions.length > 0) {
    return mutationFailure(
      403,
      "You do not have permission to approve this action.",
      {
        code: "forbidden",
        retryable: false,
        fieldErrors: {
          permission: `Missing: ${missingPermissions.join(", ")}`,
        },
      },
    );
  }

  const payload = {
    type: candidateType,
    payload: parsedPayload.payload as JsonObject,
  };
  const expectedVersion = isAgentVersionedAction(payload.type)
    ? expectedVersionFromRequest(request, payload.payload)
    : null;
  if (
    (isAgentVersionedAction(payload.type) && !expectedVersion) ||
    (!isAgentVersionedAction(payload.type) && request.headers.has("if-match"))
  ) {
    return mutationFailure(
      422,
      "The exact current appointment version is required before this action can execute.",
      {
        retryable: false,
        fieldErrors: {
          version:
            "Ask the Agent to refresh the appointment, then review it again.",
        },
      },
    );
  }
  const correlationId = randomUUID();
  const expectedEntityId = isAgentVersionedAction(payload.type)
    ? typeof payload.payload.appointmentId === "string"
      ? payload.payload.appointmentId.trim() || null
      : null
    : null;

  const temporaryBlocker = agentActionTemporaryBlocker(payload.type);
  if (temporaryBlocker) {
    return mutationFailure(503, temporaryBlocker, {
      code: "provider_failed",
      retryable: false,
    });
  }

  const responseFromJson = (
    body: unknown,
    status: number,
    headers?: HeadersInit,
  ): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    });

  let reservationPromise: Promise<
    | { kind: "reserved"; reservation: AgentExecutionReservation }
    | { kind: "blocked"; response: Response }
  > | null = null;
  let activeReservation: AgentExecutionReservation | null = null;

  const ensureExecutionReservation = () => {
    if (reservationPromise) return reservationPromise;
    reservationPromise = (async () => {
      try {
        const headers = new Headers({
          "Idempotency-Key": idempotencyKey,
          "X-Correlation-Id": correlationId,
        });
        if (expectedVersion) headers.set("If-Match", `"${expectedVersion}"`);
        const response = await callAdminApiAs(
          auth.principal,
          "/api/admin/agent/action-executions",
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              phase: "reserve",
              actionType: payload.type,
              actionId,
              payload: payload.payload,
              approval,
            }),
          },
        );
        const body: unknown = await response.json().catch(() => null);
        const replayed =
          response.headers.get("idempotency-replayed") === "true";
        if (!response.ok) {
          return {
            kind: "blocked" as const,
            response: responseFromJson(body, response.status, {
              ...(replayed ? { "idempotency-replayed": "true" } : {}),
            }),
          };
        }
        const reservation = parseAgentExecutionReservation(body, {
          actionType: payload.type,
          approvalId: approval.approvalId,
          actionId,
          actorId: auth.principal.memberId,
          sessionId: auth.principal.sessionId,
          expectedVersion,
        });
        if (reservation) {
          activeReservation = reservation;
          return { kind: "reserved" as const, reservation };
        }
        return {
          kind: "blocked" as const,
          response: mutationFailure(
            502,
            "The action reservation response was unreadable. No execution was started.",
            { code: "internal", retryable: false },
          ),
        };
      } catch {
        return {
          kind: "blocked" as const,
          response: mutationFailure(
            503,
            "The action could not be reserved, so no execution was started. Keep your inputs and try again.",
            { code: "provider_failed", retryable: true },
          ),
        };
      }
    })();
    return reservationPromise;
  };

  const finalizeExecution = async (
    upstreamStatus: number,
    upstream: unknown,
  ): Promise<Response> => {
    if (!activeReservation) {
      return mutationFailure(
        500,
        "The action result could not be bound to its reservation. Reconcile the affected record before retrying.",
        { code: "internal", retryable: false },
      );
    }
    try {
      const headers = new Headers({
        "Idempotency-Key": `${idempotencyKey}:finalize`,
        "X-Correlation-Id": activeReservation.correlationId,
      });
      if (expectedVersion) headers.set("If-Match", `"${expectedVersion}"`);
      return await callAdminApiAs(
        auth.principal,
        "/api/admin/agent/action-executions",
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            phase: "finalize",
            actionType: payload.type,
            reservationId: activeReservation.reservationId,
            reservationToken: activeReservation.reservationToken,
            upstreamStatus,
            upstream,
          }),
        },
      );
    } catch {
      return mutationFailure(
        503,
        "The operation may have completed, but its final receipt could not be confirmed. Refresh the affected record or thread before retrying.",
        { code: "provider_failed", retryable: false },
      );
    }
  };

  const safeAdminCall = async (
    path: string,
    init?: RequestInit,
    step = "execute",
  ): Promise<Response | null> => {
    const reservation = await ensureExecutionReservation();
    if (reservation.kind === "blocked") return reservation.response;
    try {
      const headers = new Headers(init?.headers);
      headers.set(
        "Idempotency-Key",
        `${reservation.reservation.reservationToken}:${step}`,
      );
      headers.set("X-Correlation-Id", reservation.reservation.correlationId);
      if (expectedVersion) headers.set("If-Match", `"${expectedVersion}"`);
      const response = await callAdminApiAs(auth.principal, path, {
        ...init,
        headers,
      });
      const body: unknown = await response.json().catch(() => null);
      if (step === "thread") {
        return responseFromJson(body, response.status, {
          ...(response.headers.get("idempotency-replayed") === "true"
            ? { "idempotency-replayed": "true" }
            : {}),
        });
      }
      const verified = parseAgentOperationalMutationResult(payload.type, body, {
        actorId: auth.principal.memberId,
        targetEntityId: expectedEntityId,
        expectedVersion,
      });
      if (!verified) {
        return mutationFailure(
          502,
          response.ok
            ? "The operational API returned 2xx without a verified actor, entity, and version receipt. No success is being claimed; retry with the same approval and key after reconciliation."
            : "The operational API returned an unreadable failure. Retry only with this same approval and key after checking the affected record.",
          { code: "internal", retryable: false },
        );
      }
      return finalizeExecution(response.status, body);
    } catch {
      return mutationFailure(
        503,
        "The operational result is unconfirmed. Retry with the same approval and key so the exact sub-operation can be replayed safely.",
        { code: "provider_failed", retryable: true },
      );
    }
  };

  const confirmedSuccess = (value: unknown): Response => {
    if (
      isJsonObject(value) &&
      value["ok"] === true &&
      isJsonObject(value["data"]) &&
      value["data"]["actionType"] === payload.type
    ) {
      const replay = parseAgentActionMutationSuccess(value, {
        actionType: payload.type,
        actorId: auth.principal.memberId,
        targetEntityId: expectedEntityId,
        expectedVersion,
      });
      return replay
        ? responseFromJson(value, 200, { "idempotency-replayed": "true" })
        : mutationFailure(
            502,
            "The stored action receipt was unreadable. Reconcile the affected record before retrying.",
            { code: "internal", retryable: false },
          );
    }
    return mutationFailure(
      502,
      "The Agent received a bare or malformed 2xx and will not claim success. Retry only with the same approval and key after reconciliation.",
      { code: "internal", retryable: false },
    );
  };

  const now = Date.now();
  const rateLimitKey = `${auth.principal.memberId}:${payload.type}`;
  const last = lastActionByType.get(rateLimitKey);
  if (ACTION_RATE_LIMIT_MS > 0 && last && now - last < ACTION_RATE_LIMIT_MS) {
    return mutationFailure(
      429,
      "This action was approved too quickly after the previous attempt. Wait a moment, then retry with the same inputs.",
      { code: "rate_limited", retryable: true },
    );
  }
  lastActionByType.set(rateLimitKey, now);

  if (payload.type === "create_contact") {
    const body = payload.payload;
    if (
      !body ||
      typeof body.contactName !== "string" ||
      typeof body.addressLine1 !== "string" ||
      typeof body.city !== "string" ||
      typeof body.state !== "string" ||
      typeof body.postalCode !== "string"
    ) {
      return NextResponse.json(
        { error: "missing_contact_fields" },
        { status: 400 },
      );
    }

    const res = await safeAdminCall(`/api/admin/tools/contact`, {
      method: "POST",
      body: JSON.stringify({
        contactName: body.contactName.trim(),
        addressLine1: body.addressLine1.trim(),
        city: body.city.trim(),
        state: body.state.trim(),
        postalCode: body.postalCode.trim(),
        addressLine2:
          typeof body.addressLine2 === "string"
            ? body.addressLine2.trim()
            : undefined,
        phone: typeof body.phone === "string" ? body.phone.trim() : undefined,
        email: typeof body.email === "string" ? body.email.trim() : undefined,
      }),
    });

    if (!res) {
      return mutationFailure(
        503,
        "The contact service could not be reached. No contact was confirmed.",
        { code: "provider_failed", retryable: true },
      );
    }

    if (!res.ok) {
      return upstreamFailure(res, "The contact could not be created.");
    }

    const data: unknown = await res.json().catch(() => null);
    return confirmedSuccess(data);
  }

  if (payload.type === "create_quote") {
    const body = payload.payload;
    if (
      !body ||
      typeof body.contactId !== "string" ||
      typeof body.propertyId !== "string" ||
      !Array.isArray(body.services)
    ) {
      return NextResponse.json(
        { error: "missing_quote_fields" },
        { status: 400 },
      );
    }

    const services = body.services.filter(
      (service): service is string =>
        typeof service === "string" && service.trim().length > 0,
    );
    const notes =
      typeof body.notes === "string" && body.notes.trim().length > 0
        ? body.notes.trim()
        : typeof body.note === "string" && body.note.trim().length > 0
          ? body.note.trim()
          : null;
    const res = await safeAdminCall(`/api/admin/tools/quote`, {
      method: "POST",
      body: JSON.stringify({
        contactId: body.contactId.trim(),
        propertyId: body.propertyId.trim(),
        services,
        notes,
        appointmentId:
          typeof body.appointmentId === "string"
            ? body.appointmentId.trim()
            : null,
        zoneId: typeof body.zoneId === "string" ? body.zoneId.trim() : null,
      }),
    });

    if (!res) {
      return mutationFailure(
        503,
        "The quote service could not be reached. No quote was confirmed.",
        { code: "provider_failed", retryable: true },
      );
    }

    if (!res.ok) {
      return upstreamFailure(res, "The quote could not be created.");
    }

    const data: unknown = await res.json().catch(() => null);
    return confirmedSuccess(data);
  }

  if (payload.type === "create_task") {
    const body = payload.payload;
    if (
      !body ||
      typeof body.appointmentId !== "string" ||
      typeof body.title !== "string"
    ) {
      return NextResponse.json(
        { error: "missing_task_fields" },
        { status: 400 },
      );
    }

    const note = typeof body.note === "string" ? body.note.trim() : "";
    const titleWithNote =
      note.length > 0 && !body.title.includes(note)
        ? `${body.title} — ${note}`
        : body.title;

    const res = await safeAdminCall(
      `/api/appointments/${body.appointmentId}/tasks`,
      {
        method: "POST",
        body: JSON.stringify({ title: titleWithNote }),
      },
    );

    if (!res) {
      return mutationFailure(
        503,
        "The task service could not be reached. No task was confirmed.",
        { code: "provider_failed", retryable: true },
      );
    }

    if (!res.ok) {
      return upstreamFailure(res, "The task could not be created.");
    }

    const data: unknown = await res.json().catch(() => null);
    return confirmedSuccess(data);
  }

  if (payload.type === "add_contact_note") {
    const body = payload.payload;
    if (
      !body ||
      typeof body.contactId !== "string" ||
      typeof body.body !== "string"
    ) {
      return NextResponse.json(
        { error: "missing_note_fields" },
        { status: 400 },
      );
    }

    const noteBody = body.body.trim();
    if (!noteBody.length) {
      return NextResponse.json(
        { error: "note_body_required" },
        { status: 400 },
      );
    }

    const title =
      noteBody.length <= 60 ? noteBody : `${noteBody.slice(0, 57)}...`;

    const res = await safeAdminCall(`/api/admin/crm/tasks`, {
      method: "POST",
      body: JSON.stringify({
        contactId: body.contactId,
        title,
        notes: noteBody,
        status: "completed",
      }),
    });

    if (!res) {
      return mutationFailure(
        503,
        "The note service could not be reached. No note was confirmed.",
        { code: "provider_failed", retryable: true },
      );
    }

    if (!res.ok) {
      return upstreamFailure(res, "The note could not be created.");
    }

    const data: unknown = await res.json().catch(() => null);
    return confirmedSuccess(data);
  }

  if (payload.type === "create_reminder") {
    const body = payload.payload;
    if (
      !body ||
      typeof body.contactId !== "string" ||
      typeof body.dueAt !== "string"
    ) {
      return NextResponse.json(
        { error: "missing_reminder_fields" },
        { status: 400 },
      );
    }

    const title =
      typeof body.title === "string" && body.title.trim().length
        ? body.title.trim()
        : "Call back";
    const dueAt = body.dueAt.trim();
    const parsed = new Date(dueAt);
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json({ error: "invalid_due_at" }, { status: 400 });
    }

    const res = await safeAdminCall(`/api/admin/crm/reminders`, {
      method: "POST",
      body: JSON.stringify({
        contactId: body.contactId,
        title,
        dueAt,
        notes:
          typeof body.notes === "string" && body.notes.trim().length
            ? body.notes.trim()
            : undefined,
        assignedTo:
          typeof body.assignedTo === "string" && body.assignedTo.trim().length
            ? body.assignedTo.trim()
            : undefined,
      }),
    });

    if (!res) {
      return mutationFailure(
        503,
        "The reminder service could not be reached. No reminder was confirmed.",
        { code: "provider_failed", retryable: true },
      );
    }

    if (!res.ok) {
      return upstreamFailure(res, "The reminder could not be created.");
    }

    const data: unknown = await res.json().catch(() => null);
    return confirmedSuccess(data);
  }

  if (payload.type === "book_appointment") {
    const body = payload.payload;
    if (
      !body ||
      typeof body.contactId !== "string" ||
      typeof body.startAt !== "string"
    ) {
      return NextResponse.json(
        { error: "missing_booking_fields" },
        { status: 400 },
      );
    }
    const propertyId = body.propertyId;
    const durationMinutes = body.durationMinutes;
    const travelBufferMinutes = body.travelBufferMinutes;
    const quotedTotalCents = body.quotedTotalCents;
    if (propertyId !== undefined && typeof propertyId !== "string") {
      return NextResponse.json(
        { error: "invalid_property_id" },
        { status: 400 },
      );
    }
    if (
      durationMinutes !== undefined &&
      (typeof durationMinutes !== "number" ||
        !Number.isFinite(durationMinutes) ||
        durationMinutes <= 0)
    ) {
      return NextResponse.json({ error: "invalid_duration" }, { status: 400 });
    }
    if (
      travelBufferMinutes !== undefined &&
      (typeof travelBufferMinutes !== "number" ||
        !Number.isFinite(travelBufferMinutes) ||
        travelBufferMinutes < 0)
    ) {
      return NextResponse.json(
        { error: "invalid_travel_buffer" },
        { status: 400 },
      );
    }
    if (
      quotedTotalCents !== undefined &&
      quotedTotalCents !== null &&
      (typeof quotedTotalCents !== "number" ||
        !Number.isFinite(quotedTotalCents) ||
        quotedTotalCents < 0 ||
        !Number.isInteger(quotedTotalCents))
    ) {
      return NextResponse.json(
        { error: "invalid_quote_total" },
        { status: 400 },
      );
    }

    const services = Array.isArray(body.services)
      ? body.services
          .filter(
            (service): service is string =>
              typeof service === "string" && service.trim().length > 0,
          )
          .map((service) => service.trim())
          .slice(0, 3)
      : [];

    const res = await safeAdminCall(`/api/admin/booking/book`, {
      method: "POST",
      body: JSON.stringify({
        contactId: body.contactId,
        ...(typeof propertyId === "string" && propertyId.trim().length
          ? { propertyId: propertyId.trim() }
          : {}),
        startAt: body.startAt,
        durationMinutes:
          typeof durationMinutes === "number" ? durationMinutes : 60,
        travelBufferMinutes:
          typeof travelBufferMinutes === "number" ? travelBufferMinutes : 30,
        services,
        note:
          typeof body.note === "string" && body.note.trim().length
            ? body.note.trim()
            : undefined,
        ...(typeof quotedTotalCents === "number" ? { quotedTotalCents } : {}),
      }),
    });

    if (!res) {
      return mutationFailure(
        503,
        "The booking service could not be reached. No booking was confirmed.",
        { code: "provider_failed", retryable: true },
      );
    }

    if (!res.ok) {
      return upstreamFailure(res, "The appointment could not be booked.");
    }

    const data: unknown = await res.json().catch(() => null);
    return confirmedSuccess(data);
  }

  if (payload.type === "reschedule_appointment") {
    const body = payload.payload;
    if (
      !body ||
      typeof body.appointmentId !== "string" ||
      typeof body.startAt !== "string"
    ) {
      return NextResponse.json(
        { error: "missing_reschedule_fields" },
        { status: 400 },
      );
    }
    const durationMinutes = body.durationMinutes;
    const travelBufferMinutes = body.travelBufferMinutes;
    if (
      durationMinutes !== undefined &&
      (typeof durationMinutes !== "number" ||
        !Number.isFinite(durationMinutes) ||
        durationMinutes <= 0)
    ) {
      return NextResponse.json({ error: "invalid_duration" }, { status: 400 });
    }
    if (
      travelBufferMinutes !== undefined &&
      (typeof travelBufferMinutes !== "number" ||
        !Number.isFinite(travelBufferMinutes) ||
        travelBufferMinutes < 0)
    ) {
      return NextResponse.json(
        { error: "invalid_travel_buffer" },
        { status: 400 },
      );
    }

    const res = await safeAdminCall(
      `/api/web/appointments/${encodeURIComponent(body.appointmentId.trim())}/reschedule`,
      {
        method: "POST",
        body: JSON.stringify({
          startAt: body.startAt,
          expectedVersion,
          ...(typeof durationMinutes === "number" ? { durationMinutes } : {}),
          ...(typeof travelBufferMinutes === "number"
            ? { travelBufferMinutes }
            : {}),
        }),
      },
    );

    if (!res) {
      return mutationFailure(
        503,
        "The scheduling service could not be reached. No reschedule was confirmed.",
        { code: "provider_failed", retryable: true },
      );
    }

    if (!res.ok) {
      return upstreamFailure(res, "The appointment could not be rescheduled.");
    }

    const data: unknown = await res.json().catch(() => null);
    return confirmedSuccess(data);
  }

  if (payload.type === "send_text") {
    const body = payload.payload;
    if (
      !body ||
      typeof body.contactId !== "string" ||
      typeof body.body !== "string"
    ) {
      return NextResponse.json(
        { error: "missing_sms_fields" },
        { status: 400 },
      );
    }
    const contactId = body.contactId.trim();
    const text = body.body.trim();
    if (!contactId)
      return NextResponse.json(
        { error: "contact_id_required" },
        { status: 400 },
      );
    if (!text)
      return NextResponse.json({ error: "body_required" }, { status: 400 });

    const channel =
      body.channel === "email" || body.channel === "dm" ? body.channel : "sms";

    const ensureRes = await safeAdminCall(
      `/api/admin/inbox/threads/ensure`,
      {
        method: "POST",
        body: JSON.stringify({ contactId, channel }),
      },
      "thread",
    );

    if (!ensureRes) {
      return mutationFailure(
        503,
        "The messaging service could not be reached. No message was confirmed.",
        { code: "provider_failed", retryable: true },
      );
    }

    if (!ensureRes.ok) {
      return upstreamFailure(
        ensureRes,
        "The customer conversation could not be prepared.",
      );
    }

    const ensurePayload: unknown = await ensureRes.json().catch(() => null);
    const ensuredThreadId = isJsonObject(ensurePayload)
      ? ensurePayload["threadId"]
      : null;
    const threadId =
      typeof ensuredThreadId === "string" ? ensuredThreadId.trim() : "";
    if (!threadId)
      return mutationFailure(
        502,
        "The messaging service did not confirm a conversation. No message was sent.",
        { code: "internal", retryable: false },
      );

    const sendRes = await safeAdminCall(
      `/api/admin/inbox/threads/${encodeURIComponent(threadId)}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          body: text,
          direction: "outbound",
          channel,
        }),
      },
      "message",
    );

    if (!sendRes) {
      return mutationFailure(
        503,
        "The message result could not be confirmed. Reconcile the thread before retrying to avoid a duplicate.",
        { code: "provider_failed", retryable: false },
      );
    }

    if (!sendRes.ok) {
      return upstreamFailure(sendRes, "The message could not be queued.");
    }

    const data: unknown = await sendRes.json().catch(() => null);
    return confirmedSuccess(isJsonObject(data) ? { threadId, ...data } : data);
  }

  if (payload.type === "cancel_appointment") {
    const body = payload.payload;
    if (!body || typeof body.appointmentId !== "string") {
      return NextResponse.json(
        { error: "missing_cancel_fields" },
        { status: 400 },
      );
    }

    const res = await safeAdminCall(
      `/api/appointments/${body.appointmentId}/status`,
      {
        method: "POST",
        body: JSON.stringify({
          status: "canceled",
          expectedVersion,
        }),
      },
    );

    if (!res) {
      return mutationFailure(
        503,
        "The cancellation result could not be confirmed. Refresh the appointment before retrying.",
        { code: "provider_failed", retryable: false },
      );
    }

    if (!res.ok) {
      return upstreamFailure(res, "The appointment could not be canceled.");
    }

    const data: unknown = await res.json().catch(() => null);
    return confirmedSuccess(data);
  }

  if (payload.type === "google_ads_recommendations_bulk_update") {
    const body = payload.payload;

    const res = await safeAdminCall(
      `/api/admin/google/ads/analyst/recommendations/bulk`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );

    if (!res) {
      return mutationFailure(
        503,
        "The marketing service could not be reached. No review change was confirmed.",
        { code: "provider_failed", retryable: true },
      );
    }

    if (!res.ok) {
      return upstreamFailure(
        res,
        "The recommendation review state could not be updated.",
      );
    }

    const data: unknown = await res.json().catch(() => null);
    return confirmedSuccess(data);
  }

  if (payload.type === "google_ads_recommendations_bulk_apply") {
    const body = payload.payload;

    const res = await safeAdminCall(
      `/api/admin/google/ads/analyst/recommendations/apply/bulk`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );

    if (!res) {
      return mutationFailure(
        503,
        "The Google Ads result could not be confirmed. Reconcile provider history before retrying.",
        { code: "provider_failed", retryable: false },
      );
    }

    if (!res.ok) {
      return upstreamFailure(
        res,
        "The Google Ads changes could not be requested.",
      );
    }

    const data: unknown = await res.json().catch(() => null);
    return confirmedSuccess(data);
  }

  return NextResponse.json({ error: "unsupported_action" }, { status: 400 });
}
