export const QUOTE_V2_COMPOSER_STEPS = [
  "client_project",
  "items_scope",
  "terms_fulfillment",
  "review_send",
] as const;

export type QuoteV2ComposerStep = (typeof QUOTE_V2_COMPOSER_STEPS)[number];
export type QuoteV2Audience = "residential" | "commercial";
export type QuoteV2DocumentType = "fixed_quote" | "estimate" | "range";
export type QuoteV2SchedulingMode =
  | "self_schedule"
  | "staff_followup"
  | "approval_only";

export type QuoteV2ContactProperty = {
  id: string;
  label: string;
  billingLabel?: string | null;
};

export type QuoteV2ContactSearchResult = {
  id: string;
  name: string;
  companyName: string | null;
  email: string | null;
  phoneE164: string | null;
  title: string | null;
  properties: QuoteV2ContactProperty[];
};

/** Keeps the remote-search result concise while exposing the matched company. */
export function quoteV2ContactResultLabel(
  contact: Pick<QuoteV2ContactSearchResult, "name" | "companyName">,
): string {
  const name = contact.name.trim().slice(0, 240) || "Client";
  const company = contact.companyName?.trim().slice(0, 240) ?? "";
  if (
    !company ||
    company.localeCompare(name, undefined, { sensitivity: "base" }) === 0
  ) {
    return name;
  }
  return `${company} · ${name}`;
}

export type QuoteV2LineDraft = {
  id: string;
  catalogKey: string;
  name: string;
  description: string;
  quantity: string;
  unit: string;
  unitPriceMin: string;
  unitPriceMax: string;
  optionGroupId: string;
  selectedByDefault: boolean;
};

export type QuoteV2OptionGroupDraft = {
  id: string;
  label: string;
  mode: "single" | "multiple";
  minimumSelections: string;
  maximumSelections: string;
};

export type QuoteV2AdjustmentDraft = {
  id: string;
  kind: "discount" | "fee" | "travel";
  label: string;
  calculation: "fixed" | "percentage";
  value: string;
};

export type QuoteV2DepositDraft = {
  mode: "none" | "fixed" | "percentage";
  value: string;
};

export type QuoteV2RecipientDraft = {
  name: string;
  email: string;
  phoneE164: string;
  emailSelected: boolean;
  smsSelected: boolean;
};

export type QuoteV2ViewRecipientDraft = QuoteV2RecipientDraft & {
  id: string;
  role: "cc" | "bcc";
};

export type QuoteV2ComposerDraft = {
  contactId: string;
  propertyId: string;
  contact: QuoteV2ContactSearchResult | null;
  audience: QuoteV2Audience;
  documentType: QuoteV2DocumentType;
  schedulingMode: QuoteV2SchedulingMode;
  projectName: string;
  projectReference: string;
  purchaseOrder: string;
  billingAddress: string;
  serviceZoneId: string;
  serviceZoneConfirmed: boolean;
  attentionName: string;
  attentionTitle: string;
  lines: QuoteV2LineDraft[];
  optionGroups: QuoteV2OptionGroupDraft[];
  adjustments: QuoteV2AdjustmentDraft[];
  scope: string;
  inclusions: string;
  exclusions: string;
  assumptions: string;
  internalNotes: string;
  validityDays: string;
  durationMinutes: string;
  paymentTerms: string;
  changeOrderRules: string;
  terms: string;
  deposit: QuoteV2DepositDraft;
  recipient: QuoteV2RecipientDraft;
  additionalRecipients: QuoteV2ViewRecipientDraft[];
  coverMessage: string;
};

export type QuoteV2OptimisticTotals = {
  valid: boolean;
  subtotalMinCents: number;
  subtotalMaxCents: number;
  discountMinCents: number;
  discountMaxCents: number;
  feeMinCents: number;
  feeMaxCents: number;
  totalMinCents: number;
  totalMaxCents: number;
  depositCents: number;
  balanceMinCents: number;
  balanceMaxCents: number;
  errors: Record<string, string>;
};

export type QuoteV2Readiness = {
  ready: boolean;
  completedCount: number;
  requirements: Array<{
    id: string;
    label: string;
    complete: boolean;
    step: QuoteV2ComposerStep;
  }>;
};

const DEFAULT_RESIDENTIAL_TERMS =
  "This proposal covers only the customer-facing scope, inclusions, and exclusions shown above.";
