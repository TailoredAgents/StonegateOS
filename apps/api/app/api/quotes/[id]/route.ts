import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { calculateQuoteBreakdown } from "@myst-os/pricing/src/engine/calculate";
import { serviceRates } from "@myst-os/pricing/src/config/defaults";
import type {
  ConcreteSurfaceInput,
  ServiceCategory,
} from "@myst-os/pricing/src/types";
import { getDb, quotes, contacts, properties } from "@/db";
import { requirePermission } from "@/lib/permissions";
import { isAdminRequest } from "../../web/admin";
import { and, eq, sql } from "drizzle-orm";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  type TeamMutationIdempotencyClaim,
  teamMutationIdempotencyReplayResponse,
} from "@/lib/team-mutation-idempotency";
import {
  assertTeamMutationExpectedVersion,
  beginTeamMutation,
  recordTeamMutationFailure,
  TeamMutationFailure,
  teamMutationErrorResponse,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";
import { isQuoteV2FeatureEnabled } from "@/lib/feature-flags";
import { getQuoteV2StaffDetail } from "@/lib/quote-v2-management";
import {
  quoteV2CorrelationId,
  quoteV2ErrorResponse,
  quoteV2PublicJson,
} from "@/lib/quote-v2-http";

const SERVICE_ID_SET = new Set<ServiceCategory>(
  serviceRates.map((rate) => rate.service),
);
const DEFAULT_QUOTE_VALID_DAYS = 7;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const serviceIdSchema = z
  .string()
  .min(1)
  .refine(
    (value): value is ServiceCategory =>
      SERVICE_ID_SET.has(value as ServiceCategory),
    "invalid_service",
  );

const UpdateQuoteSchema = z.object({
  confirmation: z.literal("update_quote"),
  zoneId: z.string().min(1),
  selectedServices: z.array(serviceIdSchema).min(1),
  selectedAddOns: z.array(z.string().min(1)).optional(),
  surfaceArea: z.number().positive().optional(),
  applyBundles: z.boolean().optional(),
  depositRate: z.number().positive().max(1).optional(),
  expiresInDays: z.number().int().min(1).max(90).optional(),
  notes: z.string().max(2000).nullable().optional(),
  clientScope: z.string().max(4000).nullable().optional(),
  jobDurationMinutes: z
    .number()
    .int()
    .min(30)
    .max(8 * 60)
    .optional(),
  serviceOverrides: z
    .record(z.string().min(1), z.number().positive())
    .optional(),
  concreteSurfaces: z
    .array(
      z.object({
        kind: z.enum(["driveway", "deck", "other"]),
        squareFeet: z.number().positive(),
      }),
    )
    .max(3)
    .optional(),
});

const toPgNumeric = (value: number | string): string => value.toString();
const toOptionalPgNumeric = (value?: number | string | null): string | null =>
  value === null || value === undefined ? null : value.toString();

function displayStatus(row: {
  status: string;
  expiresAt: Date | null;
  viewedAt: Date | null;
  refreshRequestedAt: Date | null;
  acceptedAppointmentId: string | null;
}): string {
  if (row.acceptedAppointmentId) return "booked";
  if (row.refreshRequestedAt) return "refresh_requested";
  if (row.status === "declined") return "rejected";
  if (row.status === "accepted") return "accepted";
  if (
    row.status === "sent" &&
    row.expiresAt &&
    row.expiresAt.getTime() < Date.now()
  )
    return "expired";
  if (row.status === "sent" && row.viewedAt) return "viewed";
  if (row.status === "sent") return "sent";
  return "draft";
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "quotes.read");
  if (permissionError) return permissionError;

  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  const db = getDb();
  if (UUID_PATTERN.test(id)) {
    try {
      const detail = await getQuoteV2StaffDetail(db, id);
      if (detail) {
        const correlationId = quoteV2CorrelationId(request);
        if (!isQuoteV2FeatureEnabled("staff")) {
          return quoteV2ErrorResponse(
            "not_found",
            "The versioned quote workspace is not enabled for this cohort.",
            { correlationId },
          );
        }
        return quoteV2PublicJson(
          { ok: true, quote: detail },
          { correlationId },
        );
      }
    } catch {
      return quoteV2ErrorResponse(
        "internal",
        "The quote detail could not be loaded. Try again shortly.",
        { correlationId: quoteV2CorrelationId(request), retryable: true },
      );
    }
  }
  const rows = await db
    .select({
      id: quotes.id,
      status: quotes.status,
      services: quotes.services,
      addOns: quotes.addOns,
      surfaceArea: quotes.surfaceArea,
      zoneId: quotes.zoneId,
      travelFee: quotes.travelFee,
      discounts: quotes.discounts,
      addOnsTotal: quotes.addOnsTotal,
      subtotal: quotes.subtotal,
      total: quotes.total,
      depositDue: quotes.depositDue,
      depositRate: quotes.depositRate,
      balanceDue: quotes.balanceDue,
      lineItems: quotes.lineItems,
      notes: quotes.notes,
      quoteNumber: quotes.quoteNumber,
      jobDurationMinutes: quotes.jobDurationMinutes,
      clientScope: quotes.clientScope,
      revision: quotes.revision,
      sentAt: quotes.sentAt,
      expiresAt: quotes.expiresAt,
      viewedAt: quotes.viewedAt,
      lastViewedAt: quotes.lastViewedAt,
      viewCount: quotes.viewCount,
      decisionAt: quotes.decisionAt,
      decisionNotes: quotes.decisionNotes,
      refreshRequestedAt: quotes.refreshRequestedAt,
      acceptedAppointmentId: quotes.acceptedAppointmentId,
      customerVisible: sql<boolean>`${quotes.shareToken} IS NOT NULL`,
      createdAt: quotes.createdAt,
      updatedAt: quotes.updatedAt,
      contactName: contacts.firstName,
      contactEmail: contacts.email,
      propertyAddressLine1: properties.addressLine1,
      propertyCity: properties.city,
      propertyState: properties.state,
      propertyPostalCode: properties.postalCode,
    })
    .from(quotes)
    .leftJoin(contacts, eq(quotes.contactId, contacts.id))
    .leftJoin(properties, eq(quotes.propertyId, properties.id))
    .where(and(eq(quotes.id, id), eq(quotes.engineVersion, "legacy")))
    .limit(1);

  const quote = rows[0];
  if (!quote) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  return NextResponse.json({
    quote: {
      id: quote.id,
      status: quote.status,
      services: quote.services,
      addOns: quote.addOns,
      surfaceArea: quote.surfaceArea,
      zoneId: quote.zoneId,
      travelFee: Number(quote.travelFee),
      discounts: Number(quote.discounts),
      addOnsTotal: Number(quote.addOnsTotal),
      subtotal: Number(quote.subtotal),
      total: Number(quote.total),
      depositDue: Number(quote.depositDue),
      depositRate: Number(quote.depositRate),
      balanceDue: Number(quote.balanceDue),
      lineItems: quote.lineItems,
      notes: quote.notes,
      quoteNumber: quote.quoteNumber ?? quote.id.slice(0, 8).toUpperCase(),
      jobDurationMinutes: quote.jobDurationMinutes,
      clientScope: quote.clientScope,
      revision: quote.revision,
      displayStatus: displayStatus(quote),
      sentAt: quote.sentAt ? quote.sentAt.toISOString() : null,
      expiresAt: quote.expiresAt ? quote.expiresAt.toISOString() : null,
      viewedAt: quote.viewedAt ? quote.viewedAt.toISOString() : null,
      lastViewedAt: quote.lastViewedAt
        ? quote.lastViewedAt.toISOString()
        : null,
      viewCount: quote.viewCount,
      decisionAt: quote.decisionAt ? quote.decisionAt.toISOString() : null,
      decisionNotes: quote.decisionNotes,
      refreshRequestedAt: quote.refreshRequestedAt
        ? quote.refreshRequestedAt.toISOString()
        : null,
      acceptedAppointmentId: quote.acceptedAppointmentId,
      customerVisible: quote.customerVisible,
      shareToken: null,
      createdAt: quote.createdAt.toISOString(),
      updatedAt: quote.updatedAt.toISOString(),
      contact: {
        name: quote.contactName,
        email: quote.contactEmail,
      },
      property: {
        addressLine1: quote.propertyAddressLine1,
        city: quote.propertyCity,
        state: quote.propertyState,
        postalCode: quote.propertyPostalCode,
      },
    },
  });
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id?: string }> },
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["quotes.update"],
    risk: "normal",
    requiresIdempotency: true,
    auditAction: "quote.updated",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;

  const { id: rawId } = await context.params;
  const quoteId = rawId?.trim() ?? "";
  if (!UUID_PATTERN.test(quoteId)) {
    await recordTeamMutationFailure(mutation, {
      entityType: "quote",
      code: "invalid",
      metadata: { phase: "request_validation", reason: "invalid_quote_id" },
    });
    return teamMutationErrorResponse("invalid", "A valid quote is required.", {
      correlationId: mutation.correlationId,
      fieldErrors: { quoteId: "Select a valid quote." },
    });
  }
  if (mutation.expectedVersion === null || mutation.expectedVersion === "*") {
    await recordTeamMutationFailure(mutation, {
      entityType: "quote",
      entityId: quoteId,
      code: "invalid",
      metadata: { phase: "request_validation", reason: "version_required" },
    });
    return teamMutationErrorResponse(
      "invalid",
      "The latest quote version is required before editing.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { version: "Refresh the quote and try again." },
      },
    );
  }

  const parsedBody = UpdateQuoteSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsedBody.success) {
    await recordTeamMutationFailure(mutation, {
      entityType: "quote",
      entityId: quoteId,
      code: "invalid",
      metadata: { phase: "request_validation", reason: "quote_changes" },
    });
    return teamMutationErrorResponse(
      "invalid",
      "Complete and confirm the quote changes.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { quote: "Review the quote details and try again." },
      },
    );
  }

  const body = parsedBody.data;
  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "PATCH /api/quotes/:id",
      entityType: "quote",
      entityId: quoteId,
      payload: body,
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const selectedServices = body.selectedServices;

    let breakdown: ReturnType<typeof calculateQuoteBreakdown>;
    try {
      breakdown = calculateQuoteBreakdown({
        zoneId: body.zoneId,
        selectedServices,
        selectedAddOns: body.selectedAddOns,
        surfaceArea: body.surfaceArea,
        applyBundles: body.applyBundles,
        depositRate: body.depositRate,
        serviceOverrides: body.serviceOverrides as Partial<
          Record<ServiceCategory, number>
        >,
        concreteSurfaces: (body.concreteSurfaces ??
          []) as ConcreteSurfaceInput[],
      });
    } catch {
      throw new TeamMutationFailure(
        "invalid",
        "The selected services or pricing inputs are not valid.",
        { fieldErrors: { pricing: "Review the zone, services, and prices." } },
      );
    }

    const result = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({
          id: quotes.id,
          engineVersion: quotes.engineVersion,
          status: quotes.status,
          shareToken: quotes.shareToken,
          sentAt: quotes.sentAt,
          revision: quotes.revision,
          total: quotes.total,
          expiresAt: quotes.expiresAt,
          viewedAt: quotes.viewedAt,
          lastViewedAt: quotes.lastViewedAt,
          viewCount: quotes.viewCount,
          refreshRequestedAt: quotes.refreshRequestedAt,
        })
        .from(quotes)
        .where(eq(quotes.id, quoteId))
        .for("update")
        .limit(1);
      if (!existing) {
        throw new TeamMutationFailure("invalid", "The quote was not found.", {
          status: 404,
        });
      }
      if (existing.engineVersion !== "legacy") {
        throw new TeamMutationFailure(
          "conflict",
          "This versioned quote must be changed through its draft or lifecycle workflow.",
        );
      }
      assertTeamMutationExpectedVersion(mutation, existing.revision);
      if (existing.status === "accepted" || existing.status === "declined") {
        throw new TeamMutationFailure(
          "conflict",
          "Accepted or declined quotes cannot be edited.",
        );
      }

      const customerVisible = Boolean(existing.shareToken);
      const now = new Date();
      const expiresAt = body.expiresInDays
        ? new Date(now.getTime() + body.expiresInDays * 24 * 60 * 60 * 1000)
        : customerVisible
          ? new Date(
              now.getTime() + DEFAULT_QUOTE_VALID_DAYS * 24 * 60 * 60 * 1000,
            )
          : undefined;
      const nextRevision = existing.revision + 1;
      const [updated] = await tx
        .update(quotes)
        .set({
          // A share token makes a draft customer-visible; it does not prove a
          // provider delivery was requested or accepted. Preserve the actual
          // lifecycle state until the explicit send mutation runs.
          status: existing.status,
          services: selectedServices,
          addOns: body.selectedAddOns ?? null,
          surfaceArea: toOptionalPgNumeric(body.surfaceArea),
          zoneId: body.zoneId,
          travelFee: toPgNumeric(breakdown.travelFee),
          discounts: toPgNumeric(breakdown.discounts),
          addOnsTotal: toPgNumeric(breakdown.addOnsTotal),
          subtotal: toPgNumeric(breakdown.subtotal),
          total: toPgNumeric(breakdown.total),
          depositDue: toPgNumeric(breakdown.depositDue),
          depositRate: toPgNumeric(breakdown.depositRate),
          balanceDue: toPgNumeric(breakdown.balanceDue),
          lineItems: breakdown.lineItems,
          notes: body.notes ?? null,
          clientScope: body.clientScope ?? null,
          ...(body.jobDurationMinutes
            ? { jobDurationMinutes: body.jobDurationMinutes }
            : {}),
          revision: nextRevision,
          ...(customerVisible
            ? {
                // Editing a customer-visible quote does not erase historical
                // view evidence. Only the outstanding refresh request is
                // resolved by the new revision.
                refreshRequestedAt: null,
              }
            : {}),
          ...(expiresAt ? { expiresAt } : {}),
          updatedAt: now,
        })
        .where(
          and(
            eq(quotes.id, quoteId),
            eq(quotes.engineVersion, "legacy"),
            eq(quotes.revision, existing.revision),
          ),
        )
        .returning();
      if (!updated) {
        throw new TeamMutationFailure(
          "conflict",
          "The quote changed while it was being updated. Refresh and try again.",
          { retryable: true },
        );
      }

      const { shareToken: _shareToken, ...safeUpdated } = updated;

      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "quote",
        entityId: updated.id,
        before: {
          status: existing.status,
          revision: existing.revision,
          total: Number(existing.total),
          expiresAt: existing.expiresAt?.toISOString() ?? null,
          viewedAt: existing.viewedAt?.toISOString() ?? null,
          lastViewedAt: existing.lastViewedAt?.toISOString() ?? null,
          viewCount: existing.viewCount,
          refreshRequestedAt:
            existing.refreshRequestedAt?.toISOString() ?? null,
        },
        after: {
          status: updated.status,
          revision: updated.revision,
          total: breakdown.total,
          expiresAt: updated.expiresAt?.toISOString() ?? null,
          viewedAt: updated.viewedAt?.toISOString() ?? null,
          lastViewedAt: updated.lastViewedAt?.toISOString() ?? null,
          viewCount: updated.viewCount,
          refreshRequestedAt: updated.refreshRequestedAt?.toISOString() ?? null,
        },
        metadata: { services: selectedServices, customerVisible },
        committedAt: now,
      });
      const mutationResult = teamMutationSuccessResult(
        mutation,
        {
          quote: {
            ...safeUpdated,
            createdAt: updated.createdAt.toISOString(),
            updatedAt: updated.updatedAt.toISOString(),
            sentAt: updated.sentAt?.toISOString() ?? null,
            expiresAt: updated.expiresAt?.toISOString() ?? null,
            viewedAt: updated.viewedAt?.toISOString() ?? null,
            lastViewedAt: updated.lastViewedAt?.toISOString() ?? null,
            decisionAt: updated.decisionAt?.toISOString() ?? null,
            refreshRequestedAt:
              updated.refreshRequestedAt?.toISOString() ?? null,
            displayStatus: displayStatus({
              status: updated.status,
              expiresAt: updated.expiresAt,
              viewedAt: updated.viewedAt,
              refreshRequestedAt: updated.refreshRequestedAt,
              acceptedAppointmentId: updated.acceptedAppointmentId,
            }),
          },
          breakdown,
        },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "quote",
          entityId: updated.id,
          version: String(updated.revision),
        },
      );
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
        mutationResult,
        200,
      );
      return mutationResult;
    });

    return teamMutationResultResponse(result, 200, mutation.correlationId);
  } catch (error) {
    if (db && claim) {
      await settleTeamMutationIdempotencyFailure(
        db,
        mutation,
        claim,
        error,
      ).catch(() => undefined);
    }
    await recordTeamMutationFailure(mutation, {
      entityType: "quote",
      entityId: quoteId,
      code: error instanceof TeamMutationFailure ? error.code : "internal",
      metadata: {
        phase: "mutation",
        retryable:
          error instanceof TeamMutationFailure ? error.retryable : true,
      },
    });
    return teamMutationExceptionResponse(error, mutation);
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id?: string }> },
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["quotes.delete"],
    risk: "destructive",
    requiresIdempotency: true,
    auditAction: "quote.deleted",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;

  const { id: rawId } = await context.params;
  const quoteId = rawId?.trim() ?? "";
  if (!UUID_PATTERN.test(quoteId)) {
    await recordTeamMutationFailure(mutation, {
      entityType: "quote",
      code: "invalid",
      metadata: { phase: "request_validation", reason: "invalid_quote_id" },
    });
    return teamMutationErrorResponse("invalid", "A valid quote is required.", {
      correlationId: mutation.correlationId,
      fieldErrors: { quoteId: "Select a valid quote." },
    });
  }
  if (mutation.expectedVersion === null || mutation.expectedVersion === "*") {
    await recordTeamMutationFailure(mutation, {
      entityType: "quote",
      entityId: quoteId,
      code: "invalid",
      metadata: { phase: "request_validation", reason: "version_required" },
    });
    return teamMutationErrorResponse(
      "invalid",
      "The latest quote version is required before deletion.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { version: "Refresh the quote and try again." },
      },
    );
  }
  const body = (await request.json().catch(() => null)) as {
    confirmation?: unknown;
  } | null;
  if (body?.confirmation !== "delete_quote") {
    await recordTeamMutationFailure(mutation, {
      entityType: "quote",
      entityId: quoteId,
      code: "invalid",
      metadata: { phase: "request_validation", reason: "confirmation" },
    });
    return teamMutationErrorResponse(
      "invalid",
      "Confirm this draft quote deletion.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: { confirmation: "Confirm deletion." },
      },
    );
  }

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "DELETE /api/quotes/:id",
      entityType: "quote",
      entityId: quoteId,
      payload: { confirmation: body.confirmation },
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const result = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({
          id: quotes.id,
          engineVersion: quotes.engineVersion,
          status: quotes.status,
          revision: quotes.revision,
          shareToken: quotes.shareToken,
          sentAt: quotes.sentAt,
          acceptedAppointmentId: quotes.acceptedAppointmentId,
        })
        .from(quotes)
        .where(eq(quotes.id, quoteId))
        .for("update")
        .limit(1);
      if (!existing) {
        throw new TeamMutationFailure("invalid", "The quote was not found.", {
          status: 404,
        });
      }
      if (existing.engineVersion !== "legacy") {
        throw new TeamMutationFailure(
          "conflict",
          "This versioned quote must be changed through its draft or lifecycle workflow.",
        );
      }
      assertTeamMutationExpectedVersion(mutation, existing.revision);
      if (
        existing.status !== "pending" ||
        existing.shareToken ||
        existing.sentAt ||
        existing.acceptedAppointmentId
      ) {
        throw new TeamMutationFailure(
          "conflict",
          "Only an unsent draft quote can be deleted. Keep customer-visible quotes as lifecycle evidence.",
        );
      }

      const [deleted] = await tx
        .delete(quotes)
        .where(
          and(
            eq(quotes.id, quoteId),
            eq(quotes.engineVersion, "legacy"),
            eq(quotes.revision, existing.revision),
          ),
        )
        .returning({ id: quotes.id });
      if (!deleted?.id) {
        throw new TeamMutationFailure(
          "conflict",
          "The quote changed while it was being deleted. Refresh and try again.",
          { retryable: true },
        );
      }

      const now = new Date();
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "quote",
        entityId: deleted.id,
        before: {
          status: existing.status,
          revision: existing.revision,
          customerVisible: false,
        },
        after: { deleted: true },
        committedAt: now,
      });
      const mutationResult = teamMutationSuccessResult(
        mutation,
        { quoteId: deleted.id, deleted: true },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "quote",
          entityId: deleted.id,
          version: String(existing.revision),
        },
      );
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
        mutationResult,
        200,
      );
      return mutationResult;
    });

    return teamMutationResultResponse(result, 200, mutation.correlationId);
  } catch (error) {
    if (db && claim) {
      await settleTeamMutationIdempotencyFailure(
        db,
        mutation,
        claim,
        error,
      ).catch(() => undefined);
    }
    await recordTeamMutationFailure(mutation, {
      entityType: "quote",
      entityId: quoteId,
      code: error instanceof TeamMutationFailure ? error.code : "internal",
      metadata: {
        phase: "mutation",
        retryable:
          error instanceof TeamMutationFailure ? error.retryable : true,
      },
    });
    return teamMutationExceptionResponse(error, mutation);
  }
}
