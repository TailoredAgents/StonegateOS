import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  appointments,
  auditLogs,
  getDb,
  partnerBookings,
  partnerInvoices,
  partnerPaymentAllocations,
  paymentAttempts,
  payments,
} from "@/db";
import { sanitizeAuditMetadata } from "@/lib/audit-metadata";
import {
  canCollectAppointmentPayment,
  PAYMENT_MUTATION_BLOCKING_ATTEMPT_STATUSES,
} from "@/lib/payment-ledger";
import {
  createSquarePartnerHostedCheckoutProvider,
  isSafePartnerHostedCheckoutUrl,
  isSecurePartnerPaymentReturnUrl,
  PartnerHostedCheckoutProviderError,
  type PartnerHostedCheckoutProvider,
} from "@/lib/partner-hosted-checkout-provider";
import {
  createSquarePartnerEmbeddedPaymentProvider,
  PartnerEmbeddedPaymentProviderError,
  type PartnerEmbeddedPaymentProvider,
  type PartnerWebPaymentsConfiguration,
} from "@/lib/partner-embedded-payment-provider";
import { resolvePublicSiteBaseUrl } from "@/lib/partner-portal-auth";
import type { PortalV2StoredResult } from "@/lib/partner-portal-v2-idempotency";
import type { SquareAttemptReconciliationResult } from "@/lib/square-payments";
import type { TeamMutationTransaction } from "@/lib/team-mutation";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_PAYMENT_MINOR = 2_147_483_647;
const HOSTED_LINK_LIFETIME_MS = 180 * 24 * 60 * 60 * 1_000;
const EMBEDDED_INTENT_LIFETIME_MS = 20 * 60 * 1_000;
const MoneySchema = z
  .object({
    amountMinor: z.number().int().min(1).max(MAX_PAYMENT_MINOR),
    currency: z.literal("USD"),
    minorUnit: z.literal(2),
  })
  .strict();

export const PartnerPaymentIntentRequestSchema = z
  .object({
    invoiceId: z.string().uuid(),
    purpose: z.enum(["deposit", "one_off"]),
    paymentMethod: z.enum(["card", "ach"]),
    amount: MoneySchema,
  })
  .strict();

export const PartnerInvoicePaymentLinkRequestSchema = z
  .object({
    purpose: z.enum(["deposit", "one_off"]),
    paymentMethod: z.enum(["card", "ach"]),
    amount: MoneySchema,
  })
  .strict();

export const PartnerEmbeddedPaymentCompletionSchema = z
  .object({
    paymentMethod: z.enum(["card", "ach"]).default("card"),
    sourceToken: z
      .string()
      .trim()
      .min(8)
      .max(2_048)
      .refine(
        (value) =>
          ![...value].some((character) => {
            const point = character.codePointAt(0) ?? 0;
            return point < 32 || point === 127;
          }),
        "Invalid Square payment token",
      ),
  })
  .strict();

export type PartnerPaymentPurpose = "deposit" | "one_off";
export type PartnerPaymentIntentStatus =
  | "provisioning"
  | "ready"
  | "pending"
  | "succeeded"
  | "failed"
  | "canceled"
  | "expired"
  | "requires_review";

export type PartnerPaymentAttemptMetadata = Readonly<{
  schemaVersion: 1;
  partnerAccountId: string;
  partnerInvoiceId: string;
  partnerMembershipId: string;
  partnerUserId: string;
  purpose: PartnerPaymentPurpose;
  paymentMethod: "card" | "ach";
  checkoutMode: "hosted_redirect" | "embedded_card" | "embedded_ach";
  amountMinor: number;
  currency: "USD";
  minorUnit: 2;
  correlationId: string;
  idempotencyKeyHash: string;
  providerPaymentLinkId: string | null;
  checkoutUrl: string | null;
  providerCreatedAt: string | null;
  completionIdempotencyKeyHash?: string;
  allocationState?: "settled" | "needs_review";
  allocationError?: string;
}>;

type CreatePartnerPaymentInput = Readonly<{
  accountId: string;
  membershipId: string;
  partnerUserId: string;
  email: string;
  roleKey: string;
  sessionId: string;
  correlationId: string;
  idempotencyKeyHash: string;
  invoiceId: string;
  purpose: PartnerPaymentPurpose;
  amountMinor: number;
  currency: "USD";
  paymentMethod: "card";
  provider?: PartnerHostedCheckoutProvider;
}>;

type CreatePartnerEmbeddedPaymentInput = Readonly<{
  accountId: string;
  membershipId: string;
  partnerUserId: string;
  email: string;
  roleKey: string;
  sessionId: string;
  correlationId: string;
  idempotencyKeyHash: string;
  invoiceId: string;
  purpose: PartnerPaymentPurpose;
  amountMinor: number;
  currency: "USD";
  paymentMethod: "card" | "ach";
  provider?: PartnerEmbeddedPaymentProvider;
}>;

type CompletePartnerEmbeddedPaymentInput = Readonly<{
  accountId: string;
  membershipId: string;
  partnerUserId: string;
  email: string;
  roleKey: string;
  sessionId: string;
  correlationId: string;
  idempotencyKeyHash: string;
  paymentIntentId: string;
  sourceToken: string;
  paymentMethod: "card" | "ach";
  provider?: PartnerEmbeddedPaymentProvider;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeProviderIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 255 &&
    ![...value].some((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point < 32 || point === 127;
    })
  );
}

function isEmbeddedCheckoutMode(
  value: string,
): value is "embedded_card" | "embedded_ach" {
  return value === "embedded_card" || value === "embedded_ach";
}

export function parsePartnerPaymentAttemptMetadata(
  value: unknown,
): PartnerPaymentAttemptMetadata | null {
  if (!isRecord(value)) return null;
  const candidate = value["partnerPortalPayment"];
  if (!isRecord(candidate)) return null;
  const allocationState = candidate["allocationState"];
  const allocationError = candidate["allocationError"];
  const checkoutUrl = candidate["checkoutUrl"];
  const providerPaymentLinkId = candidate["providerPaymentLinkId"];
  const providerCreatedAt = candidate["providerCreatedAt"];
  const completionIdempotencyKeyHash =
    candidate["completionIdempotencyKeyHash"];
  if (
    candidate["schemaVersion"] !== 1 ||
    typeof candidate["partnerAccountId"] !== "string" ||
    !UUID_PATTERN.test(candidate["partnerAccountId"]) ||
    typeof candidate["partnerInvoiceId"] !== "string" ||
    !UUID_PATTERN.test(candidate["partnerInvoiceId"]) ||
    typeof candidate["partnerMembershipId"] !== "string" ||
    !UUID_PATTERN.test(candidate["partnerMembershipId"]) ||
    typeof candidate["partnerUserId"] !== "string" ||
    !UUID_PATTERN.test(candidate["partnerUserId"]) ||
    (candidate["purpose"] !== "deposit" &&
      candidate["purpose"] !== "one_off") ||
    (candidate["paymentMethod"] !== "card" &&
      candidate["paymentMethod"] !== "ach") ||
    (candidate["checkoutMode"] !== "hosted_redirect" &&
      candidate["checkoutMode"] !== "embedded_card" &&
      candidate["checkoutMode"] !== "embedded_ach") ||
    (candidate["checkoutMode"] === "hosted_redirect" &&
      candidate["paymentMethod"] !== "card") ||
    (candidate["checkoutMode"] === "embedded_card" &&
      candidate["paymentMethod"] !== "card") ||
    (candidate["checkoutMode"] === "embedded_ach" &&
      candidate["paymentMethod"] !== "ach") ||
    typeof candidate["amountMinor"] !== "number" ||
    !Number.isSafeInteger(candidate["amountMinor"]) ||
    candidate["amountMinor"] <= 0 ||
    candidate["amountMinor"] > MAX_PAYMENT_MINOR ||
    candidate["currency"] !== "USD" ||
    candidate["minorUnit"] !== 2 ||
    typeof candidate["correlationId"] !== "string" ||
    candidate["correlationId"].length < 8 ||
    candidate["correlationId"].length > 128 ||
    typeof candidate["idempotencyKeyHash"] !== "string" ||
    !/^[0-9a-f]{64}$/u.test(candidate["idempotencyKeyHash"]) ||
    !(candidate["checkoutMode"] === "hosted_redirect"
      ? (providerPaymentLinkId === null ||
          safeProviderIdentifier(providerPaymentLinkId)) &&
        (checkoutUrl === null || isSafePartnerHostedCheckoutUrl(checkoutUrl))
      : providerPaymentLinkId === null && checkoutUrl === null) ||
    !(
      providerCreatedAt === null ||
      (typeof providerCreatedAt === "string" &&
        Number.isFinite(new Date(providerCreatedAt).getTime()))
    ) ||
    !(
      completionIdempotencyKeyHash === undefined ||
      (typeof completionIdempotencyKeyHash === "string" &&
        /^[0-9a-f]{64}$/u.test(completionIdempotencyKeyHash))
    ) ||
    !(
      allocationState === undefined ||
      allocationState === "settled" ||
      allocationState === "needs_review"
    ) ||
    !(
      allocationError === undefined ||
      (typeof allocationError === "string" &&
        allocationError.length > 0 &&
        allocationError.length <= 200)
    )
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    partnerAccountId: candidate["partnerAccountId"],
    partnerInvoiceId: candidate["partnerInvoiceId"],
    partnerMembershipId: candidate["partnerMembershipId"],
    partnerUserId: candidate["partnerUserId"],
    purpose: candidate["purpose"],
    paymentMethod: candidate["paymentMethod"],
    checkoutMode: candidate["checkoutMode"],
    amountMinor: candidate["amountMinor"],
    currency: "USD",
    minorUnit: 2,
    correlationId: candidate["correlationId"],
    idempotencyKeyHash: candidate["idempotencyKeyHash"],
    providerPaymentLinkId:
      typeof providerPaymentLinkId === "string" ? providerPaymentLinkId : null,
    checkoutUrl: typeof checkoutUrl === "string" ? checkoutUrl : null,
    providerCreatedAt:
      typeof providerCreatedAt === "string" ? providerCreatedAt : null,
    ...(typeof completionIdempotencyKeyHash === "string"
      ? { completionIdempotencyKeyHash }
      : {}),
    ...(allocationState === undefined ? {} : { allocationState }),
    ...(allocationError === undefined ? {} : { allocationError }),
  };
}

