import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, asc, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { contacts, getDb, teamMembers } from "@/db";
import { isAdminRequest } from "../../web/admin";
import { requirePermission } from "@/lib/permissions";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const STATUSES = ["partner", "prospect", "contacted", "inactive", "none"] as const;

type PartnerStatus = (typeof STATUSES)[number];

function parseLimit(value: string | null): number {
  if (!value) return DEFAULT_LIMIT;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(parsed), MAX_LIMIT);
}

function parseOffset(value: string | null): number {
  if (!value) return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function normalizeSearch(term: string): string {
  return term.replace(/[%_]/g, "\\$&").replace(/\s+/g, " ").trim();
}

function parseStatus(value: string | null): PartnerStatus {
  const key = value?.trim().toLowerCase() ?? "";
  return (STATUSES as readonly string[]).includes(key) ? (key as PartnerStatus) : "partner";
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "appointments.read");
  if (permissionError) return permissionError;

  const db = getDb();
  const { searchParams } = request.nextUrl;
  const status = parseStatus(searchParams.get("status"));
  const ownerId = searchParams.get("ownerId")?.trim() || "";
  const partnerType = searchParams.get("type")?.trim() || "";
  const qRaw = searchParams.get("q");
  const q = qRaw ? normalizeSearch(qRaw) : "";
  const limit = parseLimit(searchParams.get("limit"));
  const offset = parseOffset(searchParams.get("offset"));

  const filters: any[] = [];
  if (status !== "none") {
    filters.push(eq(contacts.partnerStatus, status));
  } else {
    filters.push(eq(contacts.partnerStatus, "none"));
  }

  if (ownerId) {
    filters.push(eq(contacts.partnerOwnerMemberId, ownerId));
  }
  if (partnerType) {
    filters.push(eq(contacts.partnerType, partnerType));
  }
  if (q) {
    const likePattern = `%${q.replace(/\s+/g, "%")}%`;
    filters.push(
      or(
        ilike(contacts.company, likePattern),
        ilike(contacts.firstName, likePattern),
        ilike(contacts.lastName, likePattern),
        ilike(contacts.email, likePattern),
        ilike(contacts.phone, likePattern),
        ilike(contacts.phoneE164, likePattern)
      )
    );
  }

  const whereClause = filters.length ? and(...filters) : undefined;

  const totalRows = await db
    .select({ count: sql<number>`count(*)` })
    .from(contacts)
    .where(whereClause);
  const total = Number(totalRows[0]?.count ?? 0);

  const rows = await db
    .select({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      company: contacts.company,
      email: contacts.email,
      phone: contacts.phone,
      phoneE164: contacts.phoneE164,
      partnerStatus: contacts.partnerStatus,
      partnerType: contacts.partnerType,
      partnerOwnerMemberId: contacts.partnerOwnerMemberId,
      partnerSince: contacts.partnerSince,
      partnerLastTouchAt: contacts.partnerLastTouchAt,
      partnerNextTouchAt: contacts.partnerNextTouchAt,
      partnerReferralCount: contacts.partnerReferralCount,
      partnerLastReferralAt: contacts.partnerLastReferralAt,
      ownerName: teamMembers.name
    })
    .from(contacts)
    .leftJoin(teamMembers, eq(contacts.partnerOwnerMemberId, teamMembers.id))
    .where(whereClause)
    .orderBy(
      sql`${contacts.partnerNextTouchAt} asc nulls last`,
      desc(contacts.partnerLastTouchAt),
      asc(contacts.company),
      asc(contacts.lastName),
      asc(contacts.firstName)
    )
    .limit(limit)
    .offset(offset);

  return NextResponse.json({
    ok: true,
    total,
    offset,
    limit,
    partners: rows.map((row) => {
      const name = [row.firstName, row.lastName].filter(Boolean).join(" ").trim() || "Contact";
      return {
        id: row.id,
        company: row.company ?? null,
        name,
        email: row.email ?? null,
        phone: row.phoneE164 ?? row.phone ?? null,
        partnerStatus: row.partnerStatus,
        partnerType: row.partnerType ?? null,
        partnerOwnerMemberId: row.partnerOwnerMemberId ?? null,
        partnerOwnerName: row.ownerName ?? null,
        partnerSince: row.partnerSince ? row.partnerSince.toISOString() : null,
        partnerLastTouchAt: row.partnerLastTouchAt ? row.partnerLastTouchAt.toISOString() : null,
        partnerNextTouchAt: row.partnerNextTouchAt ? row.partnerNextTouchAt.toISOString() : null,
        partnerReferralCount: row.partnerReferralCount ?? 0,
        partnerLastReferralAt: row.partnerLastReferralAt ? row.partnerLastReferralAt.toISOString() : null
      };
    })
  });
}

