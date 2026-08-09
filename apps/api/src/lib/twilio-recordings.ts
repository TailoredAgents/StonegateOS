import {
  deleteTwilioProviderRecording,
  downloadTwilioProviderRecording,
  listTwilioProviderRecordings,
  type TwilioRecordingDeleteResult,
  type TwilioRecordingDownloadResult,
  type TwilioRecordingListResult,
} from "@/lib/twilio-provider";

/**
 * A successful result with `empty: true` means Twilio answered with a valid,
 * complete empty collection. Every unavailable or malformed state is a typed
 * failure and must remain retryable/visible to the worker.
 */
export async function listTwilioRecordingsForCall(
  callSid: string,
): Promise<TwilioRecordingListResult> {
  return listTwilioProviderRecordings(callSid);
}

export async function downloadTwilioRecordingAudio(
  recordingSid: string,
): Promise<TwilioRecordingDownloadResult> {
  return downloadTwilioProviderRecording(recordingSid);
}

/**
 * Provider 404 is an explicit idempotent success (`alreadyAbsent: true`).
 * Configuration, transport, malformed, rate-limit, and provider failures are
 * never converted into a successful deletion.
 */
export async function deleteTwilioRecording(
  recordingSid: string,
): Promise<TwilioRecordingDeleteResult> {
  return deleteTwilioProviderRecording(recordingSid);
}
