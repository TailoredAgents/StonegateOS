import {
  SALES_ACTIVITY_DEFAULT_ACTIONS,
  encodeSalesActivityCursor,
  parseSalesActivityQuery,
  salesActivityFilterHash,
} from "@/lib/sales-activity-query";

const MEMBER_ID = "123e4567-e89b-42d3-a456-426614174000";
const SNAPSHOT_AT = "2026-08-08T16:00:00.000Z";
const WINDOW_START = "2026-08-01T16:00:00.000Z";
const CREATED_AT = "2026-08-08T15:00:00.123456Z";
const EVENT_ID = "00000000-0000-4000-8000-000000000100";

function cursorFor(input?: {
  actorId?: string | null;
  actions?: string[];
  limit?: number;
  rangeDays?: number;
}): string {
  const actorId = input?.actorId ?? null;
  const actions = input?.actions ?? [...SALES_ACTIVITY_DEFAULT_ACTIONS];
  const limit = input?.limit ?? 50;
  const rangeDays = input?.rangeDays ?? 7;
  return encodeSalesActivityCursor({
    version: 1,
    limit,
    direction: "older",
    filterHash: salesActivityFilterHash({ rangeDays, actorId, actions }),
    windowStart: WINDOW_START,
    snapshotAt: SNAPSHOT_AT,
    snapshotCreatedAt: CREATED_AT,
    snapshotId: EVENT_ID,
    anchorCreatedAt: CREATED_AT,
    anchorId: EVENT_ID,
  });
}

describe("Sales Activity query", () => {
  it("returns explicit newest-page defaults and a canonical filter hash", () => {
    const result = parseSalesActivityQuery(new URLSearchParams());
    expect(result).toEqual({
      ok: true,
      query: {
        limit: 50,
        rangeDays: 7,
        actorId: null,
        actions: [...SALES_ACTIVITY_DEFAULT_ACTIONS],
        filterHash: salesActivityFilterHash({
          rangeDays: 7,
          actorId: null,
          actions: SALES_ACTIVITY_DEFAULT_ACTIONS,
        }),
        cursor: null,
      },
    });
  });

  it("accepts one bounded, recognized filter set and its matching cursor", () => {
    const actions = ["message.received", "message.queued"];
    const cursor = cursorFor({
      actorId: MEMBER_ID,
      actions,
      limit: 200,
      rangeDays: 7,
    });
    const result = parseSalesActivityQuery(
      new URLSearchParams({
        limit: "200",
        rangeDays: "7",
        memberId: MEMBER_ID,
        actions: actions.join(","),
        cursor,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.query.limit).toBe(200);
    expect(result.query.rangeDays).toBe(7);
    expect(result.query.actorId).toBe(MEMBER_ID);
    expect(result.query.actions).toEqual(actions);
    expect(result.query.cursor?.direction).toBe("older");
  });

  it.each([
    { limit: "0" },
    { limit: "201" },
    { limit: "2.5" },
    { rangeDays: "91" },
    { memberId: "not-a-member" },
    { actions: "message.received,unknown.action" },
    { actions: "message.received,message.received" },
    { cursor: "" },
    { cursor: "not-a-cursor" },
    { offset: "0" },
    { unexpected: "1" },
  ])("rejects malformed or unsupported filters: %o", (query) => {
    expect(parseSalesActivityQuery(new URLSearchParams(query))).toEqual(
      expect.objectContaining({ ok: false }),
    );
  });

  it("rejects duplicate and ambiguous aliases", () => {
    const duplicate = new URLSearchParams();
    duplicate.append("limit", "50");
    duplicate.append("limit", "50");
    expect(parseSalesActivityQuery(duplicate)).toEqual(
      expect.objectContaining({ ok: false, field: "limit" }),
    );

    expect(
      parseSalesActivityQuery(
        new URLSearchParams({ memberId: MEMBER_ID, actorId: MEMBER_ID }),
      ),
    ).toEqual(expect.objectContaining({ ok: false, field: "memberId" }));
  });

  it("rejects valid cursors when the page size or canonical filters differ", () => {
    const cursor = cursorFor();
    for (const query of [
      { cursor, limit: "25" },
      { cursor, rangeDays: "14" },
      { cursor, memberId: MEMBER_ID },
      { cursor, actions: "message.received" },
    ]) {
      expect(parseSalesActivityQuery(new URLSearchParams(query))).toEqual(
        expect.objectContaining({ ok: false, field: "cursor" }),
      );
    }
  });

  it("binds the cursor time window to the selected range", () => {
    const malformedWindow = encodeSalesActivityCursor({
      version: 1,
      limit: 50,
      direction: "older",
      filterHash: salesActivityFilterHash({
        rangeDays: 7,
        actorId: null,
        actions: SALES_ACTIVITY_DEFAULT_ACTIONS,
      }),
      windowStart: "2026-08-02T16:00:00.000Z",
      snapshotAt: SNAPSHOT_AT,
      snapshotCreatedAt: CREATED_AT,
      snapshotId: EVENT_ID,
      anchorCreatedAt: CREATED_AT,
      anchorId: EVENT_ID,
    });
    expect(
      parseSalesActivityQuery(new URLSearchParams({ cursor: malformedWindow })),
    ).toEqual(expect.objectContaining({ ok: false, field: "cursor" }));
  });
});
