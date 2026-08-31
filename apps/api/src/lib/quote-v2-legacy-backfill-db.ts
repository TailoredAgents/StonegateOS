import { and, asc, eq, gt, inArray, or, sql, type SQL } from "drizzle-orm";
import {
  appointmentHolds,
  contactProperties,
  contacts,
  getDb,
  leads,
  properties,
  quoteCapabilities,
  quoteMigrationCheckpoints,
  quoteMigrationReviewItems,
  quotes,
  quoteVersionAdjustments,
  quoteVersionLineItems,
  quoteVersions,
  salesOpportunities,
  teamMembers,
  type DatabaseClient,
} from "@/db";
import {
  quoteVersionBackfillLifecyclePath,
  revokePreparedLegacyCapabilityForInactiveContact,
  runQuoteV2LegacyBackfill,
  type LegacyQuoteBackfillCursor,
  type LegacyQuoteBackfillRow,
  type PreparedLegacyQuoteBackfill,
  type QuoteMigrationReview,
  type QuoteV2LegacyBackfillSummary,
  type QuoteV2LegacyBackfillStore,
} from "@/lib/quote-v2-legacy-backfill";

type TransactionExecutor = Parameters<
  DatabaseClient["transaction"]
>[0] extends (transaction: infer Transaction) => Promise<unknown>
  ? Transaction
  : never;

type BackfillExecutor = DatabaseClient | TransactionExecutor;

function checkpointCursor(value: unknown): LegacyQuoteBackfillCursor | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate["createdAt"] !== "string" ||
    !Number.isFinite(Date.parse(candidate["createdAt"])) ||
    typeof candidate["id"] !== "string" ||
    !/^[0-9a-f-]{36}$/iu.test(candidate["id"])
  ) {
    return null;
  }
  return { createdAt: candidate["createdAt"], id: candidate["id"] };
}

async function insertReviews(
  database: BackfillExecutor,
  quoteId: string,
  reviews: QuoteMigrationReview[],
): Promise<void> {
  if (reviews.length === 0) return;
  await database
    .insert(quoteMigrationReviewItems)
    .values(
      reviews.map((review) => ({
        legacyEntityType: "quote",
        legacyEntityId: quoteId,
        reasonCode: review.reasonCode,
        details: review.details,
        status: "open",
      })),
    )
    .onConflictDoNothing({
      target: [
        quoteMigrationReviewItems.legacyEntityType,
        quoteMigrationReviewItems.legacyEntityId,
        quoteMigrationReviewItems.reasonCode,
      ],
    });
}

function quoteCursorPredicate(
  cursor: LegacyQuoteBackfillCursor | null,
): SQL | undefined {
  if (!cursor) return undefined;
  const createdAt = new Date(cursor.createdAt);
  return or(
    gt(quotes.createdAt, createdAt),
    and(eq(quotes.createdAt, createdAt), gt(quotes.id, cursor.id)),
  );
}

