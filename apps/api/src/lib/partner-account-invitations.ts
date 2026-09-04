import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  auditLogs,
  getDb,
  outboxEvents,
  partnerAccountCostCenters,
  partnerAccountInvitations,
  partnerAccountLocations,
  partnerAccountMemberships,
  partnerAccounts,
  partnerInvitationCostCenterScopes,
  partnerInvitationLocationScopes,
  partnerMembershipCostCenterScopes,
  partnerMembershipLocationScopes,
  partnerRoleTemplates,
  partnerUsers,
} from "@/db";
import {
  computePartnerCapabilities,
  isPartnerLaunchRoleKey,
  PARTNER_LAUNCH_ROLE_KEYS,
  type PartnerCapability,
  type PartnerPrincipal,
} from "@/lib/partner-account-authorization";
import { resolvePublicSiteBaseUrl } from "@/lib/partner-portal-auth";
import { createPartnerActivationChallengeInTransaction } from "@/lib/partner-purpose-auth";
import type { PortalV2StoredResult } from "@/lib/partner-portal-v2-idempotency";
import type { TeamMutationTransaction } from "@/lib/team-mutation";
import {
  createPortalV2StrongEtag,
  evaluatePortalV2RevisionPrecondition,
} from "@/lib/portal-v2-contract";

const INVITATION_TTL_MS = 30 * 60 * 1_000;
const PERSONAS = [
  "contractor",
  "real_estate_agent",
  "property_manager",
  "commercial_client",
  "other",
] as const;

const InvitationScopeIdsSchema = z
  .array(z.string().uuid())
  .max(100)
  .default([])
  .refine((values) => new Set(values).size === values.length, {
    message: "Scope identifiers must be unique.",
  });

export const PartnerInvitationCreateSchema = z
  .object({
    email: z.string().trim().email().max(254),
    name: z.string().trim().min(2).max(120),
    roleKey: z.enum(PARTNER_LAUNCH_ROLE_KEYS),
    persona: z.enum(PERSONAS),
    accessLevel: z.enum(["account", "scoped"]).default("account"),
    locationIds: InvitationScopeIdsSchema,
    costCenterIds: InvitationScopeIdsSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.roleKey === "administrator" && value.accessLevel !== "account") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["accessLevel"],
        message: "Administrators must have account-wide access.",
      });
    }
    const scopeCount = value.locationIds.length + value.costCenterIds.length;
    if (value.accessLevel === "scoped" && scopeCount === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["accessLevel"],
        message: "Scoped access requires at least one location or cost center.",
      });
    }
    if (value.accessLevel === "account" && scopeCount > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["accessLevel"],
        message: "Account-wide access cannot include scoped resources.",
      });
    }
  });

export const PartnerInvitationActionSchema = z
  .object({ action: z.enum(["resend", "revoke"]) })
  .strict();

export const PartnerInvitationAcceptanceSchema = z
  .object({ token: z.string().trim().min(32).max(256) })
  .strict();

type InvitationRow = typeof partnerAccountInvitations.$inferSelect;
type InvitationScopeSnapshot = {
  locationIds: string[];
  costCenterIds: string[];
};

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
    accessLevel: row.accessLevel,
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

export function partnerInvitationDto(
  row: InvitationRow,
  scopes: InvitationScopeSnapshot = { locationIds: [], costCenterIds: [] },
): Record<string, unknown> {
  return {
    id: row.id,
    email: row.normalizedEmail,
    name: row.inviteeName,
    role: { key: row.roleKey },
    access: {
      level: row.accessLevel,
      locationIds: scopes.locationIds,
      costCenterIds: scopes.costCenterIds,
    },
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
        : ["dispatching", "reconciliation_required"].includes(
              row.deliveryStatus,
            )
          ? ["revoke"]
          : ["resend", "revoke"],
    etag: createPortalV2StrongEtag(invitationRevision(row)),
  };
}

