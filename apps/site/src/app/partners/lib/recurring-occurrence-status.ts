/** A recurring evaluator's outcome is not a live job status. Prefer the current
 * account-scoped job projection once the occurrence has become a real request. */
export function recurringOccurrenceStatus(occurrence: {
  state: string;
  currentJobStatus?: string | null;
}): string {
  return occurrence.currentJobStatus ?? occurrence.state;
}

export function recurringOccurrenceNeedsAttention(occurrence: {
  state: string;
  currentJobStatus?: string | null;
}): boolean {
  return [
    "requested",
    "under_review",
    "approval_needed",
    "review",
    "failed",
  ].includes(recurringOccurrenceStatus(occurrence));
}
