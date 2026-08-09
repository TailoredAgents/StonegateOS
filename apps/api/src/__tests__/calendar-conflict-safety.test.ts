import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  acquireScheduleConflictLock,
  buildScheduleInterval,
  decideScheduleConflictOverride,
  scheduleIntervalsOverlap,
  selectBlockingScheduleConflicts,
  type ScheduleConflict,
  type ScheduleConflictDecision,
} from "@/lib/appointment-schedule-conflicts";
import {
  countActiveCalendarFilters,
  filterCalendarEvents,
  parseCalendarFilters,
} from "../../../site/src/app/team/lib/calendar-filters";
import type { TeamMutationTransaction } from "@/lib/team-mutation";
import { insertCalendarMutationSuccessAudit } from "@/lib/calendar-mutation-audit";

const workspaceRoot = resolve(__dirname, "../../../..");
const read = (path: string): string =>
  readFileSync(resolve(workspaceRoot, path), "utf8");

function conflictDecision(): ScheduleConflictDecision {
  return {
    conflict: true,
    capacity: 1,
    overlappingCount: 1,
    fingerprint: "a".repeat(64),
    message:
      "That time overlaps Alex Customer - job (Jul 15, 2026, 9:00 AM-10:00 AM Eastern).",
    requiredAcknowledgement:
      "I acknowledge this schedule conflict with: Alex Customer - job (Jul 15, 2026, 9:00 AM-10:00 AM Eastern)",
    conflicts: [
      {
        id: "appointment:11111111-1111-4111-8111-111111111111",
        kind: "appointment",
        appointmentId: "11111111-1111-4111-8111-111111111111",
        title: "Alex Customer - job",
        startAt: "2026-07-15T13:00:00.000Z",
        endAt: "2026-07-15T14:00:00.000Z",
      },
    ],
  };
}

