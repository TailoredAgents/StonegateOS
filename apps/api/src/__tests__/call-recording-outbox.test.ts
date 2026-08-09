import {
  isVerifiedRecordingPollEligible,
  nextVerifiedRecordingPollAt,
  planRecordingEmptyPoll,
  readVerifiedEmptyRecordingPolls,
  VERIFIED_EMPTY_RECORDING_POLL_INTERVAL_MS,
  VERIFIED_EMPTY_RECORDING_POLLS_REQUIRED,
} from "@/lib/call-recording-outbox";
import { CALL_AI_REQUEST_TIMEOUT_MS } from "@/lib/call-analysis";
import {
  isRecordingProcessingLeaseActive,
  readRecordingProcessingLease,
  recordingDeleteIdentityMatches,
  RECORDING_PROCESSING_LEASE_MS,
} from "@/lib/call-recording-persistence";

describe("recording availability polling", () => {
  it("settles absent only after exactly five verified empty observations", () => {
    let count = 0;
    for (
      let index = 1;
      index <= VERIFIED_EMPTY_RECORDING_POLLS_REQUIRED;
      index += 1
    ) {
      const plan = planRecordingEmptyPoll(count, "verified_empty");
      count = plan.verifiedEmptyPolls;
      expect(count).toBe(index);
      expect(plan.settleAbsent).toBe(
        index === VERIFIED_EMPTY_RECORDING_POLLS_REQUIRED,
      );
    }
    expect(planRecordingEmptyPoll(count, "verified_empty")).toEqual({
      verifiedEmptyPolls: VERIFIED_EMPTY_RECORDING_POLLS_REQUIRED,
      settleAbsent: true,
    });
  });

  it("does not advance the dedicated counter on outage or nonempty results", () => {
    expect(planRecordingEmptyPoll(3, "provider_unavailable")).toEqual({
      verifiedEmptyPolls: 3,
      settleAbsent: false,
    });
    expect(planRecordingEmptyPoll(3, "recording_available")).toEqual({
      verifiedEmptyPolls: 3,
      settleAbsent: false,
    });
  });

  it("reads only a bounded integer from the dedicated payload field", () => {
    expect(readVerifiedEmptyRecordingPolls({ recordingEmptyPolls: 4 })).toBe(4);
    for (const payload of [
      null,
      {},
      { attempts: 5 },
      { recordingEmptyPolls: -1 },
      { recordingEmptyPolls: 6 },
      { recordingEmptyPolls: "5" },
    ]) {
      expect(readVerifiedEmptyRecordingPolls(payload)).toBe(0);
    }
  });

  it("allows only one empty observation per durable polling interval", () => {
    const due = new Date("2026-08-08T12:00:00.000Z");
    const next = nextVerifiedRecordingPollAt(due);
    expect(next.getTime() - due.getTime()).toBe(
      VERIFIED_EMPTY_RECORDING_POLL_INTERVAL_MS,
    );
    expect(isVerifiedRecordingPollEligible(null, due)).toBe(true);
    expect(isVerifiedRecordingPollEligible(due, due)).toBe(true);
    expect(isVerifiedRecordingPollEligible(next, due)).toBe(false);
  });
});

describe("recording deletion identity", () => {
  const target = {
    callRecordId: "5be63b91-ee12-46cd-901f-205a883bb63a",
    callSid: `CA${"1".repeat(32)}`,
    recordingSid: `RE${"2".repeat(32)}`,
  };

  it("depends only on stable call and recording identity", () => {
    expect(
      recordingDeleteIdentityMatches(target, {
        id: target.callRecordId,
        callSid: target.callSid,
        recordingSid: target.recordingSid,
        deletedAt: null,
      }),
    ).toBe(true);
  });

  it("rejects an identity swap or an already-deleted record", () => {
    for (const current of [
      {
        id: "fb178c05-91ea-43f9-8c18-939ed27b2266",
        callSid: target.callSid,
        recordingSid: target.recordingSid,
        deletedAt: null,
      },
      {
        id: target.callRecordId,
        callSid: `CA${"3".repeat(32)}`,
        recordingSid: target.recordingSid,
        deletedAt: null,
      },
      {
        id: target.callRecordId,
        callSid: target.callSid,
        recordingSid: `RE${"4".repeat(32)}`,
        deletedAt: null,
      },
      {
        id: target.callRecordId,
        callSid: target.callSid,
        recordingSid: target.recordingSid,
        deletedAt: new Date("2026-08-08T12:00:00.000Z"),
      },
    ]) {
      expect(recordingDeleteIdentityMatches(target, current)).toBe(false);
    }
  });
});

describe("recording processing lease", () => {
  const token = "1e826683-32bf-4543-a20b-2eaa37715647";
  const now = new Date("2026-08-08T12:00:00.000Z");
  const expiresAt = new Date(now.getTime() + RECORDING_PROCESSING_LEASE_MS);

  it("reads only a complete tokenized lease and treats equality as expired", () => {
    const lease = readRecordingProcessingLease({
      recordingProcessingLeaseToken: token,
      recordingProcessingLeaseExpiresAt: expiresAt.toISOString(),
    });
    expect(lease).toEqual({ token, expiresAt });
    expect(isRecordingProcessingLeaseActive(lease, now)).toBe(true);
    expect(isRecordingProcessingLeaseActive(lease, expiresAt)).toBe(false);

    for (const payload of [
      null,
      {},
      { recordingProcessingLeaseToken: token },
      {
        recordingProcessingLeaseToken: "not-a-token",
        recordingProcessingLeaseExpiresAt: expiresAt.toISOString(),
      },
      {
        recordingProcessingLeaseToken: token,
        recordingProcessingLeaseExpiresAt: "not-a-date",
      },
    ]) {
      expect(readRecordingProcessingLease(payload)).toBeNull();
    }
  });

  it("keeps the crash lease above the maximum bounded provider/model sequence", () => {
    const maximumSequentialModelTime = 3 * CALL_AI_REQUEST_TIMEOUT_MS;
    const maximumSequentialTwilioTime = 3 * 10_000;
    expect(RECORDING_PROCESSING_LEASE_MS).toBeGreaterThan(
      maximumSequentialModelTime + maximumSequentialTwilioTime,
    );
  });
});
