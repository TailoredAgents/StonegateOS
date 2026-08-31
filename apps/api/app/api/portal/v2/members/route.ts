import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import { arePartnerPortalV2ReadsEnabled } from "@/lib/partner-portal-feature-flags";
import {
  listPartnerAccountMembers,
  type PartnerMemberCursor,
  type PartnerMemberStatusFilter,
} from "@/lib/partner-portal-v2-members";
import {
  createPortalV2ErrorResponse,
  encodePortalV2Cursor,
  parsePortalV2Pagination,
  readPortalV2CorrelationId,
} from "@/lib/portal-v2-contract";
import {
  createPartnerPortalV2DescriptorResponse,
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";
import { isPortalV2Uuid } from "@/lib/partner-portal-v2-security";

const ALLOWED_QUERY_KEYS = new Set(["search", "status"]);
const MEMBER_STATUSES = new Set<PartnerMemberStatusFilter>([
  "all",
  "invited",
  "active",
  "suspended",
  "removed",
]);

function isMemberCursor(value: unknown): value is PartnerMemberCursor {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    Object.keys(row).sort().join(",") === "accountId,filterHash,id,name" &&
    isPortalV2Uuid(row["accountId"]) &&
    typeof row["filterHash"] === "string" &&
    /^[0-9a-f]{64}$/u.test(row["filterHash"]) &&
    typeof row["name"] === "string" &&
    row["name"].length <= 160 &&
    isPortalV2Uuid(row["id"])
  );
}

export async function GET(request: NextRequest): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  const authorization = await requirePartnerCapability(
    request,
    "account.members.read",
  );
  if (!authorization.ok) {
    return createPartnerPortalV2ErrorResponse(
      authorization.error,
      authorization.status,
      correlationId,
    );
  }
  const { principal } = authorization;
  if (!principal.accountId || !principal.membershipId) {
    return createPartnerPortalV2ErrorResponse(
      "legacy_scope_unavailable",
      409,
      correlationId,
    );
  }
  if (!arePartnerPortalV2ReadsEnabled(principal.accountId)) {
    return createPartnerPortalV2ErrorResponse(
      "service_unavailable",
      503,
      correlationId,
    );
  }

  const params = request.nextUrl.searchParams;
  const pagination = parsePortalV2Pagination(params, {
    cursorKind: "partner_members",
    validateCursorPayload: isMemberCursor,
    defaultLimit: 50,
    maximumLimit: 100,
    allowedQueryKeys: ALLOWED_QUERY_KEYS,
  });
  if (!pagination.ok) {
    return createPartnerPortalV2DescriptorResponse(
      createPortalV2ErrorResponse("invalid_cursor", correlationId, {
        fieldErrors: pagination.fieldErrors,
      }),
    );
  }
  const statusValues = params.getAll("status");
  const searchValues = params.getAll("search");
  const rawStatus = statusValues[0]?.trim() || "all";
  const rawSearch = searchValues[0]?.trim() || null;
  if (
    statusValues.length > 1 ||
    searchValues.length > 1 ||
    !MEMBER_STATUSES.has(rawStatus as PartnerMemberStatusFilter) ||
    (rawSearch && rawSearch.length > 100)
  ) {
    return createPartnerPortalV2ErrorResponse(
      "invalid_fields",
      422,
      correlationId,
    );
  }
  const status = rawStatus as PartnerMemberStatusFilter;
  const search = rawSearch?.toLowerCase() ?? null;
  const filterHash = createHash("sha256")
    .update(JSON.stringify({ search, status }), "utf8")
    .digest("hex");
  const cursor = pagination.cursor?.payload ?? null;
  if (
    cursor &&
    (cursor.accountId !== principal.accountId ||
      cursor.filterHash !== filterHash)
  ) {
    return createPartnerPortalV2ErrorResponse(
      "invalid_cursor",
      422,
      correlationId,
    );
  }

  try {
    const result = await listPartnerAccountMembers({
      principal,
      filterHash,
      status,
      search,
      cursor,
      limit: pagination.limit,
    });
    const nextCursor = result.next
      ? encodePortalV2Cursor({
          kind: "partner_members",
          limit: pagination.limit,
          payload: {
            accountId: principal.accountId,
            filterHash,
            name: result.next.name,
            id: result.next.id,
          } satisfies PartnerMemberCursor,
        })
      : null;
    return createPartnerPortalV2SuccessResponse(
      {
        ok: true,
        members: result.members,
        roles: result.roles,
        invitation: {
          available: principal.capabilities.includes("account.members.manage"),
          reason: principal.capabilities.includes("account.members.manage")
            ? null
            : "An account administrator can invite teammates.",
        },
        page: {
          limit: pagination.limit,
          nextCursor,
          hasMore: Boolean(nextCursor),
        },
      },
      correlationId,
    );
  } catch (error) {
    console.error("[partner-portal-v2] member list failed", {
      correlationId,
      accountId: principal.accountId,
      error: error instanceof Error ? error.name : "unknown",
    });
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
