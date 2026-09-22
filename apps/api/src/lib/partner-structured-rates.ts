import { and, asc, desc, eq, lte, sql } from "drizzle-orm";
import type { PartnerServiceRateWriteSchema } from "@myst-os/pricing";
import {
  getPartnerRateCompleteness,
  PartnerServiceRateCardInputSchema,
  PartnerServiceRateSchema,
  PartnerQuoteRequiredServicesSchema,
  type PartnerServiceKeyV2,
  type PartnerServiceRate,
} from "@myst-os/pricing";
import type { z } from "zod";
import type { getDb } from "@/db";
import {
  partnerAccounts,
  partnerRateCards,
  partnerRateItems,
  partnerRateCardVersions,
  partnerRateCardVersionItems,
} from "@/db";
import { loadPartnerStaffInvitationAuthority } from "./partner-invitation-authority";
import {
  assertTeamMutationExpectedVersion,
  TeamMutationFailure,
  type TeamMutationContext,
  type TeamMutationTransaction,
} from "./team-mutation";

type RateReader = Pick<ReturnType<typeof getDb>, "select">;
export type PartnerPublishedServiceRateCard = {
  rateCardVersionId: string;
  version: number;
  currency: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  visitMinimum: string | null;
  portalVisible: boolean;
  source: "structured" | "legacy";
  rates: PartnerServiceRate[];
  quoteRequiredServiceKeys?: PartnerServiceKeyV2[];
  legacyItems: Array<{
    id: string;
    serviceKey: string;
    tierKey: string;
    label: string | null;
    amountCents: number;
  }>;
  complete: boolean;
  missing: ReturnType<typeof getPartnerRateCompleteness>["missing"];
};

/** The newest effective published version is authoritative, even when it has expired. */
export async function loadPartnerPublishedServiceRateCard(
  db: RateReader,
  input: { accountId: string; now?: Date },
): Promise<PartnerPublishedServiceRateCard | null> {
  const now = input.now ?? new Date();
  const [version] = await db
    .select()
    .from(partnerRateCardVersions)
    .where(
      and(
        eq(partnerRateCardVersions.partnerAccountId, input.accountId),
        eq(partnerRateCardVersions.status, "active"),
        lte(partnerRateCardVersions.effectiveFrom, now),
      ),
    )
    .orderBy(desc(partnerRateCardVersions.version))
    .limit(1);
  if (version?.pricingModelVersion === 2) {
    if (version.effectiveTo && version.effectiveTo <= now) return null;
    const items = await db
      .select()
      .from(partnerRateCardVersionItems)
      .where(
        eq(partnerRateCardVersionItems.partnerRateCardVersionId, version.id),
      )
      .orderBy(
        asc(partnerRateCardVersionItems.serviceKey),
        asc(partnerRateCardVersionItems.tierKey),
      );
    const rates = items.flatMap((item) => {
      if (item.pricingRules["modelVersion"] === 2) {
        const parsed = PartnerServiceRateSchema.safeParse(
          item.pricingRules["rate"],
        );
        if (
          !parsed.success ||
          parsed.data.serviceKey !== item.serviceKey ||
          parsed.data.key !== item.tierKey
        )
          throw new Error("partner_rate_snapshot_invalid");
        return [parsed.data];
      }
      throw new Error("partner_rate_snapshot_mixed_models");
    });
    const quoteRequiredServiceKeys = PartnerQuoteRequiredServicesSchema.parse(
      version.quoteRequiredServiceKeys ?? [],
    );
    if (
      rates.some((rate) => quoteRequiredServiceKeys.includes(rate.serviceKey))
    )
      throw new Error("partner_rate_snapshot_conflicting_pricing");
    return {
      quoteRequiredServiceKeys,
      rateCardVersionId: version.id,
      version: version.version,
      currency: version.currency,
      effectiveFrom: version.effectiveFrom.toISOString(),
      effectiveTo: version.effectiveTo?.toISOString() ?? null,
      visitMinimum: version.visitMinimumAmount,
      portalVisible: version.portalVisible,
      source: "structured",
      rates,
      legacyItems: [],
      ...getPartnerRateCompleteness(rates, quoteRequiredServiceKeys),
    };
  }
  // Accounts without an effective version retain the existing flat card. Once a
  // structured version is effective, this projection can no longer override it.
  const [legacy] = await db
    .select()
    .from(partnerRateCards)
    .where(
      and(
        eq(partnerRateCards.partnerAccountId, input.accountId),
        lte(partnerRateCards.effectiveFrom, now),
      ),
    )
    .orderBy(desc(partnerRateCards.version))
    .limit(1);
  if (legacy && !legacy.active) return null;
  const fallback = legacy ?? version;
  if (!fallback || (fallback.effectiveTo && fallback.effectiveTo <= now))
    return null;
  const items = legacy
    ? await db
        .select()
        .from(partnerRateItems)
        .where(eq(partnerRateItems.rateCardId, legacy.id))
    : await db
        .select()
        .from(partnerRateCardVersionItems)
        .where(
          eq(partnerRateCardVersionItems.partnerRateCardVersionId, fallback.id),
        );
  const rates: PartnerServiceRate[] = [];
  return {
    rateCardVersionId: fallback.id,
    version: fallback.version,
    currency: fallback.currency,
    effectiveFrom: fallback.effectiveFrom.toISOString(),
    effectiveTo: fallback.effectiveTo?.toISOString() ?? null,
    visitMinimum: null,
    portalVisible: true,
    source: "legacy",
    rates,
    legacyItems: items.map(
      ({ id, serviceKey, tierKey, label, amountCents }) => ({
        id,
        serviceKey,
        tierKey,
        label,
        amountCents,
      }),
    ),
    ...getPartnerRateCompleteness(rates),
  };
}

