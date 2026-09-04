import type { NextRequest } from "next/server";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import {
  auditLogs,
  getDb,
  partnerAccountLocations,
  partnerAccountMemberships,
  partnerAccounts,
  partnerMembershipCostCenterScopes,
  partnerMembershipLocationScopes,
  partnerRoleTemplates,
  partnerSessions,
} from "@/db";
import type {
  PartnerMembershipAccessLevel,
  PartnerMembershipAccessScope,
  PartnerMembershipPreferences,
  PartnerPersona,
} from "@/db";
import { requirePartnerSession } from "@/lib/partner-portal-auth";
import { sanitizeAuditMetadata } from "@/lib/audit-metadata";

export const PARTNER_CAPABILITY_CATALOG = [
  "portal.session.read",
  "portal.session.switch_account",
  "account.read",
  "account.update",
  "account.members.read",
  "account.members.manage",
  "account.security.manage",
  "account.notifications.manage",
  "bookings.read",
  "bookings.create",
  "bookings.update",
  "bookings.cancel",
  "bookings.pricing.read",
  "approvals.read",
  "approvals.decide",
  "properties.read",
  "properties.manage",
  "jobs.read",
  "jobs.change_request",
  "media.read",
  "media.upload",
  "proof.read",
  "proof.request",
  "rates.read",
  "quotes.read",
  "quotes.respond",
  "commercial.edit",
  "invoices.read",
  "invoices.disputes.request",
  "payments.initiate",
  "documents.operational.read",
  "documents.operational.manage",
  "documents.financial.read",
  "documents.financial.manage",
  "messages.read",
  "messages.send",
  "reports.operational.read",
  "reports.operational.export",
  "reports.financial.read",
  "reports.financial.export",
] as const;

export type PartnerCapability = (typeof PARTNER_CAPABILITY_CATALOG)[number];

export const PARTNER_INTRINSIC_CAPABILITIES = [
  "portal.session.read",
  "portal.session.switch_account",
] as const satisfies readonly PartnerCapability[];

const ROUTINE_MAGIC_LINK_CAPABILITIES = [
  "portal.session.read",
] as const satisfies readonly PartnerCapability[];

export const PARTNER_LAUNCH_ROLE_KEYS = [
  "administrator",
  "operations",
  "billing_approver",
  "viewer",
] as const;

export type PartnerLaunchRoleKey = (typeof PARTNER_LAUNCH_ROLE_KEYS)[number];

const PARTNER_LAUNCH_ROLE_KEY_SET = new Set<string>(PARTNER_LAUNCH_ROLE_KEYS);

export function isPartnerLaunchRoleKey(
  value: string,
): value is PartnerLaunchRoleKey {
  return PARTNER_LAUNCH_ROLE_KEY_SET.has(value);
}

const ADMINISTRATOR_CAPABILITIES = [...PARTNER_CAPABILITY_CATALOG];

export const PARTNER_SYSTEM_ROLE_TEMPLATES = {
  administrator: ADMINISTRATOR_CAPABILITIES,
  operations: [
    "portal.session.read",
    "portal.session.switch_account",
    "account.read",
    "bookings.read",
    "bookings.create",
    "bookings.update",
    "bookings.cancel",
    "bookings.pricing.read",
    "properties.read",
    "properties.manage",
    "jobs.read",
    "jobs.change_request",
    "media.read",
    "media.upload",
    "proof.read",
    "proof.request",
    "documents.operational.read",
    "documents.operational.manage",
    "messages.read",
    "messages.send",
    "reports.operational.read",
    "reports.operational.export",
  ],
  billing_approver: [
    "portal.session.read",
    "portal.session.switch_account",
    "account.read",
    "bookings.read",
    "bookings.pricing.read",
    "approvals.read",
    "approvals.decide",
    "properties.read",
    "jobs.read",
    "proof.read",
    "rates.read",
    "quotes.read",
    "quotes.respond",
    "commercial.edit",
    "invoices.read",
    "invoices.disputes.request",
    "payments.initiate",
    "documents.financial.read",
    "documents.financial.manage",
    "reports.financial.read",
    "reports.financial.export",
  ],
  viewer: [
    "portal.session.read",
    "portal.session.switch_account",
    "account.read",
    "bookings.read",
    "properties.read",
    "jobs.read",
    "media.read",
    "proof.read",
    "documents.operational.read",
    "messages.read",
    "reports.operational.read",
  ],
} as const satisfies Record<string, readonly PartnerCapability[]>;

