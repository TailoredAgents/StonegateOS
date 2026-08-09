import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { DatabaseClient } from "@/db";
import {
  auditLogs,
  callCoaching,
  callRecords,
  contacts,
  crmPipeline,
  crmTasks,
  outboxEvents,
} from "@/db";
import type { CallAnalysis } from "@/lib/call-analysis";
import type { CallCoachingResult } from "@/lib/call-coaching";
import {
  nextVerifiedRecordingPollAt,
  planRecordingEmptyPoll,
  readVerifiedEmptyRecordingPolls,
} from "@/lib/call-recording-outbox";
import type { TeamMutationTransaction } from "@/lib/team-mutation";

type RecordingIdentity = {
  callSid: string;
  recordingSid: string;
  durationSec: number | null;
  createdAt: Date | null;
};

export const RECORDING_PROCESSING_LEASE_MS = 10 * 60_000;
const RECORDING_PROCESSING_LEASE_TOKEN_KEY = "recordingProcessingLeaseToken";
const RECORDING_PROCESSING_LEASE_EXPIRES_KEY =
  "recordingProcessingLeaseExpiresAt";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type RecordingProcessingLease = {
  token: string;
  expiresAt: Date;
};

export function readRecordingProcessingLease(
  payload: Record<string, unknown> | null,
): RecordingProcessingLease | null {
  const token = payload?.[RECORDING_PROCESSING_LEASE_TOKEN_KEY];
  const expiresAtRaw = payload?.[RECORDING_PROCESSING_LEASE_EXPIRES_KEY];
  if (
    typeof token !== "string" ||
    !UUID_PATTERN.test(token) ||
    typeof expiresAtRaw !== "string"
  ) {
    return null;
  }
  const expiresAt = new Date(expiresAtRaw);
  return Number.isNaN(expiresAt.getTime()) ? null : { token, expiresAt };
}

export function isRecordingProcessingLeaseActive(
  lease: RecordingProcessingLease | null,
  now: Date,
): boolean {
  return Boolean(lease && lease.expiresAt.getTime() > now.getTime());
}

function payloadWithoutRecordingProcessingLease(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...payload };
  delete next[RECORDING_PROCESSING_LEASE_TOKEN_KEY];
  delete next[RECORDING_PROCESSING_LEASE_EXPIRES_KEY];
  return next;
}

type RecordingProcessingCall = {
  id: string;
  callSid: string;
  parentCallSid: string | null;
  contactId: string | null;
  assignedTo: string | null;
  noteTaskId: string | null;
  processedAt: Date | null;
};

type LockedRecordingProcessingLease =
  | {
      kind: "owned";
      event: {
        payload: Record<string, unknown>;
        attempts: number | null;
      };
    }
  | { kind: "lease_lost" }
  | { kind: "already_terminal" };

async function lockRecordingProcessingLease(
  tx: TeamMutationTransaction,
  input: { outboxEventId: string; leaseToken: string },
): Promise<LockedRecordingProcessingLease> {
  const [event] = await tx
    .select({
      payload: outboxEvents.payload,
      attempts: outboxEvents.attempts,
      processedAt: outboxEvents.processedAt,
      quarantinedAt: outboxEvents.quarantinedAt,
    })
    .from(outboxEvents)
    .where(eq(outboxEvents.id, input.outboxEventId))
    .for("update")
    .limit(1);
  if (!event || event.processedAt || event.quarantinedAt) {
    return { kind: "already_terminal" };
  }
  const lease = readRecordingProcessingLease(event.payload);
  if (!lease || lease.token !== input.leaseToken) {
    return { kind: "lease_lost" };
  }
  return {
    kind: "owned",
    event: { payload: event.payload, attempts: event.attempts },
  };
}

