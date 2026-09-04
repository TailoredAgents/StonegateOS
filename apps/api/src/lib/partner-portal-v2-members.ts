import { and, asc, eq, gt, ilike, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";
import {
  auditLogs,
  getDb,
  partnerAccountMemberships,
  partnerAccountCostCenters,
  partnerAccountLocations,
  partnerAccounts,
  partnerMembershipCostCenterScopes,
  partnerMembershipLocationScopes,
  partnerRoleTemplates,
  partnerSessions,
  partnerUsers,
} from "@/db";
import {
  computePartnerCapabilities,
  isPartnerLaunchRoleKey,
  PARTNER_LAUNCH_ROLE_KEYS,
  type PartnerCapability,
  type PartnerPrincipal,
} from "@/lib/partner-account-authorization";
import {
  createPortalV2StrongEtag,
  evaluatePortalV2RevisionPrecondition,
} from "@/lib/portal-v2-contract";
import type { PortalV2StoredResult } from "@/lib/partner-portal-v2-idempotency";
import {
  assertTeamMutationExpectedVersion,
  TeamMutationFailure,
  type TeamMutationTransaction,
} from "@/lib/team-mutation";

export const PartnerMemberMutationSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("role_update"),
      roleKey: z.enum(PARTNER_LAUNCH_ROLE_KEYS),
    })
    .strict(),
  z.object({ action: z.literal("suspend") }).strict(),
  z.object({ action: z.literal("reactivate") }).strict(),
  z
    .object({
      action: z.literal("scope_update"),
      accessLevel: z.enum(["account", "scoped"]),
      locationIds: z.array(z.string().uuid()).max(250).default([]),
      costCenterIds: z.array(z.string().uuid()).max(250).default([]),
    })
    .strict(),
]);

export type PartnerMemberMutation = z.infer<typeof PartnerMemberMutationSchema>;

export type PartnerMemberStatusFilter =
  | "all"
  | "invited"
  | "active"
  | "suspended"
  | "removed";

export type PartnerMemberCursor = {
  accountId: string;
  filterHash: string;
  name: string;
  id: string;
};

/** Composite tenant predicate; resource IDs are never queried on their own. */
export function createPartnerMemberTargetCondition(
  accountId: string,
  membershipId: string,
) {
  return and(
    eq(partnerAccountMemberships.id, membershipId),
    eq(partnerAccountMemberships.partnerAccountId, accountId),
  );
}

export async function hasPartnerAccountMember(
  accountId: string,
  membershipId: string,
): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: partnerAccountMemberships.id })
    .from(partnerAccountMemberships)
    .where(createPartnerMemberTargetCondition(accountId, membershipId))
    .limit(1);
  return Boolean(row?.id);
}

type MembershipRow = {
  id: string;
  partnerAccountId: string;
  partnerUserId: string;
  roleTemplateId: string | null;
  roleKey: string;
  status: "invited" | "active" | "suspended" | "removed";
  capabilityGrants: string[];
  capabilityDenies: string[];
  persona: string;
  accessLevel: "account" | "scoped";
  accessScope: Record<string, unknown>;
  isDefault: boolean;
  invitedAt: Date;
  acceptedAt: Date | null;
  suspendedAt: Date | null;
  removedAt: Date | null;
  migrationReviewStatus:
    | "not_required"
    | "pending"
    | "approved"
    | "quarantined";
  migrationLegacyRoleKey: string | null;
  migrationReviewedByTeamMemberId: string | null;
  migrationReviewedAt: Date | null;
  migrationReviewNote: string | null;
  createdAt: Date;
  updatedAt: Date;
  userName: string;
  userEmail: string;
  userActive: boolean;
  roleName: string | null;
  roleDescription: string | null;
  roleCapabilities: string[] | null;
  roleActive: boolean | null;
};

type RoleRow = {
  id: string;
  partnerAccountId: string | null;
  key: string;
  name: string;
  description: string;
  capabilities: string[];
  isSystem: boolean;
};

function memberSelection() {
  return {
    id: partnerAccountMemberships.id,
    partnerAccountId: partnerAccountMemberships.partnerAccountId,
    partnerUserId: partnerAccountMemberships.partnerUserId,
    roleTemplateId: partnerAccountMemberships.roleTemplateId,
    roleKey: partnerAccountMemberships.roleKey,
    status: partnerAccountMemberships.status,
    capabilityGrants: partnerAccountMemberships.capabilityGrants,
    capabilityDenies: partnerAccountMemberships.capabilityDenies,
    persona: partnerAccountMemberships.persona,
    accessLevel: partnerAccountMemberships.accessLevel,
    accessScope: partnerAccountMemberships.accessScope,
    isDefault: partnerAccountMemberships.isDefault,
    invitedAt: partnerAccountMemberships.invitedAt,
    acceptedAt: partnerAccountMemberships.acceptedAt,
    suspendedAt: partnerAccountMemberships.suspendedAt,
    removedAt: partnerAccountMemberships.removedAt,
    migrationReviewStatus: partnerAccountMemberships.migrationReviewStatus,
    migrationLegacyRoleKey: partnerAccountMemberships.migrationLegacyRoleKey,
    migrationReviewedByTeamMemberId:
      partnerAccountMemberships.migrationReviewedByTeamMemberId,
    migrationReviewedAt: partnerAccountMemberships.migrationReviewedAt,
    migrationReviewNote: partnerAccountMemberships.migrationReviewNote,
    createdAt: partnerAccountMemberships.createdAt,
    updatedAt: partnerAccountMemberships.updatedAt,
    userName: partnerUsers.name,
    userEmail: partnerUsers.email,
    userActive: partnerUsers.active,
    roleName: partnerRoleTemplates.name,
    roleDescription: partnerRoleTemplates.description,
    roleCapabilities: partnerRoleTemplates.capabilities,
    roleActive: partnerRoleTemplates.active,
  };
}

function membershipCapabilities(
  row: Pick<
    MembershipRow,
    | "roleTemplateId"
    | "roleCapabilities"
    | "roleActive"
    | "capabilityGrants"
    | "capabilityDenies"
  >,
): PartnerCapability[] {
  return computePartnerCapabilities({
    roleCapabilities:
      row.roleTemplateId && row.roleActive ? (row.roleCapabilities ?? []) : [],
    grants: row.capabilityGrants,
    denies: row.capabilityDenies,
  });
}

