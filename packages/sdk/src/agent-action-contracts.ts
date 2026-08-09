import type {
  MutationErrorCode,
  MutationReceipt,
  MutationResult,
  TeamPermission,
} from "./team-contracts";

export const AGENT_ACTION_TYPES = [
  "create_contact",
  "create_quote",
  "create_task",
  "add_contact_note",
  "create_reminder",
  "book_appointment",
  "cancel_appointment",
  "reschedule_appointment",
  "send_text",
  "google_ads_recommendations_bulk_update",
  "google_ads_recommendations_bulk_apply",
] as const;

export type AgentActionType = (typeof AGENT_ACTION_TYPES)[number];

export const AGENT_ACTION_PERMISSIONS = {
  create_contact: ["contacts.write", "properties.write", "pipeline.write"],
  create_quote: ["quotes.write", "contacts.read", "properties.read"],
  create_task: ["appointments.update"],
  add_contact_note: ["contacts.write"],
  create_reminder: ["contacts.write"],
  book_appointment: ["bookings.manage"],
  cancel_appointment: ["appointments.update", "messages.send"],
  reschedule_appointment: ["appointments.update"],
  send_text: ["messages.write", "messages.send"],
  google_ads_recommendations_bulk_update: ["marketing.write"],
  google_ads_recommendations_bulk_apply: ["marketing.apply"],
} as const satisfies Record<AgentActionType, readonly TeamPermission[]>;

export const AGENT_VERSIONED_ACTIONS = [
  "cancel_appointment",
  "reschedule_appointment",
] as const satisfies readonly AgentActionType[];

export type AgentActionPayload = Record<string, unknown>;

export type AgentActionPayloadParseResult =
  | { ok: true; payload: AgentActionPayload }
  | { ok: false; message: string; fieldErrors: Record<string, string> };

export type AgentActionApprovalProof = {
  approvalId: string;
  approvalToken: string;
  expiresAt: string;
};

export type AgentActionResultDescriptor = {
  result: Record<string, unknown>;
  entityType: string;
  entityId: string;
  version: string;
  providerOperationId?: string;
};

export type AgentOperationalReceipt = MutationReceipt &
  Required<
    Pick<
      MutationReceipt,
      "auditEventId" | "entityType" | "entityId" | "version"
    >
  > & { version: string };

export type AgentOperationalMutationSuccess = {
  ok: true;
  data: Record<string, unknown>;
  receipt: AgentOperationalReceipt;
  descriptor: AgentActionResultDescriptor;
};

export type AgentOperationalMutationFailure = Extract<
  MutationResult<never>,
  { ok: false }
>;

export type AgentOperationalMutationResult =
  | AgentOperationalMutationSuccess
  | AgentOperationalMutationFailure;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const EXACT_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/u;
const SAFE_VALUE_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._:/+@#&'(),-]*$/u;
const MUTATION_ERROR_CODES = new Set<MutationErrorCode>([
  "unauthorized",
  "forbidden",
  "conflict",
  "invalid",
  "rate_limited",
  "timeout",
  "provider_failed",
  "internal",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactRecord(
  value: unknown,
  allowedKeys: readonly string[],
): Record<string, unknown> | null {
  const candidate = record(value);
  if (!candidate) return null;
  const allowed = new Set(allowedKeys);
  return Object.keys(candidate).every((key) => allowed.has(key))
    ? candidate
    : null;
}

function failure(
  message: string,
  field = "payload",
): AgentActionPayloadParseResult {
  return { ok: false, message, fieldErrors: { [field]: message } };
}

function trimmedString(
  value: unknown,
  options: { minimum?: number; maximum: number; pattern?: RegExp },
): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim();
  const minimum = options.minimum ?? 1;
  if (
    normalized.length < minimum ||
    normalized.length > options.maximum ||
    (options.pattern && !options.pattern.test(normalized))
  ) {
    return null;
  }
  return normalized;
}

function optionalString(
  value: unknown,
  maximum: number,
): string | null | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return trimmedString(value, { maximum });
}