export function resolvePartnerInvoicePaymentAmount(input: {
  purpose: PartnerPaymentPurpose;
  requestedAmountMinor: number;
  invoice: {
    depositCents: number;
    paidCents: number;
    balanceCents: number;
  };
}):
  | { ok: true; amountMinor: number }
  | { ok: false; reason: "invalid_amount" | "deposit_unavailable" } {
  const { invoice } = input;
  if (
    !Number.isSafeInteger(input.requestedAmountMinor) ||
    input.requestedAmountMinor <= 0 ||
    input.requestedAmountMinor > MAX_PAYMENT_MINOR ||
    !Number.isSafeInteger(invoice.depositCents) ||
    !Number.isSafeInteger(invoice.paidCents) ||
    !Number.isSafeInteger(invoice.balanceCents) ||
    invoice.depositCents < 0 ||
    invoice.paidCents < 0 ||
    invoice.balanceCents <= 0
  ) {
    return { ok: false, reason: "invalid_amount" };
  }
  if (input.purpose === "deposit") {
    const amountMinor = Math.min(
      invoice.balanceCents,
      Math.max(invoice.depositCents - invoice.paidCents, 0),
    );
    if (amountMinor <= 0) {
      return { ok: false, reason: "deposit_unavailable" };
    }
    return input.requestedAmountMinor === amountMinor
      ? { ok: true, amountMinor }
      : { ok: false, reason: "invalid_amount" };
  }
  return input.requestedAmountMinor <= invoice.balanceCents
    ? { ok: true, amountMinor: input.requestedAmountMinor }
    : { ok: false, reason: "invalid_amount" };
}

/**
 * Embedded checkout is intentionally narrower than hosted invoice payment.
 * A deposit must match the configured outstanding deposit exactly. A one-off
 * must represent a configured 100% prepayment obligation and the full current
 * balance; ordinary issued invoice balances remain on Square-hosted pages.
 */
export function resolvePartnerEmbeddedPaymentAmount(input: {
  purpose: PartnerPaymentPurpose;
  requestedAmountMinor: number;
  invoice: {
    depositCents: number;
    totalCents: number;
    paidCents: number;
    balanceCents: number;
  };
}):
  | { ok: true; amountMinor: number }
  | {
      ok: false;
      reason:
        | "invalid_amount"
        | "deposit_unavailable"
        | "hosted_invoice_required";
    } {
  if (input.purpose === "deposit") {
    return resolvePartnerInvoicePaymentAmount(input);
  }
  if (
    input.invoice.depositCents !== input.invoice.totalCents ||
    input.requestedAmountMinor !== input.invoice.balanceCents
  ) {
    return { ok: false, reason: "hosted_invoice_required" };
  }
  return resolvePartnerInvoicePaymentAmount(input);
}

export function derivePartnerPaymentIntentStatus(input: {
  attemptStatus: string;
  expiresAt: Date;
  paymentCanonicalStatus?: string | null;
  paymentProviderStatus?: string | null;
  paymentTenderType?: string | null;
  allocationState?: string | null;
  now?: Date;
}): PartnerPaymentIntentStatus {
  const canonical = input.paymentCanonicalStatus?.trim().toLowerCase() ?? "";
  const provider = input.paymentProviderStatus?.trim().toLowerCase() ?? "";
  const tender = input.paymentTenderType?.trim().toLowerCase() ?? "";
  if (
    input.allocationState === "settled" &&
    (canonical === "completed" || provider === "completed")
  ) {
    return "succeeded";
  }
  if (
    canonical === "pending" ||
    provider === "pending" ||
    ((tender === "bank_account" || tender === "ach") &&
      canonical !== "completed" &&
      provider !== "completed")
  ) {
    return "pending";
  }
  if (input.attemptStatus === "pending_verification") return "pending";
  if (input.attemptStatus === "created") return "provisioning";
  if (input.attemptStatus === "launched") {
    return input.expiresAt <= (input.now ?? new Date()) ? "expired" : "ready";
  }
  if (input.attemptStatus === "failed") return "failed";
  if (input.attemptStatus === "canceled") return "canceled";
  if (input.attemptStatus === "expired") return "expired";
  return "requires_review";
}

