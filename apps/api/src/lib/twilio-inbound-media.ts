export const MAX_TWILIO_INBOUND_MEDIA_URLS = 10;

export type TwilioInboundMediaResult =
  | { ok: true; count: number; mediaUrls: string[] }
  | {
      ok: false;
      code:
        | "twilio_num_media_invalid"
        | "twilio_num_media_exceeds_limit"
        | "twilio_media_url_missing";
    };

/**
 * Parse only Twilio's canonical decimal NumMedia representation and then read
 * at most the documented MMS media limit. Signature verification must happen
 * before this helper is called by a webhook route.
 */
export function parseTwilioInboundMedia(
  formData: FormData,
): TwilioInboundMediaResult {
  const rawCount = formData.get("NumMedia");
  if (rawCount === null) {
    return { ok: true, count: 0, mediaUrls: [] };
  }
  if (typeof rawCount !== "string") {
    return { ok: false, code: "twilio_num_media_invalid" };
  }
  const normalizedCount = rawCount.trim();
  if (!/^(?:0|[1-9][0-9]*)$/u.test(normalizedCount)) {
    return { ok: false, code: "twilio_num_media_invalid" };
  }
  const count = Number(normalizedCount);
  if (count > MAX_TWILIO_INBOUND_MEDIA_URLS) {
    return { ok: false, code: "twilio_num_media_exceeds_limit" };
  }

  const mediaUrls: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const entries = formData.getAll(`MediaUrl${index}`);
    const value = entries.length === 1 ? entries[0] : null;
    const url = typeof value === "string" ? value.trim() : "";
    if (!url) {
      return { ok: false, code: "twilio_media_url_missing" };
    }
    mediaUrls.push(url);
  }
  return { ok: true, count, mediaUrls };
}
