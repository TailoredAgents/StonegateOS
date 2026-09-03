export type PartnerPublicHeaderAction = {
  kind: "sign_in" | "request_access";
  href: "/partners/login" | "/partners/request-access";
  label: "Sign in" | "Request access";
  analyticsKey: "landing_sign_in_header" | "landing_request_access_header";
};

const SIGN_IN_ACTION: PartnerPublicHeaderAction = {
  kind: "sign_in",
  href: "/partners/login",
  label: "Sign in",
  analyticsKey: "landing_sign_in_header",
};

const REQUEST_ACCESS_ACTION: PartnerPublicHeaderAction = {
  kind: "request_access",
  href: "/partners/request-access",
  label: "Request access",
  analyticsKey: "landing_request_access_header",
};

function normalizePartnerPathname(pathname: string | null): string {
  const path = (pathname ?? "/partners").split(/[?#]/u, 1)[0] ?? "/partners";
  return path.replace(/\/+$/u, "") || "/";
}

export function partnerPublicHeaderAction(
  pathname: string | null,
): PartnerPublicHeaderAction | null {
  const path = normalizePartnerPathname(pathname);

  const hiddenActionRoots = [
    "/partners/activate",
    "/partners/application",
    "/partners/confirm-email",
    "/partners/invitations",
    "/partners/login/mfa",
    "/partners/proof",
    "/partners/reset-password",
    "/partners/unavailable",
  ];
  if (
    hiddenActionRoots.some(
      (root) => path === root || path.startsWith(`${root}/`),
    )
  ) {
    return null;
  }
  if (path === "/partners/login") return REQUEST_ACCESS_ACTION;
  return SIGN_IN_ACTION;
}
