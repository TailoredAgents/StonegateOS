import {
  and,
  desc,
  eq,
  gt,
  ilike,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { alias } from "drizzle-orm/pg-core";
import {
  getDb,
  partnerBookings,
  partnerBillingDisputeRequests,
  partnerCancellationRequestReconciliationCases,
  partnerCancellationRequests,
  partnerJobChangeRequests,
  partnerAccessApplications,
  partnerApprovalRequests,
  partnerApprovalRules,
  partnerAccountInvitations,
  partnerAccountMergeCases,
  partnerAccountLocations,
  partnerAccountCancellationPolicies,
  partnerAccountDomains,
  partnerAccountMemberships,
  partnerAccountSchedulingPolicies,
  partnerAccounts,
  partnerCompanyJoinRequests,
  partnerInvoices,
  partnerInviteOperations,
  partnerLocationAddressReviews,
  partnerPaymentAllocations,
  partnerQuotes,
  partnerRateCards,
  partnerRateCardVersions,
  partnerRateItems,
  partnerSessions,
  partnerUsers,
  teamMembers,
} from "@/db";
import {
  buildPartnerManagementPage,
  escapedPartnerManagementSearch,
  type PartnerManagementListQuery,
  type PartnerManagementResource,
} from "@/lib/partner-management-list";
import {
  boundedPartnerQuarantineText,
  hasAcceptedPartnerInviteProviderEvidence,
  partnerQuarantineCaseId,
} from "@/lib/partner-management-quarantine";

function cursorCondition(
  query: PartnerManagementListQuery,
  createdAt: AnyPgColumn<{ data: Date }>,
  id: AnyPgColumn<{ data: string }>,
): SQL | null {
  if (!query.cursor) return null;
  const cursorAt = new Date(query.cursor.createdAt);
  return or(
    lt(createdAt, cursorAt),
    and(eq(createdAt, cursorAt), lt(id, query.cursor.id)),
  )!;
}

function where(filters: Array<SQL | null | undefined>): SQL | undefined {
  const present = filters.filter((value): value is SQL => Boolean(value));
  return present.length ? and(...present) : undefined;
}

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

async function listAccounts(query: PartnerManagementListQuery) {
  const search = query.q ? escapedPartnerManagementSearch(query.q) : null;
  const rows = await getDb()
    .select({
      id: partnerAccounts.id,
      name: partnerAccounts.name,
      domain: partnerAccounts.domain,
      website: partnerAccounts.website,
      segment: partnerAccounts.segment,
      subsegment: partnerAccounts.subsegment,
      status: partnerAccounts.status,
      city: partnerAccounts.city,
      state: partnerAccounts.state,
      relationshipManagerMemberId: partnerAccounts.ownerMemberId,
      portalAccessEnabled: partnerAccounts.portalAccessEnabled,
      portalLifecycleStatus: partnerAccounts.portalLifecycleStatus,
      portalLifecycleRevision: partnerAccounts.portalLifecycleRevision,
      portalLifecycleChangedAt: partnerAccounts.portalLifecycleChangedAt,
      portalLifecycleReason: partnerAccounts.portalLifecycleReason,
      mergedIntoPartnerAccountId: partnerAccounts.mergedIntoPartnerAccountId,
      schedulingPolicyAccountId:
        partnerAccountSchedulingPolicies.partnerAccountId,
      schedulingMinimumNoticeMinutes:
        partnerAccountSchedulingPolicies.minimumNoticeMinutes,
      schedulingMinimumCalendarLeadDays:
        partnerAccountSchedulingPolicies.minimumCalendarLeadDays,
      schedulingMaximumBookingHorizonDays:
        partnerAccountSchedulingPolicies.maximumBookingHorizonDays,
      schedulingInstantConfirmationEnabled:
        partnerAccountSchedulingPolicies.instantConfirmationEnabled,
      schedulingPolicyRevision: partnerAccountSchedulingPolicies.revision,
      schedulingPolicyUpdatedAt: partnerAccountSchedulingPolicies.updatedAt,
      cancellationPolicyAccountId:
        partnerAccountCancellationPolicies.partnerAccountId,
      cancellationMinimumNoticeMinutes:
        partnerAccountCancellationPolicies.minimumNoticeMinutes,
      cancellationDirectEnabled:
        partnerAccountCancellationPolicies.directCancellationEnabled,
      cancellationLateDisposition:
        partnerAccountCancellationPolicies.lateCancellationDisposition,
      cancellationAutomaticFeeMinor:
        partnerAccountCancellationPolicies.automaticFeeMinor,
      cancellationPolicyRevision: partnerAccountCancellationPolicies.revision,
      cancellationPolicyUpdatedAt: partnerAccountCancellationPolicies.updatedAt,
      createdAt: partnerAccounts.createdAt,
      updatedAt: partnerAccounts.updatedAt,
    })
    .from(partnerAccounts)
    .leftJoin(
      partnerAccountSchedulingPolicies,
      eq(partnerAccountSchedulingPolicies.partnerAccountId, partnerAccounts.id),
    )
    .leftJoin(
      partnerAccountCancellationPolicies,
      eq(
        partnerAccountCancellationPolicies.partnerAccountId,
        partnerAccounts.id,
      ),
    )
    .where(
      where([
        query.status ? eq(partnerAccounts.status, query.status as never) : null,
        search
          ? or(
              ilike(partnerAccounts.name, search),
              ilike(partnerAccounts.domain, search),
              ilike(partnerAccounts.website, search),
            )
          : null,
        cursorCondition(query, partnerAccounts.createdAt, partnerAccounts.id),
      ]),
    )
    .orderBy(desc(partnerAccounts.createdAt), desc(partnerAccounts.id))
    .limit(query.limit + 1);
  const page = buildPartnerManagementPage(rows, query);
  return {
    items: page.items.map(
      ({ schedulingPolicyAccountId, cancellationPolicyAccountId, ...row }) => ({
        ...row,
        schedulingPolicyConfigured: Boolean(schedulingPolicyAccountId),
        schedulingPolicyUpdatedAt:
          row.schedulingPolicyUpdatedAt?.toISOString() ?? null,
        cancellationPolicyConfigured: Boolean(cancellationPolicyAccountId),
        cancellationPolicyUpdatedAt:
          row.cancellationPolicyUpdatedAt?.toISOString() ?? null,
        portalLifecycleChangedAt:
          row.portalLifecycleChangedAt?.toISOString() ?? null,
        lifecycleVersion: String(row.portalLifecycleRevision),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      }),
    ),
    page: page.page,
  };
}

async function listAccountMergeCases(query: PartnerManagementListQuery) {
  const search = query.q ? escapedPartnerManagementSearch(query.q) : null;
  const sourceAccount = alias(partnerAccounts, "merge_source_account");
  const targetAccount = alias(partnerAccounts, "merge_target_account");
  const requester = alias(teamMembers, "merge_requester");
  const completer = alias(teamMembers, "merge_completer");
  const rows = await getDb()
    .select({
      id: partnerAccountMergeCases.id,
      sourcePartnerAccountId: partnerAccountMergeCases.sourcePartnerAccountId,
      sourceAccountName: sourceAccount.name,
      sourceLifecycleStatus: sourceAccount.portalLifecycleStatus,
      targetPartnerAccountId: partnerAccountMergeCases.targetPartnerAccountId,
      targetAccountName: targetAccount.name,
      targetLifecycleStatus: targetAccount.portalLifecycleStatus,
      state: partnerAccountMergeCases.state,
      reason: partnerAccountMergeCases.reason,
      conflictSummary: partnerAccountMergeCases.conflictSummary,
      requestedByName: requester.name,
      completedByName: completer.name,
      completedAt: partnerAccountMergeCases.completedAt,
      resolutionNote: partnerAccountMergeCases.resolutionNote,
      revision: partnerAccountMergeCases.version,
      createdAt: partnerAccountMergeCases.createdAt,
      updatedAt: partnerAccountMergeCases.updatedAt,
    })
    .from(partnerAccountMergeCases)
    .innerJoin(
      sourceAccount,
      eq(partnerAccountMergeCases.sourcePartnerAccountId, sourceAccount.id),
    )
    .innerJoin(
      targetAccount,
      eq(partnerAccountMergeCases.targetPartnerAccountId, targetAccount.id),
    )
    .innerJoin(
      requester,
      eq(partnerAccountMergeCases.requestedByTeamMemberId, requester.id),
    )
    .leftJoin(
      completer,
      eq(partnerAccountMergeCases.completedByTeamMemberId, completer.id),
    )
    .where(
      where([
        query.accountId
          ? or(
              eq(
                partnerAccountMergeCases.sourcePartnerAccountId,
                query.accountId,
              ),
              eq(
                partnerAccountMergeCases.targetPartnerAccountId,
                query.accountId,
              ),
            )
          : null,
        query.status
          ? eq(
              partnerAccountMergeCases.state,
              query.status as
                | "needs_reconciliation"
                | "ready"
                | "completed"
                | "cancelled",
            )
          : null,
        search
          ? or(
              ilike(sourceAccount.name, search),
              ilike(targetAccount.name, search),
              ilike(partnerAccountMergeCases.reason, search),
            )
          : null,
        cursorCondition(
          query,
          partnerAccountMergeCases.createdAt,
          partnerAccountMergeCases.id,
        ),
      ]),
    )
    .orderBy(
      desc(partnerAccountMergeCases.createdAt),
      desc(partnerAccountMergeCases.id),
    )
    .limit(query.limit + 1);
  const page = buildPartnerManagementPage(rows, query);
  return {
    items: page.items.map((row) => ({
      ...row,
      completedAt: iso(row.completedAt),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      version: String(row.revision),
    })),
    page: page.page,
  };
}

async function listCancellationRequests(query: PartnerManagementListQuery) {
  const search = query.q ? escapedPartnerManagementSearch(query.q) : null;
  const rows = await getDb()
    .select({
      id: partnerCancellationRequests.id,
      partnerAccountId: partnerCancellationRequests.partnerAccountId,
      accountName: partnerAccounts.name,
      partnerBookingId: partnerCancellationRequests.partnerBookingId,
      jobStatus: partnerBookings.publicStatus,
      state: partnerCancellationRequests.state,
      reason: partnerCancellationRequests.reason,
      requestSnapshot: partnerCancellationRequests.requestSnapshot,
      requestedByMembershipId:
        partnerCancellationRequests.requestedByMembershipId,
      requesterName: partnerUsers.name,
      requesterEmail: partnerUsers.email,
      revision: partnerCancellationRequests.revision,
      resolvedByTeamMemberId:
        partnerCancellationRequests.resolvedByTeamMemberId,
      resolverName: teamMembers.name,
      resolutionReason: partnerCancellationRequests.resolutionReason,
      resolvedAt: partnerCancellationRequests.resolvedAt,
      createdAt: partnerCancellationRequests.createdAt,
      updatedAt: partnerCancellationRequests.updatedAt,
    })
    .from(partnerCancellationRequests)
    .innerJoin(
      partnerAccounts,
      eq(partnerCancellationRequests.partnerAccountId, partnerAccounts.id),
    )
    .innerJoin(
      partnerBookings,
      and(
        eq(
          partnerCancellationRequests.partnerAccountId,
          partnerBookings.partnerAccountId,
        ),
        eq(partnerCancellationRequests.partnerBookingId, partnerBookings.id),
      ),
    )
    .innerJoin(
      partnerAccountMemberships,
      and(
        eq(
          partnerCancellationRequests.requestedByMembershipId,
          partnerAccountMemberships.id,
        ),
        eq(
          partnerCancellationRequests.partnerAccountId,
          partnerAccountMemberships.partnerAccountId,
        ),
      ),
    )
    .innerJoin(
      partnerUsers,
      eq(partnerAccountMemberships.partnerUserId, partnerUsers.id),
    )
    .leftJoin(
      teamMembers,
      eq(partnerCancellationRequests.resolvedByTeamMemberId, teamMembers.id),
    )
    .where(
      where([
        query.accountId
          ? eq(partnerCancellationRequests.partnerAccountId, query.accountId)
          : null,
        query.status
          ? eq(partnerCancellationRequests.state, query.status as never)
          : null,
        search
          ? or(
              ilike(partnerAccounts.name, search),
              ilike(partnerUsers.name, search),
              ilike(partnerUsers.email, search),
              ilike(partnerCancellationRequests.reason, search),
              sql`${partnerCancellationRequests.partnerBookingId}::text ILIKE ${search}`,
            )
          : null,
        cursorCondition(
          query,
          partnerCancellationRequests.createdAt,
          partnerCancellationRequests.id,
        ),
      ]),
    )
    .orderBy(
      desc(partnerCancellationRequests.createdAt),
      desc(partnerCancellationRequests.id),
    )
    .limit(query.limit + 1);
  const page = buildPartnerManagementPage(rows, query);
  return {
    items: page.items.map((row) => ({
      ...row,
      resolvedAt: iso(row.resolvedAt),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      version: String(row.revision),
    })),
    page: page.page,
  };
}

async function listBillingDisputes(query: PartnerManagementListQuery) {
  const search = query.q ? escapedPartnerManagementSearch(query.q) : null;
  const rows = await getDb()
    .select({
      id: partnerBillingDisputeRequests.id,
      partnerAccountId: partnerBillingDisputeRequests.partnerAccountId,
      accountName: partnerAccounts.name,
      partnerInvoiceId: partnerBillingDisputeRequests.partnerInvoiceId,
      relatedJobId: partnerBillingDisputeRequests.partnerBookingId,
      invoiceNumber: partnerInvoices.invoiceNumber,
      invoiceStatus: partnerInvoices.status,
      currency: partnerInvoices.currency,
      category: partnerBillingDisputeRequests.category,
      reason: partnerBillingDisputeRequests.reason,
      requestSnapshot: partnerBillingDisputeRequests.requestSnapshot,
      state: partnerBillingDisputeRequests.state,
      revision: partnerBillingDisputeRequests.revision,
      threadId: partnerBillingDisputeRequests.conversationThreadId,
      threadScope: partnerBillingDisputeRequests.threadScope,
      requestedByMembershipId:
        partnerBillingDisputeRequests.requestedByMembershipId,
      requesterName: partnerUsers.name,
      requesterEmail: partnerUsers.email,
      resolvedByTeamMemberId:
        partnerBillingDisputeRequests.resolvedByTeamMemberId,
      resolverName: teamMembers.name,
      resolutionReason: partnerBillingDisputeRequests.resolutionReason,
      resolutionSnapshot: partnerBillingDisputeRequests.resolutionSnapshot,
      resolvedAt: partnerBillingDisputeRequests.resolvedAt,
      createdAt: partnerBillingDisputeRequests.createdAt,
      updatedAt: partnerBillingDisputeRequests.updatedAt,
    })
    .from(partnerBillingDisputeRequests)
    .innerJoin(
      partnerAccounts,
      eq(partnerBillingDisputeRequests.partnerAccountId, partnerAccounts.id),
    )
    .innerJoin(
      partnerInvoices,
      and(
        eq(
          partnerBillingDisputeRequests.partnerAccountId,
          partnerInvoices.partnerAccountId,
        ),
        eq(partnerBillingDisputeRequests.partnerInvoiceId, partnerInvoices.id),
      ),
    )
    .innerJoin(
      partnerAccountMemberships,
      and(
        eq(
          partnerBillingDisputeRequests.requestedByMembershipId,
          partnerAccountMemberships.id,
        ),
        eq(
          partnerBillingDisputeRequests.partnerAccountId,
          partnerAccountMemberships.partnerAccountId,
        ),
      ),
    )
    .innerJoin(
      partnerUsers,
      eq(partnerAccountMemberships.partnerUserId, partnerUsers.id),
    )
    .leftJoin(
      teamMembers,
      eq(partnerBillingDisputeRequests.resolvedByTeamMemberId, teamMembers.id),
    )
    .where(
      where([
        query.accountId
          ? eq(partnerBillingDisputeRequests.partnerAccountId, query.accountId)
          : null,
        query.status
          ? eq(partnerBillingDisputeRequests.state, query.status as never)
          : null,
        search
          ? or(
              ilike(partnerAccounts.name, search),
              ilike(partnerUsers.name, search),
              ilike(partnerUsers.email, search),
              ilike(partnerInvoices.invoiceNumber, search),
              ilike(partnerBillingDisputeRequests.reason, search),
            )
          : null,
        cursorCondition(
          query,
          partnerBillingDisputeRequests.createdAt,
          partnerBillingDisputeRequests.id,
        ),
      ]),
    )
    .orderBy(
      desc(partnerBillingDisputeRequests.createdAt),
      desc(partnerBillingDisputeRequests.id),
    )
    .limit(query.limit + 1);
  const page = buildPartnerManagementPage(rows, query);
  return {
    items: page.items.map((row) => ({
      ...row,
      resolvedAt: iso(row.resolvedAt),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      version: String(row.revision),
    })),
    page: page.page,
  };
}

async function listLocationAddressReviews(query: PartnerManagementListQuery) {
  const search = query.q ? escapedPartnerManagementSearch(query.q) : null;
  const requesterMembership = partnerAccountMemberships;
  const rows = await getDb()
    .select({
      id: partnerLocationAddressReviews.id,
      partnerAccountId: partnerLocationAddressReviews.partnerAccountId,
      accountName: partnerAccounts.name,
      locationId: partnerLocationAddressReviews.locationId,
      siteName: partnerAccountLocations.siteName,
      addressLine1: partnerAccountLocations.addressLine1,
      addressLine2: partnerAccountLocations.addressLine2,
      city: partnerAccountLocations.city,
      stateCode: partnerAccountLocations.state,
      postalCode: partnerAccountLocations.postalCode,
      locationActive: partnerAccountLocations.active,
      addressVerificationStatus:
        partnerAccountLocations.addressVerificationStatus,
      state: partnerLocationAddressReviews.state,
      reasonCode: partnerLocationAddressReviews.reasonCode,
      enteredAddress: partnerLocationAddressReviews.enteredAddress,
      providerSuggestion: partnerLocationAddressReviews.providerSuggestion,
      providerConfidence: partnerLocationAddressReviews.providerConfidence,
      duplicateCandidates: partnerLocationAddressReviews.duplicateCandidates,
      requestedByMembershipId:
        partnerLocationAddressReviews.requestedByMembershipId,
      requesterName: partnerUsers.name,
      requesterEmail: partnerUsers.email,
      reviewedByTeamMemberId:
        partnerLocationAddressReviews.reviewedByTeamMemberId,
      reviewerName: teamMembers.name,
      resolutionNote: partnerLocationAddressReviews.resolutionNote,
      resolvedAt: partnerLocationAddressReviews.resolvedAt,
      revision: partnerLocationAddressReviews.version,
      createdAt: partnerLocationAddressReviews.createdAt,
      updatedAt: partnerLocationAddressReviews.updatedAt,
    })
    .from(partnerLocationAddressReviews)
    .innerJoin(
      partnerAccounts,
      eq(partnerLocationAddressReviews.partnerAccountId, partnerAccounts.id),
    )
    .innerJoin(
      partnerAccountLocations,
      and(
        eq(
          partnerLocationAddressReviews.partnerAccountId,
          partnerAccountLocations.partnerAccountId,
        ),
        eq(
          partnerLocationAddressReviews.locationId,
          partnerAccountLocations.id,
        ),
      ),
    )
    .innerJoin(
      requesterMembership,
      and(
        eq(
          partnerLocationAddressReviews.requestedByMembershipId,
          requesterMembership.id,
        ),
        eq(
          partnerLocationAddressReviews.partnerAccountId,
          requesterMembership.partnerAccountId,
        ),
      ),
    )
    .innerJoin(
      partnerUsers,
      eq(requesterMembership.partnerUserId, partnerUsers.id),
    )
    .leftJoin(
      teamMembers,
      eq(partnerLocationAddressReviews.reviewedByTeamMemberId, teamMembers.id),
    )
    .where(
      where([
        query.accountId
          ? eq(partnerLocationAddressReviews.partnerAccountId, query.accountId)
          : null,
        query.status
          ? eq(
              partnerLocationAddressReviews.state,
              query.status as
                | "pending"
                | "verified"
                | "correction_required"
                | "dismissed",
            )
          : null,
        search
          ? or(
              ilike(partnerAccounts.name, search),
              ilike(partnerAccountLocations.siteName, search),
              ilike(partnerAccountLocations.addressLine1, search),
              ilike(partnerUsers.email, search),
            )
          : null,
        cursorCondition(
          query,
          partnerLocationAddressReviews.createdAt,
          partnerLocationAddressReviews.id,
        ),
      ]),
    )
    .orderBy(
      desc(partnerLocationAddressReviews.createdAt),
      desc(partnerLocationAddressReviews.id),
    )
    .limit(query.limit + 1);
  const page = buildPartnerManagementPage(rows, query);
  return {
    items: page.items.map((row) => ({
      ...row,
      resolvedAt: iso(row.resolvedAt),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      version: String(row.revision),
    })),
    page: page.page,
  };
}

async function listJobChangeRequests(query: PartnerManagementListQuery) {
  const search = query.q ? escapedPartnerManagementSearch(query.q) : null;
  const rows = await getDb()
    .select({
      id: partnerJobChangeRequests.id,
      partnerAccountId: partnerJobChangeRequests.partnerAccountId,
      accountName: partnerAccounts.name,
      partnerBookingId: partnerJobChangeRequests.partnerBookingId,
      jobStatus: partnerBookings.publicStatus,
      state: partnerJobChangeRequests.state,
      reason: partnerJobChangeRequests.reason,
      proposedChanges: partnerJobChangeRequests.proposedChanges,
      requestSnapshot: partnerJobChangeRequests.requestSnapshot,
      requestedByMembershipId: partnerJobChangeRequests.requestedByMembershipId,
      requesterName: partnerUsers.name,
      requesterEmail: partnerUsers.email,
      revision: partnerJobChangeRequests.revision,
      resolvedByTeamMemberId: partnerJobChangeRequests.resolvedByTeamMemberId,
      resolverName: teamMembers.name,
      resolutionReason: partnerJobChangeRequests.resolutionReason,
      resolutionSnapshot: partnerJobChangeRequests.resolutionSnapshot,
      availableChangeOrderQuotes: sql<Array<Record<string, unknown>>>`coalesce((
        select jsonb_agg(candidate.quote_json order by candidate.issued_at desc)
        from (
          select jsonb_build_object(
            'id', projection.id,
            'number', quote.quote_number,
            'version', version.version_number,
            'amountMinor', version.total_min_cents,
            'currency', version.currency,
            'expiresAt', version.expires_at
          ) as quote_json,
          version.issued_at
          from partner_quotes projection
          join quotes quote
            on quote.id = projection.quote_id
           and quote.partner_account_id = projection.partner_account_id
          join quote_versions version
            on version.id = quote.published_version_id
           and version.quote_id = quote.id
          join quote_version_documents proposal
            on proposal.quote_version_id = version.id
           and proposal.kind = 'proposal_pdf'
          where projection.partner_account_id = ${partnerJobChangeRequests.partnerAccountId}
            and projection.partner_booking_id = ${partnerJobChangeRequests.partnerBookingId}
            and projection.authority = 'quote_v2'
            and quote.engine_version = 'v2'
            and quote.aggregate_state = 'open'
            and quote.current_version_id = version.id
            and quote.published_version_id = version.id
            and version.state = 'issued'
            and version.expires_at > now()
            and version.total_min_cents = version.total_max_cents
            and version.total_min_cents > 0
          group by projection.id, quote.quote_number, version.id
          order by version.issued_at desc
          limit 20
        ) candidate
      ), '[]'::jsonb)`,
      resolvedAt: partnerJobChangeRequests.resolvedAt,
      createdAt: partnerJobChangeRequests.createdAt,
      updatedAt: partnerJobChangeRequests.updatedAt,
    })
    .from(partnerJobChangeRequests)
    .innerJoin(
      partnerAccounts,
      eq(partnerJobChangeRequests.partnerAccountId, partnerAccounts.id),
    )
    .innerJoin(
      partnerBookings,
      and(
        eq(
          partnerJobChangeRequests.partnerAccountId,
          partnerBookings.partnerAccountId,
        ),
        eq(partnerJobChangeRequests.partnerBookingId, partnerBookings.id),
      ),
    )
    .innerJoin(
      partnerAccountMemberships,
      and(
        eq(
          partnerJobChangeRequests.requestedByMembershipId,
          partnerAccountMemberships.id,
        ),
        eq(
          partnerJobChangeRequests.partnerAccountId,
          partnerAccountMemberships.partnerAccountId,
        ),
      ),
    )
    .innerJoin(
      partnerUsers,
      eq(partnerAccountMemberships.partnerUserId, partnerUsers.id),
    )
    .leftJoin(
      teamMembers,
      eq(partnerJobChangeRequests.resolvedByTeamMemberId, teamMembers.id),
    )
    .where(
      where([
        query.accountId
          ? eq(partnerJobChangeRequests.partnerAccountId, query.accountId)
          : null,
        query.status
          ? eq(partnerJobChangeRequests.state, query.status as never)
          : null,
        search
          ? or(
              ilike(partnerAccounts.name, search),
              ilike(partnerUsers.name, search),
              ilike(partnerUsers.email, search),
              ilike(partnerJobChangeRequests.reason, search),
              sql`${partnerJobChangeRequests.partnerBookingId}::text ILIKE ${search}`,
            )
          : null,
        cursorCondition(
          query,
          partnerJobChangeRequests.createdAt,
          partnerJobChangeRequests.id,
        ),
      ]),
    )
    .orderBy(
      desc(partnerJobChangeRequests.createdAt),
      desc(partnerJobChangeRequests.id),
    )
    .limit(query.limit + 1);
  const page = buildPartnerManagementPage(rows, query);
  return {
    items: page.items.map((row) => ({
      ...row,
      resolvedAt: iso(row.resolvedAt),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      version: String(row.revision),
    })),
    page: page.page,
  };
}

async function listCommercialReadiness(query: PartnerManagementListQuery) {
  const search = query.q ? escapedPartnerManagementSearch(query.q) : null;
  const now = new Date();
  const totalRateCardCount = sql<number>`(
    select count(*)::integer
    from ${partnerRateCards}
    where ${partnerRateCards.partnerAccountId} = ${partnerAccounts.id}
  )`.mapWith(Number);
  const currentRateCardCount = sql<number>`(
    select count(*)::integer
    from ${partnerRateCards}
    where ${partnerRateCards.partnerAccountId} = ${partnerAccounts.id}
      and ${partnerRateCards.active} is true
      and ${partnerRateCards.effectiveFrom} <= ${now}
      and (${partnerRateCards.effectiveTo} is null or ${partnerRateCards.effectiveTo} > ${now})
  )`.mapWith(Number);
  const currentRateItemCount = sql<number>`(
    select count(*)::integer
    from ${partnerRateItems}
    inner join ${partnerRateCards}
      on ${partnerRateCards.id} = ${partnerRateItems.rateCardId}
    where ${partnerRateCards.partnerAccountId} = ${partnerAccounts.id}
      and ${partnerRateCards.active} is true
      and ${partnerRateCards.effectiveFrom} <= ${now}
      and (${partnerRateCards.effectiveTo} is null or ${partnerRateCards.effectiveTo} > ${now})
  )`.mapWith(Number);
  const currentCurrency = sql<string | null>`(
    select min(${partnerRateCards.currency})
    from ${partnerRateCards}
    where ${partnerRateCards.partnerAccountId} = ${partnerAccounts.id}
      and ${partnerRateCards.active} is true
      and ${partnerRateCards.effectiveFrom} <= ${now}
      and (${partnerRateCards.effectiveTo} is null or ${partnerRateCards.effectiveTo} > ${now})
  )`;
  const versionedRateCardCount = sql<number>`(
    select count(*)::integer
    from ${partnerRateCardVersions}
    where ${partnerRateCardVersions.partnerAccountId} = ${partnerAccounts.id}
  )`.mapWith(Number);
  const activeVersionedRateCardCount = sql<number>`(
    select count(*)::integer
    from ${partnerRateCardVersions}
    where ${partnerRateCardVersions.partnerAccountId} = ${partnerAccounts.id}
      and ${partnerRateCardVersions.status} = 'active'
      and ${partnerRateCardVersions.effectiveFrom} <= ${now}
      and (${partnerRateCardVersions.effectiveTo} is null or ${partnerRateCardVersions.effectiveTo} > ${now})
  )`.mapWith(Number);
  const approvalRuleCount = sql<number>`(
    select count(*)::integer
    from ${partnerApprovalRules}
    where ${partnerApprovalRules.partnerAccountId} = ${partnerAccounts.id}
  )`.mapWith(Number);
  const activeApprovalRuleCount = sql<number>`(
    select count(*)::integer
    from ${partnerApprovalRules}
    where ${partnerApprovalRules.partnerAccountId} = ${partnerAccounts.id}
      and ${partnerApprovalRules.active} is true
  )`.mapWith(Number);
  const pendingApprovalRequestCount = sql<number>`(
    select count(*)::integer
    from ${partnerApprovalRequests}
    where ${partnerApprovalRequests.partnerAccountId} = ${partnerAccounts.id}
      and ${partnerApprovalRequests.state} = 'pending'
  )`.mapWith(Number);
  const quoteCount = sql<number>`(
    select count(*)::integer
    from ${partnerQuotes}
    where ${partnerQuotes.partnerAccountId} = ${partnerAccounts.id}
  )`.mapWith(Number);
  const invoiceCount = sql<number>`(
    select count(*)::integer
    from ${partnerInvoices}
    where ${partnerInvoices.partnerAccountId} = ${partnerAccounts.id}
  )`.mapWith(Number);
  const openInvoiceCount = sql<number>`(
    select count(*)::integer
    from ${partnerInvoices}
    where ${partnerInvoices.partnerAccountId} = ${partnerAccounts.id}
      and ${partnerInvoices.status} in ('issued', 'partially_paid', 'overdue')
      and ${partnerInvoices.balanceCents} > 0
  )`.mapWith(Number);
  const overdueInvoiceCount = sql<number>`(
    select count(*)::integer
    from ${partnerInvoices}
    where ${partnerInvoices.partnerAccountId} = ${partnerAccounts.id}
      and ${partnerInvoices.status} = 'overdue'
      and ${partnerInvoices.balanceCents} > 0
  )`.mapWith(Number);
  const hostedPaymentGapCount = sql<number>`(
    select count(*)::integer
    from ${partnerInvoices}
    where ${partnerInvoices.partnerAccountId} = ${partnerAccounts.id}
      and ${partnerInvoices.status} in ('issued', 'partially_paid', 'overdue')
      and ${partnerInvoices.balanceCents} > 0
      and ${partnerInvoices.hostedPaymentUrl} is null
  )`.mapWith(Number);
  const pendingPaymentAllocationCount = sql<number>`(
    select count(*)::integer
    from ${partnerPaymentAllocations}
    where ${partnerPaymentAllocations.partnerAccountId} = ${partnerAccounts.id}
      and ${partnerPaymentAllocations.state} = 'pending'
  )`.mapWith(Number);
  const invoiceCurrencyCount = sql<number>`(
    select count(distinct ${partnerInvoices.currency})::integer
    from ${partnerInvoices}
    where ${partnerInvoices.partnerAccountId} = ${partnerAccounts.id}
      and ${partnerInvoices.status} <> 'void'
  )`.mapWith(Number);
  const invoiceCurrency = sql<string | null>`(
    select min(${partnerInvoices.currency})
    from ${partnerInvoices}
    where ${partnerInvoices.partnerAccountId} = ${partnerAccounts.id}
      and ${partnerInvoices.status} <> 'void'
  )`;
  const outstandingBalanceCents = sql<string>`(
    select coalesce(sum(${partnerInvoices.balanceCents}), 0)::text
    from ${partnerInvoices}
    where ${partnerInvoices.partnerAccountId} = ${partnerAccounts.id}
      and ${partnerInvoices.status} <> 'void'
  )`;
  const hasAnyCommercialRecord = sql<boolean>`(
    (${totalRateCardCount}) > 0
    or (${versionedRateCardCount}) > 0
    or (${approvalRuleCount}) > 0
    or (${quoteCount}) > 0
    or (${invoiceCount}) > 0
  )`;
  const statusExpression = sql<
    "ready" | "attention_required" | "unconfigured"
  >`case
    when ${partnerAccounts.portalAccessEnabled} is true
      and (${currentRateCardCount}) = 1
      and (${currentRateItemCount}) > 0
      and (${hostedPaymentGapCount}) = 0
      and (${invoiceCurrencyCount}) <= 1
      then 'ready'
    when not (${hasAnyCommercialRecord}) then 'unconfigured'
    else 'attention_required'
  end`;

  const rows = await getDb()
    .select({
      id: partnerAccounts.id,
      accountName: partnerAccounts.name,
      domain: partnerAccounts.domain,
      accountStatus: partnerAccounts.status,
      portalAccessEnabled: partnerAccounts.portalAccessEnabled,
      status: statusExpression,
      pricingCurrency: currentCurrency,
      totalRateCardCount,
      currentRateCardCount,
      currentRateItemCount,
      versionedRateCardCount,
      activeVersionedRateCardCount,
      approvalRuleCount,
      activeApprovalRuleCount,
      pendingApprovalRequestCount,
      quoteCount,
      invoiceCount,
      openInvoiceCount,
      overdueInvoiceCount,
      hostedPaymentGapCount,
      pendingPaymentAllocationCount,
      invoiceCurrencyCount,
      invoiceCurrency,
      outstandingBalanceCents,
      createdAt: partnerAccounts.createdAt,
      updatedAt: partnerAccounts.updatedAt,
    })
    .from(partnerAccounts)
    .where(
      where([
        query.accountId ? eq(partnerAccounts.id, query.accountId) : null,
        query.status ? sql`${statusExpression} = ${query.status}` : null,
        search
          ? or(
              ilike(partnerAccounts.name, search),
              ilike(partnerAccounts.domain, search),
            )
          : null,
        cursorCondition(query, partnerAccounts.createdAt, partnerAccounts.id),
      ]),
    )
    .orderBy(desc(partnerAccounts.createdAt), desc(partnerAccounts.id))
    .limit(query.limit + 1);
  const page = buildPartnerManagementPage(rows, query);
  return {
    items: page.items.map((row) => {
      const safeBalance = /^(0|[1-9][0-9]*)$/u.test(row.outstandingBalanceCents)
        ? Number(row.outstandingBalanceCents)
        : Number.NaN;
      const readinessIssues: string[] = [];
      if (!row.portalAccessEnabled) {
        readinessIssues.push("portal_access_disabled");
      }
      if (row.totalRateCardCount === 0) {
        readinessIssues.push("operational_rate_card_missing");
      } else if (row.currentRateCardCount === 0) {
        readinessIssues.push("operational_rate_card_not_current");
      } else if (row.currentRateCardCount > 1) {
        readinessIssues.push("overlapping_operational_rate_cards");
      }
      if (row.currentRateCardCount > 0 && row.currentRateItemCount === 0) {
        readinessIssues.push("operational_rate_items_missing");
      }
      if (row.activeVersionedRateCardCount > 1) {
        readinessIssues.push("overlapping_versioned_rate_cards");
      }
      if (row.hostedPaymentGapCount > 0) {
        readinessIssues.push("open_invoice_hosted_payment_gap");
      }
      if (row.invoiceCurrencyCount > 1) {
        readinessIssues.push("mixed_invoice_currencies");
      }
      if (!Number.isSafeInteger(safeBalance)) {
        readinessIssues.push("balance_exceeds_safe_display_range");
      }
      return {
        ...row,
        outstandingBalanceCents:
          row.invoiceCurrencyCount <= 1 && Number.isSafeInteger(safeBalance)
            ? safeBalance
            : null,
        approvalPolicyState:
          row.activeApprovalRuleCount > 0 ? "configured" : "none",
        billingConfigurationState: "not_modeled",
        providerWriteAvailable: false,
        readinessIssues,
        version: row.updatedAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    }),
    page: page.page,
  };
}

async function listPeople(query: PartnerManagementListQuery) {
  const search = query.q ? escapedPartnerManagementSearch(query.q) : null;
  const rows = await getDb()
    .select({
      id: partnerUsers.id,
      name: partnerUsers.name,
      email: partnerUsers.email,
      phone: partnerUsers.phoneE164,
      active: partnerUsers.active,
      passwordSetAt: partnerUsers.passwordSetAt,
      mfaRequired: partnerUsers.mfaRequired,
      mfaEnrolledAt: partnerUsers.mfaEnrolledAt,
      securityVersion: partnerUsers.securityVersion,
      createdAt: partnerUsers.createdAt,
      updatedAt: partnerUsers.updatedAt,
    })
    .from(partnerUsers)
    .where(
      where([
        query.status
          ? eq(partnerUsers.identityStatus, query.status as never)
          : null,
        query.userId ? eq(partnerUsers.id, query.userId) : null,
        search
          ? or(
              ilike(partnerUsers.name, search),
              ilike(partnerUsers.email, search),
              ilike(partnerUsers.phoneE164, search),
            )
          : null,
        cursorCondition(query, partnerUsers.createdAt, partnerUsers.id),
      ]),
    )
    .orderBy(desc(partnerUsers.createdAt), desc(partnerUsers.id))
    .limit(query.limit + 1);
  const page = buildPartnerManagementPage(rows, query);
  return {
    items: page.items.map((row) => ({
      ...row,
      passwordSetAt: iso(row.passwordSetAt),
      mfaEnrolledAt: iso(row.mfaEnrolledAt),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
    page: page.page,
  };
}

function partnerSessionStatusCondition(
  status: string | null,
  now: Date,
): SQL | null {
  switch (status) {
    case "active":
      return and(
        isNull(partnerSessions.revokedAt),
        gt(partnerSessions.expiresAt, now),
      )!;
    case "expired":
      return and(
        isNull(partnerSessions.revokedAt),
        lte(partnerSessions.expiresAt, now),
      )!;
    case "revoked":
      return isNotNull(partnerSessions.revokedAt);
    default:
      return null;
  }
}

async function listSecuritySessions(query: PartnerManagementListQuery) {
  const search = query.q ? escapedPartnerManagementSearch(query.q) : null;
  const now = new Date();
  const rows = await getDb()
    .select({
      id: partnerSessions.id,
      partnerUserId: partnerSessions.partnerUserId,
      personName: partnerUsers.name,
      personEmail: partnerUsers.email,
      identityStatus: partnerUsers.identityStatus,
      activePartnerAccountId: partnerSessions.activePartnerAccountId,
      accountName: partnerAccounts.name,
      accountStatus: partnerAccounts.status,
      activeMembershipId: partnerSessions.activeMembershipId,
      membershipStatus: partnerAccountMemberships.status,
      roleKey: partnerAccountMemberships.roleKey,
      authMethod: partnerSessions.authMethod,
      assuranceLevel: partnerSessions.assuranceLevel,
      mfaVerifiedAt: partnerSessions.mfaVerifiedAt,
      deviceName: partnerSessions.deviceName,
      accountSelectedAt: partnerSessions.accountSelectedAt,
      expiresAt: partnerSessions.expiresAt,
      revokedAt: partnerSessions.revokedAt,
      createdAt: partnerSessions.createdAt,
      lastSeenAt: partnerSessions.lastSeenAt,
      status: sql<"active" | "expired" | "revoked">`
        CASE
          WHEN ${partnerSessions.revokedAt} IS NOT NULL THEN 'revoked'
          WHEN ${partnerSessions.expiresAt} <= ${now} THEN 'expired'
          ELSE 'active'
        END
      `,
    })
    .from(partnerSessions)
    .innerJoin(partnerUsers, eq(partnerSessions.partnerUserId, partnerUsers.id))
    .leftJoin(
      partnerAccountMemberships,
      and(
        eq(partnerSessions.activeMembershipId, partnerAccountMemberships.id),
        eq(
          partnerSessions.activePartnerAccountId,
          partnerAccountMemberships.partnerAccountId,
        ),
        eq(
          partnerSessions.partnerUserId,
          partnerAccountMemberships.partnerUserId,
        ),
      ),
    )
    .leftJoin(
      partnerAccounts,
      eq(partnerSessions.activePartnerAccountId, partnerAccounts.id),
    )
    .where(
      where([
        query.accountId
          ? eq(partnerSessions.activePartnerAccountId, query.accountId)
          : null,
        query.userId ? eq(partnerSessions.partnerUserId, query.userId) : null,
        partnerSessionStatusCondition(query.status, now),
        search
          ? or(
              ilike(partnerUsers.name, search),
              ilike(partnerUsers.email, search),
              ilike(partnerAccounts.name, search),
              ilike(partnerSessions.deviceName, search),
            )
          : null,
        cursorCondition(query, partnerSessions.createdAt, partnerSessions.id),
      ]),
    )
    .orderBy(desc(partnerSessions.createdAt), desc(partnerSessions.id))
    .limit(query.limit + 1);
  const page = buildPartnerManagementPage(rows, query);
  return {
    items: page.items.map((row) => ({
      ...row,
      mfaVerifiedAt: iso(row.mfaVerifiedAt),
      accountSelectedAt: iso(row.accountSelectedAt),
      expiresAt: row.expiresAt.toISOString(),
      revokedAt: iso(row.revokedAt),
      createdAt: row.createdAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
      version: row.lastSeenAt.toISOString(),
    })),
    page: page.page,
  };
}

type PartnerQuarantineDirectoryItem = {
  id: string;
  sourceId: string;
  caseKind:
    | "identity"
    | "membership_migration"
    | "invite_delivery"
    | "cancellation_review";
  status: "contained" | "reconciliation_required" | "resolved";
  riskLevel: "critical" | "high";
  title: string;
  subjectName: string;
  subjectEmail: string;
  partnerUserId: string;
  partnerAccountId: string | null;
  accountName: string | null;
  reasonCode: string;
  reason: string;
  history: Array<{ event: string; at: string }>;
  resolutionAvailable: boolean;
  requestedChannels: string[];
  providerOperationIds: string[];
  acceptedProviderEvidencePresent: boolean;
  resolution: string | null;
  version: string;
  createdAt: Date;
  recordCreatedAt: string;
  updatedAt: string;
};

function quarantineCaseIsAfterCursor(
  item: PartnerQuarantineDirectoryItem,
  query: PartnerManagementListQuery,
): boolean {
  if (!query.cursor) return true;
  const itemTime = item.createdAt.getTime();
  const cursorTime = new Date(query.cursor.createdAt).getTime();
  return (
    itemTime < cursorTime ||
    (itemTime === cursorTime &&
      item.sourceId.localeCompare(query.cursor.id) < 0)
  );
}

async function listQuarantineCases(query: PartnerManagementListQuery) {
  const search = query.q ? escapedPartnerManagementSearch(query.q) : null;
  const includeContained = !query.status || query.status === "contained";
  const includeInviteCases = !query.accountId;
  const identityPromise =
    includeContained && !query.accountId
      ? getDb()
          .select({
            id: partnerUsers.id,
            name: partnerUsers.name,
            email: partnerUsers.email,
            createdAt: partnerUsers.createdAt,
            updatedAt: partnerUsers.updatedAt,
          })
          .from(partnerUsers)
          .where(
            where([
              eq(partnerUsers.identityStatus, "quarantined"),
              query.userId ? eq(partnerUsers.id, query.userId) : null,
              search
                ? or(
                    ilike(partnerUsers.name, search),
                    ilike(partnerUsers.email, search),
                  )
                : null,
              cursorCondition(query, partnerUsers.updatedAt, partnerUsers.id),
            ]),
          )
          .orderBy(desc(partnerUsers.updatedAt), desc(partnerUsers.id))
          .limit(query.limit + 1)
      : Promise.resolve([]);
  const membershipPromise = includeContained
    ? getDb()
        .select({
          id: partnerAccountMemberships.id,
          partnerAccountId: partnerAccountMemberships.partnerAccountId,
          accountName: partnerAccounts.name,
          partnerUserId: partnerAccountMemberships.partnerUserId,
          personName: partnerUsers.name,
          personEmail: partnerUsers.email,
          roleKey: partnerAccountMemberships.roleKey,
          membershipStatus: partnerAccountMemberships.status,
          migrationLegacyRoleKey:
            partnerAccountMemberships.migrationLegacyRoleKey,
          reviewNote: partnerAccountMemberships.migrationReviewNote,
          reviewedAt: partnerAccountMemberships.migrationReviewedAt,
          createdAt: partnerAccountMemberships.createdAt,
          updatedAt: partnerAccountMemberships.updatedAt,
        })
        .from(partnerAccountMemberships)
        .innerJoin(
          partnerAccounts,
          eq(partnerAccountMemberships.partnerAccountId, partnerAccounts.id),
        )
        .innerJoin(
          partnerUsers,
          eq(partnerAccountMemberships.partnerUserId, partnerUsers.id),
        )
        .where(
          where([
            eq(partnerAccountMemberships.migrationReviewStatus, "quarantined"),
            query.accountId
              ? eq(partnerAccountMemberships.partnerAccountId, query.accountId)
              : null,
            query.userId
              ? eq(partnerAccountMemberships.partnerUserId, query.userId)
              : null,
            search
              ? or(
                  ilike(partnerAccounts.name, search),
                  ilike(partnerUsers.name, search),
                  ilike(partnerUsers.email, search),
                  ilike(partnerAccountMemberships.roleKey, search),
                  ilike(partnerAccountMemberships.migrationReviewNote, search),
                )
              : null,
            cursorCondition(
              query,
              partnerAccountMemberships.updatedAt,
              partnerAccountMemberships.id,
            ),
          ]),
        )
        .orderBy(
          desc(partnerAccountMemberships.updatedAt),
          desc(partnerAccountMemberships.id),
        )
        .limit(query.limit + 1)
    : Promise.resolve([]);
  const invitePromise = includeInviteCases
    ? getDb()
        .select({
          id: partnerInviteOperations.id,
          partnerUserId: partnerInviteOperations.partnerUserId,
          personName: partnerUsers.name,
          personEmail: partnerUsers.email,
          operationKind: partnerInviteOperations.operationKind,
          requestedChannels: partnerInviteOperations.requestedChannels,
          state: partnerInviteOperations.state,
          version: partnerInviteOperations.version,
          providerOperationIds: partnerInviteOperations.providerOperationIds,
          providerEvidence: partnerInviteOperations.providerEvidence,
          failureCode: partnerInviteOperations.failureCode,
          quarantineReason: partnerInviteOperations.quarantineReason,
          requestedAt: partnerInviteOperations.requestedAt,
          dispatchedAt: partnerInviteOperations.dispatchedAt,
          completedAt: partnerInviteOperations.completedAt,
          quarantinedAt: partnerInviteOperations.quarantinedAt,
          reconciliationRequiredAt:
            partnerInviteOperations.reconciliationRequiredAt,
          resolution: partnerInviteOperations.resolution,
          resolutionEvidence: partnerInviteOperations.resolutionEvidence,
          resolvedAt: partnerInviteOperations.resolvedAt,
          createdAt: partnerInviteOperations.createdAt,
          updatedAt: partnerInviteOperations.updatedAt,
        })
        .from(partnerInviteOperations)
        .innerJoin(
          partnerUsers,
          eq(partnerInviteOperations.partnerUserId, partnerUsers.id),
        )
        .where(
          where([
            query.status === "contained"
              ? isNotNull(partnerInviteOperations.quarantinedAt)
              : query.status === "reconciliation_required"
                ? and(
                    eq(
                      partnerInviteOperations.state,
                      "reconciliation_required",
                    ),
                    isNull(partnerInviteOperations.resolvedAt),
                  )
                : query.status === "resolved"
                  ? and(
                      eq(
                        partnerInviteOperations.state,
                        "reconciliation_required",
                      ),
                      isNotNull(partnerInviteOperations.resolvedAt),
                    )
                  : or(
                      isNotNull(partnerInviteOperations.quarantinedAt),
                      eq(
                        partnerInviteOperations.state,
                        "reconciliation_required",
                      ),
                    ),
            query.userId
              ? eq(partnerInviteOperations.partnerUserId, query.userId)
              : null,
            search
              ? or(
                  ilike(partnerUsers.name, search),
                  ilike(partnerUsers.email, search),
                  ilike(partnerInviteOperations.operationKind, search),
                  ilike(partnerInviteOperations.failureCode, search),
                  ilike(partnerInviteOperations.quarantineReason, search),
                )
              : null,
            cursorCondition(
              query,
              partnerInviteOperations.updatedAt,
              partnerInviteOperations.id,
            ),
          ]),
        )
        .orderBy(
          desc(partnerInviteOperations.updatedAt),
          desc(partnerInviteOperations.id),
        )
        .limit(query.limit + 1)
    : Promise.resolve([]);

  const cancellationReviewPromise =
    (!query.status || query.status === "reconciliation_required") &&
    !query.userId
      ? getDb()
          .select({
            id: partnerCancellationRequestReconciliationCases.id,
            partnerAccountId:
              partnerCancellationRequestReconciliationCases.partnerAccountId,
            partnerBookingId:
              partnerCancellationRequestReconciliationCases.partnerBookingId,
            accountName: partnerAccounts.name,
            reasonCode:
              partnerCancellationRequestReconciliationCases.reasonCode,
            evidenceSnapshot:
              partnerCancellationRequestReconciliationCases.evidenceSnapshot,
            createdAt: partnerCancellationRequestReconciliationCases.createdAt,
          })
          .from(partnerCancellationRequestReconciliationCases)
          .leftJoin(
            partnerAccounts,
            eq(
              partnerCancellationRequestReconciliationCases.partnerAccountId,
              partnerAccounts.id,
            ),
          )
          .where(
            where([
              query.accountId
                ? eq(
                    partnerCancellationRequestReconciliationCases.partnerAccountId,
                    query.accountId,
                  )
                : null,
              search
                ? or(
                    ilike(partnerAccounts.name, search),
                    ilike(
                      partnerCancellationRequestReconciliationCases.reasonCode,
                      search,
                    ),
                    sql`${partnerCancellationRequestReconciliationCases.partnerBookingId}::text ILIKE ${search}`,
                  )
                : null,
              cursorCondition(
                query,
                partnerCancellationRequestReconciliationCases.createdAt,
                partnerCancellationRequestReconciliationCases.id,
              ),
            ]),
          )
          .orderBy(
            desc(partnerCancellationRequestReconciliationCases.createdAt),
            desc(partnerCancellationRequestReconciliationCases.id),
          )
          .limit(query.limit + 1)
      : Promise.resolve([]);

  const [identities, memberships, invites, cancellationReviewCases] =
    await Promise.all([
      identityPromise,
      membershipPromise,
      invitePromise,
      cancellationReviewPromise,
    ]);
  const items: PartnerQuarantineDirectoryItem[] = [
    ...identities.map((row) => ({
      id: partnerQuarantineCaseId("identity", row.id),
      sourceId: row.id,
      caseKind: "identity" as const,
      status: "contained" as const,
      riskLevel: "critical" as const,
      title: "Quarantined partner identity",
      subjectName: row.name,
      subjectEmail: row.email,
      partnerUserId: row.id,
      partnerAccountId: null,
      accountName: null,
      reasonCode: "identity_status_quarantined",
      reason:
        "Global identity access is contained. The current schema has no reversible quarantine-release receipt, so email and tenant ownership must be reconciled before a separate owner-directed repair.",
      history: [
        { event: "Identity created", at: row.createdAt.toISOString() },
        {
          event: "Containment last updated",
          at: row.updatedAt.toISOString(),
        },
      ],
      resolutionAvailable: false,
      requestedChannels: [],
      providerOperationIds: [],
      acceptedProviderEvidencePresent: false,
      resolution: null,
      version: row.updatedAt.toISOString(),
      createdAt: row.updatedAt,
      recordCreatedAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
    ...memberships.map((row) => ({
      id: partnerQuarantineCaseId("membership_migration", row.id),
      sourceId: row.id,
      caseKind: "membership_migration" as const,
      status: "contained" as const,
      riskLevel: "high" as const,
      title: "Quarantined migrated membership",
      subjectName: row.personName,
      subjectEmail: row.personEmail,
      partnerUserId: row.partnerUserId,
      partnerAccountId: row.partnerAccountId,
      accountName: row.accountName,
      reasonCode: "migration_membership_quarantined",
      reason: boundedPartnerQuarantineText(
        row.reviewNote,
        `The migrated ${row.migrationLegacyRoleKey ?? row.roleKey} access was quarantined during review. Its ${row.membershipStatus} company membership remains contained.`,
      ),
      history: [
        { event: "Membership created", at: row.createdAt.toISOString() },
        ...(row.reviewedAt
          ? [
              {
                event: "Migration review quarantined access",
                at: row.reviewedAt.toISOString(),
              },
            ]
          : []),
        { event: "Record last updated", at: row.updatedAt.toISOString() },
      ],
      resolutionAvailable: false,
      requestedChannels: [],
      providerOperationIds: [],
      acceptedProviderEvidencePresent: false,
      resolution: null,
      version: row.updatedAt.toISOString(),
      createdAt: row.updatedAt,
      recordCreatedAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
    ...invites.map((row) => {
      const status = row.resolvedAt
        ? ("resolved" as const)
        : row.state === "reconciliation_required"
          ? ("reconciliation_required" as const)
          : ("contained" as const);
      const resolutionAvailable = status === "reconciliation_required";
      const reasonCode =
        row.quarantineReason ??
        row.failureCode ??
        (status === "resolved"
          ? "provider_delivery_reconciled"
          : "provider_delivery_uncertain");
      const reason =
        status === "resolved"
          ? boundedPartnerQuarantineText(
              row.resolutionEvidence,
              "A Team Owner recorded conclusive provider evidence and released the duplicate-send guard.",
            )
          : status === "reconciliation_required"
            ? "Provider delivery may have been accepted. Review every requested channel against conclusive provider records; never resend automatically."
            : `The ${row.operationKind.replace(/_/gu, " ")} operation is durably quarantined and has no reversible release lifecycle.`;
      return {
        id: partnerQuarantineCaseId("invite_delivery", row.id),
        sourceId: row.id,
        caseKind: "invite_delivery" as const,
        status,
        riskLevel: "high" as const,
        title:
          row.operationKind === "public_login_link"
            ? "Legacy access-link delivery anomaly"
            : "Legacy partner invitation delivery anomaly",
        subjectName: row.personName,
        subjectEmail: row.personEmail,
        partnerUserId: row.partnerUserId,
        partnerAccountId: null,
        accountName: null,
        reasonCode,
        reason,
        history: [
          { event: "Delivery requested", at: row.requestedAt.toISOString() },
          ...(row.dispatchedAt
            ? [
                {
                  event: "Provider dispatch attempted",
                  at: row.dispatchedAt.toISOString(),
                },
              ]
            : []),
          ...(row.completedAt
            ? [
                {
                  event: "Attempt became terminal",
                  at: row.completedAt.toISOString(),
                },
              ]
            : []),
          ...(row.quarantinedAt
            ? [
                {
                  event: "Operation quarantined",
                  at: row.quarantinedAt.toISOString(),
                },
              ]
            : []),
          ...(row.reconciliationRequiredAt
            ? [
                {
                  event: "Provider reconciliation required",
                  at: row.reconciliationRequiredAt.toISOString(),
                },
              ]
            : []),
          ...(row.resolvedAt
            ? [
                {
                  event: `Resolved as ${row.resolution?.replace(/_/gu, " ") ?? "reviewed"}`,
                  at: row.resolvedAt.toISOString(),
                },
              ]
            : []),
        ],
        resolutionAvailable,
        requestedChannels: [...row.requestedChannels],
        providerOperationIds: [...row.providerOperationIds],
        acceptedProviderEvidencePresent:
          hasAcceptedPartnerInviteProviderEvidence(row.providerEvidence),
        resolution: row.resolution,
        version: String(row.version),
        createdAt: row.updatedAt,
        recordCreatedAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    }),
    ...cancellationReviewCases.map((row) => ({
      id: partnerQuarantineCaseId("cancellation_review", row.id),
      sourceId: row.id,
      caseKind: "cancellation_review" as const,
      status: "reconciliation_required" as const,
      riskLevel: "high" as const,
      title: "Legacy cancellation review requires reconciliation",
      subjectName: `Partner job ${row.partnerBookingId.slice(0, 8).toUpperCase()}`,
      subjectEmail: "",
      partnerUserId: "",
      partnerAccountId: row.partnerAccountId,
      accountName: row.accountName,
      reasonCode: row.reasonCode,
      reason:
        "This pre-0149 cancellation review had only hash/event evidence. It is quarantined and cannot be approved or declined until Stonegate explicitly reconciles the original request.",
      history: [
        {
          event: "Legacy review evidence quarantined",
          at: row.createdAt.toISOString(),
        },
      ],
      resolutionAvailable: false,
      requestedChannels: [],
      providerOperationIds: [],
      acceptedProviderEvidencePresent: false,
      resolution: null,
      version: row.createdAt.toISOString(),
      createdAt: row.createdAt,
      recordCreatedAt: row.createdAt.toISOString(),
      updatedAt: row.createdAt.toISOString(),
    })),
  ]
    .filter((item) => quarantineCaseIsAfterCursor(item, query))
    .sort(
      (left, right) =>
        right.createdAt.getTime() - left.createdAt.getTime() ||
        right.sourceId.localeCompare(left.sourceId),
    );
  // Quarantine case IDs are type-bound opaque identifiers. Pagination uses the
  // backing UUID strictly as a cursor tie-breaker so batched rows sharing an
  // update timestamp cannot be skipped between heterogeneous source tables.
  const page = buildPartnerManagementPage(
    items.map((item) => ({ ...item, caseId: item.id, id: item.sourceId })),
    query,
  );
  return {
    items: page.items.map(({ caseId, ...item }) => ({
      ...item,
      id: caseId,
      createdAt: item.createdAt.toISOString(),
    })),
    page: page.page,
  };
}

async function listDomains(query: PartnerManagementListQuery) {
  const search = query.q ? escapedPartnerManagementSearch(query.q) : null;
  const rows = await getDb()
    .select({
      id: partnerAccountDomains.id,
      partnerAccountId: partnerAccountDomains.partnerAccountId,
      accountName: partnerAccounts.name,
      normalizedDomain: partnerAccountDomains.normalizedDomain,
      status: partnerAccountDomains.status,
      verificationMethod: partnerAccountDomains.verificationMethod,
      verificationEvidencePresent: sql<boolean>`${partnerAccountDomains.verificationEvidence} IS NOT NULL`,
      verifiedByTeamMemberId: partnerAccountDomains.verifiedByTeamMemberId,
      verifiedAt: partnerAccountDomains.verifiedAt,
      revokedByTeamMemberId: partnerAccountDomains.revokedByTeamMemberId,
      revokedAt: partnerAccountDomains.revokedAt,
      createdAt: partnerAccountDomains.createdAt,
      updatedAt: partnerAccountDomains.updatedAt,
    })
    .from(partnerAccountDomains)
    .innerJoin(
      partnerAccounts,
      eq(partnerAccountDomains.partnerAccountId, partnerAccounts.id),
    )
    .where(
      where([
        query.accountId
          ? eq(partnerAccountDomains.partnerAccountId, query.accountId)
          : null,
        query.status
          ? eq(partnerAccountDomains.status, query.status as never)
          : null,
        search
          ? or(
              ilike(partnerAccountDomains.normalizedDomain, search),
              ilike(partnerAccounts.name, search),
            )
          : null,
        cursorCondition(
          query,
          partnerAccountDomains.createdAt,
          partnerAccountDomains.id,
        ),
      ]),
    )
    .orderBy(
      desc(partnerAccountDomains.createdAt),
      desc(partnerAccountDomains.id),
    )
    .limit(query.limit + 1);
  const page = buildPartnerManagementPage(rows, query);
  return {
    items: page.items.map((row) => ({
      ...row,
      verifiedAt: iso(row.verifiedAt),
      revokedAt: iso(row.revokedAt),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      version: row.updatedAt.toISOString(),
    })),
    page: page.page,
  };
}

async function listMemberships(query: PartnerManagementListQuery) {
  const search = query.q ? escapedPartnerManagementSearch(query.q) : null;
  const rows = await getDb()
    .select({
      id: partnerAccountMemberships.id,
      partnerAccountId: partnerAccountMemberships.partnerAccountId,
      accountName: partnerAccounts.name,
      partnerUserId: partnerAccountMemberships.partnerUserId,
      personName: partnerUsers.name,
      personEmail: partnerUsers.email,
      identityActive: partnerUsers.active,
      identityStatus: partnerUsers.identityStatus,
      passwordSetAt: partnerUsers.passwordSetAt,
      mfaEnrolledAt: partnerUsers.mfaEnrolledAt,
      roleKey: partnerAccountMemberships.roleKey,
      status: partnerAccountMemberships.status,
      persona: partnerAccountMemberships.persona,
      accessLevel: partnerAccountMemberships.accessLevel,
      accessScope: partnerAccountMemberships.accessScope,
      capabilityGrants: partnerAccountMemberships.capabilityGrants,
      capabilityDenies: partnerAccountMemberships.capabilityDenies,
      isDefault: partnerAccountMemberships.isDefault,
      migrationReviewStatus: partnerAccountMemberships.migrationReviewStatus,
      migrationLegacyRoleKey: partnerAccountMemberships.migrationLegacyRoleKey,
      migrationReviewedAt: partnerAccountMemberships.migrationReviewedAt,
      acceptedAt: partnerAccountMemberships.acceptedAt,
      suspendedAt: partnerAccountMemberships.suspendedAt,
      removedAt: partnerAccountMemberships.removedAt,
      accountPortalAccessEnabled: partnerAccounts.portalAccessEnabled,
      accountPortalLifecycleStatus: partnerAccounts.portalLifecycleStatus,
      activeAdministratorCount: sql<number>`(
        SELECT count(*)::integer
        FROM ${partnerAccountMemberships} AS administrator_membership
        INNER JOIN ${partnerUsers} AS administrator_user
          ON administrator_user."id" = administrator_membership."partner_user_id"
        WHERE administrator_membership."partner_account_id" = ${partnerAccounts.id}
          AND administrator_membership."role_key" = 'administrator'
          AND administrator_membership."status" = 'active'
          AND administrator_user."identity_status" = 'active'
          AND administrator_user."active" IS true
      )`.mapWith(Number),
      createdAt: partnerAccountMemberships.createdAt,
      updatedAt: partnerAccountMemberships.updatedAt,
    })
    .from(partnerAccountMemberships)
    .innerJoin(
      partnerAccounts,
      eq(partnerAccountMemberships.partnerAccountId, partnerAccounts.id),
    )
    .innerJoin(
      partnerUsers,
      eq(partnerAccountMemberships.partnerUserId, partnerUsers.id),
    )
    .where(
      where([
        query.accountId
          ? eq(partnerAccountMemberships.partnerAccountId, query.accountId)
          : null,
        query.userId
          ? eq(partnerAccountMemberships.partnerUserId, query.userId)
          : null,
        query.status
          ? eq(partnerAccountMemberships.status, query.status as never)
          : null,
        search
          ? or(
              ilike(partnerAccounts.name, search),
              ilike(partnerUsers.name, search),
              ilike(partnerUsers.email, search),
              ilike(partnerAccountMemberships.roleKey, search),
            )
          : null,
        cursorCondition(
          query,
          partnerAccountMemberships.createdAt,
          partnerAccountMemberships.id,
        ),
      ]),
    )
    .orderBy(
      desc(partnerAccountMemberships.createdAt),
      desc(partnerAccountMemberships.id),
    )
    .limit(query.limit + 1);
  const page = buildPartnerManagementPage(rows, query);
  return {
    items: page.items.map((row) => ({
      ...row,
      acceptedAt: iso(row.acceptedAt),
      suspendedAt: iso(row.suspendedAt),
      removedAt: iso(row.removedAt),
      passwordSetAt: iso(row.passwordSetAt),
      mfaEnrolledAt: iso(row.mfaEnrolledAt),
      migrationReviewedAt: iso(row.migrationReviewedAt),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      version: row.updatedAt.toISOString(),
    })),
    page: page.page,
  };
}

async function listInvitations(query: PartnerManagementListQuery) {
  const search = query.q ? escapedPartnerManagementSearch(query.q) : null;
  const rows = await getDb()
    .select({
      id: partnerAccountInvitations.id,
      partnerAccountId: partnerAccountInvitations.partnerAccountId,
      accountName: partnerAccounts.name,
      email: partnerAccountInvitations.email,
      inviteeName: partnerAccountInvitations.inviteeName,
      roleKey: partnerAccountInvitations.roleKey,
      roleTemplateVersion: partnerAccountInvitations.roleTemplateVersion,
      persona: partnerAccountInvitations.persona,
      status: partnerAccountInvitations.status,
      deliveryStatus: partnerAccountInvitations.deliveryStatus,
      expiresAt: partnerAccountInvitations.expiresAt,
      sentAt: partnerAccountInvitations.sentAt,
      acceptedAt: partnerAccountInvitations.acceptedAt,
      revokedAt: partnerAccountInvitations.revokedAt,
      expiredAt: partnerAccountInvitations.expiredAt,
      createdAt: partnerAccountInvitations.createdAt,
      updatedAt: partnerAccountInvitations.updatedAt,
    })
    .from(partnerAccountInvitations)
    .innerJoin(
      partnerAccounts,
      eq(partnerAccountInvitations.partnerAccountId, partnerAccounts.id),
    )
    .where(
      where([
        query.accountId
          ? eq(partnerAccountInvitations.partnerAccountId, query.accountId)
          : null,
        query.status
          ? eq(partnerAccountInvitations.status, query.status as never)
          : null,
        search
          ? or(
              ilike(partnerAccounts.name, search),
              ilike(partnerAccountInvitations.inviteeName, search),
              ilike(partnerAccountInvitations.email, search),
            )
          : null,
        cursorCondition(
          query,
          partnerAccountInvitations.createdAt,
          partnerAccountInvitations.id,
        ),
      ]),
    )
    .orderBy(
      desc(partnerAccountInvitations.createdAt),
      desc(partnerAccountInvitations.id),
    )
    .limit(query.limit + 1);
  const page = buildPartnerManagementPage(rows, query);
  return {
    items: page.items.map((row) => ({
      ...row,
      expiresAt: row.expiresAt.toISOString(),
      sentAt: iso(row.sentAt),
      acceptedAt: iso(row.acceptedAt),
      revokedAt: iso(row.revokedAt),
      expiredAt: iso(row.expiredAt),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
    page: page.page,
  };
}

async function listApplications(query: PartnerManagementListQuery) {
  const search = query.q ? escapedPartnerManagementSearch(query.q) : null;
  const rows = await getDb()
    .select({
      id: partnerAccessApplications.id,
      status: partnerAccessApplications.status,
      version: partnerAccessApplications.version,
      applicantPartnerUserId: partnerAccessApplications.applicantPartnerUserId,
      bootstrapPartnerAccountId:
        partnerAccessApplications.bootstrapPartnerAccountId,
      approvedPartnerAccountId:
        partnerAccessApplications.approvedPartnerAccountId,
      name: partnerAccessApplications.name,
      email: partnerAccessApplications.email,
      phone: partnerAccessApplications.phoneE164,
      companyName: partnerAccessApplications.companyName,
      website: partnerAccessApplications.website,
      partnerType: partnerAccessApplications.partnerType,
      flowVersion: partnerAccessApplications.flowVersion,
      companyResolutionChoice:
        partnerAccessApplications.companyResolutionChoice,
      requestedPartnerAccountId:
        partnerAccessApplications.requestedPartnerAccountId,
      serviceAreas: partnerAccessApplications.serviceAreas,
      requestedNeeds: partnerAccessApplications.requestedNeeds,
      emailVerifiedAt: partnerAccessApplications.emailVerifiedAt,
      submittedAt: partnerAccessApplications.submittedAt,
      reviewedAt: partnerAccessApplications.reviewedAt,
      reviewNote: partnerAccessApplications.reviewNote,
      createdAt: partnerAccessApplications.createdAt,
      updatedAt: partnerAccessApplications.updatedAt,
    })
    .from(partnerAccessApplications)
    .where(
      where([
        query.accountId
          ? or(
              eq(
                partnerAccessApplications.bootstrapPartnerAccountId,
                query.accountId,
              ),
              eq(
                partnerAccessApplications.approvedPartnerAccountId,
                query.accountId,
              ),
            )
          : null,
        query.userId
          ? eq(partnerAccessApplications.applicantPartnerUserId, query.userId)
          : null,
        query.status
          ? eq(partnerAccessApplications.status, query.status as never)
          : null,
        search
          ? or(
              ilike(partnerAccessApplications.name, search),
              ilike(partnerAccessApplications.email, search),
              ilike(partnerAccessApplications.companyName, search),
            )
          : null,
        cursorCondition(
          query,
          partnerAccessApplications.createdAt,
          partnerAccessApplications.id,
        ),
      ]),
    )
    .orderBy(
      desc(partnerAccessApplications.createdAt),
      desc(partnerAccessApplications.id),
    )
    .limit(query.limit + 1);
  const page = buildPartnerManagementPage(rows, query);
  return {
    items: page.items.map((row) => ({
      ...row,
      emailVerifiedAt: iso(row.emailVerifiedAt),
      submittedAt: row.submittedAt.toISOString(),
      reviewedAt: iso(row.reviewedAt),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
    page: page.page,
  };
}

async function listJoinRequests(query: PartnerManagementListQuery) {
  const search = query.q ? escapedPartnerManagementSearch(query.q) : null;
  const rows = await getDb()
    .select({
      id: partnerCompanyJoinRequests.id,
      partnerAccountId: partnerCompanyJoinRequests.partnerAccountId,
      accountName: partnerAccounts.name,
      partnerUserId: partnerCompanyJoinRequests.partnerUserId,
      personName: partnerUsers.name,
      personEmail: partnerUsers.email,
      requestedRoleKey: partnerCompanyJoinRequests.requestedRoleKey,
      message: partnerCompanyJoinRequests.message,
      status: partnerCompanyJoinRequests.status,
      version: partnerCompanyJoinRequests.version,
      resolvedMembershipId: partnerCompanyJoinRequests.resolvedMembershipId,
      reviewNote: partnerCompanyJoinRequests.reviewNote,
      requestedAt: partnerCompanyJoinRequests.requestedAt,
      reviewedAt: partnerCompanyJoinRequests.reviewedAt,
      createdAt: partnerCompanyJoinRequests.createdAt,
      updatedAt: partnerCompanyJoinRequests.updatedAt,
    })
    .from(partnerCompanyJoinRequests)
    .innerJoin(
      partnerAccounts,
      eq(partnerCompanyJoinRequests.partnerAccountId, partnerAccounts.id),
    )
    .innerJoin(
      partnerUsers,
      eq(partnerCompanyJoinRequests.partnerUserId, partnerUsers.id),
    )
    .where(
      where([
        query.accountId
          ? eq(partnerCompanyJoinRequests.partnerAccountId, query.accountId)
          : null,
        query.userId
          ? eq(partnerCompanyJoinRequests.partnerUserId, query.userId)
          : null,
        query.status
          ? eq(partnerCompanyJoinRequests.status, query.status as never)
          : null,
        search
          ? or(
              ilike(partnerAccounts.name, search),
              ilike(partnerUsers.name, search),
              ilike(partnerUsers.email, search),
            )
          : null,
        cursorCondition(
          query,
          partnerCompanyJoinRequests.createdAt,
          partnerCompanyJoinRequests.id,
        ),
      ]),
    )
    .orderBy(
      desc(partnerCompanyJoinRequests.createdAt),
      desc(partnerCompanyJoinRequests.id),
    )
    .limit(query.limit + 1);
  const page = buildPartnerManagementPage(rows, query);
  return {
    items: page.items.map((row) => ({
      ...row,
      requestedAt: row.requestedAt.toISOString(),
      reviewedAt: iso(row.reviewedAt),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
    page: page.page,
  };
}

export async function listPartnerManagementResource(
  resource: PartnerManagementResource,
  query: PartnerManagementListQuery,
) {
  switch (resource) {
    case "account-merges":
      return listAccountMergeCases(query);
    case "accounts":
      return listAccounts(query);
    case "applications":
      return listApplications(query);
    case "billing-disputes":
      return listBillingDisputes(query);
    case "cancellation-requests":
      return listCancellationRequests(query);
    case "change-requests":
      return listJobChangeRequests(query);
    case "commercial":
      return listCommercialReadiness(query);
    case "domains":
      return listDomains(query);
    case "invitations":
      return listInvitations(query);
    case "join-requests":
      return listJoinRequests(query);
    case "location-reviews":
      return listLocationAddressReviews(query);
    case "memberships":
      return listMemberships(query);
    case "people":
      return listPeople(query);
    case "quarantine":
      return listQuarantineCases(query);
    case "security":
      return listSecuritySessions(query);
  }
}
