/** Admission closes synchronously; already accepted work settles before cleanup. */
export function createWorkerTaskDrain() {
  let stopping = false;
  const pending = new Set<Promise<void>>();
  return {
    get stopping() { return stopping; },
    stop() { stopping = true; },
    async run(work: () => Promise<void>): Promise<boolean> {
      if (stopping) return false;
      const task = Promise.resolve().then(work);
      pending.add(task);
      try { await task; return true; }
      finally { pending.delete(task); }
    },
    async drained(): Promise<void> {
      if (!stopping) throw new Error("Close task admission before draining");
      await Promise.allSettled([...pending]);
    },
  };
}
