import { createHash, randomUUID } from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";
import { getDb, teamMutationIdempotency } from "@/db";

const CLAIM_MS = 30_000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const STORED_HEADERS_KEY = "__portalV2ResponseHeaders";

export type PortalV2StoredResult = {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
};

export type PortalV2IdempotentRunResult =
  | { kind: "result"; result: PortalV2StoredResult; replayed: boolean }
  | { kind: "conflict"; reason: "different_request" | "in_progress" };

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonical(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("Non-finite request value");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        .map((key) => [
          key,
          canonical((value as Record<string, unknown>)[key]),
        ]),
    );
  }
  throw new TypeError("The request is not JSON-compatible");
}

export function portalV2RequestHash(value: unknown): string {
  return hash(JSON.stringify(canonical(value)));
}

function decodeStoredResult(
  status: number,
  storedBody: Record<string, unknown>,
): PortalV2StoredResult {
  const { [STORED_HEADERS_KEY]: rawHeaders, ...body } = storedBody;
  const headers =
    rawHeaders && typeof rawHeaders === "object" && !Array.isArray(rawHeaders)
      ? Object.fromEntries(
          Object.entries(rawHeaders).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : undefined;
  return { status, body, ...(headers ? { headers } : {}) };
}

export async function runPortalV2IdempotentMutation(input: {
  principal: string;
  action: string;
  keyHash: string;
  scope: string;
  payload: unknown;
  correlationId: string;
  execute: () => Promise<PortalV2StoredResult>;
}): Promise<PortalV2IdempotentRunResult> {
  const db = getDb();
  const now = new Date();
  const principalHash = hash(`portal-v2:${input.principal}`);
  const scopeHash = hash(input.scope);
  const requestHash = portalV2RequestHash({
    scope: input.scope,
    payload: input.payload,
  });
  const operationId = randomUUID();
  const [inserted] = await db
    .insert(teamMutationIdempotency)
    .values({
      principalHash,
      action: input.action,
      keyHash: input.keyHash,
      scopeHash,
      requestHash,
      status: "in_progress",
      operationId,
      correlationId: input.correlationId,
      attemptCount: 1,
      claimedAt: now,
      claimExpiresAt: new Date(now.getTime() + CLAIM_MS),
      expiresAt: new Date(now.getTime() + RETENTION_MS),
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: teamMutationIdempotency.id });

  let claimId = inserted?.id;
  if (!claimId) {
    const [existing] = await db
      .select()
      .from(teamMutationIdempotency)
      .where(
        and(
          eq(teamMutationIdempotency.principalHash, principalHash),
          eq(teamMutationIdempotency.action, input.action),
          eq(teamMutationIdempotency.keyHash, input.keyHash),
        ),
      )
      .limit(1);
    if (!existing) return { kind: "conflict", reason: "in_progress" };
    if (
      existing.scopeHash !== scopeHash ||
      existing.requestHash !== requestHash
    ) {
      return { kind: "conflict", reason: "different_request" };
    }
    if (
      (existing.status === "succeeded" || existing.status === "failed") &&
      existing.responseStatus !== null &&
      existing.responseBody !== null
    ) {
      return {
        kind: "result",
        replayed: true,
        result: decodeStoredResult(
          existing.responseStatus,
          existing.responseBody,
        ),
      };
    }
    if (existing.claimExpiresAt > now || existing.attemptCount >= 3) {
      return { kind: "conflict", reason: "in_progress" };
    }
    const [reclaimed] = await db
      .update(teamMutationIdempotency)
      .set({
        operationId,
        correlationId: input.correlationId,
        attemptCount: sql`${teamMutationIdempotency.attemptCount} + 1`,
        claimedAt: now,
        claimExpiresAt: new Date(now.getTime() + CLAIM_MS),
        expiresAt: new Date(now.getTime() + RETENTION_MS),
        updatedAt: now,
      })
      .where(
        and(
          eq(teamMutationIdempotency.id, existing.id),
          eq(teamMutationIdempotency.status, "in_progress"),
          lt(teamMutationIdempotency.claimExpiresAt, now),
        ),
      )
      .returning({ id: teamMutationIdempotency.id });
    claimId = reclaimed?.id;
    if (!claimId) return { kind: "conflict", reason: "in_progress" };
  }

  let result: PortalV2StoredResult;
  try {
    result = await input.execute();
  } catch {
    const failure: PortalV2StoredResult = {
      status: 503,
      body: { ok: false, error: "service_unavailable" },
    };
    await db
      .update(teamMutationIdempotency)
      .set({
        status: "failed",
        responseStatus: 503,
        responseBody: { ok: false, error: "service_unavailable" },
        lastErrorCode: "service_unavailable",
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(teamMutationIdempotency.id, claimId),
          eq(teamMutationIdempotency.operationId, operationId),
        ),
      );
    return { kind: "result", result: failure, replayed: false };
  }

  const responseBody = result.headers
    ? { ...result.body, [STORED_HEADERS_KEY]: result.headers }
    : result.body;
  await db
    .update(teamMutationIdempotency)
    .set({
      status: result.status < 400 ? "succeeded" : "failed",
      responseStatus: result.status,
      responseBody,
      lastErrorCode:
        result.status < 400 || typeof result.body["error"] !== "string"
          ? null
          : result.body["error"],
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(teamMutationIdempotency.id, claimId),
        eq(teamMutationIdempotency.operationId, operationId),
      ),
    );
  return { kind: "result", result, replayed: false };
}
