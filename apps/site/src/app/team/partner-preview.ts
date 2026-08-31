import { z } from "zod";

const InstantSchema = z.string().datetime({ offset: true });
const NullableTextSchema = z.string().max(5_000).nullable();
const MoneySchema = z
  .object({
    amountMinor: z.number().int().safe(),
    currency: z.string().regex(/^[A-Z]{3}$/u),
    minorUnit: z.literal(2),
  })
  .strict();
const ScheduleSchema = z
  .object({
    arrivalWindow: z
      .object({
        startAt: InstantSchema,
        endAt: InstantSchema,
        timezone: z.string().min(1).max(64),
      })
      .strict()
      .nullable(),
    completedAt: InstantSchema.nullable(),
  })
  .strict();
const SummaryAddressSchema = z
  .object({
    line1: z.string().min(1).max(500),
    city: z.string().max(200),
    state: z.string().max(32),
    postalCode: z.string().max(32),
  })
  .strict();
const JobSummarySchema = z
  .object({
    id: z.string().uuid(),
    status: z.string().min(1).max(80),
    confirmationMode: z.string().min(1).max(80),
    service: z
      .object({
        key: z.string().max(120).nullable(),
        tierKey: z.string().max(120).nullable(),
      })
      .strict(),
    schedule: ScheduleSchema,
    location: z
      .object({
        id: z.string().uuid().nullable(),
        name: z.string().max(500).nullable(),
        address: SummaryAddressSchema.nullable(),
      })
      .strict(),
    references: z
      .object({
        poNumber: z.string().max(500).nullable(),
        costCenter: z.string().max(500).nullable(),
        project: z.string().max(500).nullable(),
      })
      .strict(),
    financial: MoneySchema.nullable(),
    allowedActions: z.array(z.string()).length(0),
    createdAt: InstantSchema,
    updatedAt: InstantSchema,
  })
  .strict();
const DetailAddressSchema = SummaryAddressSchema.extend({
  line2: z.string().max(500).nullable(),
}).strict();
const JobDetailSchema = z
  .object({
    id: z.string().uuid(),
    status: z.string().min(1).max(80),
    confirmationMode: z.string().min(1).max(80),
    service: z
      .object({
        key: z.string().max(120).nullable(),
        tierKey: z.string().max(120).nullable(),
      })
      .strict(),
    schedule: ScheduleSchema,
    location: z
      .object({
        id: z.string().uuid().nullable(),
        name: z.string().max(500).nullable(),
        externalPropertyId: z.string().max(500).nullable(),
        address: DetailAddressSchema.nullable(),
        access: z
          .object({
            instructions: NullableTextSchema,
            parking: NullableTextSchema,
            loading: NullableTextSchema,
          })
          .strict(),
        onSiteContact: z.record(z.unknown()).nullable(),
      })
      .strict(),
    scope: z.record(z.unknown()).nullable(),
    proofRequirements: z.record(z.unknown()).nullable(),
    reviewReasons: z.array(z.string().max(500)).max(100),
    references: z
      .object({
        poNumber: z.string().max(500).nullable(),
        costCenter: z.string().max(500).nullable(),
        project: z.string().max(500).nullable(),
      })
      .strict(),
    financial: MoneySchema.nullable(),
    timeline: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            type: z.string().min(1).max(120),
            label: z.string().min(1).max(500),
            detail: NullableTextSchema,
            at: InstantSchema,
            actorType: z.string().min(1).max(80),
          })
          .strict(),
      )
      .max(200),
    evidence: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            category: z.string().min(1).max(80),
            caption: NullableTextSchema,
            filename: z.string().min(1).max(500),
            status: z.string().min(1).max(80),
            createdAt: InstantSchema,
          })
          .strict(),
      )
      .max(40),
    documents: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            type: z.string().min(1).max(120),
            version: z.number().int().positive(),
            filename: z.string().min(1).max(500),
            contentType: z.string().min(1).max(200),
            byteSize: z.number().int().nonnegative().safe(),
            generatedAt: InstantSchema,
          })
          .strict(),
      )
      .max(100),
    invoices: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            number: z.string().min(1).max(500),
            status: z.string().min(1).max(80),
            total: MoneySchema,
            paid: MoneySchema,
            balance: MoneySchema,
            dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).nullable(),
            issuedAt: InstantSchema.nullable(),
            paidAt: InstantSchema.nullable(),
          })
          .strict(),
      )
      .max(20),
    conversation: z
      .object({
        subject: z.string().max(500).nullable(),
        lastMessageAt: InstantSchema.nullable(),
      })
      .strict()
      .nullable(),
    allowedActions: z.array(z.string()).length(0),
    revision: z.number().int().positive(),
    createdAt: InstantSchema,
    updatedAt: InstantSchema,
  })
  .strict();

const PreviewSchema = z
  .object({
    readOnly: z.literal(true),
    previewScope: z.literal("account"),
    account: z
      .object({
        id: z.string().uuid(),
        name: z.string().min(1).max(500),
        status: z.string().min(1).max(120),
        portalAccessEnabled: z.boolean(),
        createdAt: InstantSchema,
        updatedAt: InstantSchema,
      })
      .strict(),
    summary: z
      .object({
        activeMemberCount: z.number().int().nonnegative().safe(),
        activeLocationCount: z.number().int().nonnegative().safe(),
        totalJobCount: z.number().int().nonnegative().safe(),
        statusCounts: z.record(z.number().int().nonnegative().safe()),
        outstandingBalances: z.array(MoneySchema).max(20),
      })
      .strict(),
    jobs: z.array(JobSummarySchema).max(100),
    page: z
      .object({
        limit: z.literal(100),
        returned: z.number().int().min(0).max(100),
        hasMore: z.boolean(),
      })
      .strict(),
    selectedJob: JobDetailSchema.nullable(),
  })
  .strict()
  .superRefine((preview, context) => {
    if (preview.page.returned !== preview.jobs.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["page", "returned"],
        message: "Returned count does not match jobs.",
      });
    }
  });

const PreviewResponseSchema = z
  .object({
    ok: z.literal(true),
    correlationId: z.string().min(1).max(256),
    readOnly: z.literal(true),
    preview: PreviewSchema,
  })
  .strict();

export type PartnerStaffPreviewPayload = z.infer<typeof PreviewSchema>;

export function parsePartnerStaffPreviewResponse(
  value: unknown,
): PartnerStaffPreviewPayload | null {
  const parsed = PreviewResponseSchema.safeParse(value);
  return parsed.success ? parsed.data.preview : null;
}