export function resolvePartnerPaymentReturnUrl(
  paymentIntentId: string,
): string | null {
  if (!UUID_PATTERN.test(paymentIntentId)) return null;
  const configured = resolvePublicSiteBaseUrl();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if (!isSecurePartnerPaymentReturnUrl(url.toString())) return null;
    url.pathname = "/partners/billing";
    url.search = "";
    url.searchParams.set("paymentIntentId", paymentIntentId);
    return isSecurePartnerPaymentReturnUrl(url.toString())
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function paymentIntentDto(input: {
  id: string;
  invoiceId: string;
  purpose: PartnerPaymentPurpose;
  amountMinor: number;
  status: PartnerPaymentIntentStatus;
  paymentMethod?: "card" | "ach";
  checkoutUrl: string | null;
  checkoutMode?: "hosted_redirect" | "embedded_card" | "embedded_ach";
  webPayments?: PartnerWebPaymentsConfiguration | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}) {
  return {
    id: input.id,
    invoiceId: input.invoiceId,
    purpose: input.purpose,
    paymentMethod: input.paymentMethod ?? ("card" as const),
    status: input.status,
    amount: {
      amountMinor: input.amountMinor,
      currency: "USD" as const,
      minorUnit: 2 as const,
    },
    checkout: isEmbeddedCheckoutMode(input.checkoutMode ?? "hosted_redirect")
      ? {
          mode: input.checkoutMode as "embedded_card" | "embedded_ach",
          url: null,
          embedded: true,
        }
      : {
          mode: "hosted_redirect" as const,
          url: input.status === "ready" ? input.checkoutUrl : null,
          embedded: false,
        },
    webPayments: isEmbeddedCheckoutMode(input.checkoutMode ?? "hosted_redirect")
      ? (input.webPayments ?? null)
      : null,
    createdAt: input.createdAt.toISOString(),
    updatedAt: input.updatedAt.toISOString(),
    expiresAt: input.expiresAt.toISOString(),
  };
}

function failure(
  status: number,
  error:
    | "not_found"
    | "invalid_fields"
    | "conflict"
    | "review_required"
    | "service_unavailable",
): PortalV2StoredResult {
  return { status, body: { ok: false, error } };
}

async function insertPartnerPaymentAudit(input: {
  actorType: "human" | "system";
  partnerUserId?: string;
  email?: string;
  roleKey?: string;
  sessionId?: string;
  correlationId: string;
  idempotencyKeyHash?: string;
  outcome: "succeeded" | "failed";
  action: string;
  invoiceId: string;
  meta: Record<string, unknown>;
  tx?: TeamMutationTransaction;
}): Promise<void> {
  const database = input.tx ?? getDb();
  await database.insert(auditLogs).values({
    id: randomUUID(),
    actorType: input.actorType,
    actorId: input.partnerUserId ?? null,
    actorLabel: input.email ?? null,
    actorRole: input.roleKey ?? null,
    sessionId: input.sessionId ?? null,
    authMethod: input.actorType === "human" ? "partner_session" : "service",
    correlationId: input.correlationId,
    requiredPermissions: ["payments.initiate"],
    outcome: input.outcome,
    surface: "/partners/billing",
    idempotencyKeyHash: input.idempotencyKeyHash ?? null,
    action: input.action,
    entityType: "partner_invoice",
    entityId: input.invoiceId,
    meta: sanitizeAuditMetadata(input.meta),
  });
}

export async function createPartnerHostedPaymentIntent(
  input: CreatePartnerPaymentInput,
): Promise<PortalV2StoredResult> {
  const intentId = randomUUID();
  const returnUrl = resolvePartnerPaymentReturnUrl(intentId);
  if (!returnUrl) return failure(503, "service_unavailable");
  let provider: PartnerHostedCheckoutProvider;
  try {
    provider = input.provider ?? createSquarePartnerHostedCheckoutProvider();
  } catch {
    return failure(503, "service_unavailable");
  }
  const now = new Date();
  const expiresAt = new Date(now.getTime() + HOSTED_LINK_LIFETIME_MS);
  const db = getDb();
  const prepared = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('partner_invoice_payment'), hashtext(${input.invoiceId}))`,
    );
    const [invoice] = await tx
      .select({
        id: partnerInvoices.id,
        accountId: partnerInvoices.partnerAccountId,
        partnerBookingId: partnerInvoices.partnerBookingId,
        invoiceNumber: partnerInvoices.invoiceNumber,
        status: partnerInvoices.status,
        currency: partnerInvoices.currency,
        depositCents: partnerInvoices.depositCents,
        totalCents: partnerInvoices.totalCents,
        paidCents: partnerInvoices.paidCents,
        balanceCents: partnerInvoices.balanceCents,
        provider: partnerInvoices.provider,
        version: partnerInvoices.version,
        updatedAt: partnerInvoices.updatedAt,
      })
      .from(partnerInvoices)
      .where(
        and(
          eq(partnerInvoices.id, input.invoiceId),
          eq(partnerInvoices.partnerAccountId, input.accountId),
        ),
      )
      .for("update")
      .limit(1);
    if (!invoice)
      return { kind: "failure" as const, result: failure(404, "not_found") };
    if (!invoice.partnerBookingId) {
      return {
        kind: "failure" as const,
        result: failure(422, "review_required"),
      };
    }
    const [job] = await tx
      .select({
        appointmentId: partnerBookings.appointmentId,
        status: appointments.status,
        type: appointments.type,
      })
      .from(partnerBookings)
      .innerJoin(
        appointments,
        eq(appointments.id, partnerBookings.appointmentId),
      )
      .where(
        and(
          eq(partnerBookings.id, invoice.partnerBookingId),
          eq(partnerBookings.partnerAccountId, input.accountId),
        ),
      )
      .limit(1);
    if (!job) {
      return {
        kind: "failure" as const,
        result: failure(422, "review_required"),
      };
    }
    if (
      !["issued", "partially_paid", "overdue"].includes(invoice.status) ||
      invoice.balanceCents <= 0 ||
      invoice.totalCents !== invoice.paidCents + invoice.balanceCents ||
      !canCollectAppointmentPayment(job.status, job.type)
    ) {
      return { kind: "failure" as const, result: failure(409, "conflict") };
    }
    if (
      invoice.currency !== "USD" ||
      input.currency !== invoice.currency ||
      (invoice.provider !== null && invoice.provider !== "square")
    ) {
      return {
        kind: "failure" as const,
        result: failure(422, "review_required"),
      };
    }
    const amount = resolvePartnerInvoicePaymentAmount({
      purpose: input.purpose,
      requestedAmountMinor: input.amountMinor,
      invoice,
    });
    if (!amount.ok) {
      return {
        kind: "failure" as const,
        result: failure(422, "invalid_fields"),
      };
    }

    const attempts = await tx
      .select({
        id: paymentAttempts.id,
        status: paymentAttempts.status,
        requestedJobAmountCents: paymentAttempts.requestedJobAmountCents,
        currency: paymentAttempts.currency,
        metadata: paymentAttempts.metadata,
        createdAt: paymentAttempts.createdAt,
        updatedAt: paymentAttempts.updatedAt,
        expiresAt: paymentAttempts.expiresAt,
      })
      .from(paymentAttempts)
      .where(
        and(
          eq(paymentAttempts.appointmentId, job.appointmentId),
          eq(paymentAttempts.provider, "square"),
          inArray(paymentAttempts.status, [
            ...PAYMENT_MUTATION_BLOCKING_ATTEMPT_STATUSES,
          ]),
        ),
      )
      .orderBy(desc(paymentAttempts.updatedAt))
      .for("update");
    for (const attempt of attempts) {
      const metadata = parsePartnerPaymentAttemptMetadata(attempt.metadata);
      if (
        metadata !== null &&
        isEmbeddedCheckoutMode(metadata.checkoutMode) &&
        !metadata.completionIdempotencyKeyHash &&
        (attempt.status === "created" || attempt.status === "launched") &&
        attempt.expiresAt <= now
      ) {
        await tx
          .update(paymentAttempts)
          .set({
            status: "failed",
            errorCode: "embedded_intent_expired_unsubmitted",
            resolvedAt: now,
            updatedAt: now,
          })
          .where(eq(paymentAttempts.id, attempt.id));
        continue;
      }
      if (
        attempt.status === "launched" &&
        metadata?.partnerAccountId === input.accountId &&
        metadata.partnerInvoiceId === input.invoiceId &&
        metadata.purpose === input.purpose &&
        metadata.amountMinor === amount.amountMinor &&
        metadata.checkoutUrl &&
        attempt.expiresAt > now
      ) {
        return {
          kind: "existing" as const,
          paymentIntent: paymentIntentDto({
            id: attempt.id,
            invoiceId: input.invoiceId,
            purpose: input.purpose,
            amountMinor: amount.amountMinor,
            status: "ready",
            checkoutUrl: metadata.checkoutUrl,
            createdAt: attempt.createdAt,
            updatedAt: attempt.updatedAt,
            expiresAt: attempt.expiresAt,
          }),
        };
      }
      return { kind: "failure" as const, result: failure(409, "conflict") };
    }

    const metadata: PartnerPaymentAttemptMetadata = {
      schemaVersion: 1,
      partnerAccountId: input.accountId,
      partnerInvoiceId: input.invoiceId,
      partnerMembershipId: input.membershipId,
      partnerUserId: input.partnerUserId,
      purpose: input.purpose,
      paymentMethod: "card",
      checkoutMode: "hosted_redirect",
      amountMinor: amount.amountMinor,
      currency: "USD",
      minorUnit: 2,
      correlationId: input.correlationId,
      idempotencyKeyHash: input.idempotencyKeyHash,
      providerPaymentLinkId: null,
      checkoutUrl: null,
      providerCreatedAt: null,
    };
    await tx.insert(paymentAttempts).values({
      id: intentId,
      appointmentId: job.appointmentId,
      provider: provider.provider,
      clientRequestId: intentId,
      status: "created",
      requestedJobAmountCents: amount.amountMinor,
      currency: "USD",
      squareLocationId: provider.locationId,
      expiresAt,
      metadata: { partnerPortalPayment: metadata },
      createdAt: now,
      updatedAt: now,
    });
    return {
      kind: "create" as const,
      invoice,
      partnerBookingId: invoice.partnerBookingId,
      appointmentId: job.appointmentId,
      amountMinor: amount.amountMinor,
      metadata,
    };
  });

  if (prepared.kind === "failure") return prepared.result;
  if (prepared.kind === "existing") {
    return {
      status: 200,
      body: {
        ok: true,
        paymentIntent: prepared.paymentIntent,
        paymentLink: prepared.paymentIntent.checkout,
        reused: true,
      },
    };
  }

  let hostedCheckout;
  try {
    hostedCheckout = await provider.createHostedCheckout({
      intentId,
      invoiceId: input.invoiceId,
      invoiceNumber: prepared.invoice.invoiceNumber,
      amountMinor: prepared.amountMinor,
      currency: "USD",
      redirectUrl: returnUrl,
    });
  } catch (error) {
    const providerFailure =
      error instanceof PartnerHostedCheckoutProviderError ? error : null;
    const indeterminate = !providerFailure || providerFailure.retryable;
    await db.transaction(async (tx) => {
      await tx
        .update(paymentAttempts)
        .set({
          status: indeterminate ? "created" : "failed",
          errorCode: providerFailure?.code ?? "provider_request_indeterminate",
          errorMessage: null,
          ...(indeterminate ? {} : { resolvedAt: new Date() }),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(paymentAttempts.id, intentId),
            eq(paymentAttempts.status, "created"),
          ),
        );
      await insertPartnerPaymentAudit({
        tx,
        actorType: "human",
        partnerUserId: input.partnerUserId,
        email: input.email,
        roleKey: input.roleKey,
        sessionId: input.sessionId,
        correlationId: input.correlationId,
        idempotencyKeyHash: input.idempotencyKeyHash,
        outcome: "failed",
        action: "partner.payment.checkout_link_failed",
        invoiceId: input.invoiceId,
        meta: {
          partnerAccountId: input.accountId,
          partnerMembershipId: input.membershipId,
          paymentIntentId: intentId,
          purpose: input.purpose,
          amountMinor: prepared.amountMinor,
          provider: provider.provider,
          indeterminate,
          providerFailureCode:
            providerFailure?.code ?? "provider_request_indeterminate",
        },
      });
    });
    return failure(503, "service_unavailable");
  }

  const committedAt = new Date();
  const metadata: PartnerPaymentAttemptMetadata = {
    ...prepared.metadata,
    providerPaymentLinkId: hostedCheckout.providerLinkId,
    checkoutUrl: hostedCheckout.url,
    providerCreatedAt: hostedCheckout.createdAt,
  };
  let committed = false;
  try {
    committed = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext('partner_invoice_payment'), hashtext(${input.invoiceId}))`,
      );
      const [currentAttempt] = await tx
        .select({ status: paymentAttempts.status })
        .from(paymentAttempts)
        .where(eq(paymentAttempts.id, intentId))
        .for("update")
        .limit(1);
      const [currentInvoice] = await tx
        .select({
          version: partnerInvoices.version,
          updatedAt: partnerInvoices.updatedAt,
        })
        .from(partnerInvoices)
        .where(
          and(
            eq(partnerInvoices.id, input.invoiceId),
            eq(partnerInvoices.partnerAccountId, input.accountId),
          ),
        )
        .for("update")
        .limit(1);
      const [currentJob] = await tx
        .select({
          status: appointments.status,
          type: appointments.type,
        })
        .from(partnerBookings)
        .innerJoin(
          appointments,
          eq(appointments.id, partnerBookings.appointmentId),
        )
        .where(
          and(
            eq(partnerBookings.id, prepared.partnerBookingId),
            eq(partnerBookings.partnerAccountId, input.accountId),
            eq(partnerBookings.appointmentId, prepared.appointmentId),
          ),
        )
        .for("update")
        .limit(1);
      if (
        currentAttempt?.status !== "created" ||
        !currentInvoice ||
        !currentJob ||
        !canCollectAppointmentPayment(currentJob.status, currentJob.type) ||
        currentInvoice.version !== prepared.invoice.version ||
        currentInvoice.updatedAt.getTime() !==
          prepared.invoice.updatedAt.getTime()
      ) {
        return false;
      }
      const [attemptUpdated] = await tx
        .update(paymentAttempts)
        .set({
          status: "launched",
          providerOrderId: hostedCheckout.providerOrderId,
          metadata: { partnerPortalPayment: metadata },
          updatedAt: committedAt,
        })
        .where(
          and(
            eq(paymentAttempts.id, intentId),
            eq(paymentAttempts.status, "created"),
          ),
        )
        .returning({ id: paymentAttempts.id });
      const [invoiceUpdated] = await tx
        .update(partnerInvoices)
        .set({
          provider: hostedCheckout.provider,
          providerOrderId: hostedCheckout.providerOrderId,
          hostedPaymentUrl: hostedCheckout.url,
          version: prepared.invoice.version + 1,
          updatedAt: committedAt,
        })
        .where(
          and(
            eq(partnerInvoices.id, input.invoiceId),
            eq(partnerInvoices.partnerAccountId, input.accountId),
            eq(partnerInvoices.version, prepared.invoice.version),
          ),
        )
        .returning({ id: partnerInvoices.id });
      if (!attemptUpdated || !invoiceUpdated) {
        throw new Error("partner_payment_link_commit_conflict");
      }
      await insertPartnerPaymentAudit({
        tx,
        actorType: "human",
        partnerUserId: input.partnerUserId,
        email: input.email,
        roleKey: input.roleKey,
        sessionId: input.sessionId,
        correlationId: input.correlationId,
        idempotencyKeyHash: input.idempotencyKeyHash,
        outcome: "succeeded",
        action: "partner.payment.checkout_link_created",
        invoiceId: input.invoiceId,
        meta: {
          partnerAccountId: input.accountId,
          partnerMembershipId: input.membershipId,
          paymentIntentId: intentId,
          purpose: input.purpose,
          amountMinor: prepared.amountMinor,
          provider: hostedCheckout.provider,
          providerOrderId: hostedCheckout.providerOrderId,
          providerPaymentLinkId: hostedCheckout.providerLinkId,
        },
      });
      return true;
    });
  } catch {
    committed = false;
  }
  if (!committed) {
    const preserveProviderReference = async () =>
      db
        .update(paymentAttempts)
        .set({
          status: "pending_verification",
          providerOrderId: hostedCheckout.providerOrderId,
          metadata: { partnerPortalPayment: metadata },
          errorCode: "local_commit_conflict",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(paymentAttempts.id, intentId),
            eq(paymentAttempts.status, "created"),
          ),
        );
    try {
      await db.transaction(async (tx) => {
        await tx
          .update(paymentAttempts)
          .set({
            status: "pending_verification",
            providerOrderId: hostedCheckout.providerOrderId,
            metadata: { partnerPortalPayment: metadata },
            errorCode: "local_commit_conflict",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(paymentAttempts.id, intentId),
              eq(paymentAttempts.status, "created"),
            ),
          );
        await insertPartnerPaymentAudit({
          tx,
          actorType: "human",
          partnerUserId: input.partnerUserId,
          email: input.email,
          roleKey: input.roleKey,
          sessionId: input.sessionId,
          correlationId: input.correlationId,
          idempotencyKeyHash: input.idempotencyKeyHash,
          outcome: "failed",
          action: "partner.payment.checkout_link_commit_conflict",
          invoiceId: input.invoiceId,
          meta: {
            partnerAccountId: input.accountId,
            partnerMembershipId: input.membershipId,
            paymentIntentId: intentId,
            purpose: input.purpose,
            amountMinor: prepared.amountMinor,
            provider: hostedCheckout.provider,
            providerOrderId: hostedCheckout.providerOrderId,
            providerPaymentLinkId: hostedCheckout.providerLinkId,
          },
        });
      });
    } catch {
      // Preserving the provider order/link binding is the first recovery
      // boundary even if the best-effort audit insert is temporarily down.
      await preserveProviderReference();
    }
    return failure(503, "service_unavailable");
  }

  const paymentIntent = paymentIntentDto({
    id: intentId,
    invoiceId: input.invoiceId,
    purpose: input.purpose,
    amountMinor: prepared.amountMinor,
    status: "ready",
    checkoutUrl: hostedCheckout.url,
    createdAt: now,
    updatedAt: committedAt,
    expiresAt,
  });
  return {
    status: 201,
    body: {
      ok: true,
      paymentIntent,
      paymentLink: paymentIntent.checkout,
      reused: false,
    },
  };
}

