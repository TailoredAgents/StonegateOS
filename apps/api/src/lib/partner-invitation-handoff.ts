import { createHash } from "node:crypto";

/** Domain-separated from the random invitation credential; never persisted raw. */
export function derivePartnerInvitationActivationToken(
  invitationToken: string,
): string {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(invitationToken))
    throw new TypeError("invalid_invitation_token");
  return createHash("sha256")
    .update("stonegate:partner-invitation-activation:v1\0", "utf8")
    .update(invitationToken, "utf8")
    .digest("base64url");
}
