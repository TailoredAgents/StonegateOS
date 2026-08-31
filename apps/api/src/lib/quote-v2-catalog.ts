import {
  professionalQuoteBundlePresets,
  professionalQuoteServiceCatalogKeys,
  professionalQuoteZonePresets,
} from "@myst-os/pricing/src/quote-catalog";
import { TeamMutationFailure } from "@/lib/team-mutation";

type CatalogPolicyDocument = {
  pricing: {
    lineItems: Array<{ catalogKey?: string | null }>;
    adjustments: Array<{
      id: string;
      kind: string;
      calculation: string;
      basisPoints?: number | null;
      amountCents?: number | null;
    }>;
  };
  serviceZoneId?: string | null;
  serviceZoneConfirmed?: boolean;
};

function invalid(message: string, fieldErrors: Record<string, string>): never {
  throw new TeamMutationFailure("invalid", message, { fieldErrors });
}

export function assertQuoteV2CatalogPolicy(
  document: CatalogPolicyDocument,
  options: { requireConfirmedZone: boolean },
): void {
  const catalogLines = document.pricing.lineItems.filter(
    (line) => line.catalogKey !== null && line.catalogKey !== undefined,
  );
  const catalogKeys = catalogLines.map((line) => line.catalogKey!);
  const unknownCatalogKey = catalogKeys.find(
    (key) => !professionalQuoteServiceCatalogKeys.has(key),
  );
  if (unknownCatalogKey) {
    invalid("The proposal contains an unknown service preset.", {
      catalog: `Remove or replace “${unknownCatalogKey}”.`,
    });
  }
  if (new Set(catalogKeys).size !== catalogKeys.length) {
    invalid("A catalog service cannot be added twice.", {
      catalog:
        "Combine duplicate service presets into one quantity or use a custom line.",
    });
  }

  const catalogKeySet = new Set(catalogKeys);
  for (const adjustment of document.pricing.adjustments) {
    if (!adjustment.id.startsWith("bundle:")) continue;
    const bundle = professionalQuoteBundlePresets.find(
      (candidate) => candidate.adjustmentId === adjustment.id,
    );
    if (!bundle) {
      invalid("The proposal contains an unknown bundle discount.", {
        adjustments: `Remove or replace “${adjustment.id}”.`,
      });
    }
    if (
      adjustment.kind !== "discount" ||
      adjustment.calculation !== "percentage" ||
      adjustment.basisPoints !== bundle.basisPoints ||
      !bundle.requiredCatalogKeys.every((key) => catalogKeySet.has(key))
    ) {
      invalid("The bundle discount no longer matches its catalog policy.", {
        adjustments:
          "Add every required service and reapply the approved bundle preset.",
      });
    }
  }

  const zoneId = document.serviceZoneId ?? null;
  if (!zoneId) {
    if (options.requireConfirmedZone) {
      invalid("Confirm the service zone before finalizing.", {
        serviceZoneId: "Choose the zone for the service property.",
      });
    }
    return;
  }
  const zone = professionalQuoteZonePresets.find(
    (candidate) => candidate.id === zoneId,
  );
  if (!zone) {
    invalid("The proposal contains an unknown service zone.", {
      serviceZoneId: "Choose a configured service zone.",
    });
  }
  if (options.requireConfirmedZone && !document.serviceZoneConfirmed) {
    invalid("Confirm the service zone before finalizing.", {
      serviceZoneConfirmed:
        "Verify the property against the service-area policy.",
    });
  }
  const travelAdjustments = document.pricing.adjustments.filter(
    (adjustment) => adjustment.id === "service-zone-travel",
  );
  if (zone.travelFeeCents === 0 && travelAdjustments.length > 0) {
    invalid("The selected service zone has no configured travel charge.", {
      adjustments: "Remove the service-zone travel adjustment.",
    });
  }
  if (
    zone.travelFeeCents > 0 &&
    (travelAdjustments.length !== 1 ||
      travelAdjustments[0]?.kind !== "travel" ||
      travelAdjustments[0]?.calculation !== "fixed" ||
      travelAdjustments[0]?.amountCents !== zone.travelFeeCents)
  ) {
    invalid("The travel charge does not match the confirmed service zone.", {
      adjustments:
        "Choose the service zone again to restore its visible charge.",
    });
  }
}
