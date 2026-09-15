export type OpenAiAdsAttribution = {
  consentId?: string;
  oppref?: string;
  obref?: string;
  sourceUrl?: string;
  /** Effective measurement permission; does not imply an affirmative opt-in. */
  consent: boolean;
  capturedAt?: string;
};

type PixelQueue = ((...args: unknown[]) => void) & { q?: unknown[][] };

declare global {
  interface Window {
    oaiq?: PixelQueue;
  }
}

const ATTRIBUTION_KEY = "sg:openai-ads-attribution";
const CONSENT_KEY = "sg:openai-ads-consent";
const SUSPENDED_KEY = "sg:openai-ads-suspended";
const REVOCATIONS_KEY = "sg:openai-ads-pending-revocations";
const DENIED_CONTEXT_KEY = "sg:openai-ads-denied-context";
const REVOKED_CONTEXT_KEY = "sg:openai-ads-revoked-context";
export const OPENAI_ADS_CONSENT_EVENT = "stonegate:openai-ads-consent";
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
let memoryAttribution: OpenAiAdsAttribution | undefined;
let consentOverride: boolean | undefined;
let pendingConsentGrant = false;
let initialized = false;
const bookedEvents = new Set<string>();
const revocationsInFlight = new Set<string>();

function consentId(value: unknown): string | undefined {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
    ? value
    : undefined;
}

function pendingRevocations(): string[] {
  try {
    const parsed: unknown = JSON.parse(readStorage(REVOCATIONS_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => Boolean(consentId(id)))
      : [];
  } catch {
    return [];
  }
}

/** Retry persisted opt-outs on later public visits; booking submission never waits on ad transport. */
export function flushOpenAiAdsConsentRevocations(): void {
  const apiBase = process.env["NEXT_PUBLIC_API_BASE_URL"]
    ?.trim()
    .replace(/\/+$/u, "");
  if (!apiBase || typeof fetch !== "function") return;
  for (const id of pendingRevocations()) {
    if (revocationsInFlight.has(id)) continue;
    revocationsInFlight.add(id);
    void fetch(`${apiBase}/api/public/openai/ads/consent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ consentId: id, consent: false }),
      keepalive: true,
    })
      .then((response) => {
        if (response.ok) {
          writeStorage(
            REVOCATIONS_KEY,
            JSON.stringify(
              pendingRevocations().filter((pending) => pending !== id),
            ),
          );
          writeStorage(REVOKED_CONTEXT_KEY, id);
        }
      })
      .catch(() => {
        /* Persisted pending revocations retry on a later visit. */
      })
      .finally(() => {
        revocationsInFlight.delete(id);
      });
  }
}

function readAttribution(): OpenAiAdsAttribution | undefined {
  try {
    const raw = readStorage(ATTRIBUTION_KEY);
    return raw ? (JSON.parse(raw) as OpenAiAdsAttribution) : memoryAttribution;
  } catch {
    return memoryAttribution;
  }
}

function revokeAttribution(): string | undefined {
  const id =
    consentId(readAttribution()?.consentId) ??
    consentId(readStorage(DENIED_CONTEXT_KEY));
  if (id) {
    writeStorage(DENIED_CONTEXT_KEY, id);
    if (readStorage(REVOKED_CONTEXT_KEY) !== id)
      writeStorage(
        REVOCATIONS_KEY,
        JSON.stringify([...new Set([...pendingRevocations(), id])]),
      );
  }
  memoryAttribution = undefined;
  writeStorage(ATTRIBUTION_KEY, null);
  flushOpenAiAdsConsentRevocations();
  return id;
}

export function isOpenAiAdsPublicPath(pathname: string): boolean {
  return /^(?:\/(?:about|areas|blog|book|bookdemo|contact|contractors|estimate|gallery|pricing|privacy|reviews|service-agreement|services|terms)?\/?|\/(?:areas|blog|services)\/[a-z0-9-]+\/?)$/iu.test(
    pathname,
  );
}

export function sanitizeOpenAiAdsSourceUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (
      !/^https?:$/u.test(url.protocol) ||
      !isOpenAiAdsPublicPath(url.pathname)
    )
      return;
    // Origin matches the Pixel's source_url policy and cannot contain a private path or query.
    return url.origin;
  } catch {
    return;
  }
}

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* Storage restrictions must never block a booking. */
  }
}

function readCookie(name: string): string | undefined {
  try {
    const entry = document.cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${name}=`));
    return entry ? decodeURIComponent(entry.slice(name.length + 1)) : undefined;
  } catch {
    return;
  }
}