const CAPABILITY_SET = new Set<string>(PARTNER_CAPABILITY_CATALOG);
const INTRINSIC_SET = new Set<string>(PARTNER_INTRINSIC_CAPABILITIES);

function capabilityPatternMatches(pattern: string, required: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) {
    return required.startsWith(`${pattern.slice(0, -2)}.`);
  }
  return pattern === required;
}

function materializeCapabilityPatterns(
  patterns: readonly string[] | null | undefined,
): PartnerCapability[] {
  const normalized = (patterns ?? [])
    .map((pattern) => pattern.trim().toLowerCase())
    .filter(Boolean);
  return PARTNER_CAPABILITY_CATALOG.filter((capability) =>
    normalized.some((pattern) => capabilityPatternMatches(pattern, capability)),
  );
}

/**
 * Materialize only capabilities in the stable registry. Unknown values never
 * grant authority, granular/prefix denies win, and self-session operations
 * remain intrinsic to every active human membership.
 */
export function computePartnerCapabilities(input: {
  roleCapabilities: readonly string[] | null | undefined;
  grants?: readonly string[] | null;
  denies?: readonly string[] | null;
}): PartnerCapability[] {
  const granted = new Set<PartnerCapability>([
    ...materializeCapabilityPatterns(input.roleCapabilities),
    ...materializeCapabilityPatterns(input.grants),
    ...PARTNER_INTRINSIC_CAPABILITIES,
  ]);
  const denies = (input.denies ?? [])
    .map((denied) => denied.trim().toLowerCase())
    .filter(Boolean);

  return PARTNER_CAPABILITY_CATALOG.filter((capability) => {
    if (!granted.has(capability)) return false;
    if (INTRINSIC_SET.has(capability)) return true;
    return !denies.some((denied) =>
      capabilityPatternMatches(denied, capability),
    );
  });
}

export function isPartnerCapability(value: string): value is PartnerCapability {
  return CAPABILITY_SET.has(value);
}

export type PartnerAccountAccess = {
  accountId: string;
  accountName: string;
  accountStatus: string;
  membershipId: string;
  membershipStatus: "active";
  roleKey: string;
  persona: PartnerPersona;
  accessLevel: PartnerMembershipAccessLevel;
  accessScope: PartnerMembershipAccessScope;
  preferences: PartnerMembershipPreferences;
  capabilities: PartnerCapability[];
  isDefault: boolean;
  /** Canonical V1 compatibility anchor owned by the selected account. */
  legacyOrgContactId: string | null;
  source: "membership";
};

export type PartnerPrincipal = {
  type: "partner";
  partnerUserId: string;
  email: string;
  name: string;
  passwordSet: boolean;
  accountId: string | null;
  accountName: string;
  membershipId: string | null;
  roleKey: string;
  persona: PartnerPersona;
  accessLevel: PartnerMembershipAccessLevel;
  accessScope: PartnerMembershipAccessScope;
  preferences: PartnerMembershipPreferences;
  legacyOrgContactId: string | null;
  capabilities: PartnerCapability[];
  accessSource: "membership";
  session: {
    id: string;
    authMethod: "legacy" | "magic_link" | "password" | "passkey";
    deviceName: string | null;
    createdAt: Date;
    lastSeenAt: Date;
    expiresAt: Date;
  };
  availableAccounts: PartnerAccountAccess[];
};

export type PartnerPrincipalResult =
  | { ok: true; principal: PartnerPrincipal }
  | { ok: false; status: number; error: string };

