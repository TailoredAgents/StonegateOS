/** Exercise the production worker's module resolution without a database or provider. */
import assert from "node:assert/strict";
import { Socket } from "node:net";
import { registerApiAliases } from "./lib/register-api-aliases";
import type { TeamMutationTransaction } from "../apps/api/src/lib/team-mutation";

async function main() {
  assert.equal(process.env["NODE_ENV"], "production");
  let networkAttempts = 0;
  const originalConnect = Object.getOwnPropertyDescriptor(
    Socket.prototype,
    "connect",
  );
  assert.ok(originalConnect);
  Socket.prototype.connect = function () {
    networkAttempts += 1;
    throw new Error(
      "Network access is forbidden in the owner alert runtime test.",
    );
  };
  registerApiAliases();
  try {
    const {
      prepareStaffNotificationDispatch,
      finalizeStaffNotificationDispatch,
    } = await import("../apps/api/src/lib/staff-notification-operations");
    const {
      staffNotificationOperations,
      partnerOwnerAlertGroups,
      outboxEvents,
    } = await import("../apps/api/src/db");
    const now = new Date("2026-09-20T00:00:00Z");
    const ownerId = "10000000-0000-4000-8000-000000000001";
    const groupId = "10000000-0000-4000-8000-000000000002";
    const operation = {
      id: "10000000-0000-4000-8000-000000000003",
      subjectType: "partner_owner_test",
      subjectId: groupId,
      appointmentId: null,
      contactId: null,
      recipientTeamMemberId: ownerId,
      recipientAddress: "+12025550123",
      channel: "sms",
      kind: "partner_request_test",
      state: "requested",
      body: "TEST only",
      attemptCount: 0,
      providerRequestKey: "owner-runtime-local-test",
    };
    const settings = {
      id: "owner",
      enabled: true,
      enabledSince: now,
      ownerTeamMemberId: ownerId,
      phoneSnapshot: operation.recipientAddress,
      revision: 2,
    };
    const owner = {
      id: ownerId,
      name: "Local test owner",
      phone: operation.recipientAddress,
      active: true,
      role: "owner",
      permissions: ["partners.accounts.read", "appointments.read"],
      grant: [],
      deny: [],
    };
    let selected: unknown[][] = [];
    const writes: Array<{ table: unknown; values: Record<string, unknown> }> =
      [];
    const tx = {
      select() {
        const rows = selected.shift();
        assert.ok(
          rows,
          "Every real query must have an explicit local fixture.",
        );
        const query = {
          from() {
            return query;
          },
          innerJoin() {
            return query;
          },
          where() {
            return query;
          },
          for() {
            return query;
          },
          limit() {
            return query;
          },
          then(resolve: (value: unknown[]) => unknown) {
            return Promise.resolve(rows).then(resolve);
          },
        };
        return query;
      },
      update(table: unknown) {
        let values: Record<string, unknown> = {};
        const query = {
          set(value: Record<string, unknown>) {
            values = value;
            writes.push({ table, values });
            if (table === staffNotificationOperations)
              Object.assign(operation, value);
            return query;
          },
          where() {
            return query;
          },
          returning() {
            return Promise.resolve(
              table === staffNotificationOperations
                ? [operation]
                : [{ id: groupId }],
            );
          },
          then(resolve: (value: unknown[]) => unknown) {
            return Promise.resolve([]).then(resolve);
          },
        };
        return query;
      },
      insert(table: unknown) {
        return {
          values(values: Record<string, unknown>) {
            writes.push({ table, values });
            return Promise.resolve();
          },
        };
      },
    } as unknown as TeamMutationTransaction;
    const input = { operationId: operation.id, outboxEventId: groupId, now };
    selected = [
      [{ ...operation }],
      [{ id: ownerId, active: true, phoneE164: operation.recipientAddress }],
      [settings],
      [owner],
    ];
    assert.equal(
      (await prepareStaffNotificationDispatch(tx, input)).kind,
      "dispatch",
    );
    assert.equal(operation.state, "dispatched");
    assert.equal(operation.attemptCount, 1);
    assert.equal(selected.length, 0);

    // Use the real accepted-group finalizer so its reminder import and persistence execute.
    operation.subjectType = "partner_owner_group";
    operation.kind = "partner_request_initial";
    selected = [[{ ...operation }]];
    assert.deepEqual(
      await finalizeStaffNotificationDispatch(tx, {
        ...input,
        result: {
          ok: true,
          provider: "local-test",
          deliveryCertainty: "accepted",
          providerMessageId: "local-receipt",
        },
      }),
      { kind: "processed", state: "succeeded" },
    );
    const groupWrite = writes.find(
      (write) => write.table === partnerOwnerAlertGroups,
    );
    assert.equal(groupWrite?.values["initialAcceptedAt"], now);
    assert.equal(
      (groupWrite?.values["reminderDueAt"] as Date).getTime(),
      now.getTime() + 30 * 60_000,
    );
    const reminder = writes.find((write) => write.table === outboxEvents);
    assert.equal(reminder?.values["type"], "partner.owner_alert.reminder");
    assert.deepEqual(reminder?.values["payload"], { groupId });
    assert.equal(
      (reminder?.values["nextAttemptAt"] as Date).getTime(),
      now.getTime() + 30 * 60_000,
    );
    assert.equal(operation.state, "succeeded");
    selected = [[{ ...operation }]];
    assert.deepEqual(await prepareStaffNotificationDispatch(tx, input), {
      kind: "terminal",
      state: "succeeded",
    });
    assert.equal(operation.attemptCount, 1);
    assert.equal(
      writes.filter((write) => write.table === outboxEvents).length,
      1,
    );
    assert.equal(networkAttempts, 0);
    console.log(
      JSON.stringify({
        ownerWorkerRuntime: "passed",
        preparation: true,
        acceptedFinalization: true,
        terminalReplay: true,
        networkAttempts,
      }),
    );
  } finally {
    Object.defineProperty(Socket.prototype, "connect", originalConnect);
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
