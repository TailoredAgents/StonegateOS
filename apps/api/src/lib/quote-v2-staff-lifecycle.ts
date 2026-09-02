import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { z } from "zod";
import type { quoteResponses } from "@/db";
import {
  appointmentHolds,
  contacts,
  crmTasks,
  partnerQuotes,
  quoteActivityEvents,
  quoteCapabilities,
  quoteChangeRequests,
  quoteVersionDocuments,
  quoteVersions,
  quotes,
  salesOpportunities,
} from "@/db";
import { acquireScheduleConflictLock } from "@/lib/appointment-schedule-conflicts";
import { partnerQuoteApprovalAllowsAcceptance } from "@/lib/partner-quote-v2-approval";
import {
  QuoteV2ArchiveCommandSchema,
  QuoteV2ChangeResolutionCommandSchema,
  QuoteV2StaffDecisionCommandSchema,
  QuoteV2VoidCommandSchema,
} from "@/lib/quote-v2-contract";
import { quoteCapabilityReadExpiry } from "@/lib/quote-v2-capability";
import {
  assertSalesOpportunityTransition,
  QuoteDomainError,
  SalesOpportunityStateSchema,
  type SalesOpportunityState,
} from "@/lib/quote-v2-domain";
import {
  persistQuoteV2TerminalDecision,
  QuoteV2TerminalDecisionConflict,
} from "@/lib/quote-v2-terminal-decision";
import {
  prepareQuoteV2AcceptanceEvidence,
  QuoteV2PublicStateError,
} from "@/lib/quote-v2-public";
import { queueSystemOutboundMessage } from "@/lib/system-outbound";
import {
  TeamMutationFailure,
  type TeamMutationTransaction,
} from "@/lib/team-mutation";

export type QuoteV2StaffDecisionCommand = z.infer<
  typeof QuoteV2StaffDecisionCommandSchema
>;
export type QuoteV2ChangeResolutionCommand = z.infer<
  typeof QuoteV2ChangeResolutionCommandSchema
>;
export type QuoteV2VoidCommand = z.infer<typeof QuoteV2VoidCommandSchema>;
export type QuoteV2ArchiveCommand = z.infer<typeof QuoteV2ArchiveCommandSchema>;

type LockedQuote = {
  id: string;
  quoteNumber: string;
  contactId: string;
  partnerAccountId: string | null;
  opportunityId: string;
  aggregateState: string;
  aggregateRevision: number;
  currentVersionId: string | null;
  publishedVersionId: string | null;
  acceptedAppointmentId: string | null;
};

type LockedVersion = {
  id: string;
  quoteId: string;
  versionNumber: number;
  supersedesVersionId: string | null;
  state: string;
  documentSnapshot: Record<string, unknown>;
  contentHash: string | null;
  issuedAt: Date | null;
  expiresAt: Date | null;
};

type LockedOpportunity = {
  id: string;
  status: SalesOpportunityState;
  revision: number;
  pipelineStage: string | null;
  closedAt: Date | null;
};

export type QuoteV2LifecycleOperation =
  | "accept"
  | "decline"
  | "resolve_change"
  | "void"
  | "archive";

export function quoteV2LifecycleOpportunityTarget(input: {
  operation: QuoteV2LifecycleOperation;
  currentStatus: SalesOpportunityState;
  hasOtherRelevantQuote: boolean;
}): {
  status: SalesOpportunityState;
  pipelineStage?: string;
  closes: boolean;
} {
  if (input.operation === "accept") {
    return { status: "approved", pipelineStage: "approved", closes: false };
  }
  if (input.operation === "resolve_change") {
    return { status: "open", pipelineStage: "quoted", closes: false };
  }
  if (input.operation === "archive") {
    return input.hasOtherRelevantQuote
      ? { status: input.currentStatus, closes: false }
      : { status: "archived", pipelineStage: "archived", closes: true };
  }
  return input.hasOtherRelevantQuote
    ? { status: "open", pipelineStage: "quoted", closes: false }
    : { status: "lost", pipelineStage: "lost", closes: true };
}

async function lockQuote(
  tx: TeamMutationTransaction,
  quoteId: string,
  expectedRevision: number,
): Promise<LockedQuote> {
  const [row] = await tx
    .select({
      id: quotes.id,
      quoteNumber: quotes.quoteNumber,
      contactId: quotes.contactId,
      partnerAccountId: quotes.partnerAccountId,
      opportunityId: quotes.salesOpportunityId,
      engineVersion: quotes.engineVersion,
      aggregateState: quotes.aggregateState,
      aggregateRevision: quotes.aggregateRevision,
      currentVersionId: quotes.currentVersionId,
      publishedVersionId: quotes.publishedVersionId,
      acceptedAppointmentId: quotes.acceptedAppointmentId,
    })
    .from(quotes)
    .where(eq(quotes.id, quoteId))
    .for("update")
    .limit(1);
  if (
    !row ||
    row.engineVersion !== "v2" ||
    !row.quoteNumber ||
    !row.opportunityId ||
    !row.aggregateState ||
    !row.aggregateRevision
  ) {
    throw new TeamMutationFailure(
      "invalid",
      "The versioned quote was not found.",
      { status: 404 },
    );
  }
  if (row.aggregateRevision !== expectedRevision) {
    throw new TeamMutationFailure(
      "conflict",
      "The quote changed after it was loaded. Refresh and try again.",
      {
        retryable: true,
        fieldErrors: { version: "The submitted quote revision is stale." },
      },
    );
  }
  return {
    id: row.id,
    quoteNumber: row.quoteNumber,
    contactId: row.contactId,
    partnerAccountId: row.partnerAccountId,
    opportunityId: row.opportunityId,
    aggregateState: row.aggregateState,
    aggregateRevision: row.aggregateRevision,
    currentVersionId: row.currentVersionId,
    publishedVersionId: row.publishedVersionId,
    acceptedAppointmentId: row.acceptedAppointmentId,
  };
}

