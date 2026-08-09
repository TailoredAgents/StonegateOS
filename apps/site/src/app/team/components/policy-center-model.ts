export const POLICY_CATEGORY_IDS = [
  "business",
  "service-area",
  "booking",
  "messaging",
  "pricing",
  "templates",
  "reviews",
] as const;

export type PolicyCategoryId = (typeof POLICY_CATEGORY_IDS)[number];
export type PolicyCategoryFilter = "all" | PolicyCategoryId;

export type PolicyCardId =
  | "business_hours"
  | "quiet_hours"
  | "service_area"
  | "company_profile"
  | "sales_autopilot_signature"
  | "conversation_persona"
  | "inbox_alerts"
  | "booking_rules"
  | "confirmation_loop"
  | "follow_up_sequence"
  | "standard_job"
  | "item_policies"
  | "templates"
  | "review_request";

export type PolicyCategoryDefinition = {
  id: PolicyCategoryId;
  label: string;
  description: string;
};

export type PolicyCardDefinition = {
  id: PolicyCardId;
  category: PolicyCategoryId;
  title: string;
  description: string;
  keywords: readonly string[];
  affectedSurfaces: readonly string[];
};

export type PolicyTemplateChannelDefinition = {
  key: string;
  label: string;
};

/**
 * One shared registry drives both the visible Template fields and the server
 * action that persists them. Keeping these lists together prevents a save
 * from silently dropping a channel that the editor failed to render.
 */
export const POLICY_TEMPLATE_CHANNELS = {
  first_touch: [
    { key: "sms", label: "SMS" },
    { key: "email", label: "Email" },
    { key: "dm", label: "DM" },
    { key: "call", label: "Call" },
    { key: "web", label: "Web" },
  ],
  follow_up: [
    { key: "sms", label: "SMS" },
    { key: "email", label: "Email" },
    { key: "dm", label: "DM" },
  ],
  confirmations: [
    { key: "sms", label: "SMS" },
    { key: "email", label: "Email" },
  ],
  reviews: [
    { key: "sms", label: "SMS" },
    { key: "email", label: "Email" },
  ],
  out_of_area: [
    { key: "sms", label: "SMS" },
    { key: "email", label: "Email" },
    { key: "web", label: "Web" },
  ],
} as const satisfies Record<
  "first_touch" | "follow_up" | "confirmations" | "reviews" | "out_of_area",
  readonly PolicyTemplateChannelDefinition[]
>;

export const POLICY_CATEGORIES: readonly PolicyCategoryDefinition[] = [
  {
    id: "business",
    label: "Business",
    description: "Operating hours and company guidance.",
  },
  {
    id: "service-area",
    label: "Service Area",
    description: "Where the team may sell and book work.",
  },
  {
    id: "booking",
    label: "Booking",
    description: "Capacity, confirmation, and standard-job guardrails.",
  },
  {
    id: "messaging",
    label: "Messaging",
    description: "Voice, alerts, quiet hours, and follow-up cadence.",
  },
  {
    id: "pricing",
    label: "Pricing",
    description: "Declined items and extra-fee rules.",
  },
  {
    id: "templates",
    label: "Templates",
    description: "Reusable customer-facing copy by channel.",
  },
  {
    id: "reviews",
    label: "Reviews",
    description: "Post-job review request behavior.",
  },
] as const;

