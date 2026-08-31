import {
  isPartnerAllowedServiceKey,
  type PartnerServiceKey,
} from "@myst-os/pricing";
import { SchedulingDomainError } from "./errors";

const SERVICE_KEY_ALIASES: Readonly<Record<string, PartnerServiceKey>> = {
  "junk-removal-primary": "junk-removal",
  demolition: "demo-hauloff",
  "demolition-hauloff": "demo-hauloff",
  "demolition-haul-off": "demo-hauloff",
  "demo-haul-off": "demo-hauloff",
};

function normalizeServiceKeyToken(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/-{2,}/gu, "-");
}

/**
 * Maps known cross-system aliases onto the partner catalog's canonical keys.
 * Unknown values are rejected rather than guessed into a different service.
 */
export function canonicalizeSchedulingServiceKey(
  value: unknown,
): PartnerServiceKey | null {
  if (typeof value !== "string") return null;
  const token = normalizeServiceKeyToken(value);
  if (!token) return null;
  if (isPartnerAllowedServiceKey(token)) return token;
  return SERVICE_KEY_ALIASES[token] ?? null;
}

export function requireSchedulingServiceKey(value: unknown): PartnerServiceKey {
  const serviceKey = canonicalizeSchedulingServiceKey(value);
  if (serviceKey) return serviceKey;
  throw new SchedulingDomainError(
    "invalid_service_key",
    "Choose a supported service before scheduling.",
  );
}