async function lockVersion(
  tx: TeamMutationTransaction,
  quoteId: string,
  versionId: string,
): Promise<LockedVersion> {
  const [version] = await tx
    .select({
      id: quoteVersions.id,
      quoteId: quoteVersions.quoteId,
      versionNumber: quoteVersions.versionNumber,
      supersedesVersionId: quoteVersions.supersedesVersionId,
      state: quoteVersions.state,
      documentSnapshot: quoteVersions.documentSnapshot,
      contentHash: quoteVersions.contentHash,
      issuedAt: quoteVersions.issuedAt,
      expiresAt: quoteVersions.expiresAt,
    })
    .from(quoteVersions)
    .where(
      and(eq(quoteVersions.id, versionId), eq(quoteVersions.quoteId, quoteId)),
    )
    .for("update")
    .limit(1);
  if (!version) {
    throw new TeamMutationFailure(
      "invalid",
      "The bound proposal version was not found.",
      { status: 404 },
    );
  }
  return version;
}

async function lockOpportunity(
  tx: TeamMutationTransaction,
  opportunityId: string,
): Promise<LockedOpportunity> {
  const [row] = await tx
    .select({
      id: salesOpportunities.id,
      status: salesOpportunities.status,
      revision: salesOpportunities.revision,
      pipelineStage: salesOpportunities.pipelineStage,
      closedAt: salesOpportunities.closedAt,
    })
    .from(salesOpportunities)
    .where(eq(salesOpportunities.id, opportunityId))
    .for("update")
    .limit(1);
  const status = SalesOpportunityStateSchema.safeParse(row?.status);
  if (!row || !status.success) {
    throw new TeamMutationFailure(
      "conflict",
      "The quote project is no longer available for this action.",
    );
  }
  return { ...row, status: status.data };
}

function assertOpportunityMove(
  current: SalesOpportunityState,
  target: SalesOpportunityState,
): void {
  if (current === target) return;
  try {
    assertSalesOpportunityTransition(current, target);
  } catch (error) {
    if (error instanceof QuoteDomainError) {
      throw new TeamMutationFailure(
        "conflict",
        "The project lifecycle no longer permits this quote action.",
      );
    }
    throw error;
  }
}

async function updateOpportunity(
  tx: TeamMutationTransaction,
  input: {
    opportunity: LockedOpportunity;
    target: ReturnType<typeof quoteV2LifecycleOpportunityTarget>;
    estimatedValueCents?: number;
    now: Date;
  },
): Promise<number> {
  assertOpportunityMove(input.opportunity.status, input.target.status);
  const nextRevision = input.opportunity.revision + 1;
  const [updated] = await tx
    .update(salesOpportunities)
    .set({
      status: input.target.status,
      ...(input.target.pipelineStage
        ? { pipelineStage: input.target.pipelineStage }
        : {}),
      ...(input.estimatedValueCents !== undefined
        ? { estimatedValueCents: input.estimatedValueCents }
        : {}),
      revision: nextRevision,
      ...(input.target.closes
        ? { closedAt: input.opportunity.closedAt ?? input.now }
        : {}),
      updatedAt: input.now,
    })
    .where(
      and(
        eq(salesOpportunities.id, input.opportunity.id),
        eq(salesOpportunities.status, input.opportunity.status),
        eq(salesOpportunities.revision, input.opportunity.revision),
      ),
    )
    .returning({ revision: salesOpportunities.revision });
  if (!updated) {
    throw new TeamMutationFailure(
      "conflict",
      "The project changed while the quote action was being recorded.",
      { retryable: true },
    );
  }
  return updated.revision;
}

async function hasOtherQuote(
  tx: TeamMutationTransaction,
  input: {
    opportunityId: string;
    quoteId: string;
    mode: "actionable" | "non_archived";
  },
): Promise<boolean> {
  const [other] = await tx
    .select({ id: quotes.id })
    .from(quotes)
    .where(
      and(
        eq(quotes.salesOpportunityId, input.opportunityId),
        eq(quotes.engineVersion, "v2"),
        ne(quotes.id, input.quoteId),
        input.mode === "actionable"
          ? inArray(quotes.aggregateState, ["draft", "open"])
          : ne(quotes.aggregateState, "archived"),
      ),
    )
    .limit(1);
  return Boolean(other);
}

async function hasOpenChangeRequest(
  tx: TeamMutationTransaction,
  quoteId: string,
): Promise<boolean> {
  const [request] = await tx
    .select({ id: quoteChangeRequests.id })
    .from(quoteChangeRequests)
    .where(
      and(
        eq(quoteChangeRequests.quoteId, quoteId),
        inArray(quoteChangeRequests.status, ["open", "acknowledged"]),
      ),
    )
    .limit(1);
  return Boolean(request);
}

function notificationChannel(contact: {
  preferredContactMethod: string | null;
  phoneE164: string | null;
  email: string | null;
}): "sms" | "email" | null {
  const preferred = contact.preferredContactMethod?.trim().toLowerCase() ?? "";
  const hasSms = /^\+[1-9][0-9]{7,14}$/u.test(contact.phoneE164 ?? "");
  const hasEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(
    contact.email?.trim() ?? "",
  );
  if (preferred === "email" && hasEmail) return "email";
  if (["sms", "text", "phone"].includes(preferred) && hasSms) return "sms";
  if (hasSms) return "sms";
  return hasEmail ? "email" : null;
}

