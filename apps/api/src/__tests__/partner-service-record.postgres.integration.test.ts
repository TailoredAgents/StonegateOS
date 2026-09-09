import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb, closeDbForTests, appointments, contacts, properties, partnerAccounts, partnerUsers, partnerAccountMemberships, partnerRoleTemplates, partnerBookings, partnerNotifications, partnerNotificationDeliveries, mediaAssets, partnerJobEvidence, partnerEvidenceRequirements, outboxEvents } from "@/db";
import { queuePartnerBookingNotification } from "@/lib/partner-notification-delivery";
import { evaluatePartnerProofCompletion } from "@/lib/partner-proof-completion";
import { queuePartnerAppointmentStatusEffects } from "@/lib/partner-job-lifecycle";
import type { TeamMutationTransaction } from "@/lib/team-mutation";
import type { TeamMutationContext } from "@/lib/team-mutation";
import { teamMembers, conversationMessages, conversationThreads, conversationParticipants } from "@/db";
import { ensurePartnerJobThread } from "@/lib/partner-job-thread";
import { sendStaffPartnerJobMessageInTransaction } from "@/lib/partner-job-communication";

const local = process.env["DATABASE_URL"] && ["localhost", "127.0.0.1"].includes(new URL(process.env["DATABASE_URL"]).hostname);
const suite = local ? describe : describe.skip;
async function rollbackTest(test: (tx: TeamMutationTransaction) => Promise<void>) { const rollback = new Error("test_rollback"); try { await getDb().transaction(async (tx) => { await test(tx); throw rollback; }); } catch (error) { if (error !== rollback) throw error; } }
async function fixture(tx: TeamMutationTransaction) {
  const accountId = randomUUID(), contactId = randomUUID(), propertyId = randomUUID(), appointmentId = randomUUID(), jobId = randomUUID();
  await tx.insert(partnerAccounts).values({ id: accountId, name: "Local service test", normalizedName: accountId, portalAccessEnabled: true });
  await tx.insert(contacts).values({ id: contactId, firstName: "Local", lastName: "Test", email: `${contactId}@example.test` });
  await tx.insert(properties).values({ id: propertyId, contactId, addressLine1: "1 Local Way", city: "Atlanta", state: "GA", postalCode: "30301" });
  await tx.insert(appointments).values({ id: appointmentId, contactId, propertyId, partnerAccountId: accountId, type: "job", status: "confirmed", rescheduleToken: randomUUID() });
  await tx.insert(partnerBookings).values({ id: jobId, orgContactId: contactId, partnerAccountId: accountId, appointmentId, propertyId, publicStatus: "confirmed" });
  return { accountId, contactId, propertyId, appointmentId, jobId };
}
async function member(tx: TeamMutationTransaction, accountId: string, capability: string, scoped = false) {
  const id = randomUUID(), userId = randomUUID(), roleId = randomUUID();
  await tx.insert(partnerUsers).values({ id: userId, email: `${userId}@example.test`, normalizedEmail: `${userId}@example.test`, name: "Local partner", emailVerifiedAt: new Date() });
  await tx.insert(partnerRoleTemplates).values({ id: roleId, partnerAccountId: accountId, key: `test_${roleId.replaceAll("-", "")}`, name: "Local test role", description: "Test only", capabilities: [capability, "jobs.read"] });
  await tx.insert(partnerAccountMemberships).values({ id, partnerAccountId: accountId, partnerUserId: userId, roleTemplateId: roleId, roleKey: "operations", status: "active", acceptedAt: new Date(), accessLevel: scoped ? "scoped" : "account" });
  return id;
}

