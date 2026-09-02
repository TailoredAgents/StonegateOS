import { and, asc, desc, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import {
  getDb,
  partnerAccountServiceAgreements,
  partnerRateAddOnItems,
  partnerRateCards,
  partnerRateItems,
  partnerSchedulingProfiles,
  partnerServiceAddOnOptions,
  partnerServiceAddOns,
  partnerServiceCatalog,
} from "@/db";
import {
  findPartnerServiceEntitlement,
  partnerPricingStateRequiresRate,
  type PartnerServicePricingState,
} from "@/lib/partner-account-service-agreement";
import {
  PartnerServiceAgreementConfigurationError,
  projectPartnerAccountServiceAgreement,
} from "@/lib/partner-account-service-agreement-service";
import { MAX_PARTNER_SERVICE_ADD_ONS } from "@/lib/partner-portal-v2-service-add-ons";
import { isPartnerAddOnTierKey } from "@myst-os/pricing";

type PartnerCatalogMoney = Readonly<{
  amountMinor: number;
  currency: string;
  minorUnit: 2;
}>;

export type PartnerServiceCatalogAddOnDto = Readonly<{
  key: string;
  label: string;
  description: string;
  unitLabel: string;
  minimumQuantity: number;
  maximumQuantity: number;
  instantConfirmationMaxQuantity: number | null;
  requiresReview: boolean;
  pricingStatus: "contracted" | "review_required" | "hidden";
  unitPrice: PartnerCatalogMoney | null;
}>;

export type PartnerServiceCatalogItemDto = Readonly<{
  key: string;
  label: string;
  description: string;
  requiredScopeFields: readonly string[];
  defaultProofRequirements: Readonly<Record<string, unknown>>;
  bookable: boolean;
  priceState: PartnerServicePricingState;
  agreement: Readonly<{
    label: string;
    currency: string;
    effectiveFrom: string;
    effectiveTo: string | null;
  }>;
  inclusions: readonly string[];
  exclusions: readonly string[];
  quoteRule: string | null;
  pricingStatus: "contracted" | "review_required" | "hidden";
  basePrice: PartnerCatalogMoney | null;
  baseOptions: readonly Readonly<{
    tierKey: string;
    label: string;
    priceState: Exclude<PartnerServicePricingState, "quote_required">;
    pricingStatus: "contracted" | "review_required" | "hidden";
    price: PartnerCatalogMoney | null;
  }>[];
  addOns: readonly PartnerServiceCatalogAddOnDto[];
}>;

type BasePriceRow = Readonly<{
  serviceKey: string;
  amountMinor: number;
  currency: string;
  rateCardId: string;
  tierKey: string;
  label: string | null;
  sortOrder: number;
}>;

function normalizedMoney(
  amountMinor: number,
  currencyValue: string,
): PartnerCatalogMoney | null {
  const currency = currencyValue.trim().toUpperCase();
  if (
    !Number.isSafeInteger(amountMinor) ||
    amountMinor < 0 ||
    !/^[A-Z]{3}$/u.test(currency)
  ) {
    return null;
  }
  return Object.freeze({ amountMinor, currency, minorUnit: 2 as const });
}

/**
 * Builds the scheduling catalog for exactly one account. Negotiated amounts
 * are serialized only when the selected membership can read rates, and every
 * add-on amount must belong to the same effective account card as its base.
 */
export async function listPartnerServiceCatalog(input: {
  accountId: string;
  revealPrices: boolean;
  now?: Date;
}): Promise<readonly PartnerServiceCatalogItemDto[]> {
  const now = input.now ?? new Date();
  const db = getDb();
  const [agreementRow] = await db
    .select()
    .from(partnerAccountServiceAgreements)
    .where(
      and(
        eq(partnerAccountServiceAgreements.partnerAccountId, input.accountId),
        eq(partnerAccountServiceAgreements.active, true),
        lte(partnerAccountServiceAgreements.effectiveFrom, now),
        or(
          isNull(partnerAccountServiceAgreements.effectiveTo),
          gt(partnerAccountServiceAgreements.effectiveTo, now),
        ),
      ),
    )
    .limit(1);
  if (!agreementRow) return Object.freeze([]);
  const agreement = projectPartnerAccountServiceAgreement(agreementRow);
  const entitlementKeys = agreement.services.map((item) => item.serviceKey);
  const rows = await db
    .select({
      key: partnerServiceCatalog.key,
      label: partnerServiceCatalog.label,
      description: partnerServiceCatalog.description,
      requiredScopeFields: partnerServiceCatalog.requiredScopeFields,
      defaultProofRequirements: partnerServiceCatalog.defaultProofRequirements,
      profileVersion: partnerSchedulingProfiles.version,
    })
    .from(partnerServiceCatalog)
    .innerJoin(
      partnerSchedulingProfiles,
      eq(partnerSchedulingProfiles.serviceKey, partnerServiceCatalog.key),
    )
    .where(
      and(
        eq(partnerServiceCatalog.active, true),
        eq(partnerSchedulingProfiles.active, true),
        lte(partnerSchedulingProfiles.effectiveFrom, now),
        or(
          isNull(partnerSchedulingProfiles.effectiveTo),
          gt(partnerSchedulingProfiles.effectiveTo, now),
        ),
        inArray(partnerServiceCatalog.key, entitlementKeys),
      ),
    )
    .orderBy(
      partnerServiceCatalog.label,
      desc(partnerSchedulingProfiles.version),
    )
    .limit(200);
  const services: typeof rows = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.key)) continue;
    seen.add(row.key);
    services.push(row);
    if (services.length >= 100) break;
  }
  if (services.length === 0) return Object.freeze([]);
  const serviceKeys = services.map((service) => service.key);

  const options = await db
    .select({
      serviceKey: partnerServiceAddOnOptions.serviceKey,
      key: partnerServiceAddOns.key,
      label: partnerServiceAddOns.label,
      description: partnerServiceAddOns.description,
      unitLabel: partnerServiceAddOns.unitLabel,
      minimumQuantity: partnerServiceAddOnOptions.minimumQuantity,
      maximumQuantity: partnerServiceAddOnOptions.maximumQuantity,
      instantConfirmationMaxQuantity:
        partnerServiceAddOnOptions.instantConfirmationMaxQuantity,
      requiresReview: partnerServiceAddOnOptions.requiresReview,
      sortOrder: partnerServiceAddOnOptions.sortOrder,
    })
    .from(partnerServiceAddOnOptions)
    .innerJoin(
      partnerServiceAddOns,
      eq(partnerServiceAddOns.key, partnerServiceAddOnOptions.addOnKey),
    )
    .where(
      and(
        inArray(partnerServiceAddOnOptions.serviceKey, serviceKeys),
        eq(partnerServiceAddOnOptions.active, true),
        eq(partnerServiceAddOns.active, true),
      ),
    )
    .orderBy(
      partnerServiceAddOnOptions.serviceKey,
      asc(partnerServiceAddOnOptions.sortOrder),
      partnerServiceAddOns.label,
    )
    .limit(2_000);

  const [selectedCard] = await db
    .select({
      id: partnerRateCards.id,
      currency: partnerRateCards.currency,
      version: partnerRateCards.version,
      effectiveFrom: partnerRateCards.effectiveFrom,
    })
    .from(partnerRateCards)
    .where(
      and(
        eq(partnerRateCards.partnerAccountId, input.accountId),
        eq(partnerRateCards.active, true),
        lte(partnerRateCards.effectiveFrom, now),
        or(
          isNull(partnerRateCards.effectiveTo),
          gt(partnerRateCards.effectiveTo, now),
        ),
      ),
    )
    .orderBy(
      desc(partnerRateCards.version),
      desc(partnerRateCards.effectiveFrom),
      desc(partnerRateCards.id),
    )
    .limit(1);
  if (
    selectedCard &&
    selectedCard.currency.trim().toUpperCase() !== agreement.currency
  ) {
    throw new PartnerServiceAgreementConfigurationError(
      "agreement_rate_currency_mismatch",
    );
  }
  const baseRows: BasePriceRow[] = selectedCard
    ? await db
        .select({
          serviceKey: partnerRateItems.serviceKey,
          amountMinor: partnerRateItems.amountCents,
          currency: partnerRateCards.currency,
          rateCardId: partnerRateCards.id,
          tierKey: partnerRateItems.tierKey,
          label: partnerRateItems.label,
          sortOrder: partnerRateItems.sortOrder,
        })
        .from(partnerRateCards)
        .innerJoin(
          partnerRateItems,
          eq(partnerRateItems.rateCardId, partnerRateCards.id),
        )
        .where(
          and(
            eq(partnerRateCards.id, selectedCard.id),
            inArray(partnerRateItems.serviceKey, serviceKeys),
          ),
        )
        .orderBy(desc(partnerRateItems.sortOrder))
        .limit(1_000)
    : [];
  const baseCandidates = new Map<string, BasePriceRow[]>();
  for (const row of baseRows) {
    if (isPartnerAddOnTierKey(row.serviceKey, row.tierKey)) continue;
    const group = baseCandidates.get(row.serviceKey) ?? [];
    group.push(row);
    baseCandidates.set(row.serviceKey, group);
  }
  const selectedBase = new Map<string, BasePriceRow>();
  const selectedRateCard = new Map<string, BasePriceRow>();
  for (const [serviceKey, candidates] of baseCandidates) {
    if (
      candidates.length === 1 &&
      normalizedMoney(candidates[0]!.amountMinor, candidates[0]!.currency)
    ) {
      selectedBase.set(serviceKey, candidates[0]!);
    }
    const rateCardIds = new Set(
      candidates.map((candidate) => candidate.rateCardId),
    );
    const currencies = new Set(
      candidates.map((candidate) => candidate.currency.trim().toUpperCase()),
    );
    if (rateCardIds.size === 1 && currencies.size === 1 && candidates[0]) {
      selectedRateCard.set(serviceKey, candidates[0]);
    }
  }

  const selectedCardIds = [
    ...new Set([...selectedRateCard.values()].map((base) => base.rateCardId)),
  ];
  const addOnPriceRows =
    input.revealPrices && selectedCardIds.length > 0 && options.length > 0
      ? await db
          .select({
            rateCardId: partnerRateAddOnItems.rateCardId,
            serviceKey: partnerRateAddOnItems.serviceKey,
            addOnKey: partnerRateAddOnItems.addOnKey,
            unitAmountMinor: partnerRateAddOnItems.unitAmountCents,
          })
          .from(partnerRateAddOnItems)
          .innerJoin(
            partnerRateCards,
            eq(partnerRateCards.id, partnerRateAddOnItems.rateCardId),
          )
          .where(
            and(
              eq(partnerRateCards.partnerAccountId, input.accountId),
              inArray(partnerRateAddOnItems.rateCardId, selectedCardIds),
              inArray(partnerRateAddOnItems.serviceKey, serviceKeys),
            ),
          )
          .limit(2_000)
      : [];
  const addOnPrices = new Map(
    addOnPriceRows.map(
      (row) =>
        [
          `${row.rateCardId}:${row.serviceKey}:${row.addOnKey}`,
          row.unitAmountMinor,
        ] as const,
    ),
  );

  return Object.freeze(
    services.map((service) => {
      const entitlement = findPartnerServiceEntitlement(agreement, service.key);
      if (!entitlement) {
        throw new PartnerServiceAgreementConfigurationError(
          "service_not_entitled",
        );
      }
      const base = selectedBase.get(service.key) ?? null;
      const rateCard = selectedRateCard.get(service.key) ?? null;
      const basePrice =
        input.revealPrices && base
          ? normalizedMoney(base.amountMinor, base.currency)
          : null;
      const tierGroups = new Map<string, BasePriceRow[]>();
      for (const candidate of partnerPricingStateRequiresRate(
        entitlement.pricingState,
      )
        ? (baseCandidates.get(service.key) ?? [])
        : []) {
        const group = tierGroups.get(candidate.tierKey) ?? [];
        group.push(candidate);
        tierGroups.set(candidate.tierKey, group);
      }
      const baseOptions = Object.freeze(
        [...tierGroups.entries()]
          .flatMap(([tierKey, candidates]) => {
            if (candidates.length !== 1 || !candidates[0]) return [];
            const candidate = candidates[0];
            const price = input.revealPrices
              ? normalizedMoney(candidate.amountMinor, candidate.currency)
              : null;
            return [
              {
                tierKey,
                label:
                  candidate.label?.trim() ||
                  tierKey
                    .replace(/[-_]+/gu, " ")
                    .replace(/\b\w/gu, (letter) => letter.toUpperCase()),
                priceState: entitlement.pricingState as Exclude<
                  PartnerServicePricingState,
                  "quote_required"
                >,
                pricingStatus: input.revealPrices
                  ? price && entitlement.pricingState === "contracted"
                    ? ("contracted" as const)
                    : ("review_required" as const)
                  : ("hidden" as const),
                price,
                sortOrder: candidate.sortOrder,
              },
            ];
          })
          .sort(
            (left, right) =>
              left.sortOrder - right.sortOrder ||
              left.label.localeCompare(right.label),
          )
          .map(({ sortOrder: _sortOrder, ...option }) => Object.freeze(option)),
      );
      const allBaseOptionsContracted =
        baseOptions.length > 0 &&
        baseOptions.every((option) => option.pricingStatus === "contracted");
      const serviceOptions = options
        .filter((option) => option.serviceKey === service.key)
        .slice(0, MAX_PARTNER_SERVICE_ADD_ONS)
        .map((option): PartnerServiceCatalogAddOnDto => {
          const rawPrice = rateCard
            ? (addOnPrices.get(
                `${rateCard.rateCardId}:${service.key}:${option.key}`,
              ) ?? null)
            : null;
          const unitPrice =
            input.revealPrices && rateCard && rawPrice !== null
              ? normalizedMoney(rawPrice, rateCard.currency)
              : null;
          return Object.freeze({
            key: option.key,
            label: option.label,
            description: option.description,
            unitLabel: option.unitLabel,
            minimumQuantity: option.minimumQuantity,
            maximumQuantity: option.maximumQuantity,
            instantConfirmationMaxQuantity:
              option.instantConfirmationMaxQuantity,
            requiresReview: option.requiresReview,
            pricingStatus: input.revealPrices
              ? unitPrice
                ? "contracted"
                : "review_required"
              : "hidden",
            unitPrice,
          });
        });
      return Object.freeze({
        key: service.key,
        label: service.label,
        description: service.description,
        requiredScopeFields: Object.freeze([...service.requiredScopeFields]),
        defaultProofRequirements: Object.freeze({
          ...service.defaultProofRequirements,
        }),
        bookable:
          entitlement.pricingState === "quote_required" ||
          baseOptions.length > 0,
        priceState: entitlement.pricingState,
        agreement: Object.freeze({
          label: agreement.agreementLabel,
          currency: agreement.currency,
          effectiveFrom: agreement.effectiveFrom.toISOString(),
          effectiveTo: agreement.effectiveTo?.toISOString() ?? null,
        }),
        inclusions: Object.freeze([...entitlement.inclusions]),
        exclusions: Object.freeze([...entitlement.exclusions]),
        quoteRule: entitlement.quoteRule,
        pricingStatus: input.revealPrices
          ? entitlement.pricingState === "contracted" &&
            allBaseOptionsContracted
            ? "contracted"
            : "review_required"
          : "hidden",
        basePrice,
        baseOptions,
        addOns: Object.freeze(serviceOptions),
      });
    }),
  );
}