type NotificationKind =
  | "staff_accepted"
  | "staff_declined"
  | "change_revision"
  | "change_reopened"
  | "voided"
  | "archived";

function lifecycleNotificationContent(input: {
  kind: NotificationKind;
  quoteNumber: string;
  versionNumber: number;
  channel: "sms" | "email";
}): { subject: string | null; body: string } {
  const proposal = `${input.quoteNumber}, version ${input.versionNumber}`;
  const textByKind: Record<NotificationKind, string> = {
    staff_accepted: `We recorded your approval of proposal ${proposal}. This confirms approval only; scheduling and any required deposit are handled separately.`,
    staff_declined: `We recorded your decision not to proceed with proposal ${proposal}. Reply if this does not match your instructions.`,
    change_revision: `We completed your change request for proposal ${input.quoteNumber}. A revised proposal, version ${input.versionNumber}, is ready and will be provided through its secure proposal message.`,
    change_reopened: `We completed your change request and reopened unchanged proposal ${proposal}. You may continue using its existing secure proposal link while it remains valid.`,
    voided: `Proposal ${proposal} has been voided and can no longer be approved. Reply if you need a replacement proposal.`,
    archived: `Proposal ${proposal} has been archived. Reply if you need help with this project.`,
  };
  const body =
    input.channel === "sms"
      ? `Stonegate: ${textByKind[input.kind]}`
      : `${textByKind[input.kind]}\n\nReply to this email if you need help.`;
  return {
    subject:
      input.channel === "email"
        ? `Stonegate proposal ${input.quoteNumber} update`
        : null,
    body,
  };
}

async function queueLifecycleNotification(
  tx: TeamMutationTransaction,
  input: {
    requested: boolean;
    contactId: string;
    quoteId: string;
    versionId: string;
    quoteNumber: string;
    versionNumber: number;
    kind: NotificationKind;
    dedupeId: string;
  },
): Promise<string | null> {
  if (!input.requested) return null;
  const [contact] = await tx
    .select({
      preferredContactMethod: contacts.preferredContactMethod,
      phoneE164: contacts.phoneE164,
      email: contacts.email,
    })
    .from(contacts)
    .where(eq(contacts.id, input.contactId))
    .limit(1);
  const channel = contact ? notificationChannel(contact) : null;
  if (!contact || !channel) {
    throw new TeamMutationFailure(
      "invalid",
      "Customer notification was requested, but no valid customer channel is available.",
      {
        fieldErrors: {
          notifyCustomer:
            "Add a valid email or mobile number, or turn notification off.",
        },
      },
    );
  }
  const content = lifecycleNotificationContent({
    kind: input.kind,
    quoteNumber: input.quoteNumber,
    versionNumber: input.versionNumber,
    channel,
  });
  const messageId = await queueSystemOutboundMessage({
    db: tx,
    contactId: input.contactId,
    channel,
    toAddress:
      channel === "sms"
        ? contact.phoneE164?.trim()
        : contact.email?.trim().toLowerCase(),
    subject: content.subject,
    body: content.body,
    metadata: {
      kind: `quote.v2.${input.kind}`,
      quoteId: input.quoteId,
      versionId: input.versionId,
    },
    dedupeKey: `quote-v2:${input.kind}:${input.dedupeId}:${channel}`,
  });
  if (!messageId) {
    throw new TeamMutationFailure(
      "provider_failed",
      "The lifecycle change was not saved because its requested customer notification could not be queued.",
      { retryable: true },
    );
  }
  return messageId;
}

async function insertActivity(
  tx: TeamMutationTransaction,
  input: {
    quoteId: string;
    versionId: string;
    eventType: string;
    actorTeamMemberId: string;
    correlationId: string;
    outboxEventId?: string | null;
    causationId?: string | null;
    metadata: Record<string, unknown>;
    now: Date;
  },
): Promise<void> {
  await tx.insert(quoteActivityEvents).values({
    quoteId: input.quoteId,
    quoteVersionId: input.versionId,
    eventType: input.eventType,
    actorType: "team_member",
    actorTeamMemberId: input.actorTeamMemberId,
    outboxEventId: input.outboxEventId ?? null,
    correlationId: input.correlationId,
    causationId: input.causationId ?? null,
    metadata: input.metadata,
    occurredAt: input.now,
    createdAt: input.now,
  });
}

function acceptanceFailure(error: unknown): never {
  if (error instanceof QuoteV2PublicStateError) {
    throw new TeamMutationFailure(
      error.code === "invalid" ? "invalid" : "conflict",
      error.message,
      { fieldErrors: error.fieldErrors },
    );
  }
  throw error;
}

export type QuoteV2StaffDecisionReceipt = {
  quoteId: string;
  versionId: string;
  responseId: string;
  decision: "accepted" | "declined";
  quoteRevision: number;
  opportunityRevision: number;
  outboxEventId: string;
  notificationMessageId: string | null;
  respondedAt: string;
  certificateState?: "ready" | "pending";
};