async function completeRecordingProcessingEvent(
  tx: TeamMutationTransaction,
  input: {
    outboxEventId: string;
    leaseToken: string;
    event: { payload: Record<string, unknown>; attempts: number | null };
    now: Date;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  const [completed] = await tx
    .update(outboxEvents)
    .set({
      payload: payloadWithoutRecordingProcessingLease(
        input.payload ?? input.event.payload,
      ),
      attempts: (input.event.attempts ?? 0) + 1,
      processedAt: input.now,
      nextAttemptAt: null,
      lastError: null,
    })
    .where(
      and(
        eq(outboxEvents.id, input.outboxEventId),
        isNull(outboxEvents.processedAt),
        isNull(outboxEvents.quarantinedAt),
        sql`${outboxEvents.payload} ->> ${RECORDING_PROCESSING_LEASE_TOKEN_KEY} = ${input.leaseToken}`,
      ),
    )
    .returning({ id: outboxEvents.id });
  if (!completed) throw new Error("recording_processing_event_claim_lost");
}

export async function claimRecordingProcessingLease(input: {
  db: DatabaseClient;
  outboxEventId: string;
  callSid: string;
  now?: Date;
}): Promise<
  | {
      kind: "claimed";
      leaseToken: string;
      leaseExpiresAt: Date;
      call: RecordingProcessingCall;
    }
  | { kind: "deferred"; retryAt: Date }
  | { kind: "call_missing" }
  | { kind: "already_terminal" }
> {
  const now = input.now ?? new Date();
  return input.db.transaction(async (tx) => {
    const [event] = await tx
      .select({
        payload: outboxEvents.payload,
        attempts: outboxEvents.attempts,
        processedAt: outboxEvents.processedAt,
        quarantinedAt: outboxEvents.quarantinedAt,
        nextAttemptAt: outboxEvents.nextAttemptAt,
      })
      .from(outboxEvents)
      .where(eq(outboxEvents.id, input.outboxEventId))
      .for("update")
      .limit(1);
    if (!event || event.processedAt || event.quarantinedAt) {
      return { kind: "already_terminal" as const };
    }
    const currentLease = readRecordingProcessingLease(event.payload);
    if (isRecordingProcessingLeaseActive(currentLease, now) && currentLease) {
      return { kind: "deferred" as const, retryAt: currentLease.expiresAt };
    }
    if (
      event.nextAttemptAt instanceof Date &&
      event.nextAttemptAt.getTime() > now.getTime()
    ) {
      return { kind: "deferred" as const, retryAt: event.nextAttemptAt };
    }

    const [call] = await tx
      .select({
        id: callRecords.id,
        callSid: callRecords.callSid,
        parentCallSid: callRecords.parentCallSid,
        contactId: callRecords.contactId,
        assignedTo: callRecords.assignedTo,
        noteTaskId: callRecords.noteTaskId,
        processedAt: callRecords.processedAt,
      })
      .from(callRecords)
      .where(eq(callRecords.callSid, input.callSid))
      .for("update")
      .limit(1);
    if (!call) return { kind: "call_missing" as const };
    if (call.processedAt) {
      const [completed] = await tx
        .update(outboxEvents)
        .set({
          payload: payloadWithoutRecordingProcessingLease(event.payload),
          attempts: (event.attempts ?? 0) + 1,
          processedAt: now,
          nextAttemptAt: null,
          lastError: null,
        })
        .where(
          and(
            eq(outboxEvents.id, input.outboxEventId),
            isNull(outboxEvents.processedAt),
            isNull(outboxEvents.quarantinedAt),
          ),
        )
        .returning({ id: outboxEvents.id });
      if (!completed) throw new Error("recording_processing_event_claim_lost");
      return { kind: "already_terminal" as const };
    }

    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(
      now.getTime() + RECORDING_PROCESSING_LEASE_MS,
    );
    const payload = {
      ...payloadWithoutRecordingProcessingLease(event.payload),
      [RECORDING_PROCESSING_LEASE_TOKEN_KEY]: leaseToken,
      [RECORDING_PROCESSING_LEASE_EXPIRES_KEY]: leaseExpiresAt.toISOString(),
    };
    const [claimed] = await tx
      .update(outboxEvents)
      .set({ payload, nextAttemptAt: leaseExpiresAt })
      .where(
        and(
          eq(outboxEvents.id, input.outboxEventId),
          isNull(outboxEvents.processedAt),
          isNull(outboxEvents.quarantinedAt),
        ),
      )
      .returning({ id: outboxEvents.id });
    if (!claimed) throw new Error("recording_processing_lease_claim_lost");
    return {
      kind: "claimed" as const,
      leaseToken,
      leaseExpiresAt,
      call,
    };
  });
}

export async function deferRecordingProcessingLease(input: {
  db: DatabaseClient;
  outboxEventId: string;
  leaseToken: string;
  error: string;
  nextAttemptAt: Date;
}): Promise<"deferred" | "lease_lost" | "already_terminal"> {
  return input.db.transaction(async (tx) => {
    const lease = await lockRecordingProcessingLease(tx, input);
    if (lease.kind !== "owned") return lease.kind;
    const [deferred] = await tx
      .update(outboxEvents)
      .set({
        payload: payloadWithoutRecordingProcessingLease(lease.event.payload),
        attempts: (lease.event.attempts ?? 0) + 1,
        nextAttemptAt: input.nextAttemptAt,
        lastError: input.error,
      })
      .where(
        and(
          eq(outboxEvents.id, input.outboxEventId),
          isNull(outboxEvents.processedAt),
          isNull(outboxEvents.quarantinedAt),
          sql`${outboxEvents.payload} ->> ${RECORDING_PROCESSING_LEASE_TOKEN_KEY} = ${input.leaseToken}`,
        ),
      )
      .returning({ id: outboxEvents.id });
    if (!deferred) throw new Error("recording_processing_defer_claim_lost");
    return "deferred" as const;
  });
}

async function lockCall(
  tx: TeamMutationTransaction,
  callRecordId: string,
): Promise<typeof callRecords.$inferSelect | null> {
  const [call] = await tx
    .select()
    .from(callRecords)
    .where(eq(callRecords.id, callRecordId))
    .for("update")
    .limit(1);
  return call ?? null;
}

async function ensureDeleteEvent(
  tx: TeamMutationTransaction,
  input: {
    callSid: string;
    recordingSid: string;
    dueAt: Date;
    now: Date;
  },
): Promise<void> {
  const [existing] = await tx
    .select({ id: outboxEvents.id })
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.type, "call.recording.delete"),
        isNull(outboxEvents.processedAt),
        isNull(outboxEvents.quarantinedAt),
        sql`${outboxEvents.payload} ->> 'callSid' = ${input.callSid}`,
        sql`${outboxEvents.payload} ->> 'recordingSid' = ${input.recordingSid}`,
      ),
    )
    .limit(1);
  if (existing?.id) return;
  await tx.insert(outboxEvents).values({
    type: "call.recording.delete",
    payload: {
      callSid: input.callSid,
      recordingSid: input.recordingSid,
    },
    nextAttemptAt: input.dueAt,
    createdAt: input.now,
  });
}

