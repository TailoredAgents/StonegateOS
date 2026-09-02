import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  appointments,
  auditLogs,
  contacts,
  crmTasks,
  mediaAssets,
  outboxEvents,
  partnerQuotes,
  paymentAttempts,
  payments,
  quoteActivityEvents,
  quoteCapabilities,
  quoteChangeRequests,
  quoteResponses,
  quoteVersionAttachments,
  quoteVersionDocuments,
  quoteVersions,
  quotes,
  salesOpportunities,
  type DatabaseClient,
} from "@/db";
import { sanitizeAuditMetadata } from "@/lib/audit-metadata";
import { getBusinessHoursPolicy } from "@/lib/policy";
import { partnerQuoteApprovalAllowsAcceptance } from "@/lib/partner-quote-v2-approval";
import { reconcileQuoteAcceptanceCertificate } from "@/lib/quote-v2-acceptance-certificate";
import { quoteV2CompletedDepositDisposition } from "@/lib/quote-v2-deposit-evidence";
import { getDefaultSalesAssigneeMemberId } from "@/lib/sales-scorecard";
import type { TeamMutationTransaction } from "@/lib/team-mutation";
import {
  addQuoteChangeBusinessHours,
  canRequestQuoteV2Refresh,
  prepareQuoteV2AcceptanceEvidence,
  quoteV2PublicAllowedActions,
  resolveQuoteV2PublicAppointment,
  safeQuoteV2ResponseMetadata,
  type QuoteV2PublicCapabilitySnapshot,
  QuoteV2PublicStateError,
} from "@/lib/quote-v2-public";
import type {
  PublicQuoteChangeCommandSchema,
  PublicQuoteDecisionCommandSchema,
  PublicQuoteRefreshCommandSchema,
} from "@/lib/quote-v2-contract";
import { QuoteDocumentSnapshotSchema } from "@/lib/quote-v2-contract";
import { calculateQuoteV2Totals } from "@/lib/quote-v2-domain";
import { parseQuoteV2OutboxEvent } from "@/lib/quote-v2-outbox-contract";
import {
  persistQuoteV2TerminalDecision,
  QuoteV2TerminalDecisionConflict,
} from "@/lib/quote-v2-terminal-decision";
import type { z } from "zod";

type QuoteDbExecutor = DatabaseClient | TeamMutationTransaction;
type PublicChangeCommand = z.infer<typeof PublicQuoteChangeCommandSchema>;
type PublicDecisionCommand = z.infer<typeof PublicQuoteDecisionCommandSchema>;
type PublicRefreshCommand = z.infer<typeof PublicQuoteRefreshCommandSchema>;

export type QuoteV2ResolvedCapability = QuoteV2PublicCapabilitySnapshot & {
  tokenHash: string;
  partnerAccountId: string | null;
  currency: string;
  contactDoNotContact: boolean;
  opportunityRevision: number | null;
  opportunityOwnerTeamMemberId: string | null;
};

export type QuoteV2PublicMutationReceipt = {
  quoteId: string;
  versionId: string;
  responseId: string;
  responseType:
    | "accepted"
    | "declined"
    | "change_requested"
    | "refresh_requested";
  changeRequestId?: string;
  taskId?: string;
  appointmentId?: string;
  respondedAt: string;
  replayed: boolean;
  certificateState?: "ready" | "pending";
};

export type QuoteV2AfterAcceptanceHook = (
  tx: TeamMutationTransaction,
  input: {
    quoteId: string;
    versionId: string;
    responseId: string;
    holdId: string | null;
    acceptedDepositCents: number;
    correlationId: string;
  },
) => Promise<{ appointmentId: string; outboxEventId: string } | null>;

async function loadOpenChangeState(
  db: QuoteDbExecutor,
  quoteId: string,
): Promise<boolean> {
  const [open] = await db
    .select({ id: quoteChangeRequests.id })
    .from(quoteChangeRequests)
    .where(
      and(
        eq(quoteChangeRequests.quoteId, quoteId),
        inArray(quoteChangeRequests.status, ["open", "acknowledged"]),
      ),
    )
    .limit(1);
  return Boolean(open);
}

