import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  contacts,
  leads,
  quoteActivityEvents,
  quoteVersionAdjustments,
  quoteVersionLineItems,
  quoteVersionOptionGroups,
  quoteVersions,
  quotes,
  salesOpportunities,
  teamMembers,
} from "@/db";
import type { TeamMutationTransaction } from "@/lib/team-mutation";
import { TeamMutationFailure } from "@/lib/team-mutation";
import {
  QuoteDocumentSnapshotSchema,
  QuoteV2CreateCommandSchema,
  QuoteV2FinalizeCommandSchema,
  QuoteV2SaveDraftCommandSchema,
} from "@/lib/quote-v2-contract";
import {
  QUOTE_V2_SCHEMA_VERSION,
  QuoteDomainError,
  calculateQuoteV2Totals,
  canonicalQuoteJson,
  hashQuoteContent,
  type QuoteTotals,
} from "@/lib/quote-v2-domain";
import { generateQuoteV2Number } from "@/lib/quote-v2-number";
import { assertQuoteV2CatalogPolicy } from "@/lib/quote-v2-catalog";
import { loadContactPropertyById } from "@/lib/property-write";

const MAX_QUOTE_NUMBER_ATTEMPTS = 8;

function verifiedPhoneE164(...candidates: Array<string | null>): string | null {
  return (
    candidates.find((candidate) =>
      candidate ? /^\+[1-9]\d{7,14}$/.test(candidate) : false,
    ) ?? null
  );
}

export type QuoteV2CreateCommand = z.infer<typeof QuoteV2CreateCommandSchema>;
export type QuoteV2SaveDraftCommand = z.infer<
  typeof QuoteV2SaveDraftCommandSchema
>;
export type QuoteV2FinalizeCommand = z.infer<
  typeof QuoteV2FinalizeCommandSchema
>;

export type QuoteV2DraftReceipt = {
  quoteId: string;
  versionId: string;
  quoteNumber: string;
  quoteRevision: number;
  draftRevision: number;
  state: "draft" | "ready";
  totals: QuoteTotals | null;
};

