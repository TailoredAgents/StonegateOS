import { z } from "zod";

export const PAYMENT_ASSOCIATION_CONFIRMATIONS = {
  attach: "ATTACH PAYMENT",
  detach: "DETACH PAYMENT",
} as const;

const ProviderNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[a-z][a-z0-9_-]*$/u)
  .transform((value) => value.toLowerCase());

const ProviderObjectIdSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

export const PaymentProviderBindingSchema = z
  .object({
    provider: ProviderNameSchema,
    providerPaymentId: ProviderObjectIdSchema.nullable(),
    providerOrderId: ProviderObjectIdSchema.nullable(),
    stripeChargeId: ProviderObjectIdSchema.nullable(),
  })
  .strict();

export type PaymentProviderBinding = z.infer<
  typeof PaymentProviderBindingSchema
>;

const ReviewNoteSchema = z.string().trim().min(3).max(500);

export const AttachLegacyPaymentRequestSchema = z
  .object({
    appointmentId: z.string().uuid(),
    jobAmountCents: z.number().int().nonnegative().max(100_000_000),
    tipCents: z.number().int().nonnegative().max(10_000_000),
    reviewNote: ReviewNoteSchema,
    confirmation: z.literal(PAYMENT_ASSOCIATION_CONFIRMATIONS.attach),
    paymentBinding: PaymentProviderBindingSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.paymentBinding.provider !== "stripe") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["paymentBinding", "provider"],
        message: "Only a Stripe payment can use the legacy attach workflow.",
      });
    }
    if (
      !value.paymentBinding.providerPaymentId &&
      !value.paymentBinding.stripeChargeId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["paymentBinding", "providerPaymentId"],
        message: "The Stripe provider identity is required.",
      });
    }
  });

export const DetachLegacyPaymentRequestSchema = z
  .object({
    expectedAppointmentId: z.string().uuid(),
    reviewNote: ReviewNoteSchema,
    confirmation: z.literal(PAYMENT_ASSOCIATION_CONFIRMATIONS.detach),
    paymentBinding: PaymentProviderBindingSchema,
  })
  .strict();

export type PaymentProviderIdentityRow = {
  provider: string;
  providerPaymentId: string | null;
  providerOrderId: string | null;
  stripeChargeId: string | null;
};

/**
 * Provider object IDs are compared exactly. Only the provider name is
 * normalized because it is a catalog value rather than an opaque provider ID.
 */
export function paymentProviderBindingMatches(
  row: PaymentProviderIdentityRow,
  binding: PaymentProviderBinding,
): boolean {
  return (
    row.provider.trim().toLowerCase() === binding.provider &&
    row.providerPaymentId === binding.providerPaymentId &&
    row.providerOrderId === binding.providerOrderId &&
    row.stripeChargeId === binding.stripeChargeId
  );
}

/** Always move an updated-at version forward, even under frozen test time. */
export function nextPaymentAssociationVersion(
  previous: Date,
  candidate = new Date(),
): Date {
  return new Date(Math.max(candidate.getTime(), previous.getTime() + 1));
}
