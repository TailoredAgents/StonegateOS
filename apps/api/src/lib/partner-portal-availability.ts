import { eq } from "drizzle-orm";
import { getDb, partnerAccountSchedulingPolicies } from "@/db";
import type { PartnerPrincipal } from "@/lib/partner-account-authorization";
import {
  arePartnerPortalEmbeddedAchPaymentsEnabled,
  arePartnerPortalEmbeddedPaymentsEnabled,
  arePartnerPortalHostedPaymentsEnabled,
  arePartnerPortalV2ReadsEnabled,
  arePartnerPortalV2WritesEnabled,
  isPartnerPortalInstantConfirmationEnabled,
} from "@/lib/partner-portal-feature-flags";
import { isMediaStorageConfigured } from "@/lib/media-storage";
import { isPartnerDocumentScanningConfigured } from "@/lib/partner-document-scan";
import { createSquarePartnerEmbeddedPaymentProvider } from "@/lib/partner-embedded-payment-provider";
import { createSquarePartnerHostedCheckoutProvider } from "@/lib/partner-hosted-checkout-provider";

export type PartnerPortalAvailability = Readonly<{
  reads: boolean;
  writes: boolean;
  payments: Readonly<{ card: boolean; ach: boolean; hosted: boolean }>;
  uploads: Readonly<{ photos: boolean; documents: boolean }>;
  instantConfirmation: boolean;
}>;

/** Presentation hints only. Every action still checks its own current authority. */
export async function getPartnerPortalAvailability(
  principal: Pick<PartnerPrincipal, "accountId" | "capabilities">,
): Promise<PartnerPortalAvailability> {
  const accountId = principal.accountId;
  const reads = Boolean(accountId && arePartnerPortalV2ReadsEnabled(accountId));
  const writes = Boolean(
    accountId && arePartnerPortalV2WritesEnabled(accountId),
  );
  const payments = { card: false, ach: false, hosted: false };
  if (writes && principal.capabilities.includes("payments.initiate")) {
    if (arePartnerPortalEmbeddedPaymentsEnabled(accountId)) {
      try {
        const provider = createSquarePartnerEmbeddedPaymentProvider();
        payments.card = true;
        payments.ach =
          arePartnerPortalEmbeddedAchPaymentsEnabled(accountId) &&
          provider.webPayments.methods.ach;
      } catch {
        // An unconfigured optional provider must not prevent signing in.
      }
    }
    if (arePartnerPortalHostedPaymentsEnabled(accountId)) {
      try {
        createSquarePartnerHostedCheckoutProvider();
        payments.hosted = true;
      } catch {
        // The action remains unavailable until its provider is configured.
      }
    }
  }
  const photos =
    writes &&
    principal.capabilities.includes("media.upload") &&
    isMediaStorageConfigured();
  let instantConfirmation = false;
  if (
    accountId &&
    writes &&
    principal.capabilities.includes("bookings.create") &&
    isPartnerPortalInstantConfirmationEnabled(accountId)
  ) {
    const [policy] = await getDb()
      .select({
        enabled: partnerAccountSchedulingPolicies.instantConfirmationEnabled,
      })
      .from(partnerAccountSchedulingPolicies)
      .where(eq(partnerAccountSchedulingPolicies.partnerAccountId, accountId))
      .limit(1);
    instantConfirmation = policy?.enabled === true;
  }
  return {
    reads,
    writes,
    payments,
    uploads: {
      photos,
      documents: photos && isPartnerDocumentScanningConfigured(),
    },
    instantConfirmation,
  };
}
