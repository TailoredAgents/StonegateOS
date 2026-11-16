import { z } from "zod";

export const WINTER_DISCOUNT_BPS = 4_000;
export const CAMPAIGN_BATCH_LIMIT = 25;
export const CAMPAIGN_TIME_ZONE = "America/New_York";
export const WinterSaleSnapshotSchema = z
  .object({
    campaignId: z.string().uuid(),
    name: z.string().max(100),
    basisPoints: z.literal(4000),
    expiresAt: z.string().datetime({ offset: true }),
    serviceThrough: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    activatedAt: z.string().datetime({ offset: true }).optional(),
    retroactivePolicy: z
      .enum(["new_quotes_only", "include_unaccepted_quotes"])
      .optional(),
  })
  .strict();
export type WinterSaleSnapshot = z.infer<typeof WinterSaleSnapshotSchema>;
export const CampaignTermsSchema = z
  .object({
    audience: z.enum(["past_customers", "customers_and_leads"]).optional(),
    name: z.string().trim().min(1).max(100),
    expiresAt: z.string().datetime({ offset: true }).nullable(),
    serviceThrough: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    introduction: z
      .string()
      .trim()
      .max(180)
      .default("Our winter cleanout sale is here!"),
    retroactivePolicy: z
      .enum(["undecided", "new_quotes_only", "include_unaccepted_quotes"])
      .default("undecided"),
    stackingPolicy: z.enum(["undecided", "no_stacking"]).default("undecided"),
  })
  .strict();
export type CampaignTerms = z.infer<typeof CampaignTermsSchema>;
export type CampaignStatus =
  | "draft"
  | "active"
  | "paused"
  | "completed"
  | "cancelled";
export type CampaignRecipientPreview = {
  contactId: string;
  name: string;
  phone: string | null;
  reason: string | null;
  consentId: string | null;
  timeZone: string | null;
  body: string;
  segments: number;
};
export type CampaignReview = {
  id: string;
  campaignId: string;
  version: number;
  expiresAt: string;
  recipients: CampaignRecipientPreview[];
  segments: number;
  estimatedCost: number | null;
};
export type CampaignSummary = {
  id: string;
  version: number;
  status: CampaignStatus;
  terms: CampaignTerms;
  createdAt: string;
  updatedAt: string;
};
export type CampaignReadiness = {
  sendsEnabled: boolean;
  sender: string | null;
  blockers: string[];
  segmentPrice: number | null;
  testNumbers: string[];
};
export type CampaignRecipientResult = {
  id: string;
  contactId: string;
  name: string;
  phone: string;
  body: string;
  messageId: string | null;
  threadId: string | null;
  deliveryStatus: string;
  suppressionReason: string | null;
  repliedAt: string | null;
  isTest: boolean;
};
export type CampaignWorkspace = {
  campaigns: CampaignSummary[];
  readiness: CampaignReadiness;
  campaign: CampaignSummary | null;
  audience: CampaignRecipientPreview[];
  audienceTotal: number;
  audienceTruncated: boolean;
  recipients: CampaignRecipientResult[];
  metrics: {
    released: number;
    queued: number;
    submitted: number;
    delivered: number;
    failed: number;
    uncertain: number;
    suppressed: number;
    replied: number;
    optedOut: number;
  };
  outcomes: {
    quoted: number;
    quotedMinCents: number;
    quotedMaxCents: number;
    booked: number;
    bookedCents: number;
    collectedCents: number;
  } | null;
  resultsTruncated: boolean;
  capacity: {
    checkedAt: string;
    availableDates: string[];
    through: string | null;
    hasOpening: boolean;
  } | null;
};

/** The discount is applied to the real normal price, never a fabricated comparison price. */
export function winterSalePrice(normalCents: number) {
  if (
    !Number.isSafeInteger(normalCents) ||
    normalCents < 0 ||
    normalCents > 100_000_000
  )
    throw new Error("Invalid normal price");
  const discountCents = Math.round(
    (normalCents * WINTER_DISCOUNT_BPS) / 10_000,
  );
  return {
    normalCents,
    discountCents,
    finalCents: normalCents - discountCents,
    basisPoints: WINTER_DISCOUNT_BPS,
  };
}

const GSM_BASIC = new Set(
  Array.from(
    "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà",
  ),
);
const GSM_EXTENDED = new Set(Array.from("\f^{}\\[~]|€"));
export function smsSegments(body: string): number {
  let septets = 0;
  for (const c of body) {
    if (GSM_BASIC.has(c)) septets++;
    else if (GSM_EXTENDED.has(c)) septets += 2;
    else return body.length <= 70 ? 1 : Math.ceil(body.length / 67);
  }
  return septets <= 160 ? 1 : Math.ceil(septets / 153);
}
export function renderWinterCampaign(
  terms: CampaignTerms,
  firstName: string | null,
) {
  const name = (firstName ?? "")
    .replace(/[\r\n\t]/g, " ")
    .trim()
    .slice(0, 40);
  const greeting =
    name && !/^(unknown|contact|customer)$/i.test(name)
      ? `Hi ${name},`
      : "Hi there,";
  const deadline = terms.expiresAt
    ? new Intl.DateTimeFormat("en-US", {
        timeZone: CAMPAIGN_TIME_ZONE,
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      }).format(new Date(terms.expiresAt))
    : "[sale deadline needed]";
  const service = terms.serviceThrough ?? "[last pickup date needed]";
  return `${greeting} it's Stonegate Junk Removal. ${terms.introduction} Get 40% off all services. Book by ${deadline} for service by ${service}. Reply with photos for a quote. Reply STOP to opt out.`;
}
