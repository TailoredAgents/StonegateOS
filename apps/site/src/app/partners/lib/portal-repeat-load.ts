import { z } from "zod";
import { PartnerServiceLinesInputSchema } from "@myst-os/pricing";

const text = z.string();
const nullable = text.nullable();
const date = text.refine((value) => Number.isFinite(Date.parse(value)));
const template = z
  .object({
    active: z.boolean(),
    reusable: z
      .object({
        modelVersion: z.union([z.literal(1), z.literal(2)]).optional(),
        serviceLines: PartnerServiceLinesInputSchema.optional(),
        description: text.optional(),
        crewInstructions: nullable.optional(),
      })
      .optional(),
    id: text,
    name: text,
    serviceKey: nullable,
    locationId: nullable,
    updatedAt: date,
    etag: text,
  })
  .superRefine((value, context) => {
    if (value.reusable?.modelVersion === 2) {
      if (value.serviceKey !== null || !value.reusable.serviceLines?.length)
        context.addIssue({
          code: "custom",
          message: "The multi-service shortcut is incomplete.",
        });
    } else if (
      value.serviceKey === null ||
      value.reusable?.serviceLines?.length
    )
      context.addIssue({
        code: "custom",
        message: "The service shortcut is incomplete.",
      });
  });
const series = z.object({
  id: text,
  name: text,
  state: text,
  revision: z.number().int(),
  etag: text,
  endsOn: nullable,
  lifecycle: z
    .object({
      action: z.enum(["pause", "resume", "cancel"]),
      reason: text,
      changedAt: date,
    })
    .nullable(),
  occurrences: z.array(
    z.object({
      id: text,
      localDate: text,
      state: text,
      draftId: nullable,
      jobId: nullable,
      currentJobStatus: nullable,
      reason: nullable,
    }),
  ),
});
const bulk = z.object({
  id: text,
  state: text,
  etag: text,
  dryRun: z.boolean(),
  rowCount: z.number(),
  validCount: z.number(),
  errorCount: z.number(),
  correctionCsv: text,
  capacityReserved: z.boolean(),
  pendingCount: z.number(),
  confirmedCount: z.number(),
  reviewCount: z.number(),
  rows: z.array(
    z.object({
      rowNumber: z.number(),
      state: text,
      draftId: nullable,
      jobId: nullable,
      errors: z.array(
        z.object({ field: text.optional(), message: text.optional() }),
      ),
    }),
  ),
});
const templatesPage = z.object({
  ok: z.literal(true),
  templates: z.array(template),
  nextCursor: nullable,
});
const seriesPage = z.object({
  ok: z.literal(true),
  series: z.array(series),
  nextCursor: nullable,
});
const bulkPage = z.object({
  ok: z.literal(true),
  imports: z.array(
    z.object({ id: text, filename: text, state: text, createdAt: date }),
  ),
  nextCursor: nullable,
});
const bulkDetail = z.object({ ok: z.literal(true), import: bulk });
function parser<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>) {
  return (payload: unknown): T | null => {
    const result = schema.safeParse(payload);
    return result.success ? result.data : null;
  };
}
export type PortalServiceTemplate = z.infer<typeof template>;
export type PortalRecurringSeries = z.infer<typeof series>;
export type PortalBulkImport = z.infer<typeof bulk>;
export const parsePortalTemplates = parser(templatesPage);
export const parsePortalRecurringSeries = parser(seriesPage);
export const parsePortalBulkHistory = parser(bulkPage);
export const parsePortalBulkImport = parser(bulkDetail);
