const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const PARTNER_SMS_CONSENT_VERSION = "partner-sms-consent-v1" as const;

export type PartnerSmsDeliveryStatus =
  | "queued"
  | "dispatching"
  | "accepted"
  | "failed"
  | "reconciliation_required";

export type PartnerSmsEndpoint = {
  id: string;
  channel: "sms";
  maskedDestination: string;
  status: "pending" | "verified" | "revoked";
  verifiedAt: string | null;
  consentSource: string | null;
  consentVersion: string | null;
  createdAt: string;
  updatedAt: string;
  activeChallenge: {
    expiresAt: string;
    deliveryStatus: PartnerSmsDeliveryStatus;
  } | null;
};

const ENDPOINT_KEYS = [
  "activeChallenge",
  "channel",
  "consentSource",
  "consentVersion",
  "createdAt",
  "id",
  "maskedDestination",
  "status",
  "updatedAt",
  "verifiedAt",
] as const;
const CHALLENGE_KEYS = ["deliveryStatus", "expiresAt"] as const;
const DELIVERY_STATUSES = new Set<PartnerSmsDeliveryStatus>([
  "queued",
  "dispatching",
  "accepted",
  "failed",
  "reconciliation_required",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function isInstant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    Number.isFinite(new Date(value).getTime())
  );
}

function nullableBoundedString(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length <= 128);
}

function parseChallenge(
  value: unknown,
): PartnerSmsEndpoint["activeChallenge"] | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !hasExactKeys(value, CHALLENGE_KEYS)) {
    return undefined;
  }
  const deliveryStatus = value["deliveryStatus"];
  if (
    typeof deliveryStatus !== "string" ||
    !DELIVERY_STATUSES.has(deliveryStatus as PartnerSmsDeliveryStatus) ||
    !isInstant(value["expiresAt"])
  ) {
    return undefined;
  }
  return {
    expiresAt: value["expiresAt"],
    deliveryStatus: deliveryStatus as PartnerSmsDeliveryStatus,
  };
}

export function parsePartnerSmsEndpoint(
  value: unknown,
): PartnerSmsEndpoint | null {
  if (!isRecord(value) || !hasExactKeys(value, ENDPOINT_KEYS)) return null;
  const activeChallenge = parseChallenge(value["activeChallenge"]);
  if (
    activeChallenge === undefined ||
    typeof value["id"] !== "string" ||
    !UUID_PATTERN.test(value["id"]) ||
    value["channel"] !== "sms" ||
    typeof value["maskedDestination"] !== "string" ||
    !/^•••• [0-9]{4}$/u.test(value["maskedDestination"]) ||
    (value["status"] !== "pending" &&
      value["status"] !== "verified" &&
      value["status"] !== "revoked") ||
    (value["verifiedAt"] !== null && !isInstant(value["verifiedAt"])) ||
    !nullableBoundedString(value["consentSource"]) ||
    !nullableBoundedString(value["consentVersion"]) ||
    !isInstant(value["createdAt"]) ||
    !isInstant(value["updatedAt"])
  ) {
    return null;
  }
  return {
    id: value["id"],
    channel: "sms",
    maskedDestination: value["maskedDestination"],
    status: value["status"],
    verifiedAt: value["verifiedAt"],
    consentSource: value["consentSource"],
    consentVersion: value["consentVersion"],
    createdAt: value["createdAt"],
    updatedAt: value["updatedAt"],
    activeChallenge,
  };
}

export function parsePartnerSmsEndpoints(
  value: unknown,
): PartnerSmsEndpoint[] | null {
  if (!Array.isArray(value)) return null;
  const endpoints = value.map(parsePartnerSmsEndpoint);
  return endpoints.every(
    (endpoint): endpoint is PartnerSmsEndpoint => endpoint !== null,
  )
    ? endpoints
    : null;
}

export function hasVerifiedPartnerSmsEndpoint(
  endpoints: PartnerSmsEndpoint[] | null,
): boolean {
  return endpoints?.some((endpoint) => endpoint.status === "verified") ?? false;
}

export function withPartnerSmsChallenge(
  endpoint: PartnerSmsEndpoint,
  challenge: unknown,
): PartnerSmsEndpoint | null {
  if (endpoint.status !== "pending") {
    return challenge === undefined ? endpoint : null;
  }
  const parsed = parseChallenge(challenge);
  return parsed ? { ...endpoint, activeChallenge: parsed } : null;
}
