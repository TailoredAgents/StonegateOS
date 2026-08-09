import type { TeamRequestPrincipal } from "@/lib/team-principal";
import { callAdminApiAs } from "./api";
import { retryOutboundMutationOnce } from "./outbound-mutation-transport";

type CallAdminApiInit = NonNullable<Parameters<typeof callAdminApiAs>[2]>;

export function createAdminMutationRequest(
  principal: TeamRequestPrincipal,
  path: string,
  init: CallAdminApiInit,
): () => Promise<Response> {
  return () => callAdminApiAs(principal, path, init);
}

/**
 * Retry one transport-level ambiguity with the exact request. Callers must use
 * this only for endpoints whose durable idempotency receipt is committed with
 * the mutation.
 */
export function callAdminMutationWithSafeReplay(
  principal: TeamRequestPrincipal,
  path: string,
  init: CallAdminApiInit,
): Promise<Response> {
  return retryOutboundMutationOnce(
    createAdminMutationRequest(principal, path, init),
  );
}
