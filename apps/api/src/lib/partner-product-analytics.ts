export const PARTNER_FUNNEL_STAGES = [
  "access_request_started",
  "verification_request_accepted",
  "booking_started",
  "availability_requested",
  "availability_available",
  "availability_slot_full",
  "availability_review_only",
  "availability_degraded",
  "slot_contention",
  "booking_submitted",
  "booking_confirmed",
  "booking_review_requested",
  "booking_failed",
  "booking_abandoned",
  "upload_started",
  "upload_completed",
  "upload_failed",
  "upload_interrupted",
] as const;

export const PARTNER_FUNNEL_PERSONAS = [
  "contractor",
  "real_estate_agent",
  "property_manager",
  "commercial_client",
  "other",
  "unknown",
] as const;

export type PartnerFunnelStage = (typeof PARTNER_FUNNEL_STAGES)[number];
export type PartnerFunnelPersona = (typeof PARTNER_FUNNEL_PERSONAS)[number];

export const PARTNER_WEB_VITAL_METRICS = ["LCP", "INP", "CLS"] as const;
export type PartnerWebVitalMetric = (typeof PARTNER_WEB_VITAL_METRICS)[number];
export type PartnerWebVitalRating = "good" | "needs_improvement" | "poor";

const PARTNER_EVENTS = new Set([
  "partner_page_view",
  "partner_action",
  "partner_form_submit",
  "partner_funnel",
  "web_vital",
]);
const FUNNEL_STAGES = new Set<string>(PARTNER_FUNNEL_STAGES);
const FUNNEL_PERSONAS = new Set<string>(PARTNER_FUNNEL_PERSONAS);
const ACCESS_FUNNEL_STAGES = new Set<string>([
  "access_request_started",
  "verification_request_accepted",
]);
const FUNNEL_SURFACES = new Set([
  "access",
  "booking",
  "draft_upload",
  "proof_upload",
]);
const WEB_VITAL_METRICS = new Set<string>(PARTNER_WEB_VITAL_METRICS);
const WEB_VITAL_MAX_VALUE: Readonly<Record<PartnerWebVitalMetric, number>> = {
  LCP: 120_000,
  INP: 120_000,
  CLS: 10,
};
const SAFE_ACTION_KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const SAFE_PARTNER_PATH_SEGMENTS = new Set([
  "activate",
  "application",
  "approvals",
  "billing",
  "book",
  "bookings",
  "confirm-email",
  "expired",
  "forgot-password",
  "help",
  "invitations",
  "login",
  "mfa",
  "overview",
  "partners",
  "photos",
  "proof",
  "properties",
  "quotes",
  "reports",
  "request-access",
  "reset-password",
  "reschedule",
  "settings",
  "team",
]);
const DYNAMIC_PARTNER_PATH_LABELS: Readonly<Record<string, string>> = {
  approvals: "[approval]",
  bookings: "[job]",
  proof: "[share]",
  quotes: "[quote]",
};

export type NormalizedPartnerProductEvent =
  | Readonly<{
      event:
        | "partner_page_view"
        | "partner_action"
        | "partner_form_submit"
        | "partner_funnel";
      path: string;
      key: string | null;
      meta: Record<string, unknown>;
    }>
  | Readonly<{
      event: "web_vital";
      path: string;
      key: PartnerWebVitalMetric;
      value: number;
      meta: Readonly<{ rating: PartnerWebVitalRating }>;
    }>;

export function isPartnerAnalyticsSurface(
  event: string,
  path: string,
): boolean {
  return event.startsWith("partner_") || /^\/partners(?:\/|$)/u.test(path);
}

export function sanitizePartnerAnalyticsPath(rawPath: string): string {
  const path = rawPath.split("?", 1)[0] || "/partners";
  const segments = path.split("/").filter(Boolean);
  if (segments[0] !== "partners") return "/partners";

  return `/${segments
    .map((segment, index) => {
      const previous = segments[index - 1];
      const dynamicLabel = previous
        ? DYNAMIC_PARTNER_PATH_LABELS[previous]
        : undefined;
      if (dynamicLabel) return dynamicLabel;
      return SAFE_PARTNER_PATH_SEGMENTS.has(segment) ? segment : "[other]";
    })
    .join("/")}`;
}

