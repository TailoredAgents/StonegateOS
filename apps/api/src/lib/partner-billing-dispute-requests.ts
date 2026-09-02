import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  auditLogs,
  conversationMessages,
  conversationParticipants,
  conversationThreads,
  outboxEvents,
  partnerAccountCostCenters,
  partnerAccountLocations,
  partnerAccountMemberships,
  partnerAccounts,
  partnerBillingDisputeRequests,
  partnerBookings,
  partnerInvoices,
  type PartnerBillingDisputeCategory,
  type PartnerBillingDisputeRequestSnapshot,
  type PartnerBillingDisputeState,
} from "@/db";
import { sanitizeAuditMetadata } from "@/lib/audit-metadata";
import type { PartnerPrincipal } from "@/lib/partner-account-authorization";
import {
  createPartnerInvoiceAccessCondition,
  type PartnerCommercialAccess,
} from "@/lib/partner-portal-v2-commercial";
import { createPartnerJobLocationJoinCondition } from "@/lib/partner-portal-v2-resource-authorization";
import {
  queuePartnerBookingStaffAlert,
  resolvePartnerBookingStaffRecipient,
} from "@/lib/staff-notification-operations";
import {
  assertTeamMutationExpectedVersion,
  TeamMutationFailure,
  type TeamMutationTransaction,
} from "@/lib/team-mutation";

const DISPUTABLE_INVOICE_STATES = new Set([
  "issued",
  "partially_paid",
  "paid",
  "overdue",
]);
const TERMINAL_STATES = [
  "information_provided",
  "adjustment_required",
  "refund_review",
  "declined",
] as const;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const INVOICE_ETAG_PATTERN = /^"[A-Za-z0-9_-]{43}"$/u;
const MAX_HISTORY_PAGE_SIZE = 50;
const BILLING_REQUEST_RECEIVED_MESSAGE =
  "Stonegate will review this request. Your invoice, payment, and refund status have not changed.";

export type PartnerBillingDisputeHistoryCursor = Readonly<{
  createdAt: Date;
  id: string;
  invoiceId: string;
  version: 1;
}>;

export function parsePartnerBillingDisputeHistoryCursor(
  value: string | null,
  expectedInvoiceId?: string,
): PartnerBillingDisputeHistoryCursor | null | "invalid" {
  if (!value) return null;
  if (value.length > 512 || !BASE64URL_PATTERN.test(value)) return "invalid";
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    if (
      typeof decoded !== "object" ||
      decoded === null ||
      Array.isArray(decoded)
    ) {
      return "invalid";
    }
    const record = decoded as Record<string, unknown>;
    if (
      Object.keys(record).sort().join("\0") !==
        "createdAt\0id\0invoiceId\0version" ||
      record["version"] !== 1 ||
      typeof record["createdAt"] !== "string" ||
      typeof record["id"] !== "string" ||
      !UUID_PATTERN.test(record["id"]) ||
      typeof record["invoiceId"] !== "string" ||
      !UUID_PATTERN.test(record["invoiceId"])
    ) {
      return "invalid";
    }
    const createdAt = new Date(record["createdAt"]);
    if (
      Number.isNaN(createdAt.getTime()) ||
      createdAt.toISOString() !== record["createdAt"]
    ) {
      return "invalid";
    }
    const cursor = Object.freeze({
      createdAt,
      id: record["id"].toLowerCase(),
      invoiceId: record["invoiceId"].toLowerCase(),
      version: 1 as const,
    });
    if (
      (expectedInvoiceId &&
        cursor.invoiceId !== expectedInvoiceId.trim().toLowerCase()) ||
      encodePartnerBillingDisputeHistoryCursor(cursor) !== value
    ) {
      return "invalid";
    }
    return cursor;
  } catch {
    return "invalid";
  }
}

