import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { isAdminRequest } from "../../../web/admin";
import { getPlaidClient, plaidConfigured } from "@/lib/plaid";
import { getDb, plaidItems, plaidAccounts, plaidTransactions } from "@/db";
import { eq, inArray } from "drizzle-orm";

type SyncRequest = { itemId?: string };

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!plaidConfigured()) {
    return NextResponse.json({ error: "plaid_not_configured" }, { status: 503 });
  }
  const plaid = getPlaidClient();
  if (!plaid) return NextResponse.json({ error: "plaid_not_configured" }, { status: 503 });

  const payload = (await request.json().catch(() => ({}))) as SyncRequest;
  const db = getDb();
  const items = await db.select().from(plaidItems).where(payload.itemId ? eq(plaidItems.id, payload.itemId) : undefined);
  if (!items.length) {
    return NextResponse.json({ error: "no_items" }, { status: 400 });
  }

  let synced = 0;
  for (const item of items) {
    let cursor = item.cursor ?? null;
    let hasMore = true;
    while (hasMore) {
      const res = await plaid.transactionsSync({
        access_token: item.accessToken,
        cursor: cursor ?? undefined,
        count: 100
      });
      const added = res.data.added ?? [];
      const modified = res.data.modified ?? [];
      const accountsRes = res.data.accounts ?? [];

      // Upsert accounts
      for (const acct of accountsRes) {
        const available = acct.balances.available ?? null;
        const current = acct.balances.current ?? null;
        await db
          .insert(plaidAccounts)
          .values({
            itemId: item.id,
            accountId: acct.account_id,
            name: acct.name ?? null,
            officialName: acct.official_name ?? null,
            mask: acct.mask ?? null,
            type: acct.type ?? null,
            subtype: acct.subtype ?? null,
            isoCurrencyCode: acct.balances.iso_currency_code ?? null,
            available: available !== null ? available : null,
            current: current !== null ? current : null
          })
          .onConflictDoUpdate({
            target: plaidAccounts.accountId,
            set: {
              name: acct.name ?? null,
              officialName: acct.official_name ?? null,
              mask: acct.mask ?? null,
              type: acct.type ?? null,
              subtype: acct.subtype ?? null,
              isoCurrencyCode: acct.balances.iso_currency_code ?? null,
              available: available !== null ? available : null,
              current: current !== null ? current : null,
              updatedAt: new Date()
            }
          });
      }

      // Map account_id to db id
      const accountIds = accountsRes.map((a) => a.account_id);
      const dbAccounts =
        accountIds.length > 0
          ? await db.select().from(plaidAccounts).where(inArray(plaidAccounts.accountId, accountIds))
          : [];
      const accountIdMap = new Map<string, string>();
      for (const acct of dbAccounts) {
        accountIdMap.set(acct.accountId, acct.id);
      }

      const upsertTxn = async (txn: (typeof added)[number]) => {
        const accountDbId = accountIdMap.get(txn.account_id);
        if (!accountDbId) return;
        const amountCents = Math.round((txn.amount ?? 0) * 100);
        await db
          .insert(plaidTransactions)
          .values({
            accountId: accountDbId,
            transactionId: txn.transaction_id,
            name: txn.name ?? null,
            merchantName: txn.merchant_name ?? null,
            amount: amountCents,
            isoCurrencyCode: txn.iso_currency_code ?? null,
            date: new Date(txn.date ?? new Date().toISOString()),
            pending: Boolean(txn.pending),
            category: txn.category as string[] | null,
            raw: txn as Record<string, unknown>
          })
          .onConflictDoUpdate({
            target: plaidTransactions.transactionId,
            set: {
              name: txn.name ?? null,
              merchantName: txn.merchant_name ?? null,
              amount: amountCents,
              isoCurrencyCode: txn.iso_currency_code ?? null,
              date: new Date(txn.date ?? new Date().toISOString()),
              pending: Boolean(txn.pending),
              category: (txn.category as string[] | null) ?? null,
              raw: txn as Record<string, unknown>,
              updatedAt: new Date()
            }
          });
      };

      for (const txn of added) {
        await upsertTxn(txn);
        synced += 1;
      }
      for (const txn of modified) {
        await upsertTxn(txn);
      }

      cursor = res.data.next_cursor ?? cursor;
      hasMore = Boolean(res.data.has_more);
    }

    // Update cursor
    await db
      .update(plaidItems)
      .set({ cursor })
      .where(eq(plaidItems.id, item.id));
  }

  return NextResponse.json({ ok: true, synced });
}
