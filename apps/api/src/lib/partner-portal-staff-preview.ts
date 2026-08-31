import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import {
  appointments,
  contacts,
  conversationThreads,
  getDb,
  mediaAssets,
  partnerAccountLocations,
  partnerAccountMemberships,
  partnerAccounts,
  partnerBookings,
  partnerDocuments,
  partnerInvoices,
  partnerJobEvidence,
  partnerJobEvents,
  properties,
} from "@/db";
import { createPartnerJobLocationJoinCondition } from "@/lib/partner-portal-v2-resource-authorization";
import { createPartnerPublicJobScheduleDto } from "@/lib/partner-portal-v2-scheduling/domain";

const STAFF_PREVIEW_JOB_LIMIT = 100;
const CURRENCY_PATTERN = /^[A-Z]{3}$/u;

export const PARTNER_STAFF_PREVIEW_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type PartnerStaffPreviewMoney = Readonly<{
  amountMinor: number;
  currency: string;
  minorUnit: 2;
}>;

export type PartnerStaffPreviewJobSummary = Readonly<{
  id: string;
  status: string;
  confirmationMode: string;
  service: Readonly<{ key: string | null; tierKey: string | null }>;
  schedule: ReturnType<typeof createPartnerPublicJobScheduleDto>;
  location: Readonly<{
    id: string | null;
    name: string | null;
    address: Readonly<{
      line1: string;
      city: string;
      state: string;
      postalCode: string;
    }> | null;
  }>;
  references: Readonly<{
    poNumber: string | null;
    costCenter: string | null;
    project: string | null;
  }>;
  financial: PartnerStaffPreviewMoney | null;
  allowedActions: readonly string[];
  createdAt: string;
  updatedAt: string;
}>;

export type PartnerStaffPreviewJobDetail = Readonly<{
  id: string;
  status: string;
  confirmationMode: string;
  service: Readonly<{ key: string | null; tierKey: string | null }>;
  schedule: ReturnType<typeof createPartnerPublicJobScheduleDto>;
  location: Readonly<{
    id: string | null;
    name: string | null;
    externalPropertyId: string | null;
    address: Readonly<{
      line1: string;
      line2: string | null;
      city: string;
      state: string;
      postalCode: string;
    }> | null;
    access: Readonly<{
      instructions: string | null;
      parking: string | null;
      loading: string | null;
    }>;
    onSiteContact: Record<string, unknown> | null;
  }>;
  scope: Record<string, unknown> | null;
  proofRequirements: Record<string, unknown> | null;
  reviewReasons: readonly string[];
  references: Readonly<{
    poNumber: string | null;
    costCenter: string | null;
    project: string | null;
  }>;
  financial: PartnerStaffPreviewMoney | null;
  timeline: readonly Readonly<{
    id: string;
    type: string;
    label: string;
    detail: string | null;
    at: string;
    actorType: string;
  }>[];
  evidence: readonly Readonly<{
    id: string;
    category: string;
    caption: string | null;
    filename: string;
    status: string;
    createdAt: string;
  }>[];
  documents: readonly Readonly<{
    id: string;
    type: string;
    version: number;
    filename: string;
    contentType: string;
    byteSize: number;
    generatedAt: string;
  }>[];
  invoices: readonly Readonly<{
    id: string;
    number: string;
    status: string;
    total: PartnerStaffPreviewMoney;
    paid: PartnerStaffPreviewMoney;
    balance: PartnerStaffPreviewMoney;
    dueDate: string | null;
    issuedAt: string | null;
    paidAt: string | null;
  }>[];
  conversation: Readonly<{
    subject: string | null;
    lastMessageAt: string | null;
  }> | null;
  allowedActions: readonly string[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}>;

export type PartnerStaffPreview = Readonly<{
  readOnly: true;
  previewScope: "account";
  account: Readonly<{
    id: string;
    name: string;
    status: string;
    portalAccessEnabled: boolean;
    createdAt: string;
    updatedAt: string;
  }>;
  summary: Readonly<{
    activeMemberCount: number;
    activeLocationCount: number;
    totalJobCount: number;
    statusCounts: Readonly<Record<string, number>>;
    outstandingBalances: readonly PartnerStaffPreviewMoney[];
  }>;
  jobs: readonly PartnerStaffPreviewJobSummary[];
  page: Readonly<{
    limit: number;
    returned: number;
    hasMore: boolean;
  }>;
  selectedJob: PartnerStaffPreviewJobDetail | null;
}>;

export type PartnerStaffPreviewResult =
  | Readonly<{ kind: "found"; preview: PartnerStaffPreview }>
  | Readonly<{ kind: "not_found" }>;

function money(amountMinor: number, currency: string): PartnerStaffPreviewMoney {
  if (!Number.isSafeInteger(amountMinor) || !CURRENCY_PATTERN.test(currency)) {
    throw new TypeError("partner_staff_preview_money_invalid");
  }
  return Object.freeze({ amountMinor, currency, minorUnit: 2 });
}

function safeAggregate(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new TypeError("partner_staff_preview_aggregate_invalid");
  }
  return parsed;
}