export async function createPartnerEmbeddedPaymentIntent(
  input: CreatePartnerEmbeddedPaymentInput,
): Promise<PortalV2StoredResult> {
  let provider: PartnerEmbeddedPaymentProvider;
  try {
    provider = input.provider ?? createSquarePartnerEmbeddedPaymentProvider();
  } catch {
    return failure(503, "service_unavailable");
  }
  if (input.paymentMethod === "ach" && !provider.webPayments.methods.ach) {
    return failure(503, "service_unavailable");
  }
  const checkoutMode =
    input.paymentMethod === "ach" ? "embedded_ach" : "embedded_card";
  const intentId = randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + EMBEDDED_INTENT_LIFETIME_MS);
  const db = getDb();
  const prepared = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('partner_invoice_payment'), hashtext(${input.invoiceId}))`,
    );
    const [invoice] = await tx
      .select({
        id: partnerInvoices.id,
        partnerBookingId: partnerInvoices.partnerBookingId,
        invoiceNumber: partnerInvoices.invoiceNumber,
        status: partnerInvoices.status,
        currency: partnerInvoices.currency,
        depositCents: partnerInvoices.depositCents,
        totalCents: partnerInvoices.totalCents,
        paidCents: partnerInvoices.paidCents,
        balanceCents: partnerInvoices.balanceCents,
        provider: partnerInvoices.provider,
        version: partnerInvoices.version,
        updatedAt: partnerInvoices.updatedAt,
      })
      .from(partnerInvoices)
      .where(
        and(
          eq(partnerInvoices.id, input.invoiceId),
          eq(partnerInvoices.partnerAccountId, input.accountId),
        ),
      )
      .for("update")
      .limit(1);
    if (!invoice) {
      return { kind: "failure" as const, result: failure(404, "not_found") };
    }
    if (!invoice.partnerBookingId) {
      return {
        kind: "failure" as const,
        result: failure(422, "review_required"),
      };
    }
    const [job] = await tx
      .select({
        appointmentId: partnerBookings.appointmentId,
        status: appointments.status,
        type: appointments.type,
      })
      .from(partnerBookings)
      .innerJoin(
        appointments,
        eq(appointments.id, partnerBookings.appointmentId),
      )
      .where(
        and(
          eq(partnerBookings.id, invoice.partnerBookingId),
          eq(partnerBookings.partnerAccountId, input.accountId),
        ),
      )
      .limit(1);
    if (
      !job ||
      !["issued", "partially_paid", "overdue"].includes(invoice.status) ||
      invoice.balanceCents <= 0 ||
      invoice.totalCents !== invoice.paidCents + invoice.balanceCents ||
      !canCollectAppointmentPayment(job.status, job.type)
    ) {
      return { kind: "failure" as const, result: failure(409, "conflict") };
    }
    if (
      invoice.currency !== "USD" ||
      input.currency !== invoice.currency ||
      (invoice.provider !== null && invoice.provider !== "square")
    ) {
      return {
        kind: "failure" as const,
        result: failure(422, "review_required"),
      };
    }
    const amount = resolvePartnerEmbeddedPaymentAmount({
      purpose: input.purpose,
      requestedAmountMinor: input.amountMinor,
      invoice,
    });
    if (!amount.ok) {
      return {
        kind: "failure" as const,
        result:
          amount.reason === "hosted_invoice_required"
            ? failure(422, "review_required")
            : failure(422, "invalid_fields"),
      };
    }
    const attempts = await tx
      .select({
        id: paymentAttempts.id,
        status: paymentAttempts.status,
        requestedJobAmountCents: paymentAttempts.requestedJobAmountCents,
        currency: paymentAttempts.currency,
        metadata: paymentAttempts.metadata,
        createdAt: paymentAttempts.createdAt,
        updatedAt: paymentAttempts.updatedAt,
        expiresAt: paymentAttempts.expiresAt,
      })
      .from(paymentAttempts)
      .where(
        and(
          eq(paymentAttempts.appointmentId, job.appointmentId),
          eq(paymentAttempts.provider, "square"),
          inArray(paymentAttempts.status, [
            ...PAYMENT_MUTATION_BLOCKING_ATTEMPT_STATUSES,
          ]),
        ),
      )
      .orderBy(desc(paymentAttempts.updatedAt))
      .for("update");
    for (const attempt of attempts) {
      const metadata = parsePartnerPaymentAttemptMetadata(attempt.metadata);
      if (
        metadata !== null &&
        isEmbeddedCheckoutMode(metadata.checkoutMode) &&
        !metadata.completionIdempotencyKeyHash &&
        (attempt.status === "created" || attempt.status === "launched") &&
        attempt.expiresAt <= now
      ) {
        await tx
          .update(paymentAttempts)
          .set({
            status: "failed",
            errorCode: "embedded_intent_expired_unsubmitted",
            resolvedAt: now,
            updatedAt: now,
          })
          .where(eq(paymentAttempts.id, attempt.id));
        continue;
      }
      if (
        attempt.status === "launched" &&
        metadata?.checkoutMode === checkoutMode &&
        metadata.paymentMethod === input.paymentMethod &&
        metadata.partnerAccountId === input.accountId &&
        metadata.partnerInvoiceId === input.invoiceId &&
        metadata.purpose === input.purpose &&
        metadata.amountMinor === amount.amountMinor &&
        attempt.expiresAt > now
      ) {
        return {
          kind: "existing" as const,
          paymentIntent: paymentIntentDto({
            id: attempt.id,
            invoiceId: input.invoiceId,
            purpose: input.purpose,
            amountMinor: amount.amountMinor,
            status: "ready",
            checkoutUrl: null,
            paymentMethod: input.paymentMethod,
            checkoutMode,
            webPayments: provider.webPayments,
            createdAt: attempt.createdAt,
            updatedAt: attempt.updatedAt,
            expiresAt: attempt.expiresAt,
          }),
        };
      }
      return { kind: "failure" as const, result: failure(409, "conflict") };
    }

    const metadata: PartnerPaymentAttemptMetadata = {
      schemaVersion: 1,
      partnerAccountId: input.accountId,
      partnerInvoiceId: input.invoiceId,
      partnerMembershipId: input.membershipId,
      partnerUserId: input.partnerUserId,
      purpose: input.purpose,
      paymentMethod: input.paymentMethod,
      checkoutMode,
      amountMinor: amount.amountMinor,
      currency: "USD",
      minorUnit: 2,
      correlationId: input.correlationId,
      idempotencyKeyHash: input.idempotencyKeyHash,
      providerPaymentLinkId: null,
      checkoutUrl: null,
      providerCreatedAt: null,
    };
    await tx.insert(paymentAttempts).values({
      id: intentId,
      appointmentId: job.appointmentId,
      provider: provider.provider,
      clientRequestId: intentId,
      status: "created",
      requestedJobAmountCents: amount.amountMinor,
      currency: "USD",
      squareLocationId: provider.locationId,
      expiresAt,
      metadata: { partnerPortalPayment: metadata },
      createdAt: now,
      updatedAt: now,
    });
    return {
      kind: "create" as const,
      invoice,
      appointmentId: job.appointmentId,
      amountMinor: amount.amountMinor,
      metadata,
    };
  });

  if (prepared.kind === "failure") return prepared.result;
  if (prepared.kind === "existing") {
    return {
      status: 200,
      body: {
        ok: true,
        paymentIntent: prepared.paymentIntent,
        reused: true,
      },
    };
  }

  let order;
  try {
    order = await provider.createOrder({
      intentId,
      appointmentId: prepared.appointmentId,
      invoiceNumber: prepared.invoice.invoiceNumber,
      purpose: input.purpose,
      amountMinor: prepared.amountMinor,
      currency: "USD",
    });
  } catch (error) {
    const providerError =
      error instanceof PartnerEmbeddedPaymentProviderError ? error : null;
    const failedAt = new Date();
    const status = providerError?.indeterminate ? "needs_review" : "failed";
    const errorCode = providerError?.code ?? "provider_request_indeterminate";
    try {
      await db.transaction(async (tx) => {
        await tx
          .update(paymentAttempts)
          .set({
            status,
            errorCode,
            errorMessage: null,
            resolvedAt: failedAt,
            updatedAt: failedAt,
          })
          .where(
            and(
              eq(paymentAttempts.id, intentId),
              eq(paymentAttempts.status, "created"),
            ),
          );
        await insertPartnerPaymentAudit({
          tx,
          actorType: "human",
          partnerUserId: input.partnerUserId,
          email: input.email,
          roleKey: input.roleKey,
          sessionId: input.sessionId,
          correlationId: input.correlationId,
          idempotencyKeyHash: input.idempotencyKeyHash,
          outcome: "failed",
          action: "partner.payment.embedded_order_failed",
          invoiceId: input.invoiceId,
          meta: {
            partnerAccountId: input.accountId,
            partnerMembershipId: input.membershipId,
            paymentIntentId: intentId,
            purpose: input.purpose,
            amountMinor: prepared.amountMinor,
            provider: provider.provider,
            errorCode,
          },
        });
      });
    } catch {
      await db
        .update(paymentAttempts)
        .set({
          status,
          errorCode,
          errorMessage: null,
          resolvedAt: failedAt,
          updatedAt: failedAt,
        })
        .where(
          and(
            eq(paymentAttempts.id, intentId),
            eq(paymentAttempts.status, "created"),
          ),
        );
    }
    return failure(
      providerError?.indeterminate ? 422 : 503,
      providerError?.indeterminate ? "review_required" : "service_unavailable",
    );
  }

  const committedAt = new Date();
  let committed = false;
  try {
    committed = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(paymentAttempts)
        .set({
          status: "launched",
          providerOrderId: order.providerOrderId,
          updatedAt: committedAt,
        })
        .where(
          and(
            eq(paymentAttempts.id, intentId),
            eq(paymentAttempts.status, "created"),
          ),
        )
        .returning({ id: paymentAttempts.id });
      if (!updated) return false;
      await insertPartnerPaymentAudit({
        tx,
        actorType: "human",
        partnerUserId: input.partnerUserId,
        email: input.email,
        roleKey: input.roleKey,
        sessionId: input.sessionId,
        correlationId: input.correlationId,
        idempotencyKeyHash: input.idempotencyKeyHash,
        outcome: "succeeded",
        action: "partner.payment.embedded_intent_ready",
        invoiceId: input.invoiceId,
        meta: {
          partnerAccountId: input.accountId,
          partnerMembershipId: input.membershipId,
          paymentIntentId: intentId,
          purpose: input.purpose,
          amountMinor: prepared.amountMinor,
          provider: provider.provider,
          providerOrderId: order.providerOrderId,
          paymentMethod: input.paymentMethod,
        },
      });
      return true;
    });
  } catch {
    committed = false;
  }
  if (!committed) {
    await db
      .update(paymentAttempts)
      .set({
        status: "needs_review",
        providerOrderId: order.providerOrderId,
        errorCode: "local_commit_conflict",
        resolvedAt: committedAt,
        updatedAt: committedAt,
      })
      .where(
        and(
          eq(paymentAttempts.id, intentId),
          inArray(paymentAttempts.status, ["created", "launched"]),
        ),
      );
    return failure(422, "review_required");
  }

  const paymentIntent = paymentIntentDto({
    id: intentId,
    invoiceId: input.invoiceId,
    purpose: input.purpose,
    amountMinor: prepared.amountMinor,
    status: "ready",
    paymentMethod: input.paymentMethod,
    checkoutUrl: null,
    checkoutMode,
    webPayments: provider.webPayments,
    createdAt: now,
    updatedAt: committedAt,
    expiresAt,
  });
  return {
    status: 201,
    body: { ok: true, paymentIntent, reused: false },
  };
}

export async function completePartnerEmbeddedPaymentIntent(
  input: CompletePartnerEmbeddedPaymentInput,
): Promise<PortalV2StoredResult> {
  let provider: PartnerEmbeddedPaymentProvider;
  try {
    provider = input.provider ?? createSquarePartnerEmbeddedPaymentProvider();
  } catch {
    return failure(503, "service_unavailable");
  }
  if (input.paymentMethod === "ach" && !provider.webPayments.methods.ach) {
    return failure(503, "service_unavailable");
  }
  const db = getDb();
  const now = new Date();
  const prepared = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('partner_payment_intent'), hashtext(${input.paymentIntentId}))`,
    );
    const [attempt] = await tx
      .select({
        id: paymentAttempts.id,
        appointmentId: paymentAttempts.appointmentId,
        status: paymentAttempts.status,
        amountMinor: paymentAttempts.requestedJobAmountCents,
        currency: paymentAttempts.currency,
        providerOrderId: paymentAttempts.providerOrderId,
        locationId: paymentAttempts.squareLocationId,
        metadata: paymentAttempts.metadata,
        expiresAt: paymentAttempts.expiresAt,
      })
      .from(paymentAttempts)
      .innerJoin(
        partnerBookings,
        and(
          eq(partnerBookings.appointmentId, paymentAttempts.appointmentId),
          eq(partnerBookings.partnerAccountId, input.accountId),
        ),
      )
      .where(
        and(
          eq(paymentAttempts.id, input.paymentIntentId),
          eq(paymentAttempts.provider, "square"),
        ),
      )
      .for("update")
      .limit(1);
    const metadata = parsePartnerPaymentAttemptMetadata(attempt?.metadata);
    if (
      !attempt ||
      !attempt.appointmentId ||
      !metadata ||
      !isEmbeddedCheckoutMode(metadata.checkoutMode) ||
      metadata.paymentMethod !== input.paymentMethod ||
      metadata.checkoutMode !==
        (input.paymentMethod === "ach" ? "embedded_ach" : "embedded_card") ||
      metadata.partnerAccountId !== input.accountId ||
      metadata.partnerMembershipId !== input.membershipId ||
      metadata.amountMinor !== attempt.amountMinor ||
      metadata.currency !== attempt.currency ||
      attempt.locationId !== provider.locationId ||
      !safeProviderIdentifier(attempt.providerOrderId)
    ) {
      return { kind: "failure" as const, result: failure(404, "not_found") };
    }
    if (
      attempt.status === "completed" ||
      attempt.status === "pending_verification"
    ) {
      return { kind: "existing" as const };
    }
    const resumingClaim =
      attempt.status === "created" &&
      metadata.completionIdempotencyKeyHash === input.idempotencyKeyHash;
    if (resumingClaim && attempt.expiresAt <= now) {
      await tx
        .update(paymentAttempts)
        .set({
          status: "needs_review",
          errorCode: "embedded_charge_claim_expired",
          resolvedAt: now,
          updatedAt: now,
        })
        .where(eq(paymentAttempts.id, attempt.id));
      return {
        kind: "failure" as const,
        result: failure(422, "review_required"),
      };
    }
    if (
      attempt.status === "created" &&
      metadata.completionIdempotencyKeyHash !== input.idempotencyKeyHash
    ) {
      return { kind: "failure" as const, result: failure(409, "conflict") };
    }
    if (attempt.status !== "launched" || attempt.expiresAt <= now) {
      if (
        !resumingClaim &&
        attempt.status === "launched" &&
        attempt.expiresAt <= now
      ) {
        await tx
          .update(paymentAttempts)
          .set({
            status: "failed",
            errorCode: "embedded_intent_expired_unsubmitted",
            resolvedAt: now,
            updatedAt: now,
          })
          .where(eq(paymentAttempts.id, attempt.id));
      }
      if (!resumingClaim) {
        return { kind: "failure" as const, result: failure(409, "conflict") };
      }
    }
    const [invoice] = await tx
      .select({
        id: partnerInvoices.id,
        status: partnerInvoices.status,
        currency: partnerInvoices.currency,
        depositCents: partnerInvoices.depositCents,
        totalCents: partnerInvoices.totalCents,
        paidCents: partnerInvoices.paidCents,
        balanceCents: partnerInvoices.balanceCents,
        appointmentStatus: appointments.status,
        appointmentType: appointments.type,
      })
      .from(partnerInvoices)
      .innerJoin(
        partnerBookings,
        and(
          eq(partnerBookings.id, partnerInvoices.partnerBookingId),
          eq(partnerBookings.appointmentId, attempt.appointmentId),
          eq(partnerBookings.partnerAccountId, input.accountId),
        ),
      )
      .innerJoin(appointments, eq(appointments.id, attempt.appointmentId))
      .where(
        and(
          eq(partnerInvoices.id, metadata.partnerInvoiceId),
          eq(partnerInvoices.partnerAccountId, input.accountId),
        ),
      )
      .for("update")
      .limit(1);
    const amount = invoice
      ? resolvePartnerEmbeddedPaymentAmount({
          purpose: metadata.purpose,
          requestedAmountMinor: metadata.amountMinor,
          invoice,
        })
      : null;
    if (
      !invoice ||
      !["issued", "partially_paid", "overdue"].includes(invoice.status) ||
      invoice.currency !== metadata.currency ||
      invoice.totalCents !== invoice.paidCents + invoice.balanceCents ||
      !canCollectAppointmentPayment(
        invoice.appointmentStatus,
        invoice.appointmentType,
      ) ||
      !amount?.ok
    ) {
      return { kind: "failure" as const, result: failure(409, "conflict") };
    }
    if (!resumingClaim) {
      const [claimed] = await tx
        .update(paymentAttempts)
        .set({
          status: "created",
          metadata: {
            partnerPortalPayment: {
              ...metadata,
              completionIdempotencyKeyHash: input.idempotencyKeyHash,
            },
          },
          errorCode: "embedded_charge_claimed",
          errorMessage: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(paymentAttempts.id, attempt.id),
            eq(paymentAttempts.status, "launched"),
          ),
        )
        .returning({ id: paymentAttempts.id });
      if (!claimed) {
        return { kind: "failure" as const, result: failure(409, "conflict") };
      }
    }
    return {
      kind: "pay" as const,
      attemptId: attempt.id,
      appointmentId: attempt.appointmentId,
      invoiceId: metadata.partnerInvoiceId,
      providerOrderId: attempt.providerOrderId,
      amountMinor: metadata.amountMinor,
      currency: metadata.currency,
      paymentMethod: metadata.paymentMethod,
    };
  });

  if (prepared.kind === "failure") return prepared.result;
  if (prepared.kind === "existing") {
    const existing = await getPartnerPaymentIntent({
      accountId: input.accountId,
      paymentIntentId: input.paymentIntentId,
      provider,
    });
    return existing.ok
      ? {
          status: 200,
          body: { ok: true, paymentIntent: existing.paymentIntent },
        }
      : failure(existing.status, existing.error);
  }

  let payment;
  try {
    payment = await provider.createPayment({
      intentId: prepared.attemptId,
      appointmentId: prepared.appointmentId,
      providerOrderId: prepared.providerOrderId,
      sourceToken: input.sourceToken,
      paymentMethod: prepared.paymentMethod,
      amountMinor: prepared.amountMinor,
      currency: prepared.currency,
    });
  } catch (error) {
    const providerError =
      error instanceof PartnerEmbeddedPaymentProviderError ? error : null;
    const indeterminate = !providerError || providerError.indeterminate;
    const failedAt = new Date();
    const errorCode = providerError?.code ?? "provider_request_indeterminate";
    const failureBinding = {
      status: indeterminate ? "pending_verification" : "failed",
      errorCode,
      errorMessage: null,
      ...(indeterminate ? {} : { resolvedAt: failedAt }),
      updatedAt: failedAt,
    } as const;
    try {
      await db.transaction(async (tx) => {
        await tx
          .update(paymentAttempts)
          .set(failureBinding)
          .where(eq(paymentAttempts.id, prepared.attemptId));
        await insertPartnerPaymentAudit({
          tx,
          actorType: "human",
          partnerUserId: input.partnerUserId,
          email: input.email,
          roleKey: input.roleKey,
          sessionId: input.sessionId,
          correlationId: input.correlationId,
          idempotencyKeyHash: input.idempotencyKeyHash,
          outcome: "failed",
          action: "partner.payment.embedded_charge_failed",
          invoiceId: prepared.invoiceId,
          meta: {
            partnerAccountId: input.accountId,
            partnerMembershipId: input.membershipId,
            paymentIntentId: prepared.attemptId,
            amountMinor: prepared.amountMinor,
            provider: provider.provider,
            errorCode,
            indeterminate,
          },
        });
      });
    } catch {
      await db
        .update(paymentAttempts)
        .set(failureBinding)
        .where(eq(paymentAttempts.id, prepared.attemptId));
    }
    if (!indeterminate) return failure(422, "invalid_fields");
    const pending = await getPartnerPaymentIntent({
      accountId: input.accountId,
      paymentIntentId: prepared.attemptId,
      provider,
    });
    return pending.ok
      ? {
          status: 202,
          body: { ok: true, paymentIntent: pending.paymentIntent },
        }
      : failure(503, "service_unavailable");
  }

  const submittedAt = new Date();
  const providerBinding = {
    status: "pending_verification",
    providerOrderId: payment.providerOrderId,
    providerPaymentId: payment.providerPaymentId,
    squareLocationId: payment.locationId,
    errorCode: null,
    errorMessage: null,
    updatedAt: submittedAt,
  } as const;
  try {
    await db.transaction(async (tx) => {
      await tx
        .update(paymentAttempts)
        .set(providerBinding)
        .where(eq(paymentAttempts.id, prepared.attemptId));
      await insertPartnerPaymentAudit({
        tx,
        actorType: "human",
        partnerUserId: input.partnerUserId,
        email: input.email,
        roleKey: input.roleKey,
        sessionId: input.sessionId,
        correlationId: input.correlationId,
        idempotencyKeyHash: input.idempotencyKeyHash,
        outcome: "succeeded",
        action: "partner.payment.embedded_charge_submitted",
        invoiceId: prepared.invoiceId,
        meta: {
          partnerAccountId: input.accountId,
          partnerMembershipId: input.membershipId,
          paymentIntentId: prepared.attemptId,
          amountMinor: prepared.amountMinor,
          provider: payment.provider,
          providerOrderId: payment.providerOrderId,
          providerPaymentId: payment.providerPaymentId,
          providerStatus: payment.providerStatus,
          paymentMethod: prepared.paymentMethod,
        },
      });
    });
  } catch {
    // The provider response is financially authoritative. Preserve its exact
    // identifiers even when the best-effort audit write is temporarily down;
    // webhook/order-note reconciliation can then finish safely.
    await db
      .update(paymentAttempts)
      .set(providerBinding)
      .where(eq(paymentAttempts.id, prepared.attemptId));
  }

  if (prepared.paymentMethod === "card") {
    try {
      // Card payments can settle synchronously. ACH deliberately remains
      // pending until a signed Square webhook drives reconciliation.
      const { reconcileSquareAttempt } = await import("@/lib/square-payments");
      await reconcileSquareAttempt({
        attemptId: prepared.attemptId,
        orderId: payment.providerOrderId,
        finalize: finalizePartnerPortalPaymentReconciliation,
      });
    } catch {
      // A submitted provider payment is never retried with a new amount or
      // treated as failed merely because immediate verification is unavailable.
    }
  }
  const result = await getPartnerPaymentIntent({
    accountId: input.accountId,
    paymentIntentId: prepared.attemptId,
    provider,
  });
  return result.ok
    ? {
        status: result.paymentIntent.status === "succeeded" ? 200 : 202,
        body: { ok: true, paymentIntent: result.paymentIntent },
      }
    : failure(503, "service_unavailable");
}

