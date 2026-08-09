import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { buildTeamAuthRateLimitConflictUpdate } from "@/lib/team-auth-rate-limit";

describe("team authentication rate-limit SQL encoding", () => {
  it("column-encodes every timestamp inside the conflict expression", () => {
    const now = new Date("2026-08-09T08:14:18.378-04:00");
    const windowStartedAt = new Date("2026-08-09T12:00:00.000Z");
    const resetAt = new Date("2026-08-09T12:15:00.000Z");
    const update = buildTeamAuthRateLimitConflictUpdate({
      now,
      windowStartedAt,
      resetAt,
    });
    const dialect = new PgDialect();

    const params = (expression: SQL): unknown[] =>
      dialect.sqlToQuery(expression).params;

    expect(params(update.count)).toEqual(["2026-08-09T12:14:18.378Z"]);
    expect(params(update.windowStartedAt)).toEqual([
      "2026-08-09T12:14:18.378Z",
      "2026-08-09T12:00:00.000Z",
    ]);
    expect(params(update.resetAt)).toEqual([
      "2026-08-09T12:14:18.378Z",
      "2026-08-09T12:15:00.000Z",
    ]);

    for (const expression of [
      update.count,
      update.windowStartedAt,
      update.resetAt,
    ]) {
      expect(params(expression).some((value) => value instanceof Date)).toBe(
        false,
      );
    }
    expect(update.updatedAt).toBe(now);
  });
});
