export const CONTACT_RECOVERY_WINDOW_DAYS = 30;
const CONTACT_RECOVERY_WINDOW_MS =
  CONTACT_RECOVERY_WINDOW_DAYS * 24 * 60 * 60 * 1_000;

export function contactPurgeEligibleAt(deletedAt: Date): Date {
  return new Date(deletedAt.getTime() + CONTACT_RECOVERY_WINDOW_MS);
}

export type ContactSoftDeletePlan =
  | {
      kind: "delete";
      deletedAt: Date;
      purgeEligibleAt: Date;
    }
  | {
      kind: "already_deleted";
      deletedAt: Date;
      purgeEligibleAt: Date;
    };

export function planContactSoftDelete(
  contact: { deletedAt: Date | null; purgeEligibleAt: Date | null },
  now = new Date(),
): ContactSoftDeletePlan {
  if (contact.deletedAt) {
    return {
      kind: "already_deleted",
      deletedAt: contact.deletedAt,
      purgeEligibleAt:
        contact.purgeEligibleAt ?? contactPurgeEligibleAt(contact.deletedAt),
    };
  }
  return {
    kind: "delete",
    deletedAt: now,
    purgeEligibleAt: contactPurgeEligibleAt(now),
  };
}

export type ContactRestorePlan =
  | { kind: "restore"; restoredAt: Date; previousDeletedAt: Date }
  | { kind: "already_active" };

export function planContactRestore(
  contact: { deletedAt: Date | null },
  now = new Date(),
): ContactRestorePlan {
  return contact.deletedAt
    ? { kind: "restore", restoredAt: now, previousDeletedAt: contact.deletedAt }
    : { kind: "already_active" };
}

export type ContactPurgeEligibility =
  | {
      eligible: false;
      reason:
        | "not_deleted"
        | "invalid_retention_state"
        | "recovery_window_active";
      reviewAt: string | null;
    }
  | {
      eligible: true;
      reason: "recovery_window_elapsed";
      reviewAt: string;
    };

/**
 * Passing the recovery date only makes a contact eligible for a live
 * dependency review. It never authorizes deletion by itself; the maintenance
 * boundary must still prove permissions, version, preview, zero blocking
 * relationships, typed confirmation, idempotency, and transaction-bound
 * audit evidence.
 */
export function evaluateContactPurgeEligibility(
  contact: {
    deletedAt: Date | null;
    purgeEligibleAt: Date | null;
  },
  now = new Date(),
): ContactPurgeEligibility {
  if (contact.deletedAt === null) {
    return { eligible: false, reason: "not_deleted", reviewAt: null };
  }
  if (
    contact.purgeEligibleAt === null ||
    contact.purgeEligibleAt.getTime() <
      contactPurgeEligibleAt(contact.deletedAt).getTime()
  ) {
    return {
      eligible: false,
      reason: "invalid_retention_state",
      reviewAt: null,
    };
  }
  if (contact.purgeEligibleAt.getTime() > now.getTime()) {
    return {
      eligible: false,
      reason: "recovery_window_active",
      reviewAt: contact.purgeEligibleAt.toISOString(),
    };
  }
  return {
    eligible: true,
    reason: "recovery_window_elapsed",
    reviewAt: contact.purgeEligibleAt.toISOString(),
  };
}
