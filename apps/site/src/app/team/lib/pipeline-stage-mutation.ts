import { readTeamMutationError } from "./mutation-feedback";

export const PIPELINE_ABSENT_VERSION = "pipeline:none";

const PIPELINE_STAGES = new Set([
  "new",
  "contacted",
  "in_person_quote",
  "qualified",
  "quoted",
  "won",
  "lost",
]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const EXACT_ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

const SUCCESS_KEYS = ["data", "ok", "receipt"] as const;
const DATA_KEYS = [
  "closedSalesTaskCount",
  "noOp",
  "noteTaskId",
  "pipeline",
] as const;
const PIPELINE_KEYS = ["contactId", "stage", "updatedAt", "version"] as const;
const RECEIPT_KEYS = [
  "actorId",
  "auditEventId",
  "committedAt",
  "correlationId",
  "entityId",
  "entityType",
  "operationId",
  "version",
] as const;

export type PipelineStageState = {
  contactId: string;
  stage: string;
  updatedAt: string | null;
  version: string;
};

export type PipelineStageMutationSuccess = {
  ok: true;
  data: {
    pipeline: PipelineStageState & { updatedAt: string };
    noteTaskId: string | null;
    closedSalesTaskCount: number;
    noOp: boolean;
  };
  receipt: {
    operationId: string;
    correlationId: string;
    actorId: string;
    committedAt: string;
    auditEventId: string;
    entityType: "crm_pipeline";
    entityId: string;
    version: string;
  };
};

export class PipelineStageRequestError extends Error {
  readonly status: number;
  readonly current: PipelineStageState | null;

  constructor(
    message: string,
    status: number,
    current: PipelineStageState | null,
  ) {
    super(message);
    this.name = "PipelineStageRequestError";
    this.status = status;
    this.current = current;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
}

function isExactIsoInstant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    EXACT_ISO_INSTANT_PATTERN.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

export function pipelineExpectedVersion(updatedAt: string | null): string {
  return updatedAt ?? PIPELINE_ABSENT_VERSION;
}

export function isPipelineStage(value: unknown): value is string {
  return typeof value === "string" && PIPELINE_STAGES.has(value);
}

export function isPipelineExpectedVersion(value: unknown): value is string {
  return value === PIPELINE_ABSENT_VERSION || isExactIsoInstant(value);
}

function parseState(
  value: unknown,
  allowAbsent: boolean,
): PipelineStageState | null {
  const state = record(value);
  if (
    !state ||
    !hasExactKeys(state, PIPELINE_KEYS) ||
    typeof state["contactId"] !== "string" ||
    !UUID_PATTERN.test(state["contactId"]) ||
    typeof state["stage"] !== "string" ||
    !PIPELINE_STAGES.has(state["stage"]) ||
    !isPipelineExpectedVersion(state["version"])
  ) {
    return null;
  }
  if (state["version"] === PIPELINE_ABSENT_VERSION) {
    if (
      !allowAbsent ||
      state["updatedAt"] !== null ||
      state["stage"] !== "new"
    ) {
      return null;
    }
  } else if (
    !isExactIsoInstant(state["updatedAt"]) ||
    state["updatedAt"] !== state["version"]
  ) {
    return null;
  }
  return state as PipelineStageState;
}

export function parsePipelineConflictState(
  value: unknown,
): PipelineStageState | null {
  const payload = record(value);
  return parseState(payload?.["current"], true);
}

export function parsePipelineStageMutationSuccess(
  value: unknown,
  expected: {
    actorId: string;
    contactId: string;
    stage: string;
    previousStage: string;
    submittedVersion: string;
  },
): PipelineStageMutationSuccess | null {
  const payload = record(value);
  const data = record(payload?.["data"]);
  const pipeline = parseState(data?.["pipeline"], false);
  const receipt = record(payload?.["receipt"]);
  if (
    !payload ||
    !hasExactKeys(payload, SUCCESS_KEYS) ||
    payload["ok"] !== true ||
    !data ||
    !hasExactKeys(data, DATA_KEYS) ||
    !pipeline ||
    pipeline.updatedAt === null ||
    pipeline.contactId !== expected.contactId ||
    pipeline.stage !== expected.stage ||
    !(
      data["noteTaskId"] === null ||
      (typeof data["noteTaskId"] === "string" &&
        UUID_PATTERN.test(data["noteTaskId"]))
    ) ||
    typeof data["closedSalesTaskCount"] !== "number" ||
    !Number.isSafeInteger(data["closedSalesTaskCount"]) ||
    data["closedSalesTaskCount"] < 0 ||
    typeof data["noOp"] !== "boolean" ||
    !receipt ||
    !hasExactKeys(receipt, RECEIPT_KEYS) ||
    typeof receipt["operationId"] !== "string" ||
    !UUID_PATTERN.test(receipt["operationId"]) ||
    typeof receipt["correlationId"] !== "string" ||
    !CORRELATION_ID_PATTERN.test(receipt["correlationId"]) ||
    receipt["actorId"] !== expected.actorId ||
    !isExactIsoInstant(receipt["committedAt"]) ||
    typeof receipt["auditEventId"] !== "string" ||
    !UUID_PATTERN.test(receipt["auditEventId"]) ||
    receipt["entityType"] !== "crm_pipeline" ||
    receipt["entityId"] !== expected.contactId ||
    receipt["version"] !== pipeline.version ||
    !isPipelineExpectedVersion(expected.submittedVersion)
  ) {
    return null;
  }

  if (expected.submittedVersion !== PIPELINE_ABSENT_VERSION) {
    const submittedTime = Date.parse(expected.submittedVersion);
    const committedVersionTime = Date.parse(pipeline.version);
    if (
      committedVersionTime < submittedTime ||
      (expected.stage !== expected.previousStage &&
        committedVersionTime <= submittedTime)
    ) {
      return null;
    }
  }
  if (data["noOp"] && expected.stage !== expected.previousStage) return null;
  return payload as PipelineStageMutationSuccess;
}

/**
 * Retries one lost or unreadable success response with the exact same caller
 * key, If-Match value, and payload supplied by the closure. The API's durable
 * idempotency record turns a committed first attempt into a safe replay.
 */
export async function requestPipelineStageMutation(
  request: () => Promise<Response>,
  expected: Parameters<typeof parsePipelineStageMutationSuccess>[1],
): Promise<PipelineStageMutationSuccess> {
  let lastTransportError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await request();
      const errorResponse = response.clone();
      const payload = (await response.json().catch(() => null)) as unknown;
      if (!response.ok) {
        throw new PipelineStageRequestError(
          await readTeamMutationError(
            errorResponse,
            "Unable to update the pipeline stage",
          ),
          response.status,
          response.status === 409 ? parsePipelineConflictState(payload) : null,
        );
      }
      const success = parsePipelineStageMutationSuccess(payload, expected);
      if (success) return success;
      if (attempt === 0) continue;
      throw new PipelineStageRequestError(
        "The service returned an unverified pipeline receipt. Refresh before retrying; no success is being claimed.",
        502,
        null,
      );
    } catch (error) {
      if (error instanceof PipelineStageRequestError) throw error;
      lastTransportError = error;
      if (attempt === 0) continue;
    }
  }
  throw new PipelineStageRequestError(
    lastTransportError instanceof Error &&
    lastTransportError.name === "AbortError"
      ? "The pipeline request timed out. Its result is not confirmed; refresh before retrying."
      : "The pipeline service could not be reached. Your previous stage has been restored; retry when the connection is available.",
    502,
    null,
  );
}