export async function recordQuoteV2StaffDecision(
  tx: TeamMutationTransaction,
  input: {
    versionId: string;
    command: QuoteV2StaffDecisionCommand;
    expectedQuoteRevision: number;
    actorTeamMemberId: string;
    idempotencyKeyHash: string;
    correlationId: string;
    now?: Date;
  },
): Promise<QuoteV2StaffDecisionReceipt> {
  const command = QuoteV2StaffDecisionCommandSchema.parse(input.command);
  const now = input.now ?? new Date();
  const quote = await lockQuote(
    tx,
    command.quoteId,
    input.expectedQuoteRevision,
  );
  if (
    command.quoteRevision !== quote.aggregateRevision ||
    command.versionId !== input.versionId ||
    quote.aggregateState !== "open" ||
    quote.currentVersionId !== input.versionId ||
    quote.publishedVersionId !== input.versionId
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "Only the exact current issued proposal can receive a staff-recorded decision.",
      { fieldErrors: { versionId: "Refresh the published proposal." } },
    );
  }
  const version = await lockVersion(tx, quote.id, input.versionId);
  if (
    version.state !== "issued" ||
    !version.issuedAt ||
    !version.expiresAt ||
    version.expiresAt <= now
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "This proposal is not an unexpired issued version.",
    );
  }
  if (await hasOpenChangeRequest(tx, quote.id)) {
    throw new TeamMutationFailure(
      "conflict",
      "Resolve the open customer change request before recording a decision.",
    );
  }
  const opportunity = await lockOpportunity(tx, quote.opportunityId);
  if (opportunity.status !== "open") {
    throw new TeamMutationFailure(
      "conflict",
      "This project can no longer receive a proposal decision.",
    );
  }

  let acceptedEvidence: ReturnType<
    typeof prepareQuoteV2AcceptanceEvidence
  > | null = null;
  if (command.decision === "accepted") {
    const [proposal] = await tx
      .select({ sha256: quoteVersionDocuments.sha256 })
      .from(quoteVersionDocuments)
      .where(
        and(
          eq(quoteVersionDocuments.quoteVersionId, version.id),
          eq(quoteVersionDocuments.kind, "proposal_pdf"),
        ),
      )
      .orderBy(desc(quoteVersionDocuments.generatedAt))
      .limit(1);
    try {
      acceptedEvidence = prepareQuoteV2AcceptanceEvidence({
        row: {
          documentSnapshot: version.documentSnapshot,
          quoteNumber: quote.quoteNumber,
          versionNumber: version.versionNumber,
          contentHash: version.contentHash,
          proposalPdfHash: proposal?.sha256 ?? null,
        },
        selectedOptionIds: command.selectedOptionIds,
        signer: command.signer,
        consentVersion: command.consentVersion,
        consentAffirmed: command.consentAffirmed,
      });
    } catch (error) {
      acceptanceFailure(error);
    }
  }

  let responseValues: typeof quoteResponses.$inferInsert;
  if (command.decision === "accepted") {
    if (!acceptedEvidence) {
      throw new TeamMutationFailure(
        "internal",
        "The exact acceptance evidence could not be prepared.",
      );
    }
    if (quote.partnerAccountId) {
      const [binding] = await tx
        .select({
          accountId: partnerQuotes.partnerAccountId,
          bookingId: partnerQuotes.partnerBookingId,
          bookingDraftId: partnerQuotes.bookingDraftId,
        })
        .from(partnerQuotes)
        .where(
          and(
            eq(partnerQuotes.quoteId, quote.id),
            eq(partnerQuotes.partnerAccountId, quote.partnerAccountId),
            eq(partnerQuotes.authority, "quote_v2"),
          ),
        )
        .limit(1);
      if (!binding) {
        throw new TeamMutationFailure(
          "conflict",
          "The Partner account binding for this quote is unavailable.",
        );
      }
      const approvalAllowed = await partnerQuoteApprovalAllowsAcceptance(tx, {
        accountId: binding.accountId,
        bookingId: binding.bookingId,
        bookingDraftId: binding.bookingDraftId,
        totalMinCents: acceptedEvidence.totals.totalMinCents,
        totalMaxCents: acceptedEvidence.totals.totalMaxCents,
        currency: acceptedEvidence.document.pricing.currency,
      });
      if (!approvalAllowed) {
        throw new TeamMutationFailure(
          "invalid",
          "This Partner account requires an approved request for the exact proposal amount before acceptance.",
          {
            fieldErrors: {
              decision: "Record the required account approval first.",
            },
          },
        );
      }
    }
    responseValues = {
      quoteId: quote.id,
      quoteVersionId: version.id,
      responseType: "accepted",
      source: "team_member",
      teamMemberId: input.actorTeamMemberId,
      signerSnapshot: acceptedEvidence.signerSnapshot,
      configurationSnapshot: acceptedEvidence.configurationSnapshot,
      selectedOptionIds: acceptedEvidence.selectedOptionIds,
      message: command.notes,
      consentText: acceptedEvidence.consentText,
      consentVersion: acceptedEvidence.consentVersion,
      consentAffirmed: true,
      configurationHash: acceptedEvidence.configurationHash,
      consentHash: acceptedEvidence.consentHash,
      contentHash: acceptedEvidence.contentHash,
      issuedPdfHash: acceptedEvidence.issuedPdfHash,
      acceptedTotalMinCents: acceptedEvidence.totals.totalMinCents,
      acceptedTotalMaxCents: acceptedEvidence.totals.totalMaxCents,
      acceptedDepositCents: acceptedEvidence.totals.depositCents,
      acceptedBalanceMinCents: acceptedEvidence.totals.balanceMinCents,
      acceptedBalanceMaxCents: acceptedEvidence.totals.balanceMaxCents,
      idempotencyKeyHash: input.idempotencyKeyHash,
      requestMetadata: {
        interactionSource: command.source,
        evidenceQuality: "exact",
        customerNotificationRequested: command.notifyCustomer,
        certificateIntent: {
          schemaVersion: 1,
          state: "pending",
          source: "immutable_quote_response",
        },
      },
      respondedAt: now,
      createdAt: now,
    };
  } else {
    responseValues = {
      quoteId: quote.id,
      quoteVersionId: version.id,
      responseType: "declined",
      source: "team_member",
      teamMemberId: input.actorTeamMemberId,
      signerSnapshot: command.signer,
      reason: command.category,
      message: command.notes,
      idempotencyKeyHash: input.idempotencyKeyHash,
      requestMetadata: {
        interactionSource: command.source,
        evidenceQuality: "basic",
        customerNotificationRequested: command.notifyCustomer,
      },
      respondedAt: now,
      createdAt: now,
    };
  }
  let terminal;
  try {
    terminal = await persistQuoteV2TerminalDecision(tx, {
      context: {
        quoteId: quote.id,
        quoteNumber: quote.quoteNumber,
        versionId: version.id,
        versionNumber: version.versionNumber,
        contactId: quote.contactId,
        opportunityId: quote.opportunityId,
        opportunityStatus: opportunity.status,
        opportunityRevision: opportunity.revision,
        quoteRevision: quote.aggregateRevision,
      },
      decision: command.decision,
      responseValues,
      acceptedTotals: acceptedEvidence?.totals ?? null,
      decisionNotes: command.notes,
      correlationId: input.correlationId,
      now,
    });
  } catch (error) {
    if (
      error instanceof QuoteV2TerminalDecisionConflict ||
      error instanceof QuoteDomainError
    ) {
      throw new TeamMutationFailure("conflict", error.message, {
        retryable: true,
      });
    }
    throw error;
  }
  const notificationMessageId = await queueLifecycleNotification(tx, {
    requested: command.notifyCustomer,
    contactId: quote.contactId,
    quoteId: quote.id,
    versionId: version.id,
    quoteNumber: quote.quoteNumber,
    versionNumber: version.versionNumber,
    kind: command.decision === "accepted" ? "staff_accepted" : "staff_declined",
    dedupeId: terminal.responseId,
  });
  await insertActivity(tx, {
    quoteId: quote.id,
    versionId: version.id,
    eventType: `quote.staff_${command.decision}`,
    actorTeamMemberId: input.actorTeamMemberId,
    correlationId: input.correlationId,
    outboxEventId: terminal.outboxEventId,
    causationId: terminal.responseId,
    metadata: {
      responseId: terminal.responseId,
      interactionSource: command.source,
      customerNotificationRequested: command.notifyCustomer,
      notificationMessageId,
    },
    now,
  });
  return {
    quoteId: quote.id,
    versionId: version.id,
    responseId: terminal.responseId,
    decision: command.decision,
    quoteRevision: terminal.quoteRevision,
    opportunityRevision: terminal.opportunityRevision,
    outboxEventId: terminal.outboxEventId,
    notificationMessageId,
    respondedAt: now.toISOString(),
    ...(command.decision === "accepted"
      ? { certificateState: "pending" as const }
      : {}),
  };
}

