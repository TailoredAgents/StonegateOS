import {
  PARTNER_ACTIVATION_TOKEN_COOKIE,
  PARTNER_EMAIL_CHANGE_TOKEN_COOKIE,
  PARTNER_INVITATION_TOKEN_COOKIE,
  PARTNER_PASSWORD_RESET_TOKEN_COOKIE,
} from "@/lib/partner-application-session";

export type PartnerLandingPortalState =
  | "absent"
  | "authenticated"
  | "unauthenticated"
  | "unavailable";

export function partnerLandingDestination(input: {
  applicationSessionPresent: boolean;
  portalState: PartnerLandingPortalState;
}): "/partners/application" | "/partners/overview" | null {
  if (input.portalState === "authenticated") return "/partners/overview";
  // Historical applicants can still open their status link directly. Their
  // cookie must not hijack the relationship entrance or access-help page.
  return null;
}

export type PartnerPurposeTokenPolicy = {
  cookieName: string;
  maximumAgeSeconds: number;
};

export function partnerPurposeTokenPolicy(
  pathname: string,
): PartnerPurposeTokenPolicy | null {
  if (pathname === "/partners/activate") {
    return {
      cookieName: PARTNER_ACTIVATION_TOKEN_COOKIE,
      maximumAgeSeconds: 24 * 60 * 60,
    };
  }
  if (pathname === "/partners/reset-password") {
    return {
      cookieName: PARTNER_PASSWORD_RESET_TOKEN_COOKIE,
      maximumAgeSeconds: 30 * 60,
    };
  }
  if (pathname === "/partners/confirm-email") {
    return {
      cookieName: PARTNER_EMAIL_CHANGE_TOKEN_COOKIE,
      maximumAgeSeconds: 30 * 60,
    };
  }
  if (pathname === "/partners/invitations/accept") {
    return {
      cookieName: PARTNER_INVITATION_TOKEN_COOKIE,
      maximumAgeSeconds: 7 * 24 * 60 * 60,
    };
  }
  return null;
}

export function isValidPartnerPurposeToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{32,256}$/u.test(value);
}
