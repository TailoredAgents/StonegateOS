import { createHash } from "node:crypto";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  auditLogs,
  getDb,
  partnerAccountMemberships,
  partnerAccounts,
  partnerCompanyJoinRequests,
  partnerNotificationPreferences,
  partnerNotifications,
  partnerRoleTemplates,
  partnerUsers,
} from "@/db";
import {
  computePartnerCapabilities,
  isPartnerLaunchRoleKey,
  PARTNER_LAUNCH_ROLE_KEYS,
  type PartnerPrincipal,
} from "@/lib/partner-account-authorization";
import { mayAssignInvitationRole } from "@/lib/partner-account-invitations";
import { resolvePublicSiteBaseUrl } from "@/lib/partner-portal-auth";
import { arePartnerPortalOutboundNotificationsEnabled } from "@/lib/partner-portal-feature-flags";
import type { PortalV2StoredResult } from "@/lib/partner-portal-v2-idempotency";
import {
  normalizeCompanyDomain,
  normalizedEmailDomain,
} from "@/lib/partner-portal-v2-security";
import {
  createPortalV2StrongEtag,
  evaluatePortalV2RevisionPrecondition,
} from "@/lib/portal-v2-contract";
import { nextQuietHoursEnd } from "@/lib/policy";
import { queueSystemOutboundMessage } from "@/lib/system-outbound";
import type { TeamMutationTransaction } from "@/lib/team-mutation";

const ACTIVE_STATES = ["submitted", "under_review", "needs_information"] as const;
const PUBLIC_DOMAINS = new Set([
  "aol.com", "gmail.com", "googlemail.com", "hotmail.com", "icloud.com",
  "live.com", "mail.com", "outlook.com", "proton.me", "protonmail.com",
  "yahoo.com",
]);

export const PartnerJoinDecisionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("approve"),
    roleKey: z.enum(PARTNER_LAUNCH_ROLE_KEYS),
    persona: z.enum(["contractor", "real_estate_agent", "property_manager", "commercial_client", "other"]),
    note: z.string().trim().max(500).nullable().optional(),
  }).strict(),
  z.object({
    action: z.literal("decline"),
    note: z.string().trim().min(2).max(500),
  }).strict(),
  z.object({
    action: z.literal("needs_information"),
    note: z.string().trim().min(2).max(500),
  }).strict(),
]);

type JoinDecisionStatus = "approved" | "declined" | "needs_information";

export type PartnerJoinDecisionNotificationContent = {
  eventKey: "account_access";
  title: string;
  body: string;
  actionPath: "/partners";
  emailSubject: string;
  emailBody: string;
};

function safeDisplayText(value: string, fallback: string, maxLength: number): string {
  const withoutControls = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127 ? " " : character;
  }).join("");
  const normalized = withoutControls.replace(/\s+/gu, " ").trim();
  return (normalized || fallback).slice(0, maxLength);
}

/**
 * Customer copy is intentionally built without the request message, reviewer
 * note, account UUID, membership UUID, or request UUID. Decision details stay
 * in the tenant-scoped record and audit trail.
 */
export function buildPartnerJoinDecisionNotification(input: {
  status: JoinDecisionStatus;
  accountName: string;
  userName: string;
  portalUrl: string | null;
}): PartnerJoinDecisionNotificationContent {
  const accountName = safeDisplayText(input.accountName, "your company", 120);
  const userName = safeDisplayText(input.userName, "there", 80);
  const decision = input.status === "approved"
    ? {
        title: "Company access approved",
        body: `Your request to join ${accountName}'s Stonegate partner workspace was approved. Sign in to open the workspace.`,
        emailSubject: "Your Stonegate partner access was approved",
      }
    : input.status === "declined"
      ? {
          title: "Company access request declined",
          body: `A company administrator declined your request to join ${accountName}'s Stonegate partner workspace. No access was granted.`,
          emailSubject: "Update on your Stonegate partner access request",
        }
      : {
          title: "More information needed",
          body: `A company administrator needs more information before deciding your request to join ${accountName}. Sign in to review your access status and contact support.`,
          emailSubject: "More information is needed for your Stonegate access request",
        };
  const emailBody = [
    `Hi ${userName},`,
    "",
    decision.body,
    ...(input.portalUrl ? ["", "Open the Partner Portal:", input.portalUrl] : []),
    "",
    "This is a transactional account-access update.",
  ].join("\n");
  return {
    eventKey: "account_access",
    title: decision.title,
    body: decision.body,
    actionPath: "/partners",
    emailSubject: decision.emailSubject,
    emailBody,
  };
}

