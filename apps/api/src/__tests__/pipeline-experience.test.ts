import fs from "node:fs";
import path from "node:path";
import {
  parsePipelineQuery,
  pipelinePageWindow,
} from "../../app/api/admin/crm/pipeline/query";
import {
  executePipelineStageMutation,
  PIPELINE_ABSENT_VERSION,
  PipelineStageConflictFailure,
  type PipelineStageMutationRepository,
  type PipelineStageRecord,
} from "@/lib/pipeline-stage-mutation";
import {
  findPipelineContact,
  movePipelineContact,
  normalizePipelineBoard,
} from "../../../site/src/app/team/components/pipeline-board-state";
import { buildPipelineHref } from "../../../site/src/app/team/components/pipeline-navigation";
import type {
  PipelineContact,
  PipelineLane,
} from "../../../site/src/app/team/components/pipeline.types";

const CONTACT_ID = "11111111-1111-4111-8111-111111111111";
const VERSION = "2026-08-08T12:00:00.000Z";
const NEW_VERSION = "2026-08-08T12:01:00.000Z";

function pipelineContact(
  id: string,
  stage: string,
  updatedAt = VERSION,
): PipelineContact {
  return {
    id,
    firstName: "Avery",
    lastName: "Stone",
    email: "avery@example.test",
    phone: "+15555550100",
    source: "website",
    pipeline: { stage, notes: null, updatedAt },
    property: null,
    stats: { appointments: 0, quotes: 0 },
    notesCount: 0,
    lastActivityAt: VERSION,
    updatedAt: VERSION,
    createdAt: VERSION,
  };
}

describe("bounded pipeline query contract", () => {
  it("normalizes filters and clamps adversarial page values", () => {
    const parsed = parsePipelineQuery(
      "https://example.test/api?q=%20%20Avery%20%20Stone%20&stage=QUOTED&limit=9999&offset=999999",
    );

    expect(parsed).toEqual({
      q: "Avery Stone",
      stage: "quoted",
      limit: 100,
      offset: 100_000,
      excludeOutbound: false,
    });
  });

  it("rejects unknown stages and reports deterministic page boundaries", () => {
    expect(
      parsePipelineQuery(
        "https://example.test/api?stage=secret&limit=not-a-number&excludeOutbound=1",
      ),
    ).toMatchObject({
      stage: null,
      limit: 50,
      offset: 0,
      excludeOutbound: true,
    });
    expect(pipelinePageWindow(121, 50, 50)).toEqual({
      total: 121,
      offset: 50,
      limit: 50,
      hasPrevious: true,
      hasNext: true,
    });
  });
});

describe("pipeline URL and client reconciliation", () => {
  it("preserves view, filters, page, and selected contact in a copyable URL", () => {
    const href = buildPipelineHref({
      q: "Avery Stone",
      stage: "quoted",
      offset: 50,
      view: "list",
      excludeOutbound: true,
      contactId: CONTACT_ID,
    });
    const url = new URL(href, "https://example.test");

    expect(url.pathname).toBe("/team/sales/pipeline");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: "Avery Stone",
      stage: "quoted",
      offset: "50",
      view: "list",
      contactId: CONTACT_ID,
    });
  });

  it("makes the outbound-inclusive filter copyable without polluting the default URL", () => {
    const inclusive = new URL(
      buildPipelineHref({
        q: "",
        stage: null,
        offset: 0,
        view: "board",
        excludeOutbound: false,
        contactId: null,
      }),
      "https://example.test",
    );
    const inboundOnly = new URL(
      buildPipelineHref({
        q: "",
        stage: null,
        offset: 0,
        view: "board",
        excludeOutbound: true,
        contactId: null,
      }),
      "https://example.test",
    );

    expect(inclusive.searchParams.get("outbound")).toBe("include");
    expect(inboundOnly.searchParams.has("outbound")).toBe(false);
  });

  it("moves one contact without duplication and adopts the server version", () => {
    const lanes: PipelineLane[] = [
      { stage: "new", contacts: [pipelineContact(CONTACT_ID, "new")] },
      { stage: "quoted", contacts: [] },
    ];

    const moved = movePipelineContact(
      normalizePipelineBoard(lanes),
      CONTACT_ID,
      "quoted",
      NEW_VERSION,
    );

    expect(moved[0]?.contacts).toHaveLength(0);
    expect(moved[1]?.contacts).toHaveLength(1);
    expect(findPipelineContact(moved, CONTACT_ID)?.pipeline).toMatchObject({
      stage: "quoted",
      updatedAt: NEW_VERSION,
    });
    expect(
      moved
        .flatMap((lane) => lane.contacts)
        .filter((row) => row.id === CONTACT_ID),
    ).toHaveLength(1);
  });
});