function capabilitiesAreSubset(
  candidate: readonly PartnerCapability[],
  authority: readonly PartnerCapability[],
): boolean {
  const allowed = new Set(authority);
  return candidate.every((capability) => allowed.has(capability));
}

export type PartnerMemberAdministrationDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | "self_suspension"
        | "last_administrator"
        | "privilege_escalation"
        | "invalid_transition"
        | "no_change";
    };

/**
 * Pure policy boundary shared by the route and its focused authorization
 * tests. An administrator cannot remove the final management principal,
 * suspend themselves, or grant/control authority they do not hold.
 */
export function evaluatePartnerMemberAdministration(input: {
  actorPartnerUserId: string;
  actorCapabilities: readonly PartnerCapability[];
  targetPartnerUserId: string;
  targetStatus: MembershipRow["status"];
  targetCapabilities: readonly PartnerCapability[];
  activeAdministratorCount: number;
  mutation: PartnerMemberMutation;
  proposedCapabilities?: readonly PartnerCapability[];
  currentRoleKey: string;
}): PartnerMemberAdministrationDecision {
  const targetIsSelf = input.actorPartnerUserId === input.targetPartnerUserId;
  const targetIsAdministrator = input.targetCapabilities.includes(
    "account.members.manage",
  );

  if (
    input.mutation.action !== "reactivate" &&
    !targetIsSelf &&
    !capabilitiesAreSubset(input.targetCapabilities, input.actorCapabilities)
  ) {
    return { allowed: false, reason: "privilege_escalation" };
  }

  if (input.mutation.action === "suspend") {
    if (input.targetStatus !== "active") {
      return { allowed: false, reason: "invalid_transition" };
    }
    if (targetIsSelf) {
      return { allowed: false, reason: "self_suspension" };
    }
    if (targetIsAdministrator && input.activeAdministratorCount <= 1) {
      return { allowed: false, reason: "last_administrator" };
    }
    return { allowed: true };
  }

  if (input.mutation.action === "reactivate") {
    if (input.targetStatus !== "suspended") {
      return { allowed: false, reason: "invalid_transition" };
    }
    if (
      !capabilitiesAreSubset(input.targetCapabilities, input.actorCapabilities)
    ) {
      return { allowed: false, reason: "privilege_escalation" };
    }
    return { allowed: true };
  }

  if (input.mutation.action === "scope_update") {
    if (!["active", "suspended"].includes(input.targetStatus)) {
      return { allowed: false, reason: "invalid_transition" };
    }
    if (
      input.currentRoleKey === "administrator" &&
      input.mutation.accessLevel !== "account"
    ) {
      return { allowed: false, reason: "privilege_escalation" };
    }
    return { allowed: true };
  }

  const proposed = input.proposedCapabilities ?? [];
  if (!["active", "suspended"].includes(input.targetStatus)) {
    return { allowed: false, reason: "invalid_transition" };
  }
  if (input.currentRoleKey === input.mutation.roleKey) {
    return { allowed: false, reason: "no_change" };
  }
  if (!capabilitiesAreSubset(proposed, input.actorCapabilities)) {
    return { allowed: false, reason: "privilege_escalation" };
  }
  if (
    input.targetStatus === "active" &&
    targetIsAdministrator &&
    !proposed.includes("account.members.manage") &&
    input.activeAdministratorCount <= 1
  ) {
    return { allowed: false, reason: "last_administrator" };
  }
  return { allowed: true };
}

export function partnerMemberRevision(row: MembershipRow): string {
  return JSON.stringify({
    id: row.id,
    accountId: row.partnerAccountId,
    partnerUserId: row.partnerUserId,
    roleTemplateId: row.roleTemplateId,
    roleKey: row.roleKey,
    status: row.status,
    capabilityGrants: row.capabilityGrants,
    capabilityDenies: row.capabilityDenies,
    persona: row.persona,
    accessLevel: row.accessLevel,
    accessScope: row.accessScope,
    isDefault: row.isDefault,
    invitedAt: row.invitedAt.toISOString(),
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    suspendedAt: row.suspendedAt?.toISOString() ?? null,
    removedAt: row.removedAt?.toISOString() ?? null,
    migrationReviewStatus: row.migrationReviewStatus,
    migrationLegacyRoleKey: row.migrationLegacyRoleKey,
    migrationReviewedByTeamMemberId: row.migrationReviewedByTeamMemberId,
    migrationReviewedAt: row.migrationReviewedAt?.toISOString() ?? null,
    migrationReviewNote: row.migrationReviewNote,
    updatedAt: row.updatedAt.toISOString(),
  });
}

function memberDto(input: {
  row: MembershipRow;
  actorPartnerUserId: string;
  actorCapabilities: readonly PartnerCapability[];
  activeAdministratorCount: number;
}): Record<string, unknown> {
  const capabilities = membershipCapabilities(input.row);
  const targetIsSelf = input.row.partnerUserId === input.actorPartnerUserId;
  const actorCanManage = input.actorCapabilities.includes(
    "account.members.manage",
  );
  const canControlTarget =
    actorCanManage &&
    (targetIsSelf ||
      capabilitiesAreSubset(capabilities, input.actorCapabilities));
  const isLastAdministrator =
    input.row.status === "active" &&
    capabilities.includes("account.members.manage") &&
    input.activeAdministratorCount <= 1;
  const roleCanChange =
    ["active", "suspended"].includes(input.row.status) && canControlTarget;
  const scopeCanChange =
    ["active", "suspended"].includes(input.row.status) &&
    canControlTarget &&
    isPartnerLaunchRoleKey(input.row.roleKey);
  const canSuspend =
    input.row.status === "active" &&
    !targetIsSelf &&
    canControlTarget &&
    !isLastAdministrator;
  const canReactivate =
    actorCanManage &&
    input.row.status === "suspended" &&
    capabilitiesAreSubset(capabilities, input.actorCapabilities);

  return {
    id: input.row.id,
    user: {
      name: input.row.userName.slice(0, 160),
      email: input.row.userEmail.slice(0, 320),
      active: input.row.userActive,
    },
    role: {
      key: input.row.roleKey,
      name: input.row.roleName ?? input.row.roleKey.replaceAll("_", " "),
      description: input.row.roleDescription,
    },
    status: input.row.status,
    persona: input.row.persona,
    accessLevel: input.row.accessLevel,
    currentUser: targetIsSelf,
    defaultAccount: input.row.isDefault,
    dates: {
      invitedAt: input.row.invitedAt.toISOString(),
      acceptedAt: input.row.acceptedAt?.toISOString() ?? null,
      suspendedAt: input.row.suspendedAt?.toISOString() ?? null,
      updatedAt: input.row.updatedAt.toISOString(),
    },
    allowedActions: [
      ...(roleCanChange ? ["role_update"] : []),
      ...(scopeCanChange ? ["scope_update"] : []),
      ...(canSuspend ? ["suspend"] : []),
      ...(canReactivate ? ["reactivate"] : []),
    ],
    etag: createPortalV2StrongEtag(partnerMemberRevision(input.row)),
  };
}