async function loadSelectedJob(
  accountId: string,
  jobId: string,
): Promise<PartnerStaffPreviewJobDetail | null> {
  const db = getDb();
  const [job] = await db
    .select({
      id: partnerBookings.id,
      status: partnerBookings.publicStatus,
      confirmationMode: partnerBookings.confirmationMode,
      serviceKey: partnerBookings.serviceKey,
      tierKey: partnerBookings.tierKey,
      amountCents: partnerBookings.amountCents,
      currency: partnerBookings.currency,
      scope: partnerBookings.scopeSnapshot,
      proofRequirements: partnerBookings.proofRequirementsSnapshot,
      poNumber: partnerBookings.poNumber,
      costCenter: partnerBookings.costCenter,
      projectReference: partnerBookings.projectReference,
      reviewReasons: partnerBookings.requestedReviewReasons,
      arrivalStartAt: partnerBookings.arrivalWindowStartAt,
      arrivalEndAt: partnerBookings.arrivalWindowEndAt,
      version: partnerBookings.version,
      createdAt: partnerBookings.createdAt,
      updatedAt: partnerBookings.updatedAt,
      completedAt: appointments.completedAt,
      locationId: partnerAccountLocations.id,
      siteName: partnerAccountLocations.siteName,
      externalPropertyId: partnerAccountLocations.externalPropertyId,
      addressLine1: properties.addressLine1,
      addressLine2: properties.addressLine2,
      city: properties.city,
      state: properties.state,
      postalCode: properties.postalCode,
      accessInstructions: partnerAccountLocations.accessInstructions,
      parkingInstructions: partnerAccountLocations.parkingInstructions,
      loadingInstructions: partnerAccountLocations.loadingInstructions,
      onSiteContact: partnerAccountLocations.onSiteContact,
      timezone: partnerAccountLocations.timezone,
    })
    .from(partnerBookings)
    .innerJoin(
      appointments,
      eq(partnerBookings.appointmentId, appointments.id),
    )
    .leftJoin(properties, eq(partnerBookings.propertyId, properties.id))
    .leftJoin(
      partnerAccountLocations,
      createPartnerJobLocationJoinCondition(),
    )
    .where(
      and(
        eq(partnerBookings.partnerAccountId, accountId),
        eq(partnerBookings.id, jobId),
      ),
    )
    .limit(1);
  if (!job) return null;

  const [timeline, evidence, documents, invoices, conversation] =
    await Promise.all([
      db
        .select({
          id: partnerJobEvents.id,
          type: partnerJobEvents.eventType,
          label: partnerJobEvents.publicLabel,
          detail: partnerJobEvents.publicDetail,
          at: partnerJobEvents.effectiveAt,
          actorType: partnerJobEvents.actorType,
        })
        .from(partnerJobEvents)
        .where(
          and(
            eq(partnerJobEvents.partnerAccountId, accountId),
            eq(partnerJobEvents.partnerBookingId, job.id),
          ),
        )
        .orderBy(asc(partnerJobEvents.effectiveAt), asc(partnerJobEvents.id))
        .limit(200),
      db
        .select({
          id: partnerJobEvidence.id,
          category: partnerJobEvidence.category,
          caption: partnerJobEvidence.caption,
          filename: mediaAssets.originalFilename,
          status: mediaAssets.status,
          createdAt: partnerJobEvidence.createdAt,
        })
        .from(partnerJobEvidence)
        .innerJoin(
          mediaAssets,
          eq(partnerJobEvidence.mediaAssetId, mediaAssets.id),
        )
        .where(
          and(
            eq(partnerJobEvidence.partnerAccountId, accountId),
            eq(partnerJobEvidence.partnerBookingId, job.id),
            isNull(partnerJobEvidence.deletedAt),
            isNull(mediaAssets.deletedAt),
          ),
        )
        .orderBy(
          asc(partnerJobEvidence.category),
          asc(partnerJobEvidence.sortOrder),
          asc(partnerJobEvidence.id),
        )
        .limit(40),
      db
        .select({
          id: partnerDocuments.id,
          type: partnerDocuments.documentType,
          version: partnerDocuments.version,
          filename: partnerDocuments.filename,
          contentType: partnerDocuments.contentType,
          byteSize: partnerDocuments.byteSize,
          generatedAt: partnerDocuments.generatedAt,
        })
        .from(partnerDocuments)
        .where(
          and(
            eq(partnerDocuments.partnerAccountId, accountId),
            eq(partnerDocuments.partnerBookingId, job.id),
          ),
        )
        .orderBy(desc(partnerDocuments.generatedAt), desc(partnerDocuments.id))
        .limit(100),
      db
        .select({
          id: partnerInvoices.id,
          number: partnerInvoices.invoiceNumber,
          status: partnerInvoices.status,
          currency: partnerInvoices.currency,
          totalCents: partnerInvoices.totalCents,
          paidCents: partnerInvoices.paidCents,
          balanceCents: partnerInvoices.balanceCents,
          dueDate: partnerInvoices.dueDate,
          issuedAt: partnerInvoices.issuedAt,
          paidAt: partnerInvoices.paidAt,
        })
        .from(partnerInvoices)
        .where(
          and(
            eq(partnerInvoices.partnerAccountId, accountId),
            eq(partnerInvoices.partnerBookingId, job.id),
          ),
        )
        .orderBy(desc(partnerInvoices.createdAt), desc(partnerInvoices.id))
        .limit(20),
      db
        .select({
          subject: conversationThreads.subject,
          lastMessageAt: conversationThreads.lastMessageAt,
        })
        .from(conversationThreads)
        .where(
          and(
            eq(conversationThreads.partnerAccountId, accountId),
            eq(conversationThreads.partnerBookingId, job.id),
            eq(conversationThreads.portalVisible, true),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null),
    ]);

  return Object.freeze({
    id: job.id,
    status: job.status,
    confirmationMode: job.confirmationMode,
    service: Object.freeze({ key: job.serviceKey, tierKey: job.tierKey }),
    schedule: createPartnerPublicJobScheduleDto({
      arrivalWindowStartAt: job.arrivalStartAt,
      arrivalWindowEndAt: job.arrivalEndAt,
      timezone: job.timezone,
      completedAt: job.completedAt,
    }),
    location: Object.freeze({
      id: job.locationId,
      name: job.siteName,
      externalPropertyId: job.externalPropertyId,
      address: job.addressLine1
        ? Object.freeze({
            line1: job.addressLine1,
            line2: job.addressLine2,
            city: job.city ?? "",
            state: job.state ?? "",
            postalCode: job.postalCode ?? "",
          })
        : null,
      access: Object.freeze({
        instructions: job.accessInstructions,
        parking: job.parkingInstructions,
        loading: job.loadingInstructions,
      }),
      onSiteContact: job.onSiteContact,
    }),
    scope: job.scope,
    proofRequirements: job.proofRequirements,
    reviewReasons: Object.freeze([...job.reviewReasons]),
    references: Object.freeze({
      poNumber: job.poNumber,
      costCenter: job.costCenter,
      project: job.projectReference,
    }),
    financial:
      job.amountCents === null ? null : money(job.amountCents, job.currency),
    timeline: Object.freeze(
      timeline.map((event) =>
        Object.freeze({
          id: event.id,
          type: event.type,
          label: event.label,
          detail: event.detail,
          at: event.at.toISOString(),
          actorType: event.actorType,
        }),
      ),
    ),
    evidence: Object.freeze(
      evidence.map((item) =>
        Object.freeze({
          ...item,
          filename: item.filename ?? "image",
          createdAt: item.createdAt.toISOString(),
        }),
      ),
    ),
    documents: Object.freeze(
      documents.map((document) =>
        Object.freeze({
          ...document,
          generatedAt: document.generatedAt.toISOString(),
        }),
      ),
    ),
    invoices: Object.freeze(
      invoices.map((invoice) =>
        Object.freeze({
          id: invoice.id,
          number: invoice.number,
          status: invoice.status,
          total: money(invoice.totalCents, invoice.currency),
          paid: money(invoice.paidCents, invoice.currency),
          balance: money(invoice.balanceCents, invoice.currency),
          dueDate: invoice.dueDate,
          issuedAt: invoice.issuedAt?.toISOString() ?? null,
          paidAt: invoice.paidAt?.toISOString() ?? null,
        }),
      ),
    ),
    conversation: conversation
      ? Object.freeze({
          subject: conversation.subject,
          lastMessageAt: conversation.lastMessageAt?.toISOString() ?? null,
        })
      : null,
    allowedActions: Object.freeze([]),
    revision: job.version,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  });
}

/**
 * Build an account-level, partner-facing read model for authenticated Stonegate
 * staff. This never creates or adapts a PartnerPrincipal and never returns a
 * provider payment URL, internal appointment identifier/start, location
 * secret, staff note, storage key, or mutation capability.
 */
export async function loadPartnerStaffPreview(input: {
  orgContactId: string;
  jobId?: string | null;
}): Promise<PartnerStaffPreviewResult> {
  const db = getDb();
  const accountCandidates = await db
    .select({
      id: partnerAccounts.id,
      name: partnerAccounts.name,
      status: partnerAccounts.status,
      portalAccessEnabled: partnerAccounts.portalAccessEnabled,
      createdAt: partnerAccounts.createdAt,
      updatedAt: partnerAccounts.updatedAt,
    })
    .from(contacts)
    .innerJoin(
      partnerAccounts,
      or(
        eq(partnerAccounts.id, contacts.partnerAccountId),
        eq(partnerAccounts.portalContactId, contacts.id),
      )!,
    )
    .where(
      and(eq(contacts.id, input.orgContactId), isNull(contacts.deletedAt)),
    )
    .limit(2);
  if (accountCandidates.length !== 1 || !accountCandidates[0]) {
    return { kind: "not_found" };
  }
  const account = accountCandidates[0];

  const [memberCountRows, locationCountRows, statusRows, balanceRows, jobRows] =
    await Promise.all([
      db
        .select({ count: sql<string>`count(*)::text` })
        .from(partnerAccountMemberships)
        .where(
          and(
            eq(partnerAccountMemberships.partnerAccountId, account.id),
            eq(partnerAccountMemberships.status, "active"),
          ),
        ),
      db
        .select({ count: sql<string>`count(*)::text` })
        .from(partnerAccountLocations)
        .where(
          and(
            eq(partnerAccountLocations.partnerAccountId, account.id),
            eq(partnerAccountLocations.active, true),
          ),
        ),
      db
        .select({
          status: partnerBookings.publicStatus,
          count: sql<string>`count(*)::text`,
        })
        .from(partnerBookings)
        .where(eq(partnerBookings.partnerAccountId, account.id))
        .groupBy(partnerBookings.publicStatus),
      db
        .select({
          currency: partnerInvoices.currency,
          balance: sql<string>`coalesce(sum(${partnerInvoices.balanceCents}), 0)::text`,
        })
        .from(partnerInvoices)
        .where(
          and(
            eq(partnerInvoices.partnerAccountId, account.id),
            inArray(partnerInvoices.status, [
              "issued",
              "partially_paid",
              "overdue",
            ]),
          ),
        )
        .groupBy(partnerInvoices.currency)
        .orderBy(asc(partnerInvoices.currency)),
      db
        .select({
          id: partnerBookings.id,
          status: partnerBookings.publicStatus,
          confirmationMode: partnerBookings.confirmationMode,
          serviceKey: partnerBookings.serviceKey,
          tierKey: partnerBookings.tierKey,
          amountCents: partnerBookings.amountCents,
          currency: partnerBookings.currency,
          poNumber: partnerBookings.poNumber,
          costCenter: partnerBookings.costCenter,
          projectReference: partnerBookings.projectReference,
          arrivalStartAt: partnerBookings.arrivalWindowStartAt,
          arrivalEndAt: partnerBookings.arrivalWindowEndAt,
          createdAt: partnerBookings.createdAt,
          updatedAt: partnerBookings.updatedAt,
          completedAt: appointments.completedAt,
          locationId: partnerAccountLocations.id,
          siteName: partnerAccountLocations.siteName,
          timezone: partnerAccountLocations.timezone,
          addressLine1: properties.addressLine1,
          city: properties.city,
          state: properties.state,
          postalCode: properties.postalCode,
        })
        .from(partnerBookings)
        .innerJoin(
          appointments,
          eq(partnerBookings.appointmentId, appointments.id),
        )
        .leftJoin(properties, eq(partnerBookings.propertyId, properties.id))
        .leftJoin(
          partnerAccountLocations,
          createPartnerJobLocationJoinCondition(),
        )
        .where(eq(partnerBookings.partnerAccountId, account.id))
        .orderBy(desc(partnerBookings.createdAt), desc(partnerBookings.id))
        .limit(STAFF_PREVIEW_JOB_LIMIT + 1),
    ]);

  const selectedJob = input.jobId
    ? await loadSelectedJob(account.id, input.jobId)
    : null;
  if (input.jobId && !selectedJob) return { kind: "not_found" };

  const pageRows = jobRows.slice(0, STAFF_PREVIEW_JOB_LIMIT);
  const statusCounts = Object.fromEntries(
    statusRows.map((row) => [row.status, safeAggregate(row.count)]),
  );
  const totalJobCount = Object.values(statusCounts).reduce(
    (total, count) => total + count,
    0,
  );
  const jobs = pageRows.map((job): PartnerStaffPreviewJobSummary =>
    Object.freeze({
      id: job.id,
      status: job.status,
      confirmationMode: job.confirmationMode,
      service: Object.freeze({ key: job.serviceKey, tierKey: job.tierKey }),
      schedule: createPartnerPublicJobScheduleDto({
        arrivalWindowStartAt: job.arrivalStartAt,
        arrivalWindowEndAt: job.arrivalEndAt,
        timezone: job.timezone,
        completedAt: job.completedAt,
      }),
      location: Object.freeze({
        id: job.locationId,
        name: job.siteName,
        address: job.addressLine1
          ? Object.freeze({
              line1: job.addressLine1,
              city: job.city ?? "",
              state: job.state ?? "",
              postalCode: job.postalCode ?? "",
            })
          : null,
      }),
      references: Object.freeze({
        poNumber: job.poNumber,
        costCenter: job.costCenter,
        project: job.projectReference,
      }),
      financial:
        job.amountCents === null
          ? null
          : money(job.amountCents, job.currency),
      allowedActions: Object.freeze([]),
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
    }),
  );

  return {
    kind: "found",
    preview: Object.freeze({
      readOnly: true,
      previewScope: "account",
      account: Object.freeze({
        id: account.id,
        name: account.name,
        status: account.status,
        portalAccessEnabled: account.portalAccessEnabled,
        createdAt: account.createdAt.toISOString(),
        updatedAt: account.updatedAt.toISOString(),
      }),
      summary: Object.freeze({
        activeMemberCount: safeAggregate(memberCountRows[0]?.count ?? 0),
        activeLocationCount: safeAggregate(locationCountRows[0]?.count ?? 0),
        totalJobCount,
        statusCounts: Object.freeze(statusCounts),
        outstandingBalances: Object.freeze(
          balanceRows.map((row) =>
            money(safeAggregate(row.balance), row.currency),
          ),
        ),
      }),
      jobs: Object.freeze(jobs),
      page: Object.freeze({
        limit: STAFF_PREVIEW_JOB_LIMIT,
        returned: jobs.length,
        hasMore: jobRows.length > STAFF_PREVIEW_JOB_LIMIT,
      }),
      selectedJob,
    }),
  };
}
