import { and, desc, eq, gt, isNull, lte, or } from "drizzle-orm";
import {
  getDb,
  partnerAccountServiceAgreements,
  partnerDocuments,
  partnerRateCards,
  partnerRateItems,
} from "@/db";
import {
  findPartnerServiceEntitlement,
  isPartnerAgreementEffective,
  parsePersistedPartnerServiceEntitlements,
  type PartnerAccountServiceAgreementRecord,
  type PartnerAccountServiceEntitlement,
} from "@/lib/partner-account-service-agreement";
import type { TeamMutationTransaction } from "@/lib/team-mutation";
import { isPartnerAddOnTierKey } from "@myst-os/pricing";

const CURRENCY_PATTERN = /^[A-Z]{3}$/u;

export class PartnerServiceAgreementConfigurationError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "PartnerServiceAgreementConfigurationError";
  }
}

type AgreementRow = typeof partnerAccountServiceAgreements.$inferSelect;

function parseBoundedTextList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > 40) return null;
  const result: string[] = [];
  for (const item of value) {
    if (
      typeof item !== "string" ||
      item.length < 1 ||
      item.length > 500 ||
      item !== item.trim()
    ) {
      return null;
    }
    result.push(item);
  }
  return Object.freeze(result);
}

export function projectPartnerAccountServiceAgreement(
  row: AgreementRow,
): PartnerAccountServiceAgreementRecord {
  const currency = row.currency.trim().toUpperCase();
  const services = parsePersistedPartnerServiceEntitlements(
    row.serviceEntitlements,
  );
  const inclusions = parseBoundedTextList(row.inclusions);
  const exclusions = parseBoundedTextList(row.exclusions);
  if (
    !services ||
    !inclusions ||
    !exclusions ||
    !CURRENCY_PATTERN.test(currency) ||
    row.revision < 1
  ) {
    throw new PartnerServiceAgreementConfigurationError(
      "agreement_configuration_invalid",
    );
  }
  return Object.freeze({
    partnerAccountId: row.partnerAccountId,
    active: row.active,
    agreementLabel: row.agreementLabel,
    currency,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    inclusions,
    exclusions,
    quoteRules: row.quoteRules,
    agreementDocumentId: row.agreementDocumentId,
    services,
    revision: row.revision,
    updatedAt: row.updatedAt,
  });
}

export async function loadPartnerAccountServiceAgreement(
  tx: TeamMutationTransaction,
  input: { accountId: string; now: Date; lock?: boolean },
): Promise<PartnerAccountServiceAgreementRecord | null> {
  const query = tx
    .select()
    .from(partnerAccountServiceAgreements)
    .where(
      eq(partnerAccountServiceAgreements.partnerAccountId, input.accountId),
    );
  const rows = input.lock
    ? await query.for("update").limit(1)
    : await query.limit(1);
  const row = rows[0];
  if (!row) return null;
  const agreement = projectPartnerAccountServiceAgreement(row);
  return isPartnerAgreementEffective(agreement, input.now) ? agreement : null;
}

export type PartnerEffectiveRateOption = Readonly<{
  rateCardId: string;
  rateCardVersion: number;
  rateItemId: string;
  tierKey: string;
  label: string | null;
  amountMinor: number;
  sortOrder: number;
  currency: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}>;

/**
 * Resolves overlap by choosing the highest-version/latest-effective current
 * account card first, then reading only that card. Currency disagreement fails
 * closed instead of mixing rates from multiple agreements.
 */
