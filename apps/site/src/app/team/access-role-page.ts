import {
  isAssignableTeamPermission,
  TEAM_OWNER_ONLY_PERMISSION_CATALOG,
} from "@myst-os/sdk";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type AccessRoleRecord = {
  id: string;
  name: string;
  slug: string;
  permissions: string[];
  createdAt: string;
  updatedAt: string;
};

export type AccessRoleUpdateMutationResult =
  | {
      ok: true;
      data: {
        role: AccessRoleRecord;
        assignedMemberCount: number;
        revokedSessionCount: number;
      };
      receipt: {
        operationId: string;
        correlationId: string;
        actorId: string;
        committedAt: string;
        auditEventId: string;
        entityType: "team_role";
        entityId: string;
        version: string;
      };
    }
  | {
      ok: false;
      code:
        | "unauthorized"
        | "forbidden"
        | "conflict"
        | "invalid"
        | "rate_limited"
        | "timeout"
        | "provider_failed"
        | "internal";
      message: string;
      retryable: boolean;
      fieldErrors?: Record<string, string>;
    };

const MUTATION_ERROR_CODES = new Set([
  "unauthorized",
  "forbidden",
  "conflict",
  "invalid",
  "rate_limited",
  "timeout",
  "provider_failed",
  "internal",
]);
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const ACCESS_ROLE_MUTATION_MAXIMUM_BYTES = 32 * 1024;
const ACCESS_ROLE_MUTATION_BODY_DEADLINE_MS = 5_000;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length && expected.every((key) => key in value)
  );
}

function exactInstant(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 40) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function parseRole(value: unknown): AccessRoleRecord | null {
  const role = record(value);
  if (
    !role ||
    !exactKeys(role, [
      "createdAt",
      "id",
      "name",
      "permissions",
      "slug",
      "updatedAt",
    ]) ||
    typeof role["id"] !== "string" ||
    !UUID_PATTERN.test(role["id"]) ||
    typeof role["name"] !== "string" ||
    role["name"].trim().length < 1 ||
    role["name"].length > 120 ||
    typeof role["slug"] !== "string" ||
    role["slug"].trim().length < 1 ||
    role["slug"].length > 64 ||
    !Array.isArray(role["permissions"]) ||
    role["permissions"].length > 100 ||
    role["permissions"].some(
      (permission) =>
        typeof permission !== "string" ||
        permission.length < 1 ||
        permission.length > 100,
    ) ||
    new Set(role["permissions"]).size !== role["permissions"].length ||
    !exactInstant(role["createdAt"]) ||
    !exactInstant(role["updatedAt"]) ||
    new Date(role["updatedAt"]).getTime() <
      new Date(role["createdAt"]).getTime()
  ) {
    return null;
  }
  return role as AccessRoleRecord;
}

export function parseAccessRolesPayload(
  value: unknown,
): AccessRoleRecord[] | null {
  const payload = record(value);
  if (
    !payload ||
    !exactKeys(payload, ["roles"]) ||
    !Array.isArray(payload["roles"])
  ) {
    return null;
  }
  const roles = payload["roles"].map(parseRole);
  if (roles.some((role) => role === null)) return null;
  const typed = roles as AccessRoleRecord[];
  if (new Set(typed.map((role) => role.id)).size !== typed.length) return null;
  return typed;
}

function safeMutationMessage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const message = value.trim();
  const unsafeControl = Array.from(message).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint <= 8 ||
      codePoint === 11 ||
      codePoint === 12 ||
      (codePoint >= 14 && codePoint <= 31) ||
      codePoint === 127
    );
  });
  if (message.length < 1 || message.length > 1_000 || unsafeControl) {
    return null;
  }
  return message;
}

function parseFieldErrors(value: unknown): Record<string, string> | null {
  const fields = record(value);
  if (!fields || Object.keys(fields).length > 20) return null;
  const parsed: Record<string, string> = {};
  for (const [key, rawMessage] of Object.entries(fields)) {
    const message = safeMutationMessage(rawMessage);
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/u.test(key) || !message) return null;
    parsed[key] = message;
  }
  return parsed;
}

