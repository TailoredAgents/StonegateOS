import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  auditLogs,
  contacts,
  getDb,
  outboxEvents,
  partnerAccountInvitations,
  partnerAccountMemberships,
  partnerAccounts,
  partnerRoleTemplates,
  partnerSessions,
  partnerUsers,
} from "@/db";
import {
  computePartnerCapabilities,
  type PartnerCapability,
  type PartnerPrincipal,
} from "@/lib/partner-account-authorization";
import {
  getClientIp,
  getUserAgent,
  randomToken,
  resolvePublicSiteBaseUrl,
  sha256Base64Url,
} from "@/lib/partner-portal-auth";
import type { PortalV2StoredResult } from "@/lib/partner-portal-v2-idempotency";
import type { TeamMutationTransaction } from "@/lib/team-mutation";
import {
  createPortalV2StrongEtag,
  evaluatePortalV2RevisionPrecondition,
} from "@/lib/portal-v2-contract";
import type { NextRequest } from "next/server";

const INVITATION_TTL_MS = 30 * 60 * 1_000;
const PERSONAS = [
  "contractor",
  "real_estate_agent",
  "property_manager",
  "commercial_client",
  "other",
] as const;

export const PartnerInvitationCreateSchema = z
  .object({
    email: z.string().trim().email().max(254),
    name: z.string().trim().min(2).max(120),
    roleKey: z
      .string()
      .trim()
      .min(2)
      .max(64)
      .regex(/^[a-z][a-z0-9_]{1,63}$/u),
    persona: z.enum(PERSONAS),
  })
  .strict();

export const PartnerInvitationActionSchema = z
  .object({ action: z.enum(["resend", "revoke"]) })
  .strict();

export const PartnerInvitationAcceptanceSchema = z
  .object({ token: z.string().trim().min(32).max(256), rememberMe: z.boolean().optional() })
  .strict();

type InvitationRow = typeof partnerAccountInvitations.$inferSelect;