async function loadEnrichedBatch(
  database: DatabaseClient,
  input: { cursor: LegacyQuoteBackfillCursor | null; limit: number },
): Promise<LegacyQuoteBackfillRow[]> {
  const baseRows = await database
    .select({
      id: quotes.id,
      contactId: quotes.contactId,
      propertyId: quotes.propertyId,
      status: quotes.status,
      services: quotes.services,
      addOns: quotes.addOns,
      surfaceArea: quotes.surfaceArea,
      zoneId: quotes.zoneId,
      travelFee: quotes.travelFee,
      discounts: quotes.discounts,
      addOnsTotal: quotes.addOnsTotal,
      subtotal: quotes.subtotal,
      total: quotes.total,
      depositDue: quotes.depositDue,
      depositRate: quotes.depositRate,
      balanceDue: quotes.balanceDue,
      lineItems: quotes.lineItems,
      availability: quotes.availability,
      marketing: quotes.marketing,
      notes: quotes.notes,
      quoteNumber: quotes.quoteNumber,
      jobDurationMinutes: quotes.jobDurationMinutes,
      clientScope: quotes.clientScope,
      revision: quotes.revision,
      shareToken: quotes.shareToken,
      sentAt: quotes.sentAt,
      expiresAt: quotes.expiresAt,
      viewedAt: quotes.viewedAt,
      lastViewedAt: quotes.lastViewedAt,
      viewCount: quotes.viewCount,
      decisionAt: quotes.decisionAt,
      decisionNotes: quotes.decisionNotes,
      refreshRequestedAt: quotes.refreshRequestedAt,
      acceptedAppointmentId: quotes.acceptedAppointmentId,
      createdAt: quotes.createdAt,
      updatedAt: quotes.updatedAt,
      contactFirstName: contacts.firstName,
      contactLastName: contacts.lastName,
      contactCompany: contacts.company,
      contactEmail: contacts.email,
      contactPhone: contacts.phone,
      contactPhoneE164: contacts.phoneE164,
      salespersonMemberId: contacts.salespersonMemberId,
      contactDeletedAt: contacts.deletedAt,
      propertyAddressLine1: properties.addressLine1,
      propertyAddressLine2: properties.addressLine2,
      propertyCity: properties.city,
      propertyState: properties.state,
      propertyPostalCode: properties.postalCode,
      propertyLegacyContactId: properties.contactId,
    })
    .from(quotes)
    .innerJoin(contacts, eq(contacts.id, quotes.contactId))
    .innerJoin(properties, eq(properties.id, quotes.propertyId))
    .where(
      and(
        eq(quotes.engineVersion, "legacy"),
        quoteCursorPredicate(input.cursor),
      ),
    )
    .orderBy(asc(quotes.createdAt), asc(quotes.id))
    .limit(input.limit);

  if (baseRows.length === 0) return [];
  const quoteIds = baseRows.map((row) => row.id);
  const propertyIds = [...new Set(baseRows.map((row) => row.propertyId))];
  const ownerIds = [
    ...new Set(
      baseRows
        .map((row) => row.salespersonMemberId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const quoteNumbers = [
    ...new Set(
      baseRows
        .map((row) => row.quoteNumber?.trim() || null)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  const appointmentIds = [
    ...new Set(
      baseRows
        .map((row) => row.acceptedAppointmentId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];

  const [
    leadRows,
    propertyLinkRows,
    ownerRows,
    numberRows,
    holdRows,
    appointmentReferenceRows,
  ] = await Promise.all([
    database
      .select({
        id: leads.id,
        quoteId: leads.quoteId,
        contactId: leads.contactId,
        propertyId: leads.propertyId,
      })
      .from(leads)
      .where(inArray(leads.quoteId, quoteIds)),
    database
      .select({
        contactId: contactProperties.contactId,
        propertyId: contactProperties.propertyId,
      })
      .from(contactProperties)
      .where(inArray(contactProperties.propertyId, propertyIds)),
    ownerIds.length > 0
      ? database
          .select({ id: teamMembers.id })
          .from(teamMembers)
          .where(inArray(teamMembers.id, ownerIds))
      : Promise.resolve([]),
    quoteNumbers.length > 0
      ? database
          .select({ id: quotes.id, quoteNumber: quotes.quoteNumber })
          .from(quotes)
          .where(inArray(quotes.quoteNumber, quoteNumbers))
      : Promise.resolve([]),
    database
      .select({
        id: appointmentHolds.id,
        quoteId: appointmentHolds.fullQuoteId,
      })
      .from(appointmentHolds)
      .where(
        and(
          inArray(appointmentHolds.fullQuoteId, quoteIds),
          eq(appointmentHolds.status, "active"),
        ),
      ),
    appointmentIds.length > 0
      ? database
          .select({
            id: quotes.id,
            acceptedAppointmentId: quotes.acceptedAppointmentId,
          })
          .from(quotes)
          .where(inArray(quotes.acceptedAppointmentId, appointmentIds))
      : Promise.resolve([]),
  ]);

  const leadsByQuote = new Map<
    string,
    LegacyQuoteBackfillRow["linkedLeadCandidates"]
  >();
  for (const lead of leadRows) {
    if (!lead.quoteId) continue;
    const existing = leadsByQuote.get(lead.quoteId) ?? [];
    existing.push({
      id: lead.id,
      contactId: lead.contactId,
      propertyId: lead.propertyId,
    });
    leadsByQuote.set(lead.quoteId, existing);
  }
  const propertyLinks = new Set(
    propertyLinkRows.map((link) => `${link.contactId}:${link.propertyId}`),
  );
  const validOwners = new Set(ownerRows.map((row) => row.id));
  const numberCounts = new Map<string, number>();
  for (const quote of numberRows) {
    if (!quote.quoteNumber) continue;
    numberCounts.set(
      quote.quoteNumber,
      (numberCounts.get(quote.quoteNumber) ?? 0) + 1,
    );
  }
  const holdsByQuote = new Map<string, number>();
  for (const hold of holdRows) {
    if (!hold.quoteId) continue;
    holdsByQuote.set(hold.quoteId, (holdsByQuote.get(hold.quoteId) ?? 0) + 1);
  }
  const appointmentReferenceCounts = new Map<string, number>();
  for (const reference of appointmentReferenceRows) {
    if (!reference.acceptedAppointmentId) continue;
    appointmentReferenceCounts.set(
      reference.acceptedAppointmentId,
      (appointmentReferenceCounts.get(reference.acceptedAppointmentId) ?? 0) +
        1,
    );
  }

  return baseRows.map((row) => ({
    id: row.id,
    contactId: row.contactId,
    propertyId: row.propertyId,
    status: row.status,
    services: row.services,
    addOns: row.addOns,
    surfaceArea: row.surfaceArea,
    zoneId: row.zoneId,
    travelFee: row.travelFee,
    discounts: row.discounts,
    addOnsTotal: row.addOnsTotal,
    subtotal: row.subtotal,
    total: row.total,
    depositDue: row.depositDue,
    depositRate: row.depositRate,
    balanceDue: row.balanceDue,
    lineItems: row.lineItems,
    availability: row.availability,
    marketing: row.marketing,
    notes: row.notes,
    quoteNumber: row.quoteNumber,
    jobDurationMinutes: row.jobDurationMinutes,
    clientScope: row.clientScope,
    revision: row.revision,
    shareToken: row.shareToken,
    sentAt: row.sentAt,
    expiresAt: row.expiresAt,
    viewedAt: row.viewedAt,
    lastViewedAt: row.lastViewedAt,
    viewCount: row.viewCount,
    decisionAt: row.decisionAt,
    decisionNotes: row.decisionNotes,
    refreshRequestedAt: row.refreshRequestedAt,
    acceptedAppointmentId: row.acceptedAppointmentId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    contact: {
      firstName: row.contactFirstName,
      lastName: row.contactLastName,
      company: row.contactCompany,
      email: row.contactEmail,
      phone: row.contactPhone,
      phoneE164: row.contactPhoneE164,
      salespersonMemberId: row.salespersonMemberId,
      deletedAt: row.contactDeletedAt,
    },
    property: {
      addressLine1: row.propertyAddressLine1,
      addressLine2: row.propertyAddressLine2,
      city: row.propertyCity,
      state: row.propertyState,
      postalCode: row.propertyPostalCode,
      legacyContactId: row.propertyLegacyContactId,
    },
    linkedLeadCandidates: leadsByQuote.get(row.id) ?? [],
    hasCanonicalContactPropertyLink: propertyLinks.has(
      `${row.contactId}:${row.propertyId}`,
    ),
    ownerTeamMemberExists:
      row.salespersonMemberId === null ||
      validOwners.has(row.salespersonMemberId),
    quoteNumberCollision:
      row.quoteNumber !== null && (numberCounts.get(row.quoteNumber) ?? 0) > 1,
    activeHoldCount: holdsByQuote.get(row.id) ?? 0,
    acceptedAppointmentReferenceCount: row.acceptedAppointmentId
      ? (appointmentReferenceCounts.get(row.acceptedAppointmentId) ?? 0)
      : 0,
  }));
}

async function persistQuote(
  database: DatabaseClient,
  prepared: PreparedLegacyQuoteBackfill,
): Promise<{
  outcome: "migrated" | "review" | "skipped";
  additionalReviews?: QuoteMigrationReview[];
}> {
  return database.transaction(async (tx) => {
    // Match contact deletion's lock order. The first quote read is deliberately
    // unlocked so the per-contact advisory lock is always acquired before the
    // authoritative quote/contact row lock.
    const [candidateQuote] = await tx
      .select({
        id: quotes.id,
        contactId: quotes.contactId,
        engineVersion: quotes.engineVersion,
      })
      .from(quotes)
      .where(eq(quotes.id, prepared.quoteId))
      .limit(1);
    if (!candidateQuote || candidateQuote.engineVersion !== "legacy") {
      return { outcome: "skipped" as const };
    }
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${candidateQuote.contactId}, 0))`,
    );

    const [lockedQuote] = await tx
      .select({
        id: quotes.id,
        contactId: quotes.contactId,
        contactDeletedAt: contacts.deletedAt,
        engineVersion: quotes.engineVersion,
        salesOpportunityId: quotes.salesOpportunityId,
        currentVersionId: quotes.currentVersionId,
        publishedVersionId: quotes.publishedVersionId,
      })
      .from(quotes)
      .innerJoin(contacts, eq(contacts.id, quotes.contactId))
      .where(eq(quotes.id, prepared.quoteId))
      .for("update")
      .limit(1);
    if (!lockedQuote || lockedQuote.engineVersion !== "legacy") {
      return { outcome: "skipped" as const };
    }
    if (
      lockedQuote.contactId !== candidateQuote.contactId ||
      lockedQuote.contactId !== prepared.opportunity.contactId
    ) {
      throw new Error(
        "The legacy quote contact changed while its migration row was being persisted.",
      );
    }

    const [existingVersion] = await tx
      .select({
        id: quoteVersions.id,
        provenance: quoteVersions.provenance,
      })
      .from(quoteVersions)
      .where(
        and(
          eq(quoteVersions.quoteId, prepared.quoteId),
          eq(quoteVersions.versionNumber, 1),
        ),
      )
      .limit(1);

    if (
      lockedQuote.currentVersionId === prepared.version.id &&
      existingVersion?.id === prepared.version.id &&
      existingVersion.provenance === "legacy_current_state"
    ) {
      await insertReviews(tx, prepared.quoteId, prepared.reviews);
      return { outcome: "skipped" as const };
    }

    const additionalReviews: QuoteMigrationReview[] = [];
    if (
      (lockedQuote.currentVersionId &&
        lockedQuote.currentVersionId !== prepared.version.id) ||
      (existingVersion &&
        (existingVersion.id !== prepared.version.id ||
          existingVersion.provenance !== "legacy_current_state"))
    ) {
      additionalReviews.push({
        reasonCode: "version_number_collision",
        details: {},
      });
      await insertReviews(tx, prepared.quoteId, [
        ...prepared.reviews,
        ...additionalReviews,
      ]);
      return { outcome: "review" as const, additionalReviews };
    }

    await tx
      .insert(salesOpportunities)
      .values(prepared.opportunity)
      .onConflictDoNothing({ target: salesOpportunities.id });

    const {
      initialState: _initialState,
      targetState,
      ...versionValues
    } = prepared.version;
    await tx
      .insert(quoteVersions)
      .values({ ...versionValues, state: "draft" })
      .onConflictDoNothing({ target: quoteVersions.id });

    if (prepared.lineItems.length > 0) {
      await tx
        .insert(quoteVersionLineItems)
        .values(prepared.lineItems)
        .onConflictDoNothing({
          target: [
            quoteVersionLineItems.quoteVersionId,
            quoteVersionLineItems.lineKey,
          ],
        });
    }
    if (prepared.adjustments.length > 0) {
      await tx
        .insert(quoteVersionAdjustments)
        .values(prepared.adjustments)
        .onConflictDoNothing({
          target: [
            quoteVersionAdjustments.quoteVersionId,
            quoteVersionAdjustments.adjustmentKey,
          ],
        });
    }

    for (const state of quoteVersionBackfillLifecyclePath(targetState)) {
      await tx
        .update(quoteVersions)
        .set({ state })
        .where(eq(quoteVersions.id, prepared.version.id));
    }

    const capability =
      prepared.capability && lockedQuote.contactDeletedAt
        ? revokePreparedLegacyCapabilityForInactiveContact(
            prepared.capability,
            lockedQuote.contactDeletedAt,
          )
        : prepared.capability;
    if (capability) {
      const [capabilityOwner] = await tx
        .select({ quoteId: quoteCapabilities.quoteId })
        .from(quoteCapabilities)
        .where(eq(quoteCapabilities.tokenHash, capability.tokenHash))
        .limit(1);
      if (capabilityOwner && capabilityOwner.quoteId !== prepared.quoteId) {
        additionalReviews.push({
          reasonCode: "capability_hash_collision",
          details: {},
        });
      } else {
        await tx
          .insert(quoteCapabilities)
          .values(capability)
          .onConflictDoNothing({ target: quoteCapabilities.tokenHash });
      }
    }

    await tx
      .update(quotes)
      .set({
        salesOpportunityId: prepared.quotePatch.salesOpportunityId,
        currentVersionId: prepared.quotePatch.currentVersionId,
        publishedVersionId: prepared.quotePatch.publishedVersionId,
        aggregateState: prepared.quotePatch.aggregateState,
        aggregateRevision: prepared.quotePatch.aggregateRevision,
        // Backfill pointers are additive metadata, not a new customer/staff
        // edit to the legacy quote's business timestamp.
        updatedAt: prepared.quotePatch.updatedAt,
      })
      .where(
        and(
          eq(quotes.id, prepared.quoteId),
          eq(quotes.engineVersion, "legacy"),
        ),
      );

    const allReviews = [...prepared.reviews, ...additionalReviews];
    await insertReviews(tx, prepared.quoteId, allReviews);
    return {
      outcome:
        allReviews.length > 0 ? ("review" as const) : ("migrated" as const),
      ...(additionalReviews.length > 0 ? { additionalReviews } : {}),
    };
  });
}

export function createDrizzleQuoteV2LegacyBackfillStore(
  database: DatabaseClient = getDb(),
): QuoteV2LegacyBackfillStore {
  return {
    async startCheckpoint(input) {
      await database
        .insert(quoteMigrationCheckpoints)
        .values({
          jobKey: input.jobKey,
          checkpointKey: input.checkpointKey,
          status: "pending",
        })
        .onConflictDoNothing({
          target: [
            quoteMigrationCheckpoints.jobKey,
            quoteMigrationCheckpoints.checkpointKey,
          ],
        });

      const [current] = await database
        .select({
          status: quoteMigrationCheckpoints.status,
          cursor: quoteMigrationCheckpoints.cursor,
        })
        .from(quoteMigrationCheckpoints)
        .where(
          and(
            eq(quoteMigrationCheckpoints.jobKey, input.jobKey),
            eq(quoteMigrationCheckpoints.checkpointKey, input.checkpointKey),
          ),
        )
        .limit(1);
      if (!current)
        throw new Error("Quote backfill checkpoint could not be created");
      if (current.status === "completed") {
        return {
          status: "completed",
          cursor: checkpointCursor(current.cursor),
        };
      }

      await database
        .update(quoteMigrationCheckpoints)
        .set({
          status: "running",
          startedAt: sql`coalesce(${quoteMigrationCheckpoints.startedAt}, ${input.now})`,
          lastHeartbeatAt: input.now,
          completedAt: null,
          lastErrorCode: null,
          lastErrorDetail: null,
        })
        .where(
          and(
            eq(quoteMigrationCheckpoints.jobKey, input.jobKey),
            eq(quoteMigrationCheckpoints.checkpointKey, input.checkpointKey),
          ),
        );
      return { status: "running", cursor: checkpointCursor(current.cursor) };
    },

    loadBatch(input) {
      return loadEnrichedBatch(database, input);
    },

    persistPreparedQuote(prepared) {
      return persistQuote(database, prepared);
    },

    async advanceCheckpoint(input) {
      await database
        .update(quoteMigrationCheckpoints)
        .set({
          cursor: input.cursor,
          status: input.status,
          scannedCount: sql`${quoteMigrationCheckpoints.scannedCount} + ${input.scannedDelta}`,
          migratedCount: sql`${quoteMigrationCheckpoints.migratedCount} + ${input.migratedDelta}`,
          reviewCount: sql`${quoteMigrationCheckpoints.reviewCount} + ${input.reviewDelta}`,
          skippedCount: sql`${quoteMigrationCheckpoints.skippedCount} + ${input.skippedDelta}`,
          lastHeartbeatAt: input.now,
          completedAt: null,
        })
        .where(
          and(
            eq(quoteMigrationCheckpoints.jobKey, input.jobKey),
            eq(quoteMigrationCheckpoints.checkpointKey, input.checkpointKey),
          ),
        );
    },

    async completeCheckpoint(input) {
      await database
        .update(quoteMigrationCheckpoints)
        .set({
          cursor: input.cursor,
          status: "completed",
          lastHeartbeatAt: input.now,
          completedAt: input.now,
          lastErrorCode: null,
          lastErrorDetail: null,
        })
        .where(
          and(
            eq(quoteMigrationCheckpoints.jobKey, input.jobKey),
            eq(quoteMigrationCheckpoints.checkpointKey, input.checkpointKey),
          ),
        );
    },

    async failCheckpoint(input) {
      await database
        .update(quoteMigrationCheckpoints)
        .set({
          status: "failed",
          lastHeartbeatAt: input.now,
          lastErrorCode: input.errorCode,
          // Deliberately omit the caught exception message: provider/database
          // errors can echo bound values, including a legacy bearer token.
          lastErrorDetail:
            "Quote V2 legacy backfill failed; inspect redacted operational logs.",
        })
        .where(
          and(
            eq(quoteMigrationCheckpoints.jobKey, input.jobKey),
            eq(quoteMigrationCheckpoints.checkpointKey, input.checkpointKey),
          ),
        );
    },
  };
}

export function runDrizzleQuoteV2LegacyBackfill(
  input: {
    database?: DatabaseClient;
    dryRun?: boolean;
    batchSize?: number;
    maxBatches?: number;
    now?: Date;
    cursor?: LegacyQuoteBackfillCursor | null;
    recipientHashSecret?: string;
  } = {},
): Promise<QuoteV2LegacyBackfillSummary> {
  return runQuoteV2LegacyBackfill({
    store: createDrizzleQuoteV2LegacyBackfillStore(input.database ?? getDb()),
    dryRun: input.dryRun,
    batchSize: input.batchSize,
    maxBatches: input.maxBatches,
    now: input.now,
    cursor: input.cursor,
    recipientHashSecret: input.recipientHashSecret,
  });
}