export async function loadPartnerAgreementRateOptions(
  tx: TeamMutationTransaction,
  input: {
    accountId: string;
    serviceKey: string;
    agreementCurrency: string;
    now: Date;
  },
): Promise<readonly PartnerEffectiveRateOption[]> {
  const cards = await tx
    .select({
      id: partnerRateCards.id,
      version: partnerRateCards.version,
      currency: partnerRateCards.currency,
      effectiveFrom: partnerRateCards.effectiveFrom,
      effectiveTo: partnerRateCards.effectiveTo,
    })
    .from(partnerRateCards)
    .where(
      and(
        eq(partnerRateCards.partnerAccountId, input.accountId),
        eq(partnerRateCards.active, true),
        lte(partnerRateCards.effectiveFrom, input.now),
        or(
          isNull(partnerRateCards.effectiveTo),
          gt(partnerRateCards.effectiveTo, input.now),
        ),
      ),
    )
    .orderBy(
      desc(partnerRateCards.version),
      desc(partnerRateCards.effectiveFrom),
      desc(partnerRateCards.id),
    )
    .limit(2);
  const card = cards[0];
  if (!card) return Object.freeze([]);
  const currency = card.currency.trim().toUpperCase();
  if (
    !CURRENCY_PATTERN.test(currency) ||
    currency !== input.agreementCurrency
  ) {
    throw new PartnerServiceAgreementConfigurationError(
      "agreement_rate_currency_mismatch",
    );
  }
  const rows = await tx
    .select({
      rateItemId: partnerRateItems.id,
      tierKey: partnerRateItems.tierKey,
      label: partnerRateItems.label,
      amountMinor: partnerRateItems.amountCents,
      sortOrder: partnerRateItems.sortOrder,
    })
    .from(partnerRateItems)
    .where(
      and(
        eq(partnerRateItems.rateCardId, card.id),
        eq(partnerRateItems.serviceKey, input.serviceKey),
      ),
    );
  return Object.freeze(
    rows
      .filter((row) => !isPartnerAddOnTierKey(input.serviceKey, row.tierKey))
      .map((row) =>
        Object.freeze({
          rateCardId: card.id,
          rateCardVersion: card.version,
          ...row,
          currency,
          effectiveFrom: card.effectiveFrom,
          effectiveTo: card.effectiveTo,
        }),
      ),
  );
}

export async function requirePartnerServiceEntitlement(
  tx: TeamMutationTransaction,
  input: {
    accountId: string;
    serviceKey: string;
    now: Date;
  },
): Promise<{
  agreement: PartnerAccountServiceAgreementRecord;
  entitlement: PartnerAccountServiceEntitlement;
}> {
  const agreement = await loadPartnerAccountServiceAgreement(tx, {
    accountId: input.accountId,
    now: input.now,
  });
  const entitlement = agreement
    ? findPartnerServiceEntitlement(agreement, input.serviceKey)
    : null;
  if (!agreement || !entitlement) {
    throw new PartnerServiceAgreementConfigurationError("service_not_entitled");
  }
  return { agreement, entitlement };
}

export function partnerAgreementDto(
  agreement: PartnerAccountServiceAgreementRecord,
  document: { id: string; filename: string } | null,
) {
  return Object.freeze({
    label: agreement.agreementLabel,
    currency: agreement.currency,
    active: agreement.active,
    effectiveFrom: agreement.effectiveFrom.toISOString(),
    effectiveTo: agreement.effectiveTo?.toISOString() ?? null,
    inclusions: agreement.inclusions,
    exclusions: agreement.exclusions,
    quoteRules: agreement.quoteRules,
    services: agreement.services,
    document,
    revision: agreement.revision,
    updatedAt: agreement.updatedAt.toISOString(),
  });
}

export async function loadPartnerAgreementDocument(
  tx: TeamMutationTransaction,
  agreement: PartnerAccountServiceAgreementRecord,
): Promise<{ id: string; filename: string } | null> {
  if (!agreement.agreementDocumentId) return null;
  const [row] = await tx
    .select({ id: partnerDocuments.id, filename: partnerDocuments.filename })
    .from(partnerDocuments)
    .where(
      and(
        eq(partnerDocuments.partnerAccountId, agreement.partnerAccountId),
        eq(partnerDocuments.id, agreement.agreementDocumentId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function loadPartnerAgreementPresentation(input: {
  accountId: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  return getDb().transaction(async (tx) => {
    const agreement = await loadPartnerAccountServiceAgreement(tx, {
      accountId: input.accountId,
      now,
    });
    if (!agreement) return null;
    const document = await loadPartnerAgreementDocument(tx, agreement);
    return partnerAgreementDto(agreement, document);
  });
}