function uuid(value: unknown): string | null {
  const normalized = trimmedString(value, { maximum: 36 });
  return normalized && UUID_PATTERN.test(normalized) ? normalized : null;
}

function optionalUuid(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return uuid(value);
}

function exactIso(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    !EXACT_ISO_PATTERN.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    return null;
  }
  return value;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : null;
}

function optionalInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number | null | undefined {
  if (value === undefined || value === null) return undefined;
  return boundedInteger(value, minimum, maximum);
}

function stringList(
  value: unknown,
  options: { minimum: number; maximum: number; itemMaximum: number },
): string[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length < options.minimum || value.length > options.maximum) {
    return null;
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const parsed = trimmedString(item, {
      maximum: options.itemMaximum,
      pattern: SAFE_VALUE_PATTERN,
    });
    if (!parsed || seen.has(parsed)) return null;
    seen.add(parsed);
    normalized.push(parsed);
  }
  return normalized;
}

function versionedItems(
  value: unknown,
  maximum: number,
): Array<{ id: string; expectedVersion: string }> | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) {
    return null;
  }
  const items: Array<{ id: string; expectedVersion: string }> = [];
  const seen = new Set<string>();
  for (const valueItem of value) {
    const item = exactRecord(valueItem, ["id", "expectedVersion"]);
    const id = uuid(item?.["id"]);
    const expectedVersion = exactIso(item?.["expectedVersion"]);
    if (!item || !id || !expectedVersion || seen.has(id)) return null;
    seen.add(id);
    items.push({ id, expectedVersion });
  }
  return items;
}

function withOptional(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): Record<string, unknown> {
  if (value !== undefined) target[key] = value;
  return target;
}

export function isAgentActionType(value: unknown): value is AgentActionType {
  return (
    typeof value === "string" &&
    (AGENT_ACTION_TYPES as readonly string[]).includes(value)
  );
}

export function isAgentVersionedAction(actionType: AgentActionType): boolean {
  return (AGENT_VERSIONED_ACTIONS as readonly string[]).includes(actionType);
}

export function isAgentActionId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID_PATTERN.test(value);
}

export function isAgentIdempotencyKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 16 &&
    value.length <= 160 &&
    SAFE_ID_PATTERN.test(value)
  );
}

export function isExactAgentRecordVersion(value: unknown): value is string {
  return exactIso(value) !== null;
}

export function parseAgentActionApprovalProof(
  value: unknown,
): AgentActionApprovalProof | null {
  const proof = exactRecord(value, [
    "approvalId",
    "approvalToken",
    "expiresAt",
  ]);
  const approvalId = uuid(proof?.["approvalId"]);
  const approvalToken = uuid(proof?.["approvalToken"]);
  const expiresAt = exactIso(proof?.["expiresAt"]);
  return approvalId && approvalToken && expiresAt
    ? { approvalId, approvalToken, expiresAt }
    : null;
}