export async function readBoundedAccessRoleMutationPayload(
  response: Response,
): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!/^application\/json(?:\s*;|$)/u.test(contentType)) {
    void response.body?.cancel().catch(() => undefined);
    return null;
  }
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d{1,10}$/u.test(declared) ||
      Number(declared) > ACCESS_ROLE_MUTATION_MAXIMUM_BYTES)
  ) {
    void response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  const deadlineAt = Date.now() + ACCESS_ROLE_MUTATION_BODY_DEADLINE_MS;
  let total = 0;
  try {
    while (true) {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) return null;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const next = await Promise.race([
        reader.read(),
        new Promise<"timeout">((resolve) => {
          timeout = setTimeout(() => resolve("timeout"), remaining);
        }),
      ]).finally(() => {
        if (timeout) clearTimeout(timeout);
      });
      if (next === "timeout") return null;
      if (next.done) break;
      total += next.value.byteLength;
      if (total > ACCESS_ROLE_MUTATION_MAXIMUM_BYTES) return null;
      chunks.push(next.value);
    }
  } catch {
    return null;
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export function parseAccessRoleUpdateMutationResult(
  value: unknown,
  headers: Headers,
  expected: {
    id: string;
    name: string;
    slug: string;
    permissions: readonly string[];
    expectedUpdatedAt: string;
    actorId: string;
  },
): AccessRoleUpdateMutationResult | null {
  const payload = record(value);
  if (!payload || typeof payload["ok"] !== "boolean") return null;
  if (payload["ok"] === false) {
    const hasFields = Object.prototype.hasOwnProperty.call(
      payload,
      "fieldErrors",
    );
    if (
      !exactKeys(
        payload,
        hasFields
          ? ["code", "fieldErrors", "message", "ok", "retryable"]
          : ["code", "message", "ok", "retryable"],
      ) ||
      typeof payload["code"] !== "string" ||
      !MUTATION_ERROR_CODES.has(payload["code"]) ||
      typeof payload["retryable"] !== "boolean"
    ) {
      return null;
    }
    const message = safeMutationMessage(payload["message"]);
    const fieldErrors = hasFields
      ? parseFieldErrors(payload["fieldErrors"])
      : undefined;
    if (!message || (hasFields && !fieldErrors)) return null;
    return {
      ok: false,
      code: payload["code"] as Extract<
        AccessRoleUpdateMutationResult,
        { ok: false }
      >["code"],
      message,
      retryable: payload["retryable"],
      ...(fieldErrors ? { fieldErrors } : {}),
    };
  }

  if (!exactKeys(payload, ["data", "ok", "receipt"])) return null;
  const data = record(payload["data"]);
  const receipt = record(payload["receipt"]);
  if (
    !data ||
    !exactKeys(data, ["assignedMemberCount", "revokedSessionCount", "role"]) ||
    !Number.isSafeInteger(data["assignedMemberCount"]) ||
    Number(data["assignedMemberCount"]) < 0 ||
    Number(data["assignedMemberCount"]) > 1_000_000 ||
    !Number.isSafeInteger(data["revokedSessionCount"]) ||
    Number(data["revokedSessionCount"]) < 0 ||
    Number(data["revokedSessionCount"]) > 10_000_000 ||
    !receipt ||
    !exactKeys(receipt, [
      "actorId",
      "auditEventId",
      "committedAt",
      "correlationId",
      "entityId",
      "entityType",
      "operationId",
      "version",
    ])
  ) {
    return null;
  }

  const role = parseRole(data["role"]);
  if (!role) return null;
  const expectedPermissions = [...expected.permissions].sort();
  const actualPermissions = [...role.permissions].sort();
  const correlationId = receipt["correlationId"];
  const headerCorrelation = headers.get("x-correlation-id") ?? "";
  if (
    role.id !== expected.id ||
    role.name !== expected.name ||
    role.slug !== expected.slug ||
    expectedPermissions.length !== actualPermissions.length ||
    expectedPermissions.some(
      (permission, index) => actualPermissions[index] !== permission,
    ) ||
    role.permissions.some(
      (permission) =>
        !isAssignableTeamPermission(permission) &&
        !(
          role.slug.toLowerCase() === "owner" &&
          TEAM_OWNER_ONLY_PERMISSION_CATALOG.includes(
            permission as (typeof TEAM_OWNER_ONLY_PERMISSION_CATALOG)[number],
          )
        ),
    ) ||
    new Date(role.updatedAt).getTime() <=
      new Date(expected.expectedUpdatedAt).getTime() ||
    typeof receipt["operationId"] !== "string" ||
    !UUID_PATTERN.test(receipt["operationId"]) ||
    typeof correlationId !== "string" ||
    !CORRELATION_ID_PATTERN.test(correlationId) ||
    headerCorrelation !== correlationId ||
    receipt["actorId"] !== expected.actorId ||
    typeof receipt["auditEventId"] !== "string" ||
    !UUID_PATTERN.test(receipt["auditEventId"]) ||
    receipt["entityType"] !== "team_role" ||
    receipt["entityId"] !== expected.id ||
    receipt["version"] !== role.updatedAt ||
    receipt["committedAt"] !== role.updatedAt ||
    !exactInstant(receipt["committedAt"])
  ) {
    return null;
  }

  return {
    ok: true,
    data: {
      role,
      assignedMemberCount: Number(data["assignedMemberCount"]),
      revokedSessionCount: Number(data["revokedSessionCount"]),
    },
    receipt: {
      operationId: receipt["operationId"],
      correlationId,
      actorId: expected.actorId,
      committedAt: receipt["committedAt"],
      auditEventId: receipt["auditEventId"],
      entityType: "team_role",
      entityId: expected.id,
      version: role.updatedAt,
    },
  };
}