export function encodePartnerBillingDisputeHistoryCursor(input: {
  createdAt: Date;
  id: string;
  invoiceId: string;
}): string {
  return Buffer.from(
    JSON.stringify({
      createdAt: input.createdAt.toISOString(),
      id: input.id.toLowerCase(),
      invoiceId: input.invoiceId.toLowerCase(),
      version: 1,
    }),
    "utf8",
  ).toString("base64url");
}

type PartnerBillingDisputeReplayReceipt = Readonly<{
  version: 1;
  status: 201;
  correlationId: string;
  etag: string;
  message: string;
}>;

function readReplayReceipt(
  snapshot: PartnerBillingDisputeRequestSnapshot,
): PartnerBillingDisputeReplayReceipt | null {
  const candidate: unknown = snapshot.replayReceipt;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }
  const receipt = candidate as Record<string, unknown>;
  if (
    Object.keys(receipt).sort().join("\0") !==
      "correlationId\0etag\0message\0status\0version" ||
    receipt["version"] !== 1 ||
    receipt["status"] !== 201 ||
    typeof receipt["correlationId"] !== "string" ||
    !CORRELATION_ID_PATTERN.test(receipt["correlationId"]) ||
    typeof receipt["etag"] !== "string" ||
    !INVOICE_ETAG_PATTERN.test(receipt["etag"]) ||
    typeof receipt["message"] !== "string" ||
    receipt["message"].length < 1 ||
    receipt["message"].length > 500
  ) {
    return null;
  }
  return Object.freeze({
    version: 1,
    status: 201,
    correlationId: receipt["correlationId"],
    etag: receipt["etag"],
    message: receipt["message"],
  });
}

export const PartnerBillingDisputeRequestBodySchema = z
  .object({
    category: z.enum([
      "invoice_amount",
      "duplicate_charge",
      "payment_not_reflected",
      "service_concern",
      "refund_request",
      "tax_or_document",
      "other",
    ]),
    reason: z.string().trim().min(10).max(2_000),
    evidence: z
      .object({
        disputedAmountMinor: z
          .number()
          .int()
          .positive()
          .max(2_147_483_647)
          .nullable(),
        reference: z.string().trim().min(1).max(160).nullable(),
        details: z.string().trim().min(1).max(4_000).nullable(),
      })
      .strict(),
  })
  .strict();

export type PartnerBillingDisputeRequestBody = z.infer<
  typeof PartnerBillingDisputeRequestBodySchema
>;
export type PartnerBillingDisputeResolution = Exclude<
  PartnerBillingDisputeState,
  "pending"
>;

export class PartnerBillingDisputeError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "revision_mismatch"
      | "idempotency_conflict"
      | "billing_request_pending"
      | "invoice_not_disputable"
      | "invalid_cursor"
      | "conflict",
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "PartnerBillingDisputeError";
  }
}

type AccessibleInvoice = Readonly<{
  id: string;
  accountId: string;
  invoiceNumber: string;
  status: string;
  currency: string;
  totalCents: number;
  paidCents: number;
  balanceCents: number;
  version: number;
  updatedAt: Date;
  rawBookingId: string | null;
  bookingId: string | null;
}>;

export type PartnerBillingDisputePublicItem = Readonly<{
  id: string;
  invoiceId: string;
  category: PartnerBillingDisputeCategory;
  reason: string;
  evidence: Readonly<{
    disputedAmountMinor: number | null;
    reference: string | null;
    details: string | null;
  }>;
  state: PartnerBillingDisputeState;
  revision: number;
  relatedJobId: string | null;
  thread: Readonly<{
    id: string;
    scope: "account_billing";
  }>;
  resolution: Readonly<{
    reason: string;
    resolvedAt: string;
  }> | null;
  createdAt: string;
  updatedAt: string;
}>;

export function partnerInvoiceEtag(input: {
  invoiceId: string;
  revision: number;
  updatedAt: Date;
}): string {
  return `"${createHash("sha256")
    .update(
      JSON.stringify({
        kind: "partner_invoice",
        id: input.invoiceId,
        revision: input.revision,
        updatedAt: input.updatedAt.toISOString(),
      }),
      "utf8",
    )
    .digest("base64url")}"`;
}

