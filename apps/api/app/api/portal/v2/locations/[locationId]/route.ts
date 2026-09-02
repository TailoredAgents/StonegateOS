import type { NextRequest } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import {
  getDb,
  partnerAccountLocations,
  partnerAccounts,
  partnerBookings,
  partnerLocationAddressReviews,
  partnerLocationFavorites,
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
  auditPartnerLocationPortfolio,
  findPartnerLocationDuplicates,
  getPartnerLocationArchiveImpact,
  getPartnerLocationPortfolioMetadata,
  incrementPartnerLocationDirectory,
  lockPartnerLocationDirectory,
  partnerLocationDirectoryEtag,
} from "@/lib/partner-location-portfolio";
import {
  createPartnerLocationDto,
  partnerLocationRevision,
  PartnerLocationArchiveSchema,
  PartnerLocationUpdateSchema,
} from "@/lib/partner-portal-v2-locations";
import { runPortalV2IdempotentMutation } from "@/lib/partner-portal-v2-idempotency";
import {
  createPartnerLocationAccessCondition,
  hasPartnerLocationAccess,
} from "@/lib/partner-portal-v2-resource-authorization";
import {
  isAllowedPartnerPortalMutationOrigin,
  isPortalV2Uuid,
} from "@/lib/partner-portal-v2-security";
import {
  getServiceAreaPolicy,
  isCityAllowed,
  isPostalCodeAllowed,
} from "@/lib/policy";
import {
  getPostgresErrorMeta,
  normalizePropertyAddress,
  resolveOrCreateStandaloneProperty,
} from "@/lib/property-write";
import {
  createPortalV2IdempotencyErrorResponse,
  evaluatePortalV2RevisionPrecondition,
  readPortalV2CorrelationId,
  readPortalV2IdempotencyKey,
  type PortalV2ErrorHttpResponse,
} from "@/lib/portal-v2-contract";
import {
  createPartnerPortalV2DescriptorResponse,
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2StoredResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";

type RouteContext = { params: Promise<{ locationId: string }> };

function storedDescriptor(descriptor: PortalV2ErrorHttpResponse) {
  return {
    status: descriptor.status,
    body: descriptor.body,
    headers: descriptor.headers,
  };
}

export async function GET(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
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
  const { locationId } = await context.params;
  if (
    !principal.accountId ||
    !principal.membershipId ||
    !isPortalV2Uuid(locationId)
  ) {
    return createPartnerPortalV2ErrorResponse("not_found", 404, correlationId);
  }
  if (!arePartnerPortalV2ReadsEnabled(principal.accountId)) {
    return createPartnerPortalV2ErrorResponse(
      "service_unavailable",
      503,
      correlationId,
    );
  }
  try {
    const db = getDb();
    const [row] = await db
      .select()
      .from(partnerAccountLocations)
      .where(createPartnerLocationAccessCondition(principal, locationId))
      .limit(1);
    if (!row) {
      return createPartnerPortalV2ErrorResponse(
        "not_found",
        404,
        correlationId,
      );
    }
    const portfolio = await getPartnerLocationPortfolioMetadata({
      accountId: principal.accountId,
      membershipId: principal.membershipId,
      locationIds: [row.id],
    });
    if (!portfolio) {
      return createPartnerPortalV2ErrorResponse(
        "not_found",
        404,
        correlationId,
      );
    }
    const accountWide = principal.accessLevel === "account";
    const location = createPartnerLocationDto(row, {
      defaultLocationId: portfolio.defaultLocationId,
      favoriteLocationIds: portfolio.favoriteLocationIds,
      childCount: accountWide ? (portfolio.childCounts.get(row.id) ?? 0) : 0,
      directoryVersion: portfolio.directoryVersion,
      includeHierarchy: accountWide,
    });
    return createPartnerPortalV2SuccessResponse(
      { ok: true, location },
      correlationId,
      200,
      { ETag: location.etag },
    );
  } catch (error) {
    console.error("[partner-portal-v2] location detail failed", {
      correlationId,
      accountId: principal.accountId,
      error: error instanceof Error ? error.name : "unknown",
    });
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}

export async function PATCH(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  return mutateLocation(request, context, false);
}

export async function DELETE(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  return mutateLocation(request, context, true);
}

async function mutateLocation(
  request: NextRequest,
  context: RouteContext,
  archive: boolean,
): Promise<Response> {
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
  const { locationId } = await context.params;
  if (
    !principal.accountId ||
    !principal.membershipId ||
    !isPortalV2Uuid(locationId)
  ) {
    return createPartnerPortalV2ErrorResponse("not_found", 404, correlationId);
  }
  if (!arePartnerPortalV2WritesEnabled(principal.accountId)) {
    return createPartnerPortalV2ErrorResponse(
      "service_unavailable",
      503,
      correlationId,
    );
  }
  try {
    if (!(await hasPartnerLocationAccess(principal, locationId))) {
      return createPartnerPortalV2ErrorResponse(
        "not_found",
        404,
        correlationId,
      );
    }
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
  const idempotency = readPortalV2IdempotencyKey(request.headers);
  if (!idempotency.ok) {
    return createPartnerPortalV2DescriptorResponse(
      createPortalV2IdempotencyErrorResponse(idempotency, correlationId),
    );
  }

  let raw: unknown;
  try {
    raw = await readBoundedJsonRequest(request, {
      maximumBytes: 16 * 1_024,
      rejectDuplicateObjectKeys: true,
    });
  } catch (error) {
    return createPartnerPortalV2ErrorResponse(
      "invalid_body",
      error instanceof BoundedJsonRequestError ? error.status : 400,
      correlationId,
    );
  }
  const parsed = archive
    ? PartnerLocationArchiveSchema.safeParse(raw)
    : PartnerLocationUpdateSchema.safeParse(raw);
  if (!parsed.success) {
    return createPartnerPortalV2ErrorResponse(
      "invalid_fields",
      422,
      correlationId,
    );
  }
  const archiveInput = archive
    ? PartnerLocationArchiveSchema.parse(parsed.data)
    : null;
  const updateInput = archive
    ? null
    : PartnerLocationUpdateSchema.parse(parsed.data);
  if (
    updateInput?.active === false ||
    (principal.accessLevel !== "account" &&
      (updateInput?.parentLocationId !== undefined ||
        updateInput?.makeDefault !== undefined))
  ) {
    return createPartnerPortalV2ErrorResponse(
      "invalid_fields",
      422,
      correlationId,
    );
  }

  try {
    const verification = updateInput?.address
      ? await verifyAddress({
          addressLine1: updateInput.address.line1,
          addressLine2: updateInput.address.line2,
          city: updateInput.address.city,
          state: updateInput.address.state,
          postalCode: updateInput.address.postalCode,
        })
      : null;
    const serviceArea = updateInput?.address
      ? await getServiceAreaPolicy()
      : null;
    const eligible =
      updateInput?.address && serviceArea
        ? isPostalCodeAllowed(updateInput.address.postalCode, serviceArea) &&
          (serviceArea.cityAllowlist.length === 0 ||
            isCityAllowed(updateInput.address.city, serviceArea))
        : null;
    const encryptedSecret =
      updateInput && "accessSecret" in updateInput && updateInput.accessSecret
        ? encryptPartnerLocationSecret(updateInput.accessSecret)
        : null;
    const mutation = await runPortalV2IdempotentMutation({
      principal: `${principal.partnerUserId}:${principal.accountId}`,
      action: archive ? "partner_location.archive" : "partner_location.update",
      keyHash: idempotency.keyHash!,
      scope: `${principal.accountId}:${locationId}`,
      payload: parsed.data,
      correlationId,
      execute: async () => {
        const db = getDb();
        const result = await db
          .transaction(async (tx) => {
            const account = await lockPartnerLocationDirectory(
              tx,
              principal.accountId!,
            );
            if (!account) return { kind: "not_found" as const };
            const [row] = await tx
              .select()
              .from(partnerAccountLocations)
              .where(
                createPartnerLocationAccessCondition(principal, locationId),
              )
              .for("update")
              .limit(1);
            if (!row) return { kind: "not_found" as const };
            const precondition = evaluatePortalV2RevisionPrecondition({
              ifMatch: request.headers.get("if-match"),
              currentRevision: partnerLocationRevision(row),
              correlationId,
            });
            if (!precondition.ok) {
              return {
                kind: "precondition" as const,
                response: precondition.response,
              };
            }
            const now = new Date();
            const presentationFor = async (targetId: string) => {
              const [[favorite], [childCount]] = await Promise.all([
                tx
                  .select({ locationId: partnerLocationFavorites.locationId })
                  .from(partnerLocationFavorites)
                  .where(
                    and(
                      eq(
                        partnerLocationFavorites.partnerAccountId,
                        principal.accountId!,
                      ),
                      eq(
                        partnerLocationFavorites.membershipId,
                        principal.membershipId!,
                      ),
                      eq(partnerLocationFavorites.locationId, targetId),
                    ),
                  )
                  .limit(1),
                tx
                  .select({ count: sql<number>`count(*)::integer` })
                  .from(partnerAccountLocations)
                  .where(
                    and(
                      eq(
                        partnerAccountLocations.partnerAccountId,
                        principal.accountId!,
                      ),
                      eq(partnerAccountLocations.parentLocationId, targetId),
                      eq(partnerAccountLocations.active, true),
                    ),
                  ),
              ]);
              return {
                favorite: Boolean(favorite),
                childCount: childCount?.count ?? 0,
              };
            };

            if (archive && archiveInput) {
              if (!row.active) return { kind: "not_found" as const };
              const impact = await getPartnerLocationArchiveImpact(tx, {
                accountId: principal.accountId!,
                location: row,
                defaultLocationId: account.defaultLocationId,
              });
              // An issued Quote V2 proposal remains a live commercial promise.
              // It must be resolved, expired, superseded, or voided before the
              // service location can be removed from new operations.
              if (impact.issuedActionableQuoteV2Count > 0) {
                return { kind: "archive_requirements" as const, impact };
              }
              if (
                principal.accessLevel !== "account" &&
                (impact.isDefault || impact.activeChildCount > 0)
              ) {
                return { kind: "portfolio_scope_required" as const };
              }
              let replacementDefaultId = account.defaultLocationId;
              if (impact.isDefault) {
                replacementDefaultId =
                  impact.activeAlternativeCount === 0
                    ? null
                    : (archiveInput.replacementDefaultLocationId ?? null);
                if (
                  impact.activeAlternativeCount > 0 &&
                  !replacementDefaultId
                ) {
                  return { kind: "archive_requirements" as const, impact };
                }
                if (replacementDefaultId) {
                  const [replacement] = await tx
                    .select({ id: partnerAccountLocations.id })
                    .from(partnerAccountLocations)
                    .where(
                      and(
                        eq(partnerAccountLocations.id, replacementDefaultId),
                        eq(
                          partnerAccountLocations.partnerAccountId,
                          principal.accountId!,
                        ),
                        eq(partnerAccountLocations.active, true),
                      ),
                    )
                    .limit(1);
                  if (!replacement || replacement.id === row.id) {
                    return { kind: "not_found" as const };
                  }
                }
                await tx
                  .update(partnerAccounts)
                  .set({
                    defaultPartnerLocationId: replacementDefaultId,
                    updatedAt: now,
                  })
                  .where(eq(partnerAccounts.id, principal.accountId!));
              } else if (
                archiveInput.replacementDefaultLocationId !== undefined
              ) {
                return { kind: "archive_requirements" as const, impact };
              }

              if (impact.activeChildCount > 0) {
                if (!archiveInput.childDisposition) {
                  return { kind: "archive_requirements" as const, impact };
                }
                let replacementParentId = row.parentLocationId;
                if (archiveInput.childDisposition === "move") {
                  replacementParentId =
                    archiveInput.replacementParentLocationId ?? null;
                  const [replacementParent] = replacementParentId
                    ? await tx
                        .select({ id: partnerAccountLocations.id })
                        .from(partnerAccountLocations)
                        .where(
                          and(
                            eq(partnerAccountLocations.id, replacementParentId),
                            eq(
                              partnerAccountLocations.partnerAccountId,
                              principal.accountId!,
                            ),
                            eq(partnerAccountLocations.active, true),
                          ),
                        )
                        .limit(1)
                    : [];
                  if (!replacementParent || replacementParent.id === row.id) {
                    return { kind: "not_found" as const };
                  }
                }
                await tx
                  .update(partnerAccountLocations)
                  .set({
                    parentLocationId: replacementParentId,
                    updatedAt: now,
                  })
                  .where(
                    and(
                      eq(
                        partnerAccountLocations.partnerAccountId,
                        principal.accountId!,
                      ),
                      eq(partnerAccountLocations.parentLocationId, row.id),
                      eq(partnerAccountLocations.active, true),
                    ),
                  );
              } else if (archiveInput.childDisposition !== undefined) {
                return { kind: "archive_requirements" as const, impact };
              }
              const [archived] = await tx
                .update(partnerAccountLocations)
                .set({
                  active: false,
                  version: row.version + 1,
                  updatedAt: now,
                })
                .where(
                  and(
                    eq(partnerAccountLocations.id, row.id),
                    eq(
                      partnerAccountLocations.partnerAccountId,
                      principal.accountId!,
                    ),
                    eq(partnerAccountLocations.version, row.version),
                  ),
                )
                .returning();
              if (!archived) throw new Error("partner_location_revision_race");
              const updatedAccount = await incrementPartnerLocationDirectory(
                tx,
                principal.accountId!,
                account.version,
              );
              await auditPartnerLocationPortfolio(tx, {
                principal,
                correlationId,
                action: "partner.location.archived",
                entityType: "partner_account_location",
                entityId: row.id,
                idempotencyKeyHash: idempotency.keyHash,
                meta: {
                  partnerAccountId: principal.accountId,
                  reason: archiveInput.reason,
                  impact,
                  childDisposition: archiveInput.childDisposition ?? null,
                  defaultReassigned: impact.isDefault,
                  directoryVersion: updatedAccount.version,
                },
              });
              const presentation = await presentationFor(archived.id);
              return {
                kind: "success" as const,
                row: archived,
                account: updatedAccount,
                impact,
                presentation,
              };
            }

            if (!updateInput) return { kind: "invalid" as const };
            const requestedAddress = updateInput.address
              ? normalizePropertyAddress({
                  addressLine1: updateInput.address.line1,
                  addressLine2: updateInput.address.line2,
                  city: updateInput.address.city,
                  state: updateInput.address.state,
                  postalCode: updateInput.address.postalCode,
                })
              : normalizePropertyAddress({
                  addressLine1: row.addressLine1,
                  addressLine2: row.addressLine2,
                  city: row.city,
                  state: row.state,
                  postalCode: row.postalCode,
                });
            const duplicates = await findPartnerLocationDuplicates(tx, {
              accountId: principal.accountId!,
              excludeLocationId: row.id,
              externalPropertyId:
                updateInput.externalPropertyId === undefined
                  ? row.externalPropertyId
                  : updateInput.externalPropertyId,
              address: requestedAddress,
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
            const probableDuplicates = duplicates.filter(
              (candidate) => candidate.confidence >= 86,
            );
            const requestedParentId =
              updateInput.parentLocationId === undefined
                ? row.parentLocationId
                : updateInput.parentLocationId;
            if (requestedParentId) {
              const [parent] = await tx
                .select({ id: partnerAccountLocations.id })
                .from(partnerAccountLocations)
                .where(
                  and(
                    eq(partnerAccountLocations.id, requestedParentId),
                    eq(
                      partnerAccountLocations.partnerAccountId,
                      principal.accountId!,
                    ),
                    eq(partnerAccountLocations.active, true),
                  ),
                )
                .limit(1);
              if (!parent || parent.id === row.id) {
                return { kind: "not_found" as const };
              }
            }

            let addressUpdates: Partial<
              typeof partnerAccountLocations.$inferInsert
            > = {};
            if (updateInput.address) {
              if (!verification) throw new Error("address_verification_missing");
              const reviewRequired =
                Boolean(updateInput.requestAddressReview) ||
                verification.status !== "verified" ||
                probableDuplicates.length > 0;
              const trustedCoordinates = reviewRequired
                ? null
                : verification.coordinates;
              const currentAddress = normalizePropertyAddress({
                addressLine1: row.addressLine1,
                addressLine2: row.addressLine2,
                city: row.city,
                state: row.state,
                postalCode: row.postalCode,
              });
              if (
                requestedAddress.addressKey !== currentAddress.addressKey &&
                row.propertyId
              ) {
                const [used] = await tx
                  .select({ id: partnerBookings.id })
                  .from(partnerBookings)
                  .where(
                    and(
                      eq(
                        partnerBookings.partnerAccountId,
                        principal.accountId!,
                      ),
                      eq(partnerBookings.propertyId, row.propertyId),
                    ),
                  )
                  .limit(1);
                if (used) return { kind: "address_in_use" as const };
              }
              const property = (
                await resolveOrCreateStandaloneProperty(tx, {
                  addressLine1: requestedAddress.addressLine1,
                  addressLine2: requestedAddress.addressLine2,
                  city: requestedAddress.city,
                  state: requestedAddress.state,
                  postalCode: requestedAddress.postalCode,
                  lat: trustedCoordinates
                    ? String(trustedCoordinates.lat)
                    : null,
                  lng: trustedCoordinates
                    ? String(trustedCoordinates.lng)
                    : null,
                  now,
                })
              ).property;
              addressUpdates = {
                propertyId: property.id,
                addressLine1: property.addressLine1,
                addressLine2: property.addressLine2,
                city: property.city,
                state: property.state,
                postalCode: property.postalCode,
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
              };
            }
            const [updated] = await tx
              .update(partnerAccountLocations)
              .set({
                ...addressUpdates,
                ...(updateInput.siteName !== undefined
                  ? { siteName: updateInput.siteName }
                  : {}),
                ...(updateInput.externalPropertyId !== undefined
                  ? { externalPropertyId: updateInput.externalPropertyId }
                  : {}),
                ...(updateInput.timezone !== undefined
                  ? { timezone: updateInput.timezone }
                  : {}),
                ...(updateInput.locale !== undefined
                  ? { locale: updateInput.locale }
                  : {}),
                ...(updateInput.access !== undefined
                  ? {
                      accessInstructions: updateInput.access.details ?? null,
                      parkingInstructions: updateInput.access.parking ?? null,
                      loadingInstructions: updateInput.access.loading ?? null,
                    }
                  : {}),
                ...(updateInput.onSiteContact !== undefined
                  ? { onSiteContact: updateInput.onSiteContact }
                  : {}),
                ...(updateInput.parentLocationId !== undefined
                  ? { parentLocationId: updateInput.parentLocationId }
                  : {}),
                ...(updateInput.active === true ? { active: true } : {}),
                ...("accessSecret" in updateInput
                  ? {
                      accessSecretCiphertext:
                        encryptedSecret?.ciphertext ?? null,
                      accessSecretKeyVersion:
                        encryptedSecret?.keyVersion ?? null,
                    }
                  : {}),
                version: row.version + 1,
                updatedAt: now,
              })
              .where(
                and(
                  eq(partnerAccountLocations.id, row.id),
                  eq(
                    partnerAccountLocations.partnerAccountId,
                    principal.accountId!,
                  ),
                  eq(partnerAccountLocations.version, row.version),
                ),
              )
              .returning();
            if (!updated) throw new Error("partner_location_revision_race");
            const reviewRequired =
              Boolean(updateInput.requestAddressReview) ||
              (updateInput.address !== undefined &&
                (verification?.status !== "verified" ||
                  probableDuplicates.length > 0));
            if (reviewRequired) {
              const reasonCode = updateInput.requestAddressReview
                ? "partner_requested"
                : probableDuplicates.length > 0
                  ? "possible_duplicate"
                  : verification?.reasonCode === "suggested_correction"
                    ? "suggested_correction"
                    : verification?.reasonCode === "low_confidence"
                      ? "low_confidence"
                      : "provider_unavailable";
              const reviewValues = {
                reasonCode,
                enteredAddress: {
                  addressLine1: updated.addressLine1,
                  addressLine2: updated.addressLine2,
                  city: updated.city,
                  state: updated.state,
                  postalCode: updated.postalCode,
                },
                providerSuggestion: verification?.suggestedAddress ?? null,
                providerConfidence: verification?.confidence ?? null,
                duplicateCandidates: probableDuplicates.slice(0, 20),
                updatedAt: now,
              } as const;
              const [existingReview] = await tx
                .update(partnerLocationAddressReviews)
                .set({
                  ...reviewValues,
                  version: sql`${partnerLocationAddressReviews.version} + 1`,
                })
                .where(
                  and(
                    eq(
                      partnerLocationAddressReviews.partnerAccountId,
                      principal.accountId!,
                    ),
                    eq(partnerLocationAddressReviews.locationId, updated.id),
                    eq(partnerLocationAddressReviews.state, "pending"),
                  ),
                )
                .returning({ id: partnerLocationAddressReviews.id });
              if (!existingReview) {
                await tx.insert(partnerLocationAddressReviews).values({
                  partnerAccountId: principal.accountId!,
                  locationId: updated.id,
                  requestedByMembershipId: principal.membershipId!,
                  ...reviewValues,
                  createdAt: now,
                });
              }
            }
            if (updateInput.makeDefault) {
              if (!updated.active) return { kind: "invalid" as const };
              await tx
                .update(partnerAccounts)
                .set({ defaultPartnerLocationId: updated.id, updatedAt: now })
                .where(eq(partnerAccounts.id, principal.accountId!));
            }
            const updatedAccount = await incrementPartnerLocationDirectory(
              tx,
              principal.accountId!,
              account.version,
            );
            await auditPartnerLocationPortfolio(tx, {
              principal,
              correlationId,
              action: "partner.location.updated",
              entityType: "partner_account_location",
              entityId: row.id,
              idempotencyKeyHash: idempotency.keyHash,
              meta: {
                partnerAccountId: principal.accountId,
                addressChanged: Boolean(updateInput.address),
                addressVerificationStatus:
                  updated.addressVerificationStatus,
                addressReviewQueued: reviewRequired,
                duplicateCandidateCount: probableDuplicates.length,
                accessSecretChanged: "accessSecret" in updateInput,
                hierarchyChanged: updateInput.parentLocationId !== undefined,
                defaultChanged: Boolean(updateInput.makeDefault),
                reactivated: row.active === false && updated.active,
                directoryVersion: updatedAccount.version,
              },
            });
            const presentation = await presentationFor(updated.id);
            return {
              kind: "success" as const,
              row: updated,
              account: updatedAccount,
              impact: null,
              presentation,
            };
          })
          .catch((error: unknown) => {
            const metadata = getPostgresErrorMeta(error);
            if (metadata.code === "23505" || metadata.code === "23514") {
              return { kind: "database_conflict" as const };
            }
            throw error;
          });

        if (result.kind === "not_found") {
          return { status: 404, body: { ok: false, error: "not_found" } };
        }
        if (result.kind === "precondition") {
          return storedDescriptor(result.response);
        }
        if (result.kind === "invalid") {
          return {
            status: 422,
            body: { ok: false, error: "invalid_fields" },
          };
        }
        if (result.kind === "portfolio_scope_required") {
          return { status: 409, body: { ok: false, error: "conflict" } };
        }
        if (result.kind === "archive_requirements") {
          return {
            status: 409,
            body: {
              ok: false,
              error: "conflict",
              archiveImpact: result.impact,
            },
          };
        }
        if (result.kind === "duplicate") {
          return {
            status: 409,
            body: {
              ok: false,
              error: "conflict",
              ...(principal.accessLevel === "account"
                ? { duplicateCandidates: result.duplicates }
                : {}),
            },
          };
        }
        if (result.kind === "address_in_use") {
          return { status: 409, body: { ok: false, error: "conflict" } };
        }
        if (result.kind === "database_conflict") {
          return { status: 409, body: { ok: false, error: "conflict" } };
        }
        const location = createPartnerLocationDto(result.row, {
          defaultLocationId: result.account.defaultLocationId,
          favoriteLocationIds: result.presentation.favorite
            ? new Set([result.row.id])
            : new Set(),
          childCount: result.presentation.childCount,
          directoryVersion: result.account.version,
          includeHierarchy: principal.accessLevel === "account",
        });
        return {
          status: 200,
          body: {
            ok: true,
            location,
            ...(result.impact ? { archiveImpact: result.impact } : {}),
          },
          headers: {
            ETag: location.etag,
            "X-Location-Directory-ETag": partnerLocationDirectoryEtag({
              accountId: principal.accountId!,
              version: result.account.version,
            }),
          },
        };
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
    const metadata = getPostgresErrorMeta(error);
    if (metadata.code === "23505" || metadata.code === "23514") {
      return createPartnerPortalV2ErrorResponse("conflict", 409, correlationId);
    }
    console.error("[partner-portal-v2] location mutation failed", {
      correlationId,
      accountId: principal.accountId,
      error: error instanceof Error ? error.name : "unknown",
    });
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
