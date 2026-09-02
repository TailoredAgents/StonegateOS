import { flushWebAnalytics, trackWebEvent } from "@/lib/web-analytics";

export const PARTNER_FUNNEL_STAGES = [
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
export type PartnerFunnelSurface = "booking" | "draft_upload" | "proof_upload";

const PERSONAS = new Set<string>(PARTNER_FUNNEL_PERSONAS);
const SURFACE_PATH: Record<PartnerFunnelSurface, string> = {
  booking: "/partners/book",
  draft_upload: "/partners/book",
  proof_upload: "/partners/bookings/[job]/proof",
};

export function normalizePartnerFunnelPersona(
  value: string | null | undefined,
): PartnerFunnelPersona {
  const candidate = value?.trim().toLowerCase() ?? "";
  return PERSONAS.has(candidate)
    ? (candidate as PartnerFunnelPersona)
    : "unknown";
}

export function partnerFunnelKey(
  stage: PartnerFunnelStage,
  persona: string | null | undefined,
): string {
  return `${stage}:${normalizePartnerFunnelPersona(persona)}`;
}

/**
 * Sends only a stable stage/persona key and bounded operational dimensions.
 * IDs, service/location selections, descriptions, filenames, and commercial
 * fields are deliberately not accepted by this interface.
 */
export function trackPartnerFunnelEvent(input: {
  stage: PartnerFunnelStage;
  persona?: string | null;
  surface: PartnerFunnelSurface;
  step?: number;
}): void {
  const step =
    typeof input.step === "number" &&
    Number.isSafeInteger(input.step) &&
    input.step >= 1 &&
    input.step <= 6
      ? input.step
      : undefined;
  trackWebEvent({
    event: "partner_funnel",
    path: SURFACE_PATH[input.surface],
    key: partnerFunnelKey(input.stage, input.persona),
    meta: {
      surface: input.surface,
      ...(step ? { step } : {}),
    },
    privacyMode: "product",
  });
}

export function flushPartnerFunnelEvents(): void {
  flushWebAnalytics();
}