export function selectPartnerAccountAccess(input: {
  activeAccesses: readonly PartnerAccountAccess[];
  selectedAccountId: string | null;
  selectedMembershipId: string | null;
}):
  | { ok: true; access: PartnerAccountAccess }
  | { ok: false; status: 403; error: "account_access_required" } {
  const selected = input.activeAccesses.find(
    (access) =>
      access.accountId === input.selectedAccountId &&
      access.membershipId === input.selectedMembershipId,
  );
  if (selected) return { ok: true, access: selected };

  const fallback =
    input.activeAccesses.find((access) => access.isDefault) ??
    input.activeAccesses[0];
  if (fallback) return { ok: true, access: fallback };

  // Portal V2 is account-owned. A contact relationship is never an
  // authorization substitute for an active membership, including for users
  // whose prior membership was suspended or removed.
  return { ok: false, status: 403, error: "account_access_required" };
}

type MembershipAccessRow = {
  accountId: string;
  accountName: string;
  accountStatus: string;
  portalAccessEnabled: boolean;
  portalContactId: string | null;
  membershipId: string;
  membershipStatus: string;
  roleTemplateId: string | null;
  roleKey: string;
  persona: PartnerPersona;
  accessLevel: PartnerMembershipAccessLevel;
  accessScope: PartnerMembershipAccessScope;
  preferences: PartnerMembershipPreferences;
  capabilityGrants: string[];
  capabilityDenies: string[];
  isDefault: boolean;
  roleCapabilities: string[] | null;
  roleTemplateActive: boolean | null;
};

export function isPartnerV2MembershipEligible(input: {
  membershipStatus: string;
  portalAccessEnabled: boolean;
}): boolean {
  return (
    input.membershipStatus === "active" && input.portalAccessEnabled === true
  );
}

function membershipAccess(
  row: MembershipAccessRow,
  relationalScope: PartnerMembershipAccessScope,
): PartnerAccountAccess | null {
  if (!isPartnerV2MembershipEligible(row)) return null;
  const roleCapabilities =
    row.roleTemplateId && row.roleTemplateActive
      ? (row.roleCapabilities ?? [])
      : [];
  return {
    accountId: row.accountId,
    accountName: row.accountName,
    accountStatus: row.accountStatus,
    membershipId: row.membershipId,
    membershipStatus: "active",
    roleKey: row.roleKey,
    persona: row.persona,
    accessLevel: row.accessLevel,
    // Relational scope rows are the authority. The JSON column remains only a
    // migration/display projection and is deliberately ignored here.
    accessScope: row.accessLevel === "account" ? {} : relationalScope,
    preferences: row.preferences,
    capabilities: computePartnerCapabilities({
      roleCapabilities,
      grants: row.capabilityGrants,
      denies: row.capabilityDenies,
    }),
    isDefault: row.isDefault,
    legacyOrgContactId: row.portalContactId,
    source: "membership",
  };
}

async function loadRelationalMembershipScopes(
  membershipIds: readonly string[],
): Promise<Map<string, PartnerMembershipAccessScope>> {
  const result = new Map<string, PartnerMembershipAccessScope>();
  if (membershipIds.length === 0) return result;
  const db = getDb();
  const [locations, costCenters] = await Promise.all([
    db
      .select({
        membershipId: partnerMembershipLocationScopes.membershipId,
        locationId: partnerMembershipLocationScopes.locationId,
        propertyId: partnerAccountLocations.propertyId,
      })
      .from(partnerMembershipLocationScopes)
      .innerJoin(
        partnerAccountLocations,
        and(
          eq(
            partnerAccountLocations.partnerAccountId,
            partnerMembershipLocationScopes.partnerAccountId,
          ),
          eq(
            partnerAccountLocations.id,
            partnerMembershipLocationScopes.locationId,
          ),
        ),
      )
      .where(
        inArray(partnerMembershipLocationScopes.membershipId, [
          ...membershipIds,
        ]),
      ),
    db
      .select({
        membershipId: partnerMembershipCostCenterScopes.membershipId,
        costCenterId: partnerMembershipCostCenterScopes.costCenterId,
      })
      .from(partnerMembershipCostCenterScopes)
      .where(
        inArray(partnerMembershipCostCenterScopes.membershipId, [
          ...membershipIds,
        ]),
      ),
  ]);
  for (const row of locations) {
    const scope = result.get(row.membershipId) ?? {};
    scope.locationIds = [...(scope.locationIds ?? []), row.locationId];
    if (row.propertyId) {
      scope.propertyIds = [...(scope.propertyIds ?? []), row.propertyId];
    }
    result.set(row.membershipId, scope);
  }
  for (const row of costCenters) {
    const scope = result.get(row.membershipId) ?? {};
    scope.costCenterIds = [...(scope.costCenterIds ?? []), row.costCenterId];
    result.set(row.membershipId, scope);
  }
  return result;
}