export type QuoteV2ChangeResolutionReceipt = {
  changeRequestId: string;
  quoteId: string;
  sourceVersionId: string;
  resultingVersionId: string;
  resolution: "revision" | "reopen_unchanged";
  quoteRevision: number;
  opportunityRevision: number;
  notificationMessageId: string | null;
  resolvedAt: string;
};

export async function resolveQuoteV2ChangeRequest(
  tx: TeamMutationTransaction,
  input: {
    changeRequestId: string;
    command: QuoteV2ChangeResolutionCommand;
    expectedQuoteRevision: number;
    actorTeamMemberId: string;
    correlationId: string;
    now?: Date;
  },
): Promise<QuoteV2ChangeResolutionReceipt> {
  const command = QuoteV2ChangeResolutionCommandSchema.parse(input.command);
  const now = input.now ?? new Date();
  const quote = await lockQuote(
    tx,
    command.quoteId,
    input.expectedQuoteRevision,
  );
  if (
    quote.aggregateState !== "open" ||
    quote.aggregateRevision !== command.quoteRevision
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "Only an open quote change request can be resolved.",
    );
  }
  const [change] = await tx
    .select({
      id: quoteChangeRequests.id,
      quoteId: quoteChangeRequests.quoteId,
      versionId: quoteChangeRequests.quoteVersionId,
      status: quoteChangeRequests.status,
      ownerTaskId: quoteChangeRequests.ownerTaskId,
    })
    .from(quoteChangeRequests)
    .where(
      and(
        eq(quoteChangeRequests.id, input.changeRequestId),
        eq(quoteChangeRequests.quoteId, quote.id),
        eq(quoteChangeRequests.quoteVersionId, command.quoteVersionId),
      ),
    )
    .for("update")
    .limit(1);
  if (
    !change ||
    !change.versionId ||
    !change.ownerTaskId ||
    !["open", "acknowledged"].includes(change.status ?? "")
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "This change request is already resolved or no longer actionable.",
    );
  }
  const source = await lockVersion(tx, quote.id, change.versionId);
  const opportunity = await lockOpportunity(tx, quote.opportunityId);
  if (opportunity.status !== "open") {
    throw new TeamMutationFailure(
      "conflict",
      "The project can no longer reopen or publish this proposal.",
    );
  }

  let resulting = source;
  if (command.resolution === "reopen_unchanged") {
    if (
      quote.currentVersionId !== source.id ||
      quote.publishedVersionId !== source.id ||
      source.state !== "issued" ||
      !source.expiresAt ||
      source.expiresAt <= now
    ) {
      throw new TeamMutationFailure(
        "conflict",
        "Only the unchanged, current, unexpired issued version can be reopened.",
      );
    }
    const [otherChange] = await tx
      .select({ id: quoteChangeRequests.id })
      .from(quoteChangeRequests)
      .where(
        and(
          eq(quoteChangeRequests.quoteId, quote.id),
          ne(quoteChangeRequests.id, change.id),
          inArray(quoteChangeRequests.status, ["open", "acknowledged"]),
        ),
      )
      .limit(1);
    if (otherChange) {
      throw new TeamMutationFailure(
        "conflict",
        "Resolve every open change request before reopening this proposal.",
      );
    }
  } else {
    resulting = await lockVersion(tx, quote.id, command.replacementVersionId);
    if (
      resulting.id === source.id ||
      resulting.supersedesVersionId !== source.id ||
      quote.currentVersionId !== resulting.id ||
      quote.publishedVersionId !== resulting.id ||
      resulting.state !== "issued" ||
      !resulting.issuedAt ||
      !resulting.expiresAt ||
      resulting.expiresAt <= now ||
      !["superseded", "expired"].includes(source.state)
    ) {
      throw new TeamMutationFailure(
        "conflict",
        "Resolve with the exact issued revision that supersedes the requested version.",
        {
          fieldErrors: {
            replacementVersionId: "Select the current issued revision.",
          },
        },
      );
    }
  }

  const [resolved] = await tx
    .update(quoteChangeRequests)
    .set({
      status: "resolved",
      resolvedByTeamMemberId: input.actorTeamMemberId,
      resolutionNote: command.resolutionNote,
      resolutionKind: command.resolution,
      resultingVersionId: resulting.id,
      resolvedAt: now,
    })
    .where(
      and(
        eq(quoteChangeRequests.id, change.id),
        inArray(quoteChangeRequests.status, ["open", "acknowledged"]),
      ),
    )
    .returning({ id: quoteChangeRequests.id });
  if (!resolved) {
    throw new TeamMutationFailure(
      "conflict",
      "The change request was resolved by someone else. Refresh the quote.",
    );
  }
  const [task] = await tx
    .update(crmTasks)
    .set({ status: "completed", updatedAt: now })
    .where(eq(crmTasks.id, change.ownerTaskId))
    .returning({ id: crmTasks.id });
  if (!task) {
    throw new TeamMutationFailure(
      "internal",
      "The change request owner task could not be completed.",
    );
  }

  const nextQuoteRevision = quote.aggregateRevision + 1;
  const [updatedQuote] = await tx
    .update(quotes)
    .set({
      aggregateRevision: nextQuoteRevision,
      revision: nextQuoteRevision,
      updatedAt: now,
    })
    .where(
      and(
        eq(quotes.id, quote.id),
        eq(quotes.engineVersion, "v2"),
        eq(quotes.aggregateState, "open"),
        eq(quotes.aggregateRevision, quote.aggregateRevision),
        eq(quotes.currentVersionId, resulting.id),
        eq(quotes.publishedVersionId, resulting.id),
      ),
    )
    .returning({ id: quotes.id });
  if (!updatedQuote) {
    throw new TeamMutationFailure(
      "conflict",
      "The quote changed while the request was resolved.",
      { retryable: true },
    );
  }
  const opportunityRevision = await updateOpportunity(tx, {
    opportunity,
    target: quoteV2LifecycleOpportunityTarget({
      operation: "resolve_change",
      currentStatus: opportunity.status,
      hasOtherRelevantQuote: false,
    }),
    now,
  });
  const notificationMessageId = await queueLifecycleNotification(tx, {
    requested: command.notifyCustomer,
    contactId: quote.contactId,
    quoteId: quote.id,
    versionId: resulting.id,
    quoteNumber: quote.quoteNumber,
    versionNumber: resulting.versionNumber,
    kind:
      command.resolution === "revision" ? "change_revision" : "change_reopened",
    dedupeId: change.id,
  });
  await insertActivity(tx, {
    quoteId: quote.id,
    versionId: resulting.id,
    eventType: "quote.change_request_resolved",
    actorTeamMemberId: input.actorTeamMemberId,
    correlationId: input.correlationId,
    causationId: change.id,
    metadata: {
      changeRequestId: change.id,
      ownerTaskId: task.id,
      sourceVersionId: source.id,
      resultingVersionId: resulting.id,
      resolution: command.resolution,
      customerNotificationRequested: command.notifyCustomer,
      notificationMessageId,
    },
    now,
  });
  return {
    changeRequestId: change.id,
    quoteId: quote.id,
    sourceVersionId: source.id,
    resultingVersionId: resulting.id,
    resolution: command.resolution,
    quoteRevision: nextQuoteRevision,
    opportunityRevision,
    notificationMessageId,
    resolvedAt: now.toISOString(),
  };
}

