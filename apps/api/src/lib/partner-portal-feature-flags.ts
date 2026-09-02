import { isOperationalFeatureEnabled } from "@/lib/feature-flags";
import { getTeamOperationKillSwitch } from "@/lib/team-operation-kill-switch";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXPLICIT_TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

export function isPartnerPortalInternalTestModeEnabled(): boolean {
  const raw = process.env["PARTNER_PORTAL_INTERNAL_TEST_MODE"]
    ?.trim()
    .toLowerCase();
  return Boolean(raw && EXPLICIT_TRUE_VALUES.has(raw));
}

export function configuredPartnerPortalInternalAccountIds(): ReadonlySet<string> {
  // Account-cohort isolation is a staging/internal-test control only. A list by
  // itself has no effect, which prevents a stale production value from
  // accidentally creating the selected-partner canary superseded by the
  // single-cutover product decision.
  if (!isPartnerPortalInternalTestModeEnabled()) return new Set();
  const raw = process.env["PARTNER_PORTAL_V2_CANARY_ACCOUNT_IDS"] ?? "";
  return new Set(
    raw
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => UUID_PATTERN.test(value)),
  );
}

export function isPartnerPortalV2AccountEligible(
  partnerAccountId: string | null | undefined,
): boolean {
  const internalAccountIds = configuredPartnerPortalInternalAccountIds();
  if (internalAccountIds.size === 0) return true;
  if (!partnerAccountId) return false;
  return internalAccountIds.has(partnerAccountId.trim().toLowerCase());
}

export function arePartnerPortalV2ReadsEnabled(
  partnerAccountId?: string | null,
): boolean {
  return (
    isOperationalFeatureEnabled("PARTNER_PORTAL_V2_READS_ENABLED") &&
    isPartnerPortalV2AccountEligible(partnerAccountId)
  );
}

export function arePartnerPortalV2WritesEnabled(
  partnerAccountId?: string | null,
): boolean {
  return (
    arePartnerPortalV2ReadsEnabled(partnerAccountId) &&
    isOperationalFeatureEnabled("PARTNER_PORTAL_V2_WRITES_ENABLED")
  );
}

export function isPartnerPortalInstantConfirmationEnabled(
  partnerAccountId?: string | null,
): boolean {
  return (
    arePartnerPortalV2WritesEnabled(partnerAccountId) &&
    isOperationalFeatureEnabled("PARTNER_PORTAL_INSTANT_CONFIRMATION_ENABLED")
  );
}

export function arePartnerPortalEmbeddedPaymentsEnabled(
  partnerAccountId?: string | null,
): boolean {
  return (
    arePartnerPortalV2WritesEnabled(partnerAccountId) &&
    isOperationalFeatureEnabled("PARTNER_PORTAL_EMBEDDED_PAYMENTS_ENABLED") &&
    getTeamOperationKillSwitch(["payments.manage"]) === null
  );
}

export function arePartnerPortalEmbeddedAchPaymentsEnabled(
  partnerAccountId?: string | null,
): boolean {
  return (
    arePartnerPortalEmbeddedPaymentsEnabled(partnerAccountId) &&
    isOperationalFeatureEnabled("PARTNER_PORTAL_EMBEDDED_ACH_ENABLED")
  );
}

export function arePartnerPortalHostedPaymentsEnabled(
  partnerAccountId?: string | null,
): boolean {
  return (
    arePartnerPortalV2WritesEnabled(partnerAccountId) &&
    isOperationalFeatureEnabled("PARTNER_PORTAL_HOSTED_PAYMENTS_ENABLED") &&
    getTeamOperationKillSwitch(["payments.manage"]) === null
  );
}

/** @deprecated Call the hosted or embedded payment gate explicitly. */
export const arePartnerPortalPaymentsEnabled =
  arePartnerPortalHostedPaymentsEnabled;

export function arePartnerPortalOutboundNotificationsEnabled(
  partnerAccountId?: string | null,
): boolean {
  return (
    arePartnerPortalV2WritesEnabled(partnerAccountId) &&
    isOperationalFeatureEnabled("PARTNER_PORTAL_OUTBOUND_NOTIFICATIONS_ENABLED")
  );
}

/**
 * Access-application lifecycle messages are sent before an account exists, so
 * they cannot be evaluated against an account canary. Keep them fail-closed
 * behind the same global V2 read, write, and outbound-delivery switches.
 */
export function arePartnerPortalApplicantNotificationsEnabled(): boolean {
  return (
    isOperationalFeatureEnabled("PARTNER_PORTAL_V2_READS_ENABLED") &&
    isOperationalFeatureEnabled("PARTNER_PORTAL_V2_WRITES_ENABLED") &&
    isOperationalFeatureEnabled("PARTNER_PORTAL_OUTBOUND_NOTIFICATIONS_ENABLED")
  );
}

/** New purpose-bound credentials follow the normal operational rollout gate. */
export function arePartnerPurposeAuthTokensEnabled(): boolean {
  return isOperationalFeatureEnabled("PARTNER_PORTAL_PURPOSE_AUTH_ENABLED");
}

/**
 * Routine magic-link login is dormant, defaults off in every environment, and
 * may not be used as an authentication or rollback fallback. Purpose-bound
 * verification, activation, and reset links are governed separately and never
 * consult this flag.
 */
export function isPartnerRoutineMagicLinkLoginEnabled(): boolean {
  const raw = process.env["PARTNER_PORTAL_ROUTINE_MAGIC_LOGIN_ENABLED"]
    ?.trim()
    .toLowerCase();
  return Boolean(raw && EXPLICIT_TRUE_VALUES.has(raw));
}

export type PartnerPortalFeatureState = {
  eligible: boolean;
  reads: boolean;
  writes: boolean;
  instantConfirmation: boolean;
  hostedPayments: boolean;
  embeddedPayments: boolean;
  outboundNotifications: boolean;
};

export function getPartnerPortalFeatureState(
  partnerAccountId?: string | null,
): PartnerPortalFeatureState {
  return {
    eligible: isPartnerPortalV2AccountEligible(partnerAccountId),
    reads: arePartnerPortalV2ReadsEnabled(partnerAccountId),
    writes: arePartnerPortalV2WritesEnabled(partnerAccountId),
    instantConfirmation:
      isPartnerPortalInstantConfirmationEnabled(partnerAccountId),
    hostedPayments: arePartnerPortalHostedPaymentsEnabled(partnerAccountId),
    embeddedPayments: arePartnerPortalEmbeddedPaymentsEnabled(partnerAccountId),
    outboundNotifications:
      arePartnerPortalOutboundNotificationsEnabled(partnerAccountId),
  };
}
