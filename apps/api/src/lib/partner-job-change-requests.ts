import { z } from "zod";

export const PARTNER_JOB_CHANGE_REQUEST_REASON_MINIMUM = 5;
export const PARTNER_JOB_CHANGE_REQUEST_REASON_MAXIMUM = 1_000;
export const PARTNER_JOB_CHANGE_DESCRIPTION_MAXIMUM = 4_000;
export const PARTNER_JOB_CHANGE_INSTRUCTION_MAXIMUM = 2_000;
export const PARTNER_JOB_REFERENCE_MAXIMUM = 160;

const NullableBoundedText = (maximum: number) =>
  z.string().trim().min(1).max(maximum).nullable();

const OnSiteContactSchema = z
  .object({
    name: NullableBoundedText(160).optional(),
    phone: z
      .string()
      .trim()
      .min(7)
      .max(40)
      .regex(/^[0-9+().\-\sA-Za-z]+$/u)
      .nullable()
      .optional(),
    email: z.string().trim().email().max(254).nullable().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      !Object.values(value).some(
        (candidate) => typeof candidate === "string" && candidate.length > 0,
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Add at least one on-site contact field.",
      });
    }
  });

const MaterialitySchema = z
  .object({
    price: z.boolean(),
    schedule: z.boolean(),
    service: z.boolean(),
    quantity: z.boolean(),
    hazards: z.boolean(),
    proof: z.boolean(),
  })
  .strict();

export const PartnerJobChangeRequestBodySchema = z
  .object({
    reason: z
      .string()
      .trim()
      .min(PARTNER_JOB_CHANGE_REQUEST_REASON_MINIMUM)
      .max(PARTNER_JOB_CHANGE_REQUEST_REASON_MAXIMUM),
    proposedChanges: z
      .object({
        description: NullableBoundedText(
          PARTNER_JOB_CHANGE_DESCRIPTION_MAXIMUM,
        ).optional(),
        crewInstructions: NullableBoundedText(
          PARTNER_JOB_CHANGE_INSTRUCTION_MAXIMUM,
        ).optional(),
        accessDetails: NullableBoundedText(
          PARTNER_JOB_CHANGE_INSTRUCTION_MAXIMUM,
        ).optional(),
        onSiteContact: OnSiteContactSchema.nullable().optional(),
        materiality: MaterialitySchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const proposed = value.proposedChanges;
    const hasSafeField = [
      "description",
      "crewInstructions",
      "accessDetails",
      "onSiteContact",
    ].some((key) => Object.hasOwn(proposed, key));
    const hasMaterialFlag = Object.values(proposed.materiality).some(Boolean);
    if (!hasSafeField && !hasMaterialFlag) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["proposedChanges"],
        message: "Describe at least one proposed job change.",
      });
    }
  });

export const PartnerJobReferencesBodySchema = z
  .object({
    poNumber: NullableBoundedText(PARTNER_JOB_REFERENCE_MAXIMUM).optional(),
    costCenter: NullableBoundedText(PARTNER_JOB_REFERENCE_MAXIMUM).optional(),
    projectReference: NullableBoundedText(
      PARTNER_JOB_REFERENCE_MAXIMUM,
    ).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Object.keys(value).length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide at least one commercial reference.",
      });
    }
  });

export type PartnerJobChangeRequestBody = z.infer<
  typeof PartnerJobChangeRequestBodySchema
>;
export type PartnerJobReferencesBody = z.infer<
  typeof PartnerJobReferencesBodySchema
>;
export type PartnerJobChangeMateriality =
  PartnerJobChangeRequestBody["proposedChanges"]["materiality"];

export type PartnerJobPublicChangeFields = Readonly<{
  description: string | null;
  crewInstructions: string | null;
  accessDetails: string | null;
  onSiteContact: Readonly<Record<string, string | null>> | null;
}>;

export type PartnerJobChangeRequestSnapshot = Readonly<{
  version: 1;
  requestedAt: string;
  job: Readonly<{
    publicStatus: string;
    appointmentStatus: string;
    bookingRevision: number;
  }>;
  current: PartnerJobPublicChangeFields;
  proposed: PartnerJobChangeRequestBody["proposedChanges"];
}>;

