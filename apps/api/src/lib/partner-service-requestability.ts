import { normalizePartnerAccountWorkflow } from "@/lib/partner-account-workflows";
import { PARTNER_SERVICE_KEYS } from "@myst-os/pricing";

export const GENERAL_PARTNER_SERVICE_REQUEST = "service_request";

/** Requestability does not confer pricing, capacity, or an instant confirmation. */
export function partnerServiceRequestability(
  config: unknown,
  serviceKey: string,
  multiService = false,
) {
  const workflow = normalizePartnerAccountWorkflow(config);
  return {
    disabled: workflow.disabledServiceKeys.includes(serviceKey),
    reviewAllowed:
      !workflow.disabledServiceKeys.includes(serviceKey) &&
      (serviceKey === GENERAL_PARTNER_SERVICE_REQUEST ||
        (multiService &&
          (PARTNER_SERVICE_KEYS as readonly string[]).includes(serviceKey)) ||
        workflow.requestableServiceKeys.includes(serviceKey)),
  };
}