const DEFAULT_COMMERCIAL_TERMS =
  "This proposal covers only the stated project scope. Work outside that scope requires written approval.";

export function newQuoteV2ComposerDraft(
  id: string,
  audience: QuoteV2Audience = "residential",
): QuoteV2ComposerDraft {
  return {
    contactId: "",
    propertyId: "",
    contact: null,
    audience,
    documentType: "fixed_quote",
    schedulingMode:
      audience === "commercial" ? "staff_followup" : "self_schedule",
    projectName: "",
    projectReference: "",
    purchaseOrder: "",
    billingAddress: "",
    serviceZoneId: "",
    serviceZoneConfirmed: false,
    attentionName: "",
    attentionTitle: "",
    lines: [newQuoteV2LineDraft(`${id}-line-1`)],
    optionGroups: [],
    adjustments: [],
    scope: "",
    inclusions: "Labor, equipment, hauling, and responsible disposal",
    exclusions: "Hazardous or regulated materials not specifically listed",
    assumptions: "Safe and unobstructed access to the service area",
    internalNotes: "",
    validityDays: audience === "commercial" ? "30" : "14",
    durationMinutes: "120",
    paymentTerms: "Balance is due when the approved work is complete.",
    changeOrderRules:
      "Any added or changed work will be described and approved before it begins.",
    terms:
      audience === "commercial"
        ? DEFAULT_COMMERCIAL_TERMS
        : DEFAULT_RESIDENTIAL_TERMS,
    deposit: { mode: "none", value: "" },
    recipient: {
      name: "",
      email: "",
      phoneE164: "",
      emailSelected: true,
      smsSelected: false,
    },
    additionalRecipients: [],
    coverMessage: "",
  };
}

export function newQuoteV2LineDraft(id: string): QuoteV2LineDraft {
  return {
    id,
    catalogKey: "",
    name: "",
    description: "",
    quantity: "1",
    unit: "project",
    unitPriceMin: "",
    unitPriceMax: "",
    optionGroupId: "",
    selectedByDefault: false,
  };
}

export function applyQuoteV2AudienceDefaults(
  draft: QuoteV2ComposerDraft,
  audience: QuoteV2Audience,
): QuoteV2ComposerDraft {
  const previousDefaultValidity = draft.audience === "commercial" ? "30" : "14";
  const previousDefaultScheduling =
    draft.audience === "commercial" ? "staff_followup" : "self_schedule";
  return {
    ...draft,
    audience,
    validityDays:
      draft.validityDays === previousDefaultValidity
        ? audience === "commercial"
          ? "30"
          : "14"
        : draft.validityDays,
    schedulingMode:
      draft.schedulingMode === previousDefaultScheduling
        ? audience === "commercial"
          ? "staff_followup"
          : "self_schedule"
        : draft.schedulingMode,
    terms:
      draft.terms === DEFAULT_RESIDENTIAL_TERMS ||
      draft.terms === DEFAULT_COMMERCIAL_TERMS
        ? audience === "commercial"
          ? DEFAULT_COMMERCIAL_TERMS
          : DEFAULT_RESIDENTIAL_TERMS
        : draft.terms,
  };
}

export function parseUsdToCents(value: string): number | null {
  const normalized = value.trim().replace(/[$,\s]/gu, "");
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/u.test(normalized)) return null;
  const [whole = "0", fraction = ""] = normalized.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents <= 100_000_000 ? cents : null;
}

export function parsePositiveQuantity(value: string): number | null {
  const normalized = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/u.test(normalized)) return null;
  const quantity = Number(normalized);
  return Number.isFinite(quantity) && quantity > 0 && quantity <= 1_000_000
    ? quantity
    : null;
}

function multiplyQuantity(quantity: number, cents: number): number {
  return Math.floor((Math.round(quantity * 1_000) * cents + 500) / 1_000);
}

function percentageAmount(cents: number, percent: number): number {
  const basisPoints = Math.round(percent * 100);
  return Math.floor((cents * basisPoints + 5_000) / 10_000);
}