export function parseAgentActionPayload(
  actionType: AgentActionType,
  value: unknown,
): AgentActionPayloadParseResult {
  switch (actionType) {
    case "create_contact": {
      const input = exactRecord(value, [
        "contactName",
        "addressLine1",
        "addressLine2",
        "city",
        "state",
        "postalCode",
        "phone",
        "email",
      ]);
      if (!input) return failure("Use only the displayed contact fields.");
      const contactName = trimmedString(input["contactName"], { maximum: 120 });
      const addressLine1 = trimmedString(input["addressLine1"], {
        maximum: 160,
      });
      const city = trimmedString(input["city"], { maximum: 100 });
      const state = trimmedString(input["state"], {
        minimum: 2,
        maximum: 2,
        pattern: /^[A-Za-z]{2}$/u,
      });
      const postalCode = trimmedString(input["postalCode"], {
        maximum: 16,
        pattern: /^[A-Za-z0-9][A-Za-z0-9 -]*$/u,
      });
      const addressLine2 = optionalString(input["addressLine2"], 120);
      const phone = optionalString(input["phone"], 32);
      const email = optionalString(input["email"], 254);
      if (
        !contactName ||
        !addressLine1 ||
        !city ||
        !state ||
        !postalCode ||
        addressLine2 === null ||
        phone === null ||
        email === null
      ) {
        return failure("One or more contact fields are invalid.");
      }
      return {
        ok: true,
        payload: withOptional(
          withOptional(
            withOptional(
              {
                contactName,
                addressLine1,
                city,
                state: state.toUpperCase(),
                postalCode,
              },
              "addressLine2",
              addressLine2,
            ),
            "phone",
            phone,
          ),
          "email",
          email,
        ),
      };
    }
    case "create_quote": {
      const input = exactRecord(value, [
        "contactId",
        "propertyId",
        "services",
        "notes",
        "appointmentId",
        "zoneId",
      ]);
      if (!input) return failure("Use only the displayed quote fields.");
      const contactId = uuid(input["contactId"]);
      const propertyId = uuid(input["propertyId"]);
      const services = stringList(input["services"], {
        minimum: 1,
        maximum: 10,
        itemMaximum: 80,
      });
      const notes = optionalString(input["notes"], 4_000);
      const appointmentId = optionalUuid(input["appointmentId"]);
      const zoneId = optionalString(input["zoneId"], 100);
      if (
        !contactId ||
        !propertyId ||
        !services ||
        notes === null ||
        appointmentId === null ||
        zoneId === null
      ) {
        return failure("One or more quote fields are invalid.");
      }
      return {
        ok: true,
        payload: withOptional(
          withOptional(
            withOptional({ contactId, propertyId, services }, "notes", notes),
            "appointmentId",
            appointmentId,
          ),
          "zoneId",
          zoneId,
        ),
      };
    }
    case "create_task": {
      const input = exactRecord(value, ["appointmentId", "title", "note"]);
      const appointmentId = uuid(input?.["appointmentId"]);
      const title = trimmedString(input?.["title"], { maximum: 500 });
      const note = optionalString(input?.["note"], 2_000);
      if (!input || !appointmentId || !title || note === null) {
        return failure("The appointment task fields are invalid.");
      }
      return {
        ok: true,
        payload: withOptional({ appointmentId, title }, "note", note),
      };
    }
    case "add_contact_note": {
      const input = exactRecord(value, ["contactId", "body"]);
      const contactId = uuid(input?.["contactId"]);
      const body = trimmedString(input?.["body"], { maximum: 4_000 });
      return input && contactId && body
        ? { ok: true, payload: { contactId, body } }
        : failure("The contact note fields are invalid.");
    }
    case "create_reminder": {
      const input = exactRecord(value, [
        "contactId",
        "title",
        "dueAt",
        "notes",
        "assignedTo",
      ]);
      const contactId = uuid(input?.["contactId"]);
      const title = trimmedString(input?.["title"], { maximum: 200 });
      const dueAt = exactIso(input?.["dueAt"]);
      const notes = optionalString(input?.["notes"], 4_000);
      const assignedTo = optionalUuid(input?.["assignedTo"]);
      if (
        !input ||
        !contactId ||
        !title ||
        !dueAt ||
        notes === null ||
        assignedTo === null
      ) {
        return failure("The reminder fields are invalid.");
      }
      return {
        ok: true,
        payload: withOptional(
          withOptional({ contactId, title, dueAt }, "notes", notes),
          "assignedTo",
          assignedTo,
        ),
      };
    }
    case "book_appointment": {
      const input = exactRecord(value, [
        "contactId",
        "propertyId",
        "startAt",
        "durationMinutes",
        "travelBufferMinutes",
        "services",
        "note",
        "quotedTotalCents",
      ]);
      const contactId = uuid(input?.["contactId"]);
      const propertyId = optionalUuid(input?.["propertyId"]);
      const startAt = exactIso(input?.["startAt"]);
      const durationMinutes = optionalInteger(
        input?.["durationMinutes"],
        15,
        720,
      );
      const travelBufferMinutes = optionalInteger(
        input?.["travelBufferMinutes"],
        0,
        240,
      );
      const services =
        input?.["services"] === undefined
          ? undefined
          : stringList(input["services"], {
              minimum: 1,
              maximum: 10,
              itemMaximum: 80,
            });
      const note = optionalString(input?.["note"], 4_000);
      const quotedTotalCents = optionalInteger(
        input?.["quotedTotalCents"],
        0,
        100_000_000,
      );
      if (
        !input ||
        !contactId ||
        !startAt ||
        propertyId === null ||
        durationMinutes === null ||
        travelBufferMinutes === null ||
        services === null ||
        note === null ||
        quotedTotalCents === null
      ) {
        return failure("The booking fields are invalid.");
      }
      let payload: AgentActionPayload = { contactId, startAt };
      payload = withOptional(payload, "propertyId", propertyId);
      payload = withOptional(payload, "durationMinutes", durationMinutes);
      payload = withOptional(
        payload,
        "travelBufferMinutes",
        travelBufferMinutes,
      );
      payload = withOptional(payload, "services", services);
      payload = withOptional(payload, "note", note);
      payload = withOptional(payload, "quotedTotalCents", quotedTotalCents);
      return { ok: true, payload };
    }
    case "cancel_appointment": {
      const input = exactRecord(value, ["appointmentId", "expectedVersion"]);
      const appointmentId = uuid(input?.["appointmentId"]);
      const expectedVersion = exactIso(input?.["expectedVersion"]);
      return input && appointmentId && expectedVersion
        ? { ok: true, payload: { appointmentId, expectedVersion } }
        : failure("The exact appointment and current version are required.");
    }
    case "reschedule_appointment": {
      const input = exactRecord(value, [
        "appointmentId",
        "expectedVersion",
        "startAt",
        "durationMinutes",
        "travelBufferMinutes",
      ]);
      const appointmentId = uuid(input?.["appointmentId"]);
      const expectedVersion = exactIso(input?.["expectedVersion"]);
      const startAt = exactIso(input?.["startAt"]);
      const durationMinutes = optionalInteger(
        input?.["durationMinutes"],
        15,
        720,
      );
      const travelBufferMinutes = optionalInteger(
        input?.["travelBufferMinutes"],
        0,
        240,
      );
      if (
        !input ||
        !appointmentId ||
        !expectedVersion ||
        !startAt ||
        durationMinutes === null ||
        travelBufferMinutes === null
      ) {
        return failure("The reschedule fields or current version are invalid.");
      }
      let payload: AgentActionPayload = {
        appointmentId,
        expectedVersion,
        startAt,
      };
      payload = withOptional(payload, "durationMinutes", durationMinutes);
      payload = withOptional(
        payload,
        "travelBufferMinutes",
        travelBufferMinutes,
      );
      return { ok: true, payload };
    }
    case "send_text": {
      const input = exactRecord(value, ["contactId", "body", "channel"]);
      const contactId = uuid(input?.["contactId"]);
      const body = trimmedString(input?.["body"], { maximum: 1_600 });
      const channel = input?.["channel"] ?? "sms";
      return input && contactId && body && channel === "sms"
        ? { ok: true, payload: { contactId, body, channel: "sms" } }
        : failure("The SMS fields are invalid or exceed the safe limit.");
    }
    case "google_ads_recommendations_bulk_update": {
      const input = exactRecord(value, [
        "items",
        "status",
        "confirmation",
        "note",
      ]);
      const items = versionedItems(input?.["items"], 20);
      const status = input?.["status"];
      const confirmation = input?.["confirmation"];
      const note = optionalString(input?.["note"], 1_000);
      if (
        !input ||
        !items ||
        (status !== "approved" &&
          status !== "ignored" &&
          status !== "proposed") ||
        confirmation !==
          (status === "approved"
            ? "approve"
            : status === "ignored"
              ? "ignore"
              : "reset") ||
        note === null
      ) {
        return failure("The Google Ads review fields are invalid.");
      }
      return {
        ok: true,
        payload: withOptional({ items, status, confirmation }, "note", note),
      };
    }
    case "google_ads_recommendations_bulk_apply": {
      const input = exactRecord(value, ["items", "confirmation"]);
      const items = versionedItems(input?.["items"], 20);
      return input &&
        items &&
        input["confirmation"] === "apply_google_ads_changes"
        ? {
            ok: true,
            payload: {
              items,
              confirmation: "apply_google_ads_changes",
            },
          }
        : failure("The Google Ads apply fields are invalid.");
    }
  }
}

