import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { calculateQuoteBreakdown } from "@myst-os/pricing/src/engine/calculate";
import { serviceRates } from "@myst-os/pricing/src/config/defaults";
import type {
  ConcreteSurfaceInput,
  ServiceCategory,
} from "@myst-os/pricing/src/types";
import {
  getDb,
  conversationMessages,
  externalMessageDispatches,
  outboxEvents,
  quotes,
  contacts,
  properties,
  quoteChangeRequests,
  quotePdfDownloads,
} from "@/db";
import { requirePermission } from "@/lib/permissions";
import { loadContactPropertyById } from "@/lib/property-write";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  type TeamMutationIdempotencyClaim,
  teamMutationIdempotencyReplayResponse,
} from "@/lib/team-mutation-idempotency";
import {
  beginTeamMutation,
  recordTeamMutationFailure,
  TeamMutationFailure,
  teamMutationErrorResponse,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";
import { isAdminRequest } from "../web/admin";
import { eq, desc, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { resolvePublicSiteBaseUrl } from "@/lib/public-site-url";

const STATUS_FILTERS = ["pending", "sent", "accepted", "declined"] as const;
type QuoteStatusFilter = (typeof STATUS_FILTERS)[number];
const DEFAULT_QUOTE_JOB_DURATION_MINUTES = 120;

const SERVICE_ID_SET = new Set<ServiceCategory>(
  serviceRates.map((rate) => rate.service),
);

const serviceIdSchema = z
  .string()
  .min(1)
  .refine(
    (value): value is ServiceCategory =>
      SERVICE_ID_SET.has(value as ServiceCategory),
    "invalid_service",
  );

const CreateQuoteSchema = z.object({
  confirmation: z.literal("create_quote"),
  contactId: z.string().uuid(),
  propertyId: z.string().uuid(),
  zoneId: z.string().min(1),
  selectedServices: z.array(serviceIdSchema).min(1),
  selectedAddOns: z.array(z.string().min(1)).optional(),
  surfaceArea: z.number().positive().optional(),
  applyBundles: z.boolean().optional(),
  depositRate: z.number().positive().max(1).optional(),
  expiresInDays: z.number().int().min(1).max(90).optional(),
  notes: z.string().max(2000).optional(),
  clientScope: z.string().max(4000).optional(),
  jobDurationMinutes: z
    .number()
    .int()
    .min(30)
    .max(8 * 60)
    .optional(),
  serviceOverrides: z
    .record(z.string().min(1), z.number().positive())
    .optional(),
  makeShareable: z.boolean().optional(),
  concreteSurfaces: z
    .array(
      z.object({
        kind: z.enum(["driveway", "deck", "other"]),
        squareFeet: z.number().positive(),
      }),
    )
    .max(3)
    .optional(),
});

const toPgNumeric = (value: number | string): string => value.toString();
const toOptionalPgNumeric = (value?: number | string | null): string | null =>
  value === null || value === undefined ? null : value.toString();

function generateQuoteNumber(now = new Date()): string {
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, "");
  return `Q-${ymd}-${nanoid(6).toUpperCase()}`;
}

function buildShareUrl(token: string): string | null {
  const base = resolvePublicSiteBaseUrl({ devFallbackLocalhost: true });
  return base ? new URL(`/quote/${token}`, base).toString() : null;
}

async function requireShareableQuotePermission(
  request: NextRequest,
  correlationId: string,
): Promise<Response | null> {
  const permissionError = await requirePermission(request, "quotes.send");
  if (!permissionError) return null;
  if (permissionError.status === 401) {
    return teamMutationErrorResponse(
      "unauthorized",
      "Your team session is no longer active.",
      { correlationId },
    );
  }
  if (permissionError.status === 403) {
    return teamMutationErrorResponse(
      "forbidden",
      "You do not have permission to create a customer-visible quote link.",
      { correlationId },
    );
  }
  if (permissionError.status === 503) {
    return teamMutationErrorResponse(
      "forbidden",
      "Customer-visible quote links are temporarily disabled by a safety control.",
      { correlationId },
    );
  }
  return teamMutationErrorResponse(
    "internal",
    "Quote link permission could not be verified. Try again.",
    { correlationId, retryable: true },
  );
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? null : value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toIsoTimestamp(
  value: Date | string | null | undefined,
): string | null {
  return toDate(value)?.toISOString() ?? null;
}

function displayStatus(row: {
  status: string;
  expiresAt: Date | string | null;
  viewedAt: Date | string | null;
  refreshRequestedAt: Date | string | null;
  acceptedAppointmentId: string | null;
}): string {
  if (row.acceptedAppointmentId) return "booked";
  if (row.refreshRequestedAt) return "refresh_requested";
  if (row.status === "declined") return "rejected";
  if (row.status === "accepted") return "accepted";
  const expiresAt = toDate(row.expiresAt);
  if (row.status === "sent" && expiresAt && expiresAt.getTime() < Date.now())
    return "expired";
  if (row.status === "sent" && row.viewedAt) return "viewed";
  if (row.status === "sent") return "sent";
  return "draft";
}

function formatQuoteResponse(row: {
  id: string;
  status: string;
  services: string[];
  addOns: string[] | null;
  total: unknown;
  lineItems: unknown;
  notes: string | null;
  quoteNumber: string | null;
  jobDurationMinutes: number;
  clientScope: string | null;
  revision: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  sentAt: Date | string | null;
  expiresAt: Date | string | null;
  viewedAt: Date | string | null;
  lastViewedAt: Date | string | null;
  viewCount: number;
  decisionAt: Date | string | null;
  decisionNotes: string | null;
  refreshRequestedAt: Date | string | null;
  acceptedAppointmentId: string | null;
  shareToken: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  propertyAddressLine1: string | null;
  propertyCity: string | null;
  propertyState: string | null;
  propertyPostalCode: string | null;
  pdfDownloadCount?: number | null;
  lastPdfDownloadedAt?: Date | string | null;
  changeRequestCount?: number | null;
  latestChangeRequestReason?: string | null;
  latestChangeRequestMessage?: string | null;
  latestChangeRequestAt?: Date | string | null;
  deliveryState?: string | null;
  deliveryAttemptId?: string | null;
}) {
  const contactName = row.contactName?.trim();
  const addressLine1 = row.propertyAddressLine1?.trim();
  const city = row.propertyCity?.trim();
  const state = row.propertyState?.trim();
  const postalCode = row.propertyPostalCode?.trim();
  const latestChangeRequestAt = toIsoTimestamp(row.latestChangeRequestAt);

  return {
    id: row.id,
    status: row.status,
    services: row.services,
    addOns: row.addOns,
    total: Number(row.total),
    lineItems: row.lineItems,
    notes: row.notes,
    quoteNumber: row.quoteNumber ?? row.id.slice(0, 8).toUpperCase(),
    jobDurationMinutes: row.jobDurationMinutes,
    clientScope: row.clientScope,
    revision: row.revision,
    displayStatus: displayStatus(row),
    createdAt: toIsoTimestamp(row.createdAt),
    updatedAt: toIsoTimestamp(row.updatedAt),
    sentAt: toIsoTimestamp(row.sentAt),
    expiresAt: toIsoTimestamp(row.expiresAt),
    viewedAt: toIsoTimestamp(row.viewedAt),
    lastViewedAt: toIsoTimestamp(row.lastViewedAt),
    viewCount: row.viewCount,
    decisionAt: toIsoTimestamp(row.decisionAt),
    decisionNotes: row.decisionNotes,
    refreshRequestedAt: toIsoTimestamp(row.refreshRequestedAt),
    acceptedAppointmentId: row.acceptedAppointmentId,
    shareToken: row.shareToken,
    pdfDownloadCount: Number(row.pdfDownloadCount ?? 0),
    lastPdfDownloadedAt: toIsoTimestamp(row.lastPdfDownloadedAt),
    changeRequestCount: Number(row.changeRequestCount ?? 0),
    latestChangeRequest: latestChangeRequestAt
      ? {
          reason: row.latestChangeRequestReason,
          message: row.latestChangeRequestMessage,
          createdAt: latestChangeRequestAt,
        }
      : null,
    deliveryState: row.deliveryState ?? null,
    deliveryAttemptId: row.deliveryAttemptId ?? null,
    contact: {
      name: contactName && contactName.length ? contactName : "Customer",
      email: row.contactEmail,
      phone: row.contactPhone,
    },
    property: {
      addressLine1: addressLine1 ?? "",
      city: city ?? "",
      state: state ?? "",
      postalCode: postalCode ?? "",
    },
  };
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "quotes.read");
  if (permissionError) return permissionError;

  const statusParam = request.nextUrl.searchParams.get("status");
  const statusFilter: QuoteStatusFilter | null = STATUS_FILTERS.includes(
    statusParam as QuoteStatusFilter,
  )
    ? (statusParam as QuoteStatusFilter)
    : null;

  const db = getDb();
  const baseQuery = db
    .select({
      id: quotes.id,
      status: quotes.status,
      services: quotes.services,
      addOns: quotes.addOns,
      total: quotes.total,
      lineItems: quotes.lineItems,
      notes: quotes.notes,
      quoteNumber: quotes.quoteNumber,
      jobDurationMinutes: quotes.jobDurationMinutes,
      clientScope: quotes.clientScope,
      revision: quotes.revision,
      createdAt: quotes.createdAt,
      updatedAt: quotes.updatedAt,
      sentAt: quotes.sentAt,
      expiresAt: quotes.expiresAt,
      viewedAt: quotes.viewedAt,
      lastViewedAt: quotes.lastViewedAt,
      viewCount: quotes.viewCount,
      decisionAt: quotes.decisionAt,
      decisionNotes: quotes.decisionNotes,
      refreshRequestedAt: quotes.refreshRequestedAt,
      acceptedAppointmentId: quotes.acceptedAppointmentId,
      shareToken: quotes.shareToken,
      pdfDownloadCount: sql<number>`(
        select count(*)::int
        from ${quotePdfDownloads}
        where ${quotePdfDownloads.quoteId} = ${quotes.id}
      )`,
      lastPdfDownloadedAt: sql<Date | null>`(
        select max(${quotePdfDownloads.createdAt})
        from ${quotePdfDownloads}
        where ${quotePdfDownloads.quoteId} = ${quotes.id}
      )`,
      changeRequestCount: sql<number>`(
        select count(*)::int
        from ${quoteChangeRequests}
        where ${quoteChangeRequests.quoteId} = ${quotes.id}
      )`,
      latestChangeRequestReason: sql<string | null>`(
        select ${quoteChangeRequests.reason}
        from ${quoteChangeRequests}
        where ${quoteChangeRequests.quoteId} = ${quotes.id}
        order by ${quoteChangeRequests.createdAt} desc
        limit 1
      )`,
      latestChangeRequestMessage: sql<string | null>`(
        select ${quoteChangeRequests.message}
        from ${quoteChangeRequests}
        where ${quoteChangeRequests.quoteId} = ${quotes.id}
        order by ${quoteChangeRequests.createdAt} desc
        limit 1
      )`,
      latestChangeRequestAt: sql<Date | null>`(
        select ${quoteChangeRequests.createdAt}
        from ${quoteChangeRequests}
        where ${quoteChangeRequests.quoteId} = ${quotes.id}
        order by ${quoteChangeRequests.createdAt} desc
        limit 1
      )`,
      deliveryAttemptId: sql<string | null>`(
        select ${outboxEvents.payload} ->> 'sendAttemptId'
        from ${outboxEvents}
        where ${outboxEvents.type} = 'quote.sent'
          and ${outboxEvents.payload} ->> 'quoteId' = ${quotes.id}::text
        order by ${outboxEvents.createdAt} desc, ${outboxEvents.id} desc
        limit 1
      )`,
      deliveryState: sql<string | null>`(
        with latest_attempt as (
          select ${outboxEvents.payload} ->> 'sendAttemptId' as attempt_id
          from ${outboxEvents}
          where ${outboxEvents.type} = 'quote.sent'
            and ${outboxEvents.payload} ->> 'quoteId' = ${quotes.id}::text
          order by ${outboxEvents.createdAt} desc, ${outboxEvents.id} desc
          limit 1
        ), latest_messages as (
          select
            ${conversationMessages.deliveryStatus} as delivery_status,
            dispatch.state as dispatch_state
          from ${conversationMessages}
          left join lateral (
            select ${externalMessageDispatches.state} as state
            from ${externalMessageDispatches}
            where ${externalMessageDispatches.messageId} = ${conversationMessages.id}
            order by ${externalMessageDispatches.attemptNumber} desc,
              ${externalMessageDispatches.createdAt} desc
            limit 1
          ) dispatch on true
          where ${conversationMessages.metadata} ->> 'kind' = 'quote.sent'
            and ${conversationMessages.metadata} ->> 'quoteId' = ${quotes.id}::text
            and ${conversationMessages.metadata} ->> 'sendAttemptId' =
              (select attempt_id from latest_attempt)
        )
        select case
          when not exists (select 1 from latest_attempt) then null
          when exists (
            select 1 from latest_messages
            where dispatch_state = 'reconciliation_required'
          ) then 'reconciliation_required'
          when exists (
            select 1 from latest_messages where delivery_status = 'failed'
          ) and exists (
            select 1 from latest_messages where delivery_status <> 'failed'
          ) then 'partial_failure'
          when exists (
            select 1 from latest_messages where dispatch_state = 'dispatched'
          ) then 'dispatched'
          when not exists (select 1 from latest_messages) then 'requested'
          when exists (
            select 1 from latest_messages where delivery_status = 'queued'
          ) then 'requested'
          when exists (
            select 1 from latest_messages where delivery_status = 'sent'
          ) then 'succeeded'
          when exists (
            select 1 from latest_messages where delivery_status = 'failed'
          ) then 'failed'
          else 'requested'
        end
      )`,
      contactName: contacts.firstName,
      contactEmail: contacts.email,
      contactPhone: sql<
        string | null
      >`coalesce(${contacts.phoneE164}, ${contacts.phone})`,
      propertyAddressLine1: properties.addressLine1,
      propertyCity: properties.city,
      propertyState: properties.state,
      propertyPostalCode: properties.postalCode,
    })
    .from(quotes)
    .leftJoin(contacts, eq(quotes.contactId, contacts.id))
    .leftJoin(properties, eq(quotes.propertyId, properties.id));

  const filteredQuery = statusFilter
    ? baseQuery.where(eq(quotes.status, statusFilter))
    : baseQuery;

  const rows = await filteredQuery.orderBy(desc(quotes.updatedAt));

  return NextResponse.json({
    quotes: rows.map(formatQuoteResponse),
  });
}

export async function POST(request: NextRequest): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["quotes.write"],
    risk: "normal",
    requiresIdempotency: true,
    auditAction: "quote.created",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;

  const parsedBody = CreateQuoteSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsedBody.success) {
    await recordTeamMutationFailure(mutation, {
      entityType: "quote",
      code: "invalid",
      metadata: { phase: "request_validation", reason: "invalid_quote" },
    });
    return teamMutationErrorResponse(
      "invalid",
      "Complete and confirm the quote before creating it.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { quote: "Review the quote details and try again." },
      },
    );
  }

  const body = parsedBody.data;
  if (body.makeShareable) {
    const sharePermissionError = await requireShareableQuotePermission(
      request,
      mutation.correlationId,
    );
    if (sharePermissionError) {
      await recordTeamMutationFailure(mutation, {
        outcome: "denied",
        entityType: "quote",
        code: sharePermissionError.status === 403 ? "forbidden" : "internal",
        metadata: {
          phase: "share_permission",
          permissionStatus: sharePermissionError.status,
        },
      });
      return sharePermissionError;
    }
  }

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/quotes",
      entityType: "quote",
      entityId: "new",
      payload: body,
    });
    if (claimed.kind === "replay") {
      if (!claimed.replay.result.ok) {
        return teamMutationIdempotencyReplayResponse(claimed.replay);
      }
      const replayData = claimed.replay.result.data;
      if (
        !replayData ||
        typeof replayData !== "object" ||
        Array.isArray(replayData)
      ) {
        throw new TeamMutationFailure(
          "internal",
          "The original quote receipt is incomplete. Refresh before retrying.",
        );
      }
      const replayRecord = replayData as Record<string, unknown>;
      const replayQuoteId =
        replayRecord["quote"] &&
        typeof replayRecord["quote"] === "object" &&
        !Array.isArray(replayRecord["quote"]) &&
        "id" in replayRecord["quote"] &&
        typeof replayRecord["quote"].id === "string"
          ? replayRecord["quote"].id
          : null;
      if (!replayQuoteId) {
        throw new TeamMutationFailure(
          "internal",
          "The original quote receipt is incomplete. Refresh before retrying.",
        );
      }
      const [replayQuote] = await db
        .select({ shareToken: quotes.shareToken })
        .from(quotes)
        .where(eq(quotes.id, replayQuoteId))
        .limit(1);
      const replayShareUrl = replayQuote?.shareToken
        ? buildShareUrl(replayQuote.shareToken)
        : null;
      return teamMutationResultResponse(
        {
          ...claimed.replay.result,
          data: { ...replayRecord, shareUrl: replayShareUrl },
        },
        claimed.replay.status,
        claimed.replay.correlationId,
        { "idempotency-replayed": "true" },
      );
    }
    claim = claimed.claim;

    const selectedServices = body.selectedServices;
    const sanitizedOverrides: Partial<Record<ServiceCategory, number>> = {};
    if (body.serviceOverrides) {
      for (const [serviceId, amount] of Object.entries(body.serviceOverrides)) {
        if (
          SERVICE_ID_SET.has(serviceId as ServiceCategory) &&
          serviceId !== "driveway" &&
          selectedServices.includes(serviceId as ServiceCategory) &&
          typeof amount === "number" &&
          amount > 0
        ) {
          sanitizedOverrides[serviceId as ServiceCategory] = amount;
        }
      }
    }

    let breakdown: ReturnType<typeof calculateQuoteBreakdown>;
    try {
      breakdown = calculateQuoteBreakdown({
        zoneId: body.zoneId,
        selectedServices,
        selectedAddOns: body.selectedAddOns,
        surfaceArea: body.surfaceArea,
        applyBundles: body.applyBundles,
        depositRate: body.depositRate,
        serviceOverrides: sanitizedOverrides,
        concreteSurfaces: (body.concreteSurfaces ??
          []) as ConcreteSurfaceInput[],
      });
    } catch {
      throw new TeamMutationFailure(
        "invalid",
        "The selected services or pricing inputs are not valid.",
        { fieldErrors: { pricing: "Review the zone, services, and prices." } },
      );
    }

    const now = new Date();
    const expiresAt = body.expiresInDays
      ? new Date(now.getTime() + body.expiresInDays * 24 * 60 * 60 * 1000)
      : null;
    const shareToken = body.makeShareable ? nanoid(24) : null;
    const shareUrl = shareToken ? buildShareUrl(shareToken) : null;
    if (body.makeShareable && !shareUrl) {
      throw new TeamMutationFailure(
        "internal",
        "The public quote URL is not configured. No customer-visible quote was created.",
      );
    }

    const result = await db.transaction(async (tx) => {
      const [contact] = await tx
        .select({ id: contacts.id })
        .from(contacts)
        .where(eq(contacts.id, body.contactId))
        .limit(1);
      if (!contact) {
        throw new TeamMutationFailure("invalid", "The contact was not found.", {
          status: 404,
          fieldErrors: { contactId: "Select an existing contact." },
        });
      }

      const property = await loadContactPropertyById(tx, {
        contactId: contact.id,
        propertyId: body.propertyId,
      });
      if (!property) {
        const [existingProperty] = await tx
          .select({ id: properties.id })
          .from(properties)
          .where(eq(properties.id, body.propertyId))
          .limit(1);
        if (!existingProperty) {
          throw new TeamMutationFailure(
            "invalid",
            "The property was not found.",
            {
              status: 404,
              fieldErrors: { propertyId: "Select an existing property." },
            },
          );
        }
        throw new TeamMutationFailure(
          "invalid",
          "The selected property is not associated with this contact.",
          { fieldErrors: { propertyId: "Choose this contact's property." } },
        );
      }

      const quoteValues: typeof quotes.$inferInsert = {
        contactId: body.contactId,
        propertyId: body.propertyId,
        // A customer-visible link is not evidence that a provider send occurred.
        status: "pending",
        services: selectedServices,
        addOns: body.selectedAddOns ?? null,
        surfaceArea: toOptionalPgNumeric(body.surfaceArea),
        zoneId: body.zoneId,
        travelFee: toPgNumeric(breakdown.travelFee),
        discounts: toPgNumeric(breakdown.discounts),
        addOnsTotal: toPgNumeric(breakdown.addOnsTotal),
        subtotal: toPgNumeric(breakdown.subtotal),
        total: toPgNumeric(breakdown.total),
        depositDue: toPgNumeric(breakdown.depositDue),
        depositRate: toPgNumeric(breakdown.depositRate),
        balanceDue: toPgNumeric(breakdown.balanceDue),
        lineItems: breakdown.lineItems,
        notes: body.notes ?? null,
        quoteNumber: generateQuoteNumber(now),
        jobDurationMinutes:
          body.jobDurationMinutes ?? DEFAULT_QUOTE_JOB_DURATION_MINUTES,
        clientScope: body.clientScope ?? null,
        expiresAt,
        shareToken,
        sentAt: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      const [inserted] = await tx
        .insert(quotes)
        .values(quoteValues)
        .returning();
      if (!inserted) {
        throw new TeamMutationFailure(
          "internal",
          "The quote could not be created.",
          { retryable: true },
        );
      }

      const { shareToken: _shareToken, ...safeInserted } = inserted;

      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "quote",
        entityId: inserted.id,
        after: {
          status: inserted.status,
          revision: inserted.revision,
          contactId: inserted.contactId,
          propertyId: inserted.propertyId,
          total: breakdown.total,
          customerVisible: Boolean(shareUrl),
        },
        metadata: {
          services: selectedServices,
          makeShareable: body.makeShareable === true,
        },
        committedAt: now,
      });
      const mutationResult = teamMutationSuccessResult(
        mutation,
        {
          quote: {
            ...safeInserted,
            createdAt: inserted.createdAt.toISOString(),
            updatedAt: inserted.updatedAt.toISOString(),
            sentAt: inserted.sentAt?.toISOString() ?? null,
            expiresAt: inserted.expiresAt?.toISOString() ?? null,
            viewedAt: inserted.viewedAt?.toISOString() ?? null,
            lastViewedAt: inserted.lastViewedAt?.toISOString() ?? null,
            decisionAt: inserted.decisionAt?.toISOString() ?? null,
            refreshRequestedAt:
              inserted.refreshRequestedAt?.toISOString() ?? null,
            displayStatus: displayStatus({
              status: inserted.status,
              expiresAt: inserted.expiresAt,
              viewedAt: inserted.viewedAt,
              refreshRequestedAt: inserted.refreshRequestedAt,
              acceptedAppointmentId: inserted.acceptedAppointmentId,
            }),
          },
          breakdown,
          shareUrl,
        },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "quote",
          entityId: inserted.id,
          version: String(inserted.revision),
        },
      );
      const storedMutationResult = {
        ...mutationResult,
        data: { ...mutationResult.data, shareUrl: null },
      };
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
        storedMutationResult,
        201,
      );
      return mutationResult;
    });

    return teamMutationResultResponse(result, 201, mutation.correlationId);
  } catch (error) {
    if (db && claim) {
      await settleTeamMutationIdempotencyFailure(
        db,
        mutation,
        claim,
        error,
      ).catch(() => undefined);
    }
    await recordTeamMutationFailure(mutation, {
      entityType: "quote",
      code: error instanceof TeamMutationFailure ? error.code : "internal",
      metadata: {
        phase: "mutation",
        retryable:
          error instanceof TeamMutationFailure ? error.retryable : true,
      },
    });
    return teamMutationExceptionResponse(error, mutation);
  }
}
