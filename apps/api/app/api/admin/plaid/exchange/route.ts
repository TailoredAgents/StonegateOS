import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getPlaidClient, plaidConfigured } from "@/lib/plaid";
import { isAdminRequest } from "../../../web/admin";
import { getDb, plaidItems, plaidAccounts } from "@/db";
import { eq, type InferInsertModel } from "drizzle-orm";

type ExchangeRequest = {
  public_token?: string;
  institution?: { name?: string; id?: string };
};

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!plaidConfigured()) {
    return NextResponse.json({ error: "plaid_not_configured" }, { status: 503 });
  }
  const plaid = getPlaidClient();
  if (!plaid) return NextResponse.json({ error: "plaid_not_configured" }, { status: 503 });

  const payload = (await request.json().catch(() => ({}))) as ExchangeRequest;
  const publicToken = payload.public_token;
  if (!publicToken || typeof publicToken !== "string") {
    return NextResponse.json({ error: "missing_public_token" }, { status: 400 });
  }

  try {
    const exchange = await plaid.itemPublicTokenExchange({ public_token: publicToken });
    const accessToken = exchange.data.access_token;
    const itemId = exchange.data.item_id;

    // Upsert item
    const db = getDb();
    const [item] = await db
      .insert(plaidItems)
      .values({
        itemId,
        accessToken,
        institutionId: payload.institution?.id ?? null,
        institutionName: payload.institution?.name ?? null
      })
      .onConflictDoUpdate({
        target: plaidItems.itemId,
        set: {
          accessToken,
          institutionId: payload.institution?.id ?? null,
          institutionName: payload.institution?.name ?? null,
          updatedAt: new Date()
        }
      })
      .returning();
    if (!item) {
      return NextResponse.json({ error: "plaid_item_upsert_failed" }, { status: 500 });
    }

    // Fetch accounts for this item and upsert
    const accountsRes = await plaid.accountsGet({ access_token: accessToken });
    for (const acct of accountsRes.data.accounts ?? []) {
      const available = acct.balances.available ?? null;
      const current = acct.balances.current ?? null;
      const insertPayload: InferInsertModel<typeof plaidAccounts> = {
        itemId: item.id,
        accountId: acct.account_id,
        name: acct.name ?? null,
        officialName: acct.official_name ?? null,
        mask: acct.mask ?? null,
        type: acct.type ?? null,
        subtype: acct.subtype ?? null,
        isoCurrencyCode: acct.balances.iso_currency_code ?? null,
        available: available !== null ? String(available) : null,
        current: current !== null ? String(current) : null
      };
      await db
        .insert(plaidAccounts)
        .values(insertPayload)
        .onConflictDoUpdate({
          target: plaidAccounts.accountId,
          set: {
            name: acct.name ?? null,
            officialName: acct.official_name ?? null,
            mask: acct.mask ?? null,
            type: acct.type ?? null,
            subtype: acct.subtype ?? null,
            isoCurrencyCode: acct.balances.iso_currency_code ?? null,
            available: insertPayload.available,
            current: insertPayload.current,
            updatedAt: new Date()
          }
        });
    }

    // Return a brief status
    const itemAccounts = await db.select().from(plaidAccounts).where(eq(plaidAccounts.itemId, item.id));
    return NextResponse.json({
      ok: true,
      item: {
        id: item.id,
        itemId,
        institutionName: item.institutionName,
        accounts: itemAccounts.length
      }
    });
  } catch (error) {
    console.error("[plaid] exchange_error", error);
    return NextResponse.json({ error: "plaid_exchange_failed" }, { status: 500 });
  }
}