function canonicalize(value: unknown, ancestors: Set<object>): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Non-finite Agent value");
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError("Cyclic Agent value");
    const next = new Set(ancestors).add(value);
    return value.map((item) => canonicalize(item, next));
  }
  if (typeof value === "object" && value !== null) {
    if (ancestors.has(value)) throw new TypeError("Cyclic Agent value");
    const next = new Set(ancestors).add(value);
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) output[key] = canonicalize(item, next);
    }
    return output;
  }
  throw new TypeError("Unsupported Agent value");
}

export function canonicalAgentActionJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, new Set()));
}

function describeTask(
  data: Record<string, unknown>,
  field: "task" | "reminder",
  entityType: "appointment_task" | "crm_task",
): AgentActionResultDescriptor | null {
  const task = record(data[field]);
  const entityId = uuid(task?.["id"]);
  const version = exactIso(task?.["updatedAt"]);
  return task && entityId && version
    ? { result: data, entityType, entityId, version }
    : null;
}

export function describeAgentOperationalResult(
  actionType: AgentActionType,
  value: unknown,
): AgentActionResultDescriptor | null {
  const data = record(value);
  if (!data) return null;
  switch (actionType) {
    case "create_contact": {
      const entityId = uuid(data["contactId"]);
      const propertyId = uuid(data["propertyId"]);
      const version = exactIso(data["version"]);
      return data["ok"] === true && entityId && propertyId && version
        ? { result: data, entityType: "contact", entityId, version }
        : null;
    }
    case "create_quote": {
      const entityId = uuid(data["quoteId"]);
      const version = exactIso(data["version"]);
      return data["ok"] === true && entityId && version
        ? { result: data, entityType: "quote", entityId, version }
        : null;
    }
    case "create_task":
      return describeTask(data, "task", "appointment_task");
    case "add_contact_note":
      return describeTask(data, "task", "crm_task");
    case "create_reminder":
      return describeTask(data, "reminder", "crm_task");
    case "book_appointment": {
      const entityId = uuid(data["appointmentId"]);
      const version = exactIso(data["version"]);
      return data["ok"] === true && entityId && version
        ? { result: data, entityType: "appointment", entityId, version }
        : null;
    }
    case "cancel_appointment":
    case "reschedule_appointment": {
      const entityId = uuid(data["appointmentId"]);
      const version = exactIso(data["version"]);
      return entityId && version
        ? { result: data, entityType: "appointment", entityId, version }
        : null;
    }
    case "send_text": {
      const message = record(data["message"]);
      const entityId = uuid(message?.["id"]);
      const threadId = uuid(message?.["threadId"] ?? data["threadId"]);
      const version = exactIso(message?.["createdAt"] ?? data["version"]);
      return message &&
        entityId &&
        threadId &&
        version &&
        message["deliveryStatus"] === "queued"
        ? {
            result: { ...data, threadId },
            entityType: "conversation_message",
            entityId,
            version,
          }
        : null;
    }
    case "google_ads_recommendations_bulk_update":
    case "google_ads_recommendations_bulk_apply":
      return null;
  }
}