function safeEvidence(
  snapshot: PartnerBillingDisputeRequestSnapshot,
): PartnerBillingDisputePublicItem["evidence"] {
  return Object.freeze({
    disputedAmountMinor: snapshot.evidence.disputedAmountMinor,
    reference: snapshot.evidence.reference,
    details: snapshot.evidence.details,
  });
}

function publicItem(
  row: typeof partnerBillingDisputeRequests.$inferSelect,
): PartnerBillingDisputePublicItem {
  return Object.freeze({
    id: row.id,
    invoiceId: row.partnerInvoiceId,
    category: row.category,
    reason: row.reason,
    evidence: safeEvidence(row.requestSnapshot),
    state: row.state,
    revision: row.revision,
    relatedJobId: row.partnerBookingId,
    thread: Object.freeze({
      id: row.conversationThreadId,
      scope: row.threadScope,
    }),
    resolution:
      row.resolutionReason && row.resolvedAt
        ? Object.freeze({
            reason: row.resolutionReason,
            resolvedAt: row.resolvedAt.toISOString(),
          })
        : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

/** Reconstructs the immutable response item returned by the original create. */
function initialPublicItem(
  row: typeof partnerBillingDisputeRequests.$inferSelect,
): PartnerBillingDisputePublicItem {
  return Object.freeze({
    id: row.id,
    invoiceId: row.partnerInvoiceId,
    category: row.category,
    reason: row.reason,
    evidence: safeEvidence(row.requestSnapshot),
    state: "pending",
    revision: 1,
    relatedJobId: row.partnerBookingId,
    thread: Object.freeze({
      id: row.conversationThreadId,
      scope: row.threadScope,
    }),
    resolution: null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.createdAt.toISOString(),
  });
}

async function acquireBillingDisputeLock(
  tx: TeamMutationTransaction,
  accountId: string,
  invoiceId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`partner-billing-dispute:${accountId}:${invoiceId}`}, 0))`,
  );
}

async function acquireBillingDisputeOperationLock(
  tx: TeamMutationTransaction,
  accountId: string,
  operationKeyHash: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`partner-billing-dispute-operation:${accountId}:${operationKeyHash}`}, 0))`,
  );
}

async function loadAccessibleInvoice(
  tx: TeamMutationTransaction,
  input: {
    principal: Pick<
      PartnerPrincipal,
      | "accountId"
      | "partnerUserId"
      | "membershipId"
      | "accessLevel"
      | "accessScope"
    >;
    invoiceId: string;
    lock: boolean;
  },
): Promise<AccessibleInvoice | null> {
  if (!input.principal.accountId || !input.principal.membershipId) return null;
  const access: PartnerCommercialAccess = input.principal;
  const query = tx
    .select({
      id: partnerInvoices.id,
      accountId: partnerInvoices.partnerAccountId,
      invoiceNumber: partnerInvoices.invoiceNumber,
      status: partnerInvoices.status,
      currency: partnerInvoices.currency,
      totalCents: partnerInvoices.totalCents,
      paidCents: partnerInvoices.paidCents,
      balanceCents: partnerInvoices.balanceCents,
      version: partnerInvoices.version,
      updatedAt: partnerInvoices.updatedAt,
      rawBookingId: partnerInvoices.partnerBookingId,
      bookingId: partnerBookings.id,
    })
    .from(partnerInvoices)
    .innerJoin(
      partnerAccounts,
      and(
        eq(partnerAccounts.id, partnerInvoices.partnerAccountId),
        eq(partnerAccounts.portalAccessEnabled, true),
      ),
    )
    .innerJoin(
      partnerAccountMemberships,
      and(
        eq(partnerAccountMemberships.id, input.principal.membershipId),
        eq(
          partnerAccountMemberships.partnerAccountId,
          partnerInvoices.partnerAccountId,
        ),
        eq(
          partnerAccountMemberships.partnerUserId,
          input.principal.partnerUserId,
        ),
        eq(partnerAccountMemberships.status, "active"),
      ),
    )
    .leftJoin(
      partnerBookings,
      and(
        eq(partnerInvoices.partnerBookingId, partnerBookings.id),
        eq(partnerInvoices.partnerAccountId, partnerBookings.partnerAccountId),
      ),
    )
    .leftJoin(partnerAccountLocations, createPartnerJobLocationJoinCondition())
    .leftJoin(
      partnerAccountCostCenters,
      and(
        eq(
          partnerAccountCostCenters.partnerAccountId,
          partnerInvoices.partnerAccountId,
        ),
        eq(partnerAccountCostCenters.code, partnerInvoices.costCenter),
      ),
    )
    .where(
      and(
        eq(partnerInvoices.partnerAccountId, input.principal.accountId),
        eq(partnerInvoices.id, input.invoiceId),
        createPartnerInvoiceAccessCondition(access),
      ),
    );
  const rows = input.lock
    ? await query.for("update", { of: partnerInvoices }).limit(1)
    : await query.limit(1);
  const row = rows[0] ?? null;
  if (row?.rawBookingId && !row.bookingId) return null;
  return row;
}

