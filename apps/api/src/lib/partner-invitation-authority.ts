import { and, eq, isNull, or } from "drizzle-orm";
import {
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
  teamMembers,
  teamRoles,
} from "@/db";
import { computePartnerCapabilities } from "./partner-account-authorization";
import {
  computeEffectivePermissions,
  permissionMatches,
  restrictOwnerOnlyPermissionsForRole,
} from "./permissions";
import type { TeamMutationTransaction } from "./team-mutation";

export async function loadPartnerStaffInvitationAuthority(
  tx: TeamMutationTransaction,
  teamMemberId: string,
  required = ["partners.invitations.send"],
) {
  const [member] = await tx
    .select({
      id: teamMembers.id,
      active: teamMembers.active,
      email: teamMembers.email,
      roleSlug: teamRoles.slug,
      rolePermissions: teamRoles.permissions,
      grant: teamMembers.permissionsGrant,
      deny: teamMembers.permissionsDeny,
    })
    .from(teamMembers)
    .innerJoin(teamRoles, eq(teamMembers.roleId, teamRoles.id))
    .where(eq(teamMembers.id, teamMemberId))
    .for("share")
    .limit(1);
  if (!member?.active) return null;
  const permissions = restrictOwnerOnlyPermissionsForRole(
    member.roleSlug,
    computeEffectivePermissions(member),
  );
  if (
    !required.every((requiredPermission) =>
      permissions.some((granted) =>
        permissionMatches(granted, requiredPermission),
      ),
    )
  )
    return null;
  return member;
}

/** Rechecked at delivery, invitation consumption and password completion. */
export async function loadPartnerInvitationIssuer(
  tx: TeamMutationTransaction,
  input: {
    accountId: string;
    membershipId: string | null;
    teamMemberId: string | null;
    roleCapabilities: readonly string[];
  },
): Promise<{ partnerUserId: string | null } | null> {
  if (Boolean(input.membershipId) === Boolean(input.teamMemberId)) return null;
  if (input.teamMemberId) {
    return (await loadPartnerStaffInvitationAuthority(tx, input.teamMemberId))
      ? { partnerUserId: null }
      : null;
  }
  const [issuer] = await tx
    .select({
      partnerUserId: partnerAccountMemberships.partnerUserId,
      status: partnerAccountMemberships.status,
      accessLevel: partnerAccountMemberships.accessLevel,
      roleKey: partnerAccountMemberships.roleKey,
      grants: partnerAccountMemberships.capabilityGrants,
      denies: partnerAccountMemberships.capabilityDenies,
      roleCapabilities: partnerRoleTemplates.capabilities,
      roleActive: partnerRoleTemplates.active,
      identityActive: partnerUsers.active,
      identityStatus: partnerUsers.identityStatus,
    })
    .from(partnerAccountMemberships)
    .innerJoin(
      partnerUsers,
      eq(partnerAccountMemberships.partnerUserId, partnerUsers.id),
    )
    .innerJoin(
      partnerRoleTemplates,
      and(
        eq(partnerAccountMemberships.roleTemplateId, partnerRoleTemplates.id),
        or(
          isNull(partnerRoleTemplates.partnerAccountId),
          eq(partnerRoleTemplates.partnerAccountId, input.accountId),
        ),
      ),
    )
    .where(
      and(
        eq(partnerAccountMemberships.id, input.membershipId!),
        eq(partnerAccountMemberships.partnerAccountId, input.accountId),
      ),
    )
    .for("share")
    .limit(1);
  if (
    !issuer ||
    issuer.status !== "active" ||
    issuer.accessLevel !== "account" ||
    issuer.roleKey !== "administrator" ||
    !issuer.roleActive ||
    !issuer.identityActive ||
    issuer.identityStatus !== "active"
  )
    return null;
  const capabilities = computePartnerCapabilities({
    roleCapabilities: issuer.roleCapabilities ?? [],
    grants: issuer.grants,
    denies: issuer.denies,
  });
  if (
    !capabilities.includes("account.members.manage") ||
    !computePartnerCapabilities({
      roleCapabilities: input.roleCapabilities,
    }).every((capability) => capabilities.includes(capability))
  )
    return null;
  return { partnerUserId: issuer.partnerUserId };
}