function roleDto(
  role: RoleRow,
  actorCapabilities: readonly PartnerCapability[],
): Record<string, unknown> | null {
  const capabilities = computePartnerCapabilities({
    roleCapabilities: role.capabilities,
  });
  if (!capabilitiesAreSubset(capabilities, actorCapabilities)) return null;
  return {
    key: role.key,
    name: role.name,
    description: role.description,
    system: role.isSystem,
  };
}

async function loadRowsForAccount(accountId: string): Promise<MembershipRow[]> {
  return getDb()
    .select(memberSelection())
    .from(partnerAccountMemberships)
    .innerJoin(
      partnerUsers,
      eq(partnerAccountMemberships.partnerUserId, partnerUsers.id),
    )
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
    .where(eq(partnerAccountMemberships.partnerAccountId, accountId))
    .orderBy(asc(partnerUsers.name), asc(partnerAccountMemberships.id));
}

function activeAdministratorCount(rows: readonly MembershipRow[]): number {
  return rows.filter(
    (row) =>
      row.status === "active" &&
      row.userActive &&
      membershipCapabilities(row).includes("account.members.manage"),
  ).length;
}

export async function listPartnerAccountMembers(input: {
  principal: PartnerPrincipal;
  filterHash: string;
  status: PartnerMemberStatusFilter;
  search: string | null;
  cursor: PartnerMemberCursor | null;
  limit: number;
}): Promise<{
  members: Record<string, unknown>[];
  roles: Record<string, unknown>[];
  next: { name: string; id: string } | null;
}> {
  const { accountId } = input.principal;
  if (!accountId) throw new TypeError("Partner account is required.");
  const db = getDb();
  const actorCapabilities = input.principal.capabilities;
  const allRows = await loadRowsForAccount(accountId);
  const administrators = activeAdministratorCount(allRows);
  const normalizedSearch = input.search?.toLowerCase() ?? null;
  const rows = await db
    .select(memberSelection())
    .from(partnerAccountMemberships)
    .innerJoin(
      partnerUsers,
      eq(partnerAccountMemberships.partnerUserId, partnerUsers.id),
    )
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
        eq(partnerAccountMemberships.partnerAccountId, accountId),
        input.status === "all"
          ? undefined
          : eq(partnerAccountMemberships.status, input.status),
        normalizedSearch
          ? or(
              ilike(partnerUsers.name, `%${normalizedSearch}%`),
              ilike(partnerUsers.email, `%${normalizedSearch}%`),
            )
          : undefined,
        input.cursor
          ? or(
              gt(partnerUsers.name, input.cursor.name),
              and(
                eq(partnerUsers.name, input.cursor.name),
                gt(partnerAccountMemberships.id, input.cursor.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(asc(partnerUsers.name), asc(partnerAccountMemberships.id))
    .limit(input.limit + 1);
  const hasMore = rows.length > input.limit;
  const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
  const last = hasMore ? pageRows.at(-1) : null;
  const roles = await db
    .select({
      id: partnerRoleTemplates.id,
      partnerAccountId: partnerRoleTemplates.partnerAccountId,
      key: partnerRoleTemplates.key,
      name: partnerRoleTemplates.name,
      description: partnerRoleTemplates.description,
      capabilities: partnerRoleTemplates.capabilities,
      isSystem: partnerRoleTemplates.isSystem,
    })
    .from(partnerRoleTemplates)
    .where(
      and(
        eq(partnerRoleTemplates.active, true),
        isNull(partnerRoleTemplates.partnerAccountId),
      ),
    )
    .orderBy(
      asc(partnerRoleTemplates.partnerAccountId),
      asc(partnerRoleTemplates.name),
      asc(partnerRoleTemplates.id),
    );

  const uniqueRoles = Array.from(
    roles
      .filter((role) => isPartnerLaunchRoleKey(role.key))
      .reduce((byKey, role) => {
        if (!byKey.has(role.key)) byKey.set(role.key, role);
        return byKey;
      }, new Map<string, RoleRow>())
      .values(),
  );

  return {
    members: pageRows.map((row) =>
      memberDto({
        row,
        actorPartnerUserId: input.principal.partnerUserId,
        actorCapabilities,
        activeAdministratorCount: administrators,
      }),
    ),
    roles: uniqueRoles
      .map((role) =>
        actorCapabilities.includes("account.members.manage")
          ? roleDto(role, actorCapabilities)
          : null,
      )
      .filter((role): role is Record<string, unknown> => Boolean(role)),
    next: last ? { name: last.userName, id: last.id } : null,
  };
}

export type StaffPartnerMemberMutation = Exclude<
  PartnerMemberMutation,
  { action: "suspend" } | { action: "reactivate" }
>;

export type StaffPartnerMemberMutationResult = {
  membershipId: string;
  partnerAccountId: string;
  partnerUserId: string;
  status: MembershipRow["status"];
  roleKey: string;
  accessLevel: MembershipRow["accessLevel"];
  accessScope: Record<string, unknown>;
  previousVersion: string;
  version: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
};

export type StaffPartnerMigrationReviewResult = {
  membershipId: string;
  partnerAccountId: string;
  partnerUserId: string;
  previousReviewStatus: MembershipRow["migrationReviewStatus"];
  migrationReviewStatus: MembershipRow["migrationReviewStatus"];
  legacyRoleKey: string | null;
  status: MembershipRow["status"];
  protectiveDeniesRemoved: string[];
  sessionsRevoked: number;
  previousVersion: string;
  version: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
};

export const MIGRATED_PARTNER_ROLE_PROTECTIVE_DENIES = Object.freeze({
  admin: Object.freeze(["account.security.manage", "payments.initiate"]),
  approver: Object.freeze([
    "payments.initiate",
    "reports.financial.export",
    "commercial.edit",
  ]),
  billing: Object.freeze([
    "approvals.read",
    "approvals.decide",
    "commercial.edit",
  ]),
} satisfies Record<string, readonly string[]>);

async function lockStaffManagedPartnerAccount(
  tx: TeamMutationTransaction,
  accountId: string,
): Promise<void> {
  const [account] = await tx
    .select({ id: partnerAccounts.id })
    .from(partnerAccounts)
    .where(eq(partnerAccounts.id, accountId))
    .for("update")
    .limit(1);
  if (!account) {
    throw new TeamMutationFailure(
      "invalid",
      "The partner account was not found.",
      { status: 404 },
    );
  }
}

async function loadStaffManagedMembershipRows(
  tx: TeamMutationTransaction,
  accountId: string,
): Promise<MembershipRow[]> {
  return tx
    .select(memberSelection())
    .from(partnerAccountMemberships)
    .innerJoin(
      partnerUsers,
      eq(partnerAccountMemberships.partnerUserId, partnerUsers.id),
    )
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
    .where(eq(partnerAccountMemberships.partnerAccountId, accountId));
}

function staffMemberNotFound(): never {
  throw new TeamMutationFailure(
    "invalid",
    "The membership was not found in that partner account.",
    { status: 404 },
  );
}

function assertStaffMemberCanBeChanged(target: MembershipRow): void {
  if (!(["active", "suspended"] as const).includes(target.status as never)) {
    throw new TeamMutationFailure(
      "conflict",
      "Only active or suspended memberships can be changed.",
    );
  }
  if (
    target.migrationReviewStatus === "pending" ||
    target.migrationReviewStatus === "quarantined"
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "Complete the migrated-membership security review before changing its role or scope.",
      {
        fieldErrors: {
          membershipId: "This migrated membership still requires review.",
        },
      },
    );
  }
}

async function resolveStaffDesiredScope(
  tx: TeamMutationTransaction,
  accountId: string,
  mutation: Extract<PartnerMemberMutation, { action: "scope_update" }>,
): Promise<{
  accessLevel: "account" | "scoped";
  locationIds: string[];
  propertyIds: string[];
  costCenterIds: string[];
}> {
  const locationIds = [
    ...new Set(mutation.locationIds.map((id) => id.toLowerCase())),
  ].sort();
  const costCenterIds = [
    ...new Set(mutation.costCenterIds.map((id) => id.toLowerCase())),
  ].sort();
  if (mutation.accessLevel === "account") {
    if (locationIds.length > 0 || costCenterIds.length > 0) {
      throw new TeamMutationFailure(
        "invalid",
        "Account-wide access cannot include scoped IDs.",
        {
          fieldErrors: {
            accessLevel:
              "Remove locations and cost centers for account-wide access.",
          },
        },
      );
    }
    return {
      accessLevel: "account",
      locationIds: [],
      propertyIds: [],
      costCenterIds: [],
    };
  }
  if (locationIds.length === 0 && costCenterIds.length === 0) {
    throw new TeamMutationFailure(
      "invalid",
      "Scoped access requires at least one active location or cost center.",
      { fieldErrors: { scope: "Choose an account-owned scope." } },
    );
  }
  const [locations, costCenters] = await Promise.all([
    locationIds.length
      ? tx
          .select({
            id: partnerAccountLocations.id,
            propertyId: partnerAccountLocations.propertyId,
          })
          .from(partnerAccountLocations)
          .where(
            and(
              eq(partnerAccountLocations.partnerAccountId, accountId),
              inArray(partnerAccountLocations.id, locationIds),
              eq(partnerAccountLocations.active, true),
            ),
          )
      : Promise.resolve([]),
    costCenterIds.length
      ? tx
          .select({ id: partnerAccountCostCenters.id })
          .from(partnerAccountCostCenters)
          .where(
            and(
              eq(partnerAccountCostCenters.partnerAccountId, accountId),
              inArray(partnerAccountCostCenters.id, costCenterIds),
              eq(partnerAccountCostCenters.active, true),
            ),
          )
      : Promise.resolve([]),
  ]);
  if (
    locations.length !== locationIds.length ||
    costCenters.length !== costCenterIds.length
  ) {
    throw new TeamMutationFailure(
      "invalid",
      "The requested scope contains a missing, inactive, or cross-account resource.",
      { fieldErrors: { scope: "Choose resources from this partner account." } },
    );
  }
  return {
    accessLevel: "scoped",
    locationIds,
    propertyIds: [
      ...new Set(
        locations.flatMap((location) =>
          location.propertyId ? [location.propertyId] : [],
        ),
      ),
    ].sort(),
    costCenterIds,
  };
}

/**
 * Staff adapter for the canonical partner-member domain. The caller owns the
 * transaction, idempotency record, and Team audit receipt; this service owns
 * tenant binding, role/scope validation, concurrency, and final-admin safety.
 */
export async function mutatePartnerAccountMemberAsStaff(
  tx: TeamMutationTransaction,
  input: {
    partnerAccountId: string;
    membershipId: string;
    mutation: StaffPartnerMemberMutation;
    expectedVersion: string;
    now?: Date;
  },
): Promise<StaffPartnerMemberMutationResult> {
  await lockStaffManagedPartnerAccount(tx, input.partnerAccountId);
  const rows = await loadStaffManagedMembershipRows(tx, input.partnerAccountId);
  const target = rows.find((row) => row.id === input.membershipId);
  if (!target) staffMemberNotFound();
  assertTeamMutationExpectedVersion(
    { expectedVersion: input.expectedVersion },
    target.updatedAt,
  );
  assertStaffMemberCanBeChanged(target);

  const targetCapabilities = membershipCapabilities(target);
  const administrators = activeAdministratorCount(rows);
  let nextRoleKey = target.roleKey;
  let nextRoleTemplateId = target.roleTemplateId;
  let nextAccessLevel = target.accessLevel;
  let nextAccessScope = target.accessScope;
  let desiredScope:
    | Awaited<ReturnType<typeof resolveStaffDesiredScope>>
    | undefined;

  if (input.mutation.action === "role_update") {
    if (!isPartnerLaunchRoleKey(input.mutation.roleKey)) {
      throw new TeamMutationFailure(
        "invalid",
        "Choose a supported account role.",
        {
          fieldErrors: { roleKey: "Choose one of the four launch roles." },
        },
      );
    }
    if (target.roleKey === input.mutation.roleKey) {
      throw new TeamMutationFailure(
        "conflict",
        "The membership already has that role.",
      );
    }
    const [role] = await tx
      .select({
        id: partnerRoleTemplates.id,
        key: partnerRoleTemplates.key,
        capabilities: partnerRoleTemplates.capabilities,
      })
      .from(partnerRoleTemplates)
      .where(
        and(
          eq(partnerRoleTemplates.key, input.mutation.roleKey),
          eq(partnerRoleTemplates.active, true),
          isNull(partnerRoleTemplates.partnerAccountId),
        ),
      )
      .limit(1);
    if (!role) {
      throw new TeamMutationFailure(
        "invalid",
        "That account role is unavailable.",
        {
          fieldErrors: { roleKey: "Refresh the available roles." },
        },
      );
    }
    const proposedCapabilities = computePartnerCapabilities({
      roleCapabilities: role.capabilities,
      grants: target.capabilityGrants,
      denies: target.capabilityDenies,
    });
    if (
      target.status === "active" &&
      target.userActive &&
      targetCapabilities.includes("account.members.manage") &&
      !proposedCapabilities.includes("account.members.manage") &&
      administrators <= 1
    ) {
      throw new TeamMutationFailure(
        "conflict",
        "Add or reactivate another account administrator before changing the final administrator's role.",
        {
          fieldErrors: {
            membershipId: "The final active administrator is protected.",
          },
        },
      );
    }
    if (
      proposedCapabilities.includes("account.members.manage") &&
      target.accessLevel !== "account"
    ) {
      throw new TeamMutationFailure(
        "conflict",
        "Give this member account-wide access before assigning the Administrator role.",
        {
          fieldErrors: { accessLevel: "Administrators must be account-wide." },
        },
      );
    }
    nextRoleKey = role.key;
    nextRoleTemplateId = role.id;
  } else {
    if (
      targetCapabilities.includes("account.members.manage") &&
      input.mutation.accessLevel !== "account"
    ) {
      throw new TeamMutationFailure(
        "conflict",
        "Account administrators cannot be restricted to a partial account scope.",
        {
          fieldErrors: { accessLevel: "Administrators must be account-wide." },
        },
      );
    }
    desiredScope = await resolveStaffDesiredScope(
      tx,
      input.partnerAccountId,
      input.mutation,
    );
    const currentScope = JSON.stringify({
      accessLevel: target.accessLevel,
      accessScope: target.accessScope,
    });
    const proposedScope = JSON.stringify({
      accessLevel: desiredScope.accessLevel,
      accessScope: {
        locationIds: desiredScope.locationIds,
        propertyIds: desiredScope.propertyIds,
        costCenterIds: desiredScope.costCenterIds,
      },
    });
    if (currentScope === proposedScope) {
      throw new TeamMutationFailure(
        "conflict",
        "The membership already has that scope.",
      );
    }
    nextAccessLevel = desiredScope.accessLevel;
    nextAccessScope = {
      locationIds: desiredScope.locationIds,
      propertyIds: desiredScope.propertyIds,
      costCenterIds: desiredScope.costCenterIds,
    };
  }

  const now = input.now ?? new Date();
  if (desiredScope) {
    await tx
      .delete(partnerMembershipLocationScopes)
      .where(
        and(
          eq(partnerMembershipLocationScopes.membershipId, target.id),
          eq(
            partnerMembershipLocationScopes.partnerAccountId,
            input.partnerAccountId,
          ),
        ),
      );
    await tx
      .delete(partnerMembershipCostCenterScopes)
      .where(
        and(
          eq(partnerMembershipCostCenterScopes.membershipId, target.id),
          eq(
            partnerMembershipCostCenterScopes.partnerAccountId,
            input.partnerAccountId,
          ),
        ),
      );
    if (desiredScope.locationIds.length > 0) {
      await tx.insert(partnerMembershipLocationScopes).values(
        desiredScope.locationIds.map((locationId) => ({
          membershipId: target.id,
          partnerAccountId: input.partnerAccountId,
          locationId,
        })),
      );
    }
    if (desiredScope.costCenterIds.length > 0) {
      await tx.insert(partnerMembershipCostCenterScopes).values(
        desiredScope.costCenterIds.map((costCenterId) => ({
          membershipId: target.id,
          partnerAccountId: input.partnerAccountId,
          costCenterId,
        })),
      );
    }
  }
  const [updated] = await tx
    .update(partnerAccountMemberships)
    .set({
      roleTemplateId: nextRoleTemplateId,
      roleKey: nextRoleKey,
      accessLevel: nextAccessLevel,
      accessScope: nextAccessScope,
      updatedAt: now,
    })
    .where(
      and(
        createPartnerMemberTargetCondition(
          input.partnerAccountId,
          input.membershipId,
        ),
        eq(partnerAccountMemberships.updatedAt, target.updatedAt),
      ),
    )
    .returning({ updatedAt: partnerAccountMemberships.updatedAt });
  if (!updated) {
    throw new TeamMutationFailure(
      "conflict",
      "The membership changed while this action was being saved. Refresh and try again.",
      { retryable: true },
    );
  }
  const previousVersion = target.updatedAt.toISOString();
  const version = updated.updatedAt.toISOString();
  return {
    membershipId: target.id,
    partnerAccountId: target.partnerAccountId,
    partnerUserId: target.partnerUserId,
    status: target.status,
    roleKey: nextRoleKey,
    accessLevel: nextAccessLevel,
    accessScope: nextAccessScope,
    previousVersion,
    version,
    before: {
      roleKey: target.roleKey,
      accessLevel: target.accessLevel,
      accessScope: target.accessScope,
      version: previousVersion,
    },
    after: {
      roleKey: nextRoleKey,
      accessLevel: nextAccessLevel,
      accessScope: nextAccessScope,
      version,
    },
  };
}

/** Reviews privilege-sensitive role mappings created by the launch migration. */
export async function reviewMigratedPartnerAccountMemberAsStaff(
  tx: TeamMutationTransaction,
  input: {
    partnerAccountId: string;
    membershipId: string;
    decision: "approve" | "quarantine";
    note: string;
    reviewedByTeamMemberId: string;
    expectedVersion: string;
    allowAdministratorRecovery: boolean;
    now?: Date;
  },
): Promise<StaffPartnerMigrationReviewResult> {
  await lockStaffManagedPartnerAccount(tx, input.partnerAccountId);
  const rows = await loadStaffManagedMembershipRows(tx, input.partnerAccountId);
  const target = rows.find((row) => row.id === input.membershipId);
  if (!target) staffMemberNotFound();
  assertTeamMutationExpectedVersion(
    { expectedVersion: input.expectedVersion },
    target.updatedAt,
  );
  if (target.migrationReviewStatus !== "pending") {
    throw new TeamMutationFailure(
      "conflict",
      "Only a pending migrated membership can be reviewed.",
    );
  }
  if (
    target.migrationLegacyRoleKey === "owner" &&
    !input.allowAdministratorRecovery
  ) {
    throw new TeamMutationFailure(
      "forbidden",
      "Only a Team Owner can approve a migrated account owner.",
    );
  }
  const targetCapabilities = membershipCapabilities(target);
  if (
    input.decision === "quarantine" &&
    target.status === "active" &&
    target.userActive &&
    targetCapabilities.includes("account.members.manage") &&
    activeAdministratorCount(rows) <= 1
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "Add or reactivate another account administrator before quarantining the final administrator.",
      {
        fieldErrors: {
          membershipId: "The final active administrator is protected.",
        },
      },
    );
  }

  const now = input.now ?? new Date();
  const protectiveDenies =
    target.migrationLegacyRoleKey &&
    target.migrationLegacyRoleKey in MIGRATED_PARTNER_ROLE_PROTECTIVE_DENIES
      ? MIGRATED_PARTNER_ROLE_PROTECTIVE_DENIES[
          target.migrationLegacyRoleKey as keyof typeof MIGRATED_PARTNER_ROLE_PROTECTIVE_DENIES
        ]
      : [];
  const protectiveSet = new Set(protectiveDenies);
  const nextCapabilityDenies =
    input.decision === "approve"
      ? target.capabilityDenies.filter(
          (capability) => !protectiveSet.has(capability),
        )
      : target.capabilityDenies;
  const removed = target.capabilityDenies.filter(
    (capability) => !nextCapabilityDenies.includes(capability),
  );
  const nextStatus: MembershipRow["status"] =
    input.decision === "quarantine" &&
    (target.status === "active" || target.status === "invited")
      ? "suspended"
      : target.status;
  const normalizeAdministratorScope =
    input.decision === "approve" &&
    targetCapabilities.includes("account.members.manage") &&
    target.accessLevel !== "account";
  if (normalizeAdministratorScope) {
    await tx
      .delete(partnerMembershipLocationScopes)
      .where(
        and(
          eq(partnerMembershipLocationScopes.membershipId, target.id),
          eq(
            partnerMembershipLocationScopes.partnerAccountId,
            input.partnerAccountId,
          ),
        ),
      );
    await tx
      .delete(partnerMembershipCostCenterScopes)
      .where(
        and(
          eq(partnerMembershipCostCenterScopes.membershipId, target.id),
          eq(
            partnerMembershipCostCenterScopes.partnerAccountId,
            input.partnerAccountId,
          ),
        ),
      );
  }
  const [updated] = await tx
    .update(partnerAccountMemberships)
    .set({
      migrationReviewStatus:
        input.decision === "approve" ? "approved" : "quarantined",
      migrationReviewedByTeamMemberId: input.reviewedByTeamMemberId,
      migrationReviewedAt: now,
      migrationReviewNote: input.note,
      capabilityDenies: nextCapabilityDenies,
      accessLevel: normalizeAdministratorScope ? "account" : target.accessLevel,
      accessScope: normalizeAdministratorScope ? {} : target.accessScope,
      status: nextStatus,
      acceptedAt:
        target.status === "invited" && input.decision === "quarantine"
          ? (target.acceptedAt ?? now)
          : target.acceptedAt,
      suspendedAt:
        nextStatus === "suspended"
          ? (target.suspendedAt ?? now)
          : target.suspendedAt,
      isDefault: input.decision === "quarantine" ? false : target.isDefault,
      updatedAt: now,
    })
    .where(
      and(
        createPartnerMemberTargetCondition(
          input.partnerAccountId,
          input.membershipId,
        ),
        eq(partnerAccountMemberships.migrationReviewStatus, "pending"),
        eq(partnerAccountMemberships.updatedAt, target.updatedAt),
      ),
    )
    .returning({
      status: partnerAccountMemberships.status,
      migrationReviewStatus: partnerAccountMemberships.migrationReviewStatus,
      updatedAt: partnerAccountMemberships.updatedAt,
    });
  if (!updated) {
    throw new TeamMutationFailure(
      "conflict",
      "The membership review changed while this action was being saved. Refresh and try again.",
      { retryable: true },
    );
  }
  const revokedSessions =
    input.decision === "quarantine"
      ? await tx
          .update(partnerSessions)
          .set({ revokedAt: now })
          .where(
            and(
              eq(partnerSessions.partnerUserId, target.partnerUserId),
              eq(
                partnerSessions.activePartnerAccountId,
                input.partnerAccountId,
              ),
              isNull(partnerSessions.revokedAt),
            ),
          )
          .returning({ id: partnerSessions.id })
      : [];
  const previousVersion = target.updatedAt.toISOString();
  const version = updated.updatedAt.toISOString();
  return {
    membershipId: target.id,
    partnerAccountId: target.partnerAccountId,
    partnerUserId: target.partnerUserId,
    previousReviewStatus: target.migrationReviewStatus,
    migrationReviewStatus: updated.migrationReviewStatus,
    legacyRoleKey: target.migrationLegacyRoleKey,
    status: updated.status,
    protectiveDeniesRemoved: removed,
    sessionsRevoked: revokedSessions.length,
    previousVersion,
    version,
    before: {
      migrationReviewStatus: target.migrationReviewStatus,
      status: target.status,
      capabilityDenies: target.capabilityDenies,
      accessLevel: target.accessLevel,
      accessScope: target.accessScope,
      version: previousVersion,
    },
    after: {
      migrationReviewStatus: updated.migrationReviewStatus,
      status: updated.status,
      capabilityDenies: nextCapabilityDenies,
      accessLevel: normalizeAdministratorScope ? "account" : target.accessLevel,
      accessScope: normalizeAdministratorScope ? {} : target.accessScope,
      version,
    },
  };
}

function policyFailure(
  reason: Exclude<
    PartnerMemberAdministrationDecision,
    { allowed: true }
  >["reason"],
): PortalV2StoredResult {
  if (reason === "privilege_escalation") {
    return { status: 403, body: { ok: false, error: "forbidden" } };
  }
  return {
    status: 409,
    body: {
      ok: false,
      error: "conflict",
      reason,
    },
  };
}

export async function mutatePartnerAccountMember(input: {
  principal: PartnerPrincipal;
  membershipId: string;
  mutation: PartnerMemberMutation;
  ifMatch: string | null;
  correlationId: string;
  idempotencyKeyHash: string;
}): Promise<PortalV2StoredResult> {
  const accountId = input.principal.accountId;
  const actorMembershipId = input.principal.membershipId;
  if (!accountId || !actorMembershipId) {
    return {
      status: 409,
      body: { ok: false, error: "legacy_scope_unavailable" },
    };
  }
  const db = getDb();
  return db.transaction(async (tx): Promise<PortalV2StoredResult> => {
    const [account] = await tx
      .select({
        id: partnerAccounts.id,
        portalAccessEnabled: partnerAccounts.portalAccessEnabled,
      })
      .from(partnerAccounts)
      .where(eq(partnerAccounts.id, accountId))
      .for("update")
      .limit(1);
    if (!account) {
      return { status: 404, body: { ok: false, error: "not_found" } };
    }
    if (!account.portalAccessEnabled) {
      return { status: 403, body: { ok: false, error: "forbidden" } };
    }

    const [targetBase] = await tx
      .select({ id: partnerAccountMemberships.id })
      .from(partnerAccountMemberships)
      .where(createPartnerMemberTargetCondition(accountId, input.membershipId))
      .for("update")
      .limit(1);
    if (!targetBase) {
      return { status: 404, body: { ok: false, error: "not_found" } };
    }

    const joinedRows = await tx
      .select(memberSelection())
      .from(partnerAccountMemberships)
      .innerJoin(
        partnerUsers,
        eq(partnerAccountMemberships.partnerUserId, partnerUsers.id),
      )
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
      .where(eq(partnerAccountMemberships.partnerAccountId, accountId));
    const target = joinedRows.find((row) => row.id === input.membershipId);
    const actor = joinedRows.find(
      (row) =>
        row.id === actorMembershipId &&
        row.partnerUserId === input.principal.partnerUserId &&
        row.status === "active" &&
        row.accessLevel === "account" &&
        row.userActive,
    );
    if (!target) {
      return { status: 404, body: { ok: false, error: "not_found" } };
    }
    const actorCapabilities = actor ? membershipCapabilities(actor) : [];
    if (!actorCapabilities.includes("account.members.manage")) {
      return { status: 403, body: { ok: false, error: "forbidden" } };
    }

    const precondition = evaluatePortalV2RevisionPrecondition({
      ifMatch: input.ifMatch,
      currentRevision: partnerMemberRevision(target),
      correlationId: input.correlationId,
    });
    if (!precondition.ok) {
      return {
        status: precondition.response.status,
        body: { ...precondition.response.body },
        headers: { ETag: precondition.currentEtag },
      };
    }

    let desiredRole: RoleRow | null = null;
    let proposedCapabilities: PartnerCapability[] | undefined;
    let desiredScope:
      | {
          accessLevel: "account" | "scoped";
          locationIds: string[];
          propertyIds: string[];
          costCenterIds: string[];
        }
      | undefined;
    if (input.mutation.action === "role_update") {
      if (!isPartnerLaunchRoleKey(input.mutation.roleKey)) {
        return {
          status: 422,
          body: {
            ok: false,
            error: "invalid_fields",
            fieldErrors: { roleKey: "Choose one of the four account roles." },
          },
        };
      }
      const [role] = await tx
        .select({
          id: partnerRoleTemplates.id,
          partnerAccountId: partnerRoleTemplates.partnerAccountId,
          key: partnerRoleTemplates.key,
          name: partnerRoleTemplates.name,
          description: partnerRoleTemplates.description,
          capabilities: partnerRoleTemplates.capabilities,
          isSystem: partnerRoleTemplates.isSystem,
        })
        .from(partnerRoleTemplates)
        .where(
          and(
            eq(partnerRoleTemplates.key, input.mutation.roleKey),
            eq(partnerRoleTemplates.active, true),
            isNull(partnerRoleTemplates.partnerAccountId),
          ),
        )
        .orderBy(asc(partnerRoleTemplates.partnerAccountId))
        .limit(1);
      if (!role) {
        return {
          status: 422,
          body: {
            ok: false,
            error: "invalid_fields",
            fieldErrors: { roleKey: "Choose an available account role." },
          },
        };
      }
      desiredRole = role;
      proposedCapabilities = computePartnerCapabilities({
        roleCapabilities: role.capabilities,
        grants: target.capabilityGrants,
        denies: target.capabilityDenies,
      });
    }

    if (input.mutation.action === "scope_update") {
      const locationIds = [
        ...new Set(input.mutation.locationIds.map((id) => id.toLowerCase())),
      ].sort();
      const costCenterIds = [
        ...new Set(input.mutation.costCenterIds.map((id) => id.toLowerCase())),
      ].sort();
      if (input.mutation.accessLevel === "account") {
        if (locationIds.length > 0 || costCenterIds.length > 0) {
          return {
            status: 422,
            body: {
              ok: false,
              error: "invalid_fields",
              fieldErrors: {
                accessLevel: "Account-wide access cannot include scoped IDs.",
              },
            },
          };
        }
        desiredScope = {
          accessLevel: "account",
          locationIds: [],
          propertyIds: [],
          costCenterIds: [],
        };
      } else {
        if (locationIds.length === 0 && costCenterIds.length === 0) {
          return {
            status: 422,
            body: {
              ok: false,
              error: "invalid_fields",
              fieldErrors: {
                scope: "Choose at least one active location or cost center.",
              },
            },
          };
        }
        const [locations, costCenters] = await Promise.all([
          locationIds.length
            ? tx
                .select({
                  id: partnerAccountLocations.id,
                  propertyId: partnerAccountLocations.propertyId,
                })
                .from(partnerAccountLocations)
                .where(
                  and(
                    eq(partnerAccountLocations.partnerAccountId, accountId),
                    inArray(partnerAccountLocations.id, locationIds),
                    eq(partnerAccountLocations.active, true),
                  ),
                )
            : Promise.resolve([]),
          costCenterIds.length
            ? tx
                .select({ id: partnerAccountCostCenters.id })
                .from(partnerAccountCostCenters)
                .where(
                  and(
                    eq(partnerAccountCostCenters.partnerAccountId, accountId),
                    inArray(partnerAccountCostCenters.id, costCenterIds),
                    eq(partnerAccountCostCenters.active, true),
                  ),
                )
            : Promise.resolve([]),
        ]);
        if (
          locations.length !== locationIds.length ||
          costCenters.length !== costCenterIds.length
        ) {
          return {
            status: 422,
            body: {
              ok: false,
              error: "invalid_fields",
              fieldErrors: {
                scope:
                  "Choose active locations and cost centers from this account.",
              },
            },
          };
        }
        desiredScope = {
          accessLevel: "scoped",
          locationIds,
          propertyIds: [
            ...new Set(
              locations.flatMap((location) =>
                location.propertyId ? [location.propertyId] : [],
              ),
            ),
          ].sort(),
          costCenterIds,
        };
      }
    }

    if (input.mutation.action === "reactivate" && !target.userActive) {
      return {
        status: 409,
        body: {
          ok: false,
          error: "conflict",
          reason: "global_identity_inactive",
        },
      };
    }

    const administrators = activeAdministratorCount(joinedRows);
    const decision = evaluatePartnerMemberAdministration({
      actorPartnerUserId: actor!.partnerUserId,
      actorCapabilities,
      targetPartnerUserId: target.partnerUserId,
      targetStatus: target.status,
      targetCapabilities: membershipCapabilities(target),
      activeAdministratorCount: administrators,
      mutation: input.mutation,
      proposedCapabilities,
      currentRoleKey: target.roleKey,
    });
    if (!decision.allowed) return policyFailure(decision.reason);

    const now = new Date();
    if (input.mutation.action === "role_update" && desiredRole) {
      await tx
        .update(partnerAccountMemberships)
        .set({
          roleTemplateId: desiredRole.id,
          roleKey: desiredRole.key,
          updatedAt: now,
        })
        .where(createPartnerMemberTargetCondition(accountId, target.id));
    } else if (input.mutation.action === "scope_update" && desiredScope) {
      await tx
        .delete(partnerMembershipLocationScopes)
        .where(
          and(
            eq(partnerMembershipLocationScopes.membershipId, target.id),
            eq(partnerMembershipLocationScopes.partnerAccountId, accountId),
          ),
        );
      await tx
        .delete(partnerMembershipCostCenterScopes)
        .where(
          and(
            eq(partnerMembershipCostCenterScopes.membershipId, target.id),
            eq(partnerMembershipCostCenterScopes.partnerAccountId, accountId),
          ),
        );
      if (desiredScope.locationIds.length > 0) {
        await tx.insert(partnerMembershipLocationScopes).values(
          desiredScope.locationIds.map((locationId) => ({
            membershipId: target.id,
            partnerAccountId: accountId,
            locationId,
          })),
        );
      }
      if (desiredScope.costCenterIds.length > 0) {
        await tx.insert(partnerMembershipCostCenterScopes).values(
          desiredScope.costCenterIds.map((costCenterId) => ({
            membershipId: target.id,
            partnerAccountId: accountId,
            costCenterId,
          })),
        );
      }
      await tx
        .update(partnerAccountMemberships)
        .set({
          accessLevel: desiredScope.accessLevel,
          accessScope: {
            locationIds: desiredScope.locationIds,
            propertyIds: desiredScope.propertyIds,
            costCenterIds: desiredScope.costCenterIds,
          },
          updatedAt: now,
        })
        .where(createPartnerMemberTargetCondition(accountId, target.id));
    } else if (input.mutation.action === "suspend") {
      await tx
        .update(partnerAccountMemberships)
        .set({
          status: "suspended",
          isDefault: false,
          suspendedAt: now,
          updatedAt: now,
        })
        .where(createPartnerMemberTargetCondition(accountId, target.id));
    } else {
      await tx
        .update(partnerAccountMemberships)
        .set({
          status: "active",
          isDefault: false,
          suspendedAt: null,
          removedAt: null,
          updatedAt: now,
        })
        .where(createPartnerMemberTargetCondition(accountId, target.id));
    }

    await tx.insert(auditLogs).values({
      actorType: "human",
      actorId: input.principal.partnerUserId,
      actorLabel: input.principal.email,
      actorRole: actor!.roleKey,
      sessionId: input.principal.session.id,
      authMethod: "partner_session",
      correlationId: input.correlationId,
      requiredPermissions: ["account.members.manage"],
      outcome: "succeeded",
      surface: "partner_portal_v2",
      idempotencyKeyHash: input.idempotencyKeyHash,
      action: `partner.account_member.${input.mutation.action}`,
      entityType: "partner_account_membership",
      entityId: target.id,
      meta: {
        partnerAccountId: accountId,
        previousRoleKey: target.roleKey,
        nextRoleKey:
          input.mutation.action === "role_update"
            ? input.mutation.roleKey
            : target.roleKey,
        previousStatus: target.status,
        nextStatus:
          input.mutation.action === "suspend"
            ? "suspended"
            : input.mutation.action === "reactivate"
              ? "active"
              : target.status,
      },
      createdAt: now,
    });

    const [updated] = await tx
      .select(memberSelection())
      .from(partnerAccountMemberships)
      .innerJoin(
        partnerUsers,
        eq(partnerAccountMemberships.partnerUserId, partnerUsers.id),
      )
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
      .where(createPartnerMemberTargetCondition(accountId, target.id))
      .limit(1);
    if (!updated) {
      throw new Error("Updated partner membership could not be reloaded.");
    }
    const nextAdministrators = activeAdministratorCount(
      joinedRows.map((row) => (row.id === updated.id ? updated : row)),
    );
    const dto = memberDto({
      row: updated,
      actorPartnerUserId: input.principal.partnerUserId,
      actorCapabilities,
      activeAdministratorCount: nextAdministrators,
    });
    return {
      status: 200,
      body: { ok: true, member: dto },
      headers: {
        ETag: createPortalV2StrongEtag(partnerMemberRevision(updated)),
      },
    };
  });
}
