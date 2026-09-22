import type { DatabaseClient } from "@/db";
import { callRecords, outboxEvents } from "@/db";
import {
  claimRecordingProcessingLease,
  deferRecordingProcessingLease,
  persistRecordingTranscript,
  recordVerifiedEmptyRecordingPoll,
  RECORDING_PROCESSING_LEASE_MS,
  RECORDING_PROCESSING_MAX_ATTEMPTS,
  RECORDING_PROCESSING_RETRY_EXHAUSTED,
} from "@/lib/call-recording-persistence";

const startedAt = new Date("2026-09-16T04:00:00.000Z");
const callSid = `CA${"1".repeat(32)}`;
const recordingSid = `RE${"2".repeat(32)}`;
const eventId = "89ee03eb-3f64-4f1d-a2b2-676d0cd2d842";
const callId = "7c6de4d6-ecab-48a4-a2f2-c389ae930fc6";

// Stateful query adapter exercises the real lease/checkpoint transitions.
// No database or external provider is contacted by these regression tests.
function recordingStore(attempts = 0) {
  const event: Record<string, any> = {
    id: eventId,
    payload: { callSid },
    attempts,
    processedAt: null,
    quarantinedAt: null,
    nextAttemptAt: null,
    lastError: null,
  };
  const call: Record<string, any> = {
    id: callId,
    callSid,
    parentCallSid: null,
    contactId: null,
    assignedTo: null,
    noteTaskId: null,
    processedAt: null,
    recordingSid: null,
    transcript: null,
  };
  function rowFor(table: unknown) {
    if (table === outboxEvents) return event;
    if (table === callRecords) return call;
    throw new Error("unexpected_table");
  }
  const tx = {
    insert: () => ({ values: async () => undefined }),
    select: () => ({
      from: (table: unknown) => {
        const query = {
          where: () => query,
          for: () => query,
          limit: async () => [{ ...rowFor(table) }],
        };
        return query;
      },
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => {
          Object.assign(rowFor(table), patch);
          return {
            returning: async () => [{ id: rowFor(table).id }],
          };
        },
      }),
    }),
  };
  const db = {
    transaction: async (run: (value: typeof tx) => Promise<unknown>) => run(tx),
  } as unknown as DatabaseClient;
  return { db, event, call };
}

