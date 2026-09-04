import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  auditLogs,
  getDb,
  outboxEvents,
  partnerAccessApplications,
} from "@/db";
import { sendEmailMessage } from "@/lib/messaging";
import {
  normalizeEmail,
  resolvePublicSiteBaseUrl,
} from "@/lib/partner-portal-auth";
import type { TeamMutationTransaction } from "@/lib/team-mutation";

export const PARTNER_ACCESS_APPLICATION_EMAIL_EVENT =
  "partner.access_application.email";

export type PartnerAccessApplicationEmailDecision =
  | "declined"
  | "needs_information";

export type PartnerAccessApplicationEmailOutcome =
  | { status: "processed" }
  | { status: "retry"; error: string; nextAttemptAt: Date }
  | { status: "skipped"; error: string };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DISPATCH_LEASE_MS = 15 * 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableUuid(value: string): string {
  const chars = createHash("sha256")
    .update(value, "utf8")
    .digest("hex")
    .slice(0, 32)
    .split("");
  chars[12] = "5";
  chars[16] = ((Number.parseInt(chars[16] ?? "0", 16) & 0x3) | 0x8).toString(
    16,
  );
  const hex = chars.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function emailFingerprint(value: string): string {
  return createHash("sha256")
    .update("partner-application-email\0", "utf8")
    .update(value, "utf8")
    .digest("hex");
}

export function partnerAccessApplicationEmailEventId(input: {
  applicationId: string;
  status: PartnerAccessApplicationEmailDecision;
  version: number;
}): string {
  return stableUuid(
    `${PARTNER_ACCESS_APPLICATION_EMAIL_EVENT}\0${input.applicationId}\0${input.status}\0${input.version}`,
  );
}

function safeDisplayText(
  value: string | null | undefined,
  fallback: string,
  maximum: number,
): string {
  const normalized = Array.from(value?.normalize("NFKC") ?? "", (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127 ? " " : character;
  })
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  return (normalized || fallback).slice(0, maximum);
}

export function buildPartnerAccessApplicationDecisionEmail(input: {
  status: PartnerAccessApplicationEmailDecision;
  name: string;
  companyName: string;
  informationRequest: string | null;
  applicationUrl: string | null;
}): { subject: string; text: string } {
  const name = safeDisplayText(input.name, "there", 80);
  const companyName = safeDisplayText(input.companyName, "your company", 120);
  if (input.status === "declined") {
    return {
      subject: "Update on your Stonegate partner access request",
      text: [
        `Hi ${name},`,
        "",
        `Stonegate could not approve the partner access request for ${companyName}. No partner account or company access was activated.`,
        "",
        "If you believe your company information has changed, contact Stonegate support before submitting another request.",
        "",
        "This is a transactional update about your Partner Portal application.",
      ].join("\n"),
    };
  }

  const informationRequest = safeDisplayText(
    input.informationRequest,
    "Please review and complete the requested application details.",
    2_000,
  );
  return {
    subject: "More information is needed for your partner access request",
    text: [
      `Hi ${name},`,
      "",
      `Stonegate needs a little more information before reviewing the partner access request for ${companyName}.`,
      "",
      "Requested information:",
      informationRequest,
      ...(input.applicationUrl
        ? ["", "Return to your application:", input.applicationUrl]
        : []),
      "",
      "If your access link expired, verify the same email address again to continue.",
      "",
      "This is a transactional update about your Partner Portal application.",
    ].join("\n"),
  };
}

export async function queuePartnerAccessApplicationDecisionEmail(
  tx: TeamMutationTransaction,
  input: {
    applicationId: string;
    status: PartnerAccessApplicationEmailDecision;
    version: number;
    correlationId: string;
    now: Date;
  },
): Promise<{ outboxEventId: string }> {
  if (
    !UUID_PATTERN.test(input.applicationId) ||
    !Number.isSafeInteger(input.version) ||
    input.version < 1 ||
    !input.correlationId ||
    input.correlationId.length > 128 ||
    !["declined", "needs_information"].includes(input.status)
  ) {
    throw new TypeError("partner_application_email_input_invalid");
  }
  const outboxEventId = partnerAccessApplicationEmailEventId(input);
  const payload = {
    applicationId: input.applicationId,
    status: input.status,
    version: input.version,
    correlationId: input.correlationId,
  };
  const [inserted] = await tx
    .insert(outboxEvents)
    .values({
      id: outboxEventId,
      type: PARTNER_ACCESS_APPLICATION_EMAIL_EVENT,
      payload,
      createdAt: input.now,
    })
    .onConflictDoNothing({ target: outboxEvents.id })
    .returning({ id: outboxEvents.id });
  if (!inserted) {
    const [existing] = await tx
      .select({ type: outboxEvents.type, payload: outboxEvents.payload })
      .from(outboxEvents)
      .where(eq(outboxEvents.id, outboxEventId))
      .limit(1);
    if (
      existing?.type !== PARTNER_ACCESS_APPLICATION_EMAIL_EVENT ||
      !isRecord(existing.payload) ||
      existing.payload["applicationId"] !== payload.applicationId ||
      existing.payload["status"] !== payload.status ||
      existing.payload["version"] !== payload.version ||
      existing.payload["correlationId"] !== payload.correlationId
    ) {
      throw new Error("partner_application_email_outbox_conflict");
    }
  }
  return { outboxEventId };
}

function deliveryAuditValues(input: {
  id: string;
  action: string;
  outcome: "attempted" | "succeeded" | "failed";
  applicationId: string;
  reviewerId: string;
  correlationId: string | null;
  outboxEventId: string;
  status: PartnerAccessApplicationEmailDecision;
  version: number;
  emailHash: string;
  provider?: string | null;
  providerOperationId?: string | null;
  createdAt: Date;
}) {
  return {
    id: input.id,
    actorType: "system" as const,
    actorId: null,
    actorLabel: "partner-application-outbox",
    authMethod: "service",
    correlationId: input.correlationId,
    outcome: input.outcome,
    surface: "outbox",
    providerOperationId: input.providerOperationId ?? null,
    action: input.action,
    entityType: "partner_access_application",
    entityId: input.applicationId,
    meta: {
      decision: input.status,
      version: input.version,
      outboxEventId: input.outboxEventId,
      sourceReviewerId: input.reviewerId,
      emailHash: input.emailHash,
      provider: input.provider ?? null,
    },
    createdAt: input.createdAt,
  };
}

export async function processPartnerAccessApplicationDecisionEmail(input: {
  applicationId: string;
  status: PartnerAccessApplicationEmailDecision;
  version: number;
  outboxEventId: string;
  correlationId: string | null;
}): Promise<PartnerAccessApplicationEmailOutcome> {
  if (
    !UUID_PATTERN.test(input.applicationId) ||
    input.outboxEventId !== partnerAccessApplicationEmailEventId(input)
  ) {
    return {
      status: "skipped",
      error: "partner_application_email_event_mismatch",
    };
  }
  const db = getDb();
  const dispatchAuditId = stableUuid(
    `partner-application-email-dispatch\0${input.outboxEventId}`,
  );
  const resultAuditId = stableUuid(
    `partner-application-email-result\0${input.outboxEventId}`,
  );
  const prepared = await db.transaction(async (tx) => {
    const [application] = await tx
      .select({
        id: partnerAccessApplications.id,
        status: partnerAccessApplications.status,
        version: partnerAccessApplications.version,
        flowVersion: partnerAccessApplications.flowVersion,
        normalizedEmail: partnerAccessApplications.normalizedEmail,
        emailVerifiedAt: partnerAccessApplications.emailVerifiedAt,
        name: partnerAccessApplications.name,
        companyName: partnerAccessApplications.companyName,
        reviewNote: partnerAccessApplications.reviewNote,
        reviewedByMemberId: partnerAccessApplications.reviewedByMemberId,
      })
      .from(partnerAccessApplications)
      .where(eq(partnerAccessApplications.id, input.applicationId))
      .limit(1);
    const normalizedEmail = normalizeEmail(application?.normalizedEmail ?? "");
    if (
      !application ||
      application.flowVersion !== 2 ||
      application.status !== input.status ||
      application.version !== input.version ||
      !application.emailVerifiedAt ||
      !application.reviewedByMemberId ||
      !normalizedEmail ||
      normalizedEmail !== application.normalizedEmail ||
      (input.status === "needs_information" && !application.reviewNote?.trim())
    ) {
      return { kind: "invalid" as const };
    }
    const [completed] = await tx
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(eq(auditLogs.id, resultAuditId))
      .limit(1);
    if (completed) return { kind: "complete" as const };
    const [existingDispatch] = await tx
      .select({ createdAt: auditLogs.createdAt })
      .from(auditLogs)
      .where(eq(auditLogs.id, dispatchAuditId))
      .limit(1);
    const now = new Date();
    const emailHash = emailFingerprint(normalizedEmail);
    if (existingDispatch) {
      if (
        now.getTime() - existingDispatch.createdAt.getTime() <
        DISPATCH_LEASE_MS
      ) {
        return { kind: "in_progress" as const };
      }
      await tx
        .insert(auditLogs)
        .values(
          deliveryAuditValues({
            id: resultAuditId,
            action:
              "partner.access_application.email.delivery_reconciliation_required",
            outcome: "failed",
            applicationId: application.id,
            reviewerId: application.reviewedByMemberId,
            correlationId: input.correlationId,
            outboxEventId: input.outboxEventId,
            status: input.status,
            version: input.version,
            emailHash,
            createdAt: now,
          }),
        )
        .onConflictDoNothing({ target: auditLogs.id });
      return { kind: "complete" as const };
    }
    const [claimed] = await tx
      .insert(auditLogs)
      .values(
        deliveryAuditValues({
          id: dispatchAuditId,
          action: "partner.access_application.email.dispatch_started",
          outcome: "attempted",
          applicationId: application.id,
          reviewerId: application.reviewedByMemberId,
          correlationId: input.correlationId,
          outboxEventId: input.outboxEventId,
          status: input.status,
          version: input.version,
          emailHash,
          createdAt: now,
        }),
      )
      .onConflictDoNothing({ target: auditLogs.id })
      .returning({ id: auditLogs.id });
    return claimed
      ? {
          kind: "dispatch" as const,
          application,
          normalizedEmail,
          emailHash,
        }
      : { kind: "in_progress" as const };
  });

  if (prepared.kind === "invalid") {
    return { status: "skipped", error: "partner_application_email_stale" };
  }
  if (prepared.kind === "complete") return { status: "processed" };
  if (prepared.kind === "in_progress") {
    return {
      status: "retry",
      error: "partner_application_email_dispatch_in_progress",
      nextAttemptAt: new Date(Date.now() + DISPATCH_LEASE_MS),
    };
  }

  const base = resolvePublicSiteBaseUrl();
  const copy = buildPartnerAccessApplicationDecisionEmail({
    status: input.status,
    name: prepared.application.name,
    companyName: prepared.application.companyName,
    informationRequest:
      input.status === "needs_information"
        ? prepared.application.reviewNote
        : null,
    applicationUrl: base
      ? new URL("/partners/application", base).toString()
      : null,
  });
  let result: Awaited<ReturnType<typeof sendEmailMessage>>;
  try {
    result = await sendEmailMessage(
      prepared.normalizedEmail,
      copy.subject,
      copy.text,
      {
        idempotencyKey: `partner-application:${input.outboxEventId}:${input.version}`,
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

  const succeeded = result.ok && result.deliveryCertainty === "accepted";
  const reconciliationRequired = result.deliveryCertainty === "uncertain";
  await db
    .insert(auditLogs)
    .values(
      deliveryAuditValues({
        id: resultAuditId,
        action: succeeded
          ? "partner.access_application.email.delivery_accepted"
          : reconciliationRequired
            ? "partner.access_application.email.delivery_reconciliation_required"
            : "partner.access_application.email.delivery_failed",
        outcome: succeeded ? "succeeded" : "failed",
        applicationId: prepared.application.id,
        reviewerId: prepared.application.reviewedByMemberId!,
        correlationId: input.correlationId,
        outboxEventId: input.outboxEventId,
        status: input.status,
        version: input.version,
        emailHash: prepared.emailHash,
        provider: result.provider ?? null,
        providerOperationId: result.providerMessageId ?? null,
        createdAt: new Date(),
      }),
    )
    .onConflictDoNothing({ target: auditLogs.id });
  return { status: "processed" };
}
