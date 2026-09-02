import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  auditLogs,
  getDb,
  partnerAccounts,
  partnerAuthChallenges,
  partnerUsers,
  type PartnerAuthChallengePurpose,
} from "@/db";
import { sendEmailMessage } from "@/lib/messaging";
import { resolvePublicSiteBaseUrl } from "@/lib/partner-portal-auth";

export type PartnerAuthEmailDeliveryOutcome =
  | { status: "processed" }
  | { status: "skipped"; error: string };

function hashToken(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function expectedPath(purpose: PartnerAuthChallengePurpose): string {
  if (purpose === "email_verification") return "/partners/verify";
  if (purpose === "account_activation") return "/partners/activate";
  if (purpose === "password_reset") return "/partners/reset-password";
  return "/partners/confirm-email";
}

function safeDeliveryUrl(
  value: string,
  purpose: PartnerAuthChallengePurpose,
): { tokenHash: string; url: string } | null {
  try {
    const url = new URL(value);
    if (process.env["NODE_ENV"] === "production" && url.protocol !== "https:") {
      return null;
    }
    const configuredBase = resolvePublicSiteBaseUrl();
    if (
      !configuredBase ||
      url.origin !== new URL(configuredBase).origin ||
      url.pathname !== expectedPath(purpose)
    ) {
      return null;
    }
    const token = url.searchParams.get("token")?.trim() ?? "";
    if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) return null;
    return { tokenHash: hashToken(token), url: url.toString() };
  } catch {
    return null;
  }
}

function copyFor(input: {
  purpose: PartnerAuthChallengePurpose;
  name: string | null;
  accountName: string | null;
  deliveryUrl: string;
  expiresAt: Date;
}) {
  const greeting = input.name ? `Hi ${input.name},` : "Hello,";
  if (input.purpose === "email_verification") {
    return {
      subject: "Verify your email for Stonegate Partner access",
      body: [
        greeting,
        "",
        "Verify this email before completing your Stonegate Partner Portal application:",
        input.deliveryUrl,
        "",
        `This one-time link expires at ${input.expiresAt.toISOString()}.`,
        "If you did not request partner access, you can ignore this email.",
      ].join("\n"),
    };
  }
  if (input.purpose === "account_activation") {
    return {
      subject: "Activate your Stonegate Partner Portal account",
      body: [
        greeting,
        "",
        `Stonegate granted your access${input.accountName ? ` to ${input.accountName}` : ""}. Set or confirm your password and complete the required security setup:`,
        input.deliveryUrl,
        "",
        `This one-time link expires at ${input.expiresAt.toISOString()}.`,
        "If you were not expecting this approval, contact Stonegate support.",
      ].join("\n"),
    };
  }
  if (input.purpose === "email_change") {
    return {
      subject: "Confirm your new Stonegate Partner Portal email",
      body: [
        greeting,
        "",
        "Confirm this address as the new sign-in email for your Stonegate Partner Portal identity:",
        input.deliveryUrl,
        "",
        `This one-time link expires at ${input.expiresAt.toISOString()}.`,
        "The link confirms the mailbox only; it does not sign anyone in. If you did not request this change, do not use the link and contact Stonegate support.",
      ].join("\n"),
    };
  }
  return {
    subject: "Reset your Stonegate Partner Portal password",
    body: [
      greeting,
      "",
      "Use this one-time link to reset your Stonegate Partner Portal password:",
      input.deliveryUrl,
      "",
      `This link expires at ${input.expiresAt.toISOString()}.`,
      "If you did not request a reset, you can ignore this email. Your password has not changed.",
    ].join("\n"),
  };
}

/**
 * Claims one challenge before SMTP. A retry after an ambiguous provider call
 * requires reconciliation rather than sending the bearer credential twice.
 */
