import "server-only";
import { createHash } from "node:crypto";

export const MANUAL_CALL_ATTEMPT_COOKIE = "myst-team-call-attempts";
const MAX_ATTEMPTS = 12;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/u;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;

export type StoredManualCallAttemptState =
  | "pending"
  | "ambiguous"
  | "confirmed_not_sent";

export type StoredManualCallAttempt = {
  scopeHash: string;
  key: string;
  state: StoredManualCallAttemptState;
  updatedAt: number;
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function manualCallAttemptScope(
  contactId: string,
  taskId: string | null,
): string {
  return sha256(`contact:${contactId}:task:${taskId ?? "none"}`);
}

export function parseManualCallAttemptStore(
  raw: string | null | undefined,
  now = Date.now(),
): StoredManualCallAttempt[] {
  if (!raw || raw.length > 8_000) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value
      .filter((entry): entry is StoredManualCallAttempt => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          return false;
        }
        const row = entry as Record<string, unknown>;
        return (
          typeof row["scopeHash"] === "string" &&
          HASH_PATTERN.test(row["scopeHash"]) &&
          typeof row["key"] === "string" &&
          KEY_PATTERN.test(row["key"]) &&
          ["pending", "ambiguous", "confirmed_not_sent"].includes(
            typeof row["state"] === "string" ? row["state"] : "",
          ) &&
          typeof row["updatedAt"] === "number" &&
          Number.isSafeInteger(row["updatedAt"]) &&
          row["updatedAt"] > now - MAX_AGE_MS &&
          row["updatedAt"] <= now + 60_000
        );
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_ATTEMPTS);
  } catch {
    return [];
  }
}

export function findManualCallAttempt(
  attempts: readonly StoredManualCallAttempt[],
  scopeHash: string,
): StoredManualCallAttempt | null {
  return attempts.find((attempt) => attempt.scopeHash === scopeHash) ?? null;
}

export function storeManualCallAttempt(
  attempts: readonly StoredManualCallAttempt[],
  input: Omit<StoredManualCallAttempt, "updatedAt"> & { updatedAt?: number },
): string {
  const next = [
    { ...input, updatedAt: input.updatedAt ?? Date.now() },
    ...attempts.filter((attempt) => attempt.scopeHash !== input.scopeHash),
  ]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_ATTEMPTS);
  return JSON.stringify(next);
}

export function removeManualCallAttempt(
  attempts: readonly StoredManualCallAttempt[],
  scopeHash: string,
): string {
  return JSON.stringify(
    attempts.filter((attempt) => attempt.scopeHash !== scopeHash),
  );
}