type JoinNotificationTarget = {
  accountId: string;
  membershipId: string;
  inAppAccessible: boolean;
};

type JoinNotificationOutcome = {
  inApp: "queued" | "preference_suppressed" | "membership_unavailable";
  email: "queued" | "preference_suppressed" | "feature_disabled" | "recipient_suppressed";
};

function hashedDecisionOperationKey(input: {
  requestId: string;
  status: JoinDecisionStatus;
  version: number;
}): string {
  return createHash("sha256")
    .update(`partner-company-join-decision\0${input.requestId}\0${input.status}\0${input.version}`)
    .digest("hex");
}

function deterministicNotificationId(operationHash: string): string {
  const chars = operationHash.slice(0, 32).split("");
  chars[12] = "5";
  chars[16] = ((Number.parseInt(chars[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  const hex = chars.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function defaultNotificationTarget(
  tx: TeamMutationTransaction,
  partnerUserId: string,
): Promise<JoinNotificationTarget | null> {
  const [target] = await tx.select({
    accountId: partnerAccountMemberships.partnerAccountId,
    membershipId: partnerAccountMemberships.id,
    status: partnerAccountMemberships.status,
  }).from(partnerAccountMemberships)
    .innerJoin(partnerAccounts, eq(partnerAccountMemberships.partnerAccountId, partnerAccounts.id))
    .where(and(
      eq(partnerAccountMemberships.partnerUserId, partnerUserId),
      eq(partnerAccounts.portalAccessEnabled, true),
    ))
    .orderBy(
      desc(sql`${partnerAccountMemberships.status} = 'active'`),
      desc(partnerAccountMemberships.isDefault),
      desc(partnerAccountMemberships.updatedAt),
    )
    .limit(1);
  return target
    ? {
        accountId: target.accountId,
        membershipId: target.membershipId,
        inAppAccessible: target.status === "active",
      }
    : null;
}

async function queueJoinDecisionNotifications(input: {
  tx: TeamMutationTransaction;
  requestId: string;
  status: JoinDecisionStatus;
  version: number;
  decisionAccountId: string;
  accountName: string;
  userName: string;
  userEmail: string;
  userContactId: string | null;
  target: JoinNotificationTarget | null;
  now: Date;
}): Promise<JoinNotificationOutcome> {
  const [storedPreference] = input.target
    ? await input.tx.select({
        inAppEnabled: partnerNotificationPreferences.inAppEnabled,
        emailEnabled: partnerNotificationPreferences.emailEnabled,
        quietHoursStart: partnerNotificationPreferences.quietHoursStart,
        quietHoursEnd: partnerNotificationPreferences.quietHoursEnd,
        timezone: partnerNotificationPreferences.timezone,
      }).from(partnerNotificationPreferences).where(and(
        eq(partnerNotificationPreferences.partnerAccountId, input.target.accountId),
        eq(partnerNotificationPreferences.membershipId, input.target.membershipId),
        eq(partnerNotificationPreferences.eventKey, "account_access"),
      )).limit(1)
    : [];
  const preference = storedPreference ?? {
    inAppEnabled: true,
    emailEnabled: true,
    quietHoursStart: null,
    quietHoursEnd: null,
    timezone: "America/New_York",
  };
  const base = resolvePublicSiteBaseUrl();
  const portalUrl = base ? new URL("/partners", base).toString() : null;
  const content = buildPartnerJoinDecisionNotification({
    status: input.status,
    accountName: input.accountName,
    userName: input.userName,
    portalUrl,
  });
  const operationHash = hashedDecisionOperationKey({
    requestId: input.requestId,
    status: input.status,
    version: input.version,
  });
  let inApp: JoinNotificationOutcome["inApp"] = input.target?.inAppAccessible
    ? "preference_suppressed"
    : "membership_unavailable";
  if (preference.inAppEnabled && input.target?.inAppAccessible) {
    await input.tx.insert(partnerNotifications).values({
      id: deterministicNotificationId(operationHash),
      partnerAccountId: input.target.accountId,
      membershipId: input.target.membershipId,
      eventKey: content.eventKey,
      title: content.title,
      body: content.body,
      actionPath: content.actionPath,
      createdAt: input.now,
    }).onConflictDoNothing({ target: partnerNotifications.id });
    inApp = "queued";
  }
  if (!preference.emailEnabled) return { inApp, email: "preference_suppressed" };
  if (!arePartnerPortalOutboundNotificationsEnabled(input.decisionAccountId)) {
    return { inApp, email: "feature_disabled" };
  }
  // The system-outbound compatibility projection is contact-scoped. Joining
  // and in-app notification remain account/membership-native, while email is
  // safely suppressed when this identity has no optional CRM projection.
  if (!input.userContactId) {
    return { inApp, email: "recipient_suppressed" };
  }
  const nextAttemptAt = preference.quietHoursStart && preference.quietHoursEnd
    ? nextQuietHoursEnd(input.now, "email", {
        channels: { email: { start: preference.quietHoursStart, end: preference.quietHoursEnd } },
      }, preference.timezone)
    : null;
  const messageId = await queueSystemOutboundMessage({
    db: input.tx,
    contactId: input.userContactId,
    channel: "email",
    toAddress: input.userEmail,
    subject: content.emailSubject,
    body: content.emailBody,
    metadata: {
      partnerPortal: true,
      kind: "partner.company_join_decision",
      decision: input.status,
    },
    dedupeKey: `partner.join.decision:${operationHash}`,
    nextAttemptAt,
  });
  return { inApp, email: messageId ? "queued" : "recipient_suppressed" };
}

type JoinRow = {
  id: string;
  partnerUserId: string;
  partnerAccountId: string;
  requestedRoleKey: string;
  message: string | null;
  status: "submitted" | "under_review" | "needs_information" | "approved" | "declined" | "withdrawn";
  version: number;
  reviewedByPartnerUserId: string | null;
  resolvedMembershipId: string | null;
  reviewNote: string | null;
  reviewedAt: Date | null;
  requestedAt: Date;
  updatedAt: Date;
  userName: string;
  userEmail: string;
  userContactId: string | null;
  userActive: boolean;
};

function selection() {
  return {
    id: partnerCompanyJoinRequests.id,
    partnerUserId: partnerCompanyJoinRequests.partnerUserId,
    partnerAccountId: partnerCompanyJoinRequests.partnerAccountId,
    requestedRoleKey: partnerCompanyJoinRequests.requestedRoleKey,
    message: partnerCompanyJoinRequests.message,
    status: partnerCompanyJoinRequests.status,
    version: partnerCompanyJoinRequests.version,
    reviewedByPartnerUserId: partnerCompanyJoinRequests.reviewedByPartnerUserId,
    resolvedMembershipId: partnerCompanyJoinRequests.resolvedMembershipId,
    reviewNote: partnerCompanyJoinRequests.reviewNote,
    reviewedAt: partnerCompanyJoinRequests.reviewedAt,
    requestedAt: partnerCompanyJoinRequests.requestedAt,
    updatedAt: partnerCompanyJoinRequests.updatedAt,
    userName: partnerUsers.name,
    userEmail: partnerUsers.email,
    userContactId: partnerUsers.orgContactId,
    userActive: partnerUsers.active,
  };
}

function revision(row: JoinRow): string {
  return `${row.id}:${row.partnerAccountId}:${row.partnerUserId}:${row.status}:${row.version}:${row.updatedAt.toISOString()}`;
}

function dto(row: JoinRow): Record<string, unknown> {
  return {
    id: row.id,
    requester: { name: row.userName, email: row.userEmail },
    requestedRoleKey: row.requestedRoleKey,
    message: row.message,
    status: row.status,
    version: row.version,
    review: {
      note: row.reviewNote,
      reviewedAt: row.reviewedAt?.toISOString() ?? null,
    },
    requestedAt: row.requestedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    allowedActions: ACTIVE_STATES.includes(row.status as (typeof ACTIVE_STATES)[number])
      ? row.status === "needs_information"
        ? ["approve", "decline"]
        : ["approve", "needs_information", "decline"]
      : [],
    etag: createPortalV2StrongEtag(revision(row)),
  };
}

export async function hasAccountJoinRequest(accountId: string, requestId: string): Promise<boolean> {
  const [row] = await getDb().select({ id: partnerCompanyJoinRequests.id })
    .from(partnerCompanyJoinRequests)
    .where(and(
      eq(partnerCompanyJoinRequests.id, requestId),
      eq(partnerCompanyJoinRequests.partnerAccountId, accountId),
    )).limit(1);
  return Boolean(row);
}

export async function listAccountJoinRequests(input: {
  principal: PartnerPrincipal;
  limit: number;
}): Promise<Record<string, unknown>[]> {
  if (!input.principal.accountId) return [];
  const rows = await getDb().select(selection())
    .from(partnerCompanyJoinRequests)
    .innerJoin(partnerUsers, eq(partnerCompanyJoinRequests.partnerUserId, partnerUsers.id))
    .where(eq(partnerCompanyJoinRequests.partnerAccountId, input.principal.accountId))
    .orderBy(desc(partnerCompanyJoinRequests.requestedAt), desc(partnerCompanyJoinRequests.id))
    .limit(input.limit);
  return rows.map(dto);
}

export function verifiedJoinDomain(accountDomain: string | null, userEmail: string): boolean {
  const account = normalizeCompanyDomain(accountDomain);
  const email = normalizedEmailDomain(userEmail);
  return Boolean(account && email && account === email && !PUBLIC_DOMAINS.has(email));
}

export async function decideAccountJoinRequest(input: {
  principal: PartnerPrincipal;
  requestId: string;
  decision: z.infer<typeof PartnerJoinDecisionSchema>;
  ifMatch: string | null;
  correlationId: string;
  idempotencyKeyHash: string;
}): Promise<PortalV2StoredResult> {
  const accountId = input.principal.accountId;
  const actorMembershipId = input.principal.membershipId;
  if (!accountId || !actorMembershipId) {
    return { status: 409, body: { ok: false, error: "legacy_scope_unavailable" } };
  }
  return getDb().transaction(async (tx): Promise<PortalV2StoredResult> => {
    const [account] = await tx.select({
      id: partnerAccounts.id,
      name: partnerAccounts.name,
      domain: partnerAccounts.domain,
      portalAccessEnabled: partnerAccounts.portalAccessEnabled,
    }).from(partnerAccounts).where(eq(partnerAccounts.id, accountId)).for("update").limit(1);
    if (!account) return { status: 404, body: { ok: false, error: "not_found" } };
    if (!account.portalAccessEnabled) return { status: 403, body: { ok: false, error: "forbidden" } };

    const [actor] = await tx.select({
      id: partnerAccountMemberships.id,
      userId: partnerAccountMemberships.partnerUserId,
      status: partnerAccountMemberships.status,
      accessLevel: partnerAccountMemberships.accessLevel,
      roleKey: partnerAccountMemberships.roleKey,
      grants: partnerAccountMemberships.capabilityGrants,
      denies: partnerAccountMemberships.capabilityDenies,
      roleCapabilities: partnerRoleTemplates.capabilities,
      roleActive: partnerRoleTemplates.active,
    }).from(partnerAccountMemberships)
      .leftJoin(
        partnerRoleTemplates,
        and(
          eq(partnerAccountMemberships.roleTemplateId, partnerRoleTemplates.id),
          or(
            isNull(partnerRoleTemplates.partnerAccountId),
            eq(partnerRoleTemplates.partnerAccountId, accountId),
          ),
        ),
      )
      .where(and(
        eq(partnerAccountMemberships.id, actorMembershipId),
        eq(partnerAccountMemberships.partnerAccountId, accountId),
        eq(partnerAccountMemberships.partnerUserId, input.principal.partnerUserId),
      )).limit(1);
    const actorCapabilities = actor ? computePartnerCapabilities({
      roleCapabilities: actor.roleActive ? (actor.roleCapabilities ?? []) : [],
      grants: actor.grants,
      denies: actor.denies,
    }) : [];
    if (
      !actor || actor.status !== "active" || actor.accessLevel !== "account" ||
      !actorCapabilities.includes("account.members.manage")
    ) return { status: 403, body: { ok: false, error: "forbidden" } };

    const [request] = await tx.select(selection())
      .from(partnerCompanyJoinRequests)
      .innerJoin(partnerUsers, eq(partnerCompanyJoinRequests.partnerUserId, partnerUsers.id))
      .where(and(
        eq(partnerCompanyJoinRequests.id, input.requestId),
        eq(partnerCompanyJoinRequests.partnerAccountId, accountId),
      )).for("update").limit(1);
    if (!request) return { status: 404, body: { ok: false, error: "not_found" } };
    const precondition = evaluatePortalV2RevisionPrecondition({
      ifMatch: input.ifMatch,
      currentRevision: revision(request),
      correlationId: input.correlationId,
    });
    if (!precondition.ok) {
      return { status: precondition.response.status, body: { ...precondition.response.body }, headers: { ETag: precondition.currentEtag } };
    }
    if (!ACTIVE_STATES.includes(request.status as (typeof ACTIVE_STATES)[number])) {
      return { status: 409, body: { ok: false, error: "conflict", reason: "join_request_not_pending" } };
    }
    if (request.partnerUserId === input.principal.partnerUserId) {
      return { status: 409, body: { ok: false, error: "conflict", reason: "self_approval" } };
    }
    if (!request.userActive) {
      return { status: 409, body: { ok: false, error: "conflict", reason: "identity_inactive" } };
    }
    const now = new Date();
    if (
      input.decision.action === "decline" ||
      input.decision.action === "needs_information"
    ) {
      if (
        input.decision.action === "needs_information" &&
        request.status === "needs_information"
      ) {
        return {
          status: 409,
          body: {
            ok: false,
            error: "conflict",
            reason: "information_already_requested",
          },
        };
      }
      const nextStatus = input.decision.action === "decline"
        ? "declined" as const
        : "needs_information" as const;
      const [updated] = await tx.update(partnerCompanyJoinRequests).set({
        status: nextStatus,
        reviewedByPartnerUserId: input.principal.partnerUserId,
        reviewNote: input.decision.note,
        reviewedAt: now,
        version: sql`${partnerCompanyJoinRequests.version} + 1`,
        updatedAt: now,
      }).where(and(
        eq(partnerCompanyJoinRequests.id, request.id),
        eq(partnerCompanyJoinRequests.partnerAccountId, accountId),
        eq(partnerCompanyJoinRequests.version, request.version),
      )).returning();
      if (!updated) return { status: 412, body: { ok: false, error: "revision_mismatch" } };
      const target = await defaultNotificationTarget(tx, request.partnerUserId);
      const notification = await queueJoinDecisionNotifications({
        tx,
        requestId: request.id,
        status: nextStatus,
        version: request.version + 1,
        decisionAccountId: accountId,
        accountName: account.name,
        userName: request.userName,
        userEmail: request.userEmail,
        userContactId: request.userContactId,
        target,
        now,
      });
      await tx.insert(auditLogs).values({
        actorType: "human", actorId: input.principal.partnerUserId,
        actorLabel: input.principal.email, actorRole: actor.roleKey,
        sessionId: input.principal.session.id, authMethod: "partner_session",
        correlationId: input.correlationId, requiredPermissions: ["account.members.manage"],
        outcome: "succeeded", surface: "partner_portal_v2",
        idempotencyKeyHash: input.idempotencyKeyHash,
        action: `partner.company_join_request.${nextStatus}`,
        entityType: "partner_company_join_request", entityId: request.id,
        meta: {
          partnerAccountId: accountId,
          requesterPartnerUserId: request.partnerUserId,
          notification,
        },
      });
      const row: JoinRow = {
        ...request,
        status: nextStatus,
        reviewNote: input.decision.note,
        reviewedAt: now,
        reviewedByPartnerUserId: input.principal.partnerUserId,
        version: request.version + 1,
        updatedAt: now,
      };
      return {
        status: 200,
        body: { ok: true, joinRequest: dto(row) },
        headers: { ETag: createPortalV2StrongEtag(revision(row)) },
      };
    }

    if (!verifiedJoinDomain(account.domain, request.userEmail)) {
      return { status: 409, body: { ok: false, error: "conflict", reason: "domain_no_longer_verified" } };
    }
    if (!isPartnerLaunchRoleKey(input.decision.roleKey)) {
      return {
        status: 422,
        body: {
          ok: false,
          error: "invalid_fields",
          fieldErrors: { roleKey: "Choose one of the four account roles." },
        },
      };
    }
    const [existingMembership] = await tx.select({ id: partnerAccountMemberships.id, status: partnerAccountMemberships.status })
      .from(partnerAccountMemberships).where(and(
        eq(partnerAccountMemberships.partnerAccountId, accountId),
        eq(partnerAccountMemberships.partnerUserId, request.partnerUserId),
      )).for("update").limit(1);
    if (existingMembership) {
      return { status: 409, body: { ok: false, error: "conflict", reason: existingMembership.status === "active" ? "already_member" : "existing_access_requires_staff_review" } };
    }
    const [role] = await tx.select({
      id: partnerRoleTemplates.id,
      key: partnerRoleTemplates.key,
      capabilities: partnerRoleTemplates.capabilities,
    }).from(partnerRoleTemplates).where(and(
      eq(partnerRoleTemplates.key, input.decision.roleKey),
      eq(partnerRoleTemplates.active, true),
      isNull(partnerRoleTemplates.partnerAccountId),
    )).orderBy(partnerRoleTemplates.partnerAccountId).limit(1);
    if (!role || !mayAssignInvitationRole({ actorCapabilities, roleCapabilities: role.capabilities })) {
      return { status: 403, body: { ok: false, error: "forbidden" } };
    }
    const [anyDefault] = await tx.select({ id: partnerAccountMemberships.id })
      .from(partnerAccountMemberships).where(and(
        eq(partnerAccountMemberships.partnerUserId, request.partnerUserId),
        eq(partnerAccountMemberships.status, "active"),
        eq(partnerAccountMemberships.isDefault, true),
      )).limit(1);
    const [membership] = await tx.insert(partnerAccountMemberships).values({
      partnerAccountId: accountId,
      partnerUserId: request.partnerUserId,
      roleTemplateId: role.id,
      roleKey: role.key,
      status: "active",
      persona: input.decision.persona,
      accessLevel: "account",
      isDefault: !anyDefault,
      invitedByPartnerUserId: input.principal.partnerUserId,
      invitedAt: now,
      acceptedAt: now,
      createdAt: now,
      updatedAt: now,
    }).returning({ id: partnerAccountMemberships.id });
    if (!membership) throw new Error("join_membership_insert_failed");
    const [updated] = await tx.update(partnerCompanyJoinRequests).set({
      status: "approved",
      reviewedByPartnerUserId: input.principal.partnerUserId,
      resolvedMembershipId: membership.id,
      reviewNote: input.decision.note ?? null,
      reviewedAt: now,
      version: sql`${partnerCompanyJoinRequests.version} + 1`,
      updatedAt: now,
    }).where(and(
      eq(partnerCompanyJoinRequests.id, request.id),
      eq(partnerCompanyJoinRequests.partnerAccountId, accountId),
      eq(partnerCompanyJoinRequests.version, request.version),
    )).returning();
    if (!updated) throw new Error("join_request_update_failed");
    const notification = await queueJoinDecisionNotifications({
      tx,
      requestId: request.id,
      status: "approved",
      version: request.version + 1,
      decisionAccountId: accountId,
      accountName: account.name,
      userName: request.userName,
      userEmail: request.userEmail,
      userContactId: request.userContactId,
      target: { accountId, membershipId: membership.id, inAppAccessible: true },
      now,
    });
    await tx.insert(auditLogs).values({
      actorType: "human", actorId: input.principal.partnerUserId,
      actorLabel: input.principal.email, actorRole: actor.roleKey,
      sessionId: input.principal.session.id, authMethod: "partner_session",
      correlationId: input.correlationId, requiredPermissions: ["account.members.manage"],
      outcome: "succeeded", surface: "partner_portal_v2",
      idempotencyKeyHash: input.idempotencyKeyHash,
      action: "partner.company_join_request.approved",
      entityType: "partner_company_join_request", entityId: request.id,
      meta: {
        partnerAccountId: accountId,
        requesterPartnerUserId: request.partnerUserId,
        membershipId: membership.id,
        roleKey: role.key,
        notification,
      },
    });
    const row: JoinRow = { ...request, status: "approved", resolvedMembershipId: membership.id, reviewNote: input.decision.note ?? null, reviewedAt: now, reviewedByPartnerUserId: input.principal.partnerUserId, version: request.version + 1, updatedAt: now };
    return {
      status: 200,
      body: { ok: true, joinRequest: dto(row), membershipId: membership.id },
      headers: { ETag: createPortalV2StrongEtag(revision(row)) },
    };
  });
}