function pipelineRecord(
  stage: PipelineStageRecord["stage"],
  updatedAt: string,
): PipelineStageRecord {
  return {
    contactId: CONTACT_ID,
    stage,
    notes: "preserved pipeline context",
    createdAt: new Date("2026-08-01T12:00:00.000Z"),
    updatedAt: new Date(updatedAt),
  };
}

function fakePipelineRepository(
  initial: PipelineStageRecord | null,
  options: {
    closedSalesTaskCount?: number;
    active?: boolean;
    failUpdate?: boolean;
  } = {},
): {
  repository: PipelineStageMutationRepository;
  calls: string[];
  current(): PipelineStageRecord | null;
} {
  let current = initial;
  const calls: string[] = [];
  return {
    calls,
    current: () => current,
    repository: {
      lockContactScope() {
        calls.push("lock");
        return Promise.resolve();
      },
      findActiveContactForUpdate() {
        calls.push("contact");
        return Promise.resolve(options.active !== false);
      },
      findPipelineForUpdate() {
        calls.push("pipeline");
        return Promise.resolve(current);
      },
      insertPipeline(input) {
        calls.push("insert_pipeline");
        current = {
          contactId: input.contactId,
          stage: input.stage,
          notes: null,
          createdAt: input.now,
          updatedAt: input.now,
        };
        return Promise.resolve(current);
      },
      updatePipeline(input) {
        calls.push("update_pipeline");
        if (
          options.failUpdate ||
          !current ||
          current.updatedAt.toISOString() !==
            input.previousUpdatedAt.toISOString()
        ) {
          return Promise.resolve(null);
        }
        current = {
          ...current,
          stage: input.stage,
          updatedAt: input.updatedAt,
        };
        return Promise.resolve(current);
      },
      insertNote() {
        calls.push("insert_note");
        return Promise.resolve("22222222-2222-4222-8222-222222222222");
      },
      closeSalesHqTasks() {
        calls.push("close_sales_tasks");
        return Promise.resolve(options.closedSalesTaskCount ?? 0);
      },
    },
  };
}

