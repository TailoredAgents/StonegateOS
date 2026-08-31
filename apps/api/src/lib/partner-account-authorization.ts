import type { NextRequest } from "next/server";
import { and, asc, desc, eq, gt, isNull, or } from "drizzle-orm";
import {
  getDb,
  partnerAccountMemberships,
  partnerAccounts,
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
  "bookings.approve",
  "properties.read",
  "properties.manage",
  "jobs.read",
  "jobs.change_request",
  "media.read",
  "media.upload",
  "proof.read",
  "proof.request",
  "rates.read",
  "invoices.read",
  "payments.manage",
  "documents.read",
  "documents.manage",
  "messages.read",
  "messages.send",
  "reports.read",
  "reports.export",
] as const;

export type PartnerCapability = (typeof PARTNER_CAPABILITY_CATALOG)[number];

export const PARTNER_INTRINSIC_CAPABILITIES = [
  "portal.session.read",
  "portal.session.switch_account",
] as const satisfies readonly PartnerCapability[];

const OWNER_CAPABILITIES = [...PARTNER_CAPABILITY_CATALOG];

export const PARTNER_SYSTEM_ROLE_TEMPLATES = {
  owner: OWNER_CAPABILITIES,
  admin: OWNER_CAPABILITIES.filter(
    (capability) =>
      capability !== "account.security.manage" &&
      capability !== "payments.manage",
  ),
  scheduler: [
    "portal.session.read",
    "portal.session.switch_account",
    "account.read",
    "account.members.read",
    "bookings.read",
    "bookings.create",
    "bookings.update",
    "bookings.cancel",
    "properties.read",
    "properties.manage",
    "jobs.read",
    "jobs.change_request",
    "media.read",
    "media.upload",
    "proof.read",
    "proof.request",
    "rates.read",
    "documents.read",
    "messages.read",
    "messages.send",
    "reports.read",
  ],
  approver: [
    "portal.session.read",
    "portal.session.switch_account",
    "account.read",
    "bookings.read",
    "bookings.update",
    "bookings.approve",
    "properties.read",
    "jobs.read",
    "jobs.change_request",
    "media.read",
    "proof.read",
    "proof.request",
    "rates.read",
    "invoices.read",
    "documents.read",
    "messages.read",
    "messages.send",
    "reports.read",
  ],
  billing: [
    "portal.session.read",
    "portal.session.switch_account",
    "account.read",
    "bookings.read",
    "properties.read",
    "jobs.read",
    "proof.read",
    "rates.read",
    "invoices.read",
    "payments.manage",
    "documents.read",
    "messages.read",
    "reports.read",
    "reports.export",
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
    "rates.read",
    "invoices.read",
    "documents.read",
    "messages.read",
    "reports.read",
  ],
} as const satisfies Record<string, readonly PartnerCapability[]>;

const CAPABILITY_SET = new Set<string>(PARTNER_CAPABILITY_CATALOG);
const INTRINSIC_SET = new Set<string>(PARTNER_INTRINSIC_CAPABILITIES);
const MFA_REQUIRED_ROLE_KEYS = new Set([
  "owner",
  "admin",
  "approver",
  "billing",
]);
const MFA_REQUIRED_CAPABILITIES = new Set<PartnerCapability>([
  "account.members.manage",
  "account.security.manage",
  "bookings.approve",
  "payments.manage",
]);

export function partnerAccessRequiresMfa(input: {
  roleKey: string;
  capabilities: readonly PartnerCapability[];
}): boolean {
  return (
    MFA_REQUIRED_ROLE_KEYS.has(input.roleKey) ||
    input.capabilities.some((capability) =>
      MFA_REQUIRED_CAPABILITIES.has(capability),
    )
  );
}

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
    authMethod:
      | "legacy"
      | "magic_link"
      | "password"
      | "passkey"
      | "mfa_step_up";
    assuranceLevel: "aal1" | "aal2";
    mfaVerifiedAt: Date | null;
    deviceName: string | null;
    createdAt: Date;
    lastSeenAt: Date;
    expiresAt: Date;
  };
  security: {
    mfaRequired: boolean;
    mfaEnrolled: boolean;
    mfaSatisfied: boolean;
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
    accessScope: row.accessScope,
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

  return rows.flatMap((row) => {
    const access = membershipAccess(row);
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

  const mfaRequired =
    authentication.partnerUser.mfaRequired ||
    partnerAccessRequiresMfa({
      roleKey: selected.roleKey,
      capabilities: selected.capabilities,
    });
  const mfaSatisfied =
    !mfaRequired || authentication.session.assuranceLevel === "aal2";
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
      capabilities: selected.capabilities,
      accessSource: selected.source,
      session: {
        id: authentication.session.id,
        authMethod: authentication.session.authMethod,
        assuranceLevel: authentication.session.assuranceLevel,
        mfaVerifiedAt: authentication.session.mfaVerifiedAt,
        deviceName: authentication.session.deviceName,
        createdAt: authentication.session.createdAt,
        lastSeenAt: authentication.session.lastSeenAt,
        expiresAt: authentication.session.expiresAt,
      },
      security: {
        mfaRequired,
        mfaEnrolled: Boolean(authentication.partnerUser.mfaEnrolledAt),
        mfaSatisfied,
      },
      availableAccounts,
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
  if (
    !INTRINSIC_SET.has(capability) &&
    result.principal.security.mfaRequired &&
    !result.principal.security.mfaSatisfied
  ) {
    return { ok: false, status: 403, error: "mfa_step_up_required" };
  }
  return result;
}

export async function requirePartnerAssurance(
  request: NextRequest,
  assuranceLevel: "aal1" | "aal2",
): Promise<PartnerPrincipalResult> {
  const result = await resolvePartnerPrincipal(request);
  if (!result.ok || assuranceLevel === "aal1") return result;
  if (result.principal.session.assuranceLevel !== "aal2") {
    return { ok: false, status: 403, error: "mfa_step_up_required" };
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
  | { ok: true; accountId: string; membershipId: string }
  | { ok: false; status: 401 | 403; error: string };

export async function switchPartnerSessionAccount(
  authentication: Extract<
    Awaited<ReturnType<typeof requirePartnerSession>>,
    { ok: true }
  >,
  accountId: string,
): Promise<SwitchPartnerAccountResult> {
  const db = getDb();
  return db.transaction(async (tx) => {
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

    return {
      ok: true as const,
      accountId: membership.accountId,
      membershipId: membership.id,
    };
  });
}
