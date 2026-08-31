import { z } from "zod";
import {
  QuoteAudienceSchema,
  QuoteCapabilityActionSchema,
  QuoteDocumentTypeSchema,
  QuotePartySnapshotSchema,
  QuotePricingInputSchema,
  QuoteSchedulingModeSchema,
  QUOTE_V2_SCHEMA_VERSION,
} from "@/lib/quote-v2-domain";

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) =>
  z.string().trim().max(max).nullable().optional();
const optionalUuid = z.string().uuid().nullable().optional();

export const QuoteCompanySnapshotSchema = z
  .object({
    legalName: text(240),
    displayName: text(240),
    address: text(1_000),
    email: z.string().trim().email().max(320),
    phoneE164: z
      .string()
      .trim()
      .regex(/^\+[1-9]\d{7,14}$/u),
    website: z.string().trim().url().max(500).nullable().optional(),
    logoAssetId: optionalUuid,
    supportMessage: optionalText(500),
  })
  .strict();

export const QuoteTermsSnapshotSchema = z
  .object({
    templateId: optionalUuid,
    templateVersion: text(80),
    terms: text(20_000),
    paymentTerms: text(4_000),
    changeOrderRules: text(4_000),
    validityDays: z.number().int().min(1).max(120),
    consentVersion: text(80),
  })
  .strict();

export const QuoteDocumentSnapshotSchema = z
  .object({
    schemaVersion: z.literal(QUOTE_V2_SCHEMA_VERSION),
    documentType: QuoteDocumentTypeSchema,
    audience: QuoteAudienceSchema,
    schedulingMode: QuoteSchedulingModeSchema,
    parties: QuotePartySnapshotSchema,
    issuer: QuoteCompanySnapshotSchema,
    scope: text(12_000),
    inclusions: z.array(text(1_000)).max(50).default([]),
    exclusions: z.array(text(1_000)).max(50).default([]),
    assumptions: z.array(text(1_000)).max(50).default([]),
    pricing: QuotePricingInputSchema,
    terms: QuoteTermsSnapshotSchema,
    estimatedDurationMinutes: z
      .number()
      .int()
      .min(15)
      .max(30 * 24 * 60),
    serviceZoneId: optionalText(120),
    serviceZoneConfirmed: z.boolean().default(false),
  })
  .strict();

export type QuoteDocumentSnapshot = z.infer<typeof QuoteDocumentSnapshotSchema>;

const QuoteDraftLineItemSchema = z
  .object({
    id: text(80),
    catalogKey: optionalText(120),
    name: z.string().trim().max(240),
    description: optionalText(2_000),
    quantity: z.number().finite().min(0).max(1_000_000),
    unit: z.string().trim().max(40),
    // -1 is an explicit client-side "not entered" sentinel. It is accepted
    // only inside draft JSON and cannot be materialized into finalized rows.
    unitPriceMinCents: z.number().int().min(-1).max(100_000_000),
    unitPriceMaxCents: z
      .number()
      .int()
      .min(-1)
      .max(100_000_000)
      .nullable()
      .optional(),
    optionGroupId: optionalText(80),
    selectedByDefault: z.boolean().default(false),
    displayOrder: z.number().int().min(0).max(10_000),
  })
  .strict();

const QuoteDraftOptionGroupSchema = z
  .object({
    id: text(80),
    label: z.string().trim().max(200),
    mode: z.enum(["single", "multiple"]),
    minimumSelections: z.number().int().min(0).max(100),
    maximumSelections: z.number().int().min(0).max(100),
  })
  .strict();

const QuoteDraftAdjustmentSchema = z
  .object({
    id: text(80),
    kind: z.enum(["discount", "fee", "travel"]),
    label: z.string().trim().max(240),
    calculation: z.enum(["fixed", "percentage"]),
    basis: z.enum(["subtotal", "line_items"]).default("subtotal"),
    eligibleLineItemIds: z.array(text(80)).max(100).default([]),
    amountCents: z
      .number()
      .int()
      .min(-1)
      .max(100_000_000)
      .nullable()
      .optional(),
    basisPoints: z.number().int().min(0).max(10_000).nullable().optional(),
    displayOrder: z.number().int().min(0).max(10_000),
  })
  .strict();

const QuoteDraftDepositSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }).strict(),
  z
    .object({
      mode: z.literal("fixed"),
      amountCents: z.number().int().min(-1).max(100_000_000),
    })
    .strict(),
  z
    .object({
      mode: z.literal("percentage"),
      basisPoints: z.number().int().min(0).max(10_000),
    })
    .strict(),
]);