describe("recording processing spend bounds", () => {
  it("allows analysis retries after four successful recording-readiness polls", async () => {
    const { db, event } = recordingStore();
    let now = startedAt;
    for (let poll = 1; poll <= 4; poll++) {
      const lease = await claimRecordingProcessingLease({
        db, outboxEventId: eventId, callSid, now,
      });
      if (lease.kind !== "claimed") throw new Error("expected_claim");
      expect(await recordVerifiedEmptyRecordingPoll({
        db, outboxEventId: eventId, callRecordId: callId,
        leaseToken: lease.leaseToken, now,
      })).toEqual({ kind: "retry", verifiedEmptyPolls: poll });
      expect(event.attempts).toBe(0);
      now = new Date(now.getTime() + 60_000);
    }
    const firstAnalysis = await claimRecordingProcessingLease({
      db, outboxEventId: eventId, callSid, now,
    });
    if (firstAnalysis.kind !== "claimed") throw new Error("expected_claim");
    const retryAt = new Date(now.getTime() + 60_000);
    expect(await deferRecordingProcessingLease({
      db, outboxEventId: eventId, leaseToken: firstAnalysis.leaseToken,
      error: "analysis_failed", nextAttemptAt: retryAt,
    })).toBe("deferred");
    expect(event.attempts).toBe(1);
    expect(await claimRecordingProcessingLease({
      db, outboxEventId: eventId, callSid, now: retryAt,
    })).toMatchObject({ kind: "claimed" });
    expect(event.attempts).toBe(2);
    expect(event.quarantinedAt).toBeNull();
  });

  it("settles five verified empty observations despite an interleaved provider failure", async () => {
    const { db, event, call } = recordingStore();
    let now = startedAt;
    for (let poll = 1; poll <= 5; poll++) {
      if (poll === 3) {
        const failedLease = await claimRecordingProcessingLease({
          db, outboxEventId: eventId, callSid, now,
        });
        if (failedLease.kind !== "claimed") throw new Error("expected_claim");
        now = new Date(now.getTime() + 60_000);
        expect(await deferRecordingProcessingLease({
          db, outboxEventId: eventId, leaseToken: failedLease.leaseToken,
          error: "recording_list_provider_unavailable", nextAttemptAt: now,
        })).toBe("deferred");
        expect(event.payload.recordingEmptyPolls).toBe(2);
      }
      const lease = await claimRecordingProcessingLease({
        db, outboxEventId: eventId, callSid, now,
      });
      if (lease.kind !== "claimed") throw new Error("expected_claim");
      expect(await recordVerifiedEmptyRecordingPoll({
        db, outboxEventId: eventId, callRecordId: callId,
        leaseToken: lease.leaseToken, now,
      })).toEqual({ kind: poll === 5 ? "settled" : "retry", verifiedEmptyPolls: poll });
      expect(event.attempts).toBe(poll < 3 ? 0 : 1);
      now = new Date(now.getTime() + 60_000);
    }
    expect(event.processedAt).toBeInstanceOf(Date);
    expect(call.processedAt).toBeInstanceOf(Date);
    expect(event.nextAttemptAt).toBeNull();
    expect(event.quarantinedAt).toBeNull();
  });

  it("quarantines repeated downstream failures after five durable attempts", async () => {
    const { db, event } = recordingStore();
    let now = startedAt;
    for (let attempt = 1; attempt <= RECORDING_PROCESSING_MAX_ATTEMPTS; attempt++) {
      const lease = await claimRecordingProcessingLease({
        db, outboxEventId: eventId, callSid, now,
      });
      if (lease.kind !== "claimed") throw new Error("expected_claim");
      expect(event.attempts).toBe(attempt);
      now = new Date(now.getTime() + 60_000);
      const result = await deferRecordingProcessingLease({
        db,
        outboxEventId: eventId,
        leaseToken: lease.leaseToken,
        error: "analysis_failed",
        nextAttemptAt: now,
      });
      expect(result).toBe(
        attempt === RECORDING_PROCESSING_MAX_ATTEMPTS ? "quarantined" : "deferred",
      );
      expect(event.attempts).toBe(attempt);
    }
    expect(event.processedAt).toBeNull();
    expect(event.nextAttemptAt).toBeNull();
    expect(event.lastError).toBe("analysis_failed");
    expect(event.quarantineReason).toBe(RECORDING_PROCESSING_RETRY_EXHAUSTED);
    expect(await claimRecordingProcessingLease({
      db, outboxEventId: eventId, callSid, now,
    })).toEqual({ kind: "already_terminal" });
  });

  it("blocks legacy runaway jobs before they can enter another provider attempt", async () => {
    const { db, event } = recordingStore(40_000);
    event.lastError = "transcription_failed";
    expect(await claimRecordingProcessingLease({
      db, outboxEventId: eventId, callSid, now: startedAt,
    })).toEqual({ kind: "quarantined" });
    expect(event.attempts).toBe(40_000);
    expect(event.payload.recordingProcessingLeaseToken).toBeUndefined();
    expect(event.lastError).toBe("transcription_failed");
  });

  it("counts a worker crash before a checkpoint toward the same bound", async () => {
    const { db, event } = recordingStore(RECORDING_PROCESSING_MAX_ATTEMPTS - 1);
    const lease = await claimRecordingProcessingLease({
      db, outboxEventId: eventId, callSid, now: startedAt,
    });
    expect(lease.kind).toBe("claimed");
    expect(event.attempts).toBe(RECORDING_PROCESSING_MAX_ATTEMPTS);
    const afterCrash = new Date(startedAt.getTime() + RECORDING_PROCESSING_LEASE_MS);
    expect(await claimRecordingProcessingLease({
      db, outboxEventId: eventId, callSid, now: afterCrash,
    })).toEqual({ kind: "quarantined" });
  });
});

describe("paid transcription checkpoint", () => {
  it("retains the recording-bound transcript when analysis fails and returns it on retry", async () => {
    const { db, call, event } = recordingStore();
    const lease = await claimRecordingProcessingLease({
      db, outboxEventId: eventId, callSid, now: startedAt,
    });
    if (lease.kind !== "claimed") throw new Error("expected_claim");
    expect(await persistRecordingTranscript({
      db,
      outboxEventId: eventId,
      leaseToken: lease.leaseToken,
      callRecordId: callId,
      recording: { callSid, recordingSid, durationSec: 120, createdAt: startedAt },
      transcript: "Customer asks to schedule a pickup.",
      now: startedAt,
    })).toBe("committed");
    expect(call.processedAt).toBeNull();
    expect(event.processedAt).toBeNull();
    const retryAt = new Date(startedAt.getTime() + 60_000);
    await deferRecordingProcessingLease({
      db, outboxEventId: eventId, leaseToken: lease.leaseToken,
      error: "analysis_failed", nextAttemptAt: retryAt,
    });
    const retry = await claimRecordingProcessingLease({
      db, outboxEventId: eventId, callSid, now: retryAt,
    });
    expect(retry).toMatchObject({
      kind: "claimed",
      call: { recordingSid, transcript: "Customer asks to schedule a pickup." },
    });
  });

  it("does not checkpoint a response after another worker has taken the lease", async () => {
    const { db, call } = recordingStore();
    const lease = await claimRecordingProcessingLease({
      db, outboxEventId: eventId, callSid, now: startedAt,
    });
    if (lease.kind !== "claimed") throw new Error("expected_claim");
    await claimRecordingProcessingLease({
      db, outboxEventId: eventId, callSid,
      now: new Date(startedAt.getTime() + RECORDING_PROCESSING_LEASE_MS),
    });
    expect(await persistRecordingTranscript({
      db, outboxEventId: eventId, leaseToken: lease.leaseToken,
      callRecordId: callId,
      recording: { callSid, recordingSid, durationSec: 120, createdAt: startedAt },
      transcript: "Stale response",
    })).toBe("lease_lost");
    expect(call.transcript).toBeNull();
  });
});