suite("partner service record / real PostgreSQL", () => {
  afterAll(async () => closeDbForTests());
  it("deduplicates committed notifications and excludes non-billing and ungranted scoped people", async () => rollbackTest(async (tx) => {
    const f = await fixture(tx);
    const billing = await member(tx, f.accountId, "invoices.read"), operations = await member(tx, f.accountId, "messages.read"), scoped = await member(tx, f.accountId, "invoices.read", true);
    for (const membershipId of [billing, billing, operations, scoped]) await queuePartnerBookingNotification({ tx, accountId: f.accountId, membershipId, partnerBookingId: f.jobId, eventType: "billing.invoice_issued", dedupeKey: "same-issue", correlationId: null, occurredAt: new Date() });
    const notices = await tx.select().from(partnerNotifications).where(eq(partnerNotifications.partnerAccountId, f.accountId));
    expect(notices).toHaveLength(1); expect(notices[0]!.membershipId).toBe(billing);
    const deliveries = await tx.select().from(partnerNotificationDeliveries).where(eq(partnerNotificationDeliveries.partnerAccountId, f.accountId));
    expect(deliveries).toHaveLength(9); expect(deliveries.filter((row) => row.membershipId !== billing).every((row) => row.state === "suppressed")).toBe(true);
    expect(deliveries.find((row) => row.membershipId === billing && row.channel === "sms")!.state).toBe("suppressed");
  }));
  it("does not let unscanned PDF documents satisfy partner completion", async () => rollbackTest(async (tx) => {
    const f = await fixture(tx), assetId = randomUUID();
    await tx.insert(partnerEvidenceRequirements).values({ partnerAccountId: f.accountId, partnerBookingId: f.jobId, category: "document", minimumCount: 1, required: true });
    await tx.insert(mediaAssets).values({ id: assetId, partnerAccountId: f.accountId, storageBucket: "local-test", originalObjectKey: `quarantine/${assetId}`, status: "ready", contentType: "application/pdf", sourceMetadata: { scanStatus: "queued" } });
    await tx.insert(partnerJobEvidence).values({ partnerAccountId: f.accountId, partnerBookingId: f.jobId, mediaAssetId: assetId, category: "document" });
    expect((await evaluatePartnerProofCompletion(tx, f.appointmentId)).kind).toBe("missing");
    await tx.update(mediaAssets).set({ sourceMetadata: { scanStatus: "clean" } }).where(eq(mediaAssets.id, assetId));
    expect((await evaluatePartnerProofCompletion(tx, f.appointmentId)).kind).toBe("satisfied");
  }));
  it("queues completion records only for explicitly associated partner jobs", async () => rollbackTest(async (tx) => {
    const f = await fixture(tx);
    const normalId = randomUUID();
    await tx.insert(appointments).values({ id: normalId, contactId: f.contactId, propertyId: f.propertyId, type: "job", status: "confirmed", rescheduleToken: randomUUID() });
    expect((await evaluatePartnerProofCompletion(tx, normalId)).kind).toBe("not_partner_job");
    await queuePartnerAppointmentStatusEffects(tx, { appointmentId: normalId, previousStatus: "confirmed", status: "completed", version: new Date().toISOString() });
    await queuePartnerAppointmentStatusEffects(tx, { appointmentId: f.appointmentId, previousStatus: "confirmed", status: "completed", version: new Date().toISOString() });
    const records = await tx.select().from(outboxEvents).where(eq(outboxEvents.type, "partner.proof.prepare"));
    expect(records.filter((row) => row.payload && typeof row.payload === "object" && (row.payload)["jobId"] === f.jobId)).toHaveLength(1);
    const [updated] = await tx.select().from(partnerBookings).where(and(eq(partnerBookings.id, f.jobId), eq(partnerBookings.partnerAccountId, f.accountId)));
    expect(updated!.publicStatus).toBe("completed");
  }));
  it("keeps one explicit job thread, retries a staff reply once, and excludes internal notes", async () => rollbackTest(async (tx) => {
    const f = await fixture(tx), requester = await member(tx, f.accountId, "messages.read"), staffId = randomUUID();
    await tx.update(partnerBookings).set({ requestedByMembershipId: requester }).where(eq(partnerBookings.id, f.jobId));
    await tx.insert(teamMembers).values({ id: staffId, name: "Local staff" });
    const thread = await ensurePartnerJobThread(tx, f.accountId, f.jobId);
    expect((await ensurePartnerJobThread(tx, f.accountId, f.jobId)).id).toBe(thread.id);
    expect(await tx.select().from(conversationThreads).where(eq(conversationThreads.partnerBookingId, f.jobId))).toHaveLength(1);
    const people = await tx.select().from(conversationParticipants).where(eq(conversationParticipants.threadId, thread.id));
    expect(people).toHaveLength(1); expect(people[0]!.partnerMembershipId).toBe(requester); expect(people[0]!.contactId).toBeNull();
    const mutation: TeamMutationContext = { policy: { principalTypes: ["human"], requiredPermissions: ["messages.send"], risk: "normal", requiresIdempotency: true },
      actor: { type: "human", id: staffId, label: "Local staff", authMethod: "team_session" }, principalType: "human", operationId: randomUUID(), correlationId: randomUUID(), idempotencyKeyHash: "a".repeat(64), expectedVersion: null,
      audit: { insertSuccess: () => Promise.resolve({ auditEventId: randomUUID(), committedAt: new Date().toISOString() }) } };
    const reply = { threadId: thread.id, audience: "partner" as const, body: "Your requested work is confirmed.", attachmentIds: [], mutation };
    const first = await sendStaffPartnerJobMessageInTransaction(tx, reply);
    expect((await sendStaffPartnerJobMessageInTransaction(tx, reply)).id).toBe(first.id);
    await expect(sendStaffPartnerJobMessageInTransaction(tx, { ...reply, body: "A different message" })).rejects.toMatchObject({ code: "conflict" });
    await sendStaffPartnerJobMessageInTransaction(tx, { ...reply, audience: "internal", body: "Internal only", mutation: { ...mutation, idempotencyKeyHash: "b".repeat(64) } });
    const visible = await tx.select().from(conversationMessages).where(and(eq(conversationMessages.threadId, thread.id), eq(conversationMessages.portalVisible, true)));
    expect(visible).toHaveLength(1); expect(visible[0]!.body).toBe(reply.body);
    const notifications = await tx.select().from(partnerNotifications).where(and(eq(partnerNotifications.partnerAccountId, f.accountId), eq(partnerNotifications.eventKey, "message.received")));
    expect(notifications).toHaveLength(1); expect(notifications[0]!.membershipId).toBe(requester);
  }));
});
