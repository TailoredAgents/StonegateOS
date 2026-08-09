export type OutboundImportTransactionRunner<Transaction> = <Result>(
  work: (transaction: Transaction) => Promise<Result>,
) => Promise<Result>;

/**
 * Keeps the import executor injectable for rollback contract tests while the
 * production runner remains the database driver's real transaction method.
 */
export async function runOutboundImportAtomic<Transaction, Result>(
  runTransaction: OutboundImportTransactionRunner<Transaction>,
  work: (transaction: Transaction) => Promise<Result>,
): Promise<Result> {
  return runTransaction(work);
}
