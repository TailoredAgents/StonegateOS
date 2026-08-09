import {
  isPartnerAllowedServiceKey,
  isPartnerTierKeyForService,
} from "@myst-os/pricing";

export const PARTNER_RATE_CSV_MAX_BYTES = 64 * 1024;
export const PARTNER_RATE_MAX_ROWS = 100;
export const PARTNER_RATE_MAX_AMOUNT_CENTS = 10_000_000;

export type PartnerRateSubmissionItem = {
  serviceKey: string;
  tierKey: string;
  label: string | null;
  amountCents: number;
  sortOrder: number;
};

export type PartnerRateCsvResult =
  | { ok: true; items: PartnerRateSubmissionItem[] }
  | { ok: false; message: string };

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });
}

function parseUsdCents(value: string): number | null {
  if (!/^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/u.test(value)) return null;
  const [whole = "0", fraction = ""] = value.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) &&
    cents >= 1 &&
    cents <= PARTNER_RATE_MAX_AMOUNT_CENTS
    ? cents
    : null;
}

export function parsePartnerRateCsv(raw: string): PartnerRateCsvResult {
  if (new TextEncoder().encode(raw).byteLength > PARTNER_RATE_CSV_MAX_BYTES) {
    return {
      ok: false,
      message: "Partner rates are too large. Use at most 64 KiB.",
    };
  }

  const lines = raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (lines.length < 1 || lines.length > PARTNER_RATE_MAX_ROWS) {
    return {
      ok: false,
      message: `Enter 1–${PARTNER_RATE_MAX_ROWS} complete rate rows.`,
    };
  }

  const identities = new Set<string>();
  const items: PartnerRateSubmissionItem[] = [];
  for (const [index, line] of lines.entries()) {
    const parts = line.split(",").map((part) => part.trim());
    if (parts.length !== 3 && parts.length !== 4) {
      return {
        ok: false,
        message: `Rate row ${index + 1} must contain exactly 3 or 4 comma-separated fields.`,
      };
    }

    const serviceKey = (parts[0] ?? "").toLowerCase();
    const tierKey = parts[1] ?? "";
    const rawLabel = parts.length === 4 ? (parts[2] ?? "") : "";
    const label = rawLabel.normalize("NFKC").trim() || null;
    const amount = parts.length === 4 ? (parts[3] ?? "") : (parts[2] ?? "");

    if (!isPartnerAllowedServiceKey(serviceKey)) {
      return {
        ok: false,
        message: `Rate row ${index + 1} has an unsupported service.`,
      };
    }
    if (
      tierKey.length < 1 ||
      tierKey.length > 100 ||
      containsControlCharacter(tierKey) ||
      !isPartnerTierKeyForService(serviceKey, tierKey)
    ) {
      return {
        ok: false,
        message: `Rate row ${index + 1} has an unsupported tier.`,
      };
    }
    if (
      label !== null &&
      (label.length > 120 || containsControlCharacter(label))
    ) {
      return {
        ok: false,
        message: `Rate row ${index + 1} has an invalid label.`,
      };
    }
    const amountCents = parseUsdCents(amount);
    if (amountCents === null) {
      return {
        ok: false,
        message: `Rate row ${index + 1} needs a USD amount from $0.01 through $100,000.00 with at most two decimals.`,
      };
    }

    const identity = `${serviceKey}:${tierKey}`;
    if (identities.has(identity)) {
      return {
        ok: false,
        message: `Rate row ${index + 1} duplicates ${serviceKey}/${tierKey}.`,
      };
    }
    identities.add(identity);
    items.push({
      serviceKey,
      tierKey,
      label,
      amountCents,
      sortOrder: index,
    });
  }
  return { ok: true, items };
}
