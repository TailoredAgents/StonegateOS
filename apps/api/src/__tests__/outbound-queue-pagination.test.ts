import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { DatabaseClient } from "@/db";
import {
  decodeOutboundQueueCursor,
  encodeOutboundQueueCursor,
  escapedOutboundSearchPattern,
  outboundQueueFilterFingerprint,
  parseOutboundQueueRequest,
  parseOutboundQueueSelection,
  type OutboundQueueFilters,
} from "@/lib/outbound-queue-pagination";
import {
  loadOutboundQueuePage,
  resolveOutboundSelectedTaskMemberId,
} from "@/lib/outbound-queue-query";

const ROOT = join(process.cwd(), "../..");
const MEMBER_ID = "11111111-1111-4111-8111-111111111111";
const SNAPSHOT = new Date("2026-08-09T16:00:00.000Z");
const FILTERS: OutboundQueueFilters = {
  q: null,
  campaign: null,
  attempt: null,
  due: "all",
  has: "any",
  disposition: null,
};

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function pageAccount(index: number) {
  return {
    accountKey: `account:${uuid(index)}`,
    accountCreatedAt: new Date(SNAPSHOT.getTime() - (700 - index) * 60_000),
    primaryTaskId: uuid(10_000 + index),
  };
}

function detailRow(accountIndex: number, taskIndex = 0) {
  const account = pageAccount(accountIndex);
  return {
    taskId:
      taskIndex === 0
        ? account.primaryTaskId
        : uuid(20_000 + accountIndex * 10 + taskIndex),
    taskVersion: SNAPSHOT,
    title: taskIndex === 0 ? "Outbound call" : "Outbound follow-up",
    dueAt: new Date(SNAPSHOT.getTime() + accountIndex * 60_000),
    attempt: taskIndex + 1,
    campaign: "property_management",
    lastDisposition: taskIndex === 0 ? null : "left_voicemail",
    company: `Account ${accountIndex}`,
    noteSnippet: null,
    startedAt: null,
    assignedTo: MEMBER_ID,
    createdAt: new Date(SNAPSHOT.getTime() - accountIndex * 60_000),
    contactId: uuid(30_000 + accountIndex),
    contactName: `Contact ${accountIndex}`,
    contactEmail: `contact${accountIndex}@example.com`,
    contactPhone: `+1404555${String(accountIndex).padStart(4, "0")}`,
    contactSource: "outbound",
    contactDoNotContact: false,
    contactDoNotContactAt: null,
    contactDoNotContactReason: null,
    accountKey: account.accountKey,
    accountId: uuid(accountIndex),
    accountName: `Account ${accountIndex}`,
    accountStatus: "ready_for_first_touch",
    accountSegment: "property_manager",
    accountPortalFit: null,
    accountFitScore: null,
    accountLastTouchAt: null,
    accountNextTouchAt: null,
    accountCreatedAt: account.accountCreatedAt,
  };
}

function fakeDatabase(results: unknown[]): {
  db: DatabaseClient;
  calls: () => number;
  queries: () => unknown[];
} {
  let callCount = 0;
  const executedQueries: unknown[] = [];
  const db = {
    execute: jest.fn((query: unknown) => {
      executedQueries.push(query);
      const result = results[callCount];
      callCount += 1;
      return Promise.resolve(result);
    }),
  } as unknown as DatabaseClient;
  return {
    db,
    calls: () => callCount,
    queries: () => executedQueries,
  };
}