export const QuoteDraftPricingSchema = z
  .object({
    documentType: QuoteDocumentTypeSchema,
    currency: z.literal("USD").default("USD"),
    lineItems: z.array(QuoteDraftLineItemSchema).max(100).default([]),
    optionGroups: z.array(QuoteDraftOptionGroupSchema).max(20).default([]),
    adjustments: z.array(QuoteDraftAdjustmentSchema).max(30).default([]),
    deposit: QuoteDraftDepositSchema.default({ mode: "none" }),
  })
  .strict();

const QuoteDraftTermsSchema = z
  .object({
    templateId: optionalUuid,
    templateVersion: z.string().trim().max(80).optional(),
    terms: z.string().trim().max(20_000).optional(),
    paymentTerms: z.string().trim().max(4_000).optional(),
    changeOrderRules: z.string().trim().max(4_000).optional(),
    validityDays: z.number().int().min(0).max(120).optional(),
    consentVersion: z.string().trim().max(80).optional(),
  })
  .strict();

/** A bounded progressive document shape used only while a version is draft. */
export const QuoteDraftDocumentSchema = z
  .object({
    schemaVersion: z.literal(QUOTE_V2_SCHEMA_VERSION),
    documentType: QuoteDocumentTypeSchema,
    audience: QuoteAudienceSchema,
    schedulingMode: QuoteSchedulingModeSchema,
    parties: QuotePartySnapshotSchema.partial().default({}),
    issuer: QuoteCompanySnapshotSchema.partial().default({}),
    scope: z.string().trim().max(12_000).default(""),
    inclusions: z.array(z.string().trim().max(1_000)).max(50).default([]),
    exclusions: z.array(z.string().trim().max(1_000)).max(50).default([]),
    assumptions: z.array(z.string().trim().max(1_000)).max(50).default([]),
    pricing: QuoteDraftPricingSchema,
    terms: QuoteDraftTermsSchema.default({}),
    estimatedDurationMinutes: z
      .number()
      .int()
      .min(0)
      .max(30 * 24 * 60)
      .nullable()
      .optional(),
    serviceZoneId: optionalText(120),
    serviceZoneConfirmed: z.boolean().default(false),
  })
  .strict();

export const QuoteV2CreateCommandSchema = z
  .object({
    confirmation: z.literal("create_quote_v2"),
    contactId: z.string().uuid(),
    propertyId: z.string().uuid(),
    leadId: optionalUuid,
    projectName: text(240),
    projectReference: optionalText(160),
    audience: QuoteAudienceSchema,
    documentType: QuoteDocumentTypeSchema,
    schedulingMode: QuoteSchedulingModeSchema,
  })
  .strict();

export const QuoteV2SaveDraftCommandSchema = z
  .object({
    confirmation: z.literal("save_quote_draft"),
    versionId: z.string().uuid(),
    draftRevision: z.number().int().positive(),
    document: QuoteDraftDocumentSchema,
    internalNotes: optionalText(8_000),
  })
  .strict();

export const QuoteV2FinalizeCommandSchema = z
  .object({
    confirmation: z.literal("finalize_quote_version"),
    draftRevision: z.number().int().positive(),
  })
  .strict();

export const QuoteV2RevisionCommandSchema = z
  .object({
    confirmation: z.literal("create_quote_revision"),
    sourceVersionId: z.string().uuid(),
    quoteRevision: z.number().int().positive(),
    reason: text(1_000),
  })
  .strict();

export const QuoteV2StaffDecisionSourceSchema = z.enum([
  "phone",
  "email",
  "in_person",
  "written_confirmation",
  "other",
]);

const QuoteV2StaffDeclineSignerSchema = z
  .object({
    name: text(240),
    title: optionalText(160),
    company: optionalText(240),
  })
  .strict();

const QuoteV2StaffAcceptanceSignerSchema = z
  .object({
    name: text(240),
    title: text(160),
    company: optionalText(240),
    authorityAffirmed: z.literal(true),
  })
  .strict();

