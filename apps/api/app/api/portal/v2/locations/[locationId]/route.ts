import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import {
  auditLogs,
  getDb,
  partnerAccountLocations,
  partnerBookings,
} from "@/db";
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
  partnerLocationRevision,
  PartnerLocationUpdateSchema,
} from "@/lib/partner-portal-v2-locations";
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
  resolveOrCreateContactProperty,
  resolveOrCreateStandaloneProperty,
} from "@/lib/property-write";
import {
  createPortalV2ErrorResponse,
  evaluatePortalV2RevisionPrecondition,
  readPortalV2CorrelationId,
} from "@/lib/portal-v2-contract";
import {
  createPartnerPortalV2DescriptorResponse,
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";

type RouteContext = { params: Promise<{ locationId: string }> };

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
  if (!principal.accountId || !isPortalV2Uuid(locationId)) {
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
    const location = createPartnerLocationDto(row);
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

  let input: ReturnType<typeof PartnerLocationUpdateSchema.parse> = {
    active: false,
  };
  if (!archive) {
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
    const parsed = PartnerLocationUpdateSchema.safeParse(raw);
    if (!parsed.success) {
      return createPartnerPortalV2ErrorResponse(
        "invalid_fields",
        422,
        correlationId,
      );
    }
    input = parsed.data;
  }

  try {
    const geocode = input.address
      ? await forwardGeocode({
          addressLine1: input.address.line1,
          addressLine2: input.address.line2,
          city: input.address.city,
          state: input.address.state,
          postalCode: input.address.postalCode,
        })
      : null;
    const serviceArea = input.address ? await getServiceAreaPolicy() : null;
    const eligible =
      input.address && serviceArea
        ? isPostalCodeAllowed(input.address.postalCode, serviceArea) &&
          (serviceArea.cityAllowlist.length === 0 ||
            isCityAllowed(input.address.city, serviceArea))
        : null;
    const encryptedSecret =
      "accessSecret" in input && input.accessSecret
        ? encryptPartnerLocationSecret(input.accessSecret)
        : null;
    const db = getDb();
    const result = await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(partnerAccountLocations)
        .where(createPartnerLocationAccessCondition(principal, locationId))
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

      let propertyId = row.propertyId;
      let addressUpdates: Partial<typeof partnerAccountLocations.$inferInsert> =
        {};
      if (input.address) {
        const current = normalizePropertyAddress({
          addressLine1: row.addressLine1,
          addressLine2: row.addressLine2,
          city: row.city,
          state: row.state,
          postalCode: row.postalCode,
        });
        const requested = normalizePropertyAddress({
          addressLine1: input.address.line1,
          addressLine2: input.address.line2,
          city: input.address.city,
          state: input.address.state,
          postalCode: input.address.postalCode,
        });
        if (requested.addressKey !== current.addressKey && row.propertyId) {
          const [used] = await tx
            .select({ id: partnerBookings.id })
            .from(partnerBookings)
            .where(
              and(
                eq(partnerBookings.partnerAccountId, principal.accountId!),
                eq(partnerBookings.propertyId, row.propertyId),
              ),
            )
            .limit(1);
          if (used) return { kind: "address_in_use" as const };
        }
        const property = principal.legacyOrgContactId
          ? (
              await resolveOrCreateContactProperty(tx, {
                contactId: principal.legacyOrgContactId,
                addressLine1: requested.addressLine1,
                addressLine2: requested.addressLine2,
                city: requested.city,
                state: requested.state,
                postalCode: requested.postalCode,
                lat: geocode ? String(geocode.lat) : null,
                lng: geocode ? String(geocode.lng) : null,
                relationship: "partner_account",
              })
            ).property
          : (
              await resolveOrCreateStandaloneProperty(tx, {
                addressLine1: requested.addressLine1,
                addressLine2: requested.addressLine2,
                city: requested.city,
                state: requested.state,
                postalCode: requested.postalCode,
                lat: geocode ? String(geocode.lat) : null,
                lng: geocode ? String(geocode.lng) : null,
              })
            ).property;
        propertyId = property.id;
        addressUpdates = {
          propertyId,
          addressLine1: property.addressLine1,
          addressLine2: property.addressLine2,
          city: property.city,
          state: property.state,
          postalCode: property.postalCode,
          latitude: property.lat,
          longitude: property.lng,
          geocodeStatus: geocode ? "verified" : "failed",
          serviceAreaStatus: geocode
            ? eligible
              ? "eligible"
              : "outside"
            : "review",
        };
      }
      const now = new Date();
      const [updated] = await tx
        .update(partnerAccountLocations)
        .set({
          ...addressUpdates,
          ...(input.siteName !== undefined ? { siteName: input.siteName } : {}),
          ...(input.externalPropertyId !== undefined
            ? { externalPropertyId: input.externalPropertyId }
            : {}),
          ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
          ...(input.locale !== undefined ? { locale: input.locale } : {}),
          ...(input.access !== undefined
            ? {
                accessInstructions: input.access.details ?? null,
                parkingInstructions: input.access.parking ?? null,
                loadingInstructions: input.access.loading ?? null,
              }
            : {}),
          ...(input.onSiteContact !== undefined
            ? { onSiteContact: input.onSiteContact }
            : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
          ...("accessSecret" in input
            ? {
                accessSecretCiphertext: encryptedSecret?.ciphertext ?? null,
                accessSecretKeyVersion: encryptedSecret?.keyVersion ?? null,
              }
            : {}),
          version: row.version + 1,
          updatedAt: now,
        })
        .where(
          and(
            eq(partnerAccountLocations.id, row.id),
            eq(partnerAccountLocations.partnerAccountId, principal.accountId!),
            eq(partnerAccountLocations.version, row.version),
          ),
        )
        .returning();
      if (!updated) throw new Error("partner_location_revision_race");
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
        action: archive
          ? "partner.location.archived"
          : "partner.location.updated",
        entityType: "partner_account_location",
        entityId: row.id,
        meta: {
          partnerAccountId: principal.accountId,
          addressChanged: Boolean(input.address),
          accessSecretChanged: "accessSecret" in input,
          active: updated.active,
        },
      });
      return { kind: "success" as const, row: updated };
    });

    if (result.kind === "not_found") {
      return createPartnerPortalV2ErrorResponse(
        "not_found",
        404,
        correlationId,
      );
    }
    if (result.kind === "precondition") {
      return createPartnerPortalV2DescriptorResponse(result.response);
    }
    if (result.kind === "address_in_use") {
      return createPartnerPortalV2DescriptorResponse(
        createPortalV2ErrorResponse("conflict", correlationId, {
          fieldErrors: {
            address:
              "Archive this location and create a new one because jobs already reference this address.",
          },
          alternatives: [
            {
              action: "create_location",
              label: "Create a new location",
              href: "/partners/locations/new",
            },
          ],
        }),
      );
    }
    const location = createPartnerLocationDto(result.row);
    return createPartnerPortalV2SuccessResponse(
      { ok: true, location },
      correlationId,
      200,
      { ETag: location.etag },
    );
  } catch (error) {
    if (error instanceof PartnerLocationSecretConfigurationError) {
      return createPartnerPortalV2ErrorResponse(
        "service_unavailable",
        503,
        correlationId,
      );
    }
    const metadata = getPostgresErrorMeta(error);
    if (metadata.code === "23505") {
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
