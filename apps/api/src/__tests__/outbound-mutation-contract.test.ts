import {
  nextOutboundTaskVersion,
  outboundBulkVersion,
  outboundTaskCampaign,
  parseOutboundBulkPayload,
  parseOutboundDispositionPayload,
  parseOutboundStartPayload,
  parseOutboundTaskVersion,
  requireOutboundExpectedVersion,
} from "@/lib/outbound-mutation-contract";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  buildPartnerSincePreservationValue,
  insertPartnerConversionAudit,
} from "../../app/api/admin/outbound/disposition/route";
import type {
  TeamMutationContext,
  TeamMutationTransaction,
} from "@/lib/team-mutation";

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID_2 = "22222222-2222-4222-8222-222222222222";
const MEMBER_ID = "33333333-3333-4333-8333-333333333333";
const VERSION = "2026-08-09T12:00:00.000Z";
const VERSION_2 = "2026-08-09T12:01:00.000Z";

describe("outbound mutation input and version contracts", () => {
  it("writes a bounded partner conversion event with the verified operation identity", async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const transaction = {
      insert: () => ({
        values: (value: Record<string, unknown>) => {
          inserted.push(value);
          return Promise.resolve();
        },
      }),
    } as unknown as TeamMutationTransaction;
    const mutation = {
      policy: {
        principalTypes: ["human"],
        requiredPermissions: ["outbound.write"],
        risk: "normal",
        requiresIdempotency: true,
        auditAction: "outbound.disposition",
      },
      actor: {
        type: "human",
        id: MEMBER_ID,
        role: "sales",
        label: "Salesperson",
        sessionId: "44444444-4444-4444-8444-444444444444",
        authMethod: "team_session",
      },
      principalType: "human",
      operationId: "55555555-5555-4555-8555-555555555555",
      correlationId: "outbound-test-correlation",
      idempotencyKeyHash: "a".repeat(64),
      expectedVersion: VERSION,
      audit: {
        insertSuccess: () =>
          Promise.resolve({
            auditEventId: "unused",
            committedAt: VERSION,
          }),
      },
    } satisfies TeamMutationContext;

    await insertPartnerConversionAudit(transaction, mutation, {
      contactId: "66666666-6666-4666-8666-666666666666",
      partnerAccountId: "77777777-7777-4777-8777-777777777777",
      partnerType: "portal_first",
      previousPartnerStatus: "prospect",
      committedAt: new Date(VERSION),
    });

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      actorType: "human",
      actorId: MEMBER_ID,
      actorRole: "sales",
      sessionId: "44444444-4444-4444-8444-444444444444",
      authMethod: "team_session",
      correlationId: "outbound-test-correlation",
      requiredPermissions: ["outbound.write"],
      outcome: "succeeded",
      surface: "/team/sales/outbound",
      idempotencyKeyHash: "a".repeat(64),
      action: "partner.converted",
      entityType: "contact",
      entityId: "66666666-6666-4666-8666-666666666666",
      createdAt: new Date(VERSION),
      meta: {
        correlationId: "outbound-test-correlation",
        operationId: "55555555-5555-4555-8555-555555555555",
        contactId: "66666666-6666-4666-8666-666666666666",
        partnerAccountId: "77777777-7777-4777-8777-777777777777",
        partnerType: "portal_first",
        before: { partnerStatus: "prospect" },
        after: {
          partnerStatus: "partner",
          accountStatus: "active_partner",
        },
      },
    });
    expect(inserted[0]?.["id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });

  it("column-encodes the preserved partner conversion instant", () => {
    const now = new Date("2026-08-09T08:15:35.849-04:00");
    const query = new PgDialect().sqlToQuery(
      buildPartnerSincePreservationValue(now),
    );

    expect(query.sql.toLowerCase()).toContain("coalesce");
    expect(query.params).toEqual(["2026-08-09T12:15:35.849Z"]);
    expect(query.params.some((value) => value instanceof Date)).toBe(false);
  });

  it("accepts only the exact start shape and canonical task identity", () => {
    expect(
      parseOutboundStartPayload({ taskId: TASK_ID.toUpperCase() }),
    ).toEqual({ taskId: TASK_ID });
    expect(() =>
      parseOutboundStartPayload({ taskId: TASK_ID, actor: "owner" }),
    ).toThrow("unsupported fields");
    expect(() => parseOutboundStartPayload({ taskId: "task-1" })).toThrow(
      "taskId is invalid",
    );
  });

  it("uses a closed disposition catalog and rejects hidden fields", () => {
    expect(
      parseOutboundDispositionPayload(
        { taskId: TASK_ID, disposition: "LEFT_VOICEMAIL", recap: " Left VM " },
        new Date("2026-08-09T12:00:00.000Z"),
      ),
    ).toMatchObject({
      taskId: TASK_ID,
      disposition: "left_voicemail",
      recap: "Left VM",
      callbackAt: null,
    });
    expect(() =>
      parseOutboundDispositionPayload({
        taskId: TASK_ID,
        disposition: "whatever_the_client_sent",
      }),
    ).toThrow("supported outbound disposition");
    expect(() =>
      parseOutboundDispositionPayload({
        taskId: TASK_ID,
        disposition: "dnc",
        doNotContact: false,
      }),
    ).toThrow("unsupported fields");
  });

  it("binds callbacks to callback_requested and a bounded future instant", () => {
    const now = new Date("2026-08-09T12:00:00.000Z");
    expect(
      parseOutboundDispositionPayload(
        {
          taskId: TASK_ID,
          disposition: "callback_requested",
          callbackAt: "2026-08-10T13:00:00.000Z",
        },
        now,
      ).callbackAt?.toISOString(),
    ).toBe("2026-08-10T13:00:00.000Z");
    expect(() =>
      parseOutboundDispositionPayload(
        { taskId: TASK_ID, disposition: "callback_requested" },
        now,
      ),
    ).toThrow("must be scheduled in the future");
    expect(() =>
      parseOutboundDispositionPayload(
        {
          taskId: TASK_ID,
          disposition: "connected",
          callbackAt: "2026-08-10T13:00:00.000Z",
        },
        now,
      ),
    ).toThrow("only allowed for Callback requested");
  });

  it("rejects oversized recaps and noncanonical timestamps", () => {
    expect(() =>
      parseOutboundDispositionPayload({
        taskId: TASK_ID,
        disposition: "connected",
        recap: "x".repeat(4_001),
      }),
    ).toThrow("4,000 characters or fewer");
    expect(() => parseOutboundTaskVersion("2026-08-09T12:00:00Z")).toThrow(
      "version is invalid",
    );
  });

  it("requires exact, unique, versioned bulk task references", () => {
    expect(
      parseOutboundBulkPayload({
        action: "assign_start",
        assignedToMemberId: MEMBER_ID,
        tasks: [
          { id: TASK_ID, version: VERSION },
          { id: TASK_ID_2, version: VERSION_2 },
        ],
      }),
    ).toMatchObject({
      action: "assign_start",
      assignedToMemberId: MEMBER_ID,
      snoozePreset: null,
    });
    expect(() =>
      parseOutboundBulkPayload({
        action: "start",
        tasks: [
          { id: TASK_ID, version: VERSION },
          { id: TASK_ID, version: VERSION },
        ],
      }),
    ).toThrow("same task more than once");
    expect(() =>
      parseOutboundBulkPayload({
        action: "start",
        assignedToMemberId: MEMBER_ID,
        tasks: [{ id: TASK_ID, version: VERSION }],
      }),
    ).toThrow("only allowed for an assignment action");
  });

  it("enforces the exact 500-task boundary without truncation", () => {
    const tasks = Array.from({ length: 501 }, (_value, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      version: VERSION,
    }));
    expect(() => parseOutboundBulkPayload({ action: "start", tasks })).toThrow(
      "between 1 and 500",
    );
  });

  it("builds an order-independent selection version and detects stale headers", () => {
    const left = outboundBulkVersion([
      { id: TASK_ID, version: VERSION },
      { id: TASK_ID_2, version: VERSION_2 },
    ]);
    const right = outboundBulkVersion([
      { id: TASK_ID_2, version: VERSION_2 },
      { id: TASK_ID, version: VERSION },
    ]);
    expect(left).toBe(right);
    expect(left).toMatch(/^outbound-bulk:[0-9a-f]{64}$/u);
    expect(() => requireOutboundExpectedVersion(null, VERSION)).toThrow(
      "If-Match is required",
    );
    expect(() => requireOutboundExpectedVersion(VERSION_2, VERSION)).toThrow(
      "changed after it was loaded",
    );
  });

  it("makes task timestamp versions strictly monotonic under same-tick races", () => {
    const current = new Date(VERSION);
    expect(
      nextOutboundTaskVersion(current, new Date(VERSION)).toISOString(),
    ).toBe("2026-08-09T12:00:00.001Z");
    expect(
      nextOutboundTaskVersion(
        current,
        new Date("2026-08-09T12:00:01.000Z"),
      ).toISOString(),
    ).toBe("2026-08-09T12:00:01.000Z");
  });

  it("matches exact structured campaign keys without SQL wildcard semantics", () => {
    expect(outboundTaskCampaign("kind=outbound\ncampaign=foo")).toBe("foo");
    expect(outboundTaskCampaign("kind=outbound\ncampaign=foobar")).toBe(
      "foobar",
    );
    expect(outboundTaskCampaign("kind=outbound\ncampaign=fall_%_2026")).toBe(
      "fall_%_2026",
    );
    expect(outboundTaskCampaign("kind=outbound\nattempt=1")).toBe(
      "property_management",
    );
  });
});
