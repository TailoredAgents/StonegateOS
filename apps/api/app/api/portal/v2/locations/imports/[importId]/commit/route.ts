import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import {
  getDb,
  partnerAccountLocations,
  partnerAccounts,
  properties,
} from "@/db";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import { arePartnerPortalV2WritesEnabled } from "@/lib/partner-portal-feature-flags";
import {
  auditPartnerLocationPortfolio,
  canManageAccountLocationPortfolio,
  incrementPartnerLocationDirectory,
  isLocationImportRow,
  isLocationImportRowEvidenceConsistent,
  isLocationImportRowResult,
  isPortalLocationUuid,
  lockPartnerLocationDirectory,
  partnerLocationDirectoryEtag,
  partnerLocationImports,
  serializePartnerLocationImportOperation,
  validatePartnerLocationImportAgainstPortfolio,
  type LocationImportRow,
  type PartnerLocationImportAnalysis,
} from "@/lib/partner-location-portfolio";
import { PartnerLocationImportCommitSchema } from "@/lib/partner-portal-v2-locations";
import { isAllowedPartnerPortalMutationOrigin } from "@/lib/partner-portal-v2-security";
import {
  getPostgresErrorMeta,
  resolveOrCreateStandaloneProperty,
} from "@/lib/property-write";
import {
  createPortalV2IdempotencyErrorResponse,
  evaluatePortalV2RevisionPrecondition,
  readPortalV2CorrelationId,
  readPortalV2IdempotencyKey,
} from "@/lib/portal-v2-contract";
import { portalV2RequestHash } from "@/lib/partner-portal-v2-idempotency";
import {
  createPartnerPortalV2DescriptorResponse,
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";

type RouteContext = { params: Promise<{ importId: string }> };

function loadAnalysis(
  operation: typeof partnerLocationImports.$inferSelect,
): PartnerLocationImportAnalysis | null {
  const rows = Array.isArray(operation.normalizedRows)
    ? operation.normalizedRows.filter(isLocationImportRow)
    : [];
  const results = Array.isArray(operation.rowResults)
    ? operation.rowResults.filter(isLocationImportRowResult)
    : [];
  if (
    rows.length !== operation.validRowCount ||
    results.length !== operation.rowCount ||
    new Set(rows.map((row) => row.rowNumber)).size !== rows.length ||
    new Set(results.map((result) => result.rowNumber)).size !== results.length
  ) {
    return null;
  }
  const resultByRowNumber = new Map(
    results.map((result) => [result.rowNumber, result]),
  );
  if (
    rows.some((row) => {
      const result = resultByRowNumber.get(row.rowNumber);
      return !result || !isLocationImportRowEvidenceConsistent(row, result);
    })
  ) {
    return null;
  }
  return Object.freeze({
    normalizedRows: Object.freeze(rows),
    rowResults: Object.freeze(results),
    rowCount: operation.rowCount,
    validRowCount: operation.validRowCount,
    invalidRowCount: operation.invalidRowCount,
  });
}

function orderImportRows(
  rows: readonly LocationImportRow[],
  existingExternalIds: ReadonlySet<string>,
): readonly LocationImportRow[] | null {
  const pending = new Map(rows.map((row) => [row.rowNumber, row]));
  const available = new Set(existingExternalIds);
  const ordered: LocationImportRow[] = [];
  while (pending.size > 0) {
    const ready = [...pending.values()].filter(
      (row) =>
        !row.parentExternalPropertyId ||
        available.has(row.parentExternalPropertyId.toLowerCase()),
    );
    if (ready.length === 0) return null;
    for (const row of ready) {
      ordered.push(row);
      pending.delete(row.rowNumber);
      if (row.externalPropertyId) {
        available.add(row.externalPropertyId.toLowerCase());
      }
    }
  }
  return Object.freeze(ordered);
}

export async function POST(
  request: NextRequest,
  context: RouteContext,
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
  const { importId } = await context.params;
  if (
    !canManageAccountLocationPortfolio(principal) ||
    !isPortalLocationUuid(importId)
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
  const idempotency = readPortalV2IdempotencyKey(request.headers);
  if (!idempotency.ok) {
    return createPartnerPortalV2DescriptorResponse(
      createPortalV2IdempotencyErrorResponse(idempotency, correlationId),
    );
  }
  let raw: unknown;
  try {
    raw = await readBoundedJsonRequest(request, {
      maximumBytes: 1_024,
      rejectDuplicateObjectKeys: true,
    });
  } catch (error) {
    return createPartnerPortalV2ErrorResponse(
      "invalid_body",
      error instanceof BoundedJsonRequestError ? error.status : 400,
      correlationId,
    );
  }
  const parsed = PartnerLocationImportCommitSchema.safeParse(raw);
  if (!parsed.success) {
    return createPartnerPortalV2ErrorResponse(
      "invalid_fields",
      422,
      correlationId,
    );
  }
  const commitRequestHash = portalV2RequestHash(parsed.data);

  try {
    const db = getDb();
    const result = await db.transaction(async (tx) => {
      const account = await lockPartnerLocationDirectory(
        tx,
        principal.accountId!,
      );
      if (!account) return { kind: "not_found" as const };
      const [operation] = await tx
        .select()
        .from(partnerLocationImports)
        .where(
          and(
            eq(partnerLocationImports.id, importId),
            eq(partnerLocationImports.partnerAccountId, principal.accountId!),
          ),
        )
        .for("update")
        .limit(1);
      if (!operation) return { kind: "not_found" as const };
      if (operation.state === "committed") {
        return operation.commitIdempotencyKeyHash === idempotency.keyHash &&
          operation.commitRequestHash === commitRequestHash
          ? { kind: "replay" as const, operation, account }
          : { kind: "conflict" as const };
      }
      const precondition = evaluatePortalV2RevisionPrecondition({
        ifMatch: request.headers.get("if-match"),
        currentRevision: `partner-location-directory:${principal.accountId}:${account.version}`,
        correlationId,
      });
      if (!precondition.ok) {
        return {
          kind: "precondition" as const,
          response: precondition.response,
        };
      }
      if (operation.expiresAt.getTime() <= Date.now()) {
        const [expired] = await tx
          .update(partnerLocationImports)
          .set({
            state: "expired",
            revision: operation.revision + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(partnerLocationImports.id, operation.id),
              eq(partnerLocationImports.revision, operation.revision),
            ),
          )
          .returning();
        return { kind: "expired" as const, operation: expired ?? operation };
      }
      if (
        operation.state !== "validated" ||
        operation.invalidRowCount !== 0 ||
        parsed.data.confirmation !== `IMPORT ${operation.rowCount} LOCATIONS`
      ) {
        return { kind: "invalid" as const };
      }
      if (operation.directoryVersion !== account.version) {
        return { kind: "directory_changed" as const, account };
      }
      const [keyCollision] = await tx
        .select({ id: partnerLocationImports.id })
        .from(partnerLocationImports)
        .where(
          and(
            eq(partnerLocationImports.partnerAccountId, principal.accountId!),
            eq(
              partnerLocationImports.commitIdempotencyKeyHash,
              idempotency.keyHash!,
            ),
          ),
        )
        .limit(1);
      if (keyCollision && keyCollision.id !== operation.id) {
        return { kind: "conflict" as const };
      }

      const analysis = loadAnalysis(operation);
      if (!analysis)
        throw new Error("partner_location_import_evidence_invalid");
      const existingLocations = await tx
        .select({
          id: partnerAccountLocations.id,
          externalPropertyId: partnerAccountLocations.externalPropertyId,
          addressKey: properties.addressKey,
          active: partnerAccountLocations.active,
        })
        .from(partnerAccountLocations)
        .leftJoin(
          properties,
          eq(partnerAccountLocations.propertyId, properties.id),
        )
        .where(
          eq(partnerAccountLocations.partnerAccountId, principal.accountId!),
        )
        .limit(1_001);
      if (existingLocations.length > 1_000) {
        return { kind: "directory_too_large" as const };
      }
      const revalidated = validatePartnerLocationImportAgainstPortfolio(
        analysis,
        existingLocations,
      );
      if (revalidated.invalidRowCount > 0) {
        return { kind: "directory_changed" as const, account };
      }
      const existingByExternal = new Map(
        existingLocations.flatMap((location) =>
          location.externalPropertyId
            ? [
                [
                  location.externalPropertyId.toLowerCase(),
                  location.id,
                ] as const,
              ]
            : [],
        ),
      );
      const ordered = orderImportRows(
        revalidated.normalizedRows,
        new Set(existingByExternal.keys()),
      );
      if (!ordered) return { kind: "invalid" as const };

      const created: Array<typeof partnerAccountLocations.$inferSelect> = [];
      const importedByExternal = new Map<string, string>();
      let requestedDefaultId: string | null = null;
      const now = new Date();
      for (const row of ordered) {
        const parentKey = row.parentExternalPropertyId?.toLowerCase() ?? null;
        const parentLocationId = parentKey
          ? (importedByExternal.get(parentKey) ??
            existingByExternal.get(parentKey) ??
            null)
          : null;
        if (parentKey && !parentLocationId) {
          throw new Error("partner_location_import_parent_missing");
        }
        const property = (
          await resolveOrCreateStandaloneProperty(tx, {
            addressLine1: row.addressLine1,
            addressLine2: row.addressLine2,
            city: row.city,
            state: row.state,
            postalCode: row.postalCode,
            now,
          })
        ).property;
        const [location] = await tx
          .insert(partnerAccountLocations)
          .values({
            partnerAccountId: principal.accountId!,
            propertyId: property.id,
            siteName: row.siteName,
            externalPropertyId: row.externalPropertyId,
            addressLine1: property.addressLine1,
            addressLine2: property.addressLine2,
            city: property.city,
            state: property.state,
            postalCode: property.postalCode,
            timezone: row.timezone,
            locale: "en-US",
            latitude: property.lat,
            longitude: property.lng,
            geocodeStatus: "pending",
            serviceAreaStatus: "unverified",
            parentLocationId,
            createdByMembershipId: principal.membershipId!,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        if (!location) throw new Error("partner_location_import_insert_failed");
        created.push(location);
        if (row.externalPropertyId) {
          importedByExternal.set(
            row.externalPropertyId.toLowerCase(),
            location.id,
          );
        }
        if (row.makeDefault) requestedDefaultId = location.id;
      }
      if (requestedDefaultId) {
        await tx
          .update(partnerAccounts)
          .set({ defaultPartnerLocationId: requestedDefaultId, updatedAt: now })
          .where(eq(partnerAccounts.id, principal.accountId!));
      }
      const updatedAccount = await incrementPartnerLocationDirectory(
        tx,
        principal.accountId!,
        account.version,
      );
      const [committed] = await tx
        .update(partnerLocationImports)
        .set({
          state: "committed",
          committedByMembershipId: principal.membershipId!,
          commitIdempotencyKeyHash: idempotency.keyHash!,
          commitRequestHash,
          committedAt: now,
          revision: operation.revision + 1,
          updatedAt: now,
        })
        .where(
          and(
            eq(partnerLocationImports.id, operation.id),
            eq(partnerLocationImports.revision, operation.revision),
          ),
        )
        .returning();
      if (!committed) throw new Error("partner_location_import_revision_race");
      await auditPartnerLocationPortfolio(tx, {
        principal,
        correlationId,
        action: "partner.location_import.committed",
        entityType: "partner_location_import",
        entityId: operation.id,
        idempotencyKeyHash: idempotency.keyHash,
        meta: {
          partnerAccountId: principal.accountId,
          createdCount: created.length,
          priorDirectoryVersion: account.version,
          directoryVersion: updatedAccount.version,
          requestHash: operation.requestHash,
        },
      });
      return {
        kind: "committed" as const,
        operation: committed,
        account: updatedAccount,
        locationIds: created.map((location) => location.id),
      };
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
    if (result.kind === "expired") {
      return createPartnerPortalV2ErrorResponse("conflict", 410, correlationId);
    }
    if (result.kind === "invalid") {
      return createPartnerPortalV2ErrorResponse(
        "invalid_fields",
        422,
        correlationId,
      );
    }
    if (result.kind === "conflict") {
      return createPartnerPortalV2ErrorResponse(
        "idempotency_conflict",
        409,
        correlationId,
      );
    }
    if (
      result.kind === "directory_changed" ||
      result.kind === "directory_too_large"
    ) {
      return createPartnerPortalV2ErrorResponse("conflict", 409, correlationId);
    }
    const operation = serializePartnerLocationImportOperation(result.operation);
    const directoryEtag = partnerLocationDirectoryEtag({
      accountId: principal.accountId!,
      version: result.account.version,
    });
    return createPartnerPortalV2SuccessResponse(
      {
        ok: true,
        import: operation,
        replayed: result.kind === "replay",
        createdCount:
          result.kind === "committed"
            ? result.locationIds.length
            : result.operation.rowCount,
      },
      correlationId,
      200,
      { ETag: operation.etag, "X-Location-Directory-ETag": directoryEtag },
    );
  } catch (error) {
    const metadata = getPostgresErrorMeta(error);
    if (metadata.code === "23505" || metadata.code === "23514") {
      return createPartnerPortalV2ErrorResponse("conflict", 409, correlationId);
    }
    console.error("[partner-portal-v2] location import commit failed", {
      correlationId,
      accountId: principal.accountId,
      error: error instanceof Error ? error.name : "unknown",
    });
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
