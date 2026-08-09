import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parsePipelineFilterPresetInventory,
  parsePipelineMovements,
  parsePipelinePresetCreateResult,
  parsePipelinePresetDeleteResult,
} from "../../../site/src/app/team/pipeline-presets";

const ROOT = join(process.cwd(), "../..");
const PRESET_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const OPERATION_ID = "33333333-3333-4333-8333-333333333333";
const AUDIT_EVENT_ID = "44444444-4444-4444-8444-444444444444";
const MOVEMENT_ID = "55555555-5555-4555-8555-555555555555";
const CORRELATION_ID = "pipeline-preset-correlation-123456";
const CREATED_AT = "2026-08-08T12:00:00.000Z";
const UPDATED_AT = "2026-08-08T12:05:00.000Z";

function source(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

function preset(overrides: Record<string, unknown> = {}) {
  return {
    id: PRESET_ID,
    name: "Hot inbound leads",
    q: "Avery",
    stage: "quoted",
    excludeOutbound: true,
    view: "list",
    version: 1,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    operationId: OPERATION_ID,
    correlationId: CORRELATION_ID,
    actorId: ACTOR_ID,
    committedAt: UPDATED_AT,
    auditEventId: AUDIT_EVENT_ID,
    entityType: "team_pipeline_filter_preset",
    entityId: PRESET_ID,
    version: "1",
    ...overrides,
  };
}

function headers(): Headers {
  return new Headers({ "x-correlation-id": CORRELATION_ID });
}

describe("Pipeline saved-filter contracts", () => {
  it("accepts only a complete, bounded, unique per-user inventory", () => {
    const complete = { presets: [preset()], limit: 12 };
    expect(parsePipelineFilterPresetInventory(complete)).toEqual(complete);
    expect(
      parsePipelineFilterPresetInventory({ presets: [], limit: 12 }),
    ).toEqual({ presets: [], limit: 12 });

    for (const invalid of [
      { ...complete, privateNote: "must not cross the boundary" },
      { ...complete, limit: 13 },
      { presets: [preset(), preset()], limit: 12 },
      {
        presets: [
          preset({ name: "Same" }),
          preset({ id: MOVEMENT_ID, name: "same" }),
        ],
        limit: 12,
      },
      { presets: [preset({ q: "x".repeat(121) })], limit: 12 },
      { presets: [preset({ stage: "secret" })], limit: 12 },
      { presets: [preset({ view: "grid" })], limit: 12 },
      {
        presets: Array.from({ length: 13 }, (_, index) =>
          preset({
            id: `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
          }),
        ),
        limit: 12,
      },
    ]) {
      expect(parsePipelineFilterPresetInventory(invalid)).toBeNull();
    }
  });

  it("binds create success to the requested settings, actor, entity, version, and correlation", () => {
    const payload = {
      ok: true,
      data: { preset: preset() },
      receipt: receipt(),
    };
    const expected = {
      actorId: ACTOR_ID,
      name: "Hot inbound leads",
      q: "Avery",
      stage: "quoted" as const,
      excludeOutbound: true,
      view: "list" as const,
    };

    expect(
      parsePipelinePresetCreateResult(payload, headers(), expected),
    ).toEqual(payload);
    for (const invalid of [
      { ...payload, data: { preset: preset({ q: "Different" }) } },
      { ...payload, receipt: receipt({ actorId: MOVEMENT_ID }) },
      { ...payload, receipt: receipt({ entityId: MOVEMENT_ID }) },
      { ...payload, receipt: receipt({ version: "2" }) },
      { ...payload, secret: "not allowed" },
    ]) {
      expect(
        parsePipelinePresetCreateResult(invalid, headers(), expected),
      ).toBeNull();
    }
    expect(
      parsePipelinePresetCreateResult(
        payload,
        new Headers({ "x-correlation-id": "another-correlation-123456" }),
        expected,
      ),
    ).toBeNull();
  });

  it("binds delete success and accepts only canonical typed failures", () => {
    const payload = {
      ok: true,
      data: { deletedPresetId: PRESET_ID },
      receipt: receipt(),
    };
    const expected = { actorId: ACTOR_ID, presetId: PRESET_ID, version: 1 };
    expect(
      parsePipelinePresetDeleteResult(payload, headers(), expected),
    ).toEqual(payload);
    expect(
      parsePipelinePresetDeleteResult(
        {
          ...payload,
          data: { deletedPresetId: MOVEMENT_ID },
        },
        headers(),
        expected,
      ),
    ).toBeNull();

    const failure = {
      ok: false,
      code: "conflict",
      message: "The saved filter changed.",
      retryable: false,
      fieldErrors: { version: "Refresh saved filters." },
    } as const;
    expect(
      parsePipelinePresetDeleteResult(failure, new Headers(), expected),
    ).toEqual(failure);
    expect(
      parsePipelinePresetDeleteResult(
        { ...failure, internalDetail: "hidden" },
        new Headers(),
        expected,
      ),
    ).toBeNull();
  });
});

describe("Pipeline movement evidence contract", () => {
  const manual = {
    id: `audit:${MOVEMENT_ID}`,
    actorLabel: "Jordan Stone",
    occurredAt: UPDATED_AT,
    fromStage: "contacted",
    toStage: "quoted",
    source: "manual",
    sourceLabel: "Manual update",
  };
  const automation = {
    id: `automation:${PRESET_ID}`,
    actorLabel: "Automation",
    occurredAt: CREATED_AT,
    fromStage: null,
    toStage: "contacted",
    source: "automation",
    sourceLabel: "First response",
  };

  it("accepts empty or descending privacy-safe history and rejects excess data", () => {
    expect(parsePipelineMovements({ movements: [], limit: 10 })).toEqual({
      movements: [],
      limit: 10,
    });
    expect(
      parsePipelineMovements({ movements: [manual, automation], limit: 10 }),
    ).toEqual({ movements: [manual, automation], limit: 10 });

    for (const invalid of [
      { movements: [automation, manual], limit: 10 },
      { movements: [{ ...manual, customerPhone: "+15555550100" }], limit: 10 },
      { movements: [{ ...manual, source: "provider" }], limit: 10 },
      { movements: [{ ...manual, toStage: "secret" }], limit: 10 },
      {
        movements: [{ ...manual, actorLabel: "Jordan\u202eStone" }],
        limit: 10,
      },
      { movements: [manual, manual], limit: 10 },
      { movements: Array.from({ length: 11 }, () => manual), limit: 10 },
      { movements: [manual], limit: 11 },
    ]) {
      expect(parsePipelineMovements(invalid)).toBeNull();
    }
  });
});

describe("Pipeline saved-filter and movement implementation evidence", () => {
  const collectionRoute = source(
    "apps/api/app/api/admin/crm/pipeline/presets/route.ts",
  );
  const deleteRoute = source(
    "apps/api/app/api/admin/crm/pipeline/presets/[presetId]/route.ts",
  );
  const movementRoute = source(
    "apps/api/app/api/admin/crm/pipeline/[contactId]/movements/route.ts",
  );
  const siteCreateRoute = source(
    "apps/site/src/app/api/team/pipeline/presets/route.ts",
  );
  const siteDeleteRoute = source(
    "apps/site/src/app/api/team/pipeline/presets/[presetId]/route.ts",
  );
  const board = source(
    "apps/site/src/app/team/components/PipelineBoardClient.tsx",
  );
  const movementPanel = source(
    "apps/site/src/app/team/components/PipelineMovementEvidence.tsx",
  );
  const migration = source(
    "apps/api/src/db/migrations/0089_team_pipeline_filter_presets.sql",
  );
  const schema = source("apps/api/src/db/schema.ts");
  const journal = JSON.parse(
    source("apps/api/src/db/migrations/meta/_journal.json"),
  ) as { entries: Array<Record<string, unknown>> };

  it("registers migration 0089 with member-scoped uniqueness and movement lookup", () => {
    expect(journal.entries).toContainEqual({
      idx: 86,
      version: "7",
      when: 1788566400000,
      tag: "0089_team_pipeline_filter_presets",
      breakpoints: true,
    });
    expect(migration).toContain('REFERENCES "team_members"("id")');
    expect(migration).toContain("ON DELETE CASCADE");
    expect(migration).toContain(
      '"team_pipeline_filter_presets_member_name_key"',
    );
    expect(migration).toContain("\"payload\"->>'contactId'");
    expect(schema).toContain(
      "export const teamPipelineFilterPresets = pgTable(",
    );
    expect(schema).toContain("outbox_pipeline_movement_contact_created_idx");
  });

  it("guards, bounds, scopes, locks, audits, and atomically completes preset writes", () => {
    const createBoundary = collectionRoute.indexOf("beginTeamMutation(request");
    const createBody = collectionRoute.indexOf(
      "readBoundedJsonRequest(",
      createBoundary,
    );
    const createDb = collectionRoute.indexOf("db = getDb()", createBoundary);
    expect(createBoundary).toBeGreaterThan(-1);
    expect(createBoundary).toBeLessThan(createBody);
    expect(createBody).toBeLessThan(createDb);
    expect(collectionRoute).toContain('requiredPermissions: ["pipeline.read"]');
    expect(collectionRoute).toContain('risk: "normal"');
    expect(collectionRoute).toContain("requiresIdempotency: true");
    expect(collectionRoute).toContain(
      'auditAction: "pipeline.filter_preset.created"',
    );
    expect(collectionRoute).toContain(
      "PIPELINE_FILTER_PRESET_BODY_MAXIMUM_BYTES",
    );
    expect(collectionRoute).toContain("exactKeys(payload, CREATE_KEYS)");
    expect(collectionRoute).toContain("entityId: teamMemberId");
    expect(collectionRoute).toContain('.for("update")');
    expect(collectionRoute).toContain("PIPELINE_FILTER_PRESET_LIMIT");
    expect(collectionRoute).toContain("mutation.audit.insertSuccess(tx");
    expect(collectionRoute).toContain("completeTeamMutationIdempotency(");
    expect(collectionRoute).not.toContain("after: {\n          name:");
    expect(collectionRoute).not.toContain("after: {\n          q:");

    const deleteBoundary = deleteRoute.indexOf("beginTeamMutation(request");
    expect(deleteBoundary).toBeGreaterThan(-1);
    expect(deleteBoundary).toBeLessThan(deleteRoute.indexOf("context.params"));
    expect(deleteRoute).toContain('requiredPermissions: ["pipeline.read"]');
    expect(deleteRoute).toContain("assertTeamMutationExpectedVersion");
    expect(deleteRoute).toContain("mutation.expectedVersion");
    expect(deleteRoute).toContain(
      "eq(teamPipelineFilterPresets.teamMemberId, teamMemberId)",
    );
    expect(deleteRoute).toContain(
      "eq(teamPipelineFilterPresets.version, expectedVersion)",
    );
    expect(deleteRoute).toContain("mutation.audit.insertSuccess(tx");
    expect(deleteRoute).toContain("completeTeamMutationIdempotency(");
  });

  it("keeps Site mutations same-origin, principal-bound, exactly replayable, and receipt-bound", () => {
    for (const route of [siteCreateRoute, siteDeleteRoute]) {
      expect(
        route.indexOf("isSameOriginPipelinePresetRequest(request)"),
      ).toBeLessThan(route.indexOf("requireTeamPrincipal(request"));
      expect(route).toContain('permissions: "pipeline.read"');
      expect(route).toContain("MAXIMUM_UPSTREAM_ATTEMPTS = 2");
      expect(route).toContain("readBoundedPipelinePresetMutationPayload");
      expect(route).toContain("x-correlation-id");
      expect(route).toContain("valid, correlated");
    }
    expect(siteCreateRoute).toContain("parsePipelinePresetCreateResult");
    expect(siteCreateRoute).toContain('"Idempotency-Key": idempotencyKey');
    expect(siteDeleteRoute).toContain("parsePipelinePresetDeleteResult");
    expect(siteDeleteRoute).toContain('"If-Match": String(version)');
    expect(siteDeleteRoute).toContain("ifMatch !== String(version)");
  });

  it("returns bounded privacy-safe movement evidence and truthful responsive UI states", () => {
    expect(
      movementRoute.indexOf('requirePermission(request, "pipeline.read")'),
    ).toBeLessThan(movementRoute.indexOf("context.params"));
    expect(movementRoute).toContain("PIPELINE_MOVEMENT_LIMIT = 10");
    expect(movementRoute).toContain(
      "movements.slice(0, PIPELINE_MOVEMENT_LIMIT)",
    );
    expect(movementRoute).toContain("safeLabel(");
    expect(movementRoute).toContain("automationSourceLabel(");
    expect(movementRoute).not.toContain("customerPhone");
    expect(movementRoute).not.toContain("customerEmail");
    expect(board).toContain("My saved filters");
    expect(board).toContain("No saved filters yet.");
    expect(board).toContain("Apply");
    expect(board).toContain("Delete");
    expect(board).toContain("min-h-11");
    expect(board).toContain("createPresetRetryRef");
    expect(board).toContain("deletePresetRetryRef");
    expect(board).toContain("if (!result.retryable)");
    expect(movementPanel).toContain("Recent stage movement");
    expect(movementPanel).toContain(
      "No stage movement has been recorded for this contact yet.",
    );
    expect(movementPanel).toContain('role="alert"');
    expect(movementPanel).toContain("Retry");
  });
});