async function loadInvitationScopes(
  tx: TeamMutationTransaction,
  accountId: string,
  invitationIds: readonly string[],
): Promise<Map<string, InvitationScopeSnapshot>> {
  const snapshots = new Map<string, InvitationScopeSnapshot>();
  for (const invitationId of invitationIds) {
    snapshots.set(invitationId, { locationIds: [], costCenterIds: [] });
  }
  if (invitationIds.length === 0) return snapshots;
  const [locationRows, costCenterRows] = await Promise.all([
    tx
      .select({
        invitationId: partnerInvitationLocationScopes.invitationId,
        locationId: partnerInvitationLocationScopes.locationId,
      })
      .from(partnerInvitationLocationScopes)
      .where(
        and(
          eq(partnerInvitationLocationScopes.partnerAccountId, accountId),
          inArray(partnerInvitationLocationScopes.invitationId, [
            ...invitationIds,
          ]),
        ),
      ),
    tx
      .select({
        invitationId: partnerInvitationCostCenterScopes.invitationId,
        costCenterId: partnerInvitationCostCenterScopes.costCenterId,
      })
      .from(partnerInvitationCostCenterScopes)
      .where(
        and(
          eq(partnerInvitationCostCenterScopes.partnerAccountId, accountId),
          inArray(partnerInvitationCostCenterScopes.invitationId, [
            ...invitationIds,
          ]),
        ),
      ),
  ]);
  for (const row of locationRows) {
    snapshots.get(row.invitationId)?.locationIds.push(row.locationId);
  }
  for (const row of costCenterRows) {
    snapshots.get(row.invitationId)?.costCenterIds.push(row.costCenterId);
  }
  for (const snapshot of snapshots.values()) {
    snapshot.locationIds.sort();
    snapshot.costCenterIds.sort();
  }
  return snapshots;
}

async function validateInvitationScopes(
  tx: TeamMutationTransaction,
  input: {
    accountId: string;
    roleKey: string;
    accessLevel: "account" | "scoped";
    locationIds: readonly string[];
    costCenterIds: readonly string[];
  },
): Promise<boolean> {
  const scopeCount = input.locationIds.length + input.costCenterIds.length;
  if (input.roleKey === "administrator" && input.accessLevel !== "account") {
    return false;
  }
  if (input.accessLevel === "account") return scopeCount === 0;
  if (scopeCount === 0) return false;
  const [locations, costCenters] = await Promise.all([
    input.locationIds.length === 0
      ? Promise.resolve([])
      : tx
          .select({ id: partnerAccountLocations.id })
          .from(partnerAccountLocations)
          .where(
            and(
              eq(partnerAccountLocations.partnerAccountId, input.accountId),
              eq(partnerAccountLocations.active, true),
              inArray(partnerAccountLocations.id, [...input.locationIds]),
            ),
          ),
    input.costCenterIds.length === 0
      ? Promise.resolve([])
      : tx
          .select({ id: partnerAccountCostCenters.id })
          .from(partnerAccountCostCenters)
          .where(
            and(
              eq(partnerAccountCostCenters.partnerAccountId, input.accountId),
              eq(partnerAccountCostCenters.active, true),
              inArray(partnerAccountCostCenters.id, [...input.costCenterIds]),
            ),
          ),
  ]);
  return (
    locations.length === input.locationIds.length &&
    costCenters.length === input.costCenterIds.length
  );
}