async function insertRecordingAudit(
  tx: TeamMutationTransaction,
  input: {
    action: string;
    outcome: "succeeded" | "failed";
    callRecordId: string;
    meta: Record<string, unknown>;
    now: Date;
  },
): Promise<void> {
  await tx.insert(auditLogs).values({
    actorType: "worker",
    actorId: null,
    actorRole: null,
    actorLabel: "outbox",
    authMethod: "service",
    outcome: input.outcome,
    action: input.action,
    entityType: "call_record",
    entityId: input.callRecordId,
    meta: input.meta,
    createdAt: input.now,
  });
}

export async function recordVerifiedEmptyRecordingPoll(input: {
  db: DatabaseClient;
  outboxEventId: string;
  callRecordId: string;
  leaseToken: string;
  now?: Date;
}): Promise<
  | { kind: "retry"; verifiedEmptyPolls: number }
  | { kind: "settled"; verifiedEmptyPolls: number }
  | { kind: "already_terminal" }
  | { kind: "lease_lost" }
> {
  const now = input.now ?? new Date();
  return input.db.transaction(async (tx) => {
    const lease = await lockRecordingProcessingLease(tx, input);
    if (lease.kind !== "owned") return { kind: lease.kind };
    const call = await lockCall(tx, input.callRecordId);
    if (!call || call.processedAt) {
      await completeRecordingProcessingEvent(tx, {
        outboxEventId: input.outboxEventId,
        leaseToken: input.leaseToken,
        event: lease.event,
        now,
      });
      return { kind: "already_terminal" as const };
    }
    const verifiedEmptyPolls = readVerifiedEmptyRecordingPolls(
      lease.event.payload,
    );
    const plan = planRecordingEmptyPoll(verifiedEmptyPolls, "verified_empty");
    const payload = {
      ...payloadWithoutRecordingProcessingLease(lease.event.payload),
      recordingEmptyPolls: plan.verifiedEmptyPolls,
    };
    if (!plan.settleAbsent) {
      const [deferred] = await tx
        .update(outboxEvents)
        .set({
          payload,
          attempts: (lease.event.attempts ?? 0) + 1,
          nextAttemptAt: nextVerifiedRecordingPollAt(now),
          lastError: "recordings_not_ready",
        })
        .where(
          and(
            eq(outboxEvents.id, input.outboxEventId),
            isNull(outboxEvents.processedAt),
            isNull(outboxEvents.quarantinedAt),
            sql`${outboxEvents.payload} ->> ${RECORDING_PROCESSING_LEASE_TOKEN_KEY} = ${input.leaseToken}`,
          ),
        )
        .returning({ id: outboxEvents.id });
      if (!deferred) throw new Error("recording_poll_lease_lost");
      return {
        kind: "retry" as const,
        verifiedEmptyPolls: plan.verifiedEmptyPolls,
      };
    }

    const [claimed] = await tx
      .update(callRecords)
      .set({ processedAt: now, updatedAt: now })
      .where(
        and(
          eq(callRecords.id, input.callRecordId),
          isNull(callRecords.processedAt),
        ),
      )
      .returning({ id: callRecords.id });
    if (!claimed) return { kind: "already_terminal" as const };
    await insertRecordingAudit(tx, {
      action: "call.recording.absent",
      outcome: "succeeded",
      callRecordId: input.callRecordId,
      meta: {
        reason: "verified_empty_after_bounded_polling",
        polls: plan.verifiedEmptyPolls,
      },
      now,
    });
    await completeRecordingProcessingEvent(tx, {
      outboxEventId: input.outboxEventId,
      leaseToken: input.leaseToken,
      event: lease.event,
      payload,
      now,
    });
    return {
      kind: "settled" as const,
      verifiedEmptyPolls: plan.verifiedEmptyPolls,
    };
  });
}

