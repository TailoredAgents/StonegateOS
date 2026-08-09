import {
  PIPELINE_STAGES,
  type PipelineStage,
} from "./components/pipeline.stages";
import type { PipelineView } from "./components/pipeline.types";

export const PIPELINE_FILTER_PRESET_LIMIT = 12;
export const PIPELINE_MOVEMENT_LIMIT = 10;

export type PipelineFilterPreset = {
  id: string;
  name: string;
  q: string;
  stage: PipelineStage | null;
  excludeOutbound: boolean;
  view: PipelineView;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type PipelineMovement = {
  id: string;
  actorLabel: string;
  occurredAt: string;
  fromStage: PipelineStage | null;
  toStage: PipelineStage;
  source: "manual" | "automation";
  sourceLabel: string;
};

export type PipelinePresetInventoryState =
  | {
      status: "ready";
      presets: PipelineFilterPreset[];
      limit: number;
    }
  | { status: "error"; message: string };

export type PipelineMovementState =
  | { status: "ready"; movements: PipelineMovement[] }
  | { status: "error"; message: string };

type MutationError = {
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

export type PipelinePresetCreateResult =
  | {
      ok: true;
      data: { preset: PipelineFilterPreset };
      receipt: MutationReceipt;
    }
  | MutationError;

export type PipelinePresetDeleteResult =
  | {
      ok: true;
      data: { deletedPresetId: string };
      receipt: MutationReceipt;
    }
  | MutationError;

type MutationReceipt = {
  operationId: string;
  correlationId: string;
  actorId: string;
  committedAt: string;
  auditEventId: string;
  entityType: "team_pipeline_filter_preset";
  entityId: string;
  version: string;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CORRELATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const ERROR_CODES = new Set([
  "unauthorized",
  "forbidden",
  "conflict",
  "invalid",
  "rate_limited",
  "timeout",
  "provider_failed",
  "internal",
]);
const STAGES = new Set<string>(PIPELINE_STAGES);
const MAXIMUM_MUTATION_RESPONSE_BYTES = 32 * 1024;
const MUTATION_RESPONSE_DEADLINE_MS = 5_000;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    keys.length === sortedExpected.length &&
    sortedExpected.every((key, index) => keys[index] === key)
  );
}

function exactInstant(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 40) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function safeText(
  value: unknown,
  options: { minimum?: number; maximum: number },
): value is string {
  if (typeof value !== "string") return false;
  if (
    value.length < (options.minimum ?? 1) ||
    value.length > options.maximum ||
    value !== value.normalize("NFKC")
  ) {
    return false;
  }
  return !Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint <= 31 ||
      codePoint === 127 ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    );
  });
}

function parsePreset(value: unknown): PipelineFilterPreset | null {
  const preset = record(value);
  if (
    !preset ||
    !exactKeys(preset, [
      "createdAt",
      "excludeOutbound",
      "id",
      "name",
      "q",
      "stage",
      "updatedAt",
      "version",
      "view",
    ]) ||
    typeof preset["id"] !== "string" ||
    !UUID_PATTERN.test(preset["id"]) ||
    !safeText(preset["name"], { maximum: 60 }) ||
    !safeText(preset["q"], { minimum: 0, maximum: 120 }) ||
    (preset["stage"] !== null &&
      (typeof preset["stage"] !== "string" || !STAGES.has(preset["stage"]))) ||
    typeof preset["excludeOutbound"] !== "boolean" ||
    (preset["view"] !== "board" && preset["view"] !== "list") ||
    !Number.isSafeInteger(preset["version"]) ||
    Number(preset["version"]) < 1 ||
    !exactInstant(preset["createdAt"]) ||
    !exactInstant(preset["updatedAt"]) ||
    Date.parse(preset["updatedAt"]) < Date.parse(preset["createdAt"])
  ) {
    return null;
  }
  return preset as PipelineFilterPreset;
}

