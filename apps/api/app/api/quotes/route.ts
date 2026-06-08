import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { calculateQuoteBreakdown } from "@myst-os/pricing/src/engine/calculate";
import { serviceRates } from "@myst-os/pricing/src/config/defaults";
import type { ConcreteSurfaceInput, ServiceCategory } from "@myst-os/pricing/src/types";
import { getDb, quotes, contacts, properties, quoteChangeRequests, quotePdfDownloads } from "@/db";
import { getAuditActorFromRequest, recordAuditEvent } from "@/lib/audit";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../web/admin";
import { eq, desc, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { resolvePublicSiteBaseUrl } from "@/lib/public-site-url";

const STATUS_FILTERS = ["pending", "sent", "accepted", "declined"] as const;
type QuoteStatusFilter = (typeof STATUS_FILTERS)[number];
const DEFAULT_QUOTE_JOB_DURATION_MINUTES = 120;

const SERVICE_ID_SET = new Set<ServiceCategory>(serviceRates.map((rate) => rate.service));

const serviceIdSchema = z
  .string()
  .min(1)
  .refine(
    (value): value is ServiceCategory => SERVICE_ID_SET.has(value as ServiceCategory),
    "invalid_service"
  );

const CreateQuoteSchema = z.object({
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
  jobDurationMinutes: z.number().int().min(30).max(8 * 60).optional(),
  serviceOverrides: z.record(z.string().min(1), z.number().positive()).optional(),
  makeShareable: z.boolean().optional(),
  concreteSurfaces: z
    .array(
      z.object({
        kind: z.enum(["driveway", "deck", "other"]),
        squareFeet: z.number().positive()
      })
    )
    .max(3)
    .optional()
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

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toIsoTimestamp(value: Date | string | null | undefined): string | null {
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
  if (row.status === "sent" && expiresAt && expiresAt.getTime() < Date.now()) return "expired";
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
          createdAt: latestChangeRequestAt
        }
      : null,
    contact: {
      name: contactName && contactName.length ? contactName : "Customer",
      email: row.contactEmail
    },
    property: {
      addressLine1: addressLine1 ?? "",
      city: city ?? "",
      state: state ?? "",
      postalCode: postalCode ?? ""
    }
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
    statusParam as QuoteStatusFilter
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
      contactName: contacts.firstName,
      contactEmail: contacts.email,
      propertyAddressLine1: properties.addressLine1,
      propertyCity: properties.city,
      propertyState: properties.state,
      propertyPostalCode: properties.postalCode
    })
    .from(quotes)
    .leftJoin(contacts, eq(quotes.contactId, contacts.id))
    .leftJoin(properties, eq(quotes.propertyId, properties.id));

  const filteredQuery = statusFilter
    ? baseQuery.where(eq(quotes.status, statusFilter))
    : baseQuery;

  const rows = await filteredQuery.orderBy(desc(quotes.updatedAt));

  return NextResponse.json({
    quotes: rows.map(formatQuoteResponse)
  });
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "quotes.write");
  if (permissionError) return permissionError;

  const parsedBody = CreateQuoteSchema.safeParse(await request.json());
  if (!parsedBody.success) {
    return NextResponse.json(
      { error: "invalid_payload", details: parsedBody.error.flatten() },
      { status: 400 }
    );
  }

  const body = parsedBody.data;
  const actor = getAuditActorFromRequest(request);
  const db = getDb();

  const [contact] = await db
    .select({
      id: contacts.id,
      name: contacts.firstName
    })
    .from(contacts)
    .where(eq(contacts.id, body.contactId))
    .limit(1);

  if (!contact) {
    return NextResponse.json({ error: "contact_not_found" }, { status: 404 });
  }

  const [property] = await db
    .select({
      id: properties.id,
      contactId: properties.contactId
    })
    .from(properties)
    .where(eq(properties.id, body.propertyId))
    .limit(1);

  if (!property) {
    return NextResponse.json({ error: "property_not_found" }, { status: 404 });
  }

  if (property.contactId !== contact.id) {
    return NextResponse.json({ error: "property_contact_mismatch" }, { status: 400 });
  }

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

  const concreteSurfaces = (body.concreteSurfaces ?? []) as ConcreteSurfaceInput[];

  const breakdown = calculateQuoteBreakdown({
    zoneId: body.zoneId,
    selectedServices,
    selectedAddOns: body.selectedAddOns,
    surfaceArea: body.surfaceArea,
    applyBundles: body.applyBundles,
    depositRate: body.depositRate,
    serviceOverrides: sanitizedOverrides,
    concreteSurfaces
  });

  const expiresAt = body.expiresInDays
    ? new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000)
    : null;
  const jobDurationMinutes =
    body.jobDurationMinutes ?? DEFAULT_QUOTE_JOB_DURATION_MINUTES;
  const shareToken = body.makeShareable ? nanoid(24) : null;
  const shareUrl = shareToken ? buildShareUrl(shareToken) : null;

  if (body.makeShareable && !shareUrl) {
    return NextResponse.json(
      {
        error: "site_url_not_configured",
        message: "Set NEXT_PUBLIC_SITE_URL or SITE_URL to generate customer-facing quote links."
      },
      { status: 500 }
    );
  }

  const quoteValues: typeof quotes.$inferInsert = {
    contactId: body.contactId,
    propertyId: body.propertyId,
    status: body.makeShareable ? "sent" : "pending",
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
    quoteNumber: generateQuoteNumber(),
    jobDurationMinutes,
    clientScope: body.clientScope ?? null,
    expiresAt,
    shareToken,
    sentAt: body.makeShareable ? new Date() : null
  };

  const [inserted] = await db.insert(quotes).values(quoteValues).returning();

  if (!inserted) {
    return NextResponse.json({ error: "insert_failed" }, { status: 500 });
  }

  await recordAuditEvent({
    actor,
    action: "quote.created",
    entityType: "quote",
    entityId: inserted.id,
    meta: {
      contactId: body.contactId,
      propertyId: body.propertyId,
      services: selectedServices,
      total: breakdown.total,
      makeShareable: body.makeShareable === true,
      shareToken
    }
  });

  return NextResponse.json({
    ok: true,
    quote: {
      ...inserted,
      createdAt: inserted.createdAt.toISOString(),
      updatedAt: inserted.updatedAt.toISOString(),
      sentAt: inserted.sentAt ? inserted.sentAt.toISOString() : null,
      expiresAt: inserted.expiresAt ? inserted.expiresAt.toISOString() : null,
      viewedAt: inserted.viewedAt ? inserted.viewedAt.toISOString() : null,
      lastViewedAt: inserted.lastViewedAt ? inserted.lastViewedAt.toISOString() : null,
      decisionAt: inserted.decisionAt ? inserted.decisionAt.toISOString() : null,
      refreshRequestedAt: inserted.refreshRequestedAt ? inserted.refreshRequestedAt.toISOString() : null,
      displayStatus: displayStatus({
        status: inserted.status,
        expiresAt: inserted.expiresAt,
        viewedAt: inserted.viewedAt,
        refreshRequestedAt: inserted.refreshRequestedAt,
        acceptedAppointmentId: inserted.acceptedAppointmentId
      })
    },
    breakdown,
    shareUrl
  });
}