export async function getPartnerPaymentIntent(input: {
  accountId: string;
  paymentIntentId: string;
  provider?: PartnerEmbeddedPaymentProvider;
}): Promise<
  | { ok: true; paymentIntent: ReturnType<typeof paymentIntentDto> }
  | {
      ok: false;
      status: 404 | 503;
      error: "not_found" | "service_unavailable";
    }
> {
  const db = getDb();
  const [attempt] = await db
    .select({
      id: paymentAttempts.id,
      appointmentId: paymentAttempts.appointmentId,
      status: paymentAttempts.status,
      requestedJobAmountCents: paymentAttempts.requestedJobAmountCents,
      currency: paymentAttempts.currency,
      metadata: paymentAttempts.metadata,
      expiresAt: paymentAttempts.expiresAt,
      createdAt: paymentAttempts.createdAt,
      updatedAt: paymentAttempts.updatedAt,
    })
    .from(paymentAttempts)
    .innerJoin(
      partnerBookings,
      and(
        eq(partnerBookings.appointmentId, paymentAttempts.appointmentId),
        eq(partnerBookings.partnerAccountId, input.accountId),
      ),
    )
    .where(
      and(
        eq(paymentAttempts.id, input.paymentIntentId),
        eq(paymentAttempts.provider, "square"),
      ),
    )
    .limit(1);
  const metadata = parsePartnerPaymentAttemptMetadata(attempt?.metadata);
  if (
    !attempt ||
    !attempt.appointmentId ||
    !metadata ||
    metadata.partnerAccountId !== input.accountId ||
    metadata.amountMinor !== attempt.requestedJobAmountCents ||
    attempt.currency !== metadata.currency
  ) {
    return { ok: false, status: 404, error: "not_found" };
  }
  const [invoice] = await db
    .select({
      id: partnerInvoices.id,
      partnerBookingId: partnerInvoices.partnerBookingId,
      status: partnerInvoices.status,
      currency: partnerInvoices.currency,
      depositCents: partnerInvoices.depositCents,
      totalCents: partnerInvoices.totalCents,
      paidCents: partnerInvoices.paidCents,
      balanceCents: partnerInvoices.balanceCents,
      appointmentStatus: appointments.status,
      appointmentType: appointments.type,
    })
    .from(partnerInvoices)
    .innerJoin(
      partnerBookings,
      and(
        eq(partnerBookings.id, partnerInvoices.partnerBookingId),
        eq(partnerBookings.appointmentId, attempt.appointmentId),
      ),
    )
    .innerJoin(appointments, eq(appointments.id, partnerBookings.appointmentId))
    .where(
      and(
        eq(partnerInvoices.id, metadata.partnerInvoiceId),
        eq(partnerInvoices.partnerAccountId, input.accountId),
      ),
    )
    .limit(1);
  if (!invoice) return { ok: false, status: 404, error: "not_found" };
  const [payment] = await db
    .select({
      id: payments.id,
      canonicalStatus: payments.canonicalStatus,
      providerStatus: payments.providerStatus,
      tenderType: payments.tenderType,
    })
    .from(payments)
    .where(eq(payments.paymentAttemptId, attempt.id))
    .limit(1);
  const [allocation] = payment
    ? await db
        .select({ state: partnerPaymentAllocations.state })
        .from(partnerPaymentAllocations)
        .where(
          and(
            eq(partnerPaymentAllocations.partnerInvoiceId, invoice.id),
            eq(partnerPaymentAllocations.paymentId, payment.id),
            eq(partnerPaymentAllocations.partnerAccountId, input.accountId),
          ),
        )
        .limit(1)
    : [];
  const derivedStatus = derivePartnerPaymentIntentStatus({
    attemptStatus: attempt.status,
    expiresAt: attempt.expiresAt,
    paymentCanonicalStatus: payment?.canonicalStatus,
    paymentProviderStatus: payment?.providerStatus,
    paymentTenderType: payment?.tenderType,
    allocationState: allocation?.state,
  });
  const baseCollectible =
    ["issued", "partially_paid", "overdue"].includes(invoice.status) &&
    invoice.currency === metadata.currency &&
    invoice.balanceCents >= metadata.amountMinor &&
    canCollectAppointmentPayment(
      invoice.appointmentStatus,
      invoice.appointmentType,
    );
  const embeddedAmount = isEmbeddedCheckoutMode(metadata.checkoutMode)
    ? resolvePartnerEmbeddedPaymentAmount({
        purpose: metadata.purpose,
        requestedAmountMinor: metadata.amountMinor,
        invoice,
      })
    : null;
  const collectible =
    baseCollectible &&
    (!isEmbeddedCheckoutMode(metadata.checkoutMode) ||
      embeddedAmount?.ok === true);
  let status =
    isEmbeddedCheckoutMode(metadata.checkoutMode) &&
    attempt.status === "created" &&
    metadata.completionIdempotencyKeyHash &&
    attempt.expiresAt <= new Date()
      ? "requires_review"
      : derivedStatus === "ready" && !collectible
        ? "requires_review"
        : derivedStatus;
  let webPayments: PartnerWebPaymentsConfiguration | null = null;
  if (isEmbeddedCheckoutMode(metadata.checkoutMode)) {
    try {
      webPayments =
        input.provider?.webPayments ??
        createSquarePartnerEmbeddedPaymentProvider().webPayments;
    } catch {
      return { ok: false, status: 503, error: "service_unavailable" };
    }
    if (
      metadata.paymentMethod === "ach" &&
      status === "ready" &&
      !webPayments.methods.ach
    ) {
      status = "requires_review";
    }
  }
  return {
    ok: true,
    paymentIntent: paymentIntentDto({
      id: attempt.id,
      invoiceId: metadata.partnerInvoiceId,
      purpose: metadata.purpose,
      amountMinor: metadata.amountMinor,
      status,
      paymentMethod: metadata.paymentMethod,
      checkoutUrl: metadata.checkoutUrl,
      checkoutMode: metadata.checkoutMode,
      webPayments,
      createdAt: attempt.createdAt,
      updatedAt: attempt.updatedAt,
      expiresAt: attempt.expiresAt,
    }),
  };
}