/** Resolves only by a one-way token digest. Raw capability values never enter SQL. */
export async function loadQuoteV2CapabilityByHash(
  db: QuoteDbExecutor,
  input: { tokenHash: string; lock?: boolean },
): Promise<QuoteV2ResolvedCapability | null> {
  if (!/^[0-9a-f]{64}$/u.test(input.tokenHash)) {
    throw new Error("Capability lookup requires a SHA-256 token digest.");
  }
  const baseQuery = db
    .select({
      capabilityId: quoteCapabilities.id,
      capabilityStatus: quoteCapabilities.status,
      recipientRole: quoteCapabilities.recipientRole,
      allowedActions: quoteCapabilities.allowedActions,
      readExpiresAt: quoteCapabilities.readExpiresAt,
      actionExpiresAt: quoteCapabilities.actionExpiresAt,
      revokedAt: quoteCapabilities.revokedAt,
      quoteId: quotes.id,
      quoteNumber: quotes.quoteNumber,
      partnerAccountId: quotes.partnerAccountId,
      aggregateState: quotes.aggregateState,
      aggregateRevision: quotes.aggregateRevision,
      currentVersionId: quotes.currentVersionId,
      publishedVersionId: quotes.publishedVersionId,
      acceptedAppointmentId: quotes.acceptedAppointmentId,
      opportunityId: quotes.salesOpportunityId,
      contactId: quotes.contactId,
      contactDeletedAt: contacts.deletedAt,
      contactDoNotContact: contacts.doNotContact,
      engineVersion: quotes.engineVersion,
      versionId: quoteVersions.id,
      versionNumber: quoteVersions.versionNumber,
      versionState: quoteVersions.state,
      currency: quoteVersions.currency,
      documentSnapshot: quoteVersions.documentSnapshot,
      selectedOptionIds: quoteVersions.selectedOptionIds,
      subtotalMinCents: quoteVersions.subtotalMinCents,
      subtotalMaxCents: quoteVersions.subtotalMaxCents,
      discountMinCents: quoteVersions.discountMinCents,
      discountMaxCents: quoteVersions.discountMaxCents,
      feeMinCents: quoteVersions.feeMinCents,
      feeMaxCents: quoteVersions.feeMaxCents,
      totalMinCents: quoteVersions.totalMinCents,
      totalMaxCents: quoteVersions.totalMaxCents,
      depositCents: quoteVersions.depositCents,
      balanceMinCents: quoteVersions.balanceMinCents,
      balanceMaxCents: quoteVersions.balanceMaxCents,
      contentHash: quoteVersions.contentHash,
      issuedAt: quoteVersions.issuedAt,
      expiresAt: quoteVersions.expiresAt,
    })
    .from(quoteCapabilities)
    .innerJoin(quotes, eq(quotes.id, quoteCapabilities.quoteId))
    .innerJoin(contacts, eq(contacts.id, quotes.contactId))
    .innerJoin(
      quoteVersions,
      and(
        eq(quoteVersions.id, quoteCapabilities.quoteVersionId),
        eq(quoteVersions.quoteId, quotes.id),
      ),
    )
    .where(eq(quoteCapabilities.tokenHash, input.tokenHash))
    .limit(1);
  const rows = input.lock ? await baseQuery.for("update") : await baseQuery;
  const row = rows[0];
  if (!row || row.engineVersion !== "v2") return null;

  const [
    documentRows,
    hasOpenChangeRequest,
    opportunityRows,
    responseRows,
    attachmentRows,
  ] = await Promise.all([
    db
      .select({ sha256: quoteVersionDocuments.sha256 })
      .from(quoteVersionDocuments)
      .where(
        and(
          eq(quoteVersionDocuments.quoteVersionId, row.versionId),
          eq(quoteVersionDocuments.kind, "proposal_pdf"),
        ),
      )
      .orderBy(desc(quoteVersionDocuments.generatedAt))
      .limit(1),
    loadOpenChangeState(db, row.quoteId),
    row.opportunityId
      ? db
          .select({
            status: salesOpportunities.status,
            revision: salesOpportunities.revision,
            ownerTeamMemberId: salesOpportunities.ownerTeamMemberId,
          })
          .from(salesOpportunities)
          .where(eq(salesOpportunities.id, row.opportunityId))
          .limit(1)
      : Promise.resolve([]),
    db
      .select({
        id: quoteResponses.id,
        responseType: quoteResponses.responseType,
        selectedOptionIds: quoteResponses.selectedOptionIds,
        acceptedTotalMinCents: quoteResponses.acceptedTotalMinCents,
        acceptedTotalMaxCents: quoteResponses.acceptedTotalMaxCents,
        acceptedDepositCents: quoteResponses.acceptedDepositCents,
        acceptedBalanceMinCents: quoteResponses.acceptedBalanceMinCents,
        acceptedBalanceMaxCents: quoteResponses.acceptedBalanceMaxCents,
        appointmentId: quoteResponses.appointmentId,
      })
      .from(quoteResponses)
      .where(
        and(
          eq(quoteResponses.quoteId, row.quoteId),
          eq(quoteResponses.quoteVersionId, row.versionId),
          inArray(quoteResponses.responseType, ["accepted", "declined"]),
        ),
      )
      .orderBy(desc(quoteResponses.respondedAt))
      .limit(1),
    db
      .select({
        id: quoteVersionAttachments.id,
        purpose: quoteVersionAttachments.purpose,
        caption: quoteVersionAttachments.label,
        description: quoteVersionAttachments.description,
        fileName: mediaAssets.originalFilename,
        mediaType: mediaAssets.contentType,
        displayOrder: quoteVersionAttachments.position,
      })
      .from(quoteVersionAttachments)
      .innerJoin(
        mediaAssets,
        eq(mediaAssets.id, quoteVersionAttachments.mediaAssetId),
      )
      .where(
        and(
          eq(quoteVersionAttachments.quoteVersionId, row.versionId),
          eq(quoteVersionAttachments.customerVisible, true),
          eq(mediaAssets.status, "ready"),
          isNull(mediaAssets.deletedAt),
        ),
      )
      .orderBy(asc(quoteVersionAttachments.position)),
  ]);
  const opportunity = opportunityRows[0];
  const response = responseRows[0];
  let effective = row;
  if (response?.responseType === "accepted") {
    const document = QuoteDocumentSnapshotSchema.parse(row.documentSnapshot);
    const accepted = calculateQuoteV2Totals(
      document.pricing,
      response.selectedOptionIds,
    );
    if (
      accepted.totalMinCents !== response.acceptedTotalMinCents ||
      accepted.totalMaxCents !== response.acceptedTotalMaxCents ||
      accepted.depositCents !== response.acceptedDepositCents ||
      accepted.balanceMinCents !== response.acceptedBalanceMinCents ||
      accepted.balanceMaxCents !== response.acceptedBalanceMaxCents
    ) {
      throw new Error("quote_v2_accepted_configuration_mismatch");
    }
    effective = {
      ...row,
      selectedOptionIds: accepted.selectedOptionIds,
      subtotalMinCents: accepted.subtotalMinCents,
      subtotalMaxCents: accepted.subtotalMaxCents,
      discountMinCents: accepted.discountMinCents,
      discountMaxCents: accepted.discountMaxCents,
      feeMinCents: accepted.feeMinCents,
      feeMaxCents: accepted.feeMaxCents,
      totalMinCents: accepted.totalMinCents,
      totalMaxCents: accepted.totalMaxCents,
      depositCents: accepted.depositCents,
      balanceMinCents: accepted.balanceMinCents,
      balanceMaxCents: accepted.balanceMaxCents,
    };
  }
  let depositCaptured = false;
  let depositRequiresStaffScheduling = false;
  if (
    response?.responseType === "accepted" &&
    response.acceptedDepositCents !== null &&
    response.acceptedDepositCents > 0
  ) {
    const [captured] = await db
      .select({
        paymentAttemptId: payments.paymentAttemptId,
        provider: payments.provider,
        currency: payments.currency,
        canonicalStatus: payments.canonicalStatus,
        amountCents: payments.amount,
        jobAmountCents: payments.jobAmountCents,
        totalAmountCents: payments.totalAmountCents,
        tipCents: payments.tipCents,
        refundedAmountCents: payments.refundedAmountCents,
        metadata: payments.metadata,
        attemptId: paymentAttempts.id,
        attemptQuoteId: paymentAttempts.quoteId,
        attemptVersionId: paymentAttempts.quoteVersionId,
        attemptResponseId: paymentAttempts.quoteResponseId,
        attemptStatus: paymentAttempts.status,
        attemptExpectedCents: paymentAttempts.requestedJobAmountCents,
        attemptCurrency: paymentAttempts.currency,
      })
      .from(payments)
      .leftJoin(
        paymentAttempts,
        eq(paymentAttempts.id, payments.paymentAttemptId),
      )
      .where(
        and(
          eq(payments.quoteId, row.quoteId),
          eq(payments.quoteVersionId, row.versionId),
          eq(payments.quoteResponseId, response.id),
          eq(payments.quotePaymentKind, "deposit"),
          eq(payments.canonicalStatus, "completed"),
        ),
      )
      .limit(1);
    if (captured) {
      depositCaptured = true;
      const identityMatches =
        captured.paymentAttemptId === captured.attemptId &&
        captured.attemptQuoteId === row.quoteId &&
        captured.attemptVersionId === row.versionId &&
        captured.attemptResponseId === response.id &&
        captured.attemptExpectedCents === response.acceptedDepositCents &&
        captured.attemptCurrency === "USD";
      const lateCapture = Boolean(
        captured.metadata &&
          typeof captured.metadata === "object" &&
          !Array.isArray(captured.metadata) &&
          captured.metadata["lateCapture"] === true,
      );
      const disposition = identityMatches
        ? quoteV2CompletedDepositDisposition({
            expectedCents: response.acceptedDepositCents,
            provider: captured.provider,
            currency: captured.currency,
            canonicalStatus: captured.canonicalStatus,
            amountCents: captured.amountCents,
            jobAmountCents: captured.jobAmountCents,
            totalAmountCents: captured.totalAmountCents,
            tipCents: captured.tipCents,
            refundedAmountCents: captured.refundedAmountCents,
            attemptStatus: captured.attemptStatus ?? "missing",
            lateCapture,
          })
        : "invalid";
      depositRequiresStaffScheduling = disposition !== "bookable";
    }
  }
  const acceptedResponse =
    response?.responseType === "accepted" ? response : null;
  // `quotes.acceptedAppointmentId` is aggregate state shared by every retained
  // capability. It becomes version-visible only through this exact version's
  // accepted response; older superseded documents remain readable without
  // inheriting a later revision's appointment.
  const acceptedAppointmentId = acceptedResponse
    ? row.acceptedAppointmentId
    : null;
  const [appointmentBinding] = acceptedAppointmentId
    ? await db
        .select({
          id: appointments.id,
          quoteVersionId: appointments.quoteVersionId,
          quoteResponseId: appointments.quoteResponseId,
          status: appointments.status,
          startAt: appointments.startAt,
          durationMinutes: appointments.durationMinutes,
          schedulingTimezone: appointments.schedulingTimezone,
          promisedArrivalStartAt: appointments.promisedArrivalStartAt,
          promisedArrivalEndAt: appointments.promisedArrivalEndAt,
        })
        .from(appointments)
        .where(eq(appointments.id, acceptedAppointmentId))
        .limit(1)
    : [];
  const appointment = resolveQuoteV2PublicAppointment({
    acceptedAppointmentId,
    acceptedResponseId: acceptedResponse?.id ?? null,
    acceptedResponseAppointmentId: acceptedResponse?.appointmentId ?? null,
    expectedVersionId: row.versionId,
    appointment: appointmentBinding ?? null,
  });
  return {
    ...effective,
    tokenHash: input.tokenHash,
    contactDeletedAt: row.contactDeletedAt,
    contactDoNotContact: row.contactDoNotContact,
    proposalPdfHash: documentRows[0]?.sha256 ?? null,
    hasOpenChangeRequest,
    depositCaptured,
    depositRequiresStaffScheduling,
    acceptedResponseId: acceptedResponse?.id ?? null,
    acceptedAppointmentId,
    appointment,
    hasTerminalResponse: Boolean(response),
    attachments: attachmentRows.map((attachment) => ({
      id: attachment.id,
      purpose:
        attachment.purpose as QuoteV2ResolvedCapability["attachments"][number]["purpose"],
      caption: attachment.caption ?? attachment.description ?? null,
      fileName: attachment.fileName?.trim() || "proposal-attachment",
      mediaType:
        attachment.mediaType as QuoteV2ResolvedCapability["attachments"][number]["mediaType"],
      displayOrder: attachment.displayOrder,
    })),
    opportunityStatus: opportunity?.status ?? null,
    opportunityRevision: opportunity?.revision ?? null,
    opportunityOwnerTeamMemberId: opportunity?.ownerTeamMemberId ?? null,
  };
}

