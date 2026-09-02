export const PARTNER_JOB_ISSUE_CATEGORIES = [
  "access",
  "safety",
  "property_damage",
  "service_quality",
  "schedule",
  "other",
] as const;

export const PARTNER_JOB_ISSUE_PRIORITIES = ["standard", "urgent"] as const;

export type PartnerJobIssueCategory =
  (typeof PARTNER_JOB_ISSUE_CATEGORIES)[number];
export type PartnerJobIssuePriority =
  (typeof PARTNER_JOB_ISSUE_PRIORITIES)[number];

const ISSUE_CATEGORY_LABELS: Record<PartnerJobIssueCategory, string> = {
  access: "Access issue",
  safety: "Safety concern",
  property_damage: "Property damage",
  service_quality: "Service quality",
  schedule: "Schedule issue",
  other: "Other issue",
};

export function partnerJobIssueCategoryLabel(
  category: PartnerJobIssueCategory,
): string {
  return ISSUE_CATEGORY_LABELS[category];
}

export function readPartnerJobIssueMetadata(value: unknown): {
  category: PartnerJobIssueCategory;
  categoryLabel: string;
  priority: PartnerJobIssuePriority;
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const metadata = value as Record<string, unknown>;
  if (metadata["messageKind"] !== "issue") return null;
  const category = metadata["issueCategory"];
  const priority = metadata["issuePriority"];
  if (
    typeof category !== "string" ||
    !PARTNER_JOB_ISSUE_CATEGORIES.includes(
      category as PartnerJobIssueCategory,
    ) ||
    typeof priority !== "string" ||
    !PARTNER_JOB_ISSUE_PRIORITIES.includes(priority as PartnerJobIssuePriority)
  ) {
    return null;
  }
  return {
    category: category as PartnerJobIssueCategory,
    categoryLabel: ISSUE_CATEGORY_LABELS[category as PartnerJobIssueCategory],
    priority: priority as PartnerJobIssuePriority,
  };
}

type PublishedEtaRow = {
  etaStartAt: Date | null;
  etaEndAt: Date | null;
  sentAt: Date | null;
};

const ETA_MAX_SPAN_MS = 4 * 60 * 60_000;
const ETA_MAX_PUBLISH_AGE_MS = 24 * 60 * 60_000;
const ETA_MAX_FUTURE_MS = 24 * 60 * 60_000;
const ETA_EXPIRY_GRACE_MS = 15 * 60_000;
const ETA_CLOCK_SKEW_MS = 5 * 60_000;

export type PartnerJobOperationsSummary = {
  eta:
    | {
        state: "operational_estimate";
        startAt: string;
        endAt: string;
        publishedAt: string;
      }
    | {
        state: "not_published" | "complete" | "not_applicable";
        startAt: null;
        endAt: null;
        publishedAt: null;
      };
  assignedTeam: {
    state: "assigned" | "pending" | "complete" | "not_applicable";
    displayLabel: "Stonegate service crew";
    memberCount: number | null;
  };
};

function validDate(value: Date | null): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function safeAssignedCount(value: unknown): number {
  const count = Number(value);
  return Number.isSafeInteger(count) && count > 0 ? Math.min(count, 99) : 0;
}

function projectPublishedEta(
  value: PublishedEtaRow | null,
  now: Date,
): {
  state: "operational_estimate";
  startAt: string;
  endAt: string;
  publishedAt: string;
} | null {
  if (
    value === null ||
    !validDate(value.etaStartAt) ||
    !validDate(value.etaEndAt) ||
    !validDate(value.sentAt) ||
    !validDate(now) ||
    value.etaEndAt.getTime() <= value.etaStartAt.getTime() ||
    value.etaEndAt.getTime() - value.etaStartAt.getTime() > ETA_MAX_SPAN_MS ||
    value.sentAt.getTime() > now.getTime() + ETA_CLOCK_SKEW_MS ||
    value.sentAt.getTime() < now.getTime() - ETA_MAX_PUBLISH_AGE_MS ||
    value.etaStartAt.getTime() > now.getTime() + ETA_MAX_FUTURE_MS ||
    value.etaEndAt.getTime() < now.getTime() - ETA_EXPIRY_GRACE_MS ||
    value.sentAt.getTime() > value.etaEndAt.getTime()
  ) {
    return null;
  }
  return {
    state: "operational_estimate",
    startAt: value.etaStartAt.toISOString(),
    endAt: value.etaEndAt.toISOString(),
    publishedAt: value.sentAt.toISOString(),
  };
}

