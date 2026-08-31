import { and, asc, eq, gt, ilike, isNull, or } from "drizzle-orm";
import { z } from "zod";
import {
  auditLogs,
  getDb,
  partnerAccountMemberships,
  partnerAccounts,
  partnerRoleTemplates,
  partnerUsers,
} from "@/db";
import {
  computePartnerCapabilities,
  partnerAccessRequiresMfa,
  type PartnerCapability,
  type PartnerPrincipal,
} from "@/lib/partner-account-authorization";
import {
  createPortalV2StrongEtag,
  evaluatePortalV2RevisionPrecondition,
} from "@/lib/portal-v2-contract";
import type { PortalV2StoredResult } from "@/lib/partner-portal-v2-idempotency";

export const PartnerMemberMutationSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("role_update"),
      roleKey: z
        .string()
        .trim()
        .min(2)
        .max(64)
        .regex(/^[a-z][a-z0-9_]{1,63}$/u),
    })
    .strict(),
  z.object({ action: z.literal("suspend") }).strict(),
  z.object({ action: z.literal("reactivate") }).strict(),
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
  createdAt: Date;
  updatedAt: Date;
  userName: string;
  userEmail: string;
  userActive: boolean;
  userMfaRequired: boolean;
  userMfaEnrolledAt: Date | null;
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
    createdAt: partnerAccountMemberships.createdAt,
    updatedAt: partnerAccountMemberships.updatedAt,
    userName: partnerUsers.name,
    userEmail: partnerUsers.email,
    userActive: partnerUsers.active,
    userMfaRequired: partnerUsers.mfaRequired,
    userMfaEnrolledAt: partnerUsers.mfaEnrolledAt,
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
    security: {
      mfaRequired:
        input.row.userMfaRequired ||
        partnerAccessRequiresMfa({
          roleKey: input.row.roleKey,
          capabilities,
        }),
      mfaEnrolled: Boolean(input.row.userMfaEnrolledAt),
    },
    dates: {
      invitedAt: input.row.invitedAt.toISOString(),
      acceptedAt: input.row.acceptedAt?.toISOString() ?? null,
      suspendedAt: input.row.suspendedAt?.toISOString() ?? null,
      updatedAt: input.row.updatedAt.toISOString(),
    },
    allowedActions: [
      ...(roleCanChange ? ["role_update"] : []),
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
    mfaRequired: partnerAccessRequiresMfa({
      roleKey: role.key,
      capabilities,
    }),
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
        or(
          isNull(partnerRoleTemplates.partnerAccountId),
          eq(partnerRoleTemplates.partnerAccountId, accountId),
        ),
      ),
    )
    .orderBy(
      asc(partnerRoleTemplates.partnerAccountId),
      asc(partnerRoleTemplates.name),
      asc(partnerRoleTemplates.id),
    );

  const uniqueRoles = Array.from(
    roles
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
    if (input.mutation.action === "role_update") {
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
            or(
              isNull(partnerRoleTemplates.partnerAccountId),
              eq(partnerRoleTemplates.partnerAccountId, accountId),
            ),
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