function identifier(raw: unknown): string | undefined {
  return typeof raw === "string" &&
    raw.length > 0 &&
    raw.length <= 2048 &&
    !/[\s\p{Cc}]/u.test(raw)
    ? raw
    : undefined;
}

export function hasOpenAiAdsPrivacySignal(): boolean {
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

export function isOpenAiAdsMeasurementAllowed(): boolean {
  if (typeof window === "undefined" || hasOpenAiAdsPrivacySignal())
    return false;
  const preference =
    consentOverride ??
    (readStorage(CONSENT_KEY) === "true"
      ? true
      : readStorage(CONSENT_KEY) === "false"
        ? false
        : undefined);
  if (preference === false) return false;
  // The SDK also persists explicit denials. A route suspension is temporary and distinct from a user's choice.
  if (
    !pendingConsentGrant &&
    readStorage(SUSPENDED_KEY) !== "true" &&
    (readStorage("oaiq_consent") === "false" ||
      readCookie("__oaiq_consent") === "false")
  )
    return false;
  return (
    preference === true ||
    process.env["NEXT_PUBLIC_OPENAI_ADS_REQUIRE_CONSENT"] !== "true"
  );
}

export function setOpenAiAdsMeasurementConsent(allowed: boolean): void {
  consentOverride = allowed;
  writeStorage(CONSENT_KEY, String(allowed));
  writeStorage(SUSPENDED_KEY, null);
  pendingConsentGrant = allowed && !hasOpenAiAdsPrivacySignal();
  if (!allowed || hasOpenAiAdsPrivacySignal()) {
    revokeAttribution();
  } else {
    writeStorage(DENIED_CONTEXT_KEY, null);
  }
  window.oaiq?.("consent", isOpenAiAdsMeasurementAllowed());
  if (window.oaiq && !window.oaiq.q) pendingConsentGrant = false;
  window.dispatchEvent(new Event(OPENAI_ADS_CONSENT_EVENT));
}

export function getOpenAiAdsAttribution(): OpenAiAdsAttribution | undefined {
  if (
    typeof window === "undefined" ||
    !process.env["NEXT_PUBLIC_OPENAI_ADS_PIXEL_ID"]?.trim()
  )
    return;
  if (!isOpenAiAdsPublicPath(window.location.pathname)) return;
  flushOpenAiAdsConsentRevocations();
  if (!isOpenAiAdsMeasurementAllowed()) {
    const revokedId = revokeAttribution();
    return { consent: false, ...(revokedId ? { consentId: revokedId } : {}) };
  }
  let previous = readAttribution();
  const previousTime = Date.parse(previous?.capturedAt ?? "");
  if (
    !Number.isFinite(previousTime) ||
    previousTime > Date.now() ||
    Date.now() - previousTime > MAX_AGE_MS
  )
    previous = undefined;
  const params = new URLSearchParams(window.location.search);
  const landingOppref = identifier(params.get("oppref"));
  if (landingOppref && landingOppref !== previous?.oppref) {
    // Replace an older channel's cookie on a new ChatGPT click, including old campaign IDs.
    const campaign: Record<string, string> = {
      source: "chatgpt",
      medium: "paid",
    };
    for (const field of [
      "source",
      "medium",
      "campaign",
      "term",
      "content",
    ] as const) {
      const value = params.get(`utm_${field}`)?.trim();
      if (value) campaign[field] = value.slice(0, 120);
    }
    try {
      document.cookie = `myst_utm=${encodeURIComponent(JSON.stringify(campaign))}; Path=/; SameSite=Lax; Max-Age=${30 * 86400}${window.location.protocol === "https:" ? "; Secure" : ""}`;
    } catch {
      /* Cookie restrictions must not affect the form. */
    }
  }
  const oppref =
    landingOppref ??
    identifier(previous?.oppref) ??
    identifier(readCookie("__oppref"));
  const browserRef =
    identifier(readCookie("__obref")) ?? identifier(previous?.obref);
  const obref =
    browserRef && browserRef.length <= 1024 ? browserRef : undefined;
  const next: OpenAiAdsAttribution = {
    consentId: consentId(previous?.consentId) ?? globalThis.crypto.randomUUID(),
    ...(oppref ? { oppref } : {}),
    ...(obref ? { obref } : {}),
    sourceUrl: sanitizeOpenAiAdsSourceUrl(window.location.href),
    consent: true,
    capturedAt:
      previous?.capturedAt &&
      (!landingOppref || landingOppref === previous.oppref)
        ? previous.capturedAt
        : new Date().toISOString(),
  };
  memoryAttribution = next;
  writeStorage(ATTRIBUTION_KEY, JSON.stringify(next));
  return next;
}

/** Add a paid source only for an actual ad click, preserving explicitly supplied campaign tags. */
export function withOpenAiAdsUtm<T extends Record<string, unknown>>(utm: T): T {
  if (!getOpenAiAdsAttribution()?.oppref) return utm;
  const params = new URLSearchParams(window.location.search);
  if (identifier(params.get("oppref"))) {
    return {
      ...utm,
      source: params.get("utm_source") || "chatgpt",
      medium: params.get("utm_medium") || "paid",
    };
  }
  if (params.has("gclid") || params.has("fbclid")) {
    // A different platform's new click must not inherit the older ChatGPT source.
    return {
      ...utm,
      source: params.get("utm_source") || undefined,
      medium: params.get("utm_medium") || undefined,
    };
  }
  return {
    ...utm,
    source: utm["source"] || "chatgpt",
    medium: utm["medium"] || "paid",
  };
}

export function initializeOpenAiAdsPixel(pixelId: string): boolean {
  if (
    typeof window === "undefined" ||
    !pixelId.trim() ||
    !isOpenAiAdsPublicPath(window.location.pathname)
  )
    return false;
  if (!isOpenAiAdsMeasurementAllowed()) {
    window.oaiq?.("consent", false);
    getOpenAiAdsAttribution();
    return false;
  }
  const attribution = getOpenAiAdsAttribution();
  if (!window.oaiq) {
    const queue: PixelQueue = (...args) => {
      queue.q?.push(args);
    };
    queue.q = [];
    window.oaiq = queue;
  }
  // A loaded third-party SDK must not continue measurement on private SPA routes.
  // Restore its click cookie only when returning to an allowed public surface.
  if (readStorage(SUSPENDED_KEY) === "true" && attribution?.oppref) {
    document.cookie = `__oppref=${encodeURIComponent(attribution.oppref)}; Path=/; SameSite=Lax; Max-Age=${30 * 86400}${window.location.protocol === "https:" ? "; Secure" : ""}`;
  }
  window.oaiq("consent", true);
  writeStorage(SUSPENDED_KEY, null);
  if (!initialized) {
    window.oaiq("init", { pixelId: pixelId.trim(), debug: false });
    initialized = true;
  }
  if (!document.getElementById("openai-ads-pixel")) {
    const script = document.createElement("script");
    script.id = "openai-ads-pixel";
    script.async = true;
    script.src = "https://bzrcdn.openai.com/sdk/oaiq.min.js";
    script.onload = () => {
      pendingConsentGrant = false;
    };
    document.head.appendChild(script);
  }
  return true;
}

export function suspendOpenAiAdsPixel(): void {
  if (!initialized || !window.oaiq) return;
  // This is a navigation boundary, not a change to the user's preference.
  if (isOpenAiAdsMeasurementAllowed()) writeStorage(SUSPENDED_KEY, "true");
  window.oaiq("consent", false);
}

function measure(
  event: string,
  data: Record<string, unknown>,
  options?: Record<string, unknown>,
): boolean {
  if (
    typeof window === "undefined" ||
    !process.env["NEXT_PUBLIC_OPENAI_ADS_PIXEL_ID"]?.trim() ||
    !isOpenAiAdsPublicPath(window.location.pathname) ||
    !isOpenAiAdsMeasurementAllowed() ||
    !window.oaiq
  )
    return false;
  try {
    window.oaiq("measure", event, data, options);
    return true;
  } catch {
    return false;
  }
}

export function trackOpenAiAdsPageView(): void {
  measure("page_viewed", { type: "contents" });
}

export function trackOpenAiAdsBooking(appointmentId: string): void {
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(appointmentId)) return;
  const eventId = `booking:${appointmentId}`;
  if (bookedEvents.has(eventId)) return;
  if (
    measure(
      "appointment_scheduled",
      { type: "customer_action" },
      { event_id: eventId },
    )
  )
    bookedEvents.add(eventId);
}

export function trackOpenAiAdsPhoneClick(): void {
  // A tap is a secondary signal. Only a verified inbound call is a phone inquiry.
  measure("custom", { type: "custom" }, { custom_event_name: "phone_click" });
}
