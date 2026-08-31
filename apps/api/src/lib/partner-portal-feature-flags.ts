import { isOperationalFeatureEnabled } from "@/lib/feature-flags";
import { getTeamOperationKillSwitch } from "@/lib/team-operation-kill-switch";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function configuredCanaryAccountIds(): ReadonlySet<string> {
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
  const canaryAccountIds = configuredCanaryAccountIds();
  if (canaryAccountIds.size === 0) return true;
  if (!partnerAccountId) return false;
  return canaryAccountIds.has(partnerAccountId.trim().toLowerCase());
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