export async function recordQuoteV2CapabilityUse(
  db: QuoteDbExecutor,
  input: { capabilityId: string; at: Date },
): Promise<void> {
  await db
    .update(quoteCapabilities)
    .set({
      lastUsedAt: input.at,
      useCount: sql`${quoteCapabilities.useCount} + 1`,
      updatedAt: input.at,
    })
    .where(
      and(
        eq(quoteCapabilities.id, input.capabilityId),
        ne(quoteCapabilities.status, "revoked"),
      ),
    );
}

export async function loadQuoteV2ProposalDocument(
  db: QuoteDbExecutor,
  input: { versionId: string; expectedSha256: string },
): Promise<{
  filename: string;
  contentType: string;
  storageObjectKey: string;
  byteSize: number;
  sha256: string;
} | null> {
  const [document] = await db
    .select({
      filename: quoteVersionDocuments.filename,
      contentType: quoteVersionDocuments.contentType,
      storageObjectKey: quoteVersionDocuments.storageObjectKey,
      byteSize: quoteVersionDocuments.byteSize,
      sha256: quoteVersionDocuments.sha256,
    })
    .from(quoteVersionDocuments)
    .where(
      and(
        eq(quoteVersionDocuments.quoteVersionId, input.versionId),
        eq(quoteVersionDocuments.kind, "proposal_pdf"),
        eq(quoteVersionDocuments.sha256, input.expectedSha256),
      ),
    )
    .orderBy(desc(quoteVersionDocuments.generatedAt))
    .limit(1);
  return document ?? null;
}

