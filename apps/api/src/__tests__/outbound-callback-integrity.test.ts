import {
  parseOutboundCallbackLocal,
  parseOutboundTaskMutationSuccess,
} from "../../../site/src/app/team/lib/outbound-mutation-result";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "22222222-2222-4222-8222-222222222222";
const CONTACT_ID = "33333333-3333-4333-8333-333333333333";
const NEXT_TASK_ID = "44444444-4444-4444-8444-444444444444";
const VERSION = "2026-08-09T12:00:00.000Z";
const CALLBACK_AT = "2026-08-11T18:00:00.000Z";

function callbackSuccess(dataPatch: Record<string, unknown> = {}) {
  return {
    ok: true,
    data: {
      taskId: TASK_ID,
      contactId: CONTACT_ID,
      disposition: "callback_requested",
      stopped: false,
      nextTaskId: NEXT_TASK_ID,
      nextDueAt: CALLBACK_AT,
      version: VERSION,
      ...dataPatch,
    },
    receipt: {
      operationId: "55555555-5555-4555-8555-555555555555",
      correlationId: "outbound-callback-test",
      actorId: ACTOR_ID,
      committedAt: "2026-08-09T12:00:00.000Z",
      auditEventId: "66666666-6666-4666-8666-666666666666",
      entityType: "crm_task",
      entityId: TASK_ID,
      version: VERSION,
    },
  };
}

const expectedCallback = {
  actorId: ACTOR_ID,
  taskId: TASK_ID,
  disposition: "callback_requested",
  callbackAt: CALLBACK_AT,
} as const;

describe("outbound callback integrity", () => {
  it("converts Eastern wall time to the exact UTC instant in both offsets", () => {
    expect(parseOutboundCallbackLocal("2026-08-11T14:00")).toBe(
      "2026-08-11T18:00:00.000Z",
    );
    expect(parseOutboundCallbackLocal("2026-01-11T14:00")).toBe(
      "2026-01-11T19:00:00.000Z",
    );
  });

  it("fails closed for nonexistent and repeated Eastern DST wall times", () => {
    expect(parseOutboundCallbackLocal("2026-03-08T02:30")).toBeNull();
    expect(parseOutboundCallbackLocal("2026-11-01T01:30")).toBeNull();
  });

  it("accepts a callback receipt only when it confirms the exact scheduled task and due date", () => {
    const parsed = parseOutboundTaskMutationSuccess(
      callbackSuccess(),
      expectedCallback,
    );

    expect(parsed).not.toBeNull();
    expect(parsed?.data).toMatchObject({
      stopped: false,
      nextTaskId: NEXT_TASK_ID,
      nextDueAt: CALLBACK_AT,
    });
  });

  it.each([
    ["missing due date", { nextDueAt: null }],
    ["different due date", { nextDueAt: "2026-08-11T18:01:00.000Z" }],
    ["missing next task", { nextTaskId: null }],
    ["invalid next task", { nextTaskId: "task-2" }],
    ["stopped cadence", { stopped: true }],
  ])("rejects a callback success with %s", (_name, dataPatch) => {
    expect(
      parseOutboundTaskMutationSuccess(
        callbackSuccess(dataPatch),
        expectedCallback,
      ),
    ).toBeNull();
  });

  it("rejects a due time that is no longer future at the commit boundary", () => {
    const value = callbackSuccess({ nextDueAt: CALLBACK_AT });
    value.receipt.committedAt = CALLBACK_AT;

    expect(
      parseOutboundTaskMutationSuccess(value, expectedCallback),
    ).toBeNull();
  });

  it("does not let a callback expectation leak into another disposition", () => {
    expect(
      parseOutboundTaskMutationSuccess(callbackSuccess(), {
        actorId: ACTOR_ID,
        taskId: TASK_ID,
        disposition: "connected",
        callbackAt: CALLBACK_AT,
      }),
    ).toBeNull();
  });
});
