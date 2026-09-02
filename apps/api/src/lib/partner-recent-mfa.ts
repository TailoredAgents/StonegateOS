import type { NextRequest } from "next/server";
import {
  requirePartnerCapability,
  type PartnerCapability,
  type PartnerPrincipal,
  type PartnerPrincipalResult,
} from "@/lib/partner-account-authorization";

export const PARTNER_RECENT_MFA_WINDOW_MS = 15 * 60 * 1_000;
export const PARTNER_RECENT_MFA_CLOCK_SKEW_MS = 60 * 1_000;

export type PartnerMfaAssuranceContext = Readonly<{
  session: Readonly<
    Pick<PartnerPrincipal["session"], "assuranceLevel" | "mfaVerifiedAt">
  >;
}>;

/**
 * A privileged mutation needs a fresh authenticator proof, not merely an AAL2
 * label left on a long-lived session. A small future skew is tolerated for
 * independently clocked application/database hosts; larger or invalid times
 * fail closed.
 */
export function hasRecentPartnerMfa(
  context: PartnerMfaAssuranceContext,
  now = new Date(),
): boolean {
  const verifiedAt = context.session.mfaVerifiedAt;
  if (context.session.assuranceLevel !== "aal2" || !verifiedAt) return false;
  const ageMs = now.getTime() - verifiedAt.getTime();
  return (
    Number.isFinite(ageMs) &&
    ageMs >= -PARTNER_RECENT_MFA_CLOCK_SKEW_MS &&
    ageMs <= PARTNER_RECENT_MFA_WINDOW_MS
  );
}

export function requireRecentPartnerMfa(
  principal: PartnerPrincipal,
  now = new Date(),
): PartnerPrincipalResult {
  if (!hasRecentPartnerMfa(principal, now)) {
    return { ok: false, status: 403, error: "mfa_step_up_required" };
  }
  return { ok: true, principal };
}

export async function requireRecentPartnerMfaCapability(
  request: NextRequest,
  capability: PartnerCapability,
  now = new Date(),
): Promise<PartnerPrincipalResult> {
  const authorization = await requirePartnerCapability(request, capability);
  if (!authorization.ok) return authorization;
  return requireRecentPartnerMfa(authorization.principal, now);
}
