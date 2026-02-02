import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { getDb, partnerRateCards, partnerRateItems } from "@/db";
import { isAdminRequest } from "../../../web/admin";
import { requirePermission } from "@/lib/permissions";
import { isPartnerAllowedServiceKey, isPartnerTierKeyForService } from "@myst-os/pricing";

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "policy.write");
  if (permissionError) return permissionError;

  const url = new URL(request.url);
  const orgContactId = url.searchParams.get("orgContactId")?.trim() ?? "";
  if (!orgContactId) {
    return NextResponse.json({ ok: false, error: "orgContactId_required" }, { status: 400 });
  }

  const db = getDb();
  const [card] = await db
    .select({ id: partnerRateCards.id, currency: partnerRateCards.currency })
    .from(partnerRateCards)
    .where(eq(partnerRateCards.orgContactId, orgContactId))
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
    .where(eq(partnerRateItems.rateCardId, card.id))
    .orderBy(asc(partnerRateItems.serviceKey), asc(partnerRateItems.sortOrder), asc(partnerRateItems.tierKey));

  return NextResponse.json({
    ok: true,
    currency: card.currency,
    items: items.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }))
  });
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "policy.write");
  if (permissionError) return permissionError;

  const payload = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const orgContactId = readString(payload?.["orgContactId"]);
  const currency = readString(payload?.["currency"]) || "USD";
  const itemsRaw = payload?.["items"];
  const items = Array.isArray(itemsRaw) ? itemsRaw : [];

  if (!orgContactId) {
    return NextResponse.json({ ok: false, error: "orgContactId_required" }, { status: 400 });
  }

  const normalized: Array<{
    serviceKey: string;
    tierKey: string;
    label: string | null;
    amountCents: number;
    sortOrder: number;
  }> = [];

  for (const row of items) {
    const record = typeof row === "object" && row !== null ? (row as Record<string, unknown>) : null;
    if (!record) continue;

    const serviceKeyRaw = readString(record["serviceKey"]).toLowerCase();
    const tierKey = readString(record["tierKey"]);
    const label = readString(record["label"]) || null;
    const amountCents = readNumber(record["amountCents"]);
    const sortOrder = readNumber(record["sortOrder"]);
    if (!serviceKeyRaw || !tierKey || amountCents === null) continue;

    if (!isPartnerAllowedServiceKey(serviceKeyRaw)) {
      return NextResponse.json({ ok: false, error: `invalid_service_key:${serviceKeyRaw}` }, { status: 400 });
    }

    if (!isPartnerTierKeyForService(serviceKeyRaw, tierKey)) {
      return NextResponse.json({ ok: false, error: `invalid_tier_key:${tierKey}` }, { status: 400 });
    }

    normalized.push({
      serviceKey: serviceKeyRaw,
      tierKey,
      label,
      amountCents: Math.max(0, Math.floor(amountCents)),
      sortOrder: sortOrder === null ? 0 : Math.floor(sortOrder)
    });
  }

  const db = getDb();
  const now = new Date();

  const result = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: partnerRateCards.id })
      .from(partnerRateCards)
      .where(eq(partnerRateCards.orgContactId, orgContactId))
      .limit(1);

    const cardId =
      existing?.id ??
      (
        await tx
          .insert(partnerRateCards)
          .values({ orgContactId, currency, active: true, createdAt: now, updatedAt: now })
          .returning({ id: partnerRateCards.id })
      )[0]?.id;

    if (!cardId) {
      throw new Error("rate_card_create_failed");
    }

    await tx.update(partnerRateCards).set({ currency, updatedAt: now }).where(eq(partnerRateCards.id, cardId));
    await tx.delete(partnerRateItems).where(eq(partnerRateItems.rateCardId, cardId));

    if (normalized.length) {
      await tx.insert(partnerRateItems).values(
        normalized.map((row) => ({
          rateCardId: cardId,
          serviceKey: row.serviceKey,
          tierKey: row.tierKey,
          label: row.label,
          amountCents: row.amountCents,
          sortOrder: row.sortOrder,
          createdAt: now
        }))
      );
    }

    return cardId;
  });

  return NextResponse.json({ ok: true, cardId: result });
}