describe("outbound queue account-level keyset pagination", () => {
  it("round-trips an opaque cursor and binds it to assignee, filters, and snapshot", () => {
    const filterFingerprint = outboundQueueFilterFingerprint({
      memberId: MEMBER_ID,
      filters: FILTERS,
    });
    const encoded = encodeOutboundQueueCursor({
      memberId: MEMBER_ID,
      filterFingerprint,
      snapshotAt: SNAPSHOT.toISOString(),
      accountCreatedAt: "2026-01-01T00:00:00.000Z",
      accountKey: `account:${uuid(1)}`,
      pageSize: 50,
      position: 50,
    });
    expect(encoded).not.toContain(MEMBER_ID);
    expect(decodeOutboundQueueCursor(encoded)).toEqual({
      version: 1,
      memberId: MEMBER_ID,
      filterFingerprint,
      snapshotAt: SNAPSHOT.toISOString(),
      accountCreatedAt: "2026-01-01T00:00:00.000Z",
      accountKey: `account:${uuid(1)}`,
      pageSize: 50,
      position: 50,
    });

    const parsed = parseOutboundQueueRequest({
      searchParams: new URLSearchParams({ cursor: encoded, direction: "next" }),
      defaultMemberId: MEMBER_ID,
      now: new Date("2026-08-10T16:00:00.000Z"),
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.query.snapshotAt.toISOString()).toBe(
        SNAPSHOT.toISOString(),
      );
      expect(parsed.query.offset).toBe(50);
    }

    const changedFilters = parseOutboundQueueRequest({
      searchParams: new URLSearchParams({
        cursor: encoded,
        direction: "next",
        campaign: "another_campaign",
      }),
      defaultMemberId: MEMBER_ID,
      now: new Date("2026-08-10T16:00:00.000Z"),
    });
    expect(changedFilters).toEqual(
      expect.objectContaining({ ok: false, field: "cursor" }),
    );
    expect(
      parseOutboundQueueRequest({
        searchParams: new URLSearchParams({
          cursor: encoded,
          direction: "next",
          limit: "25",
        }),
        defaultMemberId: MEMBER_ID,
        now: new Date("2026-08-10T16:00:00.000Z"),
      }),
    ).toEqual(expect.objectContaining({ ok: false, field: "cursor" }));
  });

  it("rejects malformed, duplicate, mismatched, and unbounded query input", () => {
    for (const params of [
      new URLSearchParams({ cursor: "not-a-cursor" }),
      new URLSearchParams({ direction: "previous" }),
      new URLSearchParams({ limit: "101" }),
      new URLSearchParams({ attempt: "0" }),
      new URLSearchParams({ due: "someday" }),
      new URLSearchParams({ has: "fax" }),
      new URLSearchParams({ offset: "500" }),
    ]) {
      expect(
        parseOutboundQueueRequest({
          searchParams: params,
          defaultMemberId: MEMBER_ID,
          now: SNAPSHOT,
        }),
      ).toEqual(expect.objectContaining({ ok: false }));
    }
    const duplicated = new URLSearchParams();
    duplicated.append("campaign", "one");
    duplicated.append("campaign", "two");
    expect(
      parseOutboundQueueRequest({
        searchParams: duplicated,
        defaultMemberId: MEMBER_ID,
        now: SNAPSHOT,
      }),
    ).toEqual(expect.objectContaining({ ok: false, field: "campaign" }));
    expect(escapedOutboundSearchPattern("100%_fit!now")).toBe(
      "%100!%!_fit!!now%",
    );
  });

  it("validates selection IDs independently from queue filters", () => {
    expect(
      parseOutboundQueueSelection(
        new URLSearchParams({
          accountId: uuid(1).toUpperCase(),
          taskId: uuid(10_001).toUpperCase(),
        }),
      ),
    ).toEqual({
      ok: true,
      selection: {
        accountId: uuid(1),
        taskId: uuid(10_001),
      },
    });

    const duplicateTask = new URLSearchParams({ accountId: uuid(1) });
    duplicateTask.append("taskId", uuid(10_001));
    duplicateTask.append("taskId", uuid(10_002));
    expect(parseOutboundQueueSelection(duplicateTask)).toEqual(
      expect.objectContaining({ ok: false, field: "taskId" }),
    );
    expect(
      parseOutboundQueueRequest({
        searchParams: new URLSearchParams({ taskId: "not-a-task" }),
        defaultMemberId: MEMBER_ID,
        now: SNAPSHOT,
      }),
    ).toEqual(expect.objectContaining({ ok: false, field: "taskId" }));
  });

  it("resolves a selection-only deep link to the task owner with account binding", async () => {
    const taskId = uuid(10_001);
    const accountId = uuid(1);
    const { db, calls, queries } = fakeDatabase([[{ memberId: MEMBER_ID }]]);

    await expect(
      resolveOutboundSelectedTaskMemberId(db, { taskId, accountId }),
    ).resolves.toBe(MEMBER_ID);
    expect(calls()).toBe(1);

    const built = new PgDialect().sqlToQuery(queries()[0] as SQL);
    expect(built.sql).toContain("task.\"status\" = 'open'");
    expect(built.sql).toContain('task."outbound_is_outbound" IS TRUE');
    expect(built.sql).toContain('coalesce(account."id", contact."id")::text =');
    expect(built.params).toEqual(expect.arrayContaining([taskId, accountId]));

    const missing = fakeDatabase([[]]);
    await expect(
      resolveOutboundSelectedTaskMemberId(missing.db, {
        taskId,
        accountId: null,
      }),
    ).resolves.toBeNull();
  });

  it("reports totals beyond 500, returns a bounded page, and never splits a multi-task account", async () => {
    const accounts = Array.from({ length: 51 }, (_, index) =>
      pageAccount(index + 1),
    );
    const details = accounts
      .slice(0, 50)
      .flatMap((_, index) =>
        index === 0
          ? [detailRow(index + 1), detailRow(index + 1, 1)]
          : [detailRow(index + 1)],
      );
    const { db, calls } = fakeDatabase([
      [
        {
          total: 650,
          dueNow: 120,
          overdue: 80,
          notStarted: 30,
          callbacksToday: 12,
          campaigns: ["property_management"],
          dispositions: ["left_voicemail"],
          attempts: ["1", "2"],
        },
      ],
      accounts,
      [
        {
          accountsTouched: 400,
          conversationsStarted: 100,
          qualifiedPartners: 25,
          activePartners: 10,
          avgFitScore: 77,
          portalFirst: 8,
          managedDirect: 7,
          hybrid: 6,
          notAFit: 4,
        },
      ],
      details,
    ]);

    const result = await loadOutboundQueuePage(db, {
      memberId: MEMBER_ID,
      limit: 50,
      direction: "next",
      cursor: null,
      snapshotAt: SNAPSHOT,
      offset: 0,
      filters: FILTERS,
    });

    expect(calls()).toBe(4);
    expect(result.total).toBe(650);
    expect(result.items).toHaveLength(50);
    expect(result.nextOffset).toBe(50);
    expect(result.nextCursor).not.toBeNull();
    expect(result.previousCursor).toBeNull();
    expect(result.items[0]?.tasks).toHaveLength(2);
    expect(result.items[0]?.taskIds).toEqual([
      pageAccount(1).primaryTaskId,
      detailRow(1, 1).taskId,
    ]);
    expect(new Set(result.items.map((item) => item.key)).size).toBe(50);
    expect(result.summary.dueNow).toBe(120);
    expect(result.facets.attempts).toEqual(["1", "2"]);
  });

  it("serializes every raw timestamp boundary as an ISO instant instead of a Date object", async () => {
    const filters: OutboundQueueFilters = { ...FILTERS, due: "today" };
    const filterFingerprint = outboundQueueFilterFingerprint({
      memberId: MEMBER_ID,
      filters,
    });
    const { db, queries } = fakeDatabase([
      [
        {
          total: 0,
          dueNow: 0,
          overdue: 0,
          notStarted: 0,
          callbacksToday: 0,
          campaigns: [],
          dispositions: [],
          attempts: [],
        },
      ],
      [],
      [],
    ]);

    await loadOutboundQueuePage(db, {
      memberId: MEMBER_ID,
      limit: 50,
      direction: "next",
      cursor: {
        version: 1,
        memberId: MEMBER_ID,
        filterFingerprint,
        snapshotAt: SNAPSHOT.toISOString(),
        accountCreatedAt: "2026-08-01T12:00:00.000Z",
        accountKey: `account:${uuid(1)}`,
        pageSize: 50,
        position: 50,
      },
      snapshotAt: SNAPSHOT,
      offset: 50,
      filters,
    });

    const dialect = new PgDialect();
    const builtQueries = queries().map((query) =>
      dialect.sqlToQuery(query as SQL),
    );
    expect(builtQueries).toHaveLength(3);
    expect(
      builtQueries.every((query) => query.sql.includes("::timestamptz")),
    ).toBe(true);
    expect(
      builtQueries
        .flatMap((query) => query.params)
        .some((value) => value instanceof Date),
    ).toBe(false);
    expect(
      builtQueries
        .flatMap((query) => query.params)
        .filter(
          (value): value is string =>
            typeof value === "string" && value.endsWith("Z"),
        ),
    ).toEqual(expect.arrayContaining([SNAPSHOT.toISOString()]));
  });

  it("keeps filtering, grouping, snapshot exclusion, and limits on the database side", () => {
    const query = readFileSync(
      join(ROOT, "apps/api/src/lib/outbound-queue-query.ts"),
      "utf8",
    );
    const route = readFileSync(
      join(ROOT, "apps/api/app/api/admin/outbound/queue/route.ts"),
      "utf8",
    );
    const migration = readFileSync(
      join(
        ROOT,
        "apps/api/src/db/migrations/0092_outbound_queue_projection.sql",
      ),
      "utf8",
    );

    expect(query).toContain(
      'task."created_at" <= ${timestamptzParam(query.snapshotAt)}',
    );
    expect(query).toContain('"matching_tasks" AS MATERIALIZED');
    expect(query).toContain('GROUP BY "accountKey"');
    expect(query).toContain("LIMIT ${query.limit + 1}");
    expect(query).toContain("LIMIT ${MAX_PAGE_TASK_ROWS + 1}");
    expect(query).toContain('FROM "base_tasks"');
    expect(query).not.toContain("MAX_SCAN");
    expect(route).not.toContain("MAX_SCAN");
    expect(route).toContain('isolationLevel: "repeatable read"');
    expect(route).toContain('accessMode: "read only"');
    expect(route).toContain("parseOutboundQueueSelection(url.searchParams)");
    expect(route).toContain("resolveOutboundSelectedTaskMemberId(db");
    expect(route).toContain(
      "defaultMemberId: selectedMemberId ?? config.defaultAssigneeMemberId",
    );

    expect(migration).toContain('"outbound_is_outbound" boolean');
    expect(migration).toContain('"outbound_projection_version" integer');
    expect(migration).toContain('"crm_tasks_outbound_projection_sync"');
    expect(migration).toContain('BEFORE INSERT OR UPDATE OF "notes"');
    expect(migration).toContain('NEW."outbound_projection_version" := 1');
    expect(migration).toContain('UPDATE "crm_tasks"');
    expect(migration).toContain('"crm_tasks_outbound_queue_campaign_idx"');
    expect(migration).toContain("gin_trgm_ops");
    expect(migration).not.toContain("DROP COLUMN");
    expect(query).toContain(
      'task."outbound_projection_version" IS DISTINCT FROM 1',
    );
    expect(query).toContain('"crm_task_note_timestamptz"');
    expect(query).toContain("function timestamptzParam");
    expect(query).not.toContain("<= ${query.snapshotAt}");
  });
});