function addressLabel(property: {
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  state: string;
  postalCode: string;
}): string {
  return [
    property.addressLine1,
    property.addressLine2,
    `${property.city}, ${property.state} ${property.postalCode}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function fullName(contact: { firstName: string; lastName: string }): string {
  return `${contact.firstName} ${contact.lastName}`.trim();
}

function safeDraftTotals(document: { pricing: unknown }): QuoteTotals | null {
  try {
    return calculateQuoteV2Totals(document.pricing);
  } catch (error) {
    if (error instanceof QuoteDomainError || error instanceof z.ZodError) {
      return null;
    }
    throw error;
  }
}

function exactDocumentFieldErrors(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "document";
    fields[key] ??= issue.message;
  }
  return fields;
}

async function selectOwnerTeamMemberId(
  tx: TeamMutationTransaction,
  candidateId: string | null,
  fallbackId: string,
): Promise<string> {
  if (!candidateId || candidateId === fallbackId) return fallbackId;
  const [candidate] = await tx
    .select({ id: teamMembers.id })
    .from(teamMembers)
    .where(and(eq(teamMembers.id, candidateId), eq(teamMembers.active, true)))
    .limit(1);
  return candidate?.id ?? fallbackId;
}

async function insertV2QuoteWithUniqueNumber(
  tx: TeamMutationTransaction,
  input: {
    opportunityId: string;
    contactId: string;
    propertyId: string;
    now: Date;
  },
): Promise<{ id: string; quoteNumber: string }> {
  for (let attempt = 0; attempt < MAX_QUOTE_NUMBER_ATTEMPTS; attempt += 1) {
    const quoteNumber = generateQuoteV2Number(input.now);
    const [inserted] = await tx
      .insert(quotes)
      .values({
        salesOpportunityId: input.opportunityId,
        engineVersion: "v2",
        aggregateState: "draft",
        aggregateRevision: 1,
        contactId: input.contactId,
        propertyId: input.propertyId,
        status: "pending",
        services: [],
        addOns: [],
        zoneId: "quote-v2",
        travelFee: "0",
        discounts: "0",
        addOnsTotal: "0",
        subtotal: "0",
        total: "0",
        depositDue: "0",
        depositRate: "0",
        balanceDue: "0",
        lineItems: [],
        quoteNumber,
        jobDurationMinutes: 120,
        revision: 1,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoNothing()
      .returning({ id: quotes.id, quoteNumber: quotes.quoteNumber });
    if (inserted?.id && inserted.quoteNumber) {
      return { id: inserted.id, quoteNumber: inserted.quoteNumber };
    }
  }
  throw new TeamMutationFailure(
    "internal",
    "A collision-safe quote number could not be allocated. Retry shortly.",
    { retryable: true },
  );
}

export async function createQuoteV2Draft(
  tx: TeamMutationTransaction,
  input: {
    command: QuoteV2CreateCommand;
    actorTeamMemberId: string;
    correlationId: string;
    now?: Date;
  },
): Promise<QuoteV2DraftReceipt> {
  const command = QuoteV2CreateCommandSchema.parse(input.command);
  const now = input.now ?? new Date();
  const [contact] = await tx
    .select({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      company: contacts.company,
      email: contacts.email,
      phone: contacts.phone,
      phoneE164: contacts.phoneE164,
      salespersonMemberId: contacts.salespersonMemberId,
      deletedAt: contacts.deletedAt,
    })
    .from(contacts)
    .where(eq(contacts.id, command.contactId))
    .limit(1);
  if (!contact || contact.deletedAt) {
    throw new TeamMutationFailure("invalid", "The client was not found.", {
      status: 404,
      fieldErrors: { contactId: "Select an active client." },
    });
  }
  const property = await loadContactPropertyById(tx, {
    contactId: contact.id,
    propertyId: command.propertyId,
  });
  if (!property) {
    throw new TeamMutationFailure(
      "invalid",
      "The selected service property is not associated with this client.",
      {
        status: 404,
        fieldErrors: { propertyId: "Select one of this client's properties." },
      },
    );
  }

  if (command.leadId) {
    const [lead] = await tx
      .select({ id: leads.id })
      .from(leads)
      .where(
        and(
          eq(leads.id, command.leadId),
          eq(leads.contactId, contact.id),
          eq(leads.propertyId, property.id),
        ),
      )
      .limit(1);
    if (!lead) {
      throw new TeamMutationFailure(
        "invalid",
        "The source lead does not belong to this client and project.",
        {
          fieldErrors: { leadId: "Choose a matching lead or leave it blank." },
        },
      );
    }
  }

  const ownerTeamMemberId = await selectOwnerTeamMemberId(
    tx,
    contact.salespersonMemberId,
    input.actorTeamMemberId,
  );
  const [opportunity] = await tx
    .insert(salesOpportunities)
    .values({
      contactId: contact.id,
      propertyId: property.id,
      leadId: command.leadId ?? null,
      ownerTeamMemberId,
      name: command.projectName,
      status: "open",
      pipelineStage: "draft",
      currency: "USD",
      revision: 1,
      metadata: { quoteEngineVersion: "v2" },
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: salesOpportunities.id });
  if (!opportunity) {
    throw new TeamMutationFailure(
      "internal",
      "The quote opportunity could not be created.",
    );
  }

  const quote = await insertV2QuoteWithUniqueNumber(tx, {
    opportunityId: opportunity.id,
    contactId: contact.id,
    propertyId: property.id,
    now,
  });
  const [actor] = await tx
    .select({ name: teamMembers.name })
    .from(teamMembers)
    .where(eq(teamMembers.id, input.actorTeamMemberId))
    .limit(1);
  const customerPhoneE164 = verifiedPhoneE164(contact.phoneE164, contact.phone);
  const initialDocument = {
    schemaVersion: QUOTE_V2_SCHEMA_VERSION,
    documentType: command.documentType,
    audience: command.audience,
    schedulingMode: command.schedulingMode,
    parties: {
      customerName: fullName(contact),
      companyName: contact.company,
      attentionName: null,
      attentionTitle: null,
      email: contact.email,
      phoneE164: customerPhoneE164,
      billingAddress: null,
      serviceAddress: addressLabel(property),
      projectName: command.projectName,
      purchaseOrder: null,
      reference: command.projectReference,
      preparerName: actor?.name ?? "Stonegate team",
    },
    issuer: {},
    scope: "",
    inclusions: [],
    exclusions: [],
    assumptions: [],
    pricing: {
      documentType: command.documentType,
      currency: "USD" as const,
      lineItems: [],
      optionGroups: [],
      adjustments: [],
      deposit: { mode: "none" as const },
    },
    terms: {},
    estimatedDurationMinutes: null,
    serviceZoneId: null,
    serviceZoneConfirmed: false,
  };
  const [version] = await tx
    .insert(quoteVersions)
    .values({
      quoteId: quote.id,
      versionNumber: 1,
      draftRevision: 1,
      state: "draft",
      provenance: "native",
      schemaVersion: QUOTE_V2_SCHEMA_VERSION,
      documentType: command.documentType,
      audience: command.audience,
      schedulingMode: command.schedulingMode,
      currency: "USD",
      documentSnapshot: initialDocument,
      partySnapshot: initialDocument.parties,
      issuerSnapshot: {},
      termsSnapshot: {},
      clientName: initialDocument.parties.customerName,
      clientCompany: contact.company,
      clientEmail: contact.email,
      clientPhone: customerPhoneE164,
      projectName: command.projectName,
      referenceNumber: command.projectReference,
      createdByTeamMemberId: input.actorTeamMemberId,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: quoteVersions.id });
  if (!version) {
    throw new TeamMutationFailure(
      "internal",
      "The initial quote version could not be created.",
    );
  }
  const [linked] = await tx
    .update(quotes)
    .set({ currentVersionId: version.id, updatedAt: now })
    .where(eq(quotes.id, quote.id))
    .returning({ id: quotes.id });
  if (!linked) {
    throw new TeamMutationFailure(
      "internal",
      "The quote version could not be linked to its aggregate.",
    );
  }
  if (command.leadId) {
    const [linkedLead] = await tx
      .update(leads)
      .set({
        salesOpportunityId: opportunity.id,
        quoteId: quote.id,
        updatedAt: now,
      })
      .where(
        and(
          eq(leads.id, command.leadId),
          eq(leads.contactId, contact.id),
          eq(leads.propertyId, property.id),
        ),
      )
      .returning({ id: leads.id });
    if (!linkedLead) {
      throw new TeamMutationFailure(
        "conflict",
        "The source lead changed while the quote was created.",
        { retryable: true },
      );
    }
  }
  await tx.insert(quoteActivityEvents).values({
    quoteId: quote.id,
    quoteVersionId: version.id,
    eventType: "quote.draft_created",
    actorType: "team_member",
    actorTeamMemberId: input.actorTeamMemberId,
    correlationId: input.correlationId,
    metadata: { opportunityId: opportunity.id },
    occurredAt: now,
    createdAt: now,
  });

  return {
    quoteId: quote.id,
    versionId: version.id,
    quoteNumber: quote.quoteNumber,
    quoteRevision: 1,
    draftRevision: 1,
    state: "draft",
    totals: null,
  };
}

export async function saveQuoteV2Draft(
  tx: TeamMutationTransaction,
  input: {
    quoteId: string;
    command: QuoteV2SaveDraftCommand;
    actorTeamMemberId: string;
    correlationId: string;
    expectedDraftRevision: number;
    now?: Date;
  },
): Promise<QuoteV2DraftReceipt> {
  const command = QuoteV2SaveDraftCommandSchema.parse(input.command);
  const now = input.now ?? new Date();
  const [quote] = await tx
    .select({
      id: quotes.id,
      quoteNumber: quotes.quoteNumber,
      engineVersion: quotes.engineVersion,
      aggregateRevision: quotes.aggregateRevision,
      currentVersionId: quotes.currentVersionId,
    })
    .from(quotes)
    .where(eq(quotes.id, input.quoteId))
    .for("update")
    .limit(1);
  if (!quote || quote.engineVersion !== "v2" || !quote.quoteNumber) {
    throw new TeamMutationFailure("invalid", "The quote draft was not found.", {
      status: 404,
    });
  }
  if (
    quote.currentVersionId !== command.versionId ||
    !quote.aggregateRevision
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "A newer quote version is active. Refresh before editing.",
    );
  }
  const [version] = await tx
    .select({
      id: quoteVersions.id,
      state: quoteVersions.state,
      draftRevision: quoteVersions.draftRevision,
    })
    .from(quoteVersions)
    .where(
      and(
        eq(quoteVersions.id, command.versionId),
        eq(quoteVersions.quoteId, quote.id),
      ),
    )
    .for("update")
    .limit(1);
  if (!version || version.state !== "draft") {
    throw new TeamMutationFailure(
      "conflict",
      "Only the active draft version can be edited.",
    );
  }
  if (
    version.draftRevision !== command.draftRevision ||
    version.draftRevision !== input.expectedDraftRevision
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "The draft changed after it was loaded. Refresh before saving again.",
      {
        retryable: true,
        fieldErrors: { version: "This autosave is stale." },
      },
    );
  }

  const nextDraftRevision = version.draftRevision + 1;
  const document = command.document;
  assertQuoteV2CatalogPolicy(document, { requireConfirmedZone: false });
  const totals = safeDraftTotals(document);
  const [updated] = await tx
    .update(quoteVersions)
    .set({
      draftRevision: nextDraftRevision,
      documentType: document.documentType,
      audience: document.audience,
      schedulingMode: document.schedulingMode,
      documentSnapshot: document as unknown as Record<string, unknown>,
      partySnapshot: document.parties as Record<string, unknown>,
      issuerSnapshot: document.issuer as Record<string, unknown>,
      termsSnapshot: document.terms as Record<string, unknown>,
      clientName:
        typeof document.parties.customerName === "string"
          ? document.parties.customerName
          : null,
      clientCompany: document.parties.companyName ?? null,
      clientEmail: document.parties.email ?? null,
      clientPhone: document.parties.phoneE164 ?? null,
      projectName: document.parties.projectName ?? null,
      purchaseOrderNumber: document.parties.purchaseOrder ?? null,
      referenceNumber: document.parties.reference ?? null,
      scope: document.scope || null,
      assumptions: document.assumptions.join("\n") || null,
      exclusions: document.exclusions.join("\n") || null,
      terms:
        typeof document.terms.terms === "string" && document.terms.terms
          ? document.terms.terms
          : null,
      paymentTerms:
        typeof document.terms.paymentTerms === "string" &&
        document.terms.paymentTerms
          ? document.terms.paymentTerms
          : null,
      internalNotes: command.internalNotes ?? null,
      updatedAt: now,
    })
    .where(
      and(
        eq(quoteVersions.id, version.id),
        eq(quoteVersions.state, "draft"),
        eq(quoteVersions.draftRevision, version.draftRevision),
      ),
    )
    .returning({ id: quoteVersions.id });
  if (!updated) {
    throw new TeamMutationFailure(
      "conflict",
      "The draft changed while it was being saved. Retry shortly.",
      { retryable: true },
    );
  }
  await tx.insert(quoteActivityEvents).values({
    quoteId: quote.id,
    quoteVersionId: version.id,
    eventType: "quote.draft_saved",
    actorType: "team_member",
    actorTeamMemberId: input.actorTeamMemberId,
    correlationId: input.correlationId,
    metadata: { draftRevision: nextDraftRevision },
    occurredAt: now,
    createdAt: now,
  });

  return {
    quoteId: quote.id,
    versionId: version.id,
    quoteNumber: quote.quoteNumber,
    quoteRevision: quote.aggregateRevision,
    draftRevision: nextDraftRevision,
    state: "draft",
    totals,
  };
}

export async function finalizeQuoteV2Draft(
  tx: TeamMutationTransaction,
  input: {
    quoteId: string;
    command: QuoteV2FinalizeCommand;
    actorTeamMemberId: string;
    correlationId: string;
    expectedDraftRevision: number;
    now?: Date;
  },
): Promise<QuoteV2DraftReceipt> {
  const command = QuoteV2FinalizeCommandSchema.parse(input.command);
  const now = input.now ?? new Date();
  const [quote] = await tx
    .select({
      id: quotes.id,
      quoteNumber: quotes.quoteNumber,
      engineVersion: quotes.engineVersion,
      aggregateState: quotes.aggregateState,
      aggregateRevision: quotes.aggregateRevision,
      currentVersionId: quotes.currentVersionId,
    })
    .from(quotes)
    .where(eq(quotes.id, input.quoteId))
    .for("update")
    .limit(1);
  if (
    !quote ||
    quote.engineVersion !== "v2" ||
    !["draft", "open"].includes(quote.aggregateState ?? "") ||
    !quote.currentVersionId ||
    !quote.quoteNumber ||
    !quote.aggregateRevision
  ) {
    throw new TeamMutationFailure("invalid", "The quote draft was not found.", {
      status: 404,
    });
  }
  const [version] = await tx
    .select()
    .from(quoteVersions)
    .where(
      and(
        eq(quoteVersions.id, quote.currentVersionId),
        eq(quoteVersions.quoteId, quote.id),
      ),
    )
    .for("update")
    .limit(1);
  if (!version || version.state !== "draft") {
    throw new TeamMutationFailure(
      "conflict",
      "Only an active draft can be finalized.",
    );
  }
  if (
    version.draftRevision !== command.draftRevision ||
    version.draftRevision !== input.expectedDraftRevision
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "The draft changed after review. Refresh and review it again.",
      { fieldErrors: { version: "This review is stale." } },
    );
  }
  const parsedDocument = QuoteDocumentSnapshotSchema.safeParse(
    version.documentSnapshot,
  );
  if (!parsedDocument.success) {
    throw new TeamMutationFailure(
      "invalid",
      "Complete the proposal readiness checklist before finalizing.",
      { fieldErrors: exactDocumentFieldErrors(parsedDocument.error) },
    );
  }
  let totals: QuoteTotals;
  try {
    totals = calculateQuoteV2Totals(parsedDocument.data.pricing);
  } catch (error) {
    if (error instanceof QuoteDomainError) {
      throw new TeamMutationFailure("invalid", error.message, {
        fieldErrors: error.fieldErrors,
      });
    }
    throw error;
  }
  if (totals.totalMinCents <= 0) {
    throw new TeamMutationFailure(
      "invalid",
      "An issued proposal must have a positive total.",
      { fieldErrors: { total: "Add valid customer-facing pricing." } },
    );
  }
  const document = parsedDocument.data;
  assertQuoteV2CatalogPolicy(document, { requireConfirmedZone: true });

  const groupRows = document.pricing.optionGroups.map((group, index) => ({
    id: randomUUID(),
    quoteVersionId: version.id,
    groupKey: group.id,
    label: group.label,
    mode: group.mode,
    minimumSelections: group.minimumSelections,
    maximumSelections: group.maximumSelections,
    displayOrder: index,
    metadata: {},
    createdAt: now,
  }));
  if (groupRows.length > 0) {
    await tx.insert(quoteVersionOptionGroups).values(groupRows);
  }
  const groupIdByKey = new Map(
    groupRows.map((group) => [group.groupKey, group.id]),
  );
  if (totals.lines.length > 0) {
    await tx.insert(quoteVersionLineItems).values(
      totals.lines.map((line) => ({
        quoteVersionId: version.id,
        lineKey: line.id,
        catalogKey: line.catalogKey ?? null,
        name: line.name,
        description: line.description ?? null,
        quantity: line.quantity.toFixed(3),
        unit: line.unit,
        unitPriceMinCents: line.unitPriceMinCents,
        unitPriceMaxCents: line.unitPriceMaxCents ?? line.unitPriceMinCents,
        amountMinCents: line.amountMinCents,
        amountMaxCents: line.amountMaxCents,
        optionGroupId: line.optionGroupId
          ? (groupIdByKey.get(line.optionGroupId) ?? null)
          : null,
        selectedByDefault: line.selectedByDefault,
        displayOrder: line.displayOrder,
        metadata: {},
        createdAt: now,
      })),
    );
  }
  if (totals.adjustments.length > 0) {
    await tx.insert(quoteVersionAdjustments).values(
      totals.adjustments.map((adjustment) => ({
        quoteVersionId: version.id,
        adjustmentKey: adjustment.id,
        kind: adjustment.kind,
        label: adjustment.label,
        calculation: adjustment.calculation,
        basis: adjustment.basis,
        eligibleLineItemKeys: adjustment.eligibleLineItemIds,
        amountCents: adjustment.amountCents ?? null,
        basisPoints: adjustment.basisPoints ?? null,
        amountMinCents: adjustment.amountMinCents,
        amountMaxCents: adjustment.amountMaxCents,
        displayOrder: adjustment.displayOrder,
        metadata: {},
        createdAt: now,
      })),
    );
  }

  const readyCanonical = canonicalQuoteJson({ document, totals });
  const nextDraftRevision = version.draftRevision + 1;
  const [updated] = await tx
    .update(quoteVersions)
    .set({
      state: "ready",
      draftRevision: nextDraftRevision,
      documentSnapshot: document,
      partySnapshot: document.parties,
      issuerSnapshot: document.issuer,
      termsSnapshot: document.terms,
      canonicalRenderJson: readyCanonical,
      documentSchemaHash: hashQuoteContent({
        schema: "quote_document_snapshot",
        version: document.schemaVersion,
      }),
      pricingHash: hashQuoteContent(document.pricing),
      templateHash: hashQuoteContent(document.terms),
      contentHash: hashQuoteContent({ document, totals }),
      selectedOptionIds: totals.selectedOptionIds,
      subtotalMinCents: totals.subtotalMinCents,
      subtotalMaxCents: totals.subtotalMaxCents,
      discountMinCents: totals.discountMinCents,
      discountMaxCents: totals.discountMaxCents,
      feeMinCents: totals.feeMinCents,
      feeMaxCents: totals.feeMaxCents,
      totalMinCents: totals.totalMinCents,
      totalMaxCents: totals.totalMaxCents,
      depositCents: totals.depositCents,
      balanceMinCents: totals.balanceMinCents,
      balanceMaxCents: totals.balanceMaxCents,
      scope: document.scope,
      assumptions: document.assumptions.join("\n") || null,
      exclusions: document.exclusions.join("\n") || null,
      terms: document.terms.terms,
      paymentTerms: document.terms.paymentTerms,
      readyAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(quoteVersions.id, version.id),
        eq(quoteVersions.state, "draft"),
        eq(quoteVersions.draftRevision, version.draftRevision),
      ),
    )
    .returning({ id: quoteVersions.id });
  if (!updated) {
    throw new TeamMutationFailure(
      "conflict",
      "The draft changed while it was being finalized. Retry the review.",
      { retryable: true },
    );
  }
  await tx.insert(quoteActivityEvents).values({
    quoteId: quote.id,
    quoteVersionId: version.id,
    eventType: "quote.version_ready",
    actorType: "team_member",
    actorTeamMemberId: input.actorTeamMemberId,
    correlationId: input.correlationId,
    metadata: { draftRevision: nextDraftRevision },
    occurredAt: now,
    createdAt: now,
  });

  return {
    quoteId: quote.id,
    versionId: version.id,
    quoteNumber: quote.quoteNumber,
    quoteRevision: quote.aggregateRevision,
    draftRevision: nextDraftRevision,
    state: "ready",
    totals,
  };
}