async function dismissOpenChanges(
  tx: TeamMutationTransaction,
  input: {
    quoteId: string;
    actorTeamMemberId: string;
    resolutionNote: string;
    resolutionKind: "quote_voided" | "quote_archived";
    resultingVersionId: string;
    now: Date;
  },
): Promise<number> {
  const changes = await tx
    .select({
      id: quoteChangeRequests.id,
      ownerTaskId: quoteChangeRequests.ownerTaskId,
    })
    .from(quoteChangeRequests)
    .where(
      and(
        eq(quoteChangeRequests.quoteId, input.quoteId),
        inArray(quoteChangeRequests.status, ["open", "acknowledged"]),
      ),
    )
    .for("update");
  if (changes.length === 0) return 0;
  const changeIds = changes.map((change) => change.id);
  await tx
    .update(quoteChangeRequests)
    .set({
      status: "dismissed",
      resolvedByTeamMemberId: input.actorTeamMemberId,
      resolutionNote: input.resolutionNote,
      resolutionKind: input.resolutionKind,
      resultingVersionId: input.resultingVersionId,
      resolvedAt: input.now,
    })
    .where(
      and(
        inArray(quoteChangeRequests.id, changeIds),
        inArray(quoteChangeRequests.status, ["open", "acknowledged"]),
      ),
    );
  const taskIds = changes
    .map((change) => change.ownerTaskId)
    .filter((id): id is string => Boolean(id));
  if (taskIds.length > 0) {
    await tx
      .update(crmTasks)
      .set({ status: "completed", updatedAt: input.now })
      .where(inArray(crmTasks.id, taskIds));
  }
  return changes.length;
}