export function parsePartnerFunnelKey(
  value: string | null | undefined,
): { stage: PartnerFunnelStage; persona: PartnerFunnelPersona } | null {
  const [stage, persona, extra] = value?.trim().split(":") ?? [];
  if (
    extra !== undefined ||
    !stage ||
    !persona ||
    !FUNNEL_STAGES.has(stage) ||
    !FUNNEL_PERSONAS.has(persona)
  ) {
    return null;
  }
  return {
    stage: stage as PartnerFunnelStage,
    persona: persona as PartnerFunnelPersona,
  };
}

function partnerWebVitalRating(
  metric: PartnerWebVitalMetric,
  value: number,
): PartnerWebVitalRating {
  if (metric === "LCP") {
    return value <= 2_500
      ? "good"
      : value <= 4_000
        ? "needs_improvement"
        : "poor";
  }
  if (metric === "INP") {
    return value <= 200 ? "good" : value <= 500 ? "needs_improvement" : "poor";
  }
  return value <= 0.1 ? "good" : value <= 0.25 ? "needs_improvement" : "poor";
}

function normalizePartnerWebVital(input: {
  path: string;
  key?: string | null;
  value?: number;
}): NormalizedPartnerProductEvent | null {
  const candidate = input.key?.trim().toUpperCase() ?? "";
  if (!WEB_VITAL_METRICS.has(candidate)) return null;
  const metric = candidate as PartnerWebVitalMetric;
  const value = input.value;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > WEB_VITAL_MAX_VALUE[metric]
  ) {
    return null;
  }
  const normalizedValue =
    metric === "CLS" ? Number(value.toFixed(4)) : Math.round(value);
  return {
    event: "web_vital",
    path: sanitizePartnerAnalyticsPath(input.path),
    key: metric,
    value: normalizedValue,
    meta: { rating: partnerWebVitalRating(metric, normalizedValue) },
  };
}

export function normalizePartnerProductEvent(input: {
  event: string;
  path: string;
  key?: string | null;
  meta?: Record<string, unknown>;
  value?: number;
}): NormalizedPartnerProductEvent | null {
  if (!PARTNER_EVENTS.has(input.event)) return null;
  if (input.event === "web_vital") {
    if (!/^\/partners(?:\/|$)/u.test(input.path.split("?", 1)[0] ?? "")) {
      return null;
    }
    return normalizePartnerWebVital(input);
  }
  if (input.value !== undefined) return null;
  const event = input.event as Exclude<
    NormalizedPartnerProductEvent["event"],
    "web_vital"
  >;
  const path = sanitizePartnerAnalyticsPath(input.path);

  if (event === "partner_page_view") {
    return { event, path, key: null, meta: {} };
  }
  if (event === "partner_action" || event === "partner_form_submit") {
    const key = input.key?.trim().toLowerCase() ?? "";
    return SAFE_ACTION_KEY.test(key) ? { event, path, key, meta: {} } : null;
  }

  const funnel = parsePartnerFunnelKey(input.key);
  if (!funnel) return null;
  const surface = input.meta?.["surface"];
  const step = input.meta?.["step"];
  if (typeof surface !== "string" || !FUNNEL_SURFACES.has(surface)) {
    return null;
  }
  if (ACCESS_FUNNEL_STAGES.has(funnel.stage) !== (surface === "access")) {
    return null;
  }
  return {
    event,
    path,
    key: `${funnel.stage}:${funnel.persona}`,
    meta: {
      surface,
      ...(typeof step === "number" &&
      Number.isSafeInteger(step) &&
      step >= 1 &&
      step <= 6
        ? { step }
        : {}),
    },
  };
}
