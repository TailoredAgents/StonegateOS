import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import type { SQL } from "drizzle-orm";
import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { contacts, getDb, mergeSuggestions, teamMembers } from "@/db";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../web/admin";

const STATUSES = ["pending", "approved", "declined"] as const;
type SuggestionStatus = (typeof STATUSES)[number];

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_SEARCH_LENGTH = 100;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function recoveryLedgerIdFromMeta(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = (value as Record<string, unknown>)["recoveryLedgerId"];
  return typeof candidate === "string" && UUID_PATTERN.test(candidate)
    ? candidate
    : null;
}

function parseLimit(value: string | null): number {
  if (!value) return DEFAULT_LIMIT;
  const parsed = Number(value);
  if (Number.isNaN(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(parsed), MAX_LIMIT);
}

function parseOffset(value: string | null): number {
  if (!value) return 0;
  const parsed = Number(value);
  if (Number.isNaN(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function isStatus(value: string | null): value is SuggestionStatus {
  return value ? (STATUSES as readonly string[]).includes(value) : false;
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "contacts.merge");
  if (permissionError) return permissionError;

  const { searchParams } = request.nextUrl;
  const statusParam = searchParams.get("status");
  if (statusParam && statusParam !== "all" && !isStatus(statusParam)) {
    return NextResponse.json(
      { error: "invalid_status", retryable: false },
      { status: 422 },
    );
  }
  const status = isStatus(statusParam)
    ? statusParam
    : statusParam === "all"
      ? "all"
      : "pending";
  const limit = parseLimit(searchParams.get("limit"));
  const offset = parseOffset(searchParams.get("offset"));
  const q = (searchParams.get("q") ?? "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_SEARCH_LENGTH);

  const db = getDb();
  const filters: SQL<unknown>[] = [];
  if (status !== "all") {
    filters.push(eq(mergeSuggestions.status, status));
  }

  if (q.length > 0) {
    const escaped = q.replace(/[%_]/gu, "\\$&");
    const pattern = `%${escaped.replace(/\s+/gu, "%")}%`;
    const matches = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        or(
          ilike(contacts.firstName, pattern),
          ilike(contacts.lastName, pattern),
          ilike(contacts.email, pattern),
          ilike(contacts.phone, pattern),
          ilike(contacts.phoneE164, pattern),
        ),
      );
    const matchingContactIds = Array.from(
      new Set(matches.map((row) => row.id)),
    );
    filters.push(
      matchingContactIds.length > 0
        ? or(
            inArray(mergeSuggestions.sourceContactId, matchingContactIds),
            inArray(mergeSuggestions.targetContactId, matchingContactIds),
          )!
        : sql`false`,
    );
  }

  const whereClause = filters.length > 0 ? and(...filters) : undefined;

  const totalResult = whereClause
    ? await db
        .select({ count: sql<number>`count(*)` })
        .from(mergeSuggestions)
        .where(whereClause)
    : await db.select({ count: sql<number>`count(*)` }).from(mergeSuggestions);
  const total = Number(totalResult[0]?.count ?? 0);

  const rows = await (
    whereClause
      ? db
          .select({
            id: mergeSuggestions.id,
            status: mergeSuggestions.status,
            reason: mergeSuggestions.reason,
            confidence: mergeSuggestions.confidence,
            meta: mergeSuggestions.meta,
            reviewedBy: mergeSuggestions.reviewedBy,
            reviewedAt: mergeSuggestions.reviewedAt,
            createdAt: mergeSuggestions.createdAt,
            updatedAt: mergeSuggestions.updatedAt,
            sourceContactId: mergeSuggestions.sourceContactId,
            targetContactId: mergeSuggestions.targetContactId,
          })
          .from(mergeSuggestions)
          .where(whereClause)
      : db
          .select({
            id: mergeSuggestions.id,
            status: mergeSuggestions.status,
            reason: mergeSuggestions.reason,
            confidence: mergeSuggestions.confidence,
            meta: mergeSuggestions.meta,
            reviewedBy: mergeSuggestions.reviewedBy,
            reviewedAt: mergeSuggestions.reviewedAt,
            createdAt: mergeSuggestions.createdAt,
            updatedAt: mergeSuggestions.updatedAt,
            sourceContactId: mergeSuggestions.sourceContactId,
            targetContactId: mergeSuggestions.targetContactId,
          })
          .from(mergeSuggestions)
  )
    .orderBy(desc(mergeSuggestions.createdAt))
    .limit(limit)
    .offset(offset);

  const contactIds = Array.from(
    new Set(rows.flatMap((row) => [row.sourceContactId, row.targetContactId])),
  ).filter(Boolean);

  const contactsRows =
    contactIds.length > 0
      ? await db
          .select({
            id: contacts.id,
            firstName: contacts.firstName,
            lastName: contacts.lastName,
            email: contacts.email,
            phone: contacts.phone,
            phoneE164: contacts.phoneE164,
          })
          .from(contacts)
          .where(inArray(contacts.id, contactIds))
      : [];

  const contactMap = new Map(
    contactsRows.map((row) => [
      row.id,
      {
        id: row.id,
        name:
          [row.firstName, row.lastName].filter(Boolean).join(" ").trim() ||
          "Contact",
        email: row.email ?? null,
        phone: row.phoneE164 ?? row.phone ?? null,
      },
    ]),
  );

  const reviewerIds = Array.from(
    new Set(rows.map((row) => row.reviewedBy).filter(Boolean)),
  ) as string[];
  const reviewerRows =
    reviewerIds.length > 0
      ? await db
          .select({
            id: teamMembers.id,
            name: teamMembers.name,
          })
          .from(teamMembers)
          .where(inArray(teamMembers.id, reviewerIds))
      : [];

  const reviewerMap = new Map(reviewerRows.map((row) => [row.id, row.name]));

  const suggestions = rows.map((row) => ({
    id: row.id,
    status: row.status,
    reason: row.reason,
    confidence: row.confidence,
    meta: row.meta ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    reviewer: row.reviewedBy
      ? {
          id: row.reviewedBy,
          name: reviewerMap.get(row.reviewedBy) ?? "Reviewer",
        }
      : null,
    recoveryLedgerId: recoveryLedgerIdFromMeta(row.meta),
    sourceContact: contactMap.get(row.sourceContactId) ?? null,
    targetContact: contactMap.get(row.targetContactId) ?? null,
  }));

  const nextOffset = offset + suggestions.length;

  return NextResponse.json({
    suggestions,
    filters: { q, status },
    pagination: {
      limit,
      offset,
      total,
      nextOffset: nextOffset < total ? nextOffset : null,
    },
  });
}
