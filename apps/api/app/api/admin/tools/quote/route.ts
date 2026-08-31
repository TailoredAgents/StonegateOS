import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { calculateQuoteBreakdown } from "@myst-os/pricing/src/engine/calculate";
import { serviceRates, zones } from "@myst-os/pricing/src/config/defaults";
import type { ServiceCategory } from "@myst-os/pricing/src/types";
import { appointments, contacts, getDb, leads, quoteVersions } from "@/db";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import { QuoteDraftDocumentSchema } from "@/lib/quote-v2-contract";
import { QUOTE_V2_SCHEMA_VERSION } from "@/lib/quote-v2-domain";
import { isQuoteV2FeatureEnabled } from "@/lib/feature-flags";
import {
  createQuoteV2Draft,
  saveQuoteV2Draft,
} from "@/lib/quote-v2-staff-service";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  type TeamMutationIdempotencyClaim,
  teamMutationIdempotencyReplayResponse,
} from "@/lib/team-mutation-idempotency";
import {
  beginTeamMutation,
  recordTeamMutationFailure,
  TeamMutationFailure,
  teamMutationErrorResponse,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";
import { loadContactPropertyById } from "@/lib/property-write";
import { requirePermission } from "@/lib/permissions";

export const dynamic = "force-dynamic";

const SERVICE_IDS = new Set<string>(serviceRates.map((rate) => rate.service));
const SERVICE_LABELS = new Map<ServiceCategory, string>(
  serviceRates.map((rate) => [rate.service, rate.label]),
);
const ZONE_IDS = new Set(zones.map((zone) => zone.id));
const DEFAULT_ZONE_ID = zones[0]?.id ?? "zone-core";

const optionalUuid = z.preprocess(
  (value) => (value === null || value === "" ? undefined : value),
  z.string().uuid().optional(),
);
const optionalText = (maximum: number) =>
  z.preprocess(
    (value) => (value === null || value === "" ? undefined : value),
    z.string().trim().min(1).max(maximum).optional(),
  );

const CreateQuoteToolSchema = z
  .object({
    appointmentId: optionalUuid,
    contactId: optionalUuid,
    propertyId: optionalUuid,
    services: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .refine((value) => SERVICE_IDS.has(value), "unknown_service"),
      )
      .max(30)
      .refine(
        (values) => new Set(values).size === values.length,
        "duplicate_service",
      )
      .default([]),
    notes: optionalText(8_000),
    zoneId: z.preprocess(
      (value) => (value === null || value === "" ? undefined : value),
      z
        .string()
        .trim()
        .refine((value) => ZONE_IDS.has(value), "unknown_zone")
        .optional(),
    ),
    expiresInDays: z.number().int().min(1).max(120).optional(),
    projectName: optionalText(240),
    projectReference: optionalText(160),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.appointmentId && (!value.contactId || !value.propertyId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contactId"],
        message: "contact_and_property_or_appointment_required",
      });
    }
  });

type ToolInput = z.infer<typeof CreateQuoteToolSchema>;

function cents(value: number): number {
  const result = Math.round(value * 100);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new TeamMutationFailure(
      "invalid",
      "The calculated draft price is invalid.",
      { fieldErrors: { pricing: "Review the selected service prices." } },
    );
  }
  return result;
}

function customerName(contact: {
  firstName: string;
  lastName: string;
}): string {
  return `${contact.firstName} ${contact.lastName}`.trim() || "Customer";
}

function propertyLabel(property: {
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
}): string {
  return [
    property.addressLine1,
    property.city,
    property.state,
    property.postalCode,
  ]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(", ");
}