export type QuoteV2TerminalLifecycleReceipt = {
  quoteId: string;
  versionId: string;
  state: "voided" | "archived";
  quoteRevision: number;
  opportunityRevision: number;
  dismissedChangeRequestCount: number;
  releasedHoldCount: number;
  notificationMessageId: string | null;
  occurredAt: string;
};

export async function voidQuoteV2(
  tx: TeamMutationTransaction,
  input: {
    quoteId: string;
    command: QuoteV2VoidCommand;
    expectedQuoteRevision: number;
    actorTeamMemberId: string;
    correlationId: string;
    now?: Date;
  },
): Promise<QuoteV2TerminalLifecycleReceipt> {
  const command = QuoteV2VoidCommandSchema.parse(input.command);
  const now = input.now ?? new Date();
  // Voiding releases any still-active scheduling hold. Acquire the global
  // schedule lock before quote/hold row locks to preserve the shared ordering.
  await acquireScheduleConflictLock(tx);
  const quote = await lockQuote(tx, input.quoteId, input.expectedQuoteRevision);
  if (
    quote.aggregateRevision !== command.quoteRevision ||
    !["draft", "open"].includes(quote.aggregateState) ||
    quote.currentVersionId !== command.versionId
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "Only the exact current draft or open quote can be voided.",
    );
  }
  const current = await lockVersion(tx, quote.id, command.versionId);
  const versions = [current];
  if (quote.publishedVersionId && quote.publishedVersionId !== current.id) {
    versions.push(await lockVersion(tx, quote.id, quote.publishedVersionId));
  }
  const opportunity = await lockOpportunity(tx, quote.opportunityId);
  if (opportunity.status !== "open") {
    throw new TeamMutationFailure(
      "conflict",
      "This project can no longer void an open quote.",
    );
  }
  for (const version of versions) {
    if (!["draft", "ready", "issued"].includes(version.state)) continue;
    const [voided] = await tx
      .update(quoteVersions)
      .set({ state: "voided", updatedAt: now })
      .where(
        and(
          eq(quoteVersions.id, version.id),
          eq(quoteVersions.quoteId, quote.id),
          eq(quoteVersions.state, version.state),
        ),
      )
      .returning({ id: quoteVersions.id });
    if (!voided) {
      throw new TeamMutationFailure(
        "conflict",
        "A proposal version changed while the quote was voided.",
        { retryable: true },
      );
    }
  }
  const dismissedChangeRequestCount = await dismissOpenChanges(tx, {
    quoteId: quote.id,
    actorTeamMemberId: input.actorTeamMemberId,
    resolutionNote: `Quote voided: ${command.reason}`,
    resolutionKind: "quote_voided",
    resultingVersionId: current.id,
    now,
  });
  const releasedHolds = await tx
    .update(appointmentHolds)
    .set({ status: "expired", updatedAt: now })
    .where(
      and(
        eq(appointmentHolds.fullQuoteId, quote.id),
        eq(appointmentHolds.status, "active"),
      ),
    )
    .returning({ id: appointmentHolds.id });
  const nextQuoteRevision = quote.aggregateRevision + 1;
  const [updatedQuote] = await tx
    .update(quotes)
    .set({
      aggregateState: "voided",
      aggregateRevision: nextQuoteRevision,
      revision: nextQuoteRevision,
      decisionAt: now,
      decisionNotes: command.reason,
      updatedAt: now,
    })
    .where(
      and(
        eq(quotes.id, quote.id),
        eq(quotes.engineVersion, "v2"),
        eq(quotes.aggregateState, quote.aggregateState),
        eq(quotes.aggregateRevision, quote.aggregateRevision),
        eq(quotes.currentVersionId, current.id),
      ),
    )
    .returning({ id: quotes.id });
  if (!updatedQuote) {
    throw new TeamMutationFailure(
      "conflict",
      "The quote changed while it was voided.",
      { retryable: true },
    );
  }
  const readExpiresAt = quoteCapabilityReadExpiry({
    at: now,
    outcome: "voided",
  });
  await tx
    .update(quoteCapabilities)
    .set({
      actionExpiresAt: null,
      readExpiresAt: sql`greatest(${quoteCapabilities.readExpiresAt}, ${readExpiresAt.toISOString()}::timestamptz)`,
      updatedAt: now,
    })
    .where(
      and(
        eq(quoteCapabilities.quoteId, quote.id),
        ne(quoteCapabilities.status, "revoked"),
      ),
    );
  const otherActionable = await hasOtherQuote(tx, {
    opportunityId: quote.opportunityId,
    quoteId: quote.id,
    mode: "actionable",
  });
  const opportunityRevision = await updateOpportunity(tx, {
    opportunity,
    target: quoteV2LifecycleOpportunityTarget({
      operation: "void",
      currentStatus: opportunity.status,
      hasOtherRelevantQuote: otherActionable,
    }),
    now,
  });
  const notificationMessageId = await queueLifecycleNotification(tx, {
    requested: command.notifyCustomer,
    contactId: quote.contactId,
    quoteId: quote.id,
    versionId: current.id,
    quoteNumber: quote.quoteNumber,
    versionNumber: current.versionNumber,
    kind: "voided",
    dedupeId: `${quote.id}:${nextQuoteRevision}`,
  });
  await insertActivity(tx, {
    quoteId: quote.id,
    versionId: current.id,
    eventType: "quote.voided",
    actorTeamMemberId: input.actorTeamMemberId,
    correlationId: input.correlationId,
    metadata: {
      dismissedChangeRequestCount,
      releasedHoldCount: releasedHolds.length,
      affectedVersionIds: versions.map((version) => version.id),
      customerNotificationRequested: command.notifyCustomer,
      notificationMessageId,
    },
    now,
  });
  return {
    quoteId: quote.id,
    versionId: current.id,
    state: "voided",
    quoteRevision: nextQuoteRevision,
    opportunityRevision,
    dismissedChangeRequestCount,
    releasedHoldCount: releasedHolds.length,
    notificationMessageId,
    occurredAt: now.toISOString(),
  };
}

