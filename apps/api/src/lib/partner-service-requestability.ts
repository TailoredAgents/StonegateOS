import { normalizePartnerAccountWorkflow } from "@/lib/partner-account-workflows";

export const GENERAL_PARTNER_SERVICE_REQUEST = "service_request";

/** Requestability does not confer pricing, capacity, or an instant confirmation. */
export function partnerServiceRequestability(
  config: unknown,
  serviceKey: string,
) {
  const workflow = normalizePartnerAccountWorkflow(config);
  return {
    disabled: workflow.disabledServiceKeys.includes(serviceKey),
    reviewAllowed:
      !workflow.disabledServiceKeys.includes(serviceKey) &&
      (serviceKey === GENERAL_PARTNER_SERVICE_REQUEST ||
        workflow.requestableServiceKeys.includes(serviceKey)),
  };
}