export async function loadPartnerServiceRateSnapshot(
  db: RateReader,
  input: { accountId: string; serviceKey: string; now?: Date },
) {
  const card = await loadPartnerPublishedServiceRateCard(db, input);
  if (!card) return null;
  const rates = card.rates.filter(
    (rate) => rate.serviceKey === input.serviceKey,
  );
  return card.source === "structured"
    ? {
        ...card,
        rates,
        quoteRequiredServiceKeys:
          card.quoteRequiredServiceKeys?.filter(
            (key) => key === input.serviceKey,
          ) ?? [],
      }
    : null;
}

export async function readPartnerServiceRateEditor(
  db: RateReader,
  accountId: string,
) {
  const [account] = await db
    .select({
      id: partnerAccounts.id,
      name: partnerAccounts.name,
      revision: partnerAccounts.portalRateRevision,
      draft: partnerAccounts.portalRateDraft,
      portalVisible: partnerAccounts.portalRatesVisible,
      setupStatus: partnerAccounts.portalSetupStatus,
    })
    .from(partnerAccounts)
    .where(eq(partnerAccounts.id, accountId))
    .limit(1);
  if (!account)
    throw new TeamMutationFailure("invalid", "Choose an existing company.", {
      status: 404,
    });
  const published = await loadPartnerPublishedServiceRateCard(db, {
    accountId,
  });
  return {
    accountId,
    accountName: account.name,
    revision: String(account.revision),
    draft: account.draft,
    portalVisible: account.portalVisible,
    setupStatus: account.setupStatus,
    published,
  };
}

export async function savePartnerServiceRates(
  tx: TeamMutationTransaction,
  mutation: TeamMutationContext,
  accountId: string,
  input: z.infer<typeof PartnerServiceRateWriteSchema>,
) {
  if (
    !mutation.actor.id ||
    !(await loadPartnerStaffInvitationAuthority(tx, mutation.actor.id, [
      "partners.rates",
      "partners.accounts.manage",
    ]))
  )
    throw new TeamMutationFailure(
      "forbidden",
      "Your permission to change partner rates is no longer available.",
    );
  const [account] = await tx
    .select()
    .from(partnerAccounts)
    .where(eq(partnerAccounts.id, accountId))
    .for("update")
    .limit(1);
  if (!account)
    throw new TeamMutationFailure("invalid", "Choose an existing company.", {
      status: 404,
    });
  if (!mutation.expectedVersion || mutation.expectedVersion === "*")
    throw new TeamMutationFailure(
      "invalid",
      "Reload this company's rates before saving.",
    );
  assertTeamMutationExpectedVersion(mutation, account.portalRateRevision);
  let publishedVersionId: string | null = null;
  if (input.action === "publish") {
    const parsed = PartnerServiceRateCardInputSchema.safeParse({
      ...input.card,
      rates: input.card.rates.filter(
        (rate) =>
          rate.unitAmount.trim() &&
          !input.card.quoteRequiredServiceKeys?.includes(
            rate.serviceKey as PartnerServiceKeyV2,
          ),
      ),
    });
    if (!parsed.success)
      throw new TeamMutationFailure(
        "invalid",
        "Complete the rate amounts and measurement details before publishing.",
        {
          fieldErrors: Object.fromEntries(
            parsed.error.issues.map((issue) => [
              "card." + issue.path.join("."),
              issue.message,
            ]),
          ),
        },
      );
    const [previous] = await tx
      .select({
        id: partnerRateCardVersions.id,
        version: partnerRateCardVersions.version,
      })
      .from(partnerRateCardVersions)
      .where(eq(partnerRateCardVersions.partnerAccountId, accountId))
      .orderBy(desc(partnerRateCardVersions.version))
      .limit(1);
    const [version] = await tx
      .insert(partnerRateCardVersions)
      .values({
        partnerAccountId: accountId,
        version: (previous?.version ?? 0) + 1,
        currency: parsed.data.currency,
        status: "active",
        pricingModelVersion: 2,
        effectiveFrom: new Date(parsed.data.effectiveFrom),
        effectiveTo: parsed.data.effectiveTo
          ? new Date(parsed.data.effectiveTo)
          : null,
        supersedesId: previous?.id ?? null,
        createdByTeamMemberId: mutation.actor.id,
        visitMinimumAmount: parsed.data.visitMinimum,
        quoteRequiredServiceKeys: parsed.data.quoteRequiredServiceKeys ?? [],
        portalVisible: input.portalVisible,
      })
      .returning({ id: partnerRateCardVersions.id });
    if (!version) throw new Error("partner_rate_publication_missing");
    publishedVersionId = version.id;
    if (parsed.data.rates.length)
      await tx.insert(partnerRateCardVersionItems).values(
        parsed.data.rates.map((rate) => ({
          partnerRateCardVersionId: version.id,
          serviceKey: rate.serviceKey,
          tierKey: rate.key,
          label: rate.label,
          // Structured readers use the exact decimal in pricingRules exclusively.
          // The old cents column cannot represent fractional-cent area rates.
          amountCents: 0,
          pricingRules: { modelVersion: 2, rate },
        })),
      );
  }
  await tx
    .update(partnerAccounts)
    .set({
      portalRateDraft: input.card,
      portalRatesVisible: input.portalVisible,
      portalRateRevision: sql`${partnerAccounts.portalRateRevision} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(partnerAccounts.id, accountId));
  return {
    accountId,
    revision: String(account.portalRateRevision + 1),
    publishedVersionId,
    action: input.action,
  };
}