export function calculateQuoteV2OptimisticTotals(
  draft: QuoteV2ComposerDraft,
): QuoteV2OptimisticTotals {
  const errors: Record<string, string> = {};
  let subtotalMinCents = 0;
  let subtotalMaxCents = 0;

  const groupIds = new Set(draft.optionGroups.map((group) => group.id));
  for (const [index, group] of draft.optionGroups.entries()) {
    const minimum = Number(group.minimumSelections);
    const maximum = Number(group.maximumSelections);
    const optionCount = draft.lines.filter(
      (line) => line.optionGroupId === group.id,
    ).length;
    if (!group.label.trim()) {
      errors[`optionGroups.${index}.label`] = "Add an option-group label.";
    }
    if (
      !Number.isInteger(minimum) ||
      !Number.isInteger(maximum) ||
      minimum < 0 ||
      maximum < 1 ||
      minimum > maximum ||
      (group.mode === "single" && maximum !== 1)
    ) {
      errors[`optionGroups.${index}.selections`] =
        "Set a valid minimum and maximum selection count.";
    } else if (optionCount < maximum) {
      errors[`optionGroups.${index}.options`] =
        "Add enough line items for this option group.";
    } else {
      const defaultCount = draft.lines.filter(
        (line) => line.optionGroupId === group.id && line.selectedByDefault,
      ).length;
      if (defaultCount < minimum || defaultCount > maximum) {
        errors[`optionGroups.${index}.defaults`] =
          `Select ${minimum}–${maximum} default option(s) for authoritative preview totals.`;
      }
    }
  }
  for (const [index, line] of draft.lines.entries()) {
    const quantity = parsePositiveQuantity(line.quantity);
    const minimum = parseUsdToCents(line.unitPriceMin);
    const maximum = line.unitPriceMax.trim()
      ? parseUsdToCents(line.unitPriceMax)
      : minimum;
    if (!line.name.trim()) errors[`lines.${index}.name`] = "Add an item name.";
    if (quantity === null)
      errors[`lines.${index}.quantity`] =
        "Use a positive quantity with up to 3 decimals.";
    if (minimum === null)
      errors[`lines.${index}.unitPriceMin`] = "Enter a valid USD amount.";
    if (maximum === null || (minimum !== null && maximum < minimum)) {
      errors[`lines.${index}.unitPriceMax`] =
        "The high price cannot be below the low price.";
    }
    if (line.optionGroupId && !groupIds.has(line.optionGroupId)) {
      errors[`lines.${index}.optionGroupId`] =
        "Choose an available option group.";
    }
    if (quantity !== null && minimum !== null && maximum !== null) {
      const included = !line.optionGroupId || line.selectedByDefault;
      if (included) {
        subtotalMinCents += multiplyQuantity(quantity, minimum);
        subtotalMaxCents += multiplyQuantity(quantity, maximum);
      }
    }
  }

  if (draft.lines.length === 0) errors["lines"] = "Add at least one line item.";
  if (draft.documentType !== "range" && subtotalMinCents !== subtotalMaxCents) {
    errors["documentType"] =
      "Only a range can contain different low and high prices.";
  }
  if (draft.documentType === "range" && subtotalMaxCents <= subtotalMinCents) {
    errors["documentType"] = "A range needs a high total above its low total.";
  }

  let discountMinCents = 0;
  let discountMaxCents = 0;
  let feeMinCents = 0;
  let feeMaxCents = 0;
  for (const [index, adjustment] of draft.adjustments.entries()) {
    const parsed =
      adjustment.calculation === "fixed"
        ? parseUsdToCents(adjustment.value)
        : Number(adjustment.value);
    if (!adjustment.label.trim()) {
      errors[`adjustments.${index}.label`] = "Add an adjustment label.";
    }
    if (
      parsed === null ||
      !Number.isFinite(parsed) ||
      parsed < 0 ||
      (adjustment.calculation === "percentage" && (parsed <= 0 || parsed > 100))
    ) {
      errors[`adjustments.${index}.value`] =
        adjustment.calculation === "fixed"
          ? "Enter a valid USD amount."
          : "Enter a percentage from 0 to 100.";
      continue;
    }
    const minimum =
      adjustment.calculation === "fixed"
        ? parsed
        : percentageAmount(subtotalMinCents, parsed);
    const maximum =
      adjustment.calculation === "fixed"
        ? parsed
        : percentageAmount(subtotalMaxCents, parsed);
    if (adjustment.kind === "discount") {
      discountMinCents += minimum;
      discountMaxCents += maximum;
    } else {
      feeMinCents += minimum;
      feeMaxCents += maximum;
    }
  }

  if (
    discountMinCents > subtotalMinCents ||
    discountMaxCents > subtotalMaxCents
  ) {
    errors["adjustments"] = "Discounts cannot exceed the eligible subtotal.";
  }
  const totalMinCents = subtotalMinCents - discountMinCents + feeMinCents;
  const totalMaxCents = subtotalMaxCents - discountMaxCents + feeMaxCents;

  let depositCents = 0;
  if (draft.deposit.mode === "fixed") {
    depositCents = parseUsdToCents(draft.deposit.value) ?? -1;
  } else if (draft.deposit.mode === "percentage") {
    const percentage = Number(draft.deposit.value);
    if (!Number.isFinite(percentage) || percentage <= 0 || percentage > 100) {
      depositCents = -1;
    } else {
      depositCents = percentageAmount(totalMinCents, percentage);
    }
  }
  if (draft.documentType === "range" && draft.deposit.mode === "percentage") {
    errors["deposit"] = "Range proposals require a fixed deposit.";
  } else if (depositCents < 0 || depositCents > totalMinCents) {
    errors["deposit"] =
      "The deposit must be positive and no more than the low total.";
  }
  depositCents = Math.max(0, depositCents);

  if (totalMinCents <= 0 || totalMaxCents < totalMinCents) {
    errors["total"] = "The proposal must have a valid positive total.";
  }

  return {
    valid: Object.keys(errors).length === 0,
    subtotalMinCents,
    subtotalMaxCents,
    discountMinCents,
    discountMaxCents,
    feeMinCents,
    feeMaxCents,
    totalMinCents,
    totalMaxCents,
    depositCents,
    balanceMinCents: Math.max(0, totalMinCents - depositCents),
    balanceMaxCents: Math.max(0, totalMaxCents - depositCents),
    errors,
  };
}

function validEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value.trim());
}

function validE164(value: string): boolean {
  return /^\+[1-9]\d{7,14}$/u.test(value.trim());
}

export function quoteV2Readiness(
  draft: QuoteV2ComposerDraft,
  totals = calculateQuoteV2OptimisticTotals(draft),
): QuoteV2Readiness {
  const recipientValid =
    draft.recipient.name.trim().length > 0 &&
    (draft.recipient.emailSelected || draft.recipient.smsSelected) &&
    (!draft.recipient.emailSelected || validEmail(draft.recipient.email)) &&
    (!draft.recipient.smsSelected || validE164(draft.recipient.phoneE164));
  const viewRecipientsValid = draft.additionalRecipients.every(
    (recipient) =>
      recipient.name.trim().length > 0 &&
      (recipient.emailSelected || recipient.smsSelected) &&
      (!recipient.emailSelected || validEmail(recipient.email)) &&
      (!recipient.smsSelected || validE164(recipient.phoneE164)),
  );
  const requirements: QuoteV2Readiness["requirements"] = [
    {
      id: "client",
      label: "Client and service property selected",
      complete: Boolean(draft.contactId && draft.propertyId),
      step: "client_project",
    },
    {
      id: "project",
      label: "Project name added",
      complete: draft.projectName.trim().length > 0,
      step: "client_project",
    },
    {
      id: "service_zone",
      label: "Service zone and travel policy confirmed",
      complete: Boolean(draft.serviceZoneId && draft.serviceZoneConfirmed),
      step: "client_project",
    },
    {
      id: "pricing",
      label: "Positive, reconciled pricing",
      complete: totals.valid && totals.totalMinCents > 0,
      step: "items_scope",
    },
    {
      id: "scope",
      label: "Customer-facing scope added",
      complete: draft.scope.trim().length > 0,
      step: "items_scope",
    },
    {
      id: "terms",
      label: "Terms, payment, and validity complete",
      complete:
        draft.terms.trim().length > 0 &&
        draft.paymentTerms.trim().length > 0 &&
        Number.isInteger(Number(draft.validityDays)) &&
        Number(draft.validityDays) >= 1 &&
        Number(draft.validityDays) <= 120,
      step: "terms_fulfillment",
    },
    {
      id: "signer",
      label: "One signer with a valid delivery channel",
      complete: recipientValid,
      step: "review_send",
    },
    {
      id: "view_recipients",
      label: "View-only recipient details are valid",
      complete: viewRecipientsValid,
      step: "review_send",
    },
  ];
  const completedCount = requirements.filter((item) => item.complete).length;
  return {
    ready: completedCount === requirements.length,
    completedCount,
    requirements,
  };
}

export function splitProposalList(value: string): string[] {
  return value
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 50);
}

export function formatQuoteV2Money(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}