export function parsePipelineFilterPresetInventory(value: unknown): {
  presets: PipelineFilterPreset[];
  limit: number;
} | null {
  const payload = record(value);
  if (
    !payload ||
    !exactKeys(payload, ["limit", "presets"]) ||
    payload["limit"] !== PIPELINE_FILTER_PRESET_LIMIT ||
    !Array.isArray(payload["presets"]) ||
    payload["presets"].length > PIPELINE_FILTER_PRESET_LIMIT
  ) {
    return null;
  }
  const presets = payload["presets"].map(parsePreset);
  if (presets.some((preset) => preset === null)) return null;
  const complete = presets as PipelineFilterPreset[];
  if (
    new Set(complete.map((preset) => preset.id)).size !== complete.length ||
    new Set(complete.map((preset) => preset.name.toLowerCase())).size !==
      complete.length
  ) {
    return null;
  }
  return { presets: complete, limit: PIPELINE_FILTER_PRESET_LIMIT };
}

function parseMovement(value: unknown): PipelineMovement | null {
  const movement = record(value);
  if (
    !movement ||
    !exactKeys(movement, [
      "actorLabel",
      "fromStage",
      "id",
      "occurredAt",
      "source",
      "sourceLabel",
      "toStage",
    ]) ||
    !safeText(movement["id"], { maximum: 80 }) ||
    !/^(?:audit|automation):[0-9a-f-]{36}$/iu.test(movement["id"]) ||
    !safeText(movement["actorLabel"], { maximum: 80 }) ||
    !safeText(movement["sourceLabel"], { maximum: 48 }) ||
    !exactInstant(movement["occurredAt"]) ||
    (movement["fromStage"] !== null &&
      (typeof movement["fromStage"] !== "string" ||
        !STAGES.has(movement["fromStage"]))) ||
    typeof movement["toStage"] !== "string" ||
    !STAGES.has(movement["toStage"]) ||
    (movement["source"] !== "manual" && movement["source"] !== "automation")
  ) {
    return null;
  }
  return movement as PipelineMovement;
}

export function parsePipelineMovements(value: unknown): {
  movements: PipelineMovement[];
  limit: number;
} | null {
  const payload = record(value);
  if (
    !payload ||
    !exactKeys(payload, ["limit", "movements"]) ||
    payload["limit"] !== PIPELINE_MOVEMENT_LIMIT ||
    !Array.isArray(payload["movements"]) ||
    payload["movements"].length > PIPELINE_MOVEMENT_LIMIT
  ) {
    return null;
  }
  const movements = payload["movements"].map(parseMovement);
  if (movements.some((movement) => movement === null)) return null;
  const complete = movements as PipelineMovement[];
  if (
    new Set(complete.map((movement) => movement.id)).size !== complete.length
  ) {
    return null;
  }
  for (let index = 1; index < complete.length; index += 1) {
    if (
      Date.parse(complete[index - 1]!.occurredAt) <
      Date.parse(complete[index]!.occurredAt)
    ) {
      return null;
    }
  }
  return { movements: complete, limit: PIPELINE_MOVEMENT_LIMIT };
}

function parseMutationError(
  payload: Record<string, unknown>,
): MutationError | null {
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
    payload["ok"] !== false ||
    typeof payload["code"] !== "string" ||
    !ERROR_CODES.has(payload["code"]) ||
    !safeText(payload["message"], { maximum: 1_000 }) ||
    typeof payload["retryable"] !== "boolean"
  ) {
    return null;
  }
  let fieldErrors: Record<string, string> | undefined;
  if (hasFields) {
    const fields = record(payload["fieldErrors"]);
    if (!fields || Object.keys(fields).length > 20) return null;
    fieldErrors = {};
    for (const [key, value] of Object.entries(fields)) {
      if (
        !/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/u.test(key) ||
        !safeText(value, { maximum: 1_000 })
      ) {
        return null;
      }
      fieldErrors[key] = value;
    }
  }
  return {
    ok: false,
    code: payload["code"] as MutationError["code"],
    message: payload["message"],
    retryable: payload["retryable"],
    ...(fieldErrors ? { fieldErrors } : {}),
  };
}