function assertBoundCapability(
  row: QuoteV2ResolvedCapability,
  input: { quoteId: string; versionId: string },
): void {
  if (row.quoteId !== input.quoteId || row.versionId !== input.versionId) {
    throw new QuoteV2PublicStateError(
      "conflict",
      "This page no longer matches the proposal being acted on. Refresh it before continuing.",
    );
  }
}

function assertAction(
  row: QuoteV2ResolvedCapability,
  action: "change" | "accept" | "decline",
  now: Date,
): void {
  if (row.recipientRole !== "signer") {
    throw new QuoteV2PublicStateError(
      "conflict",
      "This recipient has view-only access to the proposal.",
    );
  }
  const allowed = quoteV2PublicAllowedActions(row, now);
  if (!allowed.includes(action)) {
    const message = row.hasOpenChangeRequest
      ? "A change request is already open for this proposal."
      : row.expiresAt && row.expiresAt <= now
        ? "This proposal expired. Request an updated proposal to continue."
        : "This proposal is no longer open for that action.";
    throw new QuoteV2PublicStateError("conflict", message);
  }
}

function assertRefreshAction(row: QuoteV2ResolvedCapability, now: Date): void {
  if (row.recipientRole !== "signer") {
    throw new QuoteV2PublicStateError(
      "conflict",
      "This recipient has view-only access to the proposal.",
    );
  }
  if (row.hasOpenChangeRequest) {
    throw new QuoteV2PublicStateError(
      "conflict",
      "An updated proposal is already being prepared.",
    );
  }
  if (!canRequestQuoteV2Refresh(row, now)) {
    const message =
      (row.versionState !== "issued" && row.versionState !== "expired") ||
      row.currentVersionId !== row.versionId ||
      row.publishedVersionId !== row.versionId ||
      row.hasTerminalResponse
        ? "This proposal version is no longer eligible for an update request."
        : !row.expiresAt || row.expiresAt > now
          ? "An updated proposal can be requested after this version expires."
          : "This project is no longer open for an updated proposal request.";
    throw new QuoteV2PublicStateError("conflict", message);
  }
}

/**
 * A replay remains a capability-authorized read of mutation evidence. Check
 * only durable access state before replay; lifecycle/action state stays after
 * replay so an active caller can recover the original receipt after the first
 * request legitimately changed the quote.
 */
function assertPublicMutationAccess(
  row: QuoteV2ResolvedCapability,
  now: Date,
  action: "change" | "refresh" | "accept" | "decline",
): void {
  if (
    row.capabilityStatus === "revoked" ||
    row.revokedAt ||
    row.readExpiresAt <= now ||
    row.contactDeletedAt
  ) {
    throw new QuoteV2PublicStateError(
      "gone",
      "This proposal link is no longer available.",
    );
  }
  if (row.capabilityStatus !== "active") {
    throw new QuoteV2PublicStateError(
      "conflict",
      "This proposal link is read-only for customer actions.",
    );
  }
  if (row.recipientRole !== "signer") {
    throw new QuoteV2PublicStateError(
      "conflict",
      "This recipient has view-only access to the proposal.",
    );
  }
  const staticallyGranted =
    action === "refresh"
      ? row.allowedActions.includes("refresh") ||
        row.allowedActions.includes("change")
      : row.allowedActions.includes(action);
  if (!staticallyGranted) {
    throw new QuoteV2PublicStateError(
      "conflict",
      "This proposal link does not permit that customer action.",
    );
  }
}

function priorRequestHash(row: { requestMetadata: unknown }): string | null {
  const metadata = row.requestMetadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const value = (metadata as Record<string, unknown>)["requestHash"];
  return typeof value === "string" ? value : null;
}

function priorCapabilityId(row: { requestMetadata: unknown }): string | null {
  const metadata = row.requestMetadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const value = (metadata as Record<string, unknown>)["capabilityId"];
  return typeof value === "string" ? value : null;
}