export async function persistSkippedRecordingProcessing(input: {
  db: DatabaseClient;
  outboxEventId: string;
  leaseToken: string;
  callRecordId: string;
  recording: RecordingIdentity;
  reason: "transcription_not_configured";
  now?: Date;
}): Promise<"committed" | "already_terminal" | "lease_lost"> {
  const now = input.now ?? new Date();
  return input.db.transaction(async (tx) => {
    const lease = await lockRecordingProcessingLease(tx, input);
    if (lease.kind !== "owned") return lease.kind;
    const call = await lockCall(tx, input.callRecordId);
    if (!call || call.processedAt) {
      await completeRecordingProcessingEvent(tx, {
        outboxEventId: input.outboxEventId,
        leaseToken: input.leaseToken,
        event: lease.event,
        now,
      });
      return "already_terminal" as const;
    }
    if (call.callSid !== input.recording.callSid) {
      throw new Error("recording_call_identity_mismatch");
    }
    await ensureDeleteEvent(tx, {
      callSid: input.recording.callSid,
      recordingSid: input.recording.recordingSid,
      dueAt: now,
      now,
    });
    await insertRecordingAudit(tx, {
      action: "call.recording.processing_skipped",
      outcome: "failed",
      callRecordId: call.id,
      meta: {
        provider: "twilio",
        reason: input.reason,
        deletionQueued: true,
      },
      now,
    });
    const [claimed] = await tx
      .update(callRecords)
      .set({
        recordingSid: input.recording.recordingSid,
        recordingDurationSec: input.recording.durationSec,
        recordingCreatedAt: input.recording.createdAt,
        deleteAfter: now,
        processedAt: now,
        updatedAt: now,
      })
      .where(and(eq(callRecords.id, call.id), isNull(callRecords.processedAt)))
      .returning({ id: callRecords.id });
    if (!claimed) throw new Error("recording_processing_claim_lost");
    await completeRecordingProcessingEvent(tx, {
      outboxEventId: input.outboxEventId,
      leaseToken: input.leaseToken,
      event: lease.event,
      now,
    });
    return "committed" as const;
  });
}

