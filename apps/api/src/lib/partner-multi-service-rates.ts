import { z } from "zod";
import {
  PartnerServiceRateCardInputSchema,
  type PartnerServiceRate,
} from "@myst-os/pricing";
import { requiredServiceRateVariants } from "./partner-multi-service-domain";

const rateSourceSchema = z.object({
  rateKey: z.string().min(1).max(80),
  rateCardVersionId: z.string().uuid(),
  version: z.number().int().positive(),
});
const snapshotMetadataSchema = z.object({
  rateCardVersionId: z.string().uuid(),
  version: z.number().int().positive(),
  portalVisible: z.boolean(),
  source: z.literal("structured"),
  rateSources: z.array(rateSourceSchema).max(200).optional(),
  minimumRateCardVersionId: z.string().uuid().optional(),
});

type SavedRateSnapshot = z.infer<typeof snapshotMetadataSchema> &
  z.infer<typeof PartnerServiceRateCardInputSchema>;
export type ApplicableServiceRateSnapshot = SavedRateSnapshot & {
  rateSources: z.infer<typeof rateSourceSchema>[];
  minimumRateCardVersionId: string;
};
export type ServiceLineRateEvidence = {
  serviceKey: string;
  scope: Record<string, unknown>;
  rateSnapshot: Record<string, unknown> | null;
  pricingSnapshot: Record<string, unknown> | null;
};

function parseSavedSnapshot(
  value: Record<string, unknown> | null,
  serviceKey: string,
): SavedRateSnapshot | null {
  if (!value) return null;
  const metadata = snapshotMetadataSchema.safeParse(value);
  const card = PartnerServiceRateCardInputSchema.safeParse({
    currency: value["currency"],
    visitMinimum: value["visitMinimum"],
    effectiveFrom: value["effectiveFrom"],
    effectiveTo: value["effectiveTo"],
    rates: value["rates"],
    quoteRequiredServiceKeys: value["quoteRequiredServiceKeys"],
  });
  if (
    !metadata.success ||
    !card.success ||
    card.data.rates.some((rate) => rate.serviceKey !== serviceKey)
  )
    throw new Error("partner_service_rate_snapshot_invalid");
  if (
    metadata.data.rateSources &&
    (metadata.data.rateSources.length !== card.data.rates.length ||
      new Set(metadata.data.rateSources.map((source) => source.rateKey))
        .size !== card.data.rates.length ||
      card.data.rates.some(
        (rate) =>
          !metadata.data.rateSources!.some(
            (source) => source.rateKey === rate.key,
          ),
      ))
  )
    throw new Error("partner_service_rate_snapshot_sources_invalid");
  return { ...card.data, ...metadata.data };
}

/** Existing negotiated variants and their minimum remain frozen. A later card
 * may supply only variants that have no saved rates, never replace known ones. */
export async function resolveApplicableServiceRates(
  line: ServiceLineRateEvidence,
  loadPublished: () => Promise<Record<string, unknown> | null>,
): Promise<ApplicableServiceRateSnapshot | null> {
  const required = requiredServiceRateVariants(line.serviceKey, line.scope);
  let primary: SavedRateSnapshot | null = null;
  const rates: PartnerServiceRate[] = [];
  const rateSources: z.infer<typeof rateSourceSchema>[] = [];
  const knownVariants = new Set<string>();
  let portalVisible = true;
  let quoteRequired = false;
  const merge = (value: Record<string, unknown> | null) => {
    const snapshot = parseSavedSnapshot(value, line.serviceKey);
    if (!snapshot) return;
    // An explicit quote choice is usable for a manually reviewed job amount.
    // It never erases negotiated rates already saved on this request.
    if (
      !rates.length &&
      snapshot.quoteRequiredServiceKeys?.some((key) => key === line.serviceKey)
    )
      quoteRequired = true;
    primary ??= snapshot;
    portalVisible &&= snapshot.portalVisible;
    const additions = snapshot.rates.filter(
      (rate) => !knownVariants.has(rate.variantKey),
    );
    if (!additions.length) return;
    for (const rate of additions) {
      if (rates.some((saved) => saved.key === rate.key))
        throw new Error("partner_service_rate_snapshot_key_collision");
      rates.push(rate);
      rateSources.push(
        snapshot.rateSources?.find((source) => source.rateKey === rate.key) ?? {
          rateKey: rate.key,
          rateCardVersionId: snapshot.rateCardVersionId,
          version: snapshot.version,
        },
      );
    }
    for (const rate of additions) knownVariants.add(rate.variantKey);
  };
  const complete = () =>
    quoteRequired || required.every((variant) => knownVariants.has(variant));
  merge(line.pricingSnapshot);
  if (!complete()) merge(line.rateSnapshot);
  if (!complete()) merge(await loadPublished());
  if (!primary || !complete()) return null;
  const selected = primary as SavedRateSnapshot;
  return {
    ...selected,
    rates,
    quoteRequiredServiceKeys: quoteRequired
      ? [line.serviceKey as PartnerServiceRate["serviceKey"]]
      : [],
    portalVisible,
    rateSources,
    minimumRateCardVersionId:
      selected.minimumRateCardVersionId ?? selected.rateCardVersionId,
  };
}
