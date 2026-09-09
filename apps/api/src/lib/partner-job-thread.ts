import { and, eq } from "drizzle-orm";
import {
  conversationThreads,
  conversationParticipants,
  partnerBookings,
  partnerAccountMemberships,
  partnerUsers,
  type DatabaseClient,
} from "@/db";

type Transaction = Parameters<Parameters<DatabaseClient["transaction"]>[0]>[0];

/** A caller must already have authorized the job. The lock serializes all thread/participant creation. */
export async function ensurePartnerJobThread(
  tx: Transaction,
  accountId: string,
  jobId: string,
): Promise<{ id: string }> {
  const [job] = await tx
    .select({
      id: partnerBookings.id,
      serviceKey: partnerBookings.serviceKey,
      creatorId: partnerBookings.requestedByMembershipId,
    })
    .from(partnerBookings)
    .where(
      and(
        eq(partnerBookings.partnerAccountId, accountId),
        eq(partnerBookings.id, jobId),
      ),
    )
    .for("update")
    .limit(1);
  if (!job) throw new Error("partner_job_thread_not_found");
  await tx
    .insert(conversationThreads)
    .values({
      partnerAccountId: accountId,
      partnerBookingId: job.id,
      portalVisible: true,
      staffScope: "general",
      status: "open",
      state: "booked",
      channel: "web",
      subject: "Partner service request",
    })
    .onConflictDoNothing();
  const [thread] = await tx
    .select({ id: conversationThreads.id })
    .from(conversationThreads)
    .where(
      and(
        eq(conversationThreads.partnerAccountId, accountId),
        eq(conversationThreads.partnerBookingId, jobId),
        eq(conversationThreads.portalVisible, true),
        eq(conversationThreads.staffScope, "general"),
      ),
    )
    .for("update")
    .limit(1);
  if (!thread) throw new Error("partner_job_thread_missing");
  if (job.creatorId) {
    const [member] = await tx
      .select({
        id: partnerAccountMemberships.id,
        name: partnerUsers.name,
        email: partnerUsers.email,
      })
      .from(partnerAccountMemberships)
      .innerJoin(
        partnerUsers,
        eq(partnerUsers.id, partnerAccountMemberships.partnerUserId),
      )
      .where(
        and(
          eq(partnerAccountMemberships.id, job.creatorId),
          eq(partnerAccountMemberships.partnerAccountId, accountId),
        ),
      )
      .limit(1);
    const [existing] = await tx
      .select({ id: conversationParticipants.id })
      .from(conversationParticipants)
      .where(
        and(
          eq(conversationParticipants.threadId, thread.id),
          eq(conversationParticipants.partnerMembershipId, job.creatorId),
        ),
      )
      .limit(1);
    if (member && !existing)
      await tx
        .insert(conversationParticipants)
        .values({
          threadId: thread.id,
          participantType: "contact",
          partnerMembershipId: member.id,
          displayName: member.name,
          externalAddress: member.email,
        });
  }
  return thread;
}