export async function persistAnalyzedRecording(input: {
  db: DatabaseClient;
  outboxEventId: string;
  leaseToken: string;
  callRecordId: string;
  expectedContactId: string | null;
  recording: RecordingIdentity;
  transcript: string;
  analysis: CallAnalysis;
  noteTimestampLabel: string;
  inboundCoaching: CallCoachingResult | null;
  outboundCoaching: CallCoachingResult | null;
  deleteAfter: Date;
  now?: Date;
}): Promise<"committed" | "already_terminal" | "lease_lost"> {
  const now = input.now ?? new Date();
  return input.db.transaction(async (tx) => {
    // Contact deletion uses contact -> outbox ordering. Acquire the same
    // advisory lock before the lease row so neither path can deadlock.
    if (input.expectedContactId) {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.expectedContactId}, 0))`,
      );
    }
    const lease = await lockRecordingProcessingLease(tx, input);
    if (lease.kind !== "owned") return lease.kind;
    const call = await lockCall(tx, input.callRecordId);
    if (!call || call.processedAt) {
      await completeRecordingProcessingEvent(tx, {
        outboxEventId: input.outboxEventId,
        leaseToken: input.leaseToken,
        event: lease.event,
        now,
      });
      return "already_terminal" as const;
    }
    if (call.contactId !== input.expectedContactId) {
      throw new Error("recording_processing_contact_changed");
    }
    if (call.callSid !== input.recording.callSid) {
      throw new Error("recording_call_identity_mismatch");
    }
    let noteTaskId = call.noteTaskId;
    if (call.contactId) {
      const [contact] = await tx
        .select({
          firstName: contacts.firstName,
          lastName: contacts.lastName,
          email: contacts.email,
          salespersonMemberId: contacts.salespersonMemberId,
          deletedAt: contacts.deletedAt,
        })
        .from(contacts)
        .where(eq(contacts.id, call.contactId))
        .for("update")
        .limit(1);

      const confidence = input.analysis.extracted.confidence ?? {};
      if (contact && !contact.deletedAt) {
        const updates: {
          firstName?: string;
          lastName?: string;
          email?: string;
        } = {};
        const placeholder =
          contact.firstName.trim().toLowerCase() === "unknown" ||
          contact.lastName.trim().toLowerCase() === "contact";
        const firstConfidence = confidence["firstName"] ?? 0;
        const lastConfidence = confidence["lastName"] ?? 0;
        const emailConfidence = confidence["email"] ?? 0;
        if (
          placeholder &&
          input.analysis.extracted.firstName &&
          firstConfidence >= 0.8
        ) {
          updates.firstName = input.analysis.extracted.firstName;
        }
        if (
          placeholder &&
          input.analysis.extracted.lastName &&
          lastConfidence >= 0.8
        ) {
          updates.lastName = input.analysis.extracted.lastName;
        }
        if (
          !contact.email &&
          input.analysis.extracted.email &&
          emailConfidence >= 0.8
        ) {
          updates.email = input.analysis.extracted.email;
        }
        if (Object.keys(updates).length > 0) {
          await tx
            .update(contacts)
            .set(updates)
            .where(eq(contacts.id, call.contactId));
        }

        const extractedBits = [
          input.analysis.extracted.postalCode
            ? `ZIP ${input.analysis.extracted.postalCode}`
            : null,
          input.analysis.extracted.timeframe
            ? `Timing: ${input.analysis.extracted.timeframe}`
            : null,
          input.analysis.extracted.items
            ? `Items: ${input.analysis.extracted.items}`
            : null,
        ].filter((value): value is string => Boolean(value));
        const note = [
          `Call ${input.noteTimestampLabel}`,
          input.analysis.summary,
          extractedBits.length > 0 ? extractedBits.join(" | ") : null,
        ]
          .filter((value): value is string => Boolean(value))
          .join("\n");
        const [pipeline] = await tx
          .select({ notes: crmPipeline.notes })
          .from(crmPipeline)
          .where(eq(crmPipeline.contactId, call.contactId))
          .for("update")
          .limit(1);
        const combined = [pipeline?.notes?.trim() ?? "", note]
          .filter(Boolean)
          .join("\n\n");
        const capped =
          combined.length > 8_000
            ? combined.slice(combined.length - 8_000)
            : combined;
        await tx
          .insert(crmPipeline)
          .values({
            contactId: call.contactId,
            stage: "new",
            notes: capped,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: crmPipeline.contactId,
            set: { notes: capped, updatedAt: now },
          });

        if (!noteTaskId) {
          const noteBody =
            note.length > 3_500 ? `${note.slice(0, 3_497)}...` : note;
          const titleLine = input.analysis.summary.trim().split("\n")[0] ?? "";
          const normalizedTitle = titleLine.trim().slice(0, 60).trimEnd();
          const title = normalizedTitle || "Call note";
          const [createdNote] = await tx
            .insert(crmTasks)
            .values({
              contactId: call.contactId,
              title,
              notes: noteBody,
              status: "completed",
              assignedTo: call.assignedTo,
            })
            .returning({ id: crmTasks.id });
          noteTaskId = createdNote?.id ?? null;
        }

        const coachingMemberId =
          call.assignedTo ?? contact.salespersonMemberId ?? null;
        for (const [rubric, coaching] of [
          ["inbound", input.inboundCoaching],
          ["outbound", input.outboundCoaching],
        ] as const) {
          if (!coaching) continue;
          await tx
            .insert(callCoaching)
            .values({
              callRecordId: call.id,
              memberId: coachingMemberId,
              rubric,
              version: 1,
              model: coaching.model,
              scoreOverall: coaching.scoreOverall,
              scoreBreakdown: coaching.scoreBreakdown,
              wins: coaching.wins,
              improvements: coaching.improvements,
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoNothing();
        }
      }
    }

    await ensureDeleteEvent(tx, {
      callSid: input.recording.callSid,
      recordingSid: input.recording.recordingSid,
      dueAt: input.deleteAfter,
      now,
    });
    await insertRecordingAudit(tx, {
      action: "call.recording.processed",
      outcome: "succeeded",
      callRecordId: call.id,
      meta: {
        provider: "twilio",
        recordingDurationSec: input.recording.durationSec,
        deleteAfter: input.deleteAfter.toISOString(),
      },
      now,
    });
    const coachingText = input.analysis.coaching.join("\n").trim();
    const [claimed] = await tx
      .update(callRecords)
      .set({
        recordingSid: input.recording.recordingSid,
        recordingDurationSec: input.recording.durationSec,
        recordingCreatedAt: input.recording.createdAt,
        transcript: input.transcript,
        extracted: input.analysis.extracted as Record<string, unknown>,
        summary: input.analysis.summary,
        coaching: coachingText || null,
        noteTaskId,
        deleteAfter: input.deleteAfter,
        processedAt: now,
        updatedAt: now,
      })
      .where(and(eq(callRecords.id, call.id), isNull(callRecords.processedAt)))
      .returning({ id: callRecords.id });
    if (!claimed) throw new Error("recording_processing_claim_lost");
    await completeRecordingProcessingEvent(tx, {
      outboxEventId: input.outboxEventId,
      leaseToken: input.leaseToken,
      event: lease.event,
      now,
    });
    return "committed" as const;
  });
}

export type RecordingDeleteTarget = {
  callRecordId: string;
  callSid: string;
  recordingSid: string;
  deleteAfter: Date | null;
};

export function recordingDeleteIdentityMatches(
  target: Pick<
    RecordingDeleteTarget,
    "callRecordId" | "callSid" | "recordingSid"
  >,
  current: {
    id: string;
    callSid: string;
    recordingSid: string | null;
    deletedAt: Date | null;
  },
): boolean {
  return (
    current.deletedAt === null &&
    current.id === target.callRecordId &&
    current.callSid === target.callSid &&
    current.recordingSid === target.recordingSid
  );
}

async function quarantineDeleteEvent(
  tx: TeamMutationTransaction,
  input: {
    outboxEventId: string;
    callRecordId: string | null;
    contactId: string | null;
    reason: string;
    now: Date;
  },
): Promise<void> {
  const [quarantined] = await tx
    .update(outboxEvents)
    .set({
      quarantinedAt: input.now,
      quarantineReason: input.reason,
      quarantinedContactId: input.contactId,
      lastError: input.reason,
      nextAttemptAt: null,
    })
    .where(
      and(
        eq(outboxEvents.id, input.outboxEventId),
        isNull(outboxEvents.processedAt),
        isNull(outboxEvents.quarantinedAt),
      ),
    )
    .returning({ id: outboxEvents.id });
  if (!quarantined) return;
  await insertRecordingAudit(tx, {
    action: "call.recording.delete.quarantined",
    outcome: "failed",
    callRecordId: input.callRecordId ?? input.outboxEventId,
    meta: {
      provider: "twilio",
      reason: input.reason,
      redispatchPrevented: true,
    },
    now: input.now,
  });
}

export async function quarantineRecordingDeleteEvent(input: {
  db: DatabaseClient;
  outboxEventId: string;
  reason: string;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  await input.db.transaction(async (tx) => {
    await quarantineDeleteEvent(tx, {
      outboxEventId: input.outboxEventId,
      callRecordId: null,
      contactId: null,
      reason: input.reason,
      now,
    });
  });
}

export async function prepareRecordingDelete(input: {
  db: DatabaseClient;
  outboxEventId: string;
  callSid: string;
  recordingSid: string;
  now?: Date;
}): Promise<
  | { kind: "delete"; target: RecordingDeleteTarget }
  | { kind: "already_terminal" }
  | { kind: "quarantined" }
> {
  const now = input.now ?? new Date();
  return input.db.transaction(async (tx) => {
    const [event] = await tx
      .select({
        processedAt: outboxEvents.processedAt,
        quarantinedAt: outboxEvents.quarantinedAt,
      })
      .from(outboxEvents)
      .where(eq(outboxEvents.id, input.outboxEventId))
      .for("update")
      .limit(1);
    if (!event || event.processedAt || event.quarantinedAt) {
      return { kind: "already_terminal" as const };
    }
    const [call] = await tx
      .select({
        id: callRecords.id,
        callSid: callRecords.callSid,
        recordingSid: callRecords.recordingSid,
        contactId: callRecords.contactId,
        deletedAt: callRecords.deletedAt,
        deleteAfter: callRecords.deleteAfter,
        updatedAt: callRecords.updatedAt,
      })
      .from(callRecords)
      .where(eq(callRecords.callSid, input.callSid))
      .for("update")
      .limit(1);
    if (!call || call.deletedAt) {
      return { kind: "already_terminal" as const };
    }
    if (call.recordingSid !== input.recordingSid) {
      await quarantineDeleteEvent(tx, {
        outboxEventId: input.outboxEventId,
        callRecordId: call.id,
        contactId: call.contactId,
        reason: "recording_delete_identity_mismatch",
        now,
      });
      return { kind: "quarantined" as const };
    }
    return {
      kind: "delete" as const,
      target: {
        callRecordId: call.id,
        callSid: call.callSid,
        recordingSid: call.recordingSid,
        deleteAfter: call.deleteAfter,
      },
    };
  });
}

export async function finalizeRecordingDelete(input: {
  db: DatabaseClient;
  outboxEventId: string;
  target: RecordingDeleteTarget;
  alreadyAbsent: boolean;
  now?: Date;
}): Promise<"committed" | "already_terminal" | "quarantined"> {
  const now = input.now ?? new Date();
  return input.db.transaction(async (tx) => {
    const [event] = await tx
      .select({
        processedAt: outboxEvents.processedAt,
        quarantinedAt: outboxEvents.quarantinedAt,
      })
      .from(outboxEvents)
      .where(eq(outboxEvents.id, input.outboxEventId))
      .for("update")
      .limit(1);
    if (!event || event.processedAt || event.quarantinedAt) {
      return "already_terminal" as const;
    }
    const call = await lockCall(tx, input.target.callRecordId);
    if (!call || call.deletedAt) return "already_terminal" as const;
    if (!recordingDeleteIdentityMatches(input.target, call)) {
      await quarantineDeleteEvent(tx, {
        outboxEventId: input.outboxEventId,
        callRecordId: call.id,
        contactId: call.contactId,
        reason: "recording_delete_identity_conflict",
        now,
      });
      return "quarantined" as const;
    }
    await insertRecordingAudit(tx, {
      action: "call.recording.deleted",
      outcome: "succeeded",
      callRecordId: call.id,
      meta: {
        provider: "twilio",
        alreadyAbsent: input.alreadyAbsent,
      },
      now,
    });
    const [deleted] = await tx
      .update(callRecords)
      .set({ deletedAt: now, updatedAt: now })
      .where(
        and(
          eq(callRecords.id, call.id),
          eq(callRecords.callSid, input.target.callSid),
          eq(callRecords.recordingSid, input.target.recordingSid),
          isNull(callRecords.deletedAt),
        ),
      )
      .returning({ id: callRecords.id });
    if (!deleted) throw new Error("recording_delete_claim_lost");
    return "committed" as const;
  });
}