function parseReceipt(value: unknown): AgentOperationalReceipt | null {
  const receipt = exactRecord(value, [
    "operationId",
    "correlationId",
    "actorId",
    "committedAt",
    "auditEventId",
    "entityType",
    "entityId",
    "version",
    "providerOperationId",
  ]);
  if (!receipt) return null;
  const operationId = uuid(receipt["operationId"]);
  const correlationId = trimmedString(receipt["correlationId"], {
    maximum: 128,
  });
  const actorId = uuid(receipt["actorId"]);
  const committedAt = exactIso(receipt["committedAt"]);
  const auditEventId = uuid(receipt["auditEventId"]);
  const entityType = trimmedString(receipt["entityType"], {
    maximum: 100,
    pattern: /^[a-z][a-z0-9_]*$/u,
  });
  const entityId = uuid(receipt["entityId"]);
  const version = exactIso(receipt["version"]);
  const providerOperationId = optionalString(
    receipt["providerOperationId"],
    200,
  );
  if (
    !operationId ||
    !correlationId ||
    !actorId ||
    !committedAt ||
    !auditEventId ||
    !entityType ||
    !entityId ||
    !version ||
    providerOperationId === null
  ) {
    return null;
  }
  return {
    operationId,
    correlationId,
    actorId,
    committedAt,
    auditEventId,
    entityType,
    entityId,
    version,
    ...(providerOperationId ? { providerOperationId } : {}),
  };
}