async function loadActiveMembershipAccesses(
  partnerUserId: string,
): Promise<PartnerAccountAccess[]> {
  const db = getDb();
  const rows = await db
    .select({
      accountId: partnerAccounts.id,
      accountName: partnerAccounts.name,
      accountStatus: partnerAccounts.status,
      portalAccessEnabled: partnerAccounts.portalAccessEnabled,
      portalContactId: partnerAccounts.portalContactId,
      membershipId: partnerAccountMemberships.id,
      membershipStatus: partnerAccountMemberships.status,
      roleTemplateId: partnerAccountMemberships.roleTemplateId,
      roleKey: partnerAccountMemberships.roleKey,
      persona: partnerAccountMemberships.persona,
      accessLevel: partnerAccountMemberships.accessLevel,
      accessScope: partnerAccountMemberships.accessScope,
      preferences: partnerAccountMemberships.preferences,
      capabilityGrants: partnerAccountMemberships.capabilityGrants,
      capabilityDenies: partnerAccountMemberships.capabilityDenies,
      isDefault: partnerAccountMemberships.isDefault,
      roleCapabilities: partnerRoleTemplates.capabilities,
      roleTemplateActive: partnerRoleTemplates.active,
    })
    .from(partnerAccountMemberships)
    .innerJoin(
      partnerAccounts,
      eq(partnerAccountMemberships.partnerAccountId, partnerAccounts.id),
    )
    .leftJoin(
      partnerRoleTemplates,
      and(
        eq(partnerAccountMemberships.roleTemplateId, partnerRoleTemplates.id),
        or(
          isNull(partnerRoleTemplates.partnerAccountId),
          eq(
            partnerRoleTemplates.partnerAccountId,
            partnerAccountMemberships.partnerAccountId,
          ),
        ),
      ),
    )
    .where(
      and(
        eq(partnerAccountMemberships.partnerUserId, partnerUserId),
        eq(partnerAccountMemberships.status, "active"),
        eq(partnerAccounts.portalAccessEnabled, true),
      ),
    )
    .orderBy(
      desc(partnerAccountMemberships.isDefault),
      asc(partnerAccounts.name),
      asc(partnerAccountMemberships.id),
    );

  const scopes = await loadRelationalMembershipScopes(
    rows.map((row) => row.membershipId),
  );

  return rows.flatMap((row) => {
    const access = membershipAccess(row, scopes.get(row.membershipId) ?? {});
    return access ? [access] : [];
  });
}

export function normalizePartnerPersona(value: string | null): PartnerPersona {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (normalized.includes("contract")) return "contractor";
  if (/real.?estate|realtor|agent/u.test(normalized)) {
    return "real_estate_agent";
  }
  if (/property.?manage|manager/u.test(normalized)) {
    return "property_manager";
  }
  if (/commercial|business|client/u.test(normalized)) {
    return "commercial_client";
  }
  return "other";
}

