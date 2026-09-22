import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  getDb,
  conversationThreads,
  conversationMessages,
  conversationParticipants,
  partnerBookings,
  partnerAccounts,
  appointments,
} from "@/db";
import {
  TeamMutationFailure,
  type TeamMutationContext,
  type TeamMutationTransaction,
} from "@/lib/team-mutation";
import { loadReadyPartnerJobMessageAttachments } from "@/lib/partner-portal-v2-media";
import { queuePartnerJobAudienceNotification } from "@/lib/partner-notification-delivery";

/** Staff and partners write the same operational thread; CRM contacts are never recipients. */
type StaffJobMessageInput = {
  threadId: string;
  audience: "partner" | "internal";
  body: string;
  attachmentIds: string[];
  expectedContactId?: string | null;
  expectedChannel?: string | null;
  mutation: TeamMutationContext;
};
export async function sendStaffPartnerJobMessage(input: StaffJobMessageInput) {
  return getDb().transaction((tx) =>
    sendStaffPartnerJobMessageInTransaction(tx, input),
  );
}

export async function sendStaffPartnerJobMessageInTransaction(
  tx: TeamMutationTransaction,
  input: StaffJobMessageInput,
) {
  const { mutation } = input;
  const hasExpectedContact = Object.prototype.hasOwnProperty.call(
    input,
    "expectedContactId",
  );
  if (!mutation.actor.id || !mutation.idempotencyKeyHash)
    throw new TeamMutationFailure(
      "unauthorized",
      "Sign in to send this message.",
    );
  const requestHash = createHash("sha256")
    .update(
      JSON.stringify({
        threadId: input.threadId,
        audience: input.audience,
        body: input.body,
        attachmentIds: [...input.attachmentIds].sort(),
        ...(hasExpectedContact
          ? {
              expectedContactId: input.expectedContactId,
              channel: input.expectedChannel,
            }
          : {}),
      }),
    )
    .digest("hex");
  const [thread] = await tx
    .select()
    .from(conversationThreads)
    .where(
      and(
        eq(conversationThreads.id, input.threadId),
        eq(conversationThreads.portalVisible, true),
        eq(conversationThreads.staffScope, "general"),
      ),
    )
    .for("update")
    .limit(1);
  if (!thread?.partnerAccountId || !thread.partnerBookingId)
    throw new TeamMutationFailure("invalid", "Job conversation not found.", {
      status: 404,
    });
  if (
    hasExpectedContact &&
    (input.expectedContactId !== null ||
      thread.contactId !== null ||
      input.expectedChannel !== "web" ||
      thread.channel !== "web")
  ) {
    throw new TeamMutationFailure("conflict", "thread_context_mismatch");
  }
  const [job] = await tx
    .select({
      id: partnerBookings.id,
      creator: partnerBookings.requestedByMembershipId,
      accountEnabled: partnerAccounts.portalAccessEnabled,
      timezone: appointments.schedulingTimezone,
    })
    .from(partnerBookings)
    .innerJoin(
      partnerAccounts,
      eq(partnerAccounts.id, partnerBookings.partnerAccountId),
    )
    .leftJoin(appointments, eq(appointments.id, partnerBookings.appointmentId))
    .where(
      and(
        eq(partnerBookings.id, thread.partnerBookingId),
        eq(partnerBookings.partnerAccountId, thread.partnerAccountId),
      ),
    )
    .limit(1);
  if (!job || (!job.accountEnabled && input.audience === "partner"))
    throw new TeamMutationFailure(
      "conflict",
      "Partner access is unavailable. You may record an internal note.",
    );
  const [replay] = await tx
    .select()
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.threadId, thread.id),
        eq(
          conversationMessages.idempotencyKeyHash,
          mutation.idempotencyKeyHash,
        ),
      ),
    )
    .limit(1);
  if (replay) {
    if (
      replay.metadata?.["requestHash"] !== requestHash ||
      replay.metadata?.["staffActorId"] !== mutation.actor.id
    )
      throw new TeamMutationFailure(
        "conflict",
        "This send key belongs to a different message.",
      );
    return {
      id: replay.id,
      threadId: thread.id,
      direction: replay.direction,
      channel: "web",
      deliveryStatus: replay.deliveryStatus,
      createdAt: replay.createdAt.toISOString(),
    };
  }
  const attachments = await loadReadyPartnerJobMessageAttachments({
    db: tx,
    accountId: thread.partnerAccountId,
    jobId: job.id,
    requestedIds: input.attachmentIds,
  });
  if (attachments.length !== input.attachmentIds.length)
    throw new TeamMutationFailure(
      "invalid",
      "Choose ready files from this job only.",
    );
  let [participant] = await tx
    .select({ id: conversationParticipants.id })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.threadId, thread.id),
        eq(conversationParticipants.teamMemberId, mutation.actor.id),
      ),
    )
    .limit(1);
  if (!participant)
    [participant] = await tx
      .insert(conversationParticipants)
      .values({
        threadId: thread.id,
        participantType: "team",
        teamMemberId: mutation.actor.id,
        displayName: mutation.actor.label || "Stonegate",
      })
      .returning({ id: conversationParticipants.id });
  const now = new Date();
  const [message] = await tx
    .insert(conversationMessages)
    .values({
      threadId: thread.id,
      participantId: participant!.id,
      direction: input.audience === "partner" ? "outbound" : "internal",
      channel: "web",
      body: input.body,
      portalVisible: input.audience === "partner",
      authorType: "staff",
      deliveryStatus: "delivered",
      sentAt: now,
      idempotencyKeyHash: mutation.idempotencyKeyHash,
      metadata: {
        requestHash,
        staffActorId: mutation.actor.id,
        attachmentIds: input.attachmentIds,
      },
    })
    .returning();
  if (!message) throw new Error("partner_message_insert_failed");
  await tx
    .update(conversationThreads)
    .set({
      lastMessageAt: now,
      lastMessagePreview: input.body.slice(0, 140),
      updatedAt: now,
    })
    .where(eq(conversationThreads.id, thread.id));
  if (input.audience === "partner") {
    const participants = await tx
      .select({ id: conversationParticipants.partnerMembershipId })
      .from(conversationParticipants)
      .where(eq(conversationParticipants.threadId, thread.id));
    const audienceMembershipIds = [
      ...new Set(
        [job.creator, ...participants.map((row) => row.id)].filter(
          (id): id is string => Boolean(id),
        ),
      ),
    ];
    await queuePartnerJobAudienceNotification({
      tx,
      accountId: thread.partnerAccountId,
      partnerBookingId: job.id,
      eventType: "message.received",
      dedupeKey: message.id,
      occurredAt: now,
      correlationId: mutation.correlationId,
      accountTimezone: job.timezone,
      audienceMembershipIds,
    });
  }
  await mutation.audit.insertSuccess(tx, {
    entityType: "conversation_message",
    entityId: message.id,
    metadata: {
      partnerAccountId: thread.partnerAccountId,
      partnerBookingId: job.id,
      threadId: thread.id,
      audience: input.audience,
      attachmentCount: attachments.length,
    },
  });
  return {
    id: message.id,
    threadId: thread.id,
    direction: message.direction,
    channel: "web",
    deliveryStatus: "delivered",
    createdAt: message.createdAt.toISOString(),
  };
}