export async function POST(request: NextRequest): Promise<Response> {
  const permissionError = await requirePermission(
    request,
    ["quotes.write", "contacts.read", "properties.read"],
    { mode: "all" },
  );
  if (permissionError) return permissionError;
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["quotes.write", "contacts.read", "properties.read"],
    risk: "normal",
    requiresIdempotency: true,
    auditAction: "quote.v2_legacy_adapter_created",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;

  if (!isQuoteV2FeatureEnabled("staff")) {
    await recordTeamMutationFailure(mutation, {
      outcome: "denied",
      entityType: "quote",
      code: "operation_disabled",
      metadata: {
        phase: "feature_flag",
        feature: "quote_v2_staff",
        adapter: "admin_tool",
      },
    });
    return teamMutationErrorResponse(
      "forbidden",
      "The versioned quote workspace is not enabled for this cohort.",
      { correlationId: mutation.correlationId, status: 404 },
    );
  }

  let body: unknown;
  try {
    body = await readBoundedJsonRequest(request, {
      maximumBytes: 16 * 1024,
      rejectDuplicateObjectKeys: true,
    });
  } catch (error) {
    const failure =
      error instanceof BoundedJsonRequestError
        ? error
        : new BoundedJsonRequestError(
            "invalid_body",
            "The quote request could not be read.",
            400,
          );
    return teamMutationErrorResponse("invalid", failure.message, {
      correlationId: mutation.correlationId,
      fieldErrors: { request: failure.code },
    });
  }
  const parsed = CreateQuoteToolSchema.safeParse(body);
  if (!parsed.success) {
    await recordTeamMutationFailure(mutation, {
      entityType: "quote_v2",
      code: "invalid",
      metadata: { phase: "legacy_adapter_validation" },
    });
    return teamMutationErrorResponse(
      "invalid",
      "Choose a valid client, property, zone, and unique service presets.",
      {
        correlationId: mutation.correlationId,
        fieldErrors: Object.fromEntries(
          parsed.error.issues.map((issue) => [
            issue.path.join(".") || "quote",
            issue.message,
          ]),
        ),
      },
    );
  }
  const actorTeamMemberId = mutation.actor.id;
  if (!actorTeamMemberId || !mutation.idempotencyKeyHash) {
    return teamMutationErrorResponse(
      "internal",
      "The verified team action is incomplete.",
      { correlationId: mutation.correlationId },
    );
  }

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/admin/tools/quote",
      entityType: "quote_v2",
      entityId: "new",
      payload: parsed.data,
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;
    const result = await db.transaction(async (tx) => {
      const resolved = await resolveToolSubject(tx, parsed.data);
      const selectedServices = resolveServices(
        parsed.data.services,
        resolved.leadServices,
      );
      const zoneId = parsed.data.zoneId ?? DEFAULT_ZONE_ID;
      const audience =
        resolved.contact.company?.trim() ||
        selectedServices.includes("commercial")
          ? "commercial"
          : "residential";
      const name =
        parsed.data.projectName ??
        `${resolved.contact.company?.trim() || customerName(resolved.contact)} estimate`;
      const created = await createQuoteV2Draft(tx, {
        command: {
          confirmation: "create_quote_v2",
          contactId: resolved.contact.id,
          propertyId: resolved.property.id,
          leadId: resolved.leadId,
          projectName: name,
          projectReference: parsed.data.projectReference ?? null,
          audience,
          documentType: "estimate",
          schedulingMode:
            audience === "commercial" ? "staff_followup" : "self_schedule",
        },
        actorTeamMemberId,
        correlationId: mutation.correlationId,
      });
      const [version] = await tx
        .select({ documentSnapshot: quoteVersions.documentSnapshot })
        .from(quoteVersions)
        .where(
          and(
            eq(quoteVersions.id, created.versionId),
            eq(quoteVersions.quoteId, created.quoteId),
          ),
        )
        .limit(1);
      if (!version) {
        throw new TeamMutationFailure(
          "internal",
          "The canonical quote draft could not be loaded.",
        );
      }
      const initial = QuoteDraftDocumentSchema.parse(version.documentSnapshot);
      const breakdown = calculateQuoteBreakdown({
        zoneId,
        selectedServices,
        selectedAddOns: [],
        applyBundles: false,
      });
      const lineItems = breakdown.lineItems
        .filter(
          (item) => item.category === "service" || item.category === "add-on",
        )
        .map((item, index) => ({
          id: item.id,
          catalogKey: item.id.startsWith("service-")
            ? `service:${item.id.slice("service-".length)}`
            : null,
          name: item.label,
          description: null,
          quantity: 1,
          unit: "project",
          unitPriceMinCents: cents(item.amount),
          unitPriceMaxCents: null,
          optionGroupId: null,
          selectedByDefault: false,
          displayOrder: index,
        }));
      const adjustments = [
        ...(breakdown.travelFee > 0
          ? [
              {
                id: "service-zone-travel",
                kind: "travel" as const,
                label: `${zones.find((zone) => zone.id === zoneId)?.name ?? "Service zone"} travel`,
                calculation: "fixed" as const,
                basis: "subtotal" as const,
                eligibleLineItemIds: [],
                amountCents: cents(breakdown.travelFee),
                basisPoints: null,
                displayOrder: 0,
              },
            ]
          : []),
      ];
      const serviceNames = selectedServices.map(
        (service) => SERVICE_LABELS.get(service) ?? service,
      );
      const document = QuoteDraftDocumentSchema.parse({
        ...initial,
        schemaVersion: QUOTE_V2_SCHEMA_VERSION,
        scope: `Prepare a professional estimate for ${serviceNames.join(", ")}.`,
        pricing: {
          documentType: "estimate",
          currency: "USD",
          lineItems,
          optionGroups: [],
          adjustments,
          deposit: { mode: "none" },
        },
        terms: {
          templateVersion: `stonegate-${audience}-draft-v1`,
          validityDays:
            parsed.data.expiresInDays ?? (audience === "commercial" ? 30 : 14),
          consentVersion: "estimate-consent-v1",
        },
        estimatedDurationMinutes: 120,
        serviceZoneId: zoneId,
        serviceZoneConfirmed: Boolean(parsed.data.zoneId),
      });
      const saved = await saveQuoteV2Draft(tx, {
        quoteId: created.quoteId,
        command: {
          confirmation: "save_quote_draft",
          versionId: created.versionId,
          draftRevision: created.draftRevision,
          document,
          internalNotes: parsed.data.notes ?? null,
        },
        actorTeamMemberId,
        correlationId: mutation.correlationId,
        expectedDraftRevision: created.draftRevision,
      });
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "quote",
        entityId: created.quoteId,
        after: {
          engineVersion: "v2",
          state: "draft",
          versionId: created.versionId,
          quoteRevision: saved.quoteRevision,
          draftRevision: saved.draftRevision,
        },
        metadata: {
          adapter: "admin_tool",
          sourceAppointmentId: parsed.data.appointmentId ?? null,
          serviceCount: selectedServices.length,
        },
      });
      const [savedVersion] = await tx
        .select({ updatedAt: quoteVersions.updatedAt })
        .from(quoteVersions)
        .where(
          and(
            eq(quoteVersions.id, created.versionId),
            eq(quoteVersions.quoteId, created.quoteId),
          ),
        )
        .limit(1);
      if (!savedVersion) {
        throw new TeamMutationFailure(
          "internal",
          "The saved quote version could not be verified.",
        );
      }
      const recordVersion = savedVersion.updatedAt.toISOString();
      const receipt = {
        ok: true as const,
        quoteId: created.quoteId,
        versionId: created.versionId,
        quoteNumber: created.quoteNumber,
        engineVersion: "v2" as const,
        state: "draft" as const,
        quoteRevision: saved.quoteRevision,
        draftRevision: saved.draftRevision,
        version: recordVersion,
        services: selectedServices,
        totalCents: saved.totals?.totalMinCents ?? cents(breakdown.total),
        summary: `Professional estimate draft ${created.quoteNumber} created for ${customerName(resolved.contact)} at ${propertyLabel(resolved.property)}. Review it in Quotes before issuing.`,
      };
      const mutationResult = teamMutationSuccessResult(mutation, receipt, {
        auditEventId: audit.auditEventId,
        committedAt: audit.committedAt,
        entityType: "quote",
        entityId: created.quoteId,
        version: recordVersion,
      });
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
        mutationResult,
        201,
      );
      return mutationResult;
    });
    return teamMutationResultResponse(result, 201, mutation.correlationId);
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
      entityType: "quote_v2",
      code: error instanceof TeamMutationFailure ? error.code : "internal",
      metadata: { phase: "legacy_adapter_create" },
    });
    return teamMutationExceptionResponse(error, mutation);
  }
}

