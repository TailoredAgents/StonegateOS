import { z } from "zod";
import { addOns, bundles, defaultPricingContext, serviceRates, zones } from "../config/defaults";
import type {
  QuoteBreakdown,
  QuoteRequestInput,
  ServiceBaseRate,
  ZoneConfig,
  ConcreteSurfaceKind
} from "../types";

const CONCRETE_RATE = 0.14;

const knownZoneIds = new Set(zones.map((zone) => zone.id));
// Validation starts from untrusted JSON strings, so the membership set must
// accept strings even though the catalog itself is narrowed to ServiceCategory.
const knownServiceIds: ReadonlySet<string> = new Set(
  serviceRates.map((rate) => rate.service),
);
const knownAddOnIds = new Set(addOns.map((addOn) => addOn.id));

const quoteInputSchema = z.object({
  zoneId: z.string().refine((value) => knownZoneIds.has(value), "invalid_zone"),
  surfaceArea: z.number().positive().optional(),
  selectedServices: z
    .array(z.string().refine((value) => knownServiceIds.has(value), "invalid_service"))
    .min(1)
    .max(50)
    .refine((values) => new Set(values).size === values.length, "duplicate_service"),
  selectedAddOns: z
    .array(z.string().refine((value) => knownAddOnIds.has(value), "invalid_add_on"))
    .max(50)
    .refine((values) => new Set(values).size === values.length, "duplicate_add_on")
    .optional(),
  applyBundles: z.boolean().optional(),
  depositRate: z.number().positive().max(1).optional(),
  serviceOverrides: z
    .record(
      z.string().refine((value) => knownServiceIds.has(value), "invalid_override_service"),
      z.number().positive(),
    )
    .optional(),
  concreteSurfaces: z
    .array(
      z.object({
        kind: z.enum(["driveway", "deck", "other"]),
        squareFeet: z.number().positive()
      })
    )
    .max(3)
    .optional()
}).superRefine((input, context) => {
  const overrideKeys = Object.keys(input.serviceOverrides ?? {});
  if (overrideKeys.length > 50) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["serviceOverrides"],
      message: "too_many_overrides",
    });
  }
  for (const serviceId of overrideKeys) {
    if (!input.selectedServices.includes(serviceId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["serviceOverrides", serviceId],
        message: "override_service_not_selected",
      });
    }
  }
  if (
    input.concreteSurfaces &&
    input.concreteSurfaces.length > 0 &&
    input.serviceOverrides?.["driveway"] !== undefined
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["serviceOverrides", "driveway"],
      message: "driveway_override_conflicts_with_surfaces",
    });
  }
});

function resolveZone(zoneId: string): ZoneConfig {
  const found = zones.find((zone) => zone.id === zoneId);
  if (!found) throw new Error(`Unknown service zone: ${zoneId}`);
  return found;
}

function resolveServiceRate(serviceId: string): ServiceBaseRate | undefined {
  return serviceRates.find((rate) => rate.service === serviceId);
}

function computeServiceAmount(rate: ServiceBaseRate, surfaceArea?: number): number {
  if (typeof rate.flatRate === "number") {
    return rate.flatRate;
  }

  const area = Math.max(
    surfaceArea ?? rate.minimumSquareFootage ?? 0,
    rate.minimumSquareFootage ?? 0,
  );
  const variable = rate.pricePerSquareFoot ? area * rate.pricePerSquareFoot : 0;
  const base = rate.basePrice ?? 0;

  return Math.max(base, base + variable);
}

function computeBundleDiscount(serviceIds: string[], applyBundles: boolean | undefined): number {
  if (!applyBundles) {
    return 0;
  }

  const eligibleBundles = bundles.filter((bundle) =>
    bundle.services.every((service) => serviceIds.includes(service))
  );

  if (!eligibleBundles.length) {
    return 0;
  }

  const discounts = eligibleBundles.map((bundle) => {
    const bundleTotal = bundle.services.reduce((total, serviceId) => {
      const rate = resolveServiceRate(serviceId);
      if (!rate) {
        return total;
      }
      return total + computeServiceAmount(rate);
    }, 0);

    return (bundleTotal * bundle.discountPercentage) / 100;
  });

  // Bundle savings are explicit alternatives, not silently stackable coupons.
  return Math.max(...discounts);
}