describe("Calendar half-open schedule intervals", () => {
  it("treats exact boundaries as available and true overlap as a conflict", () => {
    const nineToTen = buildScheduleInterval(
      new Date("2026-07-15T13:00:00.000Z"),
      60,
    );
    const tenToEleven = buildScheduleInterval(
      new Date("2026-07-15T14:00:00.000Z"),
      60,
    );
    const nineThirty = buildScheduleInterval(
      new Date("2026-07-15T13:30:00.000Z"),
      60,
    );

    expect(scheduleIntervalsOverlap(nineToTen, tenToEleven)).toBe(false);
    expect(scheduleIntervalsOverlap(nineToTen, nineThirty)).toBe(true);
    expect(nineToTen.endAt.toISOString()).toBe("2026-07-15T14:00:00.000Z");
  });

  it("takes a transaction-scoped advisory lock for concurrent decisions", async () => {
    const execute = jest.fn().mockResolvedValue([]);
    await acquireScheduleConflictLock({
      execute,
    } as unknown as TeamMutationTransaction);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("uses peak concurrency instead of rejecting sequential overlaps", () => {
    const proposed = buildScheduleInterval(
      new Date("2026-07-15T13:00:00.000Z"),
      120,
    );
    const conflict = (
      id: string,
      startAt: string,
      endAt: string,
    ): ScheduleConflict => ({
      id,
      kind: "appointment",
      appointmentId: id,
      title: id,
      startAt,
      endAt,
    });
    const sequential = [
      conflict("first", "2026-07-15T13:00:00.000Z", "2026-07-15T14:00:00.000Z"),
      conflict(
        "second",
        "2026-07-15T14:00:00.000Z",
        "2026-07-15T15:00:00.000Z",
      ),
    ];
    expect(selectBlockingScheduleConflicts(sequential, proposed, 2)).toEqual({
      maximumConcurrent: 1,
      conflicts: [],
    });

    const simultaneous = [
      ...sequential,
      conflict(
        "overlapping",
        "2026-07-15T13:30:00.000Z",
        "2026-07-15T14:30:00.000Z",
      ),
    ];
    expect(selectBlockingScheduleConflicts(simultaneous, proposed, 2)).toEqual({
      maximumConcurrent: 2,
      conflicts: simultaneous,
    });
  });
});

describe("Calendar conflict override contract", () => {
  it("rejects an unacknowledged conflict", () => {
    expect(decideScheduleConflictOverride(conflictDecision(), {})).toEqual(
      expect.objectContaining({ ok: false, code: "schedule_conflict" }),
    );
  });

  it("requires a useful reason and the exact current written conflicts", () => {
    const decision = conflictDecision();
    expect(
      decideScheduleConflictOverride(decision, {
        reason: "short",
        acknowledgement: decision.requiredAcknowledgement,
        fingerprint: decision.fingerprint,
      }),
    ).toEqual(
      expect.objectContaining({
        ok: false,
        code: "schedule_conflict_override_reason_required",
      }),
    );
    expect(
      decideScheduleConflictOverride(decision, {
        reason: "A second staffed crew is confirmed.",
        acknowledgement: `${decision.requiredAcknowledgement} stale`,
        fingerprint: decision.fingerprint,
      }),
    ).toEqual(
      expect.objectContaining({
        ok: false,
        code: "schedule_conflict_override_stale",
      }),
    );
    expect(
      decideScheduleConflictOverride(decision, {
        reason: "A second staffed crew is confirmed.",
        acknowledgement: decision.requiredAcknowledgement,
        fingerprint: decision.fingerprint,
      }),
    ).toEqual({
      ok: true,
      overridden: true,
      reason: "A second staffed crew is confirmed.",
    });
  });
});

describe("Calendar transaction-bound audit evidence", () => {
  it("propagates an audit insert failure so the caller transaction rolls back", async () => {
    const insert = jest.fn(() => ({
      values: jest.fn().mockRejectedValue(new Error("audit unavailable")),
    }));
    await expect(
      insertCalendarMutationSuccessAudit(
        { insert } as unknown as TeamMutationTransaction,
        {
          actor: {
            type: "human",
            id: "11111111-1111-4111-8111-111111111111",
            role: "owner",
            sessionId: "session-123",
            authMethod: "team_session",
          },
          action: "appointment.rescheduled",
          entityType: "appointment",
          entityId: "22222222-2222-4222-8222-222222222222",
          requiredPermissions: ["appointments.update"],
        },
      ),
    ).rejects.toThrow("audit unavailable");
  });
});

describe("Calendar URL filters", () => {
  const events = [
    {
      id: "db:one",
      source: "db" as const,
      status: "confirmed",
      crewMemberIds: ["crew-one"],
    },
    {
      id: "google:two",
      source: "google" as const,
      status: "confirmed",
      crewMemberIds: [],
    },
    {
      id: "db:three",
      source: "db" as const,
      status: "canceled",
      crewMemberIds: ["crew-two"],
    },
  ];

  it("normalizes safe copied-URL values and ignores malformed values", () => {
    expect(
      parseCalendarFilters({
        status: "confirmed",
        crew: "crew-one",
        source: "db",
        conflict: "only",
      }),
    ).toEqual({
      status: "confirmed",
      crewMemberId: "crew-one",
      source: "db",
      conflictsOnly: true,
    });
    expect(
      parseCalendarFilters({ status: "<script>", source: "other" }),
    ).toEqual({
      status: null,
      crewMemberId: null,
      source: null,
      conflictsOnly: false,
    });
  });

  it("combines status, crew, source, and conflict filters deterministically", () => {
    const filters = parseCalendarFilters({
      status: "confirmed",
      crew: "crew-one",
      source: "db",
      conflict: "only",
    });
    expect(countActiveCalendarFilters(filters)).toBe(4);
    expect(
      filterCalendarEvents(events, new Set(["db:one"]), filters).map(
        (event) => event.id,
      ),
    ).toEqual(["db:one"]);
  });
});

describe("Calendar route enforcement source contracts", () => {
  it("encodes overlap-boundary dates through their timestamp columns", () => {
    const source = read(
      "apps/api/src/lib/appointment-schedule-conflicts.ts",
    );

    expect(source).toContain(
      "sql.param(\n          interval.startAt,\n          appointments.startAt,\n        )",
    );
    expect(source).toContain(
      "sql.param(\n                interval.startAt,\n                appointmentHolds.startAt,\n              )",
    );
  });

  it("serializes both CRM booking and rescheduling before conflict inspection", () => {
    for (const path of [
      "apps/api/app/api/admin/booking/book/route.ts",
      "apps/api/app/api/web/appointments/[id]/reschedule/route.ts",
    ]) {
      const source = read(path);
      expect(source).toContain("acquireScheduleConflictLock(tx)");
      expect(source.indexOf("acquireScheduleConflictLock(tx)")).toBeLessThan(
        source.indexOf("inspectScheduleConflicts(tx"),
      );
      expect(source).toContain("appointments.override_conflicts");
      expect(source).toContain("requiredAcknowledgement");
    }
  });

  it("excludes the appointment being rescheduled and protects public details", () => {
    const source = read(
      "apps/api/app/api/web/appointments/[id]/reschedule/route.ts",
    );
    expect(source).toContain("excludeAppointmentId: appointmentId");
    expect(source).toContain("const exposeDetails = isAdmin");
    expect(source).toContain("Only an authorized team member can override");
    expect(source).toContain("scheduleConflictOverridden");
  });

  it("co-commits Calendar mutation audits through each business transaction", () => {
    for (const path of [
      "apps/api/app/api/admin/booking/book/route.ts",
      "apps/api/app/api/web/appointments/[id]/reschedule/route.ts",
    ]) {
      const source = read(path);
      expect(source).toContain("insertCalendarMutationSuccessAudit(tx");
    }

    const status = read("apps/api/app/api/appointments/[id]/status/route.ts");
    expect(status).toContain("mutation.audit.insertSuccess(tx");
    expect(status).toContain("completeTeamMutationIdempotency(");
    const statusAuditIndex = status.indexOf("mutation.audit.insertSuccess(tx");
    expect(statusAuditIndex).toBeGreaterThan(0);
    expect(
      status.indexOf(
        "await completeTeamMutationIdempotency(",
        statusAuditIndex,
      ),
    ).toBeGreaterThan(statusAuditIndex);

    const notes = read("apps/api/app/api/appointments/[id]/notes/route.ts");
    expect(notes).toContain("mutation.audit.insertSuccess(tx");
    expect(notes).toContain("completeTeamMutationIdempotency(");
    const auditIndex = notes.indexOf("mutation.audit.insertSuccess(tx");
    expect(auditIndex).toBeGreaterThan(0);
    expect(
      notes.indexOf("await completeTeamMutationIdempotency(", auditIndex),
    ).toBeGreaterThan(auditIndex);
  });
});