async function findReplay(
  tx: TeamMutationTransaction,
  input: {
    versionId: string;
    keyHash: string;
    requestHash: string;
    capabilityId: string;
    expectedType: QuoteV2PublicMutationReceipt["responseType"];
  },
): Promise<QuoteV2PublicMutationReceipt | null> {
  const [existing] = await tx
    .select({
      id: quoteResponses.id,
      quoteId: quoteResponses.quoteId,
      versionId: quoteResponses.quoteVersionId,
      responseType: quoteResponses.responseType,
      appointmentId: quoteResponses.appointmentId,
      changeRequestId: quoteResponses.changeRequestId,
      requestMetadata: quoteResponses.requestMetadata,
      respondedAt: quoteResponses.respondedAt,
    })
    .from(quoteResponses)
    .where(
      and(
        eq(quoteResponses.quoteVersionId, input.versionId),
        eq(quoteResponses.idempotencyKeyHash, input.keyHash),
      ),
    )
    .limit(1);
  if (!existing) return null;
  if (
    priorRequestHash(existing) !== input.requestHash ||
    priorCapabilityId(existing) !== input.capabilityId ||
    existing.responseType !== input.expectedType
  ) {
    throw new QuoteV2PublicStateError(
      "conflict",
      "This request key was already used for a different proposal action.",
    );
  }
  const appointmentId =
    existing.appointmentId ??
    (
      await tx
        .select({ id: appointments.id })
        .from(appointments)
        .where(eq(appointments.quoteResponseId, existing.id))
        .limit(1)
    )[0]?.id ??
    null;
  return {
    quoteId: existing.quoteId,
    versionId: existing.versionId,
    responseId: existing.id,
    responseType: input.expectedType,
    ...(existing.changeRequestId
      ? { changeRequestId: existing.changeRequestId }
      : {}),
    ...(appointmentId ? { appointmentId } : {}),
    respondedAt: existing.respondedAt.toISOString(),
    replayed: true,
  };
}

async function insertV2OutboxEvent(
  tx: TeamMutationTransaction,
  input: {
    type: "quote.change_requested.v2" | "quote.response_recorded.v2";
    quoteId: string;
    versionId: string;
    responseId: string;
    correlationId: string;
    occurredAt: Date;
  },
): Promise<string> {
  const eventId = randomUUID();
  const payload = {
    schemaVersion: 2 as const,
    eventId,
    quoteId: input.quoteId,
    versionId: input.versionId,
    responseId: input.responseId,
    correlationId: input.correlationId,
    occurredAt: input.occurredAt.toISOString(),
  };
  parseQuoteV2OutboxEvent({ type: input.type, payload });
  const [event] = await tx
    .insert(outboxEvents)
    .values({
      id: eventId,
      type: input.type,
      payload,
      createdAt: input.occurredAt,
    })
    .returning({ id: outboxEvents.id });
  if (!event) throw new Error("quote_v2_outbox_event_not_persisted");
  return event.id;
}

async function insertPublicActivity(
  tx: TeamMutationTransaction,
  input: {
    quoteId: string;
    versionId: string;
    eventType: string;
    outboxEventId: string;
    correlationId: string;
    occurredAt: Date;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  await tx.insert(quoteActivityEvents).values({
    quoteId: input.quoteId,
    quoteVersionId: input.versionId,
    eventType: input.eventType,
    actorType: "customer",
    outboxEventId: input.outboxEventId,
    correlationId: input.correlationId,
    metadata: input.metadata,
    occurredAt: input.occurredAt,
    createdAt: input.occurredAt,
  });
}

async function insertPublicAudit(
  tx: TeamMutationTransaction,
  input: {
    correlationId: string;
    keyHash: string;
    action: string;
    entityType: string;
    entityId: string;
    quoteId: string;
    versionId: string;
    outboxEventId: string;
    occurredAt: Date;
  },
): Promise<void> {
  await tx.insert(auditLogs).values({
    actorType: "system",
    actorLabel: "quote-v2-public-capability",
    correlationId: input.correlationId,
    idempotencyKeyHash: input.keyHash,
    outcome: "succeeded",
    surface: "/api/public/quotes/[capability]",
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    meta: sanitizeAuditMetadata({
      quoteId: input.quoteId,
      versionId: input.versionId,
      outboxEventId: input.outboxEventId,
      capabilityTokenStored: false,
    }),
    createdAt: input.occurredAt,
  });
}

export async function recordQuoteV2ChangeRequest(
  db: DatabaseClient,
  input: {
    tokenHash: string;
    command: PublicChangeCommand;
    idempotencyKeyHash: string;
    requestHash: string;
    correlationId: string;
    now?: Date;
  },
): Promise<QuoteV2PublicMutationReceipt> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const row = await loadQuoteV2CapabilityByHash(tx, {
      tokenHash: input.tokenHash,
      lock: true,
    });
    if (!row) {
      throw new QuoteV2PublicStateError(
        "gone",
        "This proposal link is no longer available.",
      );
    }
    assertBoundCapability(row, input.command);
    assertPublicMutationAccess(row, now, "change");
    const replay = await findReplay(tx, {
      versionId: row.versionId,
      keyHash: input.idempotencyKeyHash,
      requestHash: input.requestHash,
      capabilityId: row.capabilityId,
      expectedType: "change_requested",
    });
    if (replay) return replay;
    assertAction(row, "change", now);
    if (
      !row.opportunityId ||
      row.opportunityStatus !== "open" ||
      !row.opportunityRevision ||
      !row.aggregateRevision
    ) {
      throw new QuoteV2PublicStateError(
        "conflict",
        "This project is no longer open for proposal changes.",
      );
    }

    const businessHours = await getBusinessHoursPolicy(tx);
    const dueAt = addQuoteChangeBusinessHours({
      at: now,
      hours: 4,
      policy: businessHours,
    });
    const [contact] = await tx
      .select({ salespersonMemberId: contacts.salespersonMemberId })
      .from(contacts)
      .where(eq(contacts.id, row.contactId))
      .limit(1);
    const assignedTo =
      row.opportunityOwnerTeamMemberId ??
      contact?.salespersonMemberId ??
      (await getDefaultSalesAssigneeMemberId(tx)) ??
      null;
    const [task] = await tx
      .insert(crmTasks)
      .values({
        salesOpportunityId: row.opportunityId,
        contactId: row.contactId,
        title: "Review quote change request",
        dueAt,
        assignedTo,
        status: "open",
        notes: [
          `Quote ID: ${row.quoteId}`,
          `Version ID: ${row.versionId}`,
          `Category: ${input.command.category}`,
          `Customer message: ${input.command.message}`,
        ].join("\n"),
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: crmTasks.id });
    if (!task) throw new Error("quote_v2_change_owner_task_not_persisted");
    const [change] = await tx
      .insert(quoteChangeRequests)
      .values({
        quoteId: row.quoteId,
        quoteVersionId: row.versionId,
        expectedRevision: row.aggregateRevision,
        requestKeyHash: input.idempotencyKeyHash,
        status: "open",
        reason: input.command.category,
        message: input.command.message,
        ownerTaskId: task.id,
        dueAt,
        createdAt: now,
      })
      .returning({ id: quoteChangeRequests.id });
    if (!change) throw new Error("quote_v2_change_request_not_persisted");
    const [response] = await tx
      .insert(quoteResponses)
      .values({
        quoteId: row.quoteId,
        quoteVersionId: row.versionId,
        responseType: "change_requested",
        source: "customer",
        changeRequestId: change.id,
        reason: input.command.category,
        message: input.command.message,
        idempotencyKeyHash: input.idempotencyKeyHash,
        requestMetadata: safeQuoteV2ResponseMetadata({
          requestHash: input.requestHash,
          capabilityId: row.capabilityId,
          evidenceQuality: "basic",
        }),
        respondedAt: now,
        createdAt: now,
      })
      .returning({ id: quoteResponses.id });
    if (!response) throw new Error("quote_v2_change_response_not_persisted");

    const [opportunity] = await tx
      .update(salesOpportunities)
      .set({
        pipelineStage: "changes_requested",
        revision: row.opportunityRevision + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(salesOpportunities.id, row.opportunityId),
          eq(salesOpportunities.status, "open"),
          eq(salesOpportunities.revision, row.opportunityRevision),
        ),
      )
      .returning({ id: salesOpportunities.id });
    if (!opportunity) {
      throw new QuoteV2PublicStateError(
        "conflict",
        "The project changed while this request was submitted. Try again.",
      );
    }

    const outboxEventId = await insertV2OutboxEvent(tx, {
      type: "quote.change_requested.v2",
      quoteId: row.quoteId,
      versionId: row.versionId,
      responseId: response.id,
      correlationId: input.correlationId,
      occurredAt: now,
    });
    await insertPublicActivity(tx, {
      quoteId: row.quoteId,
      versionId: row.versionId,
      eventType: "change_requested",
      outboxEventId,
      correlationId: input.correlationId,
      occurredAt: now,
      metadata: {
        changeRequestId: change.id,
        ownerTaskId: task.id,
        category: input.command.category,
        dueAt: dueAt.toISOString(),
      },
    });
    await insertPublicAudit(tx, {
      correlationId: input.correlationId,
      keyHash: input.idempotencyKeyHash,
      action: "quote.public_change_requested.v2",
      entityType: "quote_change_request",
      entityId: change.id,
      quoteId: row.quoteId,
      versionId: row.versionId,
      outboxEventId,
      occurredAt: now,
    });
    return {
      quoteId: row.quoteId,
      versionId: row.versionId,
      responseId: response.id,
      responseType: "change_requested",
      changeRequestId: change.id,
      taskId: task.id,
      respondedAt: now.toISOString(),
      replayed: false,
    };
  });
}