export function calculateQuoteBreakdown(
  input: QuoteRequestInput,
  options?: { depositRate?: number }
): QuoteBreakdown {
  const parsed = quoteInputSchema.safeParse(input);
  if (!parsed.success) {
    throw parsed.error;
  }

  const {
    zoneId,
    surfaceArea,
    selectedServices,
    selectedAddOns,
    applyBundles,
    depositRate,
    serviceOverrides,
    concreteSurfaces
  } = parsed.data;
  const zone = resolveZone(zoneId);
  const overrides = (serviceOverrides ?? {}) as Record<string, number>;
  const normalizedConcreteSurfaces = (concreteSurfaces ?? []).map((surface) => ({
    kind: surface.kind as ConcreteSurfaceKind,
    squareFeet: surface.squareFeet
  }));

  const concreteLineItems: QuoteBreakdown["lineItems"] = [];
  let concreteTotal = 0;

  if (normalizedConcreteSurfaces.length > 0) {
    normalizedConcreteSurfaces.forEach((surface, index) => {
      const labelBase =
        surface.kind === "driveway"
          ? "Driveway"
          : surface.kind === "deck"
            ? "Deck/Patio"
            : "Concrete Surface";
      const amount = Math.round(surface.squareFeet * CONCRETE_RATE * 100) / 100;
      concreteTotal += amount;
      concreteLineItems.push({
        id: `concrete-${index}`,
        label: `${labelBase} ${index + 1} (${surface.squareFeet} sq ft)`,
        amount,
        category: "service"
      });
    });

    overrides["driveway"] = Math.round(concreteTotal * 100) / 100;
  }

  const lineItems: QuoteBreakdown["lineItems"] = [];

  const servicesSubtotal = selectedServices.reduce((sum, serviceId) => {
    const rate = resolveServiceRate(serviceId);

    if (!rate) {
      return sum;
    }

    if (serviceId === "driveway" && concreteLineItems.length > 0) {
      lineItems.push(...concreteLineItems);
      return sum + concreteTotal;
    }

    const overrideAmount = overrides[serviceId];
    const amount =
      typeof overrideAmount === "number"
        ? overrideAmount
        : computeServiceAmount(rate, surfaceArea);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error(
        `${rate.label} requires a positive staff-reviewed price.`,
      );
    }
    lineItems.push({
      id: `service-${serviceId}`,
      label: rate.label,
      amount,
      category: "service"
    });

    return sum + amount;
  }, 0);

  const addOnsTotal = (selectedAddOns ?? []).reduce((total, addOnId) => {
    const config = addOns.find((item) => item.id === addOnId);
    if (!config) {
      return total;
    }

    lineItems.push({
      id: `addon-${config.id}`,
      label: config.name,
      amount: config.price,
      category: "add-on"
    });

    return total + config.price;
  }, 0);

  const travelFee = selectedServices.some((serviceId) => {
    const rate = resolveServiceRate(serviceId);
    return rate?.includesTravel;
  })
    ? 0
    : zone.travelFee;

  if (travelFee > 0) {
    lineItems.push({
      id: "travel-fee",
      label: `${zone.name} travel`,
      amount: travelFee,
      category: "travel"
    });
  }

  const subtotal = servicesSubtotal + addOnsTotal + travelFee;
  const allowBundleDiscounts = applyBundles && Object.keys(overrides).length === 0;
  const discounts = computeBundleDiscount(selectedServices, allowBundleDiscounts);
  const total = subtotal - discounts;

  if (discounts > 0) {
    lineItems.push({
      id: "bundle-discount",
      label: "Bundle Savings",
      amount: -discounts,
      category: "discount"
    });
  }

  const resolvedDepositRate =
    options?.depositRate ?? depositRate ?? input.depositRate ?? 0;
  const depositDue = Math.round(total * resolvedDepositRate * 100) / 100;
  const balanceDue = Math.max(total - depositDue, 0);

  return {
    subtotal,
    travelFee,
    discounts,
    addOnsTotal,
    total,
    depositDue,
    balanceDue,
    depositRate: resolvedDepositRate,
    lineItems
  };
}
