import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { getDb, partnerRateCards, partnerRateItems } from "@/db";
import { requirePartnerSession } from "@/lib/partner-portal-auth";

export async function GET(request: NextRequest): Promise<Response> {
  const auth = await requirePartnerSession(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const url = new URL(request.url);
  const serviceKey = url.searchParams.get("serviceKey")?.trim().toLowerCase() ?? null;

  const db = getDb();
  const [card] = await db
    .select({ id: partnerRateCards.id, currency: partnerRateCards.currency })
    .from(partnerRateCards)
    .where(eq(partnerRateCards.orgContactId, auth.partnerUser.orgContactId))
    .limit(1);

  if (!card?.id) {
    return NextResponse.json({ ok: true, currency: "USD", items: [] });
  }

  const items = await db
    .select({
      id: partnerRateItems.id,
      serviceKey: partnerRateItems.serviceKey,
      tierKey: partnerRateItems.tierKey,
      label: partnerRateItems.label,
      amountCents: partnerRateItems.amountCents,
      sortOrder: partnerRateItems.sortOrder,
      createdAt: partnerRateItems.createdAt
    })
    .from(partnerRateItems)
    .where(
      serviceKey
        ? and(eq(partnerRateItems.rateCardId, card.id), eq(partnerRateItems.serviceKey, serviceKey))
        : eq(partnerRateItems.rateCardId, card.id)
    )
    .orderBy(asc(partnerRateItems.serviceKey), asc(partnerRateItems.sortOrder), asc(partnerRateItems.tierKey));

  return NextResponse.json({
    ok: true,
    currency: card.currency,
    items: items.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString()
    }))
  });
}