function parseReceipt(
  value: unknown,
  headers: Headers,
  expected: { actorId: string; entityId: string; version: string },
): MutationReceipt | null {
  const receipt = record(value);
  if (
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
    ]) ||
    typeof receipt["operationId"] !== "string" ||
    !UUID_PATTERN.test(receipt["operationId"]) ||
    typeof receipt["auditEventId"] !== "string" ||
    !UUID_PATTERN.test(receipt["auditEventId"]) ||
    typeof receipt["correlationId"] !== "string" ||
    !CORRELATION_PATTERN.test(receipt["correlationId"]) ||
    headers.get("x-correlation-id") !== receipt["correlationId"] ||
    receipt["actorId"] !== expected.actorId ||
    receipt["entityType"] !== "team_pipeline_filter_preset" ||
    receipt["entityId"] !== expected.entityId ||
    receipt["version"] !== expected.version ||
    !exactInstant(receipt["committedAt"])
  ) {
    return null;
  }
  return receipt as MutationReceipt;
}

export function parsePipelinePresetCreateResult(
  value: unknown,
  headers: Headers,
  expected: {
    actorId: string;
    name: string;
    q: string;
    stage: PipelineStage | null;
    excludeOutbound: boolean;
    view: PipelineView;
  },
): PipelinePresetCreateResult | null {
  const payload = record(value);
  if (!payload || typeof payload["ok"] !== "boolean") return null;
  if (payload["ok"] === false) return parseMutationError(payload);
  const data = record(payload["data"]);
  if (
    !exactKeys(payload, ["data", "ok", "receipt"]) ||
    !data ||
    !exactKeys(data, ["preset"])
  ) {
    return null;
  }
  const preset = parsePreset(data["preset"]);
  if (
    !preset ||
    preset.name !== expected.name ||
    preset.q !== expected.q ||
    preset.stage !== expected.stage ||
    preset.excludeOutbound !== expected.excludeOutbound ||
    preset.view !== expected.view
  ) {
    return null;
  }
  const receipt = parseReceipt(payload["receipt"], headers, {
    actorId: expected.actorId,
    entityId: preset.id,
    version: String(preset.version),
  });
  return receipt ? { ok: true, data: { preset }, receipt } : null;
}

export function parsePipelinePresetDeleteResult(
  value: unknown,
  headers: Headers,
  expected: { actorId: string; presetId: string; version: number },
): PipelinePresetDeleteResult | null {
  const payload = record(value);
  if (!payload || typeof payload["ok"] !== "boolean") return null;
  if (payload["ok"] === false) return parseMutationError(payload);
  const data = record(payload["data"]);
  if (
    !exactKeys(payload, ["data", "ok", "receipt"]) ||
    !data ||
    !exactKeys(data, ["deletedPresetId"]) ||
    data["deletedPresetId"] !== expected.presetId
  ) {
    return null;
  }
  const receipt = parseReceipt(payload["receipt"], headers, {
    actorId: expected.actorId,
    entityId: expected.presetId,
    version: String(expected.version),
  });
  return receipt
    ? {
        ok: true,
        data: { deletedPresetId: expected.presetId },
        receipt,
      }
    : null;
}

export async function readBoundedPipelinePresetMutationPayload(
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
      Number(declared) > MAXIMUM_MUTATION_RESPONSE_BYTES)
  ) {
    void response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return null;

  const reader = response.body.getReader();
  const deadlineAt = Date.now() + MUTATION_RESPONSE_DEADLINE_MS;
  const chunks: Uint8Array[] = [];
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
      if (total > MAXIMUM_MUTATION_RESPONSE_BYTES) return null;
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
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    return null;
  }
}