export async function getPartnerInvoiceHostedPaymentLink(input: {
  accountId: string;
  invoiceId: string;
}): Promise<
  | {
      ok: true;
      paymentLink: ReturnType<typeof paymentIntentDto> | null;
      eligible: boolean;
    }
  | { ok: false; status: 404; error: "not_found" }
> {
  const db = getDb();
  const [invoice] = await db
    .select({
      id: partnerInvoices.id,
      partnerBookingId: partnerInvoices.partnerBookingId,
      status: partnerInvoices.status,
      currency: partnerInvoices.currency,
      balanceCents: partnerInvoices.balanceCents,
      provider: partnerInvoices.provider,
    })
    .from(partnerInvoices)
    .where(
      and(
        eq(partnerInvoices.id, input.invoiceId),
        eq(partnerInvoices.partnerAccountId, input.accountId),
      ),
    )
    .limit(1);
  if (!invoice) return { ok: false, status: 404, error: "not_found" };
  const invoiceEligible =
    Boolean(invoice.partnerBookingId) &&
    ["issued", "partially_paid", "overdue"].includes(invoice.status) &&
    invoice.currency === "USD" &&
    (invoice.provider === null || invoice.provider === "square") &&
    invoice.balanceCents > 0;
  if (!invoice.partnerBookingId) {
    return { ok: true, paymentLink: null, eligible: false };
  }
  const [job] = await db
    .select({
      appointmentId: partnerBookings.appointmentId,
      status: appointments.status,
      type: appointments.type,
    })
    .from(partnerBookings)
    .innerJoin(appointments, eq(appointments.id, partnerBookings.appointmentId))
    .where(
      and(
        eq(partnerBookings.id, invoice.partnerBookingId),
        eq(partnerBookings.partnerAccountId, input.accountId),
      ),
    )
    .limit(1);
  if (!job) return { ok: true, paymentLink: null, eligible: false };
  const eligible =
    invoiceEligible && canCollectAppointmentPayment(job.status, job.type);
  const attempts = await db
    .select({ id: paymentAttempts.id, metadata: paymentAttempts.metadata })
    .from(paymentAttempts)
    .where(
      and(
        eq(paymentAttempts.appointmentId, job.appointmentId),
        eq(paymentAttempts.provider, "square"),
      ),
    )
    .orderBy(desc(paymentAttempts.createdAt))
    .limit(20);
  const matching = attempts.find((attempt) => {
    const metadata = parsePartnerPaymentAttemptMetadata(attempt.metadata);
    return (
      metadata?.partnerAccountId === input.accountId &&
      metadata.partnerInvoiceId === input.invoiceId &&
      metadata.checkoutMode === "hosted_redirect"
    );
  });
  if (!matching) return { ok: true, paymentLink: null, eligible };
  const intent = await getPartnerPaymentIntent({
    accountId: input.accountId,
    paymentIntentId: matching.id,
  });
  return intent.ok
    ? { ok: true, paymentLink: intent.paymentIntent, eligible }
    : { ok: true, paymentLink: null, eligible };
}

