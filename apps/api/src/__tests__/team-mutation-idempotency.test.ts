import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ActionPolicy } from "@myst-os/sdk";
import {
  classifyTeamMutationIdempotencyRecord,
  fingerprintTeamMutationIdempotency,
  teamMutationIdempotencyReplayResponse,
} from "@/lib/team-mutation-idempotency";
import type { TeamMutationContext } from "@/lib/team-mutation";

const API_ROOT = path.resolve(__dirname, "../..");
const RAW_KEY = "instant-quote-delete:customer-safe-key";
const KEY_HASH = createHash("sha256").update(RAW_KEY).digest("hex");
const POLICY: ActionPolicy = {
  principalTypes: ["human"],
  requiredPermissions: ["quotes.delete"],
  risk: "destructive",
  requiresIdempotency: true,
  auditAction: "instant_quote.deleted",
};

function source(relativePath: string): string {
  return fs.readFileSync(path.resolve(API_ROOT, relativePath), "utf8");
}

function mutation(
  overrides: Partial<TeamMutationContext> = {},
): TeamMutationContext {
  return {
    policy: POLICY,
    actor: {
      type: "human",
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      role: "owner",
      label: "Verified Owner",
      sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      authMethod: "team_session",
    },
    principalType: "human",
    operationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    correlationId: "request-correlation-123",
    idempotencyKeyHash: KEY_HASH,
    expectedVersion: "record-version-1",
    audit: {
      insertSuccess: jest.fn(),
    },
    ...overrides,
  };
}

function fingerprint(
  overrides: Partial<TeamMutationContext> = {},
  payload: unknown = { method: "DELETE", options: { force: false } },
) {
  return fingerprintTeamMutationIdempotency(mutation(overrides), {
    route: "DELETE /api/admin/instant-quotes/:id",
    entityType: "instant_quote",
    entityId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    payload,
  });
}

type DecisionRecord = Parameters<
  typeof classifyTeamMutationIdempotencyRecord
>[0];

function record(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  const expected = fingerprint();
  return {
    scopeHash: expected.scopeHash,
    requestHash: expected.requestHash,
    status: "in_progress",
    attemptCount: 1,
    claimExpiresAt: new Date("2026-08-08T12:00:30.000Z"),
    expiresAt: new Date("2026-08-15T12:00:00.000Z"),
    responseStatus: null,
    responseBody: null,
    ...overrides,
  };
}