export const POLICY_CARD_DEFINITIONS: readonly PolicyCardDefinition[] = [
  {
    id: "business_hours",
    category: "business",
    title: "Business hours",
    description: "Define operating hours per weekday and default timezone.",
    keywords: ["schedule", "timezone", "open", "closed", "weekday"],
    affectedSurfaces: ["Inbox", "Messaging Automation", "Simulator"],
  },
  {
    id: "company_profile",
    category: "business",
    title: "Company profile",
    description: "Editable facts and sales playbook used by Inbox AI.",
    keywords: ["phone", "discount", "playbook", "agent", "company"],
    affectedSurfaces: ["Inbox", "Booking", "Simulator"],
  },
  {
    id: "service_area",
    category: "service-area",
    title: "Service area",
    description:
      "Define core service cities plus ZIP and boundary rules for service coverage.",
    keywords: ["zip", "city", "radius", "coverage", "home base"],
    affectedSurfaces: ["Booking", "Inbox", "Simulator"],
  },
  {
    id: "booking_rules",
    category: "booking",
    title: "Booking rules",
    description: "Default booking windows, buffers, and capacity caps.",
    keywords: ["capacity", "buffer", "jobs", "window", "crew"],
    affectedSurfaces: ["Booking", "Calendar", "Simulator"],
  },
  {
    id: "confirmation_loop",
    category: "booking",
    title: "Confirmation loop",
    description: "Enable or disable appointment confirmation reminders.",
    keywords: ["appointment", "reminder", "hours", "confirm"],
    affectedSurfaces: ["Calendar", "Messaging Automation", "Inbox"],
  },
  {
    id: "standard_job",
    category: "booking",
    title: "Standard job definition",
    description: "Guardrails for what can be auto-booked.",
    keywords: ["service", "volume", "item count", "autobook"],
    affectedSurfaces: ["Booking", "Messaging Automation", "Simulator"],
  },
  {
    id: "quiet_hours",
    category: "messaging",
    title: "Quiet hours",
    description: "When outbound messages should pause by channel.",
    keywords: ["sms", "email", "dm", "pause", "channel"],
    affectedSurfaces: ["Inbox", "Messaging Automation", "Simulator"],
  },
  {
    id: "sales_autopilot_signature",
    category: "messaging",
    title: "Sales agent name",
    description:
      "Name used by Sales Autopilot when drafting and sending messages.",
    keywords: ["autopilot", "signature", "name", "draft"],
    affectedSurfaces: ["Inbox", "Messaging Automation", "Simulator"],
  },
  {
    id: "conversation_persona",
    category: "messaging",
    title: "Conversation persona",
    description:
      "System instructions used by Sales Autopilot and Inbox AI drafts.",
    keywords: ["prompt", "voice", "tone", "ai", "autopilot"],
    affectedSurfaces: ["Inbox", "Messaging Automation", "Simulator"],
  },
  {
    id: "inbox_alerts",
    category: "messaging",
    title: "Inbox alerts",
    description:
      "Text the assigned salesperson when new inbound messages arrive.",
    keywords: ["notification", "sms", "email", "dm", "salesperson"],
    affectedSurfaces: ["Inbox", "Access", "Messaging Automation"],
  },
  {
    id: "follow_up_sequence",
    category: "messaging",
    title: "Follow-up sequence",
    description: "Configure quoted-but-not-booked follow-up cadence.",
    keywords: ["quote", "cadence", "reminder", "hours"],
    affectedSurfaces: ["Inbox", "Sales HQ", "Messaging Automation"],
  },
  {
    id: "item_policies",
    category: "pricing",
    title: "Item policies",
    description: "Items declined or extra fees applied.",
    keywords: ["fee", "declined", "price", "items"],
    affectedSurfaces: ["Quotes", "Booking", "Simulator"],
  },
  {
    id: "templates",
    category: "templates",
    title: "Templates",
    description: "First touch, follow-up, confirmations, and review copy.",
    keywords: ["sms", "email", "dm", "copy", "message"],
    affectedSurfaces: ["Inbox", "Messaging Automation", "Simulator"],
  },
  {
    id: "review_request",
    category: "reviews",
    title: "Review requests",
    description:
      "Automatically send a Google review request after a job is completed.",
    keywords: ["google", "link", "completion", "sms", "post-job"],
    affectedSurfaces: ["Calendar", "Inbox", "Messaging Automation"],
  },
] as const;

export function getPolicyCardDefinition(
  id: PolicyCardId,
): PolicyCardDefinition {
  const definition = POLICY_CARD_DEFINITIONS.find((card) => card.id === id);
  if (!definition) {
    throw new Error(`Unknown Policy Center card: ${id}`);
  }
  return definition;
}

export function policyCardMatches(
  card: PolicyCardDefinition,
  category: PolicyCategoryFilter,
  query: string,
): boolean {
  if (category !== "all" && card.category !== category) {
    return false;
  }

  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) {
    return true;
  }

  const categoryLabel =
    POLICY_CATEGORIES.find((entry) => entry.id === card.category)?.label ?? "";
  const searchableText = [
    card.title,
    card.description,
    categoryLabel,
    ...card.keywords,
    ...card.affectedSurfaces,
  ]
    .join(" ")
    .toLocaleLowerCase();

  return searchableText.includes(normalizedQuery);
}

export function formatPolicyEditor(
  updatedBy: string | null | undefined,
  currentMemberId: string,
  currentMemberLabel: string,
  hasSavedRevision = false,
): string {
  if (!updatedBy) {
    return hasSavedRevision ? "System or legacy actor" : "System default";
  }
  if (updatedBy === currentMemberId) {
    return `You (${currentMemberLabel})`;
  }
  return `Team member ${updatedBy.slice(0, 8)}`;
}
