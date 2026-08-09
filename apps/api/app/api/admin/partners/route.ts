import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  ilike,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { contacts, getDb, teamMembers } from "@/db";
import {
  buildPartnerPageMetadata,
  parsePartnerListQuery,
  type PartnerCursor,
  type PartnerSortKey,
} from "@/lib/partner-query";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../web/admin";

const NEXT_TOUCH_SORT = sql<string>`coalesce(extract(epoch from ${contacts.partnerNextTouchAt}), 999999999999999999::numeric)`;
const LAST_TOUCH_SORT = sql<string>`coalesce(-extract(epoch from ${contacts.partnerLastTouchAt}), 999999999999999999::numeric)`;

function invalidFilter(field: string, message: string): NextResponse {
  return NextResponse.json(
    { error: "invalid_filter", field, message },
    { status: 422, headers: { "Cache-Control": "private, no-store" } },
  );
}

function escapedSearchPattern(value: string): string {
  return `%${value
    .replace(/\\/gu, "\\\\")
    .replace(/[%_]/gu, "\\$&")
    .replace(/\s+/gu, "%")}%`;
}

function paginationPredicate(cursor: PartnerCursor): SQL {
  const operator = cursor.direction === "previous" ? sql`<` : sql`>`;
  return sql`(
    ${NEXT_TOUCH_SORT},
    ${LAST_TOUCH_SORT},
    ${contacts.id}
  ) ${operator} (
    ${cursor.nextSort}::numeric,
    ${cursor.lastSort}::numeric,
    ${cursor.id}::uuid
  )`;
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "partners.read");
  if (permissionError) return permissionError;

  const parsed = parsePartnerListQuery(request.nextUrl.searchParams);
  if (!parsed.ok) return invalidFilter(parsed.field, parsed.message);
  const { query } = parsed;
  const snapshotAt = query.cursor
    ? new Date(query.cursor.snapshotAt)
    : new Date();
  const searchPattern = query.q ? escapedSearchPattern(query.q) : null;
  const baseFilters: SQL[] = [
    eq(contacts.partnerStatus, query.status),
    isNull(contacts.deletedAt),
    lte(contacts.createdAt, snapshotAt),
    lte(contacts.updatedAt, snapshotAt),
  ];
  if (query.ownerId) {
    baseFilters.push(eq(contacts.partnerOwnerMemberId, query.ownerId));
  }
  if (query.type) {
    baseFilters.push(sql`lower(${contacts.partnerType}) = ${query.type}`);
  }
  if (searchPattern) {
    baseFilters.push(
      or(
        ilike(contacts.company, searchPattern),
        ilike(contacts.firstName, searchPattern),
        ilike(contacts.lastName, searchPattern),
        ilike(contacts.email, searchPattern),
        ilike(contacts.phone, searchPattern),
        ilike(contacts.phoneE164, searchPattern),
      )!,
    );
  }

  try {
    const pageResult = await getDb().transaction(async (tx) => {
      await tx.execute(
        sql`set transaction isolation level repeatable read read only`,
      );
      if (query.cursor) {
        // Contacts do not retain historical row versions. Invalidating on any
        // contact update is deliberately conservative: it prevents a record
        // that changed filters or sort keys after page one from disappearing
        // silently. A future partner-specific revision counter can narrow this
        // check without weakening snapshot correctness.
        const [changedContact] = await tx
          .select({ id: contacts.id })
          .from(contacts)
          .where(gt(contacts.updatedAt, snapshotAt))
          .limit(1);
        if (changedContact) return { kind: "stale" as const };

        const [anchor] = await tx
          .select({ id: contacts.id })
          .from(contacts)
          .where(
            and(
              ...baseFilters,
              eq(contacts.id, query.cursor.id),
              sql`${NEXT_TOUCH_SORT} = ${query.cursor.nextSort}::numeric`,
              sql`${LAST_TOUCH_SORT} = ${query.cursor.lastSort}::numeric`,
            ),
          )
          .limit(1);
        if (!anchor) return { kind: "stale" as const };
      }

      const totalAtSnapshot = query.cursor
        ? query.cursor.totalAtSnapshot
        : Number(
            (
              await tx
                .select({ count: sql<number>`count(*)` })
                .from(contacts)
                .where(and(...baseFilters))
            )[0]?.count ?? 0,
          );
      const pageFilters = query.cursor
        ? [...baseFilters, paginationPredicate(query.cursor)]
        : baseFilters;
      const reverse = query.cursor?.direction === "previous";
      const rows = await tx
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
          updatedAt: contacts.updatedAt,
          ownerName: teamMembers.name,
          nextSort: NEXT_TOUCH_SORT.as("partner_next_sort"),
          lastSort: LAST_TOUCH_SORT.as("partner_last_sort"),
        })
        .from(contacts)
        .leftJoin(
          teamMembers,
          eq(contacts.partnerOwnerMemberId, teamMembers.id),
        )
        .where(and(...pageFilters))
        .orderBy(
          ...(reverse
            ? [desc(NEXT_TOUCH_SORT), desc(LAST_TOUCH_SORT), desc(contacts.id)]
            : [asc(NEXT_TOUCH_SORT), asc(LAST_TOUCH_SORT), asc(contacts.id)]),
        )
        .limit(query.limit + 1);

      const hasExtra = rows.length > query.limit;
      const selected = hasExtra ? rows.slice(0, query.limit) : rows;
      const visible = reverse ? selected.reverse() : selected;
      if (query.cursor && visible.length === 0) {
        return { kind: "stale" as const };
      }
      const hasPrevious = reverse ? hasExtra : Boolean(query.cursor);
      const hasNext = reverse ? true : hasExtra;
      const sortKeys: PartnerSortKey[] = visible.map((row) => ({
        nextSort: String(row.nextSort),
        lastSort: String(row.lastSort),
        id: row.id,
      }));
      const page = buildPartnerPageMetadata({
        limit: query.limit,
        filterHash: query.filterHash,
        snapshotAt: snapshotAt.toISOString(),
        totalAtSnapshot,
        visible: sortKeys,
        position: query.cursor ? "history" : "start",
        hasPrevious,
        hasNext,
      });
      return { kind: "page" as const, rows: visible, page };
    });

    if (pageResult.kind === "stale") {
      return NextResponse.json(
        {
          error: "partner_page_changed",
          message:
            "This partner-page snapshot changed. Return to the first page and refresh the list.",
        },
        { status: 409, headers: { "Cache-Control": "private, no-store" } },
      );
    }

    return NextResponse.json(
      {
        ok: true,
        total: pageResult.page.totalAtSnapshot,
        limit: pageResult.page.limit,
        page: pageResult.page,
        partners: pageResult.rows.map((row) => {
          const name =
            [row.firstName, row.lastName].filter(Boolean).join(" ").trim() ||
            "Contact";
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
            partnerSince: row.partnerSince
              ? row.partnerSince.toISOString()
              : null,
            partnerLastTouchAt: row.partnerLastTouchAt
              ? row.partnerLastTouchAt.toISOString()
              : null,
            partnerNextTouchAt: row.partnerNextTouchAt
              ? row.partnerNextTouchAt.toISOString()
              : null,
            partnerReferralCount: row.partnerReferralCount ?? 0,
            partnerLastReferralAt: row.partnerLastReferralAt
              ? row.partnerLastReferralAt.toISOString()
              : null,
            version: row.updatedAt.toISOString(),
          };
        }),
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    console.error("[partners] list_failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      {
        error: "partner_list_failed",
        message: "The partner list could not be loaded. Try again.",
      },
      { status: 500, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}
