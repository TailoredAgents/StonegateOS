import {
  arePartnerPortalEmbeddedAchPaymentsEnabled,
  arePartnerPortalEmbeddedPaymentsEnabled,
} from "@/lib/partner-portal-feature-flags";
import { createSquarePartnerEmbeddedPaymentProvider } from "@/lib/partner-embedded-payment-provider";
import { getPartnerAccountWorkflow } from "@/lib/partner-account-workflows";

export async function getPartnerPaymentReadiness(accountId: string) {
  const partialPayments = (await getPartnerAccountWorkflow(accountId))
    .partialPayments;
  if (!arePartnerPortalEmbeddedPaymentsEnabled(accountId))
    return { card: false, ach: false, partialPayments };
  try {
    // Configuration only: no provider request, token, merchant id or secret is exposed.
    const provider = createSquarePartnerEmbeddedPaymentProvider();
    return {
      card: true,
      ach:
        arePartnerPortalEmbeddedAchPaymentsEnabled(accountId) &&
        provider.webPayments.methods.ach,
      partialPayments,
    };
  } catch {
    return { card: false, ach: false, partialPayments };
  }
}
