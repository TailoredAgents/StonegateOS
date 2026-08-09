import {
  decodeSalesActivityCursor,
  encodeSalesActivityCursor,
  paginateSalesActivityKeys,
  SALES_ACTIVITY_DEFAULT_ACTIONS,
  salesActivityFilterHash,
  type SalesActivityKey,
} from "@/lib/sales-activity-query";
import {
  parseTeamSalesActivityPayload,
  TEAM_SALES_ACTIVITY_ACTIONS,
} from "../../../site/src/app/team/sales-activity-page";

const SNAPSHOT_AT = "2026-08-08T16:00:00.000Z";
const CREATED_AT = "2026-08-08T15:00:00.123456Z";
const FILTER_HASH = salesActivityFilterHash({
  rangeDays: 7,
  actorId: null,
  actions: ["message.received"],
});

function id(sequence: number): string {
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

function keys(count: number): SalesActivityKey[] {
  return Array.from({ length: count }, (_, index) => ({
    id: id(index + 1),
    createdAt: CREATED_AT,
  }));
}

function event(key: SalesActivityKey) {
  return {
    id: key.id,
    actor: {
      type: "human",
      id: id(900),
      role: "sales",
      label: "Sales member",
      name: "Taylor",
    },
    action: "message.received",
    entityType: "conversation_thread",
    outcome: "succeeded",
    context: {
      contactId: id(901),
      leadId: null,
      threadId: id(902),
      callRecordId: null,
      taskId: null,
      channel: "sms",
      actionType: null,
      terminalOutcome: null,
    },
    createdAt: key.createdAt,
  };
}

describe("Sales Activity snapshot cursor", () => {
  it("keeps the API and strict Site action catalogs aligned with call outcomes", () => {
    expect(TEAM_SALES_ACTIVITY_ACTIONS).toEqual(SALES_ACTIVITY_DEFAULT_ACTIONS);
    expect(TEAM_SALES_ACTIVITY_ACTIONS).toEqual(
      expect.arrayContaining([
        "sales.escalation.call.dispatched",
        "sales.escalation.call.connected",
        "sales.escalation.call.not_connected",
        "sales.escalation.call.not_dispatched",
        "sales.escalation.call.reconciliation_required",
      ]),
    );
  });

  it("round-trips one exact-key opaque cursor without operational metadata", () => {
    const cursor = {
      version: 1 as const,
      limit: 50,
      direction: "older" as const,
      filterHash: FILTER_HASH,
      windowStart: "2026-08-01T16:00:00.000Z",
      snapshotAt: SNAPSHOT_AT,
      snapshotCreatedAt: CREATED_AT,
      snapshotId: id(50),
      anchorCreatedAt: CREATED_AT,
      anchorId: id(1),
    };
    const encoded = encodeSalesActivityCursor(cursor);
    expect(encoded).not.toContain(CREATED_AT);
    expect(decodeSalesActivityCursor(encoded)).toEqual(cursor);
    expect(decodeSalesActivityCursor(`${encoded}!`)).toBeNull();
    expect(decodeSalesActivityCursor("a".repeat(1_601))).toBeNull();

    const extraKey = Buffer.from(
      JSON.stringify({ ...cursor, messageBody: "private" }),
      "utf8",
    ).toString("base64url");
    expect(decodeSalesActivityCursor(extraKey)).toBeNull();
  });

  it("uses createdAt and id for deterministic Older/Newer pages", () => {
    const source = keys(5).reverse();
    const newest = paginateSalesActivityKeys({
      keys: source,
      filterHash: FILTER_HASH,
      snapshotAt: SNAPSHOT_AT,
      rangeDays: 7,
      limit: 2,
    });
    expect(newest.ok).toBe(true);
    if (!newest.ok) return;
    expect(newest.keys.map((key) => key.id)).toEqual([id(5), id(4)]);
    expect(newest.page).toEqual(
      expect.objectContaining({
        position: "newest",
        totalAtSnapshot: 5,
        hasOlder: true,
        hasNewer: false,
      }),
    );

    const olderCursor = decodeSalesActivityCursor(newest.page.olderCursor!);
    const older = paginateSalesActivityKeys({
      keys: source,
      filterHash: FILTER_HASH,
      snapshotAt: SNAPSHOT_AT,
      rangeDays: 7,
      limit: 2,
      cursor: olderCursor,
    });
    expect(older.ok).toBe(true);
    if (!older.ok) return;
    expect(older.keys.map((key) => key.id)).toEqual([id(3), id(2)]);
    expect(older.page.hasOlder).toBe(true);
    expect(older.page.hasNewer).toBe(true);

    const newerCursor = decodeSalesActivityCursor(older.page.newerCursor!);
    const returnedNewest = paginateSalesActivityKeys({
      keys: source,
      filterHash: FILTER_HASH,
      snapshotAt: SNAPSHOT_AT,
      rangeDays: 7,
      limit: 2,
      cursor: newerCursor,
    });
    expect(returnedNewest.ok).toBe(true);
    if (!returnedNewest.ok) return;
    expect(returnedNewest.keys.map((key) => key.id)).toEqual([id(5), id(4)]);
    expect(returnedNewest.page.position).toBe("history");
    expect(returnedNewest.page.hasNewer).toBe(false);
  });

  it("keeps the original newest snapshot when concurrent rows are inserted", () => {
    const newest = paginateSalesActivityKeys({
      keys: keys(4),
      filterHash: FILTER_HASH,
      snapshotAt: SNAPSHOT_AT,
      rangeDays: 7,
      limit: 2,
    });
    expect(newest.ok).toBe(true);
    if (!newest.ok) return;
    const cursor = decodeSalesActivityCursor(newest.page.olderCursor!);

    const sameTimestampInsert = { id: id(5), createdAt: CREATED_AT };
    const laterInsert = {
      id: id(6),
      createdAt: "2026-08-08T16:00:00.000001Z",
    };
    const older = paginateSalesActivityKeys({
      keys: [...keys(4), sameTimestampInsert, laterInsert],
      filterHash: FILTER_HASH,
      snapshotAt: SNAPSHOT_AT,
      rangeDays: 7,
      limit: 2,
      cursor,
    });
    expect(older.ok).toBe(true);
    if (!older.ok) return;
    expect(older.keys.map((key) => key.id)).toEqual([id(2), id(1)]);
    expect(older.page.totalAtSnapshot).toBe(4);
    expect(older.keys).not.toContainEqual(sameTimestampInsert);
    expect(older.keys).not.toContainEqual(laterInsert);
  });

  it("reports deleted snapshot or anchor boundaries as stale", () => {
    const newest = paginateSalesActivityKeys({
      keys: keys(3),
      filterHash: FILTER_HASH,
      snapshotAt: SNAPSHOT_AT,
      rangeDays: 7,
      limit: 2,
    });
    expect(newest.ok).toBe(true);
    if (!newest.ok) return;
    const cursor = decodeSalesActivityCursor(newest.page.olderCursor!);
    expect(cursor).not.toBeNull();

    expect(
      paginateSalesActivityKeys({
        keys: [keys(3)[0]!, keys(3)[2]!],
        filterHash: FILTER_HASH,
        snapshotAt: SNAPSHOT_AT,
        rangeDays: 7,
        limit: 2,
        cursor,
      }),
    ).toEqual({ ok: false, error: "cursor_out_of_range" });
  });

  it("accepts only the strict privacy-safe API payload and page metadata", () => {
    const result = paginateSalesActivityKeys({
      keys: keys(3),
      filterHash: FILTER_HASH,
      snapshotAt: SNAPSHOT_AT,
      rangeDays: 7,
      limit: 2,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = {
      ok: true,
      rangeDays: 7,
      since: result.page.windowStart,
      memberId: null,
      actions: ["message.received"],
      events: result.keys.map(event),
      page: result.page,
      supervisor: {},
    };
    expect(parseTeamSalesActivityPayload(payload)).not.toBeNull();
    expect(
      parseTeamSalesActivityPayload({
        ...payload,
        events: [{ ...payload.events[0], meta: { phone: "+15555550100" } }],
      }),
    ).toBeNull();
    expect(
      parseTeamSalesActivityPayload({
        ...payload,
        page: { ...payload.page, offset: 50 },
      }),
    ).toBeNull();
  });
});
