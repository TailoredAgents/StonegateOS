const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
}

function exactIso(value: unknown): value is string {
  return (
    typeof value === "string" &&
    ISO_PATTERN.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function validReceipt(
  receipt: Record<string, unknown> | null,
  expected: {
    actorId: string;
    entityType: string;
    entityId?: string;
    version?: string;
  },
): boolean {
  if (
    !receipt ||
    typeof receipt["operationId"] !== "string" ||
    !UUID_PATTERN.test(receipt["operationId"]) ||
    typeof receipt["correlationId"] !== "string" ||
    receipt["correlationId"].trim().length < 8 ||
    receipt["actorId"] !== expected.actorId ||
    !exactIso(receipt["committedAt"]) ||
    typeof receipt["auditEventId"] !== "string" ||
    !UUID_PATTERN.test(receipt["auditEventId"]) ||
    receipt["entityType"] !== expected.entityType
  ) {
    return false;
  }
  if (
    expected.entityId !== undefined &&
    receipt["entityId"] !== expected.entityId
  ) {
    return false;
  }
  if (
    expected.version !== undefined &&
    receipt["version"] !== expected.version
  ) {
    return false;
  }
  return true;
}

function validMoved(value: unknown): value is Record<string, number> {
  const moved = record(value);
  return (
    moved !== null &&
    Object.keys(moved).length >= 1 &&
    Object.values(moved).every(
      (count) => Number.isSafeInteger(count) && Number(count) >= 0,
    )
  );
}

export type ParsedMergeSuccess = {
  sourceContactId: string;
  targetContactId: string;
  recoveryLedgerId: string;
  recoveryAssessmentPath: string;
  version: string;
};

export function parseContactMergeSuccess(
  value: unknown,
  expected: {
    actorId: string;
    sourceContactId: string;
    targetContactId: string;
    previewHash: string;
    suggestionId?: string;
  },
): ParsedMergeSuccess | null {
  const envelope = record(value);
  const data = record(envelope?.["data"]);
  const receipt = record(envelope?.["receipt"]);
  if (
    !envelope ||
    envelope["ok"] !== true ||
    !data ||
    data["merged"] !== true ||
    data["sourceContactId"] !== expected.sourceContactId ||
    data["targetContactId"] !== expected.targetContactId ||
    data["previewHash"] !== expected.previewHash ||
    typeof data["recoveryLedgerId"] !== "string" ||
    !UUID_PATTERN.test(data["recoveryLedgerId"]) ||
    data["recoveryAssessmentPath"] !==
      `/api/admin/merge-recovery/${data["recoveryLedgerId"]}/assessment` ||
    !exactIso(data["version"]) ||
    !validMoved(data["moved"])
  ) {
    return null;
  }
  if (expected.suggestionId !== undefined && data["status"] !== "approved") {
    return null;
  }
  if (
    !validReceipt(receipt, {
      actorId: expected.actorId,
      entityType: "contact_merge_recovery",
      entityId: data["recoveryLedgerId"],
      version: data["version"],
    })
  ) {
    return null;
  }
  return {
    sourceContactId: data["sourceContactId"],
    targetContactId: data["targetContactId"],
    recoveryLedgerId: data["recoveryLedgerId"],
    recoveryAssessmentPath: data["recoveryAssessmentPath"],
    version: data["version"],
  };
}

export function parseMergeDeclineSuccess(
  value: unknown,
  expected: { actorId: string; suggestionId: string },
): { version: string } | null {
  const envelope = record(value);
  const data = record(envelope?.["data"]);
  const receipt = record(envelope?.["receipt"]);
  if (
    !envelope ||
    envelope["ok"] !== true ||
    !data ||
    data["status"] !== "declined" ||
    data["merged"] !== false ||
    !exactIso(data["version"]) ||
    data["previewHash"] !== null ||
    data["recoveryLedgerId"] !== null ||
    data["recoveryAssessmentPath"] !== null ||
    !validReceipt(receipt, {
      actorId: expected.actorId,
      entityType: "merge_suggestion",
      entityId: expected.suggestionId,
      version: data["version"],
    })
  ) {
    return null;
  }
  return { version: data["version"] };
}

export function parseMergeScanSuccess(
  value: unknown,
  actorId: string,
): { scanned: number; created: number; skipped: number } | null {
  const envelope = record(value);
  const data = record(envelope?.["data"]);
  const receipt = record(envelope?.["receipt"]);
  if (
    !envelope ||
    envelope["ok"] !== true ||
    !data ||
    !exactKeys(data, ["created", "scanned", "skipped"]) ||
    ![data["created"], data["scanned"], data["skipped"]].every(
      (count) => Number.isSafeInteger(count) && Number(count) >= 0,
    ) ||
    !validReceipt(receipt, {
      actorId,
      entityType: "merge_suggestion_scan",
    })
  ) {
    return null;
  }
  return data as {
    scanned: number;
    created: number;
    skipped: number;
  };
}

export function isMergePreviewHash(value: unknown): value is string {
  return typeof value === "string" && HASH_PATTERN.test(value);
}
