export const TEAM_ACCESS_SAFETY_LOCK_KEY = "team_access_owner_safety_v1";

export type TeamMemberSecurityState = {
  active: boolean;
  roleSlug: string | null;
  permissionsDeny: readonly string[] | null | undefined;
};

function deniesOwnerAdministration(permission: string): boolean {
  const normalized = permission.trim();
  return (
    normalized === "*" ||
    normalized === "access.manage" ||
    normalized === "access.*"
  );
}

export function isActiveOwner(state: TeamMemberSecurityState): boolean {
  return (
    state.active &&
    state.roleSlug?.trim().toLowerCase() === "owner" &&
    !state.permissionsDeny?.some(deniesOwnerAdministration)
  );
}

export function isOwnerDemotion(
  current: TeamMemberSecurityState,
  next: TeamMemberSecurityState,
): boolean {
  return isActiveOwner(current) && !isActiveOwner(next);
}

export type TeamMemberSafetyConflict =
  | "cannot_deactivate_current_member"
  | "cannot_delete_current_member"
  | "cannot_remove_own_access"
  | "last_active_owner_required";

export function evaluateSelfAccessChange(input: {
  actorId: string;
  memberId: string;
  retainsAccess: boolean;
  hasOtherActiveOwner: boolean;
}): "cannot_remove_own_access" | null {
  if (
    input.actorId === input.memberId &&
    !input.retainsAccess &&
    !input.hasOtherActiveOwner
  ) {
    return "cannot_remove_own_access";
  }
  return null;
}

export function evaluateMemberSecurityChange(input: {
  actorId: string;
  memberId: string;
  current: TeamMemberSecurityState;
  next: TeamMemberSecurityState;
  hasOtherActiveOwner: boolean;
}): TeamMemberSafetyConflict | null {
  if (
    input.actorId === input.memberId &&
    input.current.active &&
    !input.next.active
  ) {
    return "cannot_deactivate_current_member";
  }
  if (
    isOwnerDemotion(input.current, input.next) &&
    !input.hasOtherActiveOwner
  ) {
    return "last_active_owner_required";
  }
  return null;
}

export function evaluateMemberDeletion(input: {
  actorId: string;
  memberId: string;
  current: TeamMemberSecurityState;
  hasOtherActiveOwner: boolean;
}): TeamMemberSafetyConflict | null {
  if (input.actorId === input.memberId) {
    return "cannot_delete_current_member";
  }
  if (isActiveOwner(input.current) && !input.hasOtherActiveOwner) {
    return "last_active_owner_required";
  }
  return null;
}

export function shouldRevokeMemberSessions(input: {
  current: {
    email: string | null;
    roleId: string | null;
    active: boolean;
  };
  next: {
    email: string | null;
    roleId: string | null;
    active: boolean;
  };
  phoneWasSubmitted: boolean;
  permissionsWereSubmitted: boolean;
}): boolean {
  return (
    input.current.email !== input.next.email ||
    input.current.roleId !== input.next.roleId ||
    input.current.active !== input.next.active ||
    input.phoneWasSubmitted ||
    input.permissionsWereSubmitted
  );
}