export function parseAgentOperationalMutationResult(
  actionType: AgentActionType,
  value: unknown,
  expected: {
    actorId: string;
    targetEntityId?: string | null;
    expectedVersion?: string | null;
  },
): AgentOperationalMutationResult | null {
  const envelope = record(value);
  if (!envelope) return null;
  if (envelope["ok"] === false) {
    const exact = exactRecord(envelope, [
      "ok",
      "code",
      "message",
      "retryable",
      "fieldErrors",
    ]);
    const code = exact?.["code"];
    const message = trimmedString(exact?.["message"], { maximum: 2_000 });
    const retryable = exact?.["retryable"];
    const rawFieldErrors = exact?.["fieldErrors"];
    const parsedFieldErrors: Record<string, string> = {};
    if (rawFieldErrors !== undefined) {
      const fields = record(rawFieldErrors);
      if (!fields || Object.keys(fields).length > 20) return null;
      for (const [key, item] of Object.entries(fields)) {
        const field = trimmedString(key, { maximum: 80 });
        const detail = trimmedString(item, { maximum: 500 });
        if (!field || !detail) return null;
        parsedFieldErrors[field] = detail;
      }
    }
    return exact &&
      typeof code === "string" &&
      MUTATION_ERROR_CODES.has(code as MutationErrorCode) &&
      message &&
      typeof retryable === "boolean"
      ? {
          ok: false,
          code: code as MutationErrorCode,
          message,
          retryable,
          ...(Object.keys(parsedFieldErrors).length
            ? { fieldErrors: parsedFieldErrors }
            : {}),
        }
      : null;
  }
  const exact = exactRecord(envelope, ["ok", "data", "receipt"]);
  const data = record(exact?.["data"]);
  const receipt = parseReceipt(exact?.["receipt"]);
  if (!exact || exact["ok"] !== true || !data || !receipt) return null;
  const descriptor = describeAgentOperationalResult(actionType, data);
  const googleAction =
    actionType === "google_ads_recommendations_bulk_update" ||
    actionType === "google_ads_recommendations_bulk_apply";
  const normalizedDescriptor = googleAction
    ? receipt.entityType === "google_ads_analyst_recommendation_batch" &&
      receipt.entityId &&
      isExactAgentRecordVersion(receipt.version)
      ? {
          result: data,
          entityType: receipt.entityType,
          entityId: receipt.entityId,
          version: receipt.version,
          ...(receipt.providerOperationId
            ? { providerOperationId: receipt.providerOperationId }
            : {}),
        }
      : null
    : descriptor;
  if (
    !normalizedDescriptor ||
    receipt.actorId !== expected.actorId ||
    receipt.entityType !== normalizedDescriptor.entityType ||
    receipt.entityId !== normalizedDescriptor.entityId ||
    receipt.version !== normalizedDescriptor.version ||
    (expected.targetEntityId && receipt.entityId !== expected.targetEntityId) ||
    (expected.expectedVersion &&
      (!isExactAgentRecordVersion(expected.expectedVersion) ||
        Date.parse(normalizedDescriptor.version) <
          Date.parse(expected.expectedVersion)))
  ) {
    return null;
  }
  return {
    ok: true,
    data: normalizedDescriptor.result,
    receipt,
    descriptor: normalizedDescriptor,
  };
}
