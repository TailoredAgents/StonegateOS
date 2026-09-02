import { z } from "zod";

export const PARTNER_APPROVAL_RULE_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const unique = <T>(values: T[]) => new Set(values).size === values.length;
const ServiceKeySchema = z.string().regex(/^[a-z][a-z0-9_-]{1,79}$/u);
const UuidSchema = z.string().regex(PARTNER_APPROVAL_RULE_UUID_PATTERN);
const RoleKeySchema = z.enum([
  "administrator",
  "operations",
  "billing_approver",
  "viewer",
]);
const PresenceSchema = z.enum(["present", "missing"]);

export const PartnerApprovalRuleConditionsSchema = z
  .object({
    serviceKeys: z
      .array(ServiceKeySchema)
      .min(1)
      .max(50)
      .refine(unique, "Service conditions must be unique.")
      .optional(),
    locationIds: z
      .array(UuidSchema)
      .min(1)
      .max(100)
      .refine(unique, "Location conditions must be unique.")
      .optional(),
    minimumAmountMinor: z.number().int().nonnegative().safe().optional(),
    maximumAmountMinor: z.number().int().nonnegative().safe().optional(),
    requesterRoleKeys: z
      .array(RoleKeySchema)
      .min(1)
      .max(4)
      .refine(unique, "Requester roles must be unique.")
      .optional(),
    poNumberState: PresenceSchema.optional(),
    costCenterState: PresenceSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.minimumAmountMinor !== undefined &&
      value.maximumAmountMinor !== undefined &&
      value.maximumAmountMinor < value.minimumAmountMinor
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maximumAmountMinor"],
        message: "Maximum amount must be at least the minimum amount.",
      });
    }
  });

const RuleValuesSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    conditions: PartnerApprovalRuleConditionsSchema,
    requiredDecisionCount: z.number().int().min(1).max(20),
    active: z.boolean(),
    reason: z.string().trim().min(12).max(1_000),
  })
  .strict();

export const CreatePartnerApprovalRuleSchema = RuleValuesSchema.extend({
  confirmation: z.literal("CREATE APPROVAL RULE"),
}).strict();

export const UpdatePartnerApprovalRuleSchema = RuleValuesSchema.extend({
  confirmation: z.literal("UPDATE APPROVAL RULE"),
}).strict();

export function parseIncludeInactive(
  params: URLSearchParams,
): { ok: true; value: boolean } | { ok: false; message: string } {
  const values = params.getAll("includeInactive");
  if (values.length > 1) {
    return {
      ok: false,
      message: "includeInactive may only be provided once.",
    };
  }
  const raw = values[0];
  if (raw === undefined) return { ok: true, value: false };
  if (raw === "true") return { ok: true, value: true };
  if (raw === "false") return { ok: true, value: false };
  return {
    ok: false,
    message: "includeInactive must be true or false.",
  };
}