export const QuoteV2StaffDecisionCommandSchema = z.discriminatedUnion(
  "decision",
  [
    z
      .object({
        confirmation: z.literal("record_quote_v2_decision"),
        quoteId: z.string().uuid(),
        versionId: z.string().uuid(),
        quoteRevision: z.number().int().positive(),
        decision: z.literal("accepted"),
        source: QuoteV2StaffDecisionSourceSchema,
        notes: text(2_000),
        signer: QuoteV2StaffAcceptanceSignerSchema,
        selectedOptionIds: z.array(text(80)).max(100).default([]),
        consentVersion: text(80),
        consentAffirmed: z.literal(true),
        notifyCustomer: z.boolean().default(false),
      })
      .strict(),
    z
      .object({
        confirmation: z.literal("record_quote_v2_decision"),
        quoteId: z.string().uuid(),
        versionId: z.string().uuid(),
        quoteRevision: z.number().int().positive(),
        decision: z.literal("declined"),
        source: QuoteV2StaffDecisionSourceSchema,
        notes: text(2_000),
        signer: QuoteV2StaffDeclineSignerSchema,
        category: z.enum(["price", "scope", "timing", "competitor", "other"]),
        notifyCustomer: z.boolean().default(false),
      })
      .strict(),
  ],
);

const QuoteV2ChangeResolutionBaseSchema = z.object({
  confirmation: z.literal("resolve_quote_change_request"),
  quoteId: z.string().uuid(),
  quoteVersionId: z.string().uuid(),
  quoteRevision: z.number().int().positive(),
  resolutionNote: text(2_000),
  notifyCustomer: z.boolean().default(false),
});

export const QuoteV2ChangeResolutionCommandSchema = z.discriminatedUnion(
  "resolution",
  [
    QuoteV2ChangeResolutionBaseSchema.extend({
      resolution: z.literal("revision"),
      replacementVersionId: z.string().uuid(),
    }).strict(),
    QuoteV2ChangeResolutionBaseSchema.extend({
      resolution: z.literal("reopen_unchanged"),
    }).strict(),
  ],
);

export const QuoteV2VoidCommandSchema = z
  .object({
    confirmation: z.literal("void_quote_v2"),
    versionId: z.string().uuid(),
    quoteRevision: z.number().int().positive(),
    reason: text(2_000),
    notifyCustomer: z.boolean().default(false),
  })
  .strict();

export const QuoteV2ArchiveCommandSchema = z
  .object({
    confirmation: z.literal("archive_quote_v2"),
    versionId: z.string().uuid(),
    quoteRevision: z.number().int().positive(),
    reason: text(2_000),
    notifyCustomer: z.boolean().default(false),
  })
  .strict();

export const QuoteRecipientSchema = z
  .object({
    role: z.enum(["signer", "cc", "bcc"]),
    name: text(240),
    email: z.string().trim().email().max(320).nullable().optional(),
    phoneE164: z
      .string()
      .trim()
      .regex(/^\+[1-9]\d{7,14}$/u)
      .nullable()
      .optional(),
    channels: z
      .array(z.enum(["email", "sms"]))
      .min(1)
      .max(2),
  })
  .strict()
  .superRefine((recipient, context) => {
    if (new Set(recipient.channels).size !== recipient.channels.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["channels"],
        message: "A delivery channel cannot be selected twice.",
      });
    }
    if (recipient.channels.includes("email") && !recipient.email) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["email"],
        message: "An email address is required for email delivery.",
      });
    }
    if (recipient.channels.includes("sms") && !recipient.phoneE164) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["phoneE164"],
        message: "A mobile number is required for SMS delivery.",
      });
    }
  });

export const QuoteV2IssueCommandSchema = z
  .object({
    confirmation: z.literal("issue_quote_version"),
    quoteRevision: z.number().int().positive(),
    recipients: z.array(QuoteRecipientSchema).min(1).max(20),
    coverMessage: optionalText(4_000),
    sendNow: z.boolean().default(true),
  })
  .strict()
  .superRefine((command, context) => {
    const signerCount = command.recipients.filter(
      (recipient) => recipient.role === "signer",
    ).length;
    if (signerCount !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recipients"],
        message: "Exactly one recipient must be the designated signer.",
      });
    }
  });

export const QuoteV2SendAttemptCommandSchema = z
  .object({
    confirmation: z.literal("send_quote_version"),
    quoteRevision: z.number().int().positive(),
    recipients: z.array(QuoteRecipientSchema).max(20).default([]),
    coverMessage: optionalText(4_000),
    retryDeliveryIds: z.array(z.string().uuid()).max(20).default([]),
  })
  .strict()
  .superRefine((command, context) => {
    if (
      new Set(command.retryDeliveryIds).size !== command.retryDeliveryIds.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retryDeliveryIds"],
        message: "A failed delivery can be selected only once.",
      });
    }
    if (command.retryDeliveryIds.length > 0) {
      if (command.recipients.length > 0 || command.coverMessage) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["retryDeliveryIds"],
          message:
            "A delivery retry must preserve its original recipient and content.",
        });
      }
      return;
    }
    if (command.recipients.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recipients"],
        message: "Choose at least one recipient for a new send attempt.",
      });
      return;
    }
    const signerCount = command.recipients.filter(
      (recipient) => recipient.role === "signer",
    ).length;
    if (signerCount !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recipients"],
        message: "Exactly one recipient must be the designated signer.",
      });
    }
  });