export async function archiveQuoteV2(
  tx: TeamMutationTransaction,
  input: {
    quoteId: string;
    command: QuoteV2ArchiveCommand;
    expectedQuoteRevision: number;
    actorTeamMemberId: string;
    correlationId: string;
    now?: Date;
  },
): Promise<QuoteV2TerminalLifecycleReceipt> {
  const command = QuoteV2ArchiveCommandSchema.parse(input.command);
  const now = input.now ?? new Date();
  const quote = await lockQuote(tx, input.quoteId, input.expectedQuoteRevision);
  if (
    quote.aggregateRevision !== command.quoteRevision ||
    !["draft", "accepted", "declined", "voided"].includes(
      quote.aggregateState,
    ) ||
    quote.currentVersionId !== command.versionId
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "Only the exact current non-archived quote can be archived.",
    );
  }
  const current = await lockVersion(tx, quote.id, command.versionId);
  const opportunity = await lockOpportunity(tx, quote.opportunityId);
  if (quote.aggregateState === "accepted" && opportunity.status !== "won") {
    throw new TeamMutationFailure(
      "conflict",
      "An accepted quote can be archived only after fulfillment is closed as won.",
    );
  }
  const dismissedChangeRequestCount = await dismissOpenChanges(tx, {
    quoteId: quote.id,
    actorTeamMemberId: input.actorTeamMemberId,
    resolutionNote: `Quote archived: ${command.reason}`,
    resolutionKind: "quote_archived",
    resultingVersionId: current.id,
    now,
  });
  const nextQuoteRevision = quote.aggregateRevision + 1;
  const [updatedQuote] = await tx
    .update(quotes)
    .set({
      aggregateState: "archived",
      aggregateRevision: nextQuoteRevision,
      revision: nextQuoteRevision,
      updatedAt: now,
    })
    .where(
      and(
        eq(quotes.id, quote.id),
        eq(quotes.engineVersion, "v2"),
        eq(quotes.aggregateState, quote.aggregateState),
        eq(quotes.aggregateRevision, quote.aggregateRevision),
        eq(quotes.currentVersionId, current.id),
      ),
    )
    .returning({ id: quotes.id });
  if (!updatedQuote) {
    throw new TeamMutationFailure(
      "conflict",
      "The quote changed while it was archived.",
      { retryable: true },
    );
  }
  const retentionOutcome =
    quote.aggregateState === "accepted" ? "accepted" : "voided";
  const readExpiresAt = quoteCapabilityReadExpiry({
    at: now,
    outcome: retentionOutcome,
  });
  await tx
    .update(quoteCapabilities)
    .set({
      actionExpiresAt: null,
      readExpiresAt: sql`greatest(${quoteCapabilities.readExpiresAt}, ${readExpiresAt.toISOString()}::timestamptz)`,
      updatedAt: now,
    })
    .where(
      and(
        eq(quoteCapabilities.quoteId, quote.id),
        ne(quoteCapabilities.status, "revoked"),
      ),
    );
  const otherNonArchived = await hasOtherQuote(tx, {
    opportunityId: quote.opportunityId,
    quoteId: quote.id,
    mode: "non_archived",
  });
  const opportunityRevision = await updateOpportunity(tx, {
    opportunity,
    target: quoteV2LifecycleOpportunityTarget({
      operation: "archive",
      currentStatus: opportunity.status,
      hasOtherRelevantQuote: otherNonArchived,
    }),
    now,
  });
  const notificationMessageId = await queueLifecycleNotification(tx, {
    requested: command.notifyCustomer,
    contactId: quote.contactId,
    quoteId: quote.id,
    versionId: current.id,
    quoteNumber: quote.quoteNumber,
    versionNumber: current.versionNumber,
    kind: "archived",
    dedupeId: `${quote.id}:${nextQuoteRevision}`,
  });
  await insertActivity(tx, {
    quoteId: quote.id,
    versionId: current.id,
    eventType: "quote.archived",
    actorTeamMemberId: input.actorTeamMemberId,
    correlationId: input.correlationId,
    metadata: {
      previousState: quote.aggregateState,
      dismissedChangeRequestCount,
      customerNotificationRequested: command.notifyCustomer,
      notificationMessageId,
    },
    now,
  });
  return {
    quoteId: quote.id,
    versionId: current.id,
    state: "archived",
    quoteRevision: nextQuoteRevision,
    opportunityRevision,
    dismissedChangeRequestCount,
    releasedHoldCount: 0,
    notificationMessageId,
    occurredAt: now.toISOString(),
  };
}