export function normalizeInvitationEmail(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

export function hashPartnerInvitationToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

function emailFingerprint(email: string): string {
  return createHash("sha256")
    .update("partner-invitation-email\0", "utf8")
    .update(email, "utf8")
    .digest("hex");
}

function makeCredential(): { rawToken: string; tokenHash: string } {
  const rawToken = randomBytes(32).toString("base64url");
  return { rawToken, tokenHash: hashPartnerInvitationToken(rawToken) };
}

function capabilitiesAreSubset(
  candidate: readonly PartnerCapability[],
  authority: readonly PartnerCapability[],
): boolean {
  const allowed = new Set(authority);
  return candidate.every((capability) => allowed.has(capability));
}

export function mayAssignInvitationRole(input: {
  actorCapabilities: readonly PartnerCapability[];
  roleCapabilities: readonly string[];
}): boolean {
  return capabilitiesAreSubset(
    computePartnerCapabilities({ roleCapabilities: input.roleCapabilities }),
    input.actorCapabilities,
  );
}

function invitationRevision(row: InvitationRow): string {
  return JSON.stringify({
    id: row.id,
    accountId: row.partnerAccountId,
    status: row.status,
    roleTemplateId: row.roleTemplateId,
    roleTemplateVersion: row.roleTemplateVersion,
    roleKey: row.roleKey,
    persona: row.persona,
    generation: row.generation,
    version: row.version,
    expiresAt: row.expiresAt.toISOString(),
    deliveryStatus: row.deliveryStatus,
    deliveryOutboxEventId: row.deliveryOutboxEventId,
    sentAt: row.sentAt?.toISOString() ?? null,
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    expiredAt: row.expiredAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  });
}

export function partnerInvitationDto(row: InvitationRow): Record<string, unknown> {
  return {
    id: row.id,
    email: row.normalizedEmail,
    name: row.inviteeName,
    role: { key: row.roleKey },
    persona: row.persona,
    status: row.status,
    delivery: {
      status: row.deliveryStatus,
      sentAt: row.sentAt?.toISOString() ?? null,
    },
    expiresAt: row.expiresAt.toISOString(),
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    allowedActions:
      row.status !== "pending"
        ? []
        : ["dispatching", "reconciliation_required"].includes(row.deliveryStatus)
          ? ["revoke"]
          : ["resend", "revoke"],
    etag: createPortalV2StrongEtag(invitationRevision(row)),
  };
}

async function loadActorAuthority(
  tx: TeamMutationTransaction,
  principal: PartnerPrincipal,
) {
  const accountId = principal.accountId;
  const membershipId = principal.membershipId;
  if (!accountId || !membershipId) return null;
  const [actor] = await tx
    .select({
      id: partnerAccountMemberships.id,
      partnerUserId: partnerAccountMemberships.partnerUserId,
      status: partnerAccountMemberships.status,
      accessLevel: partnerAccountMemberships.accessLevel,
      grants: partnerAccountMemberships.capabilityGrants,
      denies: partnerAccountMemberships.capabilityDenies,
      roleCapabilities: partnerRoleTemplates.capabilities,
      roleActive: partnerRoleTemplates.active,
    })
    .from(partnerAccountMemberships)
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
    .where(
      and(
        eq(partnerAccountMemberships.id, membershipId),
        eq(partnerAccountMemberships.partnerAccountId, accountId),
        eq(partnerAccountMemberships.partnerUserId, principal.partnerUserId),
      ),
    )
    .limit(1);
  if (!actor || actor.status !== "active" || actor.accessLevel !== "account") {
    return null;
  }
  const actorCapabilities = computePartnerCapabilities({
    roleCapabilities: actor.roleActive ? (actor.roleCapabilities ?? []) : [],
    grants: actor.grants,
    denies: actor.denies,
  });
  if (!actorCapabilities.includes("account.members.manage")) return null;
  return { actor, actorCapabilities };
}

async function loadActorAndRole(
  tx: TeamMutationTransaction,
  input: { principal: PartnerPrincipal; roleKey: string },
) {
  const accountId = input.principal.accountId;
  if (!accountId) return null;
  const authority = await loadActorAuthority(tx, input.principal);
  if (!authority) return null;

  const [role] = await tx
    .select({
      id: partnerRoleTemplates.id,
      key: partnerRoleTemplates.key,
      version: partnerRoleTemplates.version,
      capabilities: partnerRoleTemplates.capabilities,
      partnerAccountId: partnerRoleTemplates.partnerAccountId,
    })
    .from(partnerRoleTemplates)
    .where(
      and(
        eq(partnerRoleTemplates.key, input.roleKey),
        eq(partnerRoleTemplates.active, true),
        or(
          isNull(partnerRoleTemplates.partnerAccountId),
          eq(partnerRoleTemplates.partnerAccountId, accountId),
        ),
      ),
    )
    .orderBy(partnerRoleTemplates.partnerAccountId)
    .limit(1);
  if (!role || !mayAssignInvitationRole({ actorCapabilities: authority.actorCapabilities, roleCapabilities: role.capabilities })) {
    return null;
  }
  return { ...authority, role };
}

function invitationUrl(rawToken: string): string | null {
  const base = resolvePublicSiteBaseUrl();
  if (!base) return null;
  const url = new URL("/partners/invitations/accept", base);
  url.searchParams.set("token", rawToken);
  return url.toString();
}

async function writeInvitationAudit(
  tx: TeamMutationTransaction,
  input: {
    principal: PartnerPrincipal;
    invitationId: string | null;
    action: string;
    outcome?: "attempted" | "succeeded" | "denied" | "failed";
    correlationId: string;
    idempotencyKeyHash?: string | null;
    emailHash?: string;
    meta?: Record<string, unknown>;
  },
): Promise<void> {
  await tx.insert(auditLogs).values({
    actorType: "human",
    actorId: input.principal.partnerUserId,
    actorLabel: input.principal.email,
    actorRole: input.principal.roleKey,
    sessionId: input.principal.session.id,
    authMethod: "partner_session",
    correlationId: input.correlationId,
    requiredPermissions: ["account.members.manage"],
    outcome: input.outcome ?? "succeeded",
    surface: "partner_portal_v2",
    idempotencyKeyHash: input.idempotencyKeyHash ?? null,
    action: input.action,
    entityType: "partner_account_invitation",
    entityId: input.invitationId,
    meta: {
      partnerAccountId: input.principal.accountId,
      ...(input.emailHash ? { invitedEmailHash: input.emailHash } : {}),
      ...(input.meta ?? {}),
    },
  });
}

export async function listPartnerAccountInvitations(input: {
  principal: PartnerPrincipal;
  limit: number;
}): Promise<Record<string, unknown>[]> {
  if (!input.principal.accountId) return [];
  const db = getDb();
  const now = new Date();
  await db
    .update(partnerAccountInvitations)
    .set({
      status: "expired",
      tokenHash: null,
      expiredAt: now,
      version: sql`${partnerAccountInvitations.version} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(partnerAccountInvitations.partnerAccountId, input.principal.accountId),
        eq(partnerAccountInvitations.status, "pending"),
        sql`${partnerAccountInvitations.expiresAt} <= ${now}`,
      ),
    );
  const rows = await db
    .select()
    .from(partnerAccountInvitations)
    .where(eq(partnerAccountInvitations.partnerAccountId, input.principal.accountId))
    .orderBy(desc(partnerAccountInvitations.createdAt), desc(partnerAccountInvitations.id))
    .limit(input.limit);
  return rows.map(partnerInvitationDto);
}

export async function createPartnerAccountInvitation(input: {
  principal: PartnerPrincipal;
  payload: z.infer<typeof PartnerInvitationCreateSchema>;
  correlationId: string;
  idempotencyKeyHash: string;
}): Promise<PortalV2StoredResult> {
  const accountId = input.principal.accountId;
  if (!accountId || !input.principal.membershipId) {
    return { status: 409, body: { ok: false, error: "legacy_scope_unavailable" } };
  }
  const normalizedEmail = normalizeInvitationEmail(input.payload.email);
  const name = input.payload.name.trim();
  const fingerprint = emailFingerprint(normalizedEmail);
  return getDb().transaction(async (tx): Promise<PortalV2StoredResult> => {
    const [account] = await tx
      .select({ id: partnerAccounts.id, portalAccessEnabled: partnerAccounts.portalAccessEnabled })
      .from(partnerAccounts)
      .where(eq(partnerAccounts.id, accountId))
      .for("update")
      .limit(1);
    if (!account) return { status: 404, body: { ok: false, error: "not_found" } };
    if (!account.portalAccessEnabled) return { status: 403, body: { ok: false, error: "forbidden" } };
    const authority = await loadActorAndRole(tx, {
      principal: input.principal,
      roleKey: input.payload.roleKey,
    });
    if (!authority) return { status: 403, body: { ok: false, error: "forbidden" } };

    const expirationNow = new Date();
    await tx.update(partnerAccountInvitations).set({
      status: "expired",
      tokenHash: null,
      expiredAt: expirationNow,
      version: sql`${partnerAccountInvitations.version} + 1`,
      updatedAt: expirationNow,
    }).where(and(
      eq(partnerAccountInvitations.partnerAccountId, accountId),
      eq(partnerAccountInvitations.normalizedEmail, normalizedEmail),
      eq(partnerAccountInvitations.status, "pending"),
      sql`${partnerAccountInvitations.expiresAt} <= ${expirationNow}`,
    ));

    const [existingIdentity] = await tx
      .select({ id: partnerUsers.id })
      .from(partnerUsers)
      .innerJoin(
        partnerAccountMemberships,
        and(
          eq(partnerAccountMemberships.partnerUserId, partnerUsers.id),
          eq(partnerAccountMemberships.partnerAccountId, accountId),
        ),
      )
      .where(sql`lower(btrim(${partnerUsers.email})) = ${normalizedEmail}`)
      .limit(1);
    const [restrictedContact] = await tx
      .select({
        id: contacts.id,
        deletedAt: contacts.deletedAt,
        doNotContact: contacts.doNotContact,
        linkedPartnerUserId: partnerUsers.id,
        linkedPartnerEmail: partnerUsers.email,
      })
      .from(contacts)
      .leftJoin(partnerUsers, eq(partnerUsers.orgContactId, contacts.id))
      .where(sql`lower(btrim(${contacts.email})) = ${normalizedEmail}`)
      .limit(1);
    const [pending] = await tx
      .select({ id: partnerAccountInvitations.id })
      .from(partnerAccountInvitations)
      .where(
        and(
          eq(partnerAccountInvitations.partnerAccountId, accountId),
          eq(partnerAccountInvitations.normalizedEmail, normalizedEmail),
          eq(partnerAccountInvitations.status, "pending"),
        ),
      )
      .limit(1);
    if (
      normalizedEmail === normalizeInvitationEmail(input.principal.email) ||
      existingIdentity ||
      restrictedContact?.deletedAt ||
      restrictedContact?.doNotContact ||
      (restrictedContact?.linkedPartnerUserId &&
        normalizeInvitationEmail(restrictedContact.linkedPartnerEmail ?? "") !==
          normalizedEmail) ||
      pending
    ) {
      await writeInvitationAudit(tx, {
        principal: input.principal,
        invitationId: pending?.id ?? null,
        action: "partner.account_invitation.request_suppressed",
        correlationId: input.correlationId,
        idempotencyKeyHash: input.idempotencyKeyHash,
        emailHash: fingerprint,
      });
      return { status: 202, body: { ok: true, status: "queued" } };
    }

    const credential = makeCredential();
    const url = invitationUrl(credential.rawToken);
    if (!url) return { status: 503, body: { ok: false, error: "service_unavailable" } };
    const now = new Date();
    const invitationId = randomUUID();
    const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS);
    const [invitation] = await tx
      .insert(partnerAccountInvitations)
      .values({
        id: invitationId,
        partnerAccountId: accountId,
        email: normalizedEmail,
        normalizedEmail,
        inviteeName: name,
        roleTemplateId: authority.role.id,
        roleTemplateVersion: authority.role.version,
        roleKey: authority.role.key,
        persona: input.payload.persona,
        tokenHash: credential.tokenHash,
        expiresAt,
        invitedByMembershipId: authority.actor.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!invitation) throw new Error("invitation_insert_failed");
    const [outbox] = await tx
      .insert(outboxEvents)
      .values({
        type: "partner.account_invitation.email",
        payload: {
          invitationId,
          generation: 1,
          deliveryUrl: url,
          correlationId: input.correlationId,
        },
        createdAt: now,
      })
      .returning({ id: outboxEvents.id });
    if (!outbox) throw new Error("invitation_outbox_insert_failed");
    const [stored] = await tx
      .update(partnerAccountInvitations)
      .set({ deliveryOutboxEventId: outbox.id, updatedAt: now })
      .where(
        and(
          eq(partnerAccountInvitations.id, invitationId),
          eq(partnerAccountInvitations.partnerAccountId, accountId),
        ),
      )
      .returning();
    if (!stored) throw new Error("invitation_outbox_link_failed");
    await writeInvitationAudit(tx, {
      principal: input.principal,
      invitationId,
      action: "partner.account_invitation.created",
      correlationId: input.correlationId,
      idempotencyKeyHash: input.idempotencyKeyHash,
      emailHash: fingerprint,
      meta: { roleKey: authority.role.key, persona: input.payload.persona, generation: 1 },
    });
    return {
      status: 202,
      body: { ok: true, status: "queued", invitation: partnerInvitationDto(stored) },
      headers: { ETag: createPortalV2StrongEtag(invitationRevision(stored)) },
    };
  });
}

export async function hasPartnerAccountInvitation(accountId: string, invitationId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: partnerAccountInvitations.id })
    .from(partnerAccountInvitations)
    .where(
      and(
        eq(partnerAccountInvitations.id, invitationId),
        eq(partnerAccountInvitations.partnerAccountId, accountId),
      ),
    )
    .limit(1);
  return Boolean(row);
}

export async function mutatePartnerAccountInvitation(input: {
  principal: PartnerPrincipal;
  invitationId: string;
  action: "resend" | "revoke";
  ifMatch: string | null;
  correlationId: string;
  idempotencyKeyHash: string;
}): Promise<PortalV2StoredResult> {
  const accountId = input.principal.accountId;
  if (!accountId || !input.principal.membershipId) {
    return { status: 409, body: { ok: false, error: "legacy_scope_unavailable" } };
  }
  return getDb().transaction(async (tx): Promise<PortalV2StoredResult> => {
    const [account] = await tx.select({ id: partnerAccounts.id })
      .from(partnerAccounts).where(eq(partnerAccounts.id, accountId)).for("update").limit(1);
    if (!account) return { status: 404, body: { ok: false, error: "not_found" } };
    const [row] = await tx
      .select()
      .from(partnerAccountInvitations)
      .where(and(eq(partnerAccountInvitations.id, input.invitationId), eq(partnerAccountInvitations.partnerAccountId, accountId)))
      .for("update")
      .limit(1);
    if (!row) return { status: 404, body: { ok: false, error: "not_found" } };
    const authority = await loadActorAuthority(tx, input.principal);
    if (!authority) return { status: 403, body: { ok: false, error: "forbidden" } };
    const precondition = evaluatePortalV2RevisionPrecondition({
      ifMatch: input.ifMatch,
      currentRevision: invitationRevision(row),
      correlationId: input.correlationId,
    });
    if (!precondition.ok) {
      return { status: precondition.response.status, body: { ...precondition.response.body }, headers: { ETag: precondition.currentEtag } };
    }
    if (row.status !== "pending") {
      return { status: 409, body: { ok: false, error: "conflict", reason: "invitation_not_pending" } };
    }
    const now = new Date();
    if (input.action === "revoke") {
      const [updated] = await tx
        .update(partnerAccountInvitations)
        .set({
          status: "revoked",
          tokenHash: null,
          revokedAt: now,
          revokedByMembershipId: authority.actor.id,
          version: sql`${partnerAccountInvitations.version} + 1`,
          updatedAt: now,
        })
        .where(and(eq(partnerAccountInvitations.id, row.id), eq(partnerAccountInvitations.partnerAccountId, accountId)))
        .returning();
      if (!updated) throw new Error("invitation_revoke_failed");
      await writeInvitationAudit(tx, {
        principal: input.principal,
        invitationId: row.id,
        action: "partner.account_invitation.revoked",
        correlationId: input.correlationId,
        idempotencyKeyHash: input.idempotencyKeyHash,
        emailHash: emailFingerprint(row.normalizedEmail),
      });
      return {
        status: 200,
        body: { ok: true, invitation: partnerInvitationDto(updated) },
        headers: { ETag: createPortalV2StrongEtag(invitationRevision(updated)) },
      };
    }

    if (["dispatching", "reconciliation_required"].includes(row.deliveryStatus)) {
      return {
        status: 409,
        body: {
          ok: false,
          error: "conflict",
          reason: "delivery_reconciliation_required",
        },
      };
    }

    const [role] = await tx.select({
      id: partnerRoleTemplates.id,
      key: partnerRoleTemplates.key,
      version: partnerRoleTemplates.version,
      capabilities: partnerRoleTemplates.capabilities,
    }).from(partnerRoleTemplates).where(and(
      eq(partnerRoleTemplates.id, row.roleTemplateId),
      eq(partnerRoleTemplates.key, row.roleKey),
      eq(partnerRoleTemplates.version, row.roleTemplateVersion),
      eq(partnerRoleTemplates.active, true),
      or(isNull(partnerRoleTemplates.partnerAccountId), eq(partnerRoleTemplates.partnerAccountId, accountId)),
    )).limit(1);
    if (!role || !mayAssignInvitationRole({ actorCapabilities: authority.actorCapabilities, roleCapabilities: role.capabilities })) {
      return { status: 409, body: { ok: false, error: "conflict", reason: "invitation_role_changed" } };
    }

    const credential = makeCredential();
    const url = invitationUrl(credential.rawToken);
    if (!url) return { status: 503, body: { ok: false, error: "service_unavailable" } };
    const generation = row.generation + 1;
    const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS);
    const [outbox] = await tx.insert(outboxEvents).values({
      type: "partner.account_invitation.email",
      payload: { invitationId: row.id, generation, deliveryUrl: url, correlationId: input.correlationId },
      createdAt: now,
    }).returning({ id: outboxEvents.id });
    if (!outbox) throw new Error("invitation_outbox_insert_failed");
    const [updated] = await tx
      .update(partnerAccountInvitations)
      .set({
        tokenHash: credential.tokenHash,
        generation,
        version: sql`${partnerAccountInvitations.version} + 1`,
        expiresAt,
        deliveryStatus: "queued",
        deliveryOutboxEventId: outbox.id,
        deliveryAttemptId: null,
        deliveryProvider: null,
        deliveryProviderMessageId: null,
        deliveryDetail: null,
        dispatchStartedAt: null,
        sentAt: null,
        updatedAt: now,
      })
      .where(and(eq(partnerAccountInvitations.id, row.id), eq(partnerAccountInvitations.partnerAccountId, accountId)))
      .returning();
    if (!updated) throw new Error("invitation_resend_failed");
    await writeInvitationAudit(tx, {
      principal: input.principal,
      invitationId: row.id,
      action: "partner.account_invitation.resent",
      correlationId: input.correlationId,
      idempotencyKeyHash: input.idempotencyKeyHash,
      emailHash: emailFingerprint(row.normalizedEmail),
      meta: { generation },
    });
    return {
      status: 202,
      body: { ok: true, status: "queued", invitation: partnerInvitationDto(updated) },
      headers: { ETag: createPortalV2StrongEtag(invitationRevision(updated)) },
    };
  });
}

function splitContactName(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/u);
  const firstName = parts.shift() || "Partner";
  return { firstName, lastName: parts.join(" ") || "User" };
}

export async function acceptPartnerAccountInvitation(input: {
  token: string;
  request: NextRequest;
  correlationId: string;
  sessionDays: number;
}): Promise<
  | {
      sessionToken: string;
      accountId: string;
      expiresAt: Date;
      needsPasswordSetup: boolean;
    }
  | null
> {
  const tokenHash = hashPartnerInvitationToken(input.token);
  return getDb().transaction(async (tx) => {
    const now = new Date();
    const [candidate] = await tx
      .select({
        id: partnerAccountInvitations.id,
        accountId: partnerAccountInvitations.partnerAccountId,
      })
      .from(partnerAccountInvitations)
      .where(and(eq(partnerAccountInvitations.tokenHash, tokenHash), eq(partnerAccountInvitations.status, "pending")))
      .limit(1);
    if (!candidate) return null;
    const [account] = await tx.select({ id: partnerAccounts.id, name: partnerAccounts.name, portalAccessEnabled: partnerAccounts.portalAccessEnabled })
      .from(partnerAccounts).where(eq(partnerAccounts.id, candidate.accountId)).for("update").limit(1);
    if (!account?.portalAccessEnabled) return null;
    const [invitation] = await tx
      .select()
      .from(partnerAccountInvitations)
      .where(and(
        eq(partnerAccountInvitations.id, candidate.id),
        eq(partnerAccountInvitations.partnerAccountId, account.id),
        eq(partnerAccountInvitations.tokenHash, tokenHash),
        eq(partnerAccountInvitations.status, "pending"),
      ))
      .for("update")
      .limit(1);
    if (!invitation) return null;
    if (invitation.expiresAt <= now) {
      await tx.update(partnerAccountInvitations).set({
        status: "expired", tokenHash: null, expiredAt: now,
        version: sql`${partnerAccountInvitations.version} + 1`, updatedAt: now,
      }).where(eq(partnerAccountInvitations.id, invitation.id));
      return null;
    }
    const [role] = await tx.select({ id: partnerRoleTemplates.id })
      .from(partnerRoleTemplates)
      .where(and(
        eq(partnerRoleTemplates.id, invitation.roleTemplateId),
        eq(partnerRoleTemplates.key, invitation.roleKey),
        eq(partnerRoleTemplates.version, invitation.roleTemplateVersion),
        eq(partnerRoleTemplates.active, true),
        or(isNull(partnerRoleTemplates.partnerAccountId), eq(partnerRoleTemplates.partnerAccountId, account.id)),
      )).limit(1);
    if (!role) return null;

    const identities = await tx.select({
      id: partnerUsers.id,
      active: partnerUsers.active,
      contactDeletedAt: contacts.deletedAt,
      partnerStatus: contacts.partnerStatus,
    })
      .from(partnerUsers)
      .innerJoin(contacts, eq(partnerUsers.orgContactId, contacts.id))
      .where(sql`lower(btrim(${partnerUsers.email})) = ${invitation.normalizedEmail}`).limit(2);
    if (
      identities.length > 1 ||
      identities[0]?.active === false ||
      identities[0]?.contactDeletedAt ||
      (identities[0] && identities[0].partnerStatus !== "partner")
    ) return null;
    let partnerUserId = identities[0]?.id ?? null;
    if (!partnerUserId) {
      const matchingContacts = await tx.select({ id: contacts.id, deletedAt: contacts.deletedAt })
        .from(contacts).where(sql`lower(btrim(${contacts.email})) = ${invitation.normalizedEmail}`).limit(2);
      if (matchingContacts.length > 1 || matchingContacts[0]?.deletedAt) return null;
      let contactId = matchingContacts[0]?.id ?? null;
      if (!contactId) {
        const names = splitContactName(invitation.inviteeName);
        const [contact] = await tx.insert(contacts).values({
          ...names,
          company: account.name,
          email: invitation.normalizedEmail,
          partnerAccountId: account.id,
          partnerStatus: "partner",
          partnerType: invitation.persona,
          partnerSince: now,
          source: "partner_account_invitation",
          createdAt: now,
          updatedAt: now,
        }).returning({ id: contacts.id });
        contactId = contact?.id ?? null;
      } else {
        const [linkedIdentity] = await tx.select({ id: partnerUsers.id })
          .from(partnerUsers)
          .where(eq(partnerUsers.orgContactId, contactId))
          .limit(1);
        if (linkedIdentity) return null;
        await tx.update(contacts).set({ partnerStatus: "partner", updatedAt: now }).where(eq(contacts.id, contactId));
      }
      if (!contactId) throw new Error("invitation_contact_insert_failed");
      const [user] = await tx.insert(partnerUsers).values({
        orgContactId: contactId,
        email: invitation.normalizedEmail,
        name: invitation.inviteeName,
        active: true,
        createdAt: now,
        updatedAt: now,
      }).returning({ id: partnerUsers.id });
      partnerUserId = user?.id ?? null;
    }
    if (!partnerUserId) throw new Error("invitation_identity_insert_failed");
    const [existingMembership] = await tx.select({
      id: partnerAccountMemberships.id,
      status: partnerAccountMemberships.status,
    }).from(partnerAccountMemberships).where(and(
      eq(partnerAccountMemberships.partnerAccountId, account.id),
      eq(partnerAccountMemberships.partnerUserId, partnerUserId),
    )).for("update").limit(1);
    if (existingMembership && existingMembership.status !== "active") return null;

    let membershipId = existingMembership?.id ?? null;
    if (!membershipId) {
      const [inviter] = await tx.select({
        partnerUserId: partnerAccountMemberships.partnerUserId,
      }).from(partnerAccountMemberships).where(and(
        eq(partnerAccountMemberships.id, invitation.invitedByMembershipId),
        eq(partnerAccountMemberships.partnerAccountId, account.id),
      )).limit(1);
      const [anyDefault] = await tx.select({ id: partnerAccountMemberships.id })
        .from(partnerAccountMemberships).where(and(
          eq(partnerAccountMemberships.partnerUserId, partnerUserId),
          eq(partnerAccountMemberships.status, "active"),
          eq(partnerAccountMemberships.isDefault, true),
        )).limit(1);
      const [membership] = await tx.insert(partnerAccountMemberships).values({
        partnerAccountId: account.id,
        partnerUserId,
        roleTemplateId: invitation.roleTemplateId,
        roleKey: invitation.roleKey,
        status: "active",
        persona: invitation.persona,
        accessLevel: "account",
        isDefault: !anyDefault,
        invitedByPartnerUserId: inviter?.partnerUserId ?? null,
        invitedAt: invitation.createdAt,
        acceptedAt: now,
        createdAt: now,
        updatedAt: now,
      }).returning({ id: partnerAccountMemberships.id });
      membershipId = membership?.id ?? null;
    }
    if (!membershipId) throw new Error("invitation_membership_insert_failed");

    const [accepted] = await tx.update(partnerAccountInvitations).set({
      status: "accepted",
      tokenHash: null,
      acceptedByPartnerUserId: partnerUserId,
      acceptedMembershipId: membershipId,
      acceptedAt: now,
      version: sql`${partnerAccountInvitations.version} + 1`,
      updatedAt: now,
    }).where(and(
      eq(partnerAccountInvitations.id, invitation.id),
      eq(partnerAccountInvitations.tokenHash, tokenHash),
      eq(partnerAccountInvitations.status, "pending"),
    )).returning({ id: partnerAccountInvitations.id });
    if (!accepted) return null;
    const [userSecurity] = await tx.select({
      orgContactId: partnerUsers.orgContactId,
      passwordHash: partnerUsers.passwordHash,
      securityVersion: partnerUsers.securityVersion,
    }).from(partnerUsers).where(eq(partnerUsers.id, partnerUserId)).limit(1);
    if (!userSecurity) throw new Error("invitation_identity_unavailable");
    const sessionToken = randomToken(32);
    const sessionExpiresAt = new Date(
      now.getTime() + input.sessionDays * 24 * 60 * 60 * 1_000,
    );
    await tx.insert(partnerSessions).values({
      partnerUserId,
      activePartnerAccountId: account.id,
      activeMembershipId: membershipId,
      sessionHash: sha256Base64Url(sessionToken),
      authMethod: "magic_link",
      assuranceLevel: "aal1",
      securityVersion: userSecurity.securityVersion,
      accountSelectedAt: now,
      ip: getClientIp(input.request),
      userAgent: getUserAgent(input.request),
      expiresAt: sessionExpiresAt,
      createdAt: now,
      lastSeenAt: now,
    });
    await tx.insert(auditLogs).values({
      actorType: "human",
      actorId: partnerUserId,
      actorLabel: invitation.normalizedEmail,
      authMethod: "service",
      correlationId: input.correlationId,
      outcome: "succeeded",
      surface: "partner_portal_v2",
      action: "partner.account_invitation.accepted",
      entityType: "partner_account_invitation",
      entityId: invitation.id,
      meta: { partnerAccountId: account.id, membershipId, generation: invitation.generation },
    });
    return {
      sessionToken,
      accountId: account.id,
      expiresAt: sessionExpiresAt,
      needsPasswordSetup: !userSecurity.passwordHash,
    };
  });
}