export async function processPartnerAuthEmail(input: {
  challengeId: string;
  purpose: PartnerAuthChallengePurpose;
  generation: number;
  outboxEventId: string;
  deliveryUrl: string;
  correlationId: string | null;
}): Promise<PartnerAuthEmailDeliveryOutcome> {
  const parsed = safeDeliveryUrl(input.deliveryUrl, input.purpose);
  if (!parsed) {
    return { status: "skipped", error: "partner_auth_email_payload_invalid" };
  }
  const db = getDb();
  const attemptId = randomUUID();
  const prepared = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: partnerAuthChallenges.id,
        purpose: partnerAuthChallenges.purpose,
        status: partnerAuthChallenges.status,
        normalizedEmail: partnerAuthChallenges.normalizedEmail,
        tokenHash: partnerAuthChallenges.tokenHash,
        generation: partnerAuthChallenges.generation,
        userId: partnerAuthChallenges.partnerUserId,
        accountId: partnerAuthChallenges.partnerAccountId,
        expiresAt: partnerAuthChallenges.expiresAt,
        deliveryStatus: partnerAuthChallenges.deliveryStatus,
        deliveryOutboxEventId: partnerAuthChallenges.deliveryOutboxEventId,
      })
      .from(partnerAuthChallenges)
      .where(eq(partnerAuthChallenges.id, input.challengeId))
      .for("update")
      .limit(1);
    if (
      !row ||
      row.purpose !== input.purpose ||
      row.status !== "pending" ||
      row.generation !== input.generation ||
      row.deliveryOutboxEventId !== input.outboxEventId ||
      row.tokenHash !== parsed.tokenHash
    ) {
      return { kind: "terminal" as const };
    }
    const now = new Date();
    if (row.expiresAt <= now) {
      await tx
        .update(partnerAuthChallenges)
        .set({
          status: "expired",
          tokenHash: null,
          expiredAt: now,
          updatedAt: now,
        })
        .where(eq(partnerAuthChallenges.id, row.id));
      return { kind: "terminal" as const };
    }
    if (row.deliveryStatus === "dispatching") {
      await tx
        .update(partnerAuthChallenges)
        .set({
          deliveryStatus: "reconciliation_required",
          deliveryDetail: "dispatch_result_not_persisted",
          updatedAt: now,
        })
        .where(eq(partnerAuthChallenges.id, row.id));
      return { kind: "terminal" as const };
    }
    if (row.deliveryStatus !== "queued") {
      return { kind: "terminal" as const };
    }
    const [claimed] = await tx
      .update(partnerAuthChallenges)
      .set({
        deliveryStatus: "dispatching",
        deliveryAttemptId: attemptId,
        dispatchStartedAt: now,
        deliveryDetail: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(partnerAuthChallenges.id, row.id),
          eq(partnerAuthChallenges.deliveryStatus, "queued"),
          eq(partnerAuthChallenges.generation, input.generation),
        ),
      )
      .returning({ id: partnerAuthChallenges.id });
    if (!claimed) return { kind: "terminal" as const };
    const [user] = row.userId
      ? await tx
          .select({ name: partnerUsers.name })
          .from(partnerUsers)
          .where(eq(partnerUsers.id, row.userId))
          .limit(1)
      : [];
    const [account] = row.accountId
      ? await tx
          .select({ name: partnerAccounts.name })
          .from(partnerAccounts)
          .where(eq(partnerAccounts.id, row.accountId))
          .limit(1)
      : [];
    return {
      kind: "dispatch" as const,
      row,
      name: user?.name ?? null,
      accountName: account?.name ?? null,
    };
  });
  if (prepared.kind !== "dispatch") return { status: "processed" };

  const copy = copyFor({
    purpose: prepared.row.purpose,
    name: prepared.name,
    accountName: prepared.accountName,
    deliveryUrl: parsed.url,
    expiresAt: prepared.row.expiresAt,
  });
  let result: Awaited<ReturnType<typeof sendEmailMessage>>;
  try {
    result = await sendEmailMessage(
      prepared.row.normalizedEmail,
      copy.subject,
      copy.body,
      {
        idempotencyKey: `partner-auth:${input.outboxEventId}:${input.generation}`,
      },
    );
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
    const [current] = await tx
      .select({
        id: partnerAuthChallenges.id,
        status: partnerAuthChallenges.status,
        purpose: partnerAuthChallenges.purpose,
        generation: partnerAuthChallenges.generation,
        attemptId: partnerAuthChallenges.deliveryAttemptId,
        outboxId: partnerAuthChallenges.deliveryOutboxEventId,
        userId: partnerAuthChallenges.partnerUserId,
      })
      .from(partnerAuthChallenges)
      .where(eq(partnerAuthChallenges.id, input.challengeId))
      .for("update")
      .limit(1);
    if (
      !current ||
      current.status !== "pending" ||
      current.purpose !== input.purpose ||
      current.generation !== input.generation ||
      current.attemptId !== attemptId ||
      current.outboxId !== input.outboxEventId
    ) {
      return;
    }
    const now = new Date();
    const succeeded = result.ok && result.deliveryCertainty === "accepted";
    const deliveryStatus = succeeded
      ? "accepted"
      : result.deliveryCertainty === "uncertain"
        ? "reconciliation_required"
        : "failed";
    await tx
      .update(partnerAuthChallenges)
      .set({
        deliveryStatus,
        deliveryProvider: result.provider ?? null,
        deliveryProviderMessageId: result.providerMessageId ?? null,
        deliveryDetail: result.detail?.slice(0, 500) ?? null,
        sentAt: succeeded ? now : null,
        updatedAt: now,
      })
      .where(eq(partnerAuthChallenges.id, current.id));
    await tx.insert(auditLogs).values({
      actorType: "system",
      actorId: current.userId,
      actorLabel: "partner-auth-outbox",
      authMethod: "service",
      correlationId: input.correlationId,
      outcome: succeeded ? "succeeded" : "failed",
      surface: "outbox",
      providerOperationId: result.providerMessageId ?? null,
      action: succeeded
        ? "partner.auth.email.delivery_accepted"
        : deliveryStatus === "reconciliation_required"
          ? "partner.auth.email.delivery_reconciliation_required"
          : "partner.auth.email.delivery_failed",
      entityType: "partner_auth_challenge",
      entityId: current.id,
      meta: {
        purpose: input.purpose,
        generation: input.generation,
        outboxEventId: input.outboxEventId,
        provider: result.provider ?? null,
      },
    });
  });
  return { status: "processed" };
}