export async function resolvePartnerPrincipal(
  request: NextRequest,
): Promise<PartnerPrincipalResult> {
  const authentication = await requirePartnerSession(request);
  if (!authentication.ok) return authentication;
  if (
    authentication.session.authMethod === "magic_link" &&
    request.method !== "GET" &&
    request.method !== "HEAD"
  ) {
    return { ok: false, status: 403, error: "forbidden" };
  }

  const availableAccounts = await loadActiveMembershipAccesses(
    authentication.partnerUser.id,
  );
  const selection = selectPartnerAccountAccess({
    activeAccesses: availableAccounts,
    selectedAccountId: authentication.session.activePartnerAccountId,
    selectedMembershipId: authentication.session.activeMembershipId,
  });
  if (!selection.ok) return selection;
  const selected = selection.access;
  const isRoutineMagicLink = authentication.session.authMethod === "magic_link";
  const effectiveCapabilities = isRoutineMagicLink
    ? [...ROUTINE_MAGIC_LINK_CAPABILITIES]
    : selected.capabilities;
  const effectiveAvailableAccounts = isRoutineMagicLink
    ? availableAccounts.map((access) => ({
        ...access,
        capabilities: [...ROUTINE_MAGIC_LINK_CAPABILITIES],
      }))
    : availableAccounts;

  return {
    ok: true,
    principal: {
      type: "partner",
      partnerUserId: authentication.partnerUser.id,
      email: authentication.partnerUser.email,
      name: authentication.partnerUser.name,
      passwordSet: authentication.partnerUser.passwordSet,
      accountId: selected.accountId,
      accountName: selected.accountName,
      membershipId: selected.membershipId,
      roleKey: selected.roleKey,
      persona: selected.persona,
      accessLevel: selected.accessLevel,
      accessScope: selected.accessScope,
      preferences: selected.preferences,
      legacyOrgContactId: selected.legacyOrgContactId,
      capabilities: effectiveCapabilities,
      accessSource: selected.source,
      session: {
        id: authentication.session.id,
        authMethod: authentication.session.authMethod,
        deviceName: authentication.session.deviceName,
        createdAt: authentication.session.createdAt,
        lastSeenAt: authentication.session.lastSeenAt,
        expiresAt: authentication.session.expiresAt,
      },
      availableAccounts: effectiveAvailableAccounts,
    },
  };
}

export function hasPartnerCapability(
  principal: Pick<PartnerPrincipal, "capabilities">,
  capability: PartnerCapability,
): boolean {
  return principal.capabilities.includes(capability);
}

export async function requirePartnerCapability(
  request: NextRequest,
  capability: PartnerCapability,
): Promise<PartnerPrincipalResult> {
  const result = await resolvePartnerPrincipal(request);
  if (!result.ok) return result;
  if (!hasPartnerCapability(result.principal, capability)) {
    return { ok: false, status: 403, error: "forbidden" };
  }
  return result;
}

/**
 * Explicit bridge for V1 routes after V2 membership authorization. The
 * contact is the selected account's canonical compatibility anchor, never the
 * partner user's possibly stale organization contact.
 */
export function adaptPartnerPrincipalToLegacySession(
  principal: PartnerPrincipal,
):
  | {
      ok: true;
      partnerUser: {
        id: string;
        sessionId: string;
        orgContactId: string;
        email: string;
        name: string;
        passwordSet: boolean;
      };
    }
  | { ok: false; status: 409; error: "legacy_scope_unavailable" } {
  if (!principal.legacyOrgContactId) {
    return { ok: false, status: 409, error: "legacy_scope_unavailable" };
  }
  return {
    ok: true,
    partnerUser: {
      id: principal.partnerUserId,
      sessionId: principal.session.id,
      orgContactId: principal.legacyOrgContactId,
      email: principal.email,
      name: principal.name,
      passwordSet: principal.passwordSet,
    },
  };
}

export type SwitchPartnerAccountResult =
  | {
      ok: true;
      accountId: string;
      membershipId: string;
      defaultAccount: boolean;
    }
  | { ok: false; status: 401 | 403; error: string };

