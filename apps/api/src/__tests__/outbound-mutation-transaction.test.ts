import type { TeamMutationTransaction } from "@/lib/team-mutation";
import { runOutboundMutationAtomic } from "@/lib/outbound-mutation-transaction";

type State = {
  taskStatus: "open" | "completed";
  contactDnc: boolean;
  reminders: string[];
  audits: string[];
  receipts: string[];
};

function transactionalHarness(initial: State) {
  let committed = structuredClone(initial);
  const run = async <Result>(
    work: (tx: TeamMutationTransaction) => Promise<Result>,
  ): Promise<Result> => {
    const draft = structuredClone(committed);
    const tx = { state: draft } as unknown as TeamMutationTransaction;
    const result = await work(tx);
    committed = draft;
    return result;
  };
  return { run, current: () => structuredClone(committed) };
}

function stateOf(tx: TeamMutationTransaction): State {
  return (tx as unknown as { state: State }).state;
}

describe("outbound mutation atomic boundary", () => {
  const initial: State = {
    taskStatus: "open",
    contactDnc: false,
    reminders: ["old-task"],
    audits: [],
    receipts: [],
  };

  it("commits task, contact, reminder, audit, and receipt together", async () => {
    const harness = transactionalHarness(initial);
    await runOutboundMutationAtomic(harness.run, async (tx) => {
      await Promise.resolve();
      const state = stateOf(tx);
      state.taskStatus = "completed";
      state.contactDnc = true;
      state.reminders = [];
      state.audits.push("outbound.disposition");
      state.receipts.push("idempotency-terminal-response");
      return "ok";
    });
    expect(harness.current()).toEqual({
      taskStatus: "completed",
      contactDnc: true,
      reminders: [],
      audits: ["outbound.disposition"],
      receipts: ["idempotency-terminal-response"],
    });
  });

  it("rolls every linked write back when audit persistence fails", async () => {
    const harness = transactionalHarness(initial);
    await expect(
      runOutboundMutationAtomic(harness.run, async (tx) => {
        await Promise.resolve();
        const state = stateOf(tx);
        state.taskStatus = "completed";
        state.contactDnc = true;
        state.reminders = [];
        throw new Error("audit_insert_failed");
      }),
    ).rejects.toThrow("audit_insert_failed");
    expect(harness.current()).toEqual(initial);
  });

  it("cannot false-succeed when the durable replay receipt fails", async () => {
    const harness = transactionalHarness(initial);
    let responseClaimed = false;
    await expect(
      runOutboundMutationAtomic(harness.run, async (tx) => {
        await Promise.resolve();
        const state = stateOf(tx);
        state.taskStatus = "completed";
        state.audits.push("outbound.disposition");
        throw new Error("idempotency_completion_failed");
      }).then(() => {
        responseClaimed = true;
      }),
    ).rejects.toThrow("idempotency_completion_failed");
    expect(responseClaimed).toBe(false);
    expect(harness.current()).toEqual(initial);
  });
});