async function insertInvitationScopes(
  tx: TeamMutationTransaction,
  input: {
    invitationId: string;
    accountId: string;
    scopes: InvitationScopeSnapshot;
    now: Date;
  },
): Promise<void> {
  if (input.scopes.locationIds.length > 0) {
    await tx.insert(partnerInvitationLocationScopes).values(
      input.scopes.locationIds.map((locationId) => ({
        invitationId: input.invitationId,
        partnerAccountId: input.accountId,
        locationId,
        createdAt: input.now,
      })),
    );
  }
  if (input.scopes.costCenterIds.length > 0) {
    await tx.insert(partnerInvitationCostCenterScopes).values(
      input.scopes.costCenterIds.map((costCenterId) => ({
        invitationId: input.invitationId,
        partnerAccountId: input.accountId,
        costCenterId,
        createdAt: input.now,
      })),
    );
  }
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
  if (!accountId || !isPartnerLaunchRoleKey(input.roleKey)) return null;
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
        isNull(partnerRoleTemplates.partnerAccountId),
      ),
    )
    .orderBy(partnerRoleTemplates.partnerAccountId)
    .limit(1);
  if (
    !role ||
    !mayAssignInvitationRole({
      actorCapabilities: authority.actorCapabilities,
      roleCapabilities: role.capabilities,
    })
  ) {
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
  const accountId = input.principal.accountId;
  return getDb().transaction(async (tx) => {
    const now = new Date();
    await tx
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
          eq(partnerAccountInvitations.partnerAccountId, accountId),
          eq(partnerAccountInvitations.status, "pending"),
          sql`${partnerAccountInvitations.expiresAt} <= ${now}`,
        ),
      );
    const rows = await tx
      .select()
      .from(partnerAccountInvitations)
      .where(eq(partnerAccountInvitations.partnerAccountId, accountId))
      .orderBy(
        desc(partnerAccountInvitations.createdAt),
        desc(partnerAccountInvitations.id),
      )
      .limit(input.limit);
    const scopes = await loadInvitationScopes(
      tx,
      accountId,
      rows.map((row) => row.id),
    );
    return rows.map((row) => partnerInvitationDto(row, scopes.get(row.id)));
  });
}

export async function createPartnerAccountInvitation(input: {
  principal: PartnerPrincipal;
  payload: z.infer<typeof PartnerInvitationCreateSchema>;
  correlationId: string;
  idempotencyKeyHash: string;
}): Promise<PortalV2StoredResult> {
  const accountId = input.principal.accountId;
  if (!accountId || !input.principal.membershipId) {
    return {
      status: 409,
      body: { ok: false, error: "legacy_scope_unavailable" },
    };
  }
  const normalizedEmail = normalizeInvitationEmail(input.payload.email);
  const name = input.payload.name.trim();
  const fingerprint = emailFingerprint(normalizedEmail);
  return getDb().transaction(async (tx): Promise<PortalV2StoredResult> => {
    const [account] = await tx
      .select({
        id: partnerAccounts.id,
        portalAccessEnabled: partnerAccounts.portalAccessEnabled,
      })
      .from(partnerAccounts)
      .where(eq(partnerAccounts.id, accountId))
      .for("update")
      .limit(1);
    if (!account)
      return { status: 404, body: { ok: false, error: "not_found" } };
    if (!account.portalAccessEnabled)
      return { status: 403, body: { ok: false, error: "forbidden" } };
    const authority = await loadActorAndRole(tx, {
      principal: input.principal,
      roleKey: input.payload.roleKey,
    });
    if (!authority)
      return { status: 403, body: { ok: false, error: "forbidden" } };
    const scopes: InvitationScopeSnapshot = {
      locationIds: [...input.payload.locationIds].sort(),
      costCenterIds: [...input.payload.costCenterIds].sort(),
    };
    if (
      !(await validateInvitationScopes(tx, {
        accountId,
        roleKey: authority.role.key,
        accessLevel: input.payload.accessLevel,
        ...scopes,
      }))
    ) {
      return {
        status: 422,
        body: { ok: false, error: "invalid_fields", reason: "invalid_scope" },
      };
    }

    const expirationNow = new Date();
    await tx
      .update(partnerAccountInvitations)
      .set({
        status: "expired",
        tokenHash: null,
        expiredAt: expirationNow,
        version: sql`${partnerAccountInvitations.version} + 1`,
        updatedAt: expirationNow,
      })
      .where(
        and(
          eq(partnerAccountInvitations.partnerAccountId, accountId),
          eq(partnerAccountInvitations.normalizedEmail, normalizedEmail),
          eq(partnerAccountInvitations.status, "pending"),
          sql`${partnerAccountInvitations.expiresAt} <= ${expirationNow}`,
        ),
      );

    const identities = await tx
      .select({
        id: partnerUsers.id,
        active: partnerUsers.active,
        identityStatus: partnerUsers.identityStatus,
      })
      .from(partnerUsers)
      .where(
        or(
          eq(partnerUsers.normalizedEmail, normalizedEmail),
          sql`lower(btrim(${partnerUsers.email})) = ${normalizedEmail}`,
        ),
      )
      .limit(2);
    const existingIdentity = identities.length === 1 ? identities[0] : null;
    const [existingMembership] = existingIdentity
      ? await tx
          .select({ id: partnerAccountMemberships.id })
          .from(partnerAccountMemberships)
          .where(
            and(
              eq(partnerAccountMemberships.partnerAccountId, accountId),
              eq(partnerAccountMemberships.partnerUserId, existingIdentity.id),
            ),
          )
          .limit(1)
      : [];
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
      identities.length > 1 ||
      existingMembership ||
      (existingIdentity &&
        (!existingIdentity.active ||
          !["active", "pending_activation"].includes(
            existingIdentity.identityStatus,
          ))) ||
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
    if (!url)
      return { status: 503, body: { ok: false, error: "service_unavailable" } };
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
        accessLevel: input.payload.accessLevel,
        persona: input.payload.persona,
        tokenHash: credential.tokenHash,
        expiresAt,
        invitedByMembershipId: authority.actor.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!invitation) throw new Error("invitation_insert_failed");
    await insertInvitationScopes(tx, {
      invitationId,
      accountId,
      scopes,
      now,
    });
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
      meta: {
        roleKey: authority.role.key,
        persona: input.payload.persona,
        accessLevel: input.payload.accessLevel,
        locationScopeCount: scopes.locationIds.length,
        costCenterScopeCount: scopes.costCenterIds.length,
        generation: 1,
      },
    });
    return {
      status: 202,
      body: {
        ok: true,
        status: "queued",
        invitation: partnerInvitationDto(stored, scopes),
      },
      headers: { ETag: createPortalV2StrongEtag(invitationRevision(stored)) },
    };
  });
}