export async function switchPartnerSessionAccount(
  authentication: Extract<
    Awaited<ReturnType<typeof requirePartnerSession>>,
    { ok: true }
  >,
  accountId: string,
  options: { makeDefault?: boolean; correlationId?: string | null } = {},
): Promise<SwitchPartnerAccountResult> {
  const db = getDb();
  return db.transaction(async (tx) => {
    if (options.makeDefault === true) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`partner-default-account:${authentication.partnerUser.id}`}, 0))`,
      );
    }
    const [account] = await tx
      .select({ id: partnerAccounts.id })
      .from(partnerAccounts)
      .where(
        and(
          eq(partnerAccounts.id, accountId),
          eq(partnerAccounts.portalAccessEnabled, true),
        ),
      )
      .for("update")
      .limit(1);
    if (!account?.id) {
      return { ok: false as const, status: 403 as const, error: "forbidden" };
    }

    const [membership] = await tx
      .select({
        id: partnerAccountMemberships.id,
        accountId: partnerAccountMemberships.partnerAccountId,
        isDefault: partnerAccountMemberships.isDefault,
      })
      .from(partnerAccountMemberships)
      .where(
        and(
          eq(
            partnerAccountMemberships.partnerUserId,
            authentication.partnerUser.id,
          ),
          eq(partnerAccountMemberships.partnerAccountId, account.id),
          eq(partnerAccountMemberships.status, "active"),
        ),
      )
      .for("update")
      .limit(1);
    if (!membership?.id) {
      return { ok: false as const, status: 403 as const, error: "forbidden" };
    }

    const now = new Date();
    const [updated] = await tx
      .update(partnerSessions)
      .set({
        activePartnerAccountId: membership.accountId,
        activeMembershipId: membership.id,
        accountSelectedAt: now,
        lastSeenAt: now,
      })
      .where(
        and(
          eq(partnerSessions.id, authentication.session.id),
          eq(partnerSessions.partnerUserId, authentication.partnerUser.id),
          eq(
            partnerSessions.securityVersion,
            authentication.session.securityVersion,
          ),
          isNull(partnerSessions.revokedAt),
          gt(partnerSessions.expiresAt, now),
        ),
      )
      .returning({ id: partnerSessions.id });
    if (!updated?.id) {
      return {
        ok: false as const,
        status: 401 as const,
        error: "session_revoked",
      };
    }

    if (options.makeDefault === true && !membership.isDefault) {
      await tx
        .update(partnerAccountMemberships)
        .set({ isDefault: false, updatedAt: now })
        .where(
          and(
            eq(
              partnerAccountMemberships.partnerUserId,
              authentication.partnerUser.id,
            ),
            ne(partnerAccountMemberships.id, membership.id),
            eq(partnerAccountMemberships.isDefault, true),
          ),
        );
      const [defaulted] = await tx
        .update(partnerAccountMemberships)
        .set({ isDefault: true, updatedAt: now })
        .where(
          and(
            eq(partnerAccountMemberships.id, membership.id),
            eq(
              partnerAccountMemberships.partnerUserId,
              authentication.partnerUser.id,
            ),
            eq(partnerAccountMemberships.partnerAccountId, account.id),
            eq(partnerAccountMemberships.status, "active"),
          ),
        )
        .returning({ id: partnerAccountMemberships.id });
      if (!defaulted?.id) {
        throw new Error("partner_default_account_update_failed");
      }
    }

    await tx.insert(auditLogs).values({
      actorType: "human",
      actorId: authentication.partnerUser.id,
      actorRole: "partner",
      actorLabel: authentication.partnerUser.email,
      sessionId: authentication.session.id,
      authMethod: "partner_session",
      correlationId: options.correlationId ?? null,
      requiredPermissions: ["portal.session.switch_account"],
      outcome: "succeeded",
      surface: "/partners",
      action:
        options.makeDefault === true
          ? "partner.portal.account_switched_and_defaulted"
          : "partner.portal.account_switched",
      entityType: "partner_session",
      entityId: authentication.session.id,
      meta: sanitizeAuditMetadata({
        previousPartnerAccountId: authentication.session.activePartnerAccountId,
        partnerAccountId: membership.accountId,
        membershipId: membership.id,
        defaultAccount:
          options.makeDefault === true || membership.isDefault === true,
      }),
      createdAt: now,
    });

    return {
      ok: true as const,
      accountId: membership.accountId,
      membershipId: membership.id,
      defaultAccount:
        options.makeDefault === true || membership.isDefault === true,
    };
  });
}
