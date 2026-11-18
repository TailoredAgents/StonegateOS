import type { NextRequest } from "next/server";
import type { TeamPermission } from "@myst-os/sdk";

export type IntegrationContext = {
  integrationId: string;
  ownerId: string;
  label: string;
  permissions: TeamPermission[];
  mutationAllowed: boolean;
  ownerDelegated?: boolean;
};

// Only requests constructed by the in-process tool dispatcher can acquire this
// identity. No HTTP header, token, body field or public route can populate it.
const contexts = new WeakMap<NextRequest, IntegrationContext>();
export function bindIntegrationContext(
  request: NextRequest,
  context: IntegrationContext,
) {
  contexts.set(request, context);
}
export function getIntegrationContext(request: NextRequest) {
  return contexts.get(request);
}
