export const VERIFIED_EMPTY_RECORDING_POLLS_REQUIRED = 5;
export const VERIFIED_EMPTY_RECORDING_POLL_INTERVAL_MS = 60_000;

export type RecordingPollObservation =
  | "verified_empty"
  | "recording_available"
  | "provider_unavailable";

export type RecordingEmptyPollPlan = {
  verifiedEmptyPolls: number;
  settleAbsent: boolean;
};

export function isVerifiedRecordingPollEligible(
  nextAttemptAt: Date | null,
  now: Date,
): boolean {
  return nextAttemptAt === null || nextAttemptAt.getTime() <= now.getTime();
}

export function nextVerifiedRecordingPollAt(now: Date): Date {
  return new Date(now.getTime() + VERIFIED_EMPTY_RECORDING_POLL_INTERVAL_MS);
}

export function readVerifiedEmptyRecordingPolls(
  payload: Record<string, unknown> | null,
): number {
  const value = payload?.["recordingEmptyPolls"];
  return Number.isInteger(value) &&
    typeof value === "number" &&
    value >= 0 &&
    value <= VERIFIED_EMPTY_RECORDING_POLLS_REQUIRED
    ? value
    : 0;
}

/**
 * Only a complete, successful provider response proving both the selected
 * call and its parent contain no recordings advances the durable counter.
 */
export function planRecordingEmptyPoll(
  previousVerifiedEmptyPolls: number,
  observation: RecordingPollObservation,
): RecordingEmptyPollPlan {
  const previous =
    Number.isInteger(previousVerifiedEmptyPolls) &&
    previousVerifiedEmptyPolls >= 0 &&
    previousVerifiedEmptyPolls <= VERIFIED_EMPTY_RECORDING_POLLS_REQUIRED
      ? previousVerifiedEmptyPolls
      : 0;
  if (observation !== "verified_empty") {
    return { verifiedEmptyPolls: previous, settleAbsent: false };
  }
  const verifiedEmptyPolls = Math.min(
    previous + 1,
    VERIFIED_EMPTY_RECORDING_POLLS_REQUIRED,
  );
  return {
    verifiedEmptyPolls,
    settleAbsent:
      verifiedEmptyPolls === VERIFIED_EMPTY_RECORDING_POLLS_REQUIRED,
  };
}