async function resolveToolSubject(
  tx: Parameters<typeof createQuoteV2Draft>[0],
  input: ToolInput,
) {
  let contactId = input.contactId ?? null;
  let propertyId = input.propertyId ?? null;
  let leadId: string | null = null;
  let leadServices: string[] = [];
  if (input.appointmentId) {
    const [appointment] = await tx
      .select({
        contactId: appointments.contactId,
        propertyId: appointments.propertyId,
        leadId: appointments.leadId,
        leadServices: leads.servicesRequested,
      })
      .from(appointments)
      .leftJoin(leads, eq(leads.id, appointments.leadId))
      .where(eq(appointments.id, input.appointmentId))
      .limit(1);
    if (!appointment?.contactId || !appointment.propertyId) {
      throw new TeamMutationFailure(
        "invalid",
        "The appointment does not have a complete client and property.",
        {
          status: 404,
          fieldErrors: { appointmentId: "Choose a current appointment." },
        },
      );
    }
    if (
      (contactId && contactId !== appointment.contactId) ||
      (propertyId && propertyId !== appointment.propertyId)
    ) {
      throw new TeamMutationFailure(
        "conflict",
        "The selected appointment does not match the client and property.",
      );
    }
    contactId = appointment.contactId;
    propertyId = appointment.propertyId;
    leadId = appointment.leadId;
    leadServices = Array.isArray(appointment.leadServices)
      ? appointment.leadServices
      : [];
  }
  if (!contactId || !propertyId) {
    throw new TeamMutationFailure(
      "invalid",
      "A client and service property are required.",
    );
  }
  const [contact] = await tx
    .select({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      company: contacts.company,
      deletedAt: contacts.deletedAt,
    })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);
  if (!contact || contact.deletedAt) {
    throw new TeamMutationFailure("invalid", "The client was not found.", {
      status: 404,
    });
  }
  const property = await loadContactPropertyById(tx, {
    contactId: contact.id,
    propertyId,
  });
  if (!property) {
    throw new TeamMutationFailure(
      "invalid",
      "The property is not associated with this client.",
      { status: 404 },
    );
  }
  return { contact, property, leadId, leadServices };
}

function resolveServices(
  primary: string[],
  fallback: string[],
): ServiceCategory[] {
  const candidates = primary.length > 0 ? primary : fallback;
  if (
    candidates.length < 1 ||
    candidates.length > 30 ||
    new Set(candidates).size !== candidates.length ||
    candidates.some((service) => !SERVICE_IDS.has(service))
  ) {
    throw new TeamMutationFailure(
      "invalid",
      "Choose one or more unique service presets.",
      {
        fieldErrors: {
          services:
            "Unknown, duplicate, and empty service selections are not accepted.",
        },
      },
    );
  }
  if (candidates.includes("other")) {
    throw new TeamMutationFailure(
      "invalid",
      "A custom service needs a staff-reviewed line item and price.",
      {
        fieldErrors: {
          services:
            "Choose a priced service preset, or finish the custom line item in Quotes.",
        },
      },
    );
  }
  return candidates as ServiceCategory[];
}
