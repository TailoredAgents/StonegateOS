import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import { and, asc, eq, gt, ilike, or } from "drizzle-orm";
import { auditLogs, getDb, partnerAccountLocations } from "@/db";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { forwardGeocode } from "@/lib/geocode";
import {
  encryptPartnerLocationSecret,
  PartnerLocationSecretConfigurationError,
} from "@/lib/partner-location-secrets";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import {
  arePartnerPortalV2ReadsEnabled,
  arePartnerPortalV2WritesEnabled,
} from "@/lib/partner-portal-feature-flags";
import {
  createPartnerLocationDto,
  PartnerLocationCreateSchema,
} from "@/lib/partner-portal-v2-locations";
import {
  createPartnerLocationAccessCondition,
  partnerJobAccessScopeKey,
} from "@/lib/partner-portal-v2-resource-authorization";
import { runPortalV2IdempotentMutation } from "@/lib/partner-portal-v2-idempotency";
import { isAllowedPartnerPortalMutationOrigin } from "@/lib/partner-portal-v2-security";
import {
  getServiceAreaPolicy,
  isCityAllowed,
  isPostalCodeAllowed,
} from "@/lib/policy";
import {
  getPostgresErrorMeta,
  resolveOrCreateContactProperty,
  resolveOrCreateStandaloneProperty,
} from "@/lib/property-write";
import {
  createPortalV2ErrorResponse,
  createPortalV2IdempotencyErrorResponse,
  encodePortalV2Cursor,
  parsePortalV2Pagination,
  readPortalV2CorrelationId,
  readPortalV2IdempotencyKey,
} from "@/lib/portal-v2-contract";
import {
  createPartnerPortalV2DescriptorResponse,
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2StoredResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ALLOWED_QUERY_KEYS = new Set(["active", "search"]);

type LocationCursorPayload = {
  accountId: string;
  filterHash: string;
  siteName: string;
  id: string;
};

function isLocationCursorPayload(
  value: unknown,
): value is LocationCursorPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).sort().join(",") ===
      "accountId,filterHash,id,siteName" &&
    typeof record["accountId"] === "string" &&
    UUID_PATTERN.test(record["accountId"]) &&
    typeof record["filterHash"] === "string" &&
    /^[0-9a-f]{64}$/u.test(record["filterHash"]) &&
    typeof record["siteName"] === "string" &&
    record["siteName"].length <= 120 &&
    typeof record["id"] === "string" &&
    UUID_PATTERN.test(record["id"])
  );
}

function singleQueryValue(
  params: URLSearchParams,
  key: string,
): string | null | "duplicate" {
  const values = params.getAll(key);
  if (values.length > 1) return "duplicate";
  return values[0]?.trim() || null;
}

