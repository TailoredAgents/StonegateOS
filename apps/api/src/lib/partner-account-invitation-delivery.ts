import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  auditLogs,
  contacts,
  getDb,
  partnerAccountInvitations,
  partnerAccounts,
} from "@/db";
import { sendEmailMessage } from "@/lib/messaging";
import { hashPartnerInvitationToken } from "@/lib/partner-account-invitations";
import { resolvePublicSiteBaseUrl } from "@/lib/partner-portal-auth";

export type PartnerInvitationDeliveryOutcome =
  | { status: "processed" }
  | { status: "skipped"; error: string };

function safeDeliveryUrl(value: string): { tokenHash: string; url: string } | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && process.env["NODE_ENV"] === "production") return null;
    if (url.pathname !== "/partners/invitations/accept") return null;
    const configuredBase = resolvePublicSiteBaseUrl();
    if (!configuredBase || url.origin !== new URL(configuredBase).origin) return null;
    const token = url.searchParams.get("token")?.trim() ?? "";
    if (!/^[A-Za-z0-9_-]{32,256}$/u.test(token)) return null;
    return { tokenHash: hashPartnerInvitationToken(token), url: url.toString() };
  } catch {
    return null;
  }
}

/**
 * Durable invitation delivery with a pre-provider dispatch marker. SMTP has
 * no exactly-once key, so a retry that observes `dispatching` is moved to
 * reconciliation instead of risking a second invitation email.
 */
