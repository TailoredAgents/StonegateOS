import { and, eq, isNull, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import {
  getDb,
  contacts,
  smsCampaigns,
  smsCampaignRecipients,
  smsMarketingConsents,
  outboxEvents,
  conversationMessages,
  conversationThreads,
} from "@/db";
import type { TeamMutationTransaction } from "./team-mutation";
import {
  campaignPhone,
  campaignReadiness,
  latestCampaignConsent,
} from "./sms-campaigns";
import { readCampaignCapacity } from "./sms-campaign-capacity";
import { previewIndividualSms } from "./individual-promotional-sms";

/** Called inside the existing durable dispatch claim, after its contact lock. */
export async function guardCampaignDispatch(
  tx: TeamMutationTransaction,
  input: {
    recipientId: string;
    messageId: string;
    contactId: string;
    outboxId: string;
    now: Date;
  },
): Promise<{ block: string | null; retryAt?: Date }> {
  const [recipient] = await tx
    .select()
    .from(smsCampaignRecipients)
    .where(eq(smsCampaignRecipients.id, input.recipientId))
    .limit(1);
  if (
    !recipient ||
    recipient.messageId !== input.messageId ||
    recipient.contactId !== input.contactId
  )
    return { block: "campaign_recipient_mismatch" };
  const [campaign] = await tx
    .select()
    .from(smsCampaigns)
    .where(eq(smsCampaigns.id, recipient.campaignId))
    .for("update")
    .limit(1);
  if (!campaign) return { block: "campaign_unavailable" };
  const suppress = async (reason: string) => {
    await tx
      .update(smsCampaignRecipients)
      .set({ suppressionReason: reason })
      .where(eq(smsCampaignRecipients.id, recipient.id));
    return { block: reason };
  };
  if (recipient.suppressionReason)
    return { block: recipient.suppressionReason };
  if (recipient.claimedAt) return suppress("campaign_send_already_claimed");
  if (["completed", "cancelled"].includes(campaign.status))
    return suppress("campaign_ended");
  if (
    !campaign.terms.expiresAt ||
    new Date(campaign.terms.expiresAt) <= input.now
  )
    return suppress("campaign_expired");
  const readiness = campaignReadiness();
  const defer = async (retryAt: Date) => {
    await tx
      .update(outboxEvents)
      .set({ nextAttemptAt: retryAt, lastError: "campaign_held" })
      .where(eq(outboxEvents.id, input.outboxId));
    return { block: null, retryAt };
  };
  if (
    readiness.blockers.length ||
    campaign.sender !== readiness.sender ||
    campaign.status === "paused"
  )
    return defer(new Date(input.now.getTime() + 60_000));
  if (!recipient.isTest && campaign.status !== "active")
    return suppress("campaign_not_active");
  const [uncertain] = await tx.execute(
    sql`select 1 from external_message_dispatches d join sms_campaign_recipients r on r.message_id=d.message_id where r.campaign_id=${campaign.id} and d.state='reconciliation_required' limit 1`,
  );
  if (uncertain) {
    if (campaign.status === "active")
      await tx
        .update(smsCampaigns)
        .set({
          status: "paused",
          version: campaign.version + 1,
          updatedAt: input.now,
        })
        .where(eq(smsCampaigns.id, campaign.id));
    return defer(new Date(input.now.getTime() + 60_000));
  }
  const [contact] = await tx
    .select({
      phone: contacts.phone,
      phoneE164: contacts.phoneE164,
      doNotContact: contacts.doNotContact,
      deletedAt: contacts.deletedAt,
    })
    .from(contacts)
    .where(eq(contacts.id, input.contactId))
    .limit(1);
  if (
    !contact ||
    contact.deletedAt ||
    contact.doNotContact ||
    campaignPhone(contact.phoneE164 ?? contact.phone) !== recipient.phone
  )
    return suppress("campaign_contact_changed");
  if (recipient.isTest) {
    if (!readiness.testNumbers.includes(recipient.phone))
      return suppress("test_number_not_allowed");
  } else {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`sms-consent:${recipient.phone}`},0))`,
    );
    const consent = await latestCampaignConsent(tx, recipient.phone);
    if (
      !consent ||
      consent.id !== recipient.consentId ||
      consent.status !== "granted" ||
      consent.contactId !== recipient.contactId
    )
      return suppress("campaign_consent_changed");
    // The recipient was initially read before the phone lock. A reply can
    // commit while that lock is being acquired, so read suppression again.
    const [currentRecipient] = await tx
      .select()
      .from(smsCampaignRecipients)
      .where(eq(smsCampaignRecipients.id, recipient.id))
      .limit(1);
    if (currentRecipient?.repliedAt || currentRecipient?.suppressionReason)
      return suppress(currentRecipient.suppressionReason ?? "customer_replied");
    const [booking] = await tx.execute(
      sql`select 1 from appointments where contact_id=${recipient.contactId} and created_at>=${recipient.createdAt.toISOString()} and status <> 'canceled' and start_at>=${input.now.toISOString()} limit 1`,
    );
    if (booking) return suppress("customer_booked");
    const local = DateTime.fromJSDate(input.now, { zone: consent.timeZone });
    if (!local.isValid) return suppress("recipient_timezone_unknown");
    // A conservative operational window; launch review must verify jurisdiction/provider rules.
    if (local.hour < 9 || local.hour >= 18) {
      const next = (local.hour >= 18 ? local.plus({ days: 1 }) : local).set({
        hour: 9,
        minute: 0,
        second: 0,
        millisecond: 0,
      });
      return defer(next.toJSDate());
    }
  }
  if (campaign.nextSendAt && campaign.nextSendAt > input.now)
    return defer(campaign.nextSendAt);
  if (
    !recipient.isTest &&
    !(await readCampaignCapacity(campaign.terms.serviceThrough, input.now, tx))
      .hasOpening
  ) {
    await tx
      .update(smsCampaigns)
      .set({
        status: "paused",
        version: campaign.version + 1,
        updatedAt: input.now,
      })
      .where(eq(smsCampaigns.id, campaign.id));
    return defer(new Date(input.now.getTime() + 60_000));
  }
  if (
    campaign.terms.deliveryMode === "individual_drafts" &&
    !recipient.isTest
  ) {
    if (!recipient.draftId) return suppress("individual_draft_missing");
    const [draft] = await tx.execute<{
      version: number;
      body: string;
      body_hash: string;
    }>(
      sql`select version,body,body_hash from sms_campaign_drafts where id=${recipient.draftId}::uuid and contact_id=${recipient.contactId}::uuid`,
    );
    const [message] = await tx
      .select({
        body: conversationMessages.body,
        from: conversationMessages.fromAddress,
        to: conversationMessages.toAddress,
        threadId: conversationMessages.threadId,
      })
      .from(conversationMessages)
      .where(eq(conversationMessages.id, input.messageId));
    if (
      !draft ||
      !message ||
      draft.body !== recipient.body ||
      message.body !== draft.body ||
      message.to !== recipient.phone ||
      message.from !== campaign.sender
    )
      return suppress("reviewed_message_changed");
    const preview = await previewIndividualSms(
      tx,
      {
        contactId: recipient.contactId,
        draftId: recipient.draftId,
        version: draft.version,
      },
      {
        now: input.now,
        ignoreMessageId: input.messageId,
        ignoreRecipientId: recipient.id,
      },
    );
    if (preview.blockers.length)
      return suppress(preview.blockers.map((b) => b.code).join(","));
    if (preview.review?.threadId !== message.threadId)
      return suppress("reviewed_thread_changed");
  }
  const interval = Math.max(
    10,
    Number(process.env["SMS_CAMPAIGN_INTERVAL_SECONDS"]) || 60,
  );
  await tx
    .update(smsCampaigns)
    .set({ nextSendAt: new Date(input.now.getTime() + interval * 1000) })
    .where(eq(smsCampaigns.id, campaign.id));
  await tx
    .update(smsCampaignRecipients)
    .set({ claimedAt: input.now })
    .where(eq(smsCampaignRecipients.id, recipient.id));
  return { block: null };
}

export async function recordCampaignInbound(
  tx: TeamMutationTransaction,
  phone: string,
  contactId: string,
  body: string,
  now: Date,
) {
  const normalized = campaignPhone(phone);
  if (!normalized) return;
  const stopped =
    /^\s*(stop|stopall|unsubscribe|optout|revoke|cancel|end|quit)\s*[.!]?\s*$/i.test(
      body,
    );
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`sms-consent:${normalized}`},0))`,
  );
  if (stopped)
    await tx.insert(smsMarketingConsents).values({
      contactId,
      phone: normalized,
      status: "revoked",
      source: "inbound_sms",
      evidence: "Customer sent an opt-out keyword.",
      capturedAt: now,
      timeZone: "America/New_York",
    });
  await tx
    .update(smsCampaignRecipients)
    .set({ repliedAt: now })
    .where(
      and(
        eq(smsCampaignRecipients.phone, normalized),
        eq(smsCampaignRecipients.isTest, false),
        isNull(smsCampaignRecipients.repliedAt),
      ),
    );
  await tx
    .update(smsCampaignRecipients)
    .set({
      suppressionReason: stopped ? "Customer opted out" : "Customer replied",
    })
    .where(
      and(
        eq(smsCampaignRecipients.phone, normalized),
        eq(smsCampaignRecipients.isTest, false),
        isNull(smsCampaignRecipients.claimedAt),
      ),
    );
}

export async function hasCampaignConversation(input: {
  contactId?: string;
  messageId?: string;
}): Promise<boolean> {
  if (process.env["SMS_CAMPAIGNS_ENABLED"] !== "true") return false;
  const db = getDb();
  let contactId = input.contactId;
  if (!contactId && input.messageId) {
    const [row] = await db
      .select({ contactId: conversationThreads.contactId })
      .from(conversationMessages)
      .innerJoin(
        conversationThreads,
        eq(conversationThreads.id, conversationMessages.threadId),
      )
      .where(eq(conversationMessages.id, input.messageId))
      .limit(1);
    contactId = row?.contactId ?? undefined;
  }
  if (!contactId) return false;
  const [row] = await db
    .select({ id: smsCampaignRecipients.id })
    .from(smsCampaignRecipients)
    .innerJoin(
      smsCampaigns,
      eq(smsCampaigns.id, smsCampaignRecipients.campaignId),
    )
    .where(
      and(
        eq(smsCampaignRecipients.contactId, contactId),
        eq(smsCampaignRecipients.isTest, false),
        sql`(${smsCampaigns.status} in ('active','paused') or ${smsCampaignRecipients.createdAt} > now() - interval '30 days')`,
      ),
    )
    .limit(1);
  return !!row;
}