export function createPartnerJobOperationsSummary(input: {
  jobStatus: string;
  assignedMemberCount: unknown;
  publishedEta: PublishedEtaRow | null;
  now?: Date;
}): PartnerJobOperationsSummary {
  const status = input.jobStatus.trim().toLowerCase();
  const complete = status === "completed";
  const notApplicable = ["canceled", "declined", "no_show"].includes(status);
  const assignedMemberCount = safeAssignedCount(input.assignedMemberCount);
  const now = input.now ?? new Date();
  const publishedEta =
    complete || notApplicable
      ? null
      : projectPublishedEta(input.publishedEta, now);

  return {
    eta: publishedEta
      ? publishedEta
      : {
          state: complete
            ? "complete"
            : notApplicable
              ? "not_applicable"
              : "not_published",
          startAt: null,
          endAt: null,
          publishedAt: null,
        },
    assignedTeam: {
      state: complete
        ? "complete"
        : notApplicable
          ? "not_applicable"
          : assignedMemberCount > 0
            ? "assigned"
            : "pending",
      displayLabel: "Stonegate service crew",
      memberCount: assignedMemberCount > 0 ? assignedMemberCount : null,
    },
  };
}

const DELIVERY_EVENT_LABELS = {
  "booking.created": "Booking received",
  "booking.review_received": "Review request received",
  "booking.rescheduled": "Schedule updated",
  "booking.reschedule_review_requested": "Reschedule review requested",
  "booking.canceled": "Job canceled",
  "booking.cancellation_review_requested": "Cancellation review requested",
} as const;

const DELIVERY_CHANNEL_LABELS = {
  in_app: "In-app",
  email: "Email",
  sms: "SMS",
} as const;

const DELIVERY_STATE_SUMMARIES = {
  suppressed: { key: "not_sent", label: "Not sent by preference" },
  queued: { key: "pending", label: "Queued" },
  dispatching: { key: "pending", label: "Sending" },
  accepted: { key: "sent", label: "Accepted for delivery" },
  failed: { key: "failed", label: "Could not send" },
  reconciliation_required: {
    key: "checking",
    label: "Delivery being checked",
  },
} as const;

type DeliveryEventType = keyof typeof DELIVERY_EVENT_LABELS;
type DeliveryChannel = keyof typeof DELIVERY_CHANNEL_LABELS;
type DeliveryState = keyof typeof DELIVERY_STATE_SUMMARIES;

export type PartnerJobNotificationDeliveryDto = {
  id: string;
  event: { key: DeliveryEventType; label: string };
  channel: { key: DeliveryChannel; label: string };
  status: {
    key: "not_sent" | "pending" | "sent" | "failed" | "checking";
    label: string;
  };
  createdAt: string;
  acceptedAt: string | null;
  updatedAt: string;
};

export function createPartnerJobNotificationDeliveryDto(input: {
  id: string;
  eventType: string;
  channel: string;
  state: string;
  createdAt: Date;
  acceptedAt: Date | null;
  updatedAt: Date;
}): PartnerJobNotificationDeliveryDto | null {
  if (
    !Object.hasOwn(DELIVERY_EVENT_LABELS, input.eventType) ||
    !Object.hasOwn(DELIVERY_CHANNEL_LABELS, input.channel) ||
    !Object.hasOwn(DELIVERY_STATE_SUMMARIES, input.state) ||
    !validDate(input.createdAt) ||
    (input.acceptedAt !== null && !validDate(input.acceptedAt)) ||
    !validDate(input.updatedAt)
  ) {
    return null;
  }
  const eventType = input.eventType as DeliveryEventType;
  const channel = input.channel as DeliveryChannel;
  const state = input.state as DeliveryState;
  const status = DELIVERY_STATE_SUMMARIES[state];
  return {
    id: input.id,
    event: { key: eventType, label: DELIVERY_EVENT_LABELS[eventType] },
    channel: { key: channel, label: DELIVERY_CHANNEL_LABELS[channel] },
    status,
    createdAt: input.createdAt.toISOString(),
    acceptedAt: input.acceptedAt?.toISOString() ?? null,
    updatedAt: input.updatedAt.toISOString(),
  };
}