describe("pipeline compare-and-set execution", () => {
  it("creates only from the explicit absent-row sentinel", async () => {
    const fake = fakePipelineRepository(null);
    const result = await executePipelineStageMutation(fake.repository, {
      contactId: CONTACT_ID,
      expectedVersion: PIPELINE_ABSENT_VERSION,
      payload: { stage: "contacted", notes: null },
      now: new Date(NEW_VERSION),
    });

    expect(result.pipeline).toMatchObject({
      contactId: CONTACT_ID,
      stage: "contacted",
      version: NEW_VERSION,
    });
    expect(result.before.version).toBe(PIPELINE_ABSENT_VERSION);
    expect(fake.calls).toEqual([
      "lock",
      "contact",
      "pipeline",
      "insert_pipeline",
    ]);
  });

  it("updates monotonically, preserves pipeline notes, and applies linked writes", async () => {
    const fake = fakePipelineRepository(pipelineRecord("new", VERSION), {
      closedSalesTaskCount: 2,
    });
    const result = await executePipelineStageMutation(fake.repository, {
      contactId: CONTACT_ID,
      expectedVersion: VERSION,
      payload: { stage: "quoted", notes: "Customer approved scope" },
      now: new Date(VERSION),
    });

    expect(result.pipeline).toMatchObject({
      stage: "quoted",
      version: "2026-08-08T12:00:00.001Z",
    });
    expect(fake.current()?.notes).toBe("preserved pipeline context");
    expect(result.noteTaskId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(result.closedSalesTaskCount).toBe(2);
    expect(result.noOp).toBe(false);
    expect(fake.calls).toEqual([
      "lock",
      "contact",
      "pipeline",
      "update_pipeline",
      "insert_note",
      "close_sales_tasks",
    ]);
  });

  it("records a same-stage no-op without manufacturing a new version", async () => {
    const fake = fakePipelineRepository(pipelineRecord("contacted", VERSION));
    const result = await executePipelineStageMutation(fake.repository, {
      contactId: CONTACT_ID,
      expectedVersion: VERSION,
      payload: { stage: "contacted", notes: null },
      now: new Date(NEW_VERSION),
    });

    expect(result.noOp).toBe(true);
    expect(result.pipeline.version).toBe(VERSION);
    expect(fake.calls).not.toContain("update_pipeline");
  });

  it("returns the exact current state before any linked write on stale input", async () => {
    const fake = fakePipelineRepository(
      pipelineRecord("contacted", NEW_VERSION),
    );
    await expect(
      executePipelineStageMutation(fake.repository, {
        contactId: CONTACT_ID,
        expectedVersion: VERSION,
        payload: { stage: "quoted", notes: "must not be written" },
      }),
    ).rejects.toMatchObject({
      name: PipelineStageConflictFailure.name,
      current: {
        contactId: CONTACT_ID,
        stage: "contacted",
        version: NEW_VERSION,
      },
    });
    expect(fake.calls).toEqual(["lock", "contact", "pipeline"]);
  });

  it("fails closed when the compare-and-set loses a concurrent race", async () => {
    const fake = fakePipelineRepository(pipelineRecord("new", VERSION), {
      failUpdate: true,
    });
    await expect(
      executePipelineStageMutation(fake.repository, {
        contactId: CONTACT_ID,
        expectedVersion: VERSION,
        payload: { stage: "quoted", notes: "must roll back" },
      }),
    ).rejects.toMatchObject({ code: "conflict", retryable: true });
    expect(fake.calls).toEqual([
      "lock",
      "contact",
      "pipeline",
      "update_pipeline",
    ]);
  });
});

describe("pipeline implementation evidence", () => {
  const apiRoute = fs.readFileSync(
    path.resolve(__dirname, "../../app/api/admin/crm/pipeline/route.ts"),
    "utf8",
  );
  const mutationRoute = fs.readFileSync(
    path.resolve(
      __dirname,
      "../../app/api/admin/crm/pipeline/[contactId]/route.ts",
    ),
    "utf8",
  );
  const client = fs.readFileSync(
    path.resolve(
      __dirname,
      "../../../site/src/app/team/components/PipelineBoardClient.tsx",
    ),
    "utf8",
  );
  const section = fs.readFileSync(
    path.resolve(
      __dirname,
      "../../../site/src/app/team/components/PipelineSection.tsx",
    ),
    "utf8",
  );
  const teamPage = fs.readFileSync(
    path.resolve(__dirname, "../../../site/src/app/team/page.tsx"),
    "utf8",
  );
  const siteMutation = fs.readFileSync(
    path.resolve(
      __dirname,
      "../../../site/src/app/api/team/contacts/pipeline/route.ts",
    ),
    "utf8",
  );
  const detailsPane = fs.readFileSync(
    path.resolve(
      __dirname,
      "../../../site/src/app/team/components/ContactsDetailsPaneClient.tsx",
    ),
    "utf8",
  );

  it("bounds and orders the API page while returning full stage counts", () => {
    expect(apiRoute).toContain(".limit(query.limit)");
    expect(apiRoute).toContain(".offset(query.offset)");
    expect(apiRoute).toContain("desc(crmPipeline.updatedAt)");
    expect(apiRoute).toContain("stageCounts");
    expect(apiRoute).toContain("pipelinePageWindow");
    expect(apiRoute).toContain("loadContactPropertiesForContacts");
  });

  it("provides list mode, keyboard stage controls, URL filters, and live feedback", () => {
    expect(client).toContain('view === "list"');
    expect(client).toContain('aria-label="Pipeline contacts"');
    expect(client).toContain("buildPipelineHref");
    expect(client).toContain("pipelineExpectedVersion");
    expect(client).toContain('"Idempotency-Key": idempotencyKey');
    expect(client).toContain('"If-Match": `"${expectedVersion}"`');
    expect(client).toContain('role="alert"');
    expect(client).toContain('aria-live="polite"');
  });

  it("wires URL state into the server page and preserves conflict details through the proxy", () => {
    expect(teamPage).toContain("stage: params.stage");
    expect(teamPage).toContain("outbound: params.outbound");
    expect(section).toContain('pipelineParams.set("q", q.trim())');
    expect(section).toContain('pipelineParams.set("stage", stage.trim())');
    expect(section).toContain('pipelineParams.set("offset", offset.trim())');
    expect(section).toContain('excludeOutbound: excludeOutbound ? "1" : "0"');
    expect(client).toContain("Include outbound contacts");
    expect(siteMutation).toContain('request.headers.get("if-match")');
    expect(siteMutation).toContain("parsePipelineConflictState");
    expect(siteMutation).toContain("parsePipelineStageMutationSuccess");
    expect(detailsPane).toContain("pipelineExpectedVersion(pipelineUpdatedAt)");
    expect(detailsPane).toContain("error.current.updatedAt");
    expect(detailsPane).toContain("router.refresh()");
    expect(mutationRoute).toContain('auditAction: "pipeline.updated"');
    expect(mutationRoute).toContain('entityType: "crm_pipeline"');
    expect(mutationRoute).toContain("fromStage: execution.before.stage");
    expect(mutationRoute).toContain("stage: execution.pipeline.stage");
  });
});
