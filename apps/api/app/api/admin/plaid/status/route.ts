import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getDb, plaidItems, plaidAccounts, plaidTransactions } from "@/db";
import { isAdminRequest } from "../../../web/admin";
import { eq, inArray } from "drizzle-orm";
import { plaidConfigured } from "@/lib/plaid";

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!plaidConfigured()) {
    return NextResponse.json({ ok: false, configured: false });
  }

  const db = getDb();
  const items = await db.select().from(plaidItems);
  const result: Array<{
    id: string;
    institutionName: string | null;
    accounts: number;
    transactions: number;
    cursor: string | null;
  }> = [];
  for (const item of items) {
    const accounts = await db.select().from(plaidAccounts).where(eq(plaidAccounts.itemId, item.id));
    const acctIds = accounts.map((a) => a.id);
    let txnCount = 0;
    if (acctIds.length) {
      const txns = await db
        .select({ id: plaidTransactions.id })
        .from(plaidTransactions)
        .where(inArray(plaidTransactions.accountId, acctIds));
      txnCount = txns.length;
    }
    result.push({
      id: item.id,
      institutionName: item.institutionName ?? null,
      accounts: accounts.length,
      transactions: txnCount,
      cursor: item.cursor ?? null
    });
  }

  return NextResponse.json({
    ok: true,
    configured: true,
    items: result
  });
}