async function markPartnerAllocationReview(input: {
  tx: TeamMutationTransaction;
  metadata: PartnerPaymentAttemptMetadata;
  attemptId: string;
  reason: string;
}): Promise<void> {
  const reason = input.reason.slice(0, 200);
  await input.tx
    .update(paymentAttempts)
    .set({
      metadata: {
        partnerPortalPayment: {
          ...input.metadata,
          allocationState: "needs_review",
          allocationError: reason,
        },
      },
      updatedAt: new Date(),
    })
    .where(eq(paymentAttempts.id, input.attemptId));
  await insertPartnerPaymentAudit({
    tx: input.tx,
    actorType: "system",
    correlationId: input.metadata.correlationId,
    idempotencyKeyHash: input.metadata.idempotencyKeyHash,
    outcome: "failed",
    action: "partner.payment.allocation_review_required",
    invoiceId: input.metadata.partnerInvoiceId,
    meta: {
      partnerAccountId: input.metadata.partnerAccountId,
      paymentIntentId: input.attemptId,
      reason,
    },
  });
}

export async function finalizePartnerPortalPaymentReconciliation(
  tx: TeamMutationTransaction,
  result: SquareAttemptReconciliationResult,
): Promise<void> {
  if (result.status !== "verified") return;
  const [attempt] = await tx
    .select({
      id: paymentAttempts.id,
      appointmentId: paymentAttempts.appointmentId,
      metadata: paymentAttempts.metadata,
    })
    .from(paymentAttempts)
    .where(eq(paymentAttempts.id, result.attemptId))
    .for("update")
    .limit(1);
  const metadata = parsePartnerPaymentAttemptMetadata(attempt?.metadata);
  if (!attempt || !metadata) return;

  const [invoice] = await tx
    .select({
      id: partnerInvoices.id,
      accountId: partnerInvoices.partnerAccountId,
      partnerBookingId: partnerInvoices.partnerBookingId,
      currency: partnerInvoices.currency,
      totalCents: partnerInvoices.totalCents,
      paidCents: partnerInvoices.paidCents,
      balanceCents: partnerInvoices.balanceCents,
      status: partnerInvoices.status,
      version: partnerInvoices.version,
    })
    .from(partnerInvoices)
    .where(
      and(
        eq(partnerInvoices.id, metadata.partnerInvoiceId),
        eq(partnerInvoices.partnerAccountId, metadata.partnerAccountId),
      ),
    )
    .for("update")
    .limit(1);
  const [job] = invoice?.partnerBookingId
    ? await tx
        .select({ appointmentId: partnerBookings.appointmentId })
        .from(partnerBookings)
        .where(
          and(
            eq(partnerBookings.id, invoice.partnerBookingId),
            eq(partnerBookings.partnerAccountId, metadata.partnerAccountId),
          ),
        )
        .limit(1)
    : [];
  const [payment] = await tx
    .select({
      id: payments.id,
      appointmentId: payments.appointmentId,
      paymentAttemptId: payments.paymentAttemptId,
      jobAmountCents: payments.jobAmountCents,
      currency: payments.currency,
      canonicalStatus: payments.canonicalStatus,
      providerStatus: payments.providerStatus,
      tenderType: payments.tenderType,
    })
    .from(payments)
    .where(eq(payments.id, result.paymentId))
    .for("update")
    .limit(1);
  if (
    !invoice ||
    !job ||
    !payment ||
    result.appointmentId !== attempt.appointmentId ||
    job.appointmentId !== attempt.appointmentId ||
    payment.appointmentId !== attempt.appointmentId ||
    payment.paymentAttemptId !== attempt.id ||
    payment.jobAmountCents !== metadata.amountMinor ||
    payment.currency !== metadata.currency ||
    payment.tenderType !==
      (metadata.paymentMethod === "ach" ? "bank_account" : "card") ||
    (payment.canonicalStatus !== "completed" &&
      payment.providerStatus?.toLowerCase() !== "completed") ||
    invoice.currency !== metadata.currency ||
    !["issued", "partially_paid", "overdue"].includes(invoice.status) ||
    invoice.totalCents !== invoice.paidCents + invoice.balanceCents ||
    invoice.balanceCents < metadata.amountMinor
  ) {
    await markPartnerAllocationReview({
      tx,
      metadata,
      attemptId: attempt.id,
      reason: "invoice_payment_binding_mismatch",
    });
    return;
  }
  const allocations = await tx
    .select({
      id: partnerPaymentAllocations.id,
      accountId: partnerPaymentAllocations.partnerAccountId,
      invoiceId: partnerPaymentAllocations.partnerInvoiceId,
      amountCents: partnerPaymentAllocations.amountCents,
      state: partnerPaymentAllocations.state,
    })
    .from(partnerPaymentAllocations)
    .where(eq(partnerPaymentAllocations.paymentId, payment.id))
    .for("update");
  const existing = allocations.find(
    (allocation) =>
      allocation.accountId === metadata.partnerAccountId &&
      allocation.invoiceId === metadata.partnerInvoiceId,
  );
  if (existing) {
    if (
      existing.amountCents === metadata.amountMinor &&
      existing.state === "settled"
    ) {
      return;
    }
    await markPartnerAllocationReview({
      tx,
      metadata,
      attemptId: attempt.id,
      reason: "existing_allocation_mismatch",
    });
    return;
  }
  if (allocations.length > 0) {
    await markPartnerAllocationReview({
      tx,
      metadata,
      attemptId: attempt.id,
      reason: "payment_already_allocated_elsewhere",
    });
    return;
  }
  const now = new Date();
  await tx.insert(partnerPaymentAllocations).values({
    partnerAccountId: metadata.partnerAccountId,
    partnerInvoiceId: metadata.partnerInvoiceId,
    paymentId: payment.id,
    amountCents: metadata.amountMinor,
    state: "settled",
    allocatedAt: now,
    createdAt: now,
  });
  const paidCents = invoice.paidCents + metadata.amountMinor;
  const balanceCents = invoice.totalCents - paidCents;
  const [updated] = await tx
    .update(partnerInvoices)
    .set({
      paidCents,
      balanceCents,
      status: balanceCents === 0 ? "paid" : "partially_paid",
      paidAt: balanceCents === 0 ? now : null,
      version: invoice.version + 1,
      updatedAt: now,
    })
    .where(
      and(
        eq(partnerInvoices.id, invoice.id),
        eq(partnerInvoices.version, invoice.version),
        eq(partnerInvoices.paidCents, invoice.paidCents),
        eq(partnerInvoices.balanceCents, invoice.balanceCents),
      ),
    )
    .returning({ id: partnerInvoices.id });
  if (!updated) {
    throw new Error("partner_invoice_allocation_update_conflict");
  }
  await tx
    .update(paymentAttempts)
    .set({
      metadata: {
        partnerPortalPayment: {
          ...metadata,
          allocationState: "settled",
        },
      },
      updatedAt: now,
    })
    .where(eq(paymentAttempts.id, attempt.id));
  await insertPartnerPaymentAudit({
    tx,
    actorType: "system",
    correlationId: metadata.correlationId,
    idempotencyKeyHash: metadata.idempotencyKeyHash,
    outcome: "succeeded",
    action: "partner.payment.allocated",
    invoiceId: invoice.id,
    meta: {
      partnerAccountId: metadata.partnerAccountId,
      paymentIntentId: attempt.id,
      paymentId: payment.id,
      amountMinor: metadata.amountMinor,
      invoiceStatus: balanceCents === 0 ? "paid" : "partially_paid",
    },
  });
}
