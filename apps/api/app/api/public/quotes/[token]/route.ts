import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb, quotes, contacts, properties, outboxEvents } from "@/db";
import { eq, sql } from "drizzle-orm";

const PublicQuoteActionSchema = z.object({
  decision: z.enum(["accepted", "declined"]).optional(),
  action: z.enum(["refresh"]).optional(),
  reason: z.string().max(120).optional(),
  notes: z.string().max(1000).optional()
}).refine((value) => Boolean(value.decision || value.action), "decision_or_action_required");

function displayStatus(row: {
  status: string;
  expiresAt: Date | null;
  viewedAt: Date | null;
  refreshRequestedAt: Date | null;
  acceptedAppointmentId: string | null;
}): string {
  if (row.acceptedAppointmentId) return "booked";
  if (row.refreshRequestedAt) return "refresh_requested";
  if (row.status === "declined") return "rejected";
  if (row.status === "accepted") return "accepted";
  if (row.status === "sent" && row.expiresAt && row.expiresAt.getTime() < Date.now()) return "expired";
  if (row.status === "sent" && row.viewedAt) return "viewed";
  if (row.status === "sent") return "sent";
  return "draft";
}

function mapPublicQuote(row: {
  id: string;
  status: string;
  services: string[];
  addOns: string[] | null;
  lineItems: unknown;
  subtotal: unknown;
  total: unknown;
  depositDue: unknown;
  balanceDue: unknown;
  quoteNumber: string | null;
  jobDurationMinutes: number;
  clientScope: string | null;
  revision: number;
  sentAt: Date | null;
  expiresAt: Date | null;
  viewedAt: Date | null;
  lastViewedAt: Date | null;
  viewCount: number;
  decisionAt: Date | null;
  decisionNotes: string | null;
  refreshRequestedAt: Date | null;
  acceptedAppointmentId: string | null;
  contactName: string | null;
  propertyAddressLine1: string | null;
  propertyCity: string | null;
  propertyState: string | null;
  propertyPostalCode: string | null;
}) {
  const expiresAtIso = row.expiresAt ? row.expiresAt.toISOString() : null;
  const expired = row.expiresAt ? row.expiresAt.getTime() < Date.now() : false;
  const customerName = row.contactName?.trim();
  const city = row.propertyCity?.trim();
  const state = row.propertyState?.trim();
  const postalCode = row.propertyPostalCode?.trim();
  const cityState = [city, state]
    .filter((part): part is string => Boolean(part && part.length))
    .join(", ")
    .trim();
  const serviceArea = [cityState, postalCode]
    .filter((part): part is string => Boolean(part && part.length))
    .join(" ")
    .trim();

  return {
    id: row.id,
    status: row.status,
    services: row.services,
    addOns: row.addOns,
    lineItems: row.lineItems,
    subtotal: Number(row.subtotal),
    total: Number(row.total),
    depositDue: Number(row.depositDue),
    balanceDue: Number(row.balanceDue),
    quoteNumber: row.quoteNumber ?? row.id.slice(0, 8).toUpperCase(),
    jobDurationMinutes: row.jobDurationMinutes,
    clientScope: row.clientScope,
    revision: row.revision,
    displayStatus: displayStatus(row),
    sentAt: row.sentAt ? row.sentAt.toISOString() : null,
    expiresAt: expiresAtIso,
    viewedAt: row.viewedAt ? row.viewedAt.toISOString() : null,
    lastViewedAt: row.lastViewedAt ? row.lastViewedAt.toISOString() : null,
    viewCount: row.viewCount,
    decisionAt: row.decisionAt ? row.decisionAt.toISOString() : null,
    expired,
    decisionNotes: row.decisionNotes,
    refreshRequestedAt: row.refreshRequestedAt ? row.refreshRequestedAt.toISOString() : null,
    acceptedAppointmentId: row.acceptedAppointmentId,
    customerName: customerName && customerName.length ? customerName : "Customer",
    addressLine1: row.propertyAddressLine1?.trim() ?? "",
    serviceArea: serviceArea.length ? serviceArea : ""
  };
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ token: string }> }
): Promise<Response> {
  const { token } = await context.params;
  if (!token) {
    return NextResponse.json({ error: "missing_token" }, { status: 400 });
  }

  const db = getDb();
  const rows = await db
    .select({
      id: quotes.id,
      status: quotes.status,
      services: quotes.services,
      addOns: quotes.addOns,
      lineItems: quotes.lineItems,
      subtotal: quotes.subtotal,
      total: quotes.total,
      depositDue: quotes.depositDue,
      balanceDue: quotes.balanceDue,
      quoteNumber: quotes.quoteNumber,
      jobDurationMinutes: quotes.jobDurationMinutes,
      clientScope: quotes.clientScope,
      revision: quotes.revision,
      sentAt: quotes.sentAt,
      expiresAt: quotes.expiresAt,
      viewedAt: quotes.viewedAt,
      lastViewedAt: quotes.lastViewedAt,
      viewCount: quotes.viewCount,
      decisionAt: quotes.decisionAt,
      decisionNotes: quotes.decisionNotes,
      refreshRequestedAt: quotes.refreshRequestedAt,
      acceptedAppointmentId: quotes.acceptedAppointmentId,
      contactName: contacts.firstName,
      propertyAddressLine1: properties.addressLine1,
      propertyCity: properties.city,
      propertyState: properties.state,
      propertyPostalCode: properties.postalCode
    })
    .from(quotes)
    .leftJoin(contacts, eq(quotes.contactId, contacts.id))
    .leftJoin(properties, eq(quotes.propertyId, properties.id))
    .where(eq(quotes.shareToken, token))
    .limit(1);

  const quote = rows[0];
  if (!quote) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const preview = request.nextUrl.searchParams.get("preview") === "1";
  let responseQuote = quote;
  if (!preview) {
    const now = new Date();
    const [viewed] = await db
      .update(quotes)
      .set({
        viewedAt: quote.viewedAt ?? now,
        lastViewedAt: now,
        viewCount: sql`${quotes.viewCount} + 1`,
        updatedAt: now
      })
      .where(eq(quotes.id, quote.id))
      .returning({
        viewedAt: quotes.viewedAt,
        lastViewedAt: quotes.lastViewedAt,
        viewCount: quotes.viewCount
      });
    if (viewed) {
      responseQuote = {
        ...quote,
        viewedAt: viewed.viewedAt,
        lastViewedAt: viewed.lastViewedAt,
        viewCount: viewed.viewCount
      };
    }
  }

  return NextResponse.json({
    quote: mapPublicQuote(responseQuote)
  });
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ token: string }> }
): Promise<Response> {
  const { token } = await context.params;
  if (!token) {
    return NextResponse.json({ error: "missing_token" }, { status: 400 });
  }

  const parsedBody = PublicQuoteActionSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsedBody.success) {
    return NextResponse.json(
      { error: "invalid_payload", details: parsedBody.error.flatten() },
      { status: 400 }
    );
  }

  const db = getDb();
  const rows = await db
    .select({
      id: quotes.id,
      status: quotes.status,
      expiresAt: quotes.expiresAt
    })
    .from(quotes)
    .where(eq(quotes.shareToken, token))
    .limit(1);

  const quote = rows[0];
  if (!quote) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const nowMs = Date.now();
  const expired = quote.expiresAt ? quote.expiresAt.getTime() < nowMs : false;
  if (parsedBody.data.action === "refresh") {
    const requestedAt = new Date();
    const [updated] = await db
      .update(quotes)
      .set({ refreshRequestedAt: requestedAt, updatedAt: requestedAt })
      .where(eq(quotes.id, quote.id))
      .returning({ id: quotes.id, refreshRequestedAt: quotes.refreshRequestedAt });
    if (!updated) {
      return NextResponse.json({ error: "update_failed" }, { status: 500 });
    }
    return NextResponse.json({
      ok: true,
      quoteId: updated.id,
      refreshRequestedAt: updated.refreshRequestedAt?.toISOString() ?? requestedAt.toISOString()
    });
  }

  const decision = parsedBody.data.decision;
  if (!decision) {
    return NextResponse.json({ error: "missing_decision" }, { status: 400 });
  }

  if (expired) {
    return NextResponse.json({ error: "expired" }, { status: 410 });
  }

  const decisionAt = new Date();
  const noteParts = [
    parsedBody.data.reason ? `Reason: ${parsedBody.data.reason}` : null,
    parsedBody.data.notes?.trim() ? parsedBody.data.notes.trim() : null
  ].filter((part): part is string => Boolean(part));
  const [updated] = await db
    .update(quotes)
    .set({
      status: decision,
      decisionAt,
      decisionNotes: noteParts.length ? noteParts.join("\n") : null,
      refreshRequestedAt: null,
      updatedAt: decisionAt
    })
    .where(eq(quotes.id, quote.id))
    .returning({
      id: quotes.id,
      status: quotes.status,
      decisionAt: quotes.decisionAt,
      decisionNotes: quotes.decisionNotes
    });
  if (!updated) {
    return NextResponse.json({ error: "update_failed" }, { status: 500 });
  }

  await db.insert(outboxEvents).values({
    type: "quote.decision",
    payload: {
      quoteId: updated.id,
      decision,
      source: "customer",
      notes: noteParts.length ? noteParts.join("\n") : null
    }
  });

  return NextResponse.json({
    ok: true,
    quoteId: updated.id,
    status: updated.status,
    decisionAt: updated.decisionAt ? updated.decisionAt.toISOString() : null,
    decisionNotes: updated.decisionNotes
  });
}
