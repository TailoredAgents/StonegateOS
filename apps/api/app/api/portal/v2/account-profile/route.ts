import type { NextRequest } from "next/server";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { auditLogs, getDb, partnerAccounts } from "@/db";
import { sanitizeAuditMetadata } from "@/lib/audit-metadata";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";
import {
  hasPartnerCapability,
  requirePartnerCapability,
  resolvePartnerPrincipal,
  type PartnerCapability,
  type PartnerPrincipal,
} from "@/lib/partner-account-authorization";
import { normalizePartnerAccountName } from "@/lib/partner-accounts";
import { hasRecentPartnerMfa } from "@/lib/partner-recent-mfa";
import {
  arePartnerPortalV2ReadsEnabled,
  arePartnerPortalV2WritesEnabled,
} from "@/lib/partner-portal-feature-flags";
import { isAllowedPartnerPortalMutationOrigin } from "@/lib/partner-portal-v2-security";
import {
  createPortalV2StrongEtag,
  evaluatePortalV2RevisionPrecondition,
  readPortalV2CorrelationId,
} from "@/lib/portal-v2-contract";
import {
  createPartnerPortalV2DescriptorResponse,
  createPartnerPortalV2ErrorResponse,
  createPartnerPortalV2SuccessResponse,
  createPartnerPortalV2UnexpectedResponse,
} from "@/lib/partner-portal-v2-response";

const NullableText = (maximum: number) =>
  z.union([z.string().trim().min(1).max(maximum), z.null()]);
const NullableEmail = z.union([
  z
    .string()
    .trim()
    .email()
    .max(254)
    .transform((value) => value.toLowerCase()),
  z.null(),
]);
const NullablePhone = z.union([
  z
    .string()
    .trim()
    .regex(/^\+[1-9][0-9]{7,14}$/u),
  z.null(),
]);
const NullableWebsite = z.union([
  z
    .string()
    .trim()
    .max(2_048)
    .transform((value, context) => {
      try {
        const url = new URL(value);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password
        ) {
          throw new Error("unsupported_url");
        }
        url.hash = "";
        return url.toString();
      } catch {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Enter a valid HTTP or HTTPS website.",
        });
        return z.NEVER;
      }
    }),
  z.null(),
]);

const ContactSchema = z
  .object({
    name: NullableText(160),
    email: NullableEmail,
    phoneE164: NullablePhone,
  })
  .strict()
  .superRefine((value, context) => {
    const empty =
      value.name === null && value.email === null && value.phoneE164 === null;
    if (!empty && (!value.name || !value.email)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide both a contact name and email, or clear all fields.",
      });
    }
  });

const BillingAddressSchema = z
  .object({
    line1: NullableText(200),
    line2: NullableText(200),
    city: NullableText(120),
    state: NullableText(64),
    postalCode: NullableText(20),
    country: z.union([
      z
        .string()
        .trim()
        .regex(/^[A-Za-z]{2}$/u)
        .transform((value) => value.toUpperCase()),
      z.null(),
    ]),
  })
  .strict()
  .superRefine((value, context) => {
    const values = [
      value.line1,
      value.line2,
      value.city,
      value.state,
      value.postalCode,
      value.country,
    ];
    const empty = values.every((item) => item === null);
    if (
      !empty &&
      (!value.line1 ||
        !value.city ||
        !value.state ||
        !value.postalCode ||
        !value.country)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Complete the billing street, city, state, postal code, and country.",
      });
    }
  });