export async function GET(request: NextRequest): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  const authorization = await requirePartnerCapability(
    request,
    "properties.read",
  );
  if (!authorization.ok) {
    return createPartnerPortalV2ErrorResponse(
      authorization.error,
      authorization.status,
      correlationId,
    );
  }
  const { principal } = authorization;
  if (!principal.accountId) {
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
    cursorKind: "partner_locations",
    validateCursorPayload: isLocationCursorPayload,
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
  const active = singleQueryValue(params, "active") ?? "true";
  const search = singleQueryValue(params, "search");
  if (
    active === "duplicate" ||
    search === "duplicate" ||
    !["true", "false", "all"].includes(active) ||
    (search && search.length > 100)
  ) {
    return createPartnerPortalV2ErrorResponse(
      "invalid_fields",
      422,
      correlationId,
    );
  }
  const normalizedSearch = search?.toLowerCase() ?? null;
  const accessScopeKey = partnerJobAccessScopeKey(principal);
  const filterHash = createHash("sha256")
    .update(
      JSON.stringify({ active, search: normalizedSearch, accessScopeKey }),
      "utf8",
    )
    .digest("hex");
  if (
    pagination.cursor &&
    (pagination.cursor.payload.accountId !== principal.accountId ||
      pagination.cursor.payload.filterHash !== filterHash)
  ) {
    return createPartnerPortalV2ErrorResponse(
      "invalid_cursor",
      422,
      correlationId,
    );
  }

  try {
    const cursor = pagination.cursor?.payload;
    const db = getDb();
    const rows = await db
      .select()
      .from(partnerAccountLocations)
      .where(
        and(
          createPartnerLocationAccessCondition(principal),
          active === "all"
            ? undefined
            : eq(partnerAccountLocations.active, active === "true"),
          normalizedSearch
            ? or(
                ilike(
                  partnerAccountLocations.siteName,
                  `%${normalizedSearch}%`,
                ),
                ilike(
                  partnerAccountLocations.addressLine1,
                  `%${normalizedSearch}%`,
                ),
                ilike(
                  partnerAccountLocations.externalPropertyId,
                  `%${normalizedSearch}%`,
                ),
              )
            : undefined,
          cursor
            ? or(
                gt(partnerAccountLocations.siteName, cursor.siteName),
                and(
                  eq(partnerAccountLocations.siteName, cursor.siteName),
                  gt(partnerAccountLocations.id, cursor.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(
        asc(partnerAccountLocations.siteName),
        asc(partnerAccountLocations.id),
      )
      .limit(pagination.limit + 1);
    const hasMore = rows.length > pagination.limit;
    const pageRows = hasMore ? rows.slice(0, pagination.limit) : rows;
    const last = pageRows.at(-1);
    const locations = pageRows.map(createPartnerLocationDto);
    const nextCursor =
      hasMore && last
        ? encodePortalV2Cursor({
            kind: "partner_locations",
            limit: pagination.limit,
            payload: {
              accountId: principal.accountId,
              filterHash,
              siteName: last.siteName,
              id: last.id,
            } satisfies LocationCursorPayload,
          })
        : null;
    return createPartnerPortalV2SuccessResponse(
      {
        ok: true,
        data: locations,
        locations,
        page: { limit: pagination.limit, nextCursor, hasMore },
      },
      correlationId,
    );
  } catch (error) {
    console.error("[partner-portal-v2] locations list failed", {
      correlationId,
      accountId: principal.accountId,
      error: error instanceof Error ? error.name : "unknown",
    });
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  if (!isAllowedPartnerPortalMutationOrigin(request)) {
    return createPartnerPortalV2ErrorResponse("forbidden", 403, correlationId);
  }
  const authorization = await requirePartnerCapability(
    request,
    "properties.manage",
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
  if (principal.accessLevel !== "account") {
    return createPartnerPortalV2ErrorResponse("forbidden", 403, correlationId);
  }
  if (!arePartnerPortalV2WritesEnabled(principal.accountId)) {
    return createPartnerPortalV2ErrorResponse(
      "service_unavailable",
      503,
      correlationId,
    );
  }
  const idempotency = readPortalV2IdempotencyKey(request.headers);
  if (!idempotency.ok) {
    return createPartnerPortalV2DescriptorResponse(
      createPortalV2IdempotencyErrorResponse(idempotency, correlationId),
    );
  }
  if (!idempotency.keyHash) {
    return createPartnerPortalV2ErrorResponse(
      "invalid_idempotency_key",
      400,
      correlationId,
    );
  }

  let raw: unknown;
  try {
    raw = await readBoundedJsonRequest(request, {
      maximumBytes: 16 * 1024,
      rejectDuplicateObjectKeys: true,
    });
  } catch (error) {
    return createPartnerPortalV2ErrorResponse(
      "invalid_body",
      error instanceof BoundedJsonRequestError ? error.status : 400,
      correlationId,
    );
  }
  const parsed = PartnerLocationCreateSchema.safeParse(raw);
  if (!parsed.success) {
    return createPartnerPortalV2ErrorResponse(
      "invalid_fields",
      422,
      correlationId,
    );
  }

  try {
    const input = parsed.data;
    const geocode = await forwardGeocode({
      addressLine1: input.address.line1,
      addressLine2: input.address.line2,
      city: input.address.city,
      state: input.address.state,
      postalCode: input.address.postalCode,
    });
    const serviceArea = await getServiceAreaPolicy();
    const eligible =
      isPostalCodeAllowed(input.address.postalCode, serviceArea) &&
      (serviceArea.cityAllowlist.length === 0 ||
        isCityAllowed(input.address.city, serviceArea));
    const encryptedSecret = input.accessSecret
      ? encryptPartnerLocationSecret(input.accessSecret)
      : null;

    const mutation = await runPortalV2IdempotentMutation({
      principal: `${principal.partnerUserId}:${principal.accountId}`,
      action: "partner_location.create",
      keyHash: idempotency.keyHash,
      scope: principal.accountId,
      payload: input,
      correlationId,
      execute: async () => {
        try {
          const db = getDb();
          const location = await db.transaction(async (tx) => {
            const now = new Date();
            const property = principal.legacyOrgContactId
              ? (
                  await resolveOrCreateContactProperty(tx, {
                    contactId: principal.legacyOrgContactId,
                    addressLine1: input.address.line1,
                    addressLine2: input.address.line2,
                    city: input.address.city,
                    state: input.address.state,
                    postalCode: input.address.postalCode,
                    lat: geocode ? String(geocode.lat) : null,
                    lng: geocode ? String(geocode.lng) : null,
                    relationship: "partner_account",
                    now,
                  })
                ).property
              : (
                  await resolveOrCreateStandaloneProperty(tx, {
                    addressLine1: input.address.line1,
                    addressLine2: input.address.line2 ?? null,
                    city: input.address.city,
                    state: input.address.state,
                    postalCode: input.address.postalCode,
                    lat: geocode ? String(geocode.lat) : null,
                    lng: geocode ? String(geocode.lng) : null,
                    now,
                  })
                ).property;
            const [created] = await tx
              .insert(partnerAccountLocations)
              .values({
                partnerAccountId: principal.accountId!,
                propertyId: property.id,
                siteName: input.siteName,
                externalPropertyId: input.externalPropertyId ?? null,
                addressLine1: property.addressLine1,
                addressLine2: property.addressLine2,
                city: property.city,
                state: property.state,
                postalCode: property.postalCode,
                timezone: input.timezone ?? "America/New_York",
                locale: input.locale ?? "en-US",
                latitude: property.lat,
                longitude: property.lng,
                geocodeStatus: geocode ? "verified" : "failed",
                serviceAreaStatus: geocode
                  ? eligible
                    ? "eligible"
                    : "outside"
                  : "review",
                accessInstructions: input.access?.details ?? null,
                parkingInstructions: input.access?.parking ?? null,
                loadingInstructions: input.access?.loading ?? null,
                accessSecretCiphertext: encryptedSecret?.ciphertext ?? null,
                accessSecretKeyVersion: encryptedSecret?.keyVersion ?? null,
                onSiteContact: input.onSiteContact ?? null,
                createdByMembershipId: principal.membershipId,
                createdAt: now,
                updatedAt: now,
              })
              .returning();
            if (!created) throw new Error("partner_location_create_failed");
            await tx.insert(auditLogs).values({
              actorType: "human",
              actorId: principal.partnerUserId,
              actorLabel: principal.email,
              actorRole: principal.roleKey,
              sessionId: principal.session.id,
              authMethod: "partner_session",
              correlationId,
              requiredPermissions: ["properties.manage"],
              surface: "partner_portal_v2",
              idempotencyKeyHash: idempotency.keyHash,
              action: "partner.location.created",
              entityType: "partner_account_location",
              entityId: created.id,
              meta: {
                partnerAccountId: principal.accountId,
                geocodeStatus: created.geocodeStatus,
                serviceAreaStatus: created.serviceAreaStatus,
                hasAccessSecret: Boolean(created.accessSecretCiphertext),
              },
            });
            return created;
          });
          const dto = createPartnerLocationDto(location);
          return {
            status: 201,
            body: { ok: true, location: dto },
            headers: {
              ETag: dto.etag,
              Location: `/api/portal/v2/locations/${location.id}`,
            },
          };
        } catch (error) {
          const metadata = getPostgresErrorMeta(error);
          if (metadata.code === "23505") {
            return {
              status: 409,
              body: { ok: false, error: "conflict" },
            };
          }
          throw error;
        }
      },
    });
    if (mutation.kind === "conflict") {
      return createPartnerPortalV2ErrorResponse(
        "idempotency_conflict",
        409,
        correlationId,
      );
    }
    return createPartnerPortalV2StoredResponse(mutation.result, correlationId);
  } catch (error) {
    if (error instanceof PartnerLocationSecretConfigurationError) {
      return createPartnerPortalV2ErrorResponse(
        "service_unavailable",
        503,
        correlationId,
      );
    }
    console.error("[partner-portal-v2] location create failed", {
      correlationId,
      accountId: principal.accountId,
      error: error instanceof Error ? error.name : "unknown",
    });
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