function nullableSnapshotText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maximum
    ? normalized
    : null;
}

function snapshotOnSiteContact(
  value: unknown,
): Readonly<Record<string, string | null>> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const contact = Object.freeze({
    name: nullableSnapshotText(record["name"], 160),
    phone: nullableSnapshotText(record["phone"], 40),
    email: nullableSnapshotText(record["email"], 254),
  });
  return Object.values(contact).some((candidate) => candidate !== null)
    ? contact
    : null;
}

export function projectPartnerJobPublicChangeFields(
  scopeSnapshot: Readonly<Record<string, unknown>> | null,
): PartnerJobPublicChangeFields {
  const source = scopeSnapshot ?? {};
  return Object.freeze({
    description: nullableSnapshotText(
      source["description"],
      PARTNER_JOB_CHANGE_DESCRIPTION_MAXIMUM,
    ),
    crewInstructions: nullableSnapshotText(
      source["crewInstructions"],
      PARTNER_JOB_CHANGE_INSTRUCTION_MAXIMUM,
    ),
    accessDetails: nullableSnapshotText(
      source["accessDetails"],
      PARTNER_JOB_CHANGE_INSTRUCTION_MAXIMUM,
    ),
    onSiteContact: snapshotOnSiteContact(source["onSiteContact"]),
  });
}

export function createPartnerJobChangeRequestSnapshot(input: {
  requestedAt: Date;
  publicStatus: string;
  appointmentStatus: string;
  bookingRevision: number;
  scopeSnapshot: Readonly<Record<string, unknown>> | null;
  proposedChanges: PartnerJobChangeRequestBody["proposedChanges"];
}): PartnerJobChangeRequestSnapshot {
  return Object.freeze({
    version: 1 as const,
    requestedAt: input.requestedAt.toISOString(),
    job: Object.freeze({
      publicStatus: input.publicStatus,
      appointmentStatus: input.appointmentStatus,
      bookingRevision: input.bookingRevision,
    }),
    current: projectPartnerJobPublicChangeFields(input.scopeSnapshot),
    proposed: Object.freeze({
      ...input.proposedChanges,
      materiality: Object.freeze({ ...input.proposedChanges.materiality }),
      ...(input.proposedChanges.onSiteContact &&
      typeof input.proposedChanges.onSiteContact === "object"
        ? {
            onSiteContact: Object.freeze({
              ...input.proposedChanges.onSiteContact,
            }),
          }
        : {}),
    }),
  });
}

export function partnerJobChangeRequiresChangeOrder(
  proposed: PartnerJobChangeRequestBody["proposedChanges"],
): boolean {
  return Object.values(proposed.materiality).some(Boolean);
}

export function partnerJobChangeSnapshotStillMatches(
  snapshot: PartnerJobChangeRequestSnapshot,
  currentScopeSnapshot: Readonly<Record<string, unknown>> | null,
): boolean {
  return (
    JSON.stringify(snapshot.current) ===
    JSON.stringify(projectPartnerJobPublicChangeFields(currentScopeSnapshot))
  );
}

export function applyApprovedPartnerJobPublicChanges(input: {
  scopeSnapshot: Readonly<Record<string, unknown>> | null;
  proposed: PartnerJobChangeRequestBody["proposedChanges"];
}): Readonly<Record<string, unknown>> {
  if (partnerJobChangeRequiresChangeOrder(input.proposed)) {
    throw new TypeError(
      "Materially sensitive changes cannot be applied directly.",
    );
  }
  const next: Record<string, unknown> = { ...(input.scopeSnapshot ?? {}) };
  for (const key of [
    "description",
    "crewInstructions",
    "accessDetails",
    "onSiteContact",
  ] as const) {
    if (Object.hasOwn(input.proposed, key)) {
      next[key] = input.proposed[key] ?? null;
    }
  }
  return Object.freeze(next);
}
