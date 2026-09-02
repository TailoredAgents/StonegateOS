import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import { and, asc, eq, gt, ilike, or } from "drizzle-orm";
import {
  auditLogs,
  getDb,
  partnerAccountLocations,
  partnerAccounts,
  partnerLocationAddressReviews,
} from "@/db";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { verifyAddress } from "@/lib/geocode";
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
  findPartnerLocationDuplicates,
  getPartnerLocationPortfolioMetadata,
  incrementPartnerLocationDirectory,
  lockPartnerLocationDirectory,
  partnerLocationDirectoryEtag,
} from "@/lib/partner-location-portfolio";
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

function singleQueryValue(params: URLSearchParams, key: string): string | null {
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
    const portfolio = await getPartnerLocationPortfolioMetadata({
      accountId: principal.accountId,
      membershipId: principal.membershipId,
      locationIds: pageRows.map((row) => row.id),
    });
    if (!portfolio) {
      return createPartnerPortalV2ErrorResponse(
        "not_found",
        404,
        correlationId,
      );
    }
    const accountWide = principal.accessLevel === "account";
    const locations = pageRows.map((row) =>
      createPartnerLocationDto(row, {
        defaultLocationId: portfolio.defaultLocationId,
        favoriteLocationIds: portfolio.favoriteLocationIds,
        childCount: accountWide ? (portfolio.childCounts.get(row.id) ?? 0) : 0,
        directoryVersion: portfolio.directoryVersion,
        includeHierarchy: accountWide,
      }),
    );
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
        directory: {
          version: portfolio.directoryVersion,
          defaultLocationId: accountWide ? portfolio.defaultLocationId : null,
          canManagePortfolio:
            accountWide && principal.capabilities.includes("properties.manage"),
          etag: partnerLocationDirectoryEtag({
            accountId: principal.accountId,
            version: portfolio.directoryVersion,
          }),
        },
        page: { limit: pagination.limit, nextCursor, hasMore },
      },
      correlationId,
      200,
      {
        "X-Location-Directory-ETag": partnerLocationDirectoryEtag({
          accountId: principal.accountId,
          version: portfolio.directoryVersion,
        }),
      },
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
    const verification = await verifyAddress({
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
          const locationResult = await db.transaction(async (tx) => {
            const account = await lockPartnerLocationDirectory(
              tx,
              principal.accountId!,
            );
            if (!account) return { kind: "not_found" as const };
            const duplicates = await findPartnerLocationDuplicates(tx, {
              accountId: principal.accountId!,
              externalPropertyId: input.externalPropertyId ?? null,
              address: {
                addressLine1: input.address.line1,
                addressLine2: input.address.line2,
                city: input.address.city,
                state: input.address.state,
                postalCode: input.address.postalCode,
              },
            });
            const exactDuplicates = duplicates.filter(
              (candidate) => candidate.confidence === 100,
            );
            if (exactDuplicates.length > 0) {
              return {
                kind: "duplicate" as const,
                duplicates: exactDuplicates,
              };
            }
            if (input.parentLocationId) {
              const [parent] = await tx
                .select({ id: partnerAccountLocations.id })
                .from(partnerAccountLocations)
                .where(
                  and(
                    eq(partnerAccountLocations.id, input.parentLocationId),
                    eq(
                      partnerAccountLocations.partnerAccountId,
                      principal.accountId!,
                    ),
                    eq(partnerAccountLocations.active, true),
                  ),
                )
                .limit(1);
              if (!parent) return { kind: "parent_not_found" as const };
            }
            const now = new Date();
            const probableDuplicates = duplicates.filter(
              (candidate) => candidate.confidence >= 86,
            );
            const reviewRequired =
              Boolean(input.requestAddressReview) ||
              verification.status !== "verified" ||
              probableDuplicates.length > 0;
            const trustedCoordinates = reviewRequired
              ? null
              : verification.coordinates;
            const property = (
              await resolveOrCreateStandaloneProperty(tx, {
                addressLine1: input.address.line1,
                addressLine2: input.address.line2 ?? null,
                city: input.address.city,
                state: input.address.state,
                postalCode: input.address.postalCode,
                lat: trustedCoordinates ? String(trustedCoordinates.lat) : null,
                lng: trustedCoordinates ? String(trustedCoordinates.lng) : null,
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
                latitude: trustedCoordinates
                  ? String(trustedCoordinates.lat)
                  : null,
                longitude: trustedCoordinates
                  ? String(trustedCoordinates.lng)
                  : null,
                geocodeStatus: reviewRequired
                  ? verification.coordinates
                    ? "pending"
                    : "failed"
                  : "verified",
                serviceAreaStatus: reviewRequired
                  ? "review"
                  : trustedCoordinates
                  ? eligible
                    ? "eligible"
                    : "outside"
                  : "review",
                addressVerificationStatus: reviewRequired
                  ? verification.status === "suggested_correction"
                    ? "suggested_correction"
                    : "review_required"
                  : "verified",
                addressVerificationProvider: verification.provider,
                addressVerificationConfidence: verification.confidence,
                addressVerificationFeatureId: verification.featureId,
                addressVerificationSuggestion:
                  verification.suggestedAddress ?? null,
                addressVerifiedAt: reviewRequired ? null : now,
                accessInstructions: input.access?.details ?? null,
                parkingInstructions: input.access?.parking ?? null,
                loadingInstructions: input.access?.loading ?? null,
                accessSecretCiphertext: encryptedSecret?.ciphertext ?? null,
                accessSecretKeyVersion: encryptedSecret?.keyVersion ?? null,
                onSiteContact: input.onSiteContact ?? null,
                parentLocationId: input.parentLocationId ?? null,
                createdByMembershipId: principal.membershipId,
                createdAt: now,
                updatedAt: now,
              })
              .returning();
            if (!created) throw new Error("partner_location_create_failed");
            if (reviewRequired) {
              await tx.insert(partnerLocationAddressReviews).values({
                partnerAccountId: principal.accountId!,
                locationId: created.id,
                requestedByMembershipId: principal.membershipId!,
                reasonCode: input.requestAddressReview
                  ? "partner_requested"
                  : probableDuplicates.length > 0
                    ? "possible_duplicate"
                    : verification.reasonCode === "suggested_correction"
                      ? "suggested_correction"
                      : verification.reasonCode === "low_confidence"
                        ? "low_confidence"
                        : "provider_unavailable",
                enteredAddress: {
                  addressLine1: input.address.line1,
                  addressLine2: input.address.line2 ?? null,
                  city: input.address.city,
                  state: input.address.state,
                  postalCode: input.address.postalCode,
                },
                providerSuggestion: verification.suggestedAddress ?? null,
                providerConfidence: verification.confidence,
                duplicateCandidates: probableDuplicates.slice(0, 20),
                createdAt: now,
                updatedAt: now,
              });
            }
            if (input.makeDefault) {
              await tx
                .update(partnerAccounts)
                .set({
                  defaultPartnerLocationId: created.id,
                  updatedAt: now,
                })
                .where(eq(partnerAccounts.id, principal.accountId!));
            }
            const updatedAccount = await incrementPartnerLocationDirectory(
              tx,
              principal.accountId!,
              account.version,
            );
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
                addressVerificationStatus:
                  created.addressVerificationStatus,
                addressReviewQueued: reviewRequired,
                duplicateCandidateCount: probableDuplicates.length,
                hasAccessSecret: Boolean(created.accessSecretCiphertext),
                parentLocationId: created.parentLocationId,
                isDefault: updatedAccount.defaultLocationId === created.id,
                directoryVersion: updatedAccount.version,
              },
            });
            return {
              kind: "success" as const,
              location: created,
              account: updatedAccount,
            };
          });
          if (locationResult.kind === "not_found") {
            return { status: 404, body: { ok: false, error: "not_found" } };
          }
          if (locationResult.kind === "duplicate") {
            return {
              status: 409,
              body: {
                ok: false,
                error: "conflict",
                duplicateCandidates: locationResult.duplicates,
              },
            };
          }
          if (locationResult.kind === "parent_not_found") {
            return {
              status: 404,
              body: { ok: false, error: "not_found" },
            };
          }
          const dto = createPartnerLocationDto(locationResult.location, {
            defaultLocationId: locationResult.account.defaultLocationId,
            favoriteLocationIds: new Set(),
            childCount: 0,
            directoryVersion: locationResult.account.version,
            includeHierarchy: true,
          });
          const directoryEtag = partnerLocationDirectoryEtag({
            accountId: principal.accountId!,
            version: locationResult.account.version,
          });
          return {
            status: 201,
            body: { ok: true, location: dto },
            headers: {
              ETag: dto.etag,
              "X-Location-Directory-ETag": directoryEtag,
              Location: `/api/portal/v2/locations/${locationResult.location.id}`,
            },
          };
        } catch (error) {
          const metadata = getPostgresErrorMeta(error);
          if (metadata.code === "23505" || metadata.code === "23514") {
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
