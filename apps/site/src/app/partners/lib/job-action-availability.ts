export const PARTNER_JOB_ACTION_KEYS = [
  "request_change",
  "reschedule",
  "edit_references",
  "cancel",
  "request_cancellation_review",
  "message",
  "upload_media",
  "create_proof_share",
  "duplicate",
] as const;

export type PartnerJobActionKey = (typeof PARTNER_JOB_ACTION_KEYS)[number];

export type PartnerJobActionAvailability = Readonly<{
  action: PartnerJobActionKey;
  allowed: boolean;
  reason: Readonly<{ code: string; label: string }>;
}>;

const ACTION_KEY_SET = new Set<string>(PARTNER_JOB_ACTION_KEYS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parsePartnerJobActionAvailability(
  value: unknown,
): PartnerJobActionAvailability[] | null {
  if (
    !Array.isArray(value) ||
    value.length !== PARTNER_JOB_ACTION_KEYS.length
  ) {
    return null;
  }
  const seen = new Set<string>();
  const parsed: PartnerJobActionAvailability[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate) || !isRecord(candidate["reason"])) return null;
    const action = candidate["action"];
    const allowed = candidate["allowed"];
    const reasonCode = candidate["reason"]["code"];
    const reasonLabel = candidate["reason"]["label"];
    if (
      typeof action !== "string" ||
      !ACTION_KEY_SET.has(action) ||
      seen.has(action) ||
      typeof allowed !== "boolean" ||
      typeof reasonCode !== "string" ||
      reasonCode.length < 1 ||
      reasonCode.length > 80 ||
      typeof reasonLabel !== "string" ||
      reasonLabel.length < 1 ||
      reasonLabel.length > 240
    ) {
      return null;
    }
    seen.add(action);
    parsed.push({
      action: action as PartnerJobActionKey,
      allowed,
      reason: { code: reasonCode, label: reasonLabel },
    });
  }
  return seen.size === PARTNER_JOB_ACTION_KEYS.length ? parsed : null;
}

export function findPartnerJobAction(
  actions: readonly PartnerJobActionAvailability[],
  action: PartnerJobActionKey,
): PartnerJobActionAvailability | null {
  return actions.find((entry) => entry.action === action) ?? null;
}

export function partnerJobActionBlockers(
  actions: readonly PartnerJobActionAvailability[],
  keys: readonly PartnerJobActionKey[] = ["reschedule", "cancel", "duplicate"],
): PartnerJobActionAvailability[] {
  const requested = new Set(keys);
  return actions.filter(
    (entry) => requested.has(entry.action) && !entry.allowed,
  );
}
