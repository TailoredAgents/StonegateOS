import { z } from "zod";
import { getPartnerServiceDefinition } from "@myst-os/pricing";
import {
  resolvePartnerApprovalRequirement,
  type PartnerApprovalRequirementResolution,
} from "./partner-portal-v2-approvals";

export const PartnerMultiServicePriceSchema = z
  .object({
    accountId: z.string().uuid(),
    linePrices: z
      .array(
        z
          .object({
            serviceLineId: z.string().uuid(),
            amountCents: z.number().int().nonnegative().max(2147483647),
            description: z.string().trim().min(3).max(4000),
            charges: z
              .array(
                z
                  .object({
                    rateKey: z.string().min(1).max(80),
                    quantity: z
                      .string()
                      .regex(/^(?:0|[1-9]\d{0,7})(?:\.\d{1,4})?$/)
                      .refine((value) => Number(value) > 0),
                  })
                  .strict(),
              )
              .min(1)
              .max(30)
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(8),
    reason: z.string().trim().min(12).max(1000),
  })
  .strict();

export function requiredServiceRateVariants(
  serviceKey: string,
  scope: Record<string, unknown>,
): string[] {
  const definition = getPartnerServiceDefinition(serviceKey);
  if (!definition) throw new Error("Unsupported service.");
  const selected =
    serviceKey === "soft-washing"
      ? scope["washArea"]
      : serviceKey === "painting"
        ? scope["workArea"]
        : serviceKey === "drywall-repair-paint"
          ? scope["paintCoverage"]
          : "standard";
  return definition.variants.some((variant) => variant.key === selected)
    ? [String(selected)]
    : definition.variants.map((variant) => variant.key);
}
export const PartnerMultiServiceVisitSchema = z
  .object({
    accountId: z.string().uuid(),
    serviceLineIds: z.array(z.string().uuid()).min(1).max(8),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    startTime: z.string().regex(/^(?:[01]\d|2[0-3]):(?:00|30)$/),
    durationMinutes: z.number().int().min(30).max(1440),
    travelBufferMinutes: z.number().int().min(0).max(240),
    resourceIds: z.array(z.string().uuid()).max(30).default([]),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.serviceLineIds).size === value.serviceLineIds.length,
    { message: "Choose each service once.", path: ["serviceLineIds"] },
  );
export const PartnerMultiServiceVisitStatusSchema = z
  .object({
    accountId: z.string().uuid(),
    status: z.enum(["in_progress", "completed", "canceled"]),
    completedServiceLineIds: z.array(z.string().uuid()).max(8).default([]),
  })
  .strict();

export function sumExplicitLinePrices(
  lines: readonly { id: string }[],
  prices: readonly { serviceLineId: string; amountCents: number }[],
): number {
  if (
    lines.length !== prices.length ||
    new Set(prices.map((price) => price.serviceLineId)).size !==
      prices.length ||
    prices.some(
      (price) =>
        !lines.some((line) => line.id === price.serviceLineId) ||
        !Number.isSafeInteger(price.amountCents) ||
        price.amountCents < 0,
    )
  )
    throw new Error("Every service needs exactly one explicit price.");
  const total = prices.reduce((sum, price) => sum + price.amountCents, 0);
  if (!Number.isSafeInteger(total) || total > 2147483647)
    throw new Error("The confirmed total exceeds the supported amount.");
  return total;
}

/** One minimum for each actual, uncanceled visit; service count never multiplies it. */
export function requiredVisitMinimum(
  visits: readonly { status: string; minimumAmountCents: number }[],
  nextMinimum = 0,
): number {
  return visits
    .filter((visit) => visit.status !== "canceled")
    .reduce((sum, visit) => sum + visit.minimumAmountCents, nextMinimum);
}

export function unscheduledMultiServiceLineIds(
  lines: readonly { id: string; status: string }[],
  visits: readonly { status: string; serviceLineIds: readonly string[] }[],
) {
  const covered = new Set(
    visits
      .filter((visit) => ["scheduled", "in_progress"].includes(visit.status))
      .flatMap((visit) => [...visit.serviceLineIds]),
  );
  return lines
    .filter(
      (line) =>
        !["completed", "canceled"].includes(line.status) &&
        !covered.has(line.id),
    )
    .map((line) => line.id);
}

export function multiServiceParentStatus(
  lines: readonly { id: string; status: string }[],
  visits: readonly { status: string; serviceLineIds: readonly string[] }[],
) {
  if (
    lines.length &&
    lines.every((line) => ["completed", "canceled"].includes(line.status)) &&
    visits.every((visit) => ["completed", "canceled"].includes(visit.status))
  )
    return "completed";
  if (
    visits.some((visit) => ["in_progress", "completed"].includes(visit.status))
  )
    return "in_progress";
  if (visits.some((visit) => visit.status === "scheduled"))
    return unscheduledMultiServiceLineIds(lines, visits).length
      ? "partially_scheduled"
      : "confirmed";
  return "under_review";
}

export function combineMultiServiceApprovals(
  resolutions: readonly PartnerApprovalRequirementResolution[],
): PartnerApprovalRequirementResolution {
  const first = resolutions[0];
  if (!first) throw new Error("At least one service is required.");
  const matched = [
    ...new Map(
      resolutions
        .flatMap((resolution) => resolution.matchedRules)
        .map((rule) => [rule.id, rule]),
    ).values(),
  ];
  return matched.length
    ? {
        context: first.context,
        required: true,
        requiredDecisionCount: Math.max(
          ...matched.map((rule) => rule.requiredDecisionCount),
        ),
        matchedRules: matched,
      }
    : {
        context: first.context,
        required: false,
        requiredDecisionCount: 0,
        matchedRules: [],
      };
}

export async function resolveMultiServiceApproval(
  input: Omit<
    Parameters<typeof resolvePartnerApprovalRequirement>[0],
    "serviceKey"
  > & { serviceKeys: readonly string[] },
) {
  const resolutions: PartnerApprovalRequirementResolution[] = [];
  for (const serviceKey of new Set(input.serviceKeys))
    resolutions.push(
      await resolvePartnerApprovalRequirement({ ...input, serviceKey }),
    );
  return combineMultiServiceApprovals(resolutions);
}