export async function recordQuoteV2RefreshRequest(
  db: DatabaseClient,
  input: {
    tokenHash: string;
    command: PublicRefreshCommand;
    idempotencyKeyHash: string;
    requestHash: string;
    correlationId: string;
    now?: Date;
  },
): Promise<QuoteV2PublicMutationReceipt> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const row = await loadQuoteV2CapabilityByHash(tx, {
      tokenHash: input.tokenHash,
      lock: true,
    });
    if (!row) {
      throw new QuoteV2PublicStateError(
        "gone",
        "This proposal link is no longer available.",
      );
    }
    assertBoundCapability(row, input.command);
    assertPublicMutationAccess(row, now, "refresh");
    const replay = await findReplay(tx, {
      versionId: row.versionId,
      keyHash: input.idempotencyKeyHash,
      requestHash: input.requestHash,
      capabilityId: row.capabilityId,
      expectedType: "refresh_requested",
    });
    if (replay) return replay;
    assertRefreshAction(row, now);
    if (
      !row.opportunityId ||
      row.opportunityStatus !== "open" ||
      !row.opportunityRevision ||
      !row.aggregateRevision
    ) {
      throw new QuoteV2PublicStateError(
        "conflict",
        "This project is no longer open for an updated proposal request.",
      );
    }

    const businessHours = await getBusinessHoursPolicy(tx);
    const dueAt = addQuoteChangeBusinessHours({
      at: now,
      hours: 4,
      policy: businessHours,
    });
    const [contact] = await tx
      .select({ salespersonMemberId: contacts.salespersonMemberId })
      .from(contacts)
      .where(eq(contacts.id, row.contactId))
      .limit(1);
    const assignedTo =
      row.opportunityOwnerTeamMemberId ??
      contact?.salespersonMemberId ??
      (await getDefaultSalesAssigneeMemberId(tx)) ??
      null;
    if (!assignedTo) {
      throw new QuoteV2PublicStateError(
        "provider_unavailable",
        "The updated proposal request cannot be assigned right now. Please try again.",
      );
    }

    const [task] = await tx
      .insert(crmTasks)
      .values({
        salesOpportunityId: row.opportunityId,
        contactId: row.contactId,
        title: "Prepare updated expired proposal",
        dueAt,
        assignedTo,
        status: "open",
        notes: [
          `Quote ID: ${row.quoteId}`,
          `Version ID: ${row.versionId}`,
          "Reason: expired_refresh",
          input.command.message
            ? `Customer note: ${input.command.message}`
            : null,
        ]
          .filter((line): line is string => Boolean(line))
          .join("\n"),
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: crmTasks.id });
    if (!task) throw new Error("quote_v2_refresh_owner_task_not_persisted");

    const [change] = await tx
      .insert(quoteChangeRequests)
      .values({
        quoteId: row.quoteId,
        quoteVersionId: row.versionId,
        expectedRevision: row.aggregateRevision,
        requestKeyHash: input.idempotencyKeyHash,
        status: "open",
        reason: "expired_refresh",
        message: input.command.message ?? null,
        ownerTaskId: task.id,
        dueAt,
        createdAt: now,
      })
      .returning({ id: quoteChangeRequests.id });
    if (!change) throw new Error("quote_v2_refresh_request_not_persisted");

    const [response] = await tx
      .insert(quoteResponses)
      .values({
        quoteId: row.quoteId,
        quoteVersionId: row.versionId,
        responseType: "refresh_requested",
        source: "customer",
        changeRequestId: change.id,
        reason: "expired_refresh",
        message: input.command.message ?? null,
        idempotencyKeyHash: input.idempotencyKeyHash,
        requestMetadata: safeQuoteV2ResponseMetadata({
          requestHash: input.requestHash,
          capabilityId: row.capabilityId,
          evidenceQuality: "basic",
        }),
        respondedAt: now,
        createdAt: now,
      })
      .returning({ id: quoteResponses.id });
    if (!response) throw new Error("quote_v2_refresh_response_not_persisted");

    const [markedQuote] = await tx
      .update(quotes)
      .set({ refreshRequestedAt: now, updatedAt: now })
      .where(
        and(
          eq(quotes.id, row.quoteId),
          eq(quotes.currentVersionId, row.versionId),
          eq(quotes.publishedVersionId, row.versionId),
          eq(quotes.aggregateState, "open"),
          eq(quotes.aggregateRevision, row.aggregateRevision),
        ),
      )
      .returning({ id: quotes.id });
    if (!markedQuote) {
      throw new QuoteV2PublicStateError(
        "conflict",
        "The proposal changed while this request was submitted. Refresh the page.",
      );
    }

    const [opportunity] = await tx
      .update(salesOpportunities)
      .set({
        pipelineStage: "changes_requested",
        revision: row.opportunityRevision + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(salesOpportunities.id, row.opportunityId),
          eq(salesOpportunities.status, "open"),
          eq(salesOpportunities.revision, row.opportunityRevision),
        ),
      )
      .returning({ id: salesOpportunities.id });
    if (!opportunity) {
      throw new QuoteV2PublicStateError(
        "conflict",
        "The project changed while this request was submitted. Try again.",
      );
    }

    const outboxEventId = await insertV2OutboxEvent(tx, {
      type: "quote.change_requested.v2",
      quoteId: row.quoteId,
      versionId: row.versionId,
      responseId: response.id,
      correlationId: input.correlationId,
      occurredAt: now,
    });
    await insertPublicActivity(tx, {
      quoteId: row.quoteId,
      versionId: row.versionId,
      eventType: "refresh_requested",
      outboxEventId,
      correlationId: input.correlationId,
      occurredAt: now,
      metadata: {
        responseId: response.id,
        changeRequestId: change.id,
        ownerTaskId: task.id,
        dueAt: dueAt.toISOString(),
      },
    });
    await insertPublicAudit(tx, {
      correlationId: input.correlationId,
      keyHash: input.idempotencyKeyHash,
      action: "quote.public_refresh_requested.v2",
      entityType: "quote_change_request",
      entityId: change.id,
      quoteId: row.quoteId,
      versionId: row.versionId,
      outboxEventId,
      occurredAt: now,
    });
    return {
      quoteId: row.quoteId,
      versionId: row.versionId,
      responseId: response.id,
      responseType: "refresh_requested",
      changeRequestId: change.id,
      taskId: task.id,
      respondedAt: now.toISOString(),
      replayed: false,
    };
  });
}