export const QuoteV2ListQuerySchema = z
  .object({
    cursor: z.string().trim().min(1).max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(40),
    bucket: z
      .enum([
        "needs_action",
        "drafts",
        "awaiting_client",
        "accepted_booked",
        "closed",
      ])
      .optional(),
    search: z.string().trim().max(200).optional(),
    ownerId: z.string().uuid().optional(),
    sort: z
      .enum(["next_action", "updated_desc", "expiry_asc", "total_desc"])
      .default("next_action"),
  })
  .strict();

const publicIdentity = z
  .object({
    name: text(240),
    title: text(160),
    company: optionalText(240),
    authorityAffirmed: z.literal(true),
  })
  .strict();

export const PublicQuoteChangeCommandSchema = z
  .object({
    quoteId: z.string().uuid(),
    versionId: z.string().uuid(),
    category: z.enum(["scope", "pricing", "timing", "terms", "other"]),
    message: text(4_000),
  })
  .strict();

export const PublicQuoteRefreshCommandSchema = z
  .object({
    quoteId: z.string().uuid(),
    versionId: z.string().uuid(),
    message: optionalText(2_000),
  })
  .strict();

export const PublicQuoteDecisionCommandSchema = z.discriminatedUnion(
  "decision",
  [
    z
      .object({
        decision: z.literal("accepted"),
        quoteId: z.string().uuid(),
        versionId: z.string().uuid(),
        selectedOptionIds: z.array(text(80)).max(100).default([]),
        signer: publicIdentity,
        consentVersion: text(80),
        consentAffirmed: z.literal(true),
        requestedStartAt: z
          .string()
          .datetime({ offset: true })
          .nullable()
          .optional(),
        holdId: optionalUuid,
      })
      .strict(),
    z
      .object({
        decision: z.literal("declined"),
        quoteId: z.string().uuid(),
        versionId: z.string().uuid(),
        category: z.enum(["price", "scope", "timing", "competitor", "other"]),
        notes: optionalText(2_000),
        signerName: text(240),
      })
      .strict(),
  ],
);

export const PublicQuoteHoldCommandSchema = z
  .object({
    quoteId: z.string().uuid(),
    versionId: z.string().uuid(),
    responseId: z.string().uuid().nullable().optional(),
    startAt: z.string().datetime({ offset: true }),
    timezone: text(100),
  })
  .strict();

export const PublicQuoteCheckoutCommandSchema = z
  .object({
    quoteId: z.string().uuid(),
    versionId: z.string().uuid(),
    responseId: z.string().uuid(),
    holdId: optionalUuid,
  })
  .strict();

export const PublicQuoteBookingCommandSchema = z
  .object({
    quoteId: z.string().uuid(),
    versionId: z.string().uuid(),
    responseId: z.string().uuid(),
    holdId: optionalUuid,
  })
  .strict();

const PublicQuoteAppointmentWindowSchema = z
  .object({
    startAt: z.string().datetime({ offset: true }),
    endAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .refine(
    (window) => Date.parse(window.endAt) > Date.parse(window.startAt),
    "Appointment window end must be after its start.",
  );

export const PublicQuoteAppointmentSchema = z
  .object({
    id: z.string().uuid(),
    status: z.enum(["requested", "confirmed", "canceled", "completed"]),
    startAt: z.string().datetime({ offset: true }),
    endAt: z.string().datetime({ offset: true }),
    timezone: text(64),
    durationMinutes: z
      .number()
      .int()
      .min(1)
      .max(30 * 24 * 60),
    promisedArrivalWindow: PublicQuoteAppointmentWindowSchema.nullable(),
  })
  .strict()
  .refine(
    (appointment) =>
      Date.parse(appointment.endAt) > Date.parse(appointment.startAt),
    "Appointment end must be after its start.",
  );

export const PublicQuoteAvailabilitySlotSchema = z
  .object({
    startAt: z.string().datetime({ offset: true }),
    endAt: z.string().datetime({ offset: true }),
    label: text(160),
  })
  .strict()
  .refine(
    (slot) => Date.parse(slot.endAt) > Date.parse(slot.startAt),
    "Availability slot end must be after its start.",
  );

export const PublicQuoteAvailabilitySchema = z
  .object({
    state: z.enum(["available", "empty"]),
    quoteId: z.string().uuid(),
    versionId: z.string().uuid(),
    responseId: z.string().uuid().nullable(),
    timezone: text(64),
    durationMinutes: z
      .number()
      .int()
      .min(1)
      .max(30 * 24 * 60),
    travelBufferMinutes: z
      .number()
      .int()
      .min(0)
      .max(24 * 60),
    arrivalWindowMeaning: text(500),
    recommendedSlots: z.array(PublicQuoteAvailabilitySlotSchema).max(3),
    days: z
      .array(
        z
          .object({
            date: z.string().date(),
            slots: z.array(PublicQuoteAvailabilitySlotSchema).max(100),
          })
          .strict(),
      )
      .max(60),
    generatedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((availability, context) => {
    const hasAnySlot =
      availability.recommendedSlots.length > 0 ||
      availability.days.some((day) => day.slots.length > 0);
    if (
      availability.state === "available" &&
      availability.recommendedSlots.length === 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recommendedSlots"],
        message: "Available scheduling must include a recommended slot.",
      });
    }
    if (availability.state === "empty" && hasAnySlot) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recommendedSlots"],
        message: "Empty scheduling cannot include appointment slots.",
      });
    }
  });