export async function hasPartnerAccountInvitation(
  accountId: string,
  invitationId: string,
): Promise<boolean> {
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
    return {
      status: 409,
      body: { ok: false, error: "legacy_scope_unavailable" },
    };
  }
  return getDb().transaction(async (tx): Promise<PortalV2StoredResult> => {
    const [account] = await tx
      .select({ id: partnerAccounts.id })
      .from(partnerAccounts)
      .where(eq(partnerAccounts.id, accountId))
      .for("update")
      .limit(1);
    if (!account)
      return { status: 404, body: { ok: false, error: "not_found" } };
    const [row] = await tx
      .select()
      .from(partnerAccountInvitations)
      .where(
        and(
          eq(partnerAccountInvitations.id, input.invitationId),
          eq(partnerAccountInvitations.partnerAccountId, accountId),
        ),
      )
      .for("update")
      .limit(1);
    if (!row) return { status: 404, body: { ok: false, error: "not_found" } };
    const authority = await loadActorAuthority(tx, input.principal);
    if (!authority)
      return { status: 403, body: { ok: false, error: "forbidden" } };
    const precondition = evaluatePortalV2RevisionPrecondition({
      ifMatch: input.ifMatch,
      currentRevision: invitationRevision(row),
      correlationId: input.correlationId,
    });
    if (!precondition.ok) {
      return {
        status: precondition.response.status,
        body: { ...precondition.response.body },
        headers: { ETag: precondition.currentEtag },
      };
    }
    if (row.status !== "pending") {
      return {
        status: 409,
        body: {
          ok: false,
          error: "conflict",
          reason: "invitation_not_pending",
        },
      };
    }
    const scopeSnapshot = (
      await loadInvitationScopes(tx, accountId, [row.id])
    ).get(row.id) ?? { locationIds: [], costCenterIds: [] };
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
        .where(
          and(
            eq(partnerAccountInvitations.id, row.id),
            eq(partnerAccountInvitations.partnerAccountId, accountId),
          ),
        )
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
        body: {
          ok: true,
          invitation: partnerInvitationDto(updated, scopeSnapshot),
        },
        headers: {
          ETag: createPortalV2StrongEtag(invitationRevision(updated)),
        },
      };
    }

    if (
      ["dispatching", "reconciliation_required"].includes(row.deliveryStatus)
    ) {
      return {
        status: 409,
        body: {
          ok: false,
          error: "conflict",
          reason: "delivery_reconciliation_required",
        },
      };
    }

    const [role] = await tx
      .select({
        id: partnerRoleTemplates.id,
        key: partnerRoleTemplates.key,
        version: partnerRoleTemplates.version,
        capabilities: partnerRoleTemplates.capabilities,
      })
      .from(partnerRoleTemplates)
      .where(
        and(
          eq(partnerRoleTemplates.id, row.roleTemplateId),
          eq(partnerRoleTemplates.key, row.roleKey),
          eq(partnerRoleTemplates.version, row.roleTemplateVersion),
          eq(partnerRoleTemplates.active, true),
          isNull(partnerRoleTemplates.partnerAccountId),
        ),
      )
      .limit(1);
    if (
      !role ||
      !mayAssignInvitationRole({
        actorCapabilities: authority.actorCapabilities,
        roleCapabilities: role.capabilities,
      })
    ) {
      return {
        status: 409,
        body: {
          ok: false,
          error: "conflict",
          reason: "invitation_role_changed",
        },
      };
    }
    if (
      !(await validateInvitationScopes(tx, {
        accountId,
        roleKey: row.roleKey,
        accessLevel: row.accessLevel,
        ...scopeSnapshot,
      }))
    ) {
      return {
        status: 409,
        body: {
          ok: false,
          error: "conflict",
          reason: "invitation_scope_changed",
        },
      };
    }

    const credential = makeCredential();
    const url = invitationUrl(credential.rawToken);
    if (!url)
      return { status: 503, body: { ok: false, error: "service_unavailable" } };
    const generation = row.generation + 1;
    const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS);
    const [outbox] = await tx
      .insert(outboxEvents)
      .values({
        type: "partner.account_invitation.email",
        payload: {
          invitationId: row.id,
          generation,
          deliveryUrl: url,
          correlationId: input.correlationId,
        },
        createdAt: now,
      })
      .returning({ id: outboxEvents.id });
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
      .where(
        and(
          eq(partnerAccountInvitations.id, row.id),
          eq(partnerAccountInvitations.partnerAccountId, accountId),
        ),
      )
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
      body: {
        ok: true,
        status: "queued",
        invitation: partnerInvitationDto(updated, scopeSnapshot),
      },
      headers: { ETag: createPortalV2StrongEtag(invitationRevision(updated)) },
    };
  });
}