export async function recordQuoteV2Decision(
  db: DatabaseClient,
  input: {
    tokenHash: string;
    command: PublicDecisionCommand;
    idempotencyKeyHash: string;
    requestHash: string;
    correlationId: string;
    now?: Date;
    afterAcceptance?: QuoteV2AfterAcceptanceHook;
  },
): Promise<QuoteV2PublicMutationReceipt> {
  const now = input.now ?? new Date();
  const receipt = await db.transaction(async (tx) => {
    const row = await loadQuoteV2CapabilityByHash(tx, {
      tokenHash: input.tokenHash,
      lock: true,
    });
    if (!row) {
      throw new QuoteV2PublicStateError(
        "gone",
        "This proposal link is no longer available.",
      );
    }
    assertBoundCapability(row, input.command);
    const responseType = input.command.decision;
    const acceptedCommand =
      input.command.decision === "accepted" ? input.command : null;
    const action = responseType === "accepted" ? "accept" : "decline";
    assertPublicMutationAccess(row, now, action);
    const replay = await findReplay(tx, {
      versionId: row.versionId,
      keyHash: input.idempotencyKeyHash,
      requestHash: input.requestHash,
      capabilityId: row.capabilityId,
      expectedType: responseType,
    });
    if (replay) return replay;
    assertAction(row, action, now);
    if (
      !row.opportunityId ||
      !row.quoteNumber ||
      row.opportunityStatus !== "open" ||
      !row.opportunityRevision ||
      !row.aggregateRevision
    ) {
      throw new QuoteV2PublicStateError(
        "conflict",
        "This project is no longer open for a proposal response.",
      );
    }

    let responseValues: typeof quoteResponses.$inferInsert;
    let acceptedTotals:
      | ReturnType<typeof prepareQuoteV2AcceptanceEvidence>["totals"]
      | null = null;
    if (input.command.decision === "accepted") {
      const evidence = prepareQuoteV2AcceptanceEvidence({
        row,
        selectedOptionIds: input.command.selectedOptionIds,
        signer: input.command.signer,
        consentVersion: input.command.consentVersion,
        consentAffirmed: input.command.consentAffirmed,
        requestedStartAt: input.command.requestedStartAt,
        holdId: input.command.holdId,
      });
      if (row.partnerAccountId) {
        const [binding] = await tx
          .select({
            accountId: partnerQuotes.partnerAccountId,
            bookingId: partnerQuotes.partnerBookingId,
            bookingDraftId: partnerQuotes.bookingDraftId,
          })
          .from(partnerQuotes)
          .where(
            and(
              eq(partnerQuotes.quoteId, row.quoteId),
              eq(partnerQuotes.partnerAccountId, row.partnerAccountId),
              eq(partnerQuotes.authority, "quote_v2"),
            ),
          )
          .limit(1);
        if (!binding) {
          throw new QuoteV2PublicStateError(
            "provider_unavailable",
            "This account proposal cannot be verified right now.",
          );
        }
        const approvalAllowed = await partnerQuoteApprovalAllowsAcceptance(tx, {
          accountId: binding.accountId,
          bookingId: binding.bookingId,
          bookingDraftId: binding.bookingDraftId,
          totalMinCents: evidence.totals.totalMinCents,
          totalMaxCents: evidence.totals.totalMaxCents,
          currency: row.currency,
        });
        if (!approvalAllowed) {
          throw new QuoteV2PublicStateError(
            "invalid",
            "This account requires an approved request for the exact proposal amount before acceptance.",
          );
        }
      }
      acceptedTotals = evidence.totals;
      responseValues = {
        quoteId: row.quoteId,
        quoteVersionId: row.versionId,
        responseType: "accepted",
        source: "customer",
        signerSnapshot: evidence.signerSnapshot,
        configurationSnapshot: evidence.configurationSnapshot,
        selectedOptionIds: evidence.selectedOptionIds,
        consentText: evidence.consentText,
        consentVersion: evidence.consentVersion,
        consentAffirmed: true,
        configurationHash: evidence.configurationHash,
        consentHash: evidence.consentHash,
        contentHash: evidence.contentHash,
        issuedPdfHash: evidence.issuedPdfHash,
        acceptedTotalMinCents: evidence.totals.totalMinCents,
        acceptedTotalMaxCents: evidence.totals.totalMaxCents,
        acceptedDepositCents: evidence.totals.depositCents,
        acceptedBalanceMinCents: evidence.totals.balanceMinCents,
        acceptedBalanceMaxCents: evidence.totals.balanceMaxCents,
        idempotencyKeyHash: input.idempotencyKeyHash,
        requestMetadata: safeQuoteV2ResponseMetadata({
          requestHash: input.requestHash,
          capabilityId: row.capabilityId,
          evidenceQuality: "exact",
          certificateIntent: true,
        }),
        respondedAt: now,
        createdAt: now,
      };
    } else {
      responseValues = {
        quoteId: row.quoteId,
        quoteVersionId: row.versionId,
        responseType: "declined",
        source: "customer",
        signerSnapshot: { name: input.command.signerName },
        reason: input.command.category,
        message: input.command.notes ?? null,
        idempotencyKeyHash: input.idempotencyKeyHash,
        requestMetadata: safeQuoteV2ResponseMetadata({
          requestHash: input.requestHash,
          capabilityId: row.capabilityId,
          evidenceQuality: "basic",
        }),
        respondedAt: now,
        createdAt: now,
      };
    }

    let terminal;
    try {
      terminal = await persistQuoteV2TerminalDecision(tx, {
        context: {
          quoteId: row.quoteId,
          quoteNumber: row.quoteNumber,
          versionId: row.versionId,
          versionNumber: row.versionNumber,
          contactId: row.contactId,
          opportunityId: row.opportunityId,
          opportunityStatus: "open",
          opportunityRevision: row.opportunityRevision,
          quoteRevision: row.aggregateRevision,
        },
        decision: responseType,
        responseValues,
        acceptedTotals,
        decisionNotes:
          input.command.decision === "declined"
            ? [input.command.category, input.command.notes]
                .filter((value): value is string => Boolean(value))
                .join("\n")
            : null,
        correlationId: input.correlationId,
        now,
        ...(input.afterAcceptance && acceptedCommand
          ? {
              afterAcceptance: (decisionTx, decision) =>
                input.afterAcceptance!(decisionTx, {
                  ...decision,
                  holdId: acceptedCommand.holdId ?? null,
                }),
            }
          : {}),
      });
    } catch (error) {
      if (error instanceof QuoteV2TerminalDecisionConflict) {
        throw new QuoteV2PublicStateError("conflict", error.message);
      }
      throw error;
    }
    if (!terminal.appointmentId) {
      await insertPublicActivity(tx, {
        quoteId: row.quoteId,
        versionId: row.versionId,
        eventType: responseType,
        outboxEventId: terminal.outboxEventId,
        correlationId: input.correlationId,
        occurredAt: now,
        metadata: {
          responseId: terminal.responseId,
          evidenceQuality: responseType === "accepted" ? "exact" : "basic",
          selectedOptionCount: acceptedTotals?.selectedOptionIds.length ?? 0,
        },
      });
    }
    await insertPublicAudit(tx, {
      correlationId: input.correlationId,
      keyHash: input.idempotencyKeyHash,
      action: `quote.public_${responseType}.v2`,
      entityType: "quote_response",
      entityId: terminal.responseId,
      quoteId: row.quoteId,
      versionId: row.versionId,
      outboxEventId: terminal.outboxEventId,
      occurredAt: now,
    });
    return {
      quoteId: row.quoteId,
      versionId: row.versionId,
      responseId: terminal.responseId,
      responseType,
      ...(terminal.appointmentId
        ? { appointmentId: terminal.appointmentId }
        : {}),
      respondedAt: now.toISOString(),
      replayed: false,
    };
  });
  if (receipt.responseType === "accepted") {
    const certificate = await reconcileQuoteAcceptanceCertificate(db, {
      responseId: receipt.responseId,
      correlationId: input.correlationId,
      now,
    });
    return { ...receipt, certificateState: certificate.state };
  }
  return receipt;
}
