import type { TeamMutationTransaction } from "@/lib/team-mutation";

export type OutboundMutationTransactionRunner = <Result>(
  work: (tx: TeamMutationTransaction) => Promise<Result>,
) => Promise<Result>;

/**
 * Single testable commit boundary for outbound task, linked-record, reminder,
 * audit, receipt, and idempotency writes.
 */
export function runOutboundMutationAtomic<Result>(
  runTransaction: OutboundMutationTransactionRunner,
  work: (tx: TeamMutationTransaction) => Promise<Result>,
): Promise<Result> {
  return runTransaction(work);
}