function assertInvoiceRevision(
  invoice: AccessibleInvoice,
  ifMatch: string | null,
): void {
  if (
    ifMatch !==
    partnerInvoiceEtag({
      invoiceId: invoice.id,
      revision: invoice.version,
      updatedAt: invoice.updatedAt,
    })
  ) {
    throw new PartnerBillingDisputeError(
      "revision_mismatch",
      412,
      "The invoice changed. Refresh it before submitting this request.",
    );
  }
}

async function ensureRequestThread(
  tx: TeamMutationTransaction,
  input: {
    requestId: string;
    invoice: AccessibleInvoice;
    principal: PartnerPrincipal;
  },
): Promise<{
  id: string;
  scope: "account_billing";
  participantId: string;
}> {
  const [thread] = await tx
    .insert(conversationThreads)
    .values({
      id: input.requestId,
      partnerAccountId: input.invoice.accountId,
      partnerBookingId: null,
      staffScope: "partner_billing",
      portalVisible: true,
      status: "open",
      state: "review",
      channel: "web",
      subject: `Billing request · Invoice ${input.invoice.invoiceNumber}`.slice(
        0,
        240,
      ),
    })
    .returning({ id: conversationThreads.id });
  if (!thread) throw new Error("partner_billing_dispute_thread_missing");

  let [participant] = await tx
    .select({ id: conversationParticipants.id })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.threadId, thread.id),
        eq(
          conversationParticipants.partnerMembershipId,
          input.principal.membershipId!,
        ),
      ),
    )
    .limit(1);
  if (!participant) {
    [participant] = await tx
      .insert(conversationParticipants)
      .values({
        threadId: thread.id,
        participantType: "contact",
        contactId: null,
        partnerMembershipId: input.principal.membershipId,
        externalAddress: input.principal.email,
        displayName: input.principal.name,
      })
      .returning({ id: conversationParticipants.id });
  }
  if (!participant)
    throw new Error("partner_billing_dispute_participant_missing");
  return {
    id: thread.id,
    scope: "account_billing",
    participantId: participant.id,
  };
}

