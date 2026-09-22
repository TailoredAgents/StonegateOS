export const COOKIE_CONSENT_COOKIE = "sg_cookie_consent";
export const COOKIE_CONSENT_STORAGE_KEY = "sg:cookie-consent";
export const COOKIE_CONSENT_EVENT = "stonegate:cookie-consent";
export const COOKIE_SETTINGS_EVENT = "stonegate:cookie-settings";
export const COOKIE_CONSENT_MAX_AGE = 180 * 24 * 60 * 60;

export type CookiePreferences = {
  version: 1;
  analytics: boolean;
  advertising: boolean;
  updatedAt: number;
};

/** Shared by the browser and middleware. Missing, old, or malformed choices deny access. */
export function parseCookiePreferences(
  raw: string | null | undefined,
): CookiePreferences | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(decodeURIComponent(raw));
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    if (
      record["version"] !== 1 ||
      typeof record["analytics"] !== "boolean" ||
      typeof record["advertising"] !== "boolean" ||
      typeof record["updatedAt"] !== "number" ||
      !Number.isFinite(record["updatedAt"]) ||
      record["updatedAt"] > Date.now() ||
      Date.now() - record["updatedAt"] >= COOKIE_CONSENT_MAX_AGE * 1000
    )
      return null;
    return {
      version: 1,
      analytics: record["analytics"],
      advertising: record["advertising"],
      updatedAt: record["updatedAt"],
    };
  } catch {
    return null;
  }
}

export function getCookiePreferences(): CookiePreferences | null {
  if (typeof document === "undefined") return null;
  try {
    const prefix = `${COOKIE_CONSENT_COOKIE}=`;
    const raw = document.cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(prefix))
      ?.slice(prefix.length);
    return parseCookiePreferences(raw);
  } catch {
    return null;
  }
}

export function hasPrivacySignal(): boolean {
  if (typeof window === "undefined") return true;
  const nav = window.navigator as Navigator & {
    globalPrivacyControl?: boolean;
    msDoNotTrack?: string;
  };
  return (
    nav.globalPrivacyControl === true ||
    nav.doNotTrack === "1" ||
    nav.doNotTrack === "yes" ||
    nav.msDoNotTrack === "1"
  );
}

export function isAnalyticsAllowed(): boolean {
  return !hasPrivacySignal() && getCookiePreferences()?.analytics === true;
}

export function isAdvertisingAllowed(): boolean {
  return !hasPrivacySignal() && getCookiePreferences()?.advertising === true;
}

export function isPublicTrackingPath(pathname: string): boolean {
  return /^(?:\/(?:about|areas|blog|book|bookdemo|contact|contractors|estimate|gallery|pricing|privacy|reviews|service-agreement|services|terms)?\/?|\/(?:areas|blog|services)\/[a-z0-9-]+\/?)$/iu.test(
    pathname,
  );
}

export function setCookiePreferences(
  choice: Pick<CookiePreferences, "analytics" | "advertising">,
): void {
  if (typeof window === "undefined") return;
  const signal = hasPrivacySignal();
  const preferences: CookiePreferences = {
    version: 1,
    analytics: !signal && choice.analytics === true,
    advertising: !signal && choice.advertising === true,
    updatedAt: Date.now(),
  };
  const serialized = JSON.stringify(preferences);
  try {
    document.cookie = `${COOKIE_CONSENT_COOKIE}=${encodeURIComponent(serialized)}; Path=/; SameSite=Lax; Max-Age=${COOKIE_CONSENT_MAX_AGE}${window.location.protocol === "https:" ? "; Secure" : ""}`;
  } catch {
    // If cookies are unavailable, reads continue to deny optional tracking.
  }
  try {
    // This preference record also notifies other tabs; it is not an analytics identifier.
    window.localStorage.setItem(COOKIE_CONSENT_STORAGE_KEY, serialized);
  } catch {
    // The cookie remains authoritative when localStorage is unavailable.
  }
  window.dispatchEvent(new Event(COOKIE_CONSENT_EVENT));
}

export function openCookieSettings(): void {
  if (typeof window !== "undefined")
    window.dispatchEvent(new Event(COOKIE_SETTINGS_EVENT));
}

function removeStorage(storage: Storage, keys: string[]): void {
  for (const key of keys) storage.removeItem(key);
}

/** Only clear known optional data; authentication, booking and consent records stay intact. */
export function clearDisallowedCookieData(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const analytics = isAnalyticsAllowed();
  const advertising = isAdvertisingAllowed();
  try {
    if (!analytics) {
      removeStorage(window.localStorage, ["sg:session"]);
      removeStorage(window.sessionStorage, [
        "sg:visit",
        "sg:visit_last",
        "sg:visit_started",
      ]);
    }
    if (!advertising) {
      removeStorage(window.sessionStorage, ["sg:utm"]);
      removeStorage(window.localStorage, [
        "_gcl_ls",
        "lastExternalReferrer",
        "lastExternalReferrerTime",
      ]);
    }
  } catch {
    // Storage may be restricted by the browser.
  }
  try {
    const names = document.cookie
      .split(";")
      .map((part) => part.trim().split("=")[0] ?? "");
    const hostParts = window.location.hostname.split(".");
    const domains = [
      "",
      ...hostParts.map((_, index) => hostParts.slice(index).join(".")),
    ];
    for (const name of names) {
      const remove =
        (!analytics && /^(?:_ga(?:_|$)|_gid$|_gat)/u.test(name)) ||
        (!advertising &&
          /^(?:_gcl_|_fbp$|_fbc$|__obref$|__oppref$|myst_utm$)/u.test(name));
      if (!remove) continue;
      for (const domain of domains) {
        document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax${domain ? `; Domain=${domain}` : ""}${window.location.protocol === "https:" ? "; Secure" : ""}`;
      }
    }
  } catch {
    // Cookies belonging to another provider's domain can only be cleared by that provider/browser.
  }
}