describe("durable team-mutation idempotency", () => {
  it("hashes the raw key and verified principal without returning either value", () => {
    const result = fingerprint();

    expect(result.keyHash).toBe(KEY_HASH);
    expect(result.keyHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.principalHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(result)).not.toContain(RAW_KEY);
    expect(JSON.stringify(result)).not.toContain(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
  });

  it("canonicalizes object key order but binds entity, payload, and version", () => {
    const first = fingerprint(
      {},
      { options: { force: false }, method: "DELETE" },
    );
    const reordered = fingerprint(
      {},
      { method: "DELETE", options: { force: false } },
    );
    const changedPayload = fingerprint(
      {},
      { method: "DELETE", options: { force: true } },
    );
    const changedVersion = fingerprint({ expectedVersion: "record-version-2" });
    const changedEntity = fingerprintTeamMutationIdempotency(mutation(), {
      route: "DELETE /api/admin/instant-quotes/:id",
      entityType: "instant_quote",
      entityId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      payload: { method: "DELETE", options: { force: false } },
    });

    expect(first).toEqual(reordered);
    expect(changedPayload.requestHash).not.toBe(first.requestHash);
    expect(changedVersion.requestHash).not.toBe(first.requestHash);
    expect(changedEntity.scopeHash).not.toBe(first.scopeHash);
    expect(changedEntity.requestHash).not.toBe(first.requestHash);
  });

  it("conflicts instead of replaying a key used for another scope or request", () => {
    const expected = fingerprint();
    expect(
      classifyTeamMutationIdempotencyRecord(
        record({ scopeHash: "f".repeat(64) }),
        expected,
        new Date("2026-08-08T12:00:00.000Z"),
      ),
    ).toEqual({ kind: "scope_conflict" });
    expect(
      classifyTeamMutationIdempotencyRecord(
        record({ requestHash: "e".repeat(64) }),
        expected,
        new Date("2026-08-08T12:00:00.000Z"),
      ),
    ).toEqual({ kind: "scope_conflict" });
  });

  it("replays complete successes and failures but refuses incomplete terminals", () => {
    const expected = fingerprint();
    const now = new Date("2026-08-08T12:00:00.000Z");
    expect(
      classifyTeamMutationIdempotencyRecord(
        record({
          status: "succeeded",
          responseStatus: 200,
          responseBody: { ok: true },
        }),
        expected,
        now,
      ),
    ).toEqual({ kind: "replay" });
    expect(
      classifyTeamMutationIdempotencyRecord(
        record({
          status: "failed",
          responseStatus: 409,
          responseBody: { ok: false, code: "conflict" },
        }),
        expected,
        now,
      ),
    ).toEqual({ kind: "replay" });
    expect(
      classifyTeamMutationIdempotencyRecord(
        record({ status: "succeeded" }),
        expected,
        now,
      ),
    ).toEqual({ kind: "corrupt" });
  });

  it("returns the exact stored success and receipt without minting a new one", async () => {
    const stored = {
      ok: true as const,
      data: { deleted: true },
      receipt: {
        operationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        correlationId: "original-correlation-123",
        actorId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        committedAt: "2026-08-08T12:00:00.000Z",
        auditEventId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      },
    };

    const response = teamMutationIdempotencyReplayResponse({
      result: stored,
      status: 200,
      correlationId: stored.receipt.correlationId,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("idempotency-replayed")).toBe("true");
    expect(response.headers.get("x-correlation-id")).toBe(
      "original-correlation-123",
    );
    expect(await response.json()).toEqual(stored);
  });

  it("returns a deterministic retry window for a concurrent live claim", () => {
    expect(
      classifyTeamMutationIdempotencyRecord(
        record({ claimExpiresAt: new Date("2026-08-08T12:00:08.001Z") }),
        fingerprint(),
        new Date("2026-08-08T12:00:00.000Z"),
      ),
    ).toEqual({ kind: "in_progress", retryAfterSeconds: 9 });
  });

  it("stops replay after the seven-day retention boundary", () => {
    expect(
      classifyTeamMutationIdempotencyRecord(
        record({
          status: "succeeded",
          responseStatus: 200,
          responseBody: { ok: true },
          expiresAt: new Date("2026-08-08T12:00:00.000Z"),
        }),
        fingerprint(),
        new Date("2026-08-08T12:00:00.000Z"),
      ),
    ).toEqual({ kind: "expired" });
  });

  it("permits only two stale takeovers after the original claim", () => {
    const now = new Date("2026-08-08T12:01:00.000Z");
    const stale = new Date("2026-08-08T12:00:30.000Z");
    expect(
      classifyTeamMutationIdempotencyRecord(
        record({ attemptCount: 2, claimExpiresAt: stale }),
        fingerprint(),
        now,
      ),
    ).toEqual({ kind: "reclaim" });
    expect(
      classifyTeamMutationIdempotencyRecord(
        record({ attemptCount: 3, claimExpiresAt: stale }),
        fingerprint(),
        now,
      ),
    ).toEqual({ kind: "exhausted" });
  });

  it("registers an additive hashed ledger as journal entry 63", () => {
    const migration = source(
      "src/db/migrations/0066_team_mutation_idempotency.sql",
    );
    const journal = JSON.parse(
      source("src/db/migrations/meta/_journal.json"),
    ) as { entries?: Array<{ idx?: number; tag?: string }> };

    expect(journal.entries).toContainEqual(
      expect.objectContaining({
        idx: 63,
        tag: "0066_team_mutation_idempotency",
      }),
    );
    expect(migration).toContain(
      'UNIQUE INDEX IF NOT EXISTS "team_mutation_idempotency_principal_action_key"',
    );
    expect(migration).toContain('"key_hash" varchar(64) NOT NULL');
    expect(migration).toContain('"request_hash" varchar(64) NOT NULL');
    expect(migration).toContain(
      'CHECK ("attempt_count" BETWEEN 1 AND 3)',
    );
    expect(migration).not.toMatch(/"idempotency_key"|"raw_key"/u);
  });

  it("binds the instant-quote UI request to the version rendered to the user", () => {
    const action = source("../site/src/app/team/actions.ts");
    const form = source(
      "../site/src/app/team/components/DeleteInstantQuoteForm.tsx",
    );

    expect(form).toContain('name="expectedVersion"');
    expect(form).toContain('name="idempotencyKey"');
    expect(action).toContain('formData.get("expectedVersion")');
    expect(action).toContain('formData.get("idempotencyKey")');
    expect(action).toContain('"x-expected-version": expectedVersion');
    expect(action).toContain('"Idempotency-Key": idempotencyKey');
  });
});
