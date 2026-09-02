import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDb, partnerAccountLocations, properties } from "@/db";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { requirePartnerCapability } from "@/lib/partner-account-authorization";
import { arePartnerPortalV2WritesEnabled } from "@/lib/partner-portal-feature-flags";
import {
  auditPartnerLocationPortfolio,
  canManageAccountLocationPortfolio,
  locationImportRequestHash,
  lockPartnerLocationDirectory,
  PARTNER_LOCATION_IMPORT_RETENTION_MS,
  PARTNER_LOCATION_IMPORT_TTL_MS,
  parsePartnerLocationCsv,
  partnerLocationDirectoryEtag,
  partnerLocationImports,
  serializePartnerLocationImportOperation,
  validatePartnerLocationImportAgainstPortfolio,
} from "@/lib/partner-location-portfolio";
import { PartnerLocationImportDryRunSchema } from "@/lib/partner-portal-v2-locations";
import { isAllowedPartnerPortalMutationOrigin } from "@/lib/partner-portal-v2-security";
import {
  createPortalV2IdempotencyErrorResponse,
  readPortalV2CorrelationId,
  readPortalV2IdempotencyKey,
} from "@/lib/portal-v2-contract";
import {
  createPartnerPortalV2DescriptorResponse,
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";

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
  if (!canManageAccountLocationPortfolio(principal)) {
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
      // JSON escaping can nearly double a valid 256 KiB CSV. The decoded CSV
      // is still independently capped by the strict schema/parser.
      maximumBytes: 540 * 1_024,
      rejectDuplicateObjectKeys: true,
    });
  } catch (error) {
    return createPartnerPortalV2ErrorResponse(
      "invalid_body",
      error instanceof BoundedJsonRequestError ? error.status : 400,
      correlationId,
    );
  }
  const parsed = PartnerLocationImportDryRunSchema.safeParse(raw);
  if (!parsed.success) {
    return createPartnerPortalV2ErrorResponse(
      "invalid_fields",
      422,
      correlationId,
    );
  }

  let analysis;
  try {
    analysis = parsePartnerLocationCsv(parsed.data.csv);
  } catch {
    return createPartnerPortalV2ErrorResponse(
      "invalid_fields",
      422,
      correlationId,
    );
  }

  try {
    const db = getDb();
    const requestHash = locationImportRequestHash(parsed.data.csv);
    const result = await db.transaction(async (tx) => {
      const account = await lockPartnerLocationDirectory(
        tx,
        principal.accountId!,
      );
      if (!account) return { kind: "not_found" as const };
      const [existingOperation] = await tx
        .select()
        .from(partnerLocationImports)
        .where(
          and(
            eq(partnerLocationImports.partnerAccountId, principal.accountId!),
            eq(
              partnerLocationImports.dryRunIdempotencyKeyHash,
              idempotency.keyHash!,
            ),
          ),
        )
        .limit(1);
      if (existingOperation) {
        return existingOperation.requestHash === requestHash
          ? { kind: "replay" as const, operation: existingOperation, account }
          : { kind: "conflict" as const };
      }

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
      const validated = validatePartnerLocationImportAgainstPortfolio(
        analysis,
        existingLocations,
      );
      const now = new Date();
      const [operation] = await tx
        .insert(partnerLocationImports)
        .values({
          partnerAccountId: principal.accountId!,
          requestedByMembershipId: principal.membershipId!,
          dryRunIdempotencyKeyHash: idempotency.keyHash!,
          requestHash,
          state: validated.invalidRowCount === 0 ? "validated" : "invalid",
          directoryVersion: account.version,
          rowCount: validated.rowCount,
          validRowCount: validated.validRowCount,
          invalidRowCount: validated.invalidRowCount,
          normalizedRows: validated.normalizedRows.map((row) => ({ ...row })),
          rowResults: validated.rowResults.map((row) => ({ ...row })),
          expiresAt: new Date(now.getTime() + PARTNER_LOCATION_IMPORT_TTL_MS),
          purgeAfter: new Date(
            now.getTime() + PARTNER_LOCATION_IMPORT_RETENTION_MS,
          ),
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!operation) throw new Error("partner_location_import_create_failed");
      await auditPartnerLocationPortfolio(tx, {
        principal,
        correlationId,
        action: "partner.location_import.validated",
        entityType: "partner_location_import",
        entityId: operation.id,
        idempotencyKeyHash: idempotency.keyHash,
        meta: {
          partnerAccountId: principal.accountId,
          rowCount: validated.rowCount,
          validRowCount: validated.validRowCount,
          invalidRowCount: validated.invalidRowCount,
          requestHash,
          directoryVersion: account.version,
        },
      });
      return { kind: "created" as const, operation, account };
    });

    if (result.kind === "not_found") {
      return createPartnerPortalV2ErrorResponse(
        "not_found",
        404,
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
    if (result.kind === "directory_too_large") {
      return createPartnerPortalV2ErrorResponse("conflict", 409, correlationId);
    }
    const operation = serializePartnerLocationImportOperation(result.operation);
    return createPartnerPortalV2SuccessResponse(
      { ok: true, import: operation, replayed: result.kind === "replay" },
      correlationId,
      result.kind === "created" ? 201 : 200,
      {
        ETag: operation.etag,
        "X-Location-Directory-ETag": partnerLocationDirectoryEtag({
          accountId: principal.accountId!,
          version: result.account.version,
        }),
      },
    );
  } catch (error) {
    console.error("[partner-portal-v2] location import dry-run failed", {
      correlationId,
      accountId: principal.accountId,
      error: error instanceof Error ? error.name : "unknown",
    });
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
