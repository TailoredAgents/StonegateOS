export const OWNER_ASSISTANT_SOURCE_IDS = [
  "revenue",
  "payment_reconciliation",
  "schedule",
] as const;

export type OwnerAssistantSourceId =
  (typeof OWNER_ASSISTANT_SOURCE_IDS)[number];

export type OwnerAssistantRange =
  | "today"
  | "tomorrow"
  | "this_week"
  | "next_week";

export type OwnerAssistantSourceStatus =
  | "available"
  | "empty"
  | "forbidden"
  | "unavailable";

export type OwnerAssistantSourceCitation = {
  id: OwnerAssistantSourceId;
  label: string;
  status: OwnerAssistantSourceStatus;
  checkedAt: string;
  detail: string;
  href: string;
};

export type OwnerAssistantWarning = {
  code: "ai_provider_failed";
  message: string;
};

const SOURCE_TERMS: Readonly<
  Record<OwnerAssistantSourceId, readonly string[]>
> = {
  revenue: ["revenue", "sales", "income", "profit", "p&l", "earned"],
  payment_reconciliation: [
    "payment",
    "refund",
    "square",
    "stripe",
    "reconciliation",
    "reconcile",
    "unmatched",
    "transaction",
  ],
  schedule: ["schedule", "appointment", "booking", "calendar", "job"],
};

export function selectOwnerAssistantSources(
  message: string,
): OwnerAssistantSourceId[] {
  const normalized = message.trim().toLowerCase();
  const selected = OWNER_ASSISTANT_SOURCE_IDS.filter((source) =>
    SOURCE_TERMS[source].some((term) => normalized.includes(term)),
  );

  return selected.length > 0 ? selected : [...OWNER_ASSISTANT_SOURCE_IDS];
}

export function selectOwnerAssistantRange(
  message: string,
): OwnerAssistantRange {
  const normalized = message.trim().toLowerCase();
  if (normalized.includes("tomorrow")) return "tomorrow";
  if (normalized.includes("today")) return "today";
  if (normalized.includes("next week")) return "next_week";
  return "this_week";
}

export function ownerAssistantCitationToken(
  source: Pick<OwnerAssistantSourceCitation, "label">,
): string {
  return `[${source.label}]`;
}

export function addVerifiedSourceFooter(
  reply: string,
  sources: readonly OwnerAssistantSourceCitation[],
): string {
  const trustedSources = sources.filter(
    (source) => source.status === "available" || source.status === "empty",
  );
  const footer =
    trustedSources.length > 0
      ? `Verified sources: ${trustedSources
          .map(ownerAssistantCitationToken)
          .join(", ")}.`
      : "Verified sources: none available for this answer.";
  const trimmedReply = reply.trim();

  return trimmedReply ? `${trimmedReply}\n\n${footer}` : footer;
}
