import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NextRequest } from "next/server";
import { readBoundedJsonRequest } from "@/lib/bounded-json-request";
import type { BoundedJsonRequestError } from "@/lib/bounded-json-request";
import {
  parsePipelineExpectedVersion,
  parsePipelineStageMutationPayload,
  PIPELINE_ABSENT_VERSION,
  PIPELINE_MUTATION_MAXIMUM_BYTES,
  runPipelineStageMutationAtomic,
} from "@/lib/pipeline-stage-mutation";
import {
  parsePipelineConflictState,
  parsePipelineStageMutationSuccess,
  PipelineStageRequestError,
  requestPipelineStageMutation,
} from "../../../site/src/app/team/lib/pipeline-stage-mutation";

const REPOSITORY_ROOT = resolve(process.cwd(), "../..");
const CONTACT_ID = "11111111-1111-4111-8111-111111111111";
const MEMBER_ID = "22222222-2222-4222-8222-222222222222";
const OPERATION_ID = "33333333-3333-4333-8333-333333333333";
const CORRELATION_ID = "44444444-4444-4444-8444-444444444444";
const AUDIT_ID = "55555555-5555-4555-8555-555555555555";
const VERSION = "2026-08-09T12:00:00.000Z";
const NEW_VERSION = "2026-08-09T12:00:00.001Z";

function read(relativePath: string): string {
  return readFileSync(resolve(REPOSITORY_ROOT, relativePath), "utf8");
}

function success(overrides: Record<string, unknown> = {}): unknown {
  return {
    ok: true,
    data: {
      pipeline: {
        contactId: CONTACT_ID,
        stage: "contacted",
        updatedAt: NEW_VERSION,
        version: NEW_VERSION,
      },
      noteTaskId: null,
      closedSalesTaskCount: 0,
      noOp: false,
    },
    receipt: {
      operationId: OPERATION_ID,
      correlationId: CORRELATION_ID,
      actorId: MEMBER_ID,
      committedAt: NEW_VERSION,
      auditEventId: AUDIT_ID,
      entityType: "crm_pipeline",
      entityId: CONTACT_ID,
      version: NEW_VERSION,
    },
    ...overrides,
  };
}

const expectedSuccess = {
  actorId: MEMBER_ID,
  contactId: CONTACT_ID,
  stage: "contacted",
  previousStage: "new",
  submittedVersion: VERSION,
};

describe("pipeline stage mutation input and version contract", () => {
  it("normalizes one exact bounded payload and rejects unknown or malformed fields", () => {
    expect(
      parsePipelineStageMutationPayload({
        stage: " CONTACTED ",
        notes: " Follow up tomorrow ",
      }),
    ).toEqual({ stage: "contacted", notes: "Follow up tomorrow" });
    expect(() =>
      parsePipelineStageMutationPayload({ stage: "contacted", admin: true }),
    ).toThrow("unsupported or missing fields");
    expect(() =>
      parsePipelineStageMutationPayload({ stage: "secret" }),
    ).toThrow("supported pipeline stage");
    expect(() =>
      parsePipelineStageMutationPayload({
        stage: "contacted",
        notes: "x".repeat(2_001),
      }),
    ).toThrow("too long");
  });

  it("requires either the exact canonical version or the explicit absent sentinel", () => {
    expect(parsePipelineExpectedVersion(VERSION)).toBe(VERSION);
    expect(parsePipelineExpectedVersion(PIPELINE_ABSENT_VERSION)).toBe(
      PIPELINE_ABSENT_VERSION,
    );
    expect(() => parsePipelineExpectedVersion(null)).toThrow(
      "latest pipeline version",
    );
    expect(() => parsePipelineExpectedVersion("2026-08-09T12:00:00Z")).toThrow(
      "latest pipeline version",
    );
  });

  it("rejects declared and streamed bodies beyond the hard byte limit", async () => {
    const body = JSON.stringify({
      stage: "contacted",
      notes: "x".repeat(PIPELINE_MUTATION_MAXIMUM_BYTES),
    });
    const request = new NextRequest("https://api.example.test/pipeline", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body,
    });
    await expect(
      readBoundedJsonRequest(request, {
        maximumBytes: PIPELINE_MUTATION_MAXIMUM_BYTES,
      }),
    ).rejects.toMatchObject<Partial<BoundedJsonRequestError>>({
      code: "body_too_large",
      status: 413,
    });
  });
});