export async function acceptPartnerAccountInvitation(input: {
  token: string;
  correlationId: string;
}): Promise<{
  accountId: string;
  membershipId: string;
  activationRequired: true;
  deliveryStatus: "queued";
} | null> {
  const tokenHash = hashPartnerInvitationToken(input.token);
  return getDb().transaction(async (tx) => {
    const now = new Date();
    const [candidate] = await tx
      .select({
        id: partnerAccountInvitations.id,
        accountId: partnerAccountInvitations.partnerAccountId,
      })
      .from(partnerAccountInvitations)
      .where(
        and(
          eq(partnerAccountInvitations.tokenHash, tokenHash),
          eq(partnerAccountInvitations.status, "pending"),
        ),
      )
      .limit(1);
    if (!candidate) return null;
    const [account] = await tx
      .select({
        id: partnerAccounts.id,
        portalAccessEnabled: partnerAccounts.portalAccessEnabled,
      })
      .from(partnerAccounts)
      .where(eq(partnerAccounts.id, candidate.accountId))
      .for("update")
      .limit(1);
    if (!account?.portalAccessEnabled) return null;
    const [invitation] = await tx
      .select()
      .from(partnerAccountInvitations)
      .where(
        and(
          eq(partnerAccountInvitations.id, candidate.id),
          eq(partnerAccountInvitations.partnerAccountId, account.id),
          eq(partnerAccountInvitations.tokenHash, tokenHash),
          eq(partnerAccountInvitations.status, "pending"),
        ),
      )
      .for("update")
      .limit(1);
    if (!invitation) return null;
    if (invitation.expiresAt <= now) {
      await tx
        .update(partnerAccountInvitations)
        .set({
          status: "expired",
          tokenHash: null,
          expiredAt: now,
          version: sql`${partnerAccountInvitations.version} + 1`,
          updatedAt: now,
        })
        .where(eq(partnerAccountInvitations.id, invitation.id));
      return null;
    }
    const [role] = await tx
      .select({
        id: partnerRoleTemplates.id,
        capabilities: partnerRoleTemplates.capabilities,
      })
      .from(partnerRoleTemplates)
      .where(
        and(
          eq(partnerRoleTemplates.id, invitation.roleTemplateId),
          eq(partnerRoleTemplates.key, invitation.roleKey),
          eq(partnerRoleTemplates.version, invitation.roleTemplateVersion),
          eq(partnerRoleTemplates.active, true),
          isNull(partnerRoleTemplates.partnerAccountId),
        ),
      )
      .limit(1);
    if (!role) return null;
    const [issuer] = await tx
      .select({
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
            eq(partnerRoleTemplates.partnerAccountId, account.id),
          ),
        ),
      )
      .where(
        and(
          eq(partnerAccountMemberships.id, invitation.invitedByMembershipId),
          eq(partnerAccountMemberships.partnerAccountId, account.id),
        ),
      )
      .limit(1);
    if (
      !issuer ||
      issuer.status !== "active" ||
      issuer.accessLevel !== "account" ||
      !issuer.roleActive
    ) {
      return null;
    }
    const issuerCapabilities = computePartnerCapabilities({
      roleCapabilities: issuer.roleCapabilities ?? [],
      grants: issuer.grants,
      denies: issuer.denies,
    });
    if (
      !issuerCapabilities.includes("account.members.manage") ||
      !mayAssignInvitationRole({
        actorCapabilities: issuerCapabilities,
        roleCapabilities: role.capabilities,
      })
    ) {
      return null;
    }

    const scopeSnapshot = (
      await loadInvitationScopes(tx, account.id, [invitation.id])
    ).get(invitation.id) ?? { locationIds: [], costCenterIds: [] };
    if (
      !(await validateInvitationScopes(tx, {
        accountId: account.id,
        roleKey: invitation.roleKey,
        accessLevel: invitation.accessLevel,
        ...scopeSnapshot,
      }))
    ) {
      return null;
    }

    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`partner-invitation-identity:${invitation.normalizedEmail}`}, 0))`,
    );
    const identities = await tx
      .select({
        id: partnerUsers.id,
        active: partnerUsers.active,
        identityStatus: partnerUsers.identityStatus,
        normalizedEmail: partnerUsers.normalizedEmail,
        securityVersion: partnerUsers.securityVersion,
      })
      .from(partnerUsers)
      .where(
        or(
          eq(partnerUsers.normalizedEmail, invitation.normalizedEmail),
          sql`lower(btrim(${partnerUsers.email})) = ${invitation.normalizedEmail}`,
        ),
      )
      .limit(2);
    if (identities.length > 1) return null;
    const existingIdentity = identities[0];
    if (
      existingIdentity &&
      !(
        (existingIdentity.identityStatus === "active" &&
          existingIdentity.active) ||
        (existingIdentity.identityStatus === "pending_activation" &&
          !existingIdentity.active)
      )
    ) {
      return null;
    }
    if (existingIdentity) {
      const [existingMembership] = await tx
        .select({ id: partnerAccountMemberships.id })
        .from(partnerAccountMemberships)
        .where(
          and(
            eq(partnerAccountMemberships.partnerAccountId, account.id),
            eq(partnerAccountMemberships.partnerUserId, existingIdentity.id),
          ),
        )
        .for("update")
        .limit(1);
      if (existingMembership) return null;
    }
    let partnerUserId = existingIdentity?.id ?? null;
    let securityVersion = existingIdentity?.securityVersion ?? 1;
    if (existingIdentity) {
      const [updated] = await tx
        .update(partnerUsers)
        .set({
          normalizedEmail: invitation.normalizedEmail,
          emailVerifiedAt: now,
          updatedAt: now,
        })
        .where(eq(partnerUsers.id, existingIdentity.id))
        .returning({
          id: partnerUsers.id,
          securityVersion: partnerUsers.securityVersion,
        });
      if (!updated) return null;
      partnerUserId = updated.id;
      securityVersion = updated.securityVersion;
    } else {
      const [created] = await tx
        .insert(partnerUsers)
        .values({
          orgContactId: null,
          email: invitation.normalizedEmail,
          normalizedEmail: invitation.normalizedEmail,
          name: invitation.inviteeName,
          active: false,
          identityStatus: "pending_activation",
          emailVerifiedAt: now,
          mfaRequired: false,
          securityVersion,
          createdAt: now,
          updatedAt: now,
        })
        .returning({
          id: partnerUsers.id,
          securityVersion: partnerUsers.securityVersion,
        });
      if (!created) throw new Error("invitation_identity_insert_failed");
      partnerUserId = created.id;
      securityVersion = created.securityVersion;
    }

    const [anyDefault] = await tx
      .select({ id: partnerAccountMemberships.id })
      .from(partnerAccountMemberships)
      .where(
        and(
          eq(partnerAccountMemberships.partnerUserId, partnerUserId),
          eq(partnerAccountMemberships.isDefault, true),
        ),
      )
      .limit(1);
    const [membership] = await tx
      .insert(partnerAccountMemberships)
      .values({
        partnerAccountId: account.id,
        partnerUserId,
        roleTemplateId: invitation.roleTemplateId,
        roleKey: invitation.roleKey,
        status: "invited",
        persona: invitation.persona,
        accessLevel: invitation.accessLevel,
        accessScope: {
          locationIds: scopeSnapshot.locationIds,
          costCenterIds: scopeSnapshot.costCenterIds,
        },
        isDefault: !anyDefault,
        invitedByPartnerUserId: issuer.partnerUserId,
        invitedAt: invitation.createdAt,
        acceptedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: partnerAccountMemberships.id });
    const membershipId = membership?.id;
    if (!membershipId) throw new Error("invitation_membership_insert_failed");
    if (scopeSnapshot.locationIds.length > 0) {
      await tx.insert(partnerMembershipLocationScopes).values(
        scopeSnapshot.locationIds.map((locationId) => ({
          membershipId,
          partnerAccountId: account.id,
          locationId,
          createdAt: now,
        })),
      );
    }
    if (scopeSnapshot.costCenterIds.length > 0) {
      await tx.insert(partnerMembershipCostCenterScopes).values(
        scopeSnapshot.costCenterIds.map((costCenterId) => ({
          membershipId,
          partnerAccountId: account.id,
          costCenterId,
          createdAt: now,
        })),
      );
    }

    const [accepted] = await tx
      .update(partnerAccountInvitations)
      .set({
        status: "accepted",
        tokenHash: null,
        acceptedByPartnerUserId: partnerUserId,
        acceptedMembershipId: membershipId,
        acceptedAt: now,
        deliveryStatus: "accepted",
        version: sql`${partnerAccountInvitations.version} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(partnerAccountInvitations.id, invitation.id),
          eq(partnerAccountInvitations.tokenHash, tokenHash),
          eq(partnerAccountInvitations.status, "pending"),
        ),
      )
      .returning({ id: partnerAccountInvitations.id });
    if (!accepted) return null;
    await createPartnerActivationChallengeInTransaction(tx, {
      partnerUserId,
      partnerAccountId: account.id,
      partnerMembershipId: membershipId,
      applicationId: null,
      normalizedEmail: invitation.normalizedEmail,
      securityVersion,
      correlationId: input.correlationId,
      now,
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
      meta: {
        partnerAccountId: account.id,
        membershipId,
        roleKey: invitation.roleKey,
        accessLevel: invitation.accessLevel,
        locationScopeCount: scopeSnapshot.locationIds.length,
        costCenterScopeCount: scopeSnapshot.costCenterIds.length,
        activationRequired: true,
        generation: invitation.generation,
      },
    });
    return {
      accountId: account.id,
      membershipId,
      activationRequired: true,
      deliveryStatus: "queued",
    };
  });
}