export async function processPartnerAccountInvitationEmail(input: {
  invitationId: string;
  generation: number;
  outboxEventId: string;
  deliveryUrl: string;
  correlationId: string | null;
}): Promise<PartnerInvitationDeliveryOutcome> {
  const parsed = safeDeliveryUrl(input.deliveryUrl);
  if (!parsed) return { status: "skipped", error: "partner_invitation_payload_invalid" };
  const db = getDb();
  const attemptId = randomUUID();
  const [candidate] = await db.select({
    accountId: partnerAccountInvitations.partnerAccountId,
  }).from(partnerAccountInvitations)
    .where(eq(partnerAccountInvitations.id, input.invitationId))
    .limit(1);
  if (!candidate) return { status: "processed" };
  const prepared = await db.transaction(async (tx) => {
    const [account] = await tx.select({
      id: partnerAccounts.id,
      name: partnerAccounts.name,
    }).from(partnerAccounts)
      .where(eq(partnerAccounts.id, candidate.accountId))
      .for("update")
      .limit(1);
    if (!account) return { kind: "terminal" as const };
    const [row] = await tx
      .select({
        id: partnerAccountInvitations.id,
        accountId: partnerAccountInvitations.partnerAccountId,
        email: partnerAccountInvitations.normalizedEmail,
        inviteeName: partnerAccountInvitations.inviteeName,
        roleKey: partnerAccountInvitations.roleKey,
        status: partnerAccountInvitations.status,
        tokenHash: partnerAccountInvitations.tokenHash,
        generation: partnerAccountInvitations.generation,
        expiresAt: partnerAccountInvitations.expiresAt,
        deliveryStatus: partnerAccountInvitations.deliveryStatus,
        deliveryOutboxEventId: partnerAccountInvitations.deliveryOutboxEventId,
      })
      .from(partnerAccountInvitations)
      .where(and(
        eq(partnerAccountInvitations.id, input.invitationId),
        eq(partnerAccountInvitations.partnerAccountId, account.id),
      ))
      .for("update")
      .limit(1);
    if (
      !row ||
      row.status !== "pending" ||
      row.generation !== input.generation ||
      row.deliveryOutboxEventId !== input.outboxEventId ||
      row.tokenHash !== parsed.tokenHash
    ) {
      return { kind: "terminal" as const };
    }
    const now = new Date();
    if (row.expiresAt <= now) {
      await tx.update(partnerAccountInvitations).set({
        status: "expired",
        tokenHash: null,
        expiredAt: now,
        version: sql`${partnerAccountInvitations.version} + 1`,
        updatedAt: now,
      }).where(eq(partnerAccountInvitations.id, row.id));
      return { kind: "terminal" as const };
    }
    const [restrictedRecipient] = await tx.select({ id: contacts.id })
      .from(contacts)
      .where(and(
        sql`lower(btrim(${contacts.email})) = ${row.email}`,
        sql`(${contacts.doNotContact} = true OR ${contacts.deletedAt} IS NOT NULL)`,
      ))
      .limit(1);
    if (restrictedRecipient) {
      await tx.update(partnerAccountInvitations).set({
        deliveryStatus: "failed",
        deliveryDetail: "recipient_suppressed",
        updatedAt: now,
      }).where(eq(partnerAccountInvitations.id, row.id));
      await tx.insert(auditLogs).values({
        actorType: "system",
        actorLabel: "partner-invitation-outbox",
        authMethod: "service",
        correlationId: input.correlationId,
        outcome: "failed",
        surface: "outbox",
        action: "partner.account_invitation.delivery_suppressed",
        entityType: "partner_account_invitation",
        entityId: row.id,
        meta: { partnerAccountId: row.accountId, generation: row.generation, outboxEventId: input.outboxEventId },
      });
      return { kind: "terminal" as const };
    }
    if (row.deliveryStatus === "dispatching") {
      await tx.update(partnerAccountInvitations).set({
        deliveryStatus: "reconciliation_required",
        deliveryDetail: "dispatch_result_not_persisted",
        updatedAt: now,
      }).where(eq(partnerAccountInvitations.id, row.id));
      await tx.insert(auditLogs).values({
        actorType: "system",
        actorLabel: "partner-invitation-outbox",
        authMethod: "service",
        correlationId: input.correlationId,
        outcome: "failed",
        surface: "outbox",
        action: "partner.account_invitation.delivery_reconciliation_required",
        entityType: "partner_account_invitation",
        entityId: row.id,
        meta: { partnerAccountId: row.accountId, generation: row.generation, outboxEventId: input.outboxEventId },
      });
      return { kind: "terminal" as const };
    }
    if (row.deliveryStatus !== "queued") return { kind: "terminal" as const };
    const [claimed] = await tx.update(partnerAccountInvitations).set({
      deliveryStatus: "dispatching",
      deliveryAttemptId: attemptId,
      dispatchStartedAt: now,
      deliveryDetail: null,
      updatedAt: now,
    }).where(and(
      eq(partnerAccountInvitations.id, row.id),
      eq(partnerAccountInvitations.deliveryStatus, "queued"),
      eq(partnerAccountInvitations.generation, input.generation),
    )).returning({ id: partnerAccountInvitations.id });
    return claimed
      ? { kind: "dispatch" as const, row: { ...row, accountName: account.name } }
      : { kind: "terminal" as const };
  });
  if (prepared.kind !== "dispatch") return { status: "processed" };

  const subject = `You’re invited to ${prepared.row.accountName} on Stonegate`;
  const body = [
    `Hi ${prepared.row.inviteeName},`,
    "",
    `${prepared.row.accountName} invited you to its Stonegate partner workspace as ${prepared.row.roleKey.replaceAll("_", " ")}.`,
    "",
    "Review and accept this one-time invitation within 30 minutes:",
    parsed.url,
    "",
    "If you weren’t expecting this invitation, you can ignore this email.",
  ].join("\n");
  let result: Awaited<ReturnType<typeof sendEmailMessage>>;
  try {
    result = await sendEmailMessage(prepared.row.email, subject, body, {
      idempotencyKey: `partner-invitation:${input.outboxEventId}:${input.generation}`,
    });
  } catch {
    result = {
      ok: false,
      provider: "smtp",
      providerIdempotencySupported: false,
      deliveryCertainty: "uncertain",
      detail: "provider_dispatch_exception",
    };
  }

  await db.transaction(async (tx) => {
    const [current] = await tx.select({
      id: partnerAccountInvitations.id,
      accountId: partnerAccountInvitations.partnerAccountId,
      attemptId: partnerAccountInvitations.deliveryAttemptId,
      generation: partnerAccountInvitations.generation,
      outboxId: partnerAccountInvitations.deliveryOutboxEventId,
      status: partnerAccountInvitations.status,
    }).from(partnerAccountInvitations)
      .where(eq(partnerAccountInvitations.id, input.invitationId))
      .for("update")
      .limit(1);
    if (
      !current ||
      current.status !== "pending" ||
      current.attemptId !== attemptId ||
      current.generation !== input.generation ||
      current.outboxId !== input.outboxEventId
    ) return;
    const now = new Date();
    const succeeded = result.ok && result.deliveryCertainty === "accepted";
    const deliveryStatus = succeeded
      ? "accepted"
      : result.deliveryCertainty === "uncertain"
        ? "reconciliation_required"
        : "failed";
    await tx.update(partnerAccountInvitations).set({
      deliveryStatus,
      deliveryProvider: result.provider ?? null,
      deliveryProviderMessageId: result.providerMessageId ?? null,
      deliveryDetail: result.detail?.slice(0, 500) ?? null,
      sentAt: succeeded ? now : null,
      updatedAt: now,
    }).where(eq(partnerAccountInvitations.id, current.id));
    await tx.insert(auditLogs).values({
      actorType: "system",
      actorLabel: "partner-invitation-outbox",
      authMethod: "service",
      correlationId: input.correlationId,
      outcome: succeeded ? "succeeded" : "failed",
      surface: "outbox",
      providerOperationId: result.providerMessageId ?? null,
      action: succeeded
        ? "partner.account_invitation.delivery_accepted"
        : deliveryStatus === "reconciliation_required"
          ? "partner.account_invitation.delivery_reconciliation_required"
          : "partner.account_invitation.delivery_failed",
      entityType: "partner_account_invitation",
      entityId: current.id,
      meta: { partnerAccountId: current.accountId, generation: input.generation, outboxEventId: input.outboxEventId, provider: result.provider ?? null },
    });
  });
  return { status: "processed" };
}