describe("pipeline receipt and retry contract", () => {
  it("accepts only a receipt bound to actor, contact, target stage, and monotonic version", () => {
    expect(
      parsePipelineStageMutationSuccess(success(), expectedSuccess),
    ).toMatchObject({
      data: { pipeline: { stage: "contacted", version: NEW_VERSION } },
      receipt: { actorId: MEMBER_ID, entityId: CONTACT_ID },
    });
    const base = success() as {
      data: Record<string, unknown>;
      receipt: Record<string, unknown>;
    };
    expect(
      parsePipelineStageMutationSuccess(
        success({ receipt: { ...base.receipt, actorId: CONTACT_ID } }),
        expectedSuccess,
      ),
    ).toBeNull();
    expect(
      parsePipelineStageMutationSuccess(
        success({
          data: {
            ...base.data,
            pipeline: {
              ...(base.data["pipeline"] as Record<string, unknown>),
              version: VERSION,
              updatedAt: VERSION,
            },
          },
          receipt: { ...base.receipt, version: VERSION },
        }),
        expectedSuccess,
      ),
    ).toBeNull();
    expect(
      parsePipelineStageMutationSuccess(
        success({ extra: true }),
        expectedSuccess,
      ),
    ).toBeNull();
  });

  it("parses a safe exact current state and rejects broadened conflict data", () => {
    const current = {
      contactId: CONTACT_ID,
      stage: "new",
      updatedAt: null,
      version: PIPELINE_ABSENT_VERSION,
    };
    expect(parsePipelineConflictState({ current })).toEqual(current);
    expect(
      parsePipelineConflictState({ current: { ...current, extra: true } }),
    ).toBeNull();
  });

  it("safely replays one lost response with the exact caller closure", async () => {
    const request = jest
      .fn<Promise<Response>, []>()
      .mockRejectedValueOnce(new TypeError("connection reset"))
      .mockResolvedValueOnce(Response.json(success()));
    await expect(
      requestPipelineStageMutation(request, expectedSuccess),
    ).resolves.toMatchObject({ receipt: { operationId: OPERATION_ID } });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("never claims success for two malformed responses or a persistent network failure", async () => {
    const malformed = jest
      .fn<Promise<Response>, []>()
      .mockResolvedValue(Response.json({ ok: true }));
    await expect(
      requestPipelineStageMutation(malformed, expectedSuccess),
    ).rejects.toBeInstanceOf(PipelineStageRequestError);
    expect(malformed).toHaveBeenCalledTimes(2);

    const offline = jest
      .fn<Promise<Response>, []>()
      .mockRejectedValue(new TypeError("offline"));
    await expect(
      requestPipelineStageMutation(offline, expectedSuccess),
    ).rejects.toMatchObject({ status: 502 });
    expect(offline).toHaveBeenCalledTimes(2);
  });
});

describe("pipeline transaction and source contracts", () => {
  it("rolls linked writes back when the audit boundary fails", async () => {
    let committed: string[] = [];
    const runner = async <Result>(
      work: (tx: never) => Promise<Result>,
    ): Promise<Result> => {
      const draft = [...committed];
      const tx = {
        write(value: string) {
          draft.push(value);
        },
      };
      const result = await work(tx as never);
      committed = draft;
      return result;
    };

    await expect(
      runPipelineStageMutationAtomic(runner, (tx) => {
        (tx as unknown as { write(value: string): void }).write("pipeline");
        (tx as unknown as { write(value: string): void }).write("note");
        (tx as unknown as { write(value: string): void }).write("sales tasks");
        return Promise.reject(new Error("audit unavailable"));
      }),
    ).rejects.toThrow("audit unavailable");
    expect(committed).toEqual([]);
  });

  it("keeps authorization, exact input, business writes, audit, receipt, and replay in the required order", () => {
    const route = read(
      "apps/api/app/api/admin/crm/pipeline/[contactId]/route.ts",
    );
    const boundary = route.indexOf("beginTeamMutation(request,");
    expect(boundary).toBeGreaterThanOrEqual(0);
    expect(route.indexOf("context.params")).toBeGreaterThan(boundary);
    expect(route.indexOf("readBoundedJsonRequest(request")).toBeGreaterThan(
      boundary,
    );
    expect(route.indexOf("getDb()")).toBeGreaterThan(
      route.indexOf("parsePipelineStageMutationPayload"),
    );
    expect(route).toContain('principalTypes: ["human"]');
    expect(route).toContain('requiredPermissions: ["pipeline.write"]');
    expect(route).toContain("requiresIdempotency: true");
    expect(route).toContain('auditAction: "pipeline.updated"');
    expect(route).toContain("PIPELINE_MUTATION_MAXIMUM_BYTES");
    expect(route).toContain("claimTeamMutationIdempotency(");
    expect(route).toContain('if (claimed.kind === "replay")');
    expect(route).toContain("pg_advisory_xact_lock");
    expect(route).toContain("executePipelineStageMutation(");
    expect(route).toContain("mutation.audit.insertSuccess(tx");
    expect(route).toContain("completeTeamMutationIdempotency(");
    expect(route).not.toContain("recordAuditEvent(");

    const transaction = route.indexOf("database.transaction(work)");
    const execute = route.indexOf("executePipelineStageMutation(", transaction);
    const audit = route.indexOf("mutation.audit.insertSuccess(tx", execute);
    const completion = route.indexOf("completeTeamMutationIdempotency(", audit);
    expect(transaction).toBeGreaterThanOrEqual(0);
    expect(execute).toBeGreaterThan(transaction);
    expect(audit).toBeGreaterThan(execute);
    expect(completion).toBeGreaterThan(audit);
  });

  it("persists the exact safe 409 current state so a lost conflict response replays intact", () => {
    const route = read(
      "apps/api/app/api/admin/crm/pipeline/[contactId]/route.ts",
    );
    const conflictStart = route.indexOf(
      "if (error instanceof PipelineStageConflictFailure)",
      route.indexOf("database.transaction(work)"),
    );
    const conflictEnd = route.indexOf("throw error;", conflictStart);
    const conflictBranch = route.slice(conflictStart, conflictEnd);
    expect(conflictStart).toBeGreaterThanOrEqual(0);
    expect(conflictBranch).toContain("current: error.current");
    expect(conflictBranch).toContain("completeTeamMutationIdempotency(");
    expect(conflictBranch).toContain("conflictResult");
    expect(conflictBranch).toContain("409");
    expect(route).toContain("teamMutationIdempotencyReplayResponse(");
    expect(route.indexOf('if (claimed.kind === "replay")')).toBeLessThan(
      route.indexOf("database.transaction(work)"),
    );
  });

  it("wires every stage caller to a stable key, exact version, previous stage, and strict receipt", () => {
    const board = read(
      "apps/site/src/app/team/components/PipelineBoardClient.tsx",
    );
    const detail = read(
      "apps/site/src/app/team/components/ContactsDetailsPaneClient.tsx",
    );
    const list = read(
      "apps/site/src/app/team/components/ContactsListClient.tsx",
    );
    const inbox = read(
      "apps/site/src/app/team/components/InboxNewLeadNotice.tsx",
    );
    const actions = read("apps/site/src/app/team/actions.ts");
    const proxy = read("apps/site/src/app/api/team/contacts/pipeline/route.ts");
    for (const source of [board, detail]) {
      expect(source).toContain('"Idempotency-Key": idempotencyKey');
      expect(source).toContain('"If-Match": `"${expectedVersion}"`');
      expect(source).toContain("requestPipelineStageMutation(");
      expect(source).toContain("previousStage");
      expect(source).toContain("pipeline-stage:${");
    }
    for (const source of [list, inbox]) {
      expect(source).toContain('name="expectedVersion"');
      expect(source).toContain('name="idempotencyKey"');
      expect(source).toContain('name="previousStage"');
    }
    expect(actions).toContain("requestPipelineStageMutation(");
    expect(actions).toContain('formData.getAll("expectedVersion")');
    expect(proxy).toContain("parsePipelineStageMutationSuccess");
    expect(proxy).toContain("parsePipelineConflictState");
    expect(proxy).toContain("readBoundedRequestBytes");
    expect(inbox).toContain(
      "pipeline-stage:${lead.contactId}:${lead.pipelineVersion}",
    );
    expect(proxy.indexOf("requireTeamPrincipal(request")).toBeLessThan(
      proxy.indexOf("readPayload(request)"),
    );
  });
});