export async function validatePartnerInvitationActivationAuthority(
  tx: TeamMutationTransaction,
  input: {
    invitationId: string | null;
    invitationGeneration: number | null;
    accountId: string;
    membershipId: string;
  },
): Promise<boolean> {
  if (!input.invitationId)
    return (
      input.invitationGeneration === null ||
      input.invitationGeneration === undefined
    );
  const [row] = await tx
    .select({
      invitation: partnerAccountInvitations,
      role: partnerRoleTemplates,
      enabled: partnerAccounts.portalAccessEnabled,
      lifecycle: partnerAccounts.portalLifecycleStatus,
    })
    .from(partnerAccountInvitations)
    .innerJoin(
      partnerAccounts,
      eq(partnerAccountInvitations.partnerAccountId, partnerAccounts.id),
    )
    .innerJoin(
      partnerRoleTemplates,
      eq(partnerAccountInvitations.roleTemplateId, partnerRoleTemplates.id),
    )
    .where(
      and(
        eq(partnerAccountInvitations.id, input.invitationId),
        eq(partnerAccountInvitations.partnerAccountId, input.accountId),
      ),
    )
    .limit(1);
  if (
    !row ||
    !row.enabled ||
    row.lifecycle !== "active" ||
    row.invitation.activatedAt ||
    row.invitation.status !== "accepted" ||
    row.invitation.generation !== input.invitationGeneration ||
    row.invitation.acceptedMembershipId !== input.membershipId ||
    !row.role.active ||
    row.role.key !== row.invitation.roleKey ||
    row.role.version !== row.invitation.roleTemplateVersion ||
    row.role.partnerAccountId !== null
  )
    return false;
  const [membership] = await tx
    .select({
      roleId: partnerAccountMemberships.roleTemplateId,
      roleKey: partnerAccountMemberships.roleKey,
      access: partnerAccountMemberships.accessLevel,
    })
    .from(partnerAccountMemberships)
    .where(
      and(
        eq(partnerAccountMemberships.id, input.membershipId),
        eq(partnerAccountMemberships.partnerAccountId, input.accountId),
      ),
    )
    .limit(1);
  if (
    !membership ||
    membership.roleId !== row.role.id ||
    membership.roleKey !== row.invitation.roleKey ||
    membership.access !== row.invitation.accessLevel
  )
    return false;
  const [invitedLocations, memberLocations, invitedCosts, memberCosts] =
    await Promise.all([
      tx
        .select({ id: partnerInvitationLocationScopes.locationId })
        .from(partnerInvitationLocationScopes)
        .innerJoin(
          partnerAccountLocations,
          and(
            eq(
              partnerInvitationLocationScopes.locationId,
              partnerAccountLocations.id,
            ),
            eq(partnerAccountLocations.partnerAccountId, input.accountId),
            eq(partnerAccountLocations.active, true),
          ),
        )
        .where(
          and(
            eq(
              partnerInvitationLocationScopes.invitationId,
              input.invitationId,
            ),
            eq(
              partnerInvitationLocationScopes.partnerAccountId,
              input.accountId,
            ),
          ),
        ),
      tx
        .select({ id: partnerMembershipLocationScopes.locationId })
        .from(partnerMembershipLocationScopes)
        .where(
          and(
            eq(
              partnerMembershipLocationScopes.membershipId,
              input.membershipId,
            ),
            eq(
              partnerMembershipLocationScopes.partnerAccountId,
              input.accountId,
            ),
          ),
        ),
      tx
        .select({ id: partnerInvitationCostCenterScopes.costCenterId })
        .from(partnerInvitationCostCenterScopes)
        .innerJoin(
          partnerAccountCostCenters,
          and(
            eq(
              partnerInvitationCostCenterScopes.costCenterId,
              partnerAccountCostCenters.id,
            ),
            eq(partnerAccountCostCenters.partnerAccountId, input.accountId),
            eq(partnerAccountCostCenters.active, true),
          ),
        )
        .where(
          and(
            eq(
              partnerInvitationCostCenterScopes.invitationId,
              input.invitationId,
            ),
            eq(
              partnerInvitationCostCenterScopes.partnerAccountId,
              input.accountId,
            ),
          ),
        ),
      tx
        .select({ id: partnerMembershipCostCenterScopes.costCenterId })
        .from(partnerMembershipCostCenterScopes)
        .where(
          and(
            eq(
              partnerMembershipCostCenterScopes.membershipId,
              input.membershipId,
            ),
            eq(
              partnerMembershipCostCenterScopes.partnerAccountId,
              input.accountId,
            ),
          ),
        ),
    ]);
  const ids = (rows: { id: string }[]) =>
    rows
      .map((entry) => entry.id)
      .sort()
      .join(",");
  if (
    ids(invitedLocations) !== ids(memberLocations) ||
    ids(invitedCosts) !== ids(memberCosts)
  )
    return false;
  const count = invitedLocations.length + invitedCosts.length;
  if (membership.access === "account" ? count !== 0 : count === 0) return false;
  return Boolean(
    await loadPartnerInvitationIssuer(tx, {
      accountId: input.accountId,
      membershipId: row.invitation.invitedByMembershipId,
      teamMemberId: row.invitation.invitedByTeamMemberId,
      roleCapabilities: row.role.capabilities,
    }),
  );
}