function initialMessageBody(
  category: PartnerBillingDisputeCategory,
  reason: string,
  evidence: PartnerBillingDisputeRequestBody["evidence"],
): string {
  return [
    `Billing request (${category.replaceAll("_", " ")}): ${reason}`,
    evidence.disputedAmountMinor === null
      ? null
      : `Disputed amount (minor units): ${evidence.disputedAmountMinor}`,
    evidence.reference ? `Reference: ${evidence.reference}` : null,
    evidence.details ? `Supporting details: ${evidence.details}` : null,
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n\n")
    .slice(0, 8_000);
}

export async function createPartnerBillingDisputeRequest(
  tx: TeamMutationTransaction,
  input: {
    principal: PartnerPrincipal;
    invoiceId: string;
    payload: PartnerBillingDisputeRequestBody;
    operationKeyHash: string;
    requestHash: string;
    ifMatch: string | null;
    correlationId: string;
    now?: Date;
  },
): Promise<{
  item: PartnerBillingDisputePublicItem;
  invoice: AccessibleInvoice;
  replayed: boolean;
  response: PartnerBillingDisputeReplayReceipt;
}> {
  const accountId = input.principal.accountId;
  if (!accountId || !input.principal.membershipId) {
    throw new PartnerBillingDisputeError(
      "not_found",
      404,
      "Invoice not found.",
    );
  }
  await acquireBillingDisputeOperationLock(
    tx,
    accountId,
    input.operationKeyHash,
  );
  await acquireBillingDisputeLock(tx, accountId, input.invoiceId);
  const invoice = await loadAccessibleInvoice(tx, {
    principal: input.principal,
    invoiceId: input.invoiceId,
    lock: true,
  });
  if (!invoice) {
    throw new PartnerBillingDisputeError(
      "not_found",
      404,
      "Invoice not found.",
    );
  }
  const [replay] = await tx
    .select()
    .from(partnerBillingDisputeRequests)
    .where(
      and(
        eq(partnerBillingDisputeRequests.partnerAccountId, accountId),
        eq(
          partnerBillingDisputeRequests.operationKeyHash,
          input.operationKeyHash,
        ),
      ),
    )
    .limit(1);
  if (replay) {
    if (
      replay.partnerInvoiceId !== invoice.id ||
      replay.requestHash !== input.requestHash
    ) {
      throw new PartnerBillingDisputeError(
        "idempotency_conflict",
        409,
        "That idempotency key was already used for another request.",
      );
    }
    const response = readReplayReceipt(replay.requestSnapshot);
    if (!response) {
      throw new PartnerBillingDisputeError(
        "conflict",
        409,
        "The original response cannot be replayed safely. Refresh billing history before continuing.",
      );
    }
    return {
      item: initialPublicItem(replay),
      invoice,
      replayed: true,
      response,
    };
  }
  assertInvoiceRevision(invoice, input.ifMatch);
  if (!DISPUTABLE_INVOICE_STATES.has(invoice.status)) {
    throw new PartnerBillingDisputeError(
      "invoice_not_disputable",
      409,
      "This invoice is not in a state that accepts billing requests.",
    );
  }
  const [pending] = await tx
    .select({ id: partnerBillingDisputeRequests.id })
    .from(partnerBillingDisputeRequests)
    .where(
      and(
        eq(partnerBillingDisputeRequests.partnerAccountId, accountId),
        eq(partnerBillingDisputeRequests.partnerInvoiceId, invoice.id),
        eq(partnerBillingDisputeRequests.state, "pending"),
      ),
    )
    .limit(1);
  if (pending) {
    throw new PartnerBillingDisputeError(
      "billing_request_pending",
      409,
      "This invoice already has a billing request under review.",
    );
  }

  const now = input.now ?? new Date();
  const requestId = randomUUID();
  const replayReceipt: PartnerBillingDisputeReplayReceipt = Object.freeze({
    version: 1,
    status: 201,
    correlationId: input.correlationId,
    etag: partnerInvoiceEtag({
      invoiceId: invoice.id,
      revision: invoice.version,
      updatedAt: invoice.updatedAt,
    }),
    message: BILLING_REQUEST_RECEIVED_MESSAGE,
  });
  const thread = await ensureRequestThread(tx, {
    requestId,
    invoice,
    principal: input.principal,
  });
  const requestSnapshot: PartnerBillingDisputeRequestSnapshot = Object.freeze({
    version: 1,
    requestedAt: now.toISOString(),
    invoice: Object.freeze({
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber.slice(0, 120),
      version: invoice.version,
      status: invoice.status,
      currency: invoice.currency,
      totalMinor: invoice.totalCents,
      paidMinor: invoice.paidCents,
      balanceMinor: invoice.balanceCents,
      bookingId: invoice.bookingId,
    }),
    evidence: Object.freeze({ ...input.payload.evidence }),
    replayReceipt,
  });
  const [created] = await tx
    .insert(partnerBillingDisputeRequests)
    .values({
      id: requestId,
      partnerAccountId: accountId,
      partnerInvoiceId: invoice.id,
      partnerBookingId: invoice.bookingId,
      requestedByMembershipId: input.principal.membershipId,
      conversationThreadId: thread.id,
      threadScope: thread.scope,
      category: input.payload.category,
      reason: input.payload.reason,
      requestSnapshot,
      operationKeyHash: input.operationKeyHash,
      requestHash: input.requestHash,
      state: "pending",
      revision: 1,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!created) throw new Error("partner_billing_dispute_create_failed");

  const staffRecipient = await resolvePartnerBookingStaffRecipient(tx);
  if (staffRecipient) {
    await queuePartnerBookingStaffAlert(tx, {
      appointmentId: created.id,
      contactId: null,
      recipient: staffRecipient,
      kind: "partner_billing_dispute_requested",
      body: `A Partner billing request is waiting in Team Partners. Reference ${created.id.slice(0, 8).toUpperCase()}.`,
      actor: {
        partnerUserId: input.principal.partnerUserId,
        sessionId: input.principal.session.id,
        label: input.principal.email,
      },
      correlationId: input.correlationId,
      now,
    });
  }

  await tx.insert(conversationMessages).values({
    threadId: thread.id,
    participantId: thread.participantId,
    direction: "inbound",
    channel: "web",
    subject: "Partner billing request",
    body: initialMessageBody(
      input.payload.category,
      input.payload.reason,
      input.payload.evidence,
    ),
    deliveryStatus: "delivered",
    portalVisible: true,
    authorType: "partner",
    idempotencyKeyHash: createHash("sha256")
      .update(`billing-dispute-message:${input.operationKeyHash}`, "utf8")
      .digest("hex"),
    receivedAt: now,
    metadata: {
      billingDisputeRequestId: created.id,
      category: created.category,
    },
    createdAt: now,
  });
  await tx.insert(outboxEvents).values({
    type: "partner.billing_dispute.requested",
    payload: {
      partnerAccountId: accountId,
      partnerInvoiceId: invoice.id,
      billingDisputeRequestId: created.id,
      state: "pending",
      revision: created.revision,
      correlationId: input.correlationId,
    },
    createdAt: now,
  });
  const auditId = randomUUID();
  await tx.insert(auditLogs).values({
    id: auditId,
    actorType: "human",
    actorId: input.principal.partnerUserId,
    actorLabel: input.principal.email,
    actorRole: input.principal.roleKey,
    sessionId: input.principal.session.id,
    authMethod: "partner_session",
    correlationId: input.correlationId,
    requiredPermissions: ["invoices.disputes.request"],
    outcome: "succeeded",
    surface: "/partners/billing",
    idempotencyKeyHash: input.operationKeyHash,
    action: "partner.billing_dispute.requested",
    entityType: "partner_billing_dispute_request",
    entityId: created.id,
    meta: sanitizeAuditMetadata({
      partnerAccountId: accountId,
      partnerInvoiceId: invoice.id,
      billingDisputeRequestId: created.id,
      category: created.category,
      state: created.state,
      threadScope: created.threadScope,
      monetaryMutationPerformed: false,
      providerActionPerformed: false,
    }),
    createdAt: now,
  });
  return {
    item: initialPublicItem(created),
    invoice,
    replayed: false,
    response: replayReceipt,
  };
}

export async function listPartnerBillingDisputeRequests(
  tx: TeamMutationTransaction,
  input: {
    principal: PartnerPrincipal;
    invoiceId: string;
    cursor?: PartnerBillingDisputeHistoryCursor | null;
    limit?: number;
  },
): Promise<{
  invoice: AccessibleInvoice;
  items: PartnerBillingDisputePublicItem[];
  hasMore: boolean;
  nextCursor: string | null;
}> {
  const invoice = await loadAccessibleInvoice(tx, {
    principal: input.principal,
    invoiceId: input.invoiceId,
    lock: false,
  });
  if (!invoice) {
    throw new PartnerBillingDisputeError(
      "not_found",
      404,
      "Invoice not found.",
    );
  }
  if (input.cursor && input.cursor.invoiceId !== invoice.id) {
    throw new PartnerBillingDisputeError(
      "invalid_cursor",
      422,
      "The cursor belongs to a different invoice history.",
    );
  }
  const limit = Math.min(
    Math.max(Math.floor(input.limit ?? 20), 1),
    MAX_HISTORY_PAGE_SIZE,
  );
  const cursorPredicate = input.cursor
    ? or(
        lt(partnerBillingDisputeRequests.createdAt, input.cursor.createdAt),
        and(
          eq(partnerBillingDisputeRequests.createdAt, input.cursor.createdAt),
          lt(partnerBillingDisputeRequests.id, input.cursor.id),
        ),
      )
    : undefined;
  const rows = await tx
    .select()
    .from(partnerBillingDisputeRequests)
    .where(
      and(
        eq(partnerBillingDisputeRequests.partnerAccountId, invoice.accountId),
        eq(partnerBillingDisputeRequests.partnerInvoiceId, invoice.id),
        cursorPredicate,
      ),
    )
    .orderBy(
      desc(partnerBillingDisputeRequests.createdAt),
      desc(partnerBillingDisputeRequests.id),
    )
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);
  return {
    invoice,
    items: page.map((row) => publicItem(row)),
    hasMore,
    nextCursor:
      hasMore && last
        ? encodePartnerBillingDisputeHistoryCursor({
            createdAt: last.createdAt,
            id: last.id,
            invoiceId: invoice.id,
          })
        : null,
  };
}

export async function decidePartnerBillingDisputeAsStaff(
  tx: TeamMutationTransaction,
  input: {
    requestId: string;
    decision: PartnerBillingDisputeResolution;
    reason: string;
    expectedVersion: string;
    teamMemberId: string;
    correlationId: string;
    now?: Date;
  },
): Promise<{
  requestId: string;
  partnerAccountId: string;
  partnerInvoiceId: string;
  state: PartnerBillingDisputeResolution;
  revision: number;
  resolvedAt: Date;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}> {
  if (!TERMINAL_STATES.includes(input.decision)) {
    throw new TeamMutationFailure("invalid", "Choose a valid outcome.", {
      status: 422,
    });
  }
  const [identity] = await tx
    .select({
      accountId: partnerBillingDisputeRequests.partnerAccountId,
      invoiceId: partnerBillingDisputeRequests.partnerInvoiceId,
    })
    .from(partnerBillingDisputeRequests)
    .where(eq(partnerBillingDisputeRequests.id, input.requestId))
    .limit(1);
  if (!identity) {
    throw new TeamMutationFailure("invalid", "Billing request not found.", {
      status: 404,
    });
  }
  await acquireBillingDisputeLock(tx, identity.accountId, identity.invoiceId);
  const [lockedInvoice] = await tx
    .select({
      version: partnerInvoices.version,
      status: partnerInvoices.status,
    })
    .from(partnerInvoices)
    .where(
      and(
        eq(partnerInvoices.partnerAccountId, identity.accountId),
        eq(partnerInvoices.id, identity.invoiceId),
      ),
    )
    .for("update")
    .limit(1);
  if (!lockedInvoice) {
    throw new TeamMutationFailure("invalid", "Billing request not found.", {
      status: 404,
    });
  }
  const [current] = await tx
    .select({
      id: partnerBillingDisputeRequests.id,
      partnerAccountId: partnerBillingDisputeRequests.partnerAccountId,
      partnerInvoiceId: partnerBillingDisputeRequests.partnerInvoiceId,
      conversationThreadId: partnerBillingDisputeRequests.conversationThreadId,
      state: partnerBillingDisputeRequests.state,
      revision: partnerBillingDisputeRequests.revision,
    })
    .from(partnerBillingDisputeRequests)
    .where(
      and(
        eq(partnerBillingDisputeRequests.id, input.requestId),
        eq(partnerBillingDisputeRequests.partnerAccountId, identity.accountId),
        eq(partnerBillingDisputeRequests.partnerInvoiceId, identity.invoiceId),
      ),
    )
    .for("update", { of: partnerBillingDisputeRequests })
    .limit(1);
  if (!current) {
    throw new TeamMutationFailure("invalid", "Billing request not found.", {
      status: 404,
    });
  }
  assertTeamMutationExpectedVersion(
    { expectedVersion: input.expectedVersion },
    current.revision,
  );
  if (current.state !== "pending") {
    throw new TeamMutationFailure(
      "conflict",
      "This billing request was already resolved. Refresh the queue.",
      { status: 409 },
    );
  }
  const now = input.now ?? new Date();
  const resolutionSnapshot = Object.freeze({
    version: 1 as const,
    outcome: input.decision,
    resolvedAt: now.toISOString(),
    invoiceVersion: lockedInvoice.version,
    invoiceStatus: lockedInvoice.status,
    monetaryMutationPerformed: false as const,
    providerActionPerformed: false as const,
  });
  const [resolved] = await tx
    .update(partnerBillingDisputeRequests)
    .set({
      state: input.decision,
      revision: current.revision + 1,
      resolvedByTeamMemberId: input.teamMemberId,
      resolutionReason: input.reason,
      resolutionSnapshot,
      resolvedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(partnerBillingDisputeRequests.id, current.id),
        eq(partnerBillingDisputeRequests.state, "pending"),
        eq(partnerBillingDisputeRequests.revision, current.revision),
      ),
    )
    .returning({ revision: partnerBillingDisputeRequests.revision });
  if (!resolved) {
    throw new TeamMutationFailure(
      "conflict",
      "Another reviewer resolved this request. Refresh the queue.",
      { status: 409 },
    );
  }
  const label = input.decision.replaceAll("_", " ");
  await tx.insert(conversationMessages).values({
    threadId: current.conversationThreadId,
    direction: "outbound",
    channel: "web",
    subject: "Billing request update",
    body: `Stonegate marked this request ${label}. ${input.reason}`.slice(
      0,
      4_000,
    ),
    deliveryStatus: "delivered",
    portalVisible: true,
    authorType: "staff",
    sentAt: now,
    metadata: {
      billingDisputeRequestId: current.id,
      state: input.decision,
    },
    createdAt: now,
  });
  await tx.insert(outboxEvents).values({
    type: "partner.billing_dispute.resolved",
    payload: {
      partnerAccountId: current.partnerAccountId,
      partnerInvoiceId: current.partnerInvoiceId,
      billingDisputeRequestId: current.id,
      state: input.decision,
      revision: resolved.revision,
      correlationId: input.correlationId,
    },
    createdAt: now,
  });
  return {
    requestId: current.id,
    partnerAccountId: current.partnerAccountId,
    partnerInvoiceId: current.partnerInvoiceId,
    state: input.decision,
    revision: resolved.revision,
    resolvedAt: now,
    before: { state: current.state, revision: current.revision },
    after: {
      state: input.decision,
      revision: resolved.revision,
      monetaryMutationPerformed: false,
      providerActionPerformed: false,
    },
  };
}

export function isPartnerBillingDisputeUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