export const PublicQuoteAvailabilityResponseSchema = z
  .object({ availability: PublicQuoteAvailabilitySchema })
  .strict();

export type PublicQuoteAvailability = z.infer<
  typeof PublicQuoteAvailabilitySchema
>;
export type PublicQuoteAvailabilityResponse = z.infer<
  typeof PublicQuoteAvailabilityResponseSchema
>;

export const PublicQuoteEnvelopeSchema = z
  .object({
    quoteId: z.string().uuid(),
    versionId: z.string().uuid(),
    versionNumber: z.number().int().positive(),
    quoteNumber: text(80),
    lifecycleState: text(80),
    displayState: text(120),
    document: QuoteDocumentSnapshotSchema,
    selectedOptionIds: z.array(text(80)),
    totals: z
      .object({
        subtotalMinCents: z.number().int().nonnegative(),
        subtotalMaxCents: z.number().int().nonnegative(),
        discountMinCents: z.number().int().nonnegative(),
        discountMaxCents: z.number().int().nonnegative(),
        feeMinCents: z.number().int().nonnegative(),
        feeMaxCents: z.number().int().nonnegative(),
        totalMinCents: z.number().int().positive(),
        totalMaxCents: z.number().int().positive(),
        depositCents: z.number().int().nonnegative(),
        balanceMinCents: z.number().int().nonnegative(),
        balanceMaxCents: z.number().int().nonnegative(),
      })
      .strict(),
    issuedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    allowedActions: z.array(QuoteCapabilityActionSchema),
    attachments: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            purpose: z.enum([
              "scope_evidence",
              "site_plan",
              "specification",
              "terms",
              "other",
            ]),
            caption: text(1_000).nullable(),
            fileName: text(240),
            mediaType: z.enum([
              "image/jpeg",
              "image/png",
              "image/webp",
              "image/heic",
              "application/pdf",
            ]),
            displayOrder: z.number().int().min(0).max(10_000),
          })
          .strict(),
      )
      .max(10)
      .optional(),
    acceptedResponseId: z.string().uuid().nullable(),
    acceptedAppointmentId: z.string().uuid().nullable(),
    appointment: PublicQuoteAppointmentSchema.nullable(),
  })
  .strict();

export const QuoteV2ErrorCodeSchema = z.enum([
  "unauthorized",
  "forbidden",
  "not_found",
  "gone",
  "conflict",
  "invalid",
  "rate_limited",
  "provider_unavailable",
  "internal",
]);

export const QuoteV2ErrorEnvelopeSchema = z
  .object({
    ok: z.literal(false),
    code: QuoteV2ErrorCodeSchema,
    message: text(1_000),
    fieldErrors: z.record(z.string().max(500)).optional(),
    retryable: z.boolean(),
    correlationId: text(128),
  })
  .strict();

export type QuoteV2ErrorCode = z.infer<typeof QuoteV2ErrorCodeSchema>;

export function quoteV2ErrorStatus(code: QuoteV2ErrorCode): number {
  return {
    unauthorized: 401,
    forbidden: 403,
    not_found: 404,
    gone: 410,
    conflict: 409,
    invalid: 422,
    rate_limited: 429,
    provider_unavailable: 503,
    internal: 500,
  }[code];
}