const AccountProfilePatchSchema = z
  .object({
    organization: z
      .object({
        name: z.string().trim().min(1).max(160),
        website: NullableWebsite,
      })
      .strict()
      .optional(),
    serviceContact: ContactSchema.optional(),
    billing: z
      .object({
        contact: ContactSchema,
        address: BillingAddressSchema,
        defaultPoNumber: NullableText(80),
        costCenterGuidance: NullableText(500),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      Boolean(value.organization || value.serviceContact || value.billing),
    { message: "Provide at least one account-profile section." },
  );

const profileSelection = {
  id: partnerAccounts.id,
  name: partnerAccounts.name,
  website: partnerAccounts.website,
  portalAccessEnabled: partnerAccounts.portalAccessEnabled,
  profileRevision: partnerAccounts.profileRevision,
  serviceContactName: partnerAccounts.serviceContactName,
  serviceContactEmail: partnerAccounts.serviceContactEmail,
  serviceContactPhoneE164: partnerAccounts.serviceContactPhoneE164,
  billingContactName: partnerAccounts.billingContactName,
  billingContactEmail: partnerAccounts.billingContactEmail,
  billingContactPhoneE164: partnerAccounts.billingContactPhoneE164,
  billingAddressLine1: partnerAccounts.billingAddressLine1,
  billingAddressLine2: partnerAccounts.billingAddressLine2,
  billingAddressCity: partnerAccounts.billingAddressCity,
  billingAddressState: partnerAccounts.billingAddressState,
  billingAddressPostalCode: partnerAccounts.billingAddressPostalCode,
  billingAddressCountry: partnerAccounts.billingAddressCountry,
  defaultPoNumber: partnerAccounts.defaultPoNumber,
  costCenterGuidance: partnerAccounts.costCenterGuidance,
  updatedAt: partnerAccounts.updatedAt,
};

type ProfileRow = Pick<
  typeof partnerAccounts.$inferSelect,
  keyof typeof profileSelection
>;

function safeWebsite(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      return null;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function partnerAccountProfileRevision(row: ProfileRow): string {
  return JSON.stringify({
    accountId: row.id,
    revision: row.profileRevision,
    organization: [row.name, row.website],
    service: [
      row.serviceContactName,
      row.serviceContactEmail,
      row.serviceContactPhoneE164,
    ],
    billing: [
      row.billingContactName,
      row.billingContactEmail,
      row.billingContactPhoneE164,
      row.billingAddressLine1,
      row.billingAddressLine2,
      row.billingAddressCity,
      row.billingAddressState,
      row.billingAddressPostalCode,
      row.billingAddressCountry,
      row.defaultPoNumber,
      row.costCenterGuidance,
    ],
  });
}

function dto(row: ProfileRow, principal: PartnerPrincipal) {
  const canViewBilling =
    hasPartnerCapability(principal, "commercial.edit") ||
    hasPartnerCapability(principal, "invoices.read");
  return {
    id: row.id,
    organization: {
      name: row.name.trim(),
      website: safeWebsite(row.website),
    },
    serviceContact: {
      name: row.serviceContactName,
      email: row.serviceContactEmail,
      phoneE164: row.serviceContactPhoneE164,
    },
    billing: canViewBilling
      ? {
          contact: {
            name: row.billingContactName,
            email: row.billingContactEmail,
            phoneE164: row.billingContactPhoneE164,
          },
          address: {
            line1: row.billingAddressLine1,
            line2: row.billingAddressLine2,
            city: row.billingAddressCity,
            state: row.billingAddressState,
            postalCode: row.billingAddressPostalCode,
            country: row.billingAddressCountry,
          },
          defaultPoNumber: row.defaultPoNumber,
          costCenterGuidance: row.costCenterGuidance,
        }
      : null,
    permissions: {
      canEditOrganization:
        principal.accessLevel === "account" &&
        hasPartnerCapability(principal, "account.update"),
      canEditBilling:
        principal.accessLevel === "account" &&
        hasPartnerCapability(principal, "commercial.edit"),
      canViewBilling,
    },
    revision: row.profileRevision,
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function loadProfile(accountId: string): Promise<ProfileRow | null> {
  const [row] = await getDb()
    .select(profileSelection)
    .from(partnerAccounts)
    .where(eq(partnerAccounts.id, accountId))
    .limit(1);
  return row ?? null;
}

function capabilityFailure(
  principal: PartnerPrincipal,
  required: readonly PartnerCapability[],
): { status: number; error: string } | null {
  if (principal.accessLevel !== "account") {
    return { status: 403, error: "forbidden" };
  }
  if (
    required.some((capability) => !hasPartnerCapability(principal, capability))
  ) {
    return { status: 403, error: "forbidden" };
  }
  if (!hasRecentPartnerMfa(principal)) {
    return { status: 403, error: "mfa_step_up_required" };
  }
  return null;
}

export async function GET(request: NextRequest): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  const authorization = await requirePartnerCapability(request, "account.read");
  if (!authorization.ok) {
    return createPartnerPortalV2ErrorResponse(
      authorization.error,
      authorization.status,
      correlationId,
    );
  }
  const { principal } = authorization;
  if (!principal.accountId) {
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
    const row = await loadProfile(principal.accountId);
    if (!row?.portalAccessEnabled) {
      return createPartnerPortalV2ErrorResponse(
        "not_found",
        404,
        correlationId,
      );
    }
    return createPartnerPortalV2SuccessResponse(
      { ok: true, profile: dto(row, principal) },
      correlationId,
      200,
      { ETag: createPortalV2StrongEtag(partnerAccountProfileRevision(row)) },
    );
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}

export async function PATCH(request: NextRequest): Promise<Response> {
  const correlationId = readPortalV2CorrelationId(request.headers);
  if (!isAllowedPartnerPortalMutationOrigin(request)) {
    return createPartnerPortalV2ErrorResponse("forbidden", 403, correlationId);
  }
  const authentication = await resolvePartnerPrincipal(request);
  if (!authentication.ok) {
    return createPartnerPortalV2ErrorResponse(
      authentication.error,
      authentication.status,
      correlationId,
    );
  }
  const { principal } = authentication;
  if (!principal.accountId || !principal.membershipId) {
    return createPartnerPortalV2ErrorResponse("not_found", 404, correlationId);
  }
  if (!arePartnerPortalV2WritesEnabled(principal.accountId)) {
    return createPartnerPortalV2ErrorResponse(
      "service_unavailable",
      503,
      correlationId,
    );
  }

  let raw: unknown;
  try {
    raw = await readBoundedJsonRequest(request, {
      maximumBytes: 8 * 1_024,
      deadlineMs: 10_000,
      rejectDuplicateObjectKeys: true,
    });
  } catch (error) {
    return createPartnerPortalV2ErrorResponse(
      error instanceof BoundedJsonRequestError && error.code === "invalid_body"
        ? "invalid_body"
        : "invalid_request",
      error instanceof BoundedJsonRequestError ? error.status : 400,
      correlationId,
    );
  }
  const parsed = AccountProfilePatchSchema.safeParse(raw);
  if (!parsed.success) {
    return createPartnerPortalV2ErrorResponse(
      "invalid_fields",
      422,
      correlationId,
    );
  }
  const requiredCapabilities = [
    ...(parsed.data.organization || parsed.data.serviceContact
      ? (["account.update"] as const)
      : []),
    ...(parsed.data.billing ? (["commercial.edit"] as const) : []),
  ] satisfies PartnerCapability[];
  const failure = capabilityFailure(principal, requiredCapabilities);
  if (failure) {
    return createPartnerPortalV2ErrorResponse(
      failure.error,
      failure.status,
      correlationId,
    );
  }

  try {
    const result = await getDb().transaction(async (tx) => {
      const [current] = await tx
        .select(profileSelection)
        .from(partnerAccounts)
        .where(eq(partnerAccounts.id, principal.accountId!))
        .for("update")
        .limit(1);
      if (!current?.portalAccessEnabled) return { kind: "not_found" as const };
      const precondition = evaluatePortalV2RevisionPrecondition({
        ifMatch: request.headers.get("if-match"),
        currentRevision: partnerAccountProfileRevision(current),
        correlationId,
      });
      if (!precondition.ok) {
        return {
          kind: "precondition" as const,
          response: precondition.response,
        };
      }

      const patch: Partial<typeof partnerAccounts.$inferInsert> = {};
      const changedSections: string[] = [];
      if (parsed.data.organization) {
        const normalizedName = normalizePartnerAccountName(
          parsed.data.organization.name,
        );
        if (!normalizedName) return { kind: "invalid" as const };
        patch.name = parsed.data.organization.name;
        patch.normalizedName = normalizedName;
        patch.website = parsed.data.organization.website;
        changedSections.push("organization");
      }
      if (parsed.data.serviceContact) {
        patch.serviceContactName = parsed.data.serviceContact.name;
        patch.serviceContactEmail = parsed.data.serviceContact.email;
        patch.serviceContactPhoneE164 = parsed.data.serviceContact.phoneE164;
        changedSections.push("service_contact");
      }
      if (parsed.data.billing) {
        patch.billingContactName = parsed.data.billing.contact.name;
        patch.billingContactEmail = parsed.data.billing.contact.email;
        patch.billingContactPhoneE164 = parsed.data.billing.contact.phoneE164;
        patch.billingAddressLine1 = parsed.data.billing.address.line1;
        patch.billingAddressLine2 = parsed.data.billing.address.line2;
        patch.billingAddressCity = parsed.data.billing.address.city;
        patch.billingAddressState = parsed.data.billing.address.state;
        patch.billingAddressPostalCode = parsed.data.billing.address.postalCode;
        patch.billingAddressCountry = parsed.data.billing.address.country;
        patch.defaultPoNumber = parsed.data.billing.defaultPoNumber;
        patch.costCenterGuidance = parsed.data.billing.costCenterGuidance;
        changedSections.push("billing");
      }
      const now = new Date();
      const [updated] = await tx
        .update(partnerAccounts)
        .set({
          ...patch,
          profileRevision: sql`${partnerAccounts.profileRevision} + 1`,
          updatedAt: now,
        })
        .where(eq(partnerAccounts.id, current.id))
        .returning(profileSelection);
      if (!updated?.id) return { kind: "not_found" as const };
      await tx.insert(auditLogs).values({
        actorType: "human",
        actorId: principal.partnerUserId,
        actorLabel: principal.email,
        actorRole: principal.roleKey,
        sessionId: principal.session.id,
        authMethod: "partner_session",
        correlationId,
        requiredPermissions: requiredCapabilities,
        outcome: "succeeded",
        surface: "/partners/settings",
        action: "partner.account_profile.updated",
        entityType: "partner_account",
        entityId: principal.accountId,
        meta: sanitizeAuditMetadata({
          partnerAccountId: principal.accountId,
          partnerMembershipId: principal.membershipId,
          changedSections,
          previousRevision: current.profileRevision,
          revision: updated.profileRevision,
        }),
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
    if (result.kind === "invalid") {
      return createPartnerPortalV2ErrorResponse(
        "invalid_fields",
        422,
        correlationId,
      );
    }
    if (result.kind === "precondition") {
      return createPartnerPortalV2DescriptorResponse(result.response);
    }
    return createPartnerPortalV2SuccessResponse(
      { ok: true, profile: dto(result.row, principal) },
      correlationId,
      200,
      {
        ETag: createPortalV2StrongEtag(
          partnerAccountProfileRevision(result.row),
        ),
      },
    );
  } catch (error) {
    return createPartnerPortalV2UnexpectedResponse(correlationId, error);
  }
}
