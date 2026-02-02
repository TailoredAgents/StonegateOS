import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { contacts, getDb, partnerRateCards, partnerRateItems, partnerUsers } from "@/db";
import { isAdminRequest } from "../../../web/admin";
import { requirePermission } from "@/lib/permissions";
import {
  createPartnerLoginToken,
  normalizeEmail,
  normalizePhoneE164,
  resolveRequestOriginBaseUrl,
  resolvePublicSiteBaseUrl
} from "@/lib/partner-portal-auth";
import { sendEmailMessage, sendSmsMessage } from "@/lib/messaging";

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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
    return NextResponse.json({ error: "orgContactId_required" }, { status: 400 });
  }

  const db = getDb();
  const rows = await db
    .select({
      id: partnerUsers.id,
      orgContactId: partnerUsers.orgContactId,
      email: partnerUsers.email,
      phone: partnerUsers.phone,
      phoneE164: partnerUsers.phoneE164,
      name: partnerUsers.name,
      active: partnerUsers.active,
      passwordSetAt: partnerUsers.passwordSetAt,
      createdAt: partnerUsers.createdAt,
      updatedAt: partnerUsers.updatedAt
    })
    .from(partnerUsers)
    .where(eq(partnerUsers.orgContactId, orgContactId));

  return NextResponse.json({
    ok: true,
    users: rows.map((row) => ({
      ...row,
      passwordSetAt: row.passwordSetAt ? row.passwordSetAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString()
    }))
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
  const email = normalizeEmail(payload?.["email"]);
  const name = readString(payload?.["name"]);
  const phone = readString(payload?.["phone"]);
  const phoneE164 = phone.length ? normalizePhoneE164(phone) : null;

  if (!orgContactId || !email || !name) {
    return NextResponse.json({ ok: false, error: "missing_required_fields" }, { status: 400 });
  }
  if (phone.length && !phoneE164) {
    return NextResponse.json({ ok: false, error: "invalid_phone" }, { status: 400 });
  }

  const db = getDb();
  const [org] = await db
    .select({ id: contacts.id, partnerStatus: contacts.partnerStatus, partnerSince: contacts.partnerSince })
    .from(contacts)
    .where(eq(contacts.id, orgContactId))
    .limit(1);
  if (!org?.id) {
    return NextResponse.json({ ok: false, error: "org_not_found" }, { status: 404 });
  }

  const now = new Date();
  const nowIso = now.toISOString();

  // If we're inviting someone into the Partner Portal, treat this org as an active partner.
  // Do not overwrite a more-specific status like "inactive" unless the owner explicitly changes it later.
  const status = typeof org.partnerStatus === "string" ? org.partnerStatus : "none";
  const promotable = status === "none" || status === "prospect" || status === "contacted";
  if (promotable) {
    await db
      .update(contacts)
      .set({
        partnerStatus: "partner",
        partnerSince: sql`coalesce(${contacts.partnerSince}, ${nowIso})`,
        updatedAt: now
      })
      .where(eq(contacts.id, orgContactId));
  }

  let userId: string | null = null;

  const [existing] = await db
    .select({
      id: partnerUsers.id,
      orgContactId: partnerUsers.orgContactId,
      phoneE164: partnerUsers.phoneE164
    })
    .from(partnerUsers)
    .where(eq(partnerUsers.email, email))
    .limit(1);

  if (phoneE164) {
    const [phoneTaken] = await db
      .select({ id: partnerUsers.id, orgContactId: partnerUsers.orgContactId })
      .from(partnerUsers)
      .where(eq(partnerUsers.phoneE164, phoneE164))
      .limit(1);

    if (phoneTaken?.id && phoneTaken.id !== existing?.id) {
      return NextResponse.json({ ok: false, error: "phone_already_used_by_other_partner" }, { status: 409 });
    }
  }

  if (existing?.id) {
    if (existing.orgContactId !== orgContactId) {
      return NextResponse.json({ ok: false, error: "email_already_used_by_other_partner" }, { status: 409 });
    }

    if (phoneE164 && existing.phoneE164 && existing.phoneE164 !== phoneE164) {
      return NextResponse.json({ ok: false, error: "phone_mismatch_for_existing_user" }, { status: 409 });
    }

    if (phoneE164 && !existing.phoneE164) {
      await db
        .update(partnerUsers)
        .set({ phone, phoneE164, updatedAt: now })
        .where(eq(partnerUsers.id, existing.id));
    }

    userId = existing.id;
  } else {
    const [created] = await db
      .insert(partnerUsers)
      .values({
        orgContactId,
        email,
        name,
        phone: phone.length ? phone : null,
        phoneE164,
        active: true,
        createdAt: now,
        updatedAt: now
      })
      .returning({ id: partnerUsers.id });
    userId = created?.id ?? null;
  }

  if (!userId) {
    return NextResponse.json({ ok: false, error: "create_failed" }, { status: 500 });
  }

  // Ensure a baseline rate card exists so the portal can show tiers instead of "call for pricing".
  // Does not overwrite existing negotiated rates.
  try {
    const [existingCard] = await db
      .select({ id: partnerRateCards.id })
      .from(partnerRateCards)
      .where(eq(partnerRateCards.orgContactId, orgContactId))
      .limit(1);

    const cardId = existingCard?.id ?? null;
    const defaultItems = [
      {
        serviceKey: "junk-removal",
        tierKey: "quarter",
        label: "Quarter load",
        amountCents: 15000,
        sortOrder: 1
      },
      {
        serviceKey: "junk-removal",
        tierKey: "half",
        label: "Half load",
        amountCents: 30000,
        sortOrder: 2
      },
      {
        serviceKey: "junk-removal",
        tierKey: "three_quarter",
        label: "3/4 load",
        amountCents: 45000,
        sortOrder: 3
      },
      {
        serviceKey: "junk-removal",
        tierKey: "full",
        label: "Full load",
        amountCents: 60000,
        sortOrder: 4
      },
      {
        serviceKey: "junk-removal",
        tierKey: "mattress_fee",
        label: "Mattress fee (each)",
        amountCents: 3000,
        sortOrder: 50
      },
      {
        serviceKey: "junk-removal",
        tierKey: "paint_fee",
        label: "Paint cans (each)",
        amountCents: 1000,
        sortOrder: 51
      },
      {
        serviceKey: "junk-removal",
        tierKey: "tire_fee",
        label: "Tires (each)",
        amountCents: 1000,
        sortOrder: 52
      },
      {
        serviceKey: "demo-hauloff",
        tierKey: "small",
        label: "Small demo",
        amountCents: 65000,
        sortOrder: 1
      },
      {
        serviceKey: "demo-hauloff",
        tierKey: "medium",
        label: "Medium demo",
        amountCents: 125000,
        sortOrder: 2
      },
      {
        serviceKey: "demo-hauloff",
        tierKey: "large",
        label: "Large demo",
        amountCents: 240000,
        sortOrder: 3
      },
      {
        serviceKey: "land-clearing",
        tierKey: "small_patch",
        label: "Small patch",
        amountCents: 85000,
        sortOrder: 1
      },
      {
        serviceKey: "land-clearing",
        tierKey: "yard_section",
        label: "Yard section",
        amountCents: 165000,
        sortOrder: 2
      },
      {
        serviceKey: "land-clearing",
        tierKey: "most_of_yard",
        label: "Most of a yard",
        amountCents: 320000,
        sortOrder: 3
      },
      {
        serviceKey: "land-clearing",
        tierKey: "full_lot",
        label: "Full lot (starting)",
        amountCents: 550000,
        sortOrder: 4
      },
      {
        serviceKey: "land-clearing",
        tierKey: "not_sure",
        label: "Not sure",
        amountCents: 165000,
        sortOrder: 50
      }
    ] as const;

    const [countRow] = cardId
      ? await db
          .select({ cnt: sql<number>`count(*)` })
          .from(partnerRateItems)
          .where(eq(partnerRateItems.rateCardId, cardId))
      : [{ cnt: 0 } as { cnt: number }];

    if (!cardId) {
      const [createdCard] = await db
        .insert(partnerRateCards)
        .values({ orgContactId, currency: "USD", active: true, createdAt: now, updatedAt: now })
        .returning({ id: partnerRateCards.id });

      const newCardId = createdCard?.id ?? null;
      if (newCardId) {
        await db.insert(partnerRateItems).values(
          defaultItems.map((item) => ({
            rateCardId: newCardId,
            ...item
          }))
        );
      }
    } else if ((countRow?.cnt ?? 0) === 0) {
      await db.insert(partnerRateItems).values(
        defaultItems.map((item) => ({
          rateCardId: cardId,
          ...item
        }))
      );
    } else {
      // Backfill missing defaults for existing partners (idempotent; avoids duplicates).
      const rows = await db
        .select({ serviceKey: partnerRateItems.serviceKey, tierKey: partnerRateItems.tierKey })
        .from(partnerRateItems)
        .where(eq(partnerRateItems.rateCardId, cardId));

      const existingKeys = new Set(rows.map((r) => `${(r.serviceKey ?? "").toLowerCase()}:${r.tierKey ?? ""}`));
      const missing = defaultItems.filter((item) => !existingKeys.has(`${item.serviceKey}:${item.tierKey}`));

      if (missing.length) {
        await db.insert(partnerRateItems).values(
          missing.map((item) => ({
            rateCardId: cardId,
            ...item,
            createdAt: now
          }))
        );
      }
    }
  } catch {
    // ignore
  }

  const siteBaseUrl = resolvePublicSiteBaseUrl() ?? resolveRequestOriginBaseUrl(request);
  if (siteBaseUrl) {
    try {
      const { rawToken, expiresAt } = await createPartnerLoginToken(userId, request, 30);
      const url = new URL("/partners/auth", siteBaseUrl);
      url.searchParams.set("token", rawToken);

      const subject = "You've been invited to the Stonegate Partner Portal";
      const body = [
        `Hi ${name},`,
        "",
        "You now have access to the Stonegate Partner Portal to request and schedule service.",
        "",
        "Use this link to log in (expires in ~30 minutes):",
        url.toString(),
        "",
        `Expires at: ${expiresAt.toISOString()}`,
        "",
        "After login, you can optionally set a password for faster sign-in next time."
      ].join("\n");

      const smsBody = `Stonegate Partner Portal invite: ${url.toString()} (expires ${expiresAt.toISOString()})`;

      await Promise.allSettled([
        sendEmailMessage(email, subject, body),
        phoneE164 ? sendSmsMessage(phoneE164, smsBody) : Promise.resolve()
      ]);
    } catch {
      // ignore
    }
  }

  const [user] = await db
    .select({
      id: partnerUsers.id,
      orgContactId: partnerUsers.orgContactId,
      email: partnerUsers.email,
      phone: partnerUsers.phone,
      phoneE164: partnerUsers.phoneE164,
      name: partnerUsers.name,
      active: partnerUsers.active,
      createdAt: partnerUsers.createdAt
    })
    .from(partnerUsers)
    .where(and(eq(partnerUsers.id, userId), eq(partnerUsers.orgContactId, orgContactId)))
    .limit(1);

  return NextResponse.json({
    ok: true,
    user: user
      ? {
          ...user,
          createdAt: user.createdAt.toISOString()
        }
      : null
  });
}
