import { createHash, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { z } from "zod";
import { smsSegments } from "@myst-os/sdk";
import {
  contacts,
  conversationMessages,
  type getDb,
  smsCampaigns,
  smsCampaignRecipients,
  smsCampaignReviews,
  smsCampaignBatches,
} from "@/db";
import {
  campaignPhone,
  campaignReadiness,
  campaignTermIssues,
  campaignTestFingerprint,
  latestCampaignConsent,
} from "./sms-campaigns";
import { readCampaignCapacity } from "./sms-campaign-capacity";
import { queueSystemOutboundMessage } from "./system-outbound";
import {
  TeamMutationFailure,
  type TeamMutationContext,
  type TeamMutationTransaction,
} from "./team-mutation";

type Executor = ReturnType<typeof getDb> | TeamMutationTransaction;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const fingerprint = (value: unknown): string => hash(JSON.stringify(value));
export const DraftSelectionSchema = z
  .object({
    contactId: z.string().uuid(),
    draftId: z.string().uuid(),
    version: z.coerce.number().int().positive(),
  })
  .strict();
type Selection = z.infer<typeof DraftSelectionSchema>;
export const SmsReviewSchema = z
  .object({
    contactId: z.string().uuid(),
    draftId: z.string().uuid(),
    version: z.number().int(),
    campaignId: z.string().uuid(),
    campaignVersion: z.number().int(),
    qualificationVersion: z.number().int(),
    destination: z.string(),
    sender: z.string(),
    text: z.string().min(1).max(1600),
    bodyHash: z.string(),
    threadId: z.string().uuid().nullable(),
    consentId: z.string().uuid(),
    discountBasisPoints: z.literal(3000),
    expiresAt: z.string(),
    serviceThrough: z.string(),
  })
  .strict();
export const SingleSmsReleaseSchema = DraftSelectionSchema.extend({
  review: SmsReviewSchema,
  reviewExpiresAt: z.string().datetime({ offset: true }),
}).strict();
export type SmsBlocker = { code: string; detail: string };
type DraftRow = {
  id: string;
  campaign_id: string;
  contact_id: string;
  version: number;
  body: string;
  body_hash: string;
  source_reference: string;
  source_hash: string;
  latest_version: number;
};
type QualificationRow = {
  version: number;
  qualification: string;
  facebook_status: string;
  holds: string[];
  external_last_activity_at: Date | null;
  reviewed_at: Date;
  evidence_reference: string;
};

export const QualificationSchema = z
  .object({
    contactId: z.string().uuid(),
    expectedVersion: z.number().int().nonnegative(),
    qualification: z.enum([
      "past_customer",
      "prior_inquiry",
      "quote_only",
      "unverified",
    ]),
    facebookStatus: z.enum(["clear", "excluded", "uncertain"]),
    holds: z.array(z.string().min(3).max(250)).max(30),
    externalLastActivityAt: z.string().datetime({ offset: true }).nullable(),
    evidenceReference: z.string().trim().min(10).max(1000),
    reviewedAt: z.string().datetime({ offset: true }),
  })
  .strict();

/** Owner attestation records a reference only; no external evidence is fetched. */
export async function recordOutreachQualification(
  tx: TeamMutationTransaction,
  ownerId: string,
  input: z.infer<typeof QualificationSchema>,
) {
  const now = new Date();
  if (
    new Date(input.reviewedAt) > now ||
    (input.externalLastActivityAt &&
      new Date(input.externalLastActivityAt) > now)
  )
    throw new TeamMutationFailure(
      "invalid",
      "Evidence timestamps cannot be in the future.",
    );
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${input.contactId},0))`,
  );
  const [contact] = await tx
    .select({ id: contacts.id })
    .from(contacts)
    .where(eq(contacts.id, input.contactId));
  if (!contact)
    throw new TeamMutationFailure("invalid", "Contact not found.", {
      status: 404,
    });
  const [prior] = await tx.execute<{ version: number }>(
    sql`select version from sms_outreach_qualifications where contact_id=${input.contactId}::uuid for update`,
  );
  if ((prior?.version ?? 0) !== input.expectedVersion)
    throw new TeamMutationFailure(
      "conflict",
      "Qualification changed. Refresh before editing.",
    );
  await tx.execute(sql`insert into sms_outreach_qualifications(contact_id,version,qualification,facebook_status,holds,external_last_activity_at,evidence_reference,reviewed_at,reviewed_by)
    values(${input.contactId}::uuid,${input.expectedVersion + 1},${input.qualification},${input.facebookStatus},${JSON.stringify(input.holds)}::jsonb,${input.externalLastActivityAt}::timestamptz,${input.evidenceReference},${input.reviewedAt}::timestamptz,${ownerId}::uuid)
    on conflict(contact_id) do update set version=excluded.version,qualification=excluded.qualification,facebook_status=excluded.facebook_status,holds=excluded.holds,external_last_activity_at=excluded.external_last_activity_at,evidence_reference=excluded.evidence_reference,reviewed_at=excluded.reviewed_at,reviewed_by=excluded.reviewed_by`);
  return { contactId: input.contactId, version: input.expectedVersion + 1 };
}

export async function previewIndividualSms(
  db: Executor,
  selection: Selection,
  options: {
    now?: Date;
    ignoreMessageId?: string;
    ignoreRecipientId?: string;
  } = {},
) {
  const now = options.now ?? new Date();
  const blockers: SmsBlocker[] = [];
  const block = (code: string, detail: string) =>
    blockers.push({ code, detail });
  const [draft] = await db.execute<DraftRow>(
    sql`select d.*, (select max(v.version)::int from sms_campaign_drafts v where v.campaign_id=d.campaign_id and v.contact_id=d.contact_id) latest_version from sms_campaign_drafts d where d.id=${selection.draftId}::uuid and d.contact_id=${selection.contactId}::uuid`,
  );
  if (!draft)
    return {
      selection,
      review: null,
      blockers: [
        {
          code: "draft_not_found",
          detail: "No saved draft belongs to that exact contact and draft ID.",
        },
      ],
      eligible: false,
    };
  const [campaign] = await db
    .select()
    .from(smsCampaigns)
    .where(eq(smsCampaigns.id, draft.campaign_id));
  if (!campaign)
    throw new TeamMutationFailure("invalid", "Campaign not found.", {
      status: 404,
    });
  if (
    draft.version !== selection.version ||
    draft.latest_version !== selection.version
  )
    block(
      "draft_version_changed",
      "Select and review the latest saved draft version.",
    );
  if (hash(draft.body) !== draft.body_hash)
    block(
      "draft_integrity_changed",
      "Saved wording no longer matches its immutable digest.",
    );
  if (
    campaign.terms.deliveryMode !== "individual_drafts" ||
    campaign.terms.discountBasisPoints !== 3000 ||
    campaign.terms.audience !== "customers_and_leads"
  )
    block(
      "wrong_campaign_type",
      "Choose a 30% individual-draft campaign for customers and leads.",
    );
  if (["paused", "completed", "cancelled"].includes(campaign.status))
    block("campaign_not_releasable", `Campaign is ${campaign.status}.`);
  campaignTermIssues(campaign.terms, now).forEach((detail) =>
    block("offer_terms", detail),
  );
  const readiness = campaignReadiness();
  readiness.blockers.forEach((detail) => block("campaign_readiness", detail));
  if (campaign.sender && campaign.sender !== readiness.sender)
    block(
      "sender_changed",
      "The configured Stonegate number changed after campaign approval.",
    );
  const [contact] = await db
    .select()
    .from(contacts)
    .where(eq(contacts.id, selection.contactId));
  const phone = campaignPhone(contact?.phoneE164 ?? contact?.phone);
  if (!contact || contact.deletedAt || contact.mergedIntoContactId)
    block("contact_unavailable", "Contact is missing, deleted or merged.");
  if (contact?.doNotContact)
    block(
      "do_not_contact",
      "The contact has an active do-not-contact restriction.",
    );
  if (!phone) block("invalid_phone", "Contact has no usable saved SMS number.");
  if (
    contact?.phoneE164 &&
    contact.phone &&
    campaignPhone(contact.phoneE164) !== campaignPhone(contact.phone)
  )
    block(
      "phone_fields_conflict",
      "Saved raw and normalized phone fields disagree; resolve the destination before sending.",
    );
  if (
    contact &&
    ["natasha larson", "tim gant", "kim spratlin"].includes(
      `${contact.firstName} ${contact.lastName}`
        .trim()
        .replace(/\s+/g, " ")
        .toLowerCase(),
    )
  )
    block(
      "named_exclusion",
      "Owner-named exclusion; uncertain name matches also require disambiguation.",
    );
  const [qualification] = await db.execute<QualificationRow>(
    sql`select * from sms_outreach_qualifications where contact_id=${selection.contactId}::uuid`,
  );
  if (!qualification || qualification.qualification === "unverified")
    block(
      "qualification_unverified",
      "An owner must reference evidence of a legitimate inquiry, quote or past job. A completed job is optional.",
    );
  if (!qualification || qualification.facebook_status !== "clear")
    block(
      "facebook_exclusion",
      "Facebook outreach exclusion or unresolved overlap must remain on hold.",
    );
  if (
    qualification &&
    (new Date(qualification.reviewed_at).getTime() > now.getTime() ||
      now.getTime() - new Date(qualification.reviewed_at).getTime() >
        24 * 60 * 60_000)
  )
    block(
      "external_history_review_stale",
      "Refresh the owner review of external Facebook/mailbox history within 24 hours of release.",
    );
  for (const hold of qualification?.holds ?? [])
    block("owner_service_or_identity_hold", hold);
  const cutoff = new Date(now.getTime() - 21 * 86400_000).toISOString();
  if (
    qualification?.external_last_activity_at &&
    new Date(qualification.external_last_activity_at).getTime() >=
      new Date(cutoff).getTime()
  )
    block(
      "recent_external_activity_21_days",
      "Recorded external conversation is within the rolling 21-day window.",
    );
  const threads = await db.execute<{ id: string; staff_scope: string }>(
    sql`select id,staff_scope from conversation_threads where contact_id=${selection.contactId}::uuid and channel='sms' order by id`,
  );
  const threadId =
    threads.length === 1 && threads[0]!.staff_scope === "general"
      ? threads[0]!.id
      : null;
  if (threads.length > 1 || (threads.length === 1 && !threadId))
    block(
      "sms_thread_ambiguous",
      "Multiple SMS threads or a non-general thread exist; resolve ownership before release.",
    );
  if (phone) {
    const owners = await db.execute<{ id: string }>(
      sql`select id from contacts where phone_e164=${phone} or regexp_replace(coalesce(phone,''),'[^0-9]','','g') in (${phone.slice(1)},${phone.slice(2)})`,
    );
    if (owners.length !== 1 || owners[0]?.id !== selection.contactId)
      block(
        "phone_ownership_ambiguous",
        "This destination belongs to multiple or conflicting CRM identities.",
      );
    const [staff] = await db.execute(
      sql`select 1 from team_members where phone_e164=${phone} limit 1`,
    );
    if (staff || readiness.testNumbers.includes(phone))
      block(
        "staff_or_test_number",
        "Use the separate owner-test path for staff or test numbers.",
      );
    if (threadId) {
      const addresses = await db.execute<{
        contact_id: string | null;
        external_address: string | null;
      }>(
        sql`select contact_id,external_address from conversation_participants where thread_id=${threadId}::uuid and participant_type='contact'`,
      );
      if (
        addresses.some(
          (a) =>
            (a.contact_id && a.contact_id !== selection.contactId) ||
            (a.external_address && campaignPhone(a.external_address) !== phone),
        )
      )
        block(
          "thread_phone_mismatch",
          "An SMS thread participant points to another contact or number.",
        );
    }
  }
  const [facebook] = await db.execute(
    sql`select 1 from conversation_threads where contact_id=${selection.contactId}::uuid and channel='dm' limit 1`,
  );
  if (facebook)
    block(
      "facebook_history",
      "This CRM contact has Facebook/DM history and is outside the CRM-only promotion.",
    );
  const [activeJob] = await db.execute(
    sql`select 1 from appointments where contact_id=${selection.contactId}::uuid and status not in ('completed','canceled','no_show') limit 1`,
  );
  if (activeJob)
    block("active_job", "An active or unresolved job exists for this contact.");
  const [recentMessage] = await db.execute(
    sql`select 1 from conversation_messages m join conversation_threads t on t.id=m.thread_id where t.contact_id=${selection.contactId}::uuid and coalesce(m.received_at,m.sent_at,m.created_at)>=${cutoff}::timestamptz and (${options.ignoreMessageId ?? null}::uuid is null or m.id<>${options.ignoreMessageId ?? null}::uuid) limit 1`,
  );
  if (recentMessage)
    block(
      "recent_message_21_days",
      "SMS, email, Facebook or other conversation activity occurred within 21 days.",
    );
  const [recentCall] = await db.execute(
    sql`select 1 from call_records where created_at>=${cutoff}::timestamptz and (contact_id=${selection.contactId}::uuid or (${phone}::text is not null and (regexp_replace(coalesce(from_number,''),'[^0-9]','','g') in (${phone?.slice(1) ?? ""},${phone?.slice(2) ?? ""}) or regexp_replace(coalesce(to_number,''),'[^0-9]','','g') in (${phone?.slice(1) ?? ""},${phone?.slice(2) ?? ""})))) limit 1`,
  );
  if (recentCall)
    block(
      "recent_call_21_days",
      "A linked call or call to/from this destination occurred within 21 days.",
    );
  const [recentBusiness] = await db.execute(
    sql`select 1 from (select created_at,updated_at from quotes where contact_id=${selection.contactId}::uuid union all select created_at,updated_at from appointments where contact_id=${selection.contactId}::uuid) activity where greatest(created_at,updated_at)>=${cutoff}::timestamptz limit 1`,
  );
  if (recentBusiness)
    block(
      "recent_quote_or_job_21_days",
      "A quote or job was created or updated within 21 days.",
    );
  const consent = phone ? await latestCampaignConsent(db, phone) : null;
  if (
    !consent ||
    consent.status !== "granted" ||
    consent.contactId !== selection.contactId
  )
    block(
      consent?.status === "revoked"
        ? "opted_out"
        : "marketing_consent_unverified",
      "Current promotional permission for this exact contact and phone is required; ownership of a phone is not consent.",
    );
  const zone = consent
    ? DateTime.fromJSDate(now, { zone: consent.timeZone })
    : null;
  if (consent && !zone?.isValid)
    block("recipient_timezone_unknown", "Verify the recipient timezone.");
  // Quiet hours and pacing defer the queued message in guardCampaignDispatch.
  const deliveryHolds: SmsBlocker[] = [];
  if (zone?.isValid && (zone.hour < 9 || zone.hour >= 18))
    deliveryHolds.push({
      code: "quiet_hours",
      detail:
        "Delivery waits until 9am–6pm in the recipient's verified timezone.",
    });
  if (campaign.nextSendAt && campaign.nextSendAt > now)
    deliveryHolds.push({
      code: "campaign_pacing",
      detail: `Delivery waits until ${campaign.nextSendAt.toISOString()}.`,
    });
  const [already] = await db.execute(
    sql`select 1 from sms_campaign_recipients where is_test=false and (phone=${phone} or contact_id=${selection.contactId}::uuid) and (${options.ignoreRecipientId ?? null}::uuid is null or id<>${options.ignoreRecipientId ?? null}::uuid) and (campaign_id=${campaign.id}::uuid or created_at>${new Date(now.getTime() - 30 * 86400_000).toISOString()}::timestamptz) limit 1`,
  );
  if (already)
    block(
      "duplicate_or_recent_promotion",
      "This destination/contact already has a release in this campaign or the 30-day promotion cooldown.",
    );
  const [uncertain] = await db.execute(
    sql`select 1 from external_message_dispatches d join sms_campaign_recipients r on r.message_id=d.message_id where r.campaign_id=${campaign.id}::uuid and d.state='reconciliation_required' limit 1`,
  );
  if (uncertain)
    block(
      "reconciliation_required",
      "Resolve uncertain provider work before releasing another promotional SMS.",
    );
  const [tested] = await db.execute(
    sql`select 1 from sms_campaign_recipients r join conversation_messages m on m.id=r.message_id where r.campaign_id=${campaign.id}::uuid and r.is_test=true and m.delivery_status in ('sent','delivered') and m.metadata->>'campaignTestFingerprint'=${campaignTestFingerprint(campaign.terms, readiness.sender)} limit 1`,
  );
  if (!tested)
    block(
      "owner_test_required",
      "The existing campaign owner-test check for this offer and sender has not passed.",
    );
  if (
    !(
      await readCampaignCapacity(
        campaign.terms.serviceThrough,
        now,
        "rollback" in db ? db : undefined,
      )
    ).hasOpening
  )
    block(
      "service_capacity",
      "No standard job opening was found before the offer's service cutoff.",
    );
  const review =
    phone && readiness.sender && consent && qualification
      ? {
          contactId: selection.contactId,
          draftId: draft.id,
          version: draft.version,
          campaignId: campaign.id,
          campaignVersion: campaign.version,
          qualificationVersion: qualification.version,
          destination: phone,
          sender: readiness.sender,
          text: draft.body,
          bodyHash: draft.body_hash,
          threadId,
          consentId: consent.id,
          discountBasisPoints: 3000 as const,
          expiresAt: campaign.terms.expiresAt ?? "",
          serviceThrough: campaign.terms.serviceThrough ?? "",
        }
      : null;
  return {
    selection,
    review,
    blockers,
    deliveryHolds,
    eligible: blockers.length === 0,
    reviewExpiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
    segments: smsSegments(draft.body),
    estimatedCost:
      readiness.segmentPrice === null
        ? null
        : smsSegments(draft.body) * readiness.segmentPrice,
    savedText: draft.body,
    destination: phone,
    sender: readiness.sender,
  };
}

export async function individualSmsStatus(db: Executor, selection: Selection) {
  const [row] = await db.execute<{
    contact_id: string;
    draft_id: string;
    thread_id: string;
    message_id: string;
    delivery_status: string;
    suppression_reason: string | null;
    dispatch_state: string | null;
  }>(
    sql`select r.contact_id,r.draft_id,m.thread_id,m.id message_id,m.delivery_status,r.suppression_reason,(select d.state from external_message_dispatches d where d.message_id=m.id order by d.attempt_number desc limit 1) dispatch_state from sms_campaign_recipients r join sms_campaign_drafts v on v.id=r.draft_id join conversation_messages m on m.id=r.message_id where r.draft_id=${selection.draftId}::uuid and r.contact_id=${selection.contactId}::uuid and v.version=${selection.version} and r.is_test=false`,
  );
  return row
    ? {
        contactId: row.contact_id,
        draftId: row.draft_id,
        threadId: row.thread_id,
        messageId: row.message_id,
        deliveryState:
          row.dispatch_state === "reconciliation_required"
            ? "reconciliation_required"
            : row.suppression_reason
              ? "suppressed"
              : row.delivery_status,
        providerState: row.dispatch_state,
        blocker: row.suppression_reason,
      }
    : null;
}

export async function releaseIndividualSms(
  tx: TeamMutationTransaction,
  mutation: TeamMutationContext,
  input: z.infer<typeof SingleSmsReleaseSchema>,
) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended('sms-campaign-launch',0))`,
  );
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${input.contactId},0))`,
  );
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`system-outbound:${input.contactId}:sms`},0))`,
  );
  await tx.execute(
    sql`select id from sms_campaigns where id=${input.review.campaignId}::uuid for update`,
  );
  const prior = await individualSmsStatus(tx, input);
  if (prior) return { released: 0, replay: true, ...prior };
  const now = new Date();
  if (
    new Date(input.reviewExpiresAt) <= now ||
    new Date(input.reviewExpiresAt).getTime() > now.getTime() + 10 * 60_000
  )
    throw new TeamMutationFailure(
      "conflict",
      "The send preview expired. Preview and approve the exact text again.",
    );
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`sms-consent:${input.review.destination}`},0))`,
  );
  const current = await previewIndividualSms(tx, input, { now });
  if (!current.eligible)
    return {
      released: 0,
      deliveryState: "blocked",
      blockers: current.blockers,
    };
  if (
    !current.review ||
    fingerprint(current.review) !== fingerprint(input.review)
  )
    throw new TeamMutationFailure(
      "conflict",
      "Destination, sender, draft, offer, thread or consent changed after review.",
    );
  const r = current.review;
  const [review] = await tx
    .insert(smsCampaignReviews)
    .values({
      campaignId: r.campaignId,
      version: r.campaignVersion,
      sender: r.sender,
      createdBy: mutation.actor.id!,
      expiresAt: new Date(input.reviewExpiresAt),
      consumedAt: now,
      recipients: [
        {
          contactId: r.contactId,
          phone: r.destination,
          name: "Individual saved draft",
          reason: null,
          consentId: r.consentId,
          timeZone: null,
          body: r.text,
          segments: smsSegments(r.text),
        },
      ],
    })
    .returning();
  const [batch] = await tx
    .insert(smsCampaignBatches)
    .values({
      campaignId: r.campaignId,
      reviewId: review!.id,
      releasedBy: mutation.actor.id!,
    })
    .returning();
  const recipientId = randomUUID();
  await tx.insert(smsCampaignRecipients).values({
    id: recipientId,
    campaignId: r.campaignId,
    batchId: batch!.id,
    contactId: r.contactId,
    phone: r.destination,
    name: "Individual saved draft",
    consentId: r.consentId,
    body: r.text,
    draftId: r.draftId,
  });
  const messageId = await queueSystemOutboundMessage({
    db: tx,
    contactId: r.contactId,
    channel: "sms",
    generalThreadOnly: true,
    threadId: r.threadId ?? undefined,
    toAddress: r.destination,
    body: r.text,
    metadata: {
      smsCampaignId: r.campaignId,
      smsCampaignRecipientId: recipientId,
      smsDraftId: r.draftId,
      smsDraftVersion: r.version,
      smsDraftBodyHash: r.bodyHash,
      reviewedSender: r.sender,
    },
    dedupeKey: `sms-campaign:${r.campaignId}:${hash(r.destination)}`,
  });
  if (!messageId)
    throw new TeamMutationFailure(
      "conflict",
      "Contact became unavailable; nothing was queued.",
    );
  await tx
    .update(smsCampaignRecipients)
    .set({ messageId })
    .where(eq(smsCampaignRecipients.id, recipientId));
  await tx
    .update(smsCampaigns)
    .set({
      status: "active",
      sender: r.sender,
      activatedAt: sql`coalesce(${smsCampaigns.activatedAt},${now.toISOString()}::timestamptz)`,
      updatedAt: now,
    })
    .where(eq(smsCampaigns.id, r.campaignId));
  await tx
    .update(conversationMessages)
    .set({ fromAddress: r.sender })
    .where(eq(conversationMessages.id, messageId));
  await tx.execute(
    sql`update conversation_threads set status='open' where id=(select thread_id from conversation_messages where id=${messageId}::uuid)`,
  );
  return {
    released: 1,
    replay: false,
    ...(await individualSmsStatus(tx, input)),
    deliveryHolds: current.deliveryHolds,
  };
}
