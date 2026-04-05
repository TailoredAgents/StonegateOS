import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import { contacts, crmTasks, getDb } from "@/db";
import { isAdminRequest } from "../../../../web/admin";
import { requirePermission } from "@/lib/permissions";
import {
  resolveOrCreatePartnerAccount,
} from "@/lib/partner-accounts";

function parseLimit(value: string | null): number {
  if (!value) return 250;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 250;
  return Math.min(Math.floor(parsed), 2000);
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "appointments.update");
  if (permissionError) return permissionError;

  const url = new URL(request.url);
  const limit = parseLimit(url.searchParams.get("limit"));
  const db = getDb();
  const now = new Date();

  const rows = await db
    .select({
      id: contacts.id,
      company: contacts.company,
      email: contacts.email,
      source: contacts.source,
      partnerStatus: contacts.partnerStatus,
      salespersonMemberId: contacts.salespersonMemberId,
      partnerOwnerMemberId: contacts.partnerOwnerMemberId,
      partnerAccountId: contacts.partnerAccountId
    })
    .from(contacts)
    .where(
      and(
        isNull(contacts.partnerAccountId),
        or(
          sql`lower(coalesce(${contacts.source}, '')) like 'outbound:%'`,
          ne(contacts.partnerStatus, "none")
        )
      )
    )
    .limit(limit);

  let scanned = 0;
  let linkedContacts = 0;
  let linkedTasks = 0;
  let skipped = 0;

  for (const row of rows) {
    scanned += 1;
    const source = row.source ?? null;
    const sourceCampaign =
      typeof source === "string" && source.toLowerCase().startsWith("outbound:")
        ? source.slice("outbound:".length).trim() || null
        : null;

    const account = await resolveOrCreatePartnerAccount(db as any, {
      name: row.company,
      domain: row.email ?? null,
      source,
      sourceCampaign,
      ownerMemberId: row.partnerOwnerMemberId ?? row.salespersonMemberId ?? null
    });

    if (!account?.id) {
      skipped += 1;
      continue;
    }

    await db
      .update(contacts)
      .set({ partnerAccountId: account.id, updatedAt: now })
      .where(eq(contacts.id, row.id));
    linkedContacts += 1;

    const taskResult = await db
      .update(crmTasks)
      .set({ partnerAccountId: account.id, updatedAt: now })
      .where(and(eq(crmTasks.contactId, row.id), isNull(crmTasks.partnerAccountId)))
      .returning({ id: crmTasks.id });

    linkedTasks += taskResult.length;
  }

  return NextResponse.json({
    ok: true,
    scanned,
    linkedContacts,
    linkedTasks,
    skipped
  });
}
