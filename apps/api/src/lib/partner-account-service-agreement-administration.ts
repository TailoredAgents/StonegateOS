import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  partnerAccountServiceAgreements,
  partnerAccounts,
  partnerDocuments,
  partnerServiceCatalog,
} from "@/db";
import {
  PartnerAccountServiceAgreementMutationSchema,
  partnerPricingStateRequiresRate,
  type PartnerAccountServiceAgreementMutation,
} from "@/lib/partner-account-service-agreement";
import {
  loadPartnerAgreementRateOptions,
  partnerAgreementDto,
  projectPartnerAccountServiceAgreement,
} from "@/lib/partner-account-service-agreement-service";
import {
  TeamMutationFailure,
  type TeamMutationTransaction,
} from "@/lib/team-mutation";

type AgreementRow = typeof partnerAccountServiceAgreements.$inferSelect;

function staffSnapshot(row: AgreementRow | null): Record<string, unknown> {
  if (!row) return { configured: false };
  return {
    configured: true,
    active: row.active,
    agreementLabel: row.agreementLabel,
    currency: row.currency,
    effectiveFrom: row.effectiveFrom.toISOString(),
    effectiveTo: row.effectiveTo?.toISOString() ?? null,
    inclusions: row.inclusions,
    exclusions: row.exclusions,
    quoteRules: row.quoteRules,
    agreementDocumentId: row.agreementDocumentId,
    serviceEntitlements: row.serviceEntitlements,
    revision: row.revision,
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function validateAgreementReferences(
  tx: TeamMutationTransaction,
  input: {
    partnerAccountId: string;
    values: PartnerAccountServiceAgreementMutation;
    now: Date;
  },
): Promise<void> {
  const serviceKeys = input.values.services.map((item) => item.serviceKey);
  const services = await tx
    .select({ key: partnerServiceCatalog.key })
    .from(partnerServiceCatalog)
    .where(
      and(
        inArray(partnerServiceCatalog.key, serviceKeys),
        eq(partnerServiceCatalog.active, true),
      ),
    );
  if (new Set(services.map((item) => item.key)).size !== serviceKeys.length) {
    throw new TeamMutationFailure(
      "invalid",
      "Every entitled service must be active in the canonical service catalog.",
      { fieldErrors: { services: "Remove unknown or inactive services." } },
    );
  }
  if (input.values.agreementDocumentId) {
    const [document] = await tx
      .select({ id: partnerDocuments.id })
      .from(partnerDocuments)
      .where(
        and(
          eq(partnerDocuments.partnerAccountId, input.partnerAccountId),
          eq(partnerDocuments.id, input.values.agreementDocumentId),
        ),
      )
      .limit(1);
    if (!document) {
      throw new TeamMutationFailure(
        "invalid",
        "The agreement document was not found for this account.",
        {
          status: 404,
          fieldErrors: { agreementDocumentId: "Choose an account document." },
        },
      );
    }
  }

  const effectiveNow =
    input.values.active &&
    new Date(input.values.effectiveFrom) <= input.now &&
    (!input.values.effectiveTo ||
      new Date(input.values.effectiveTo) > input.now);
  if (!effectiveNow) return;
  for (const entitlement of input.values.services) {
    if (!partnerPricingStateRequiresRate(entitlement.pricingState)) continue;
    const rates = await loadPartnerAgreementRateOptions(tx, {
      accountId: input.partnerAccountId,
      serviceKey: entitlement.serviceKey,
      agreementCurrency: input.values.currency,
      now: input.now,
    });
    if (rates.length === 0) {
      throw new TeamMutationFailure(
        "invalid",
        "A priced entitlement requires at least one current account rate in the same currency.",
        {
          fieldErrors: {
            services: `${entitlement.serviceKey} is missing a current ${input.values.currency} rate.`,
          },
        },
      );
    }
  }
}

export async function loadPartnerAccountServiceAgreementForStaff(
  tx: TeamMutationTransaction,
  input: { partnerAccountId: string; now?: Date },
) {
  const [account] = await tx
    .select({ id: partnerAccounts.id, name: partnerAccounts.name })
    .from(partnerAccounts)
    .where(eq(partnerAccounts.id, input.partnerAccountId))
    .limit(1);
  if (!account) return null;
  const [row, serviceRows] = await Promise.all([
    tx
      .select()
      .from(partnerAccountServiceAgreements)
      .where(
        eq(
          partnerAccountServiceAgreements.partnerAccountId,
          input.partnerAccountId,
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null),
    tx
      .select({
        key: partnerServiceCatalog.key,
        label: partnerServiceCatalog.label,
      })
      .from(partnerServiceCatalog)
      .where(eq(partnerServiceCatalog.active, true))
      .orderBy(asc(partnerServiceCatalog.label), asc(partnerServiceCatalog.key))
      .limit(101),
  ]);
  const servicesTruncated = serviceRows.length > 100;
  const serviceOptions = serviceRows.slice(0, 100);
  if (!row) {
    return {
      account,
      agreement: null,
      etag: '"0"',
      serviceOptions,
      servicesTruncated,
    };
  }
  const agreement = projectPartnerAccountServiceAgreement(row);
  const document = agreement.agreementDocumentId
    ? await tx
        .select({
          id: partnerDocuments.id,
          filename: partnerDocuments.filename,
        })
        .from(partnerDocuments)
        .where(
          and(
            eq(partnerDocuments.partnerAccountId, input.partnerAccountId),
            eq(partnerDocuments.id, agreement.agreementDocumentId),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null)
    : null;
  return {
    account,
    agreement: partnerAgreementDto(agreement, document),
    etag: `"${agreement.revision}"`,
    serviceOptions,
    servicesTruncated,
  };
}

export async function updatePartnerAccountServiceAgreementAsStaff(
  tx: TeamMutationTransaction,
  input: {
    partnerAccountId: string;
    values: PartnerAccountServiceAgreementMutation;
    expectedVersion: string;
    changedByTeamMemberId: string;
    now?: Date;
  },
): Promise<{
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  agreement: AgreementRow;
}> {
  const values = PartnerAccountServiceAgreementMutationSchema.parse(
    input.values,
  );
  const now = input.now ?? new Date();
  const [account] = await tx
    .select({ id: partnerAccounts.id })
    .from(partnerAccounts)
    .where(eq(partnerAccounts.id, input.partnerAccountId))
    .for("update")
    .limit(1);
  if (!account) {
    throw new TeamMutationFailure(
      "invalid",
      "The Partner account was not found.",
      {
        status: 404,
      },
    );
  }
  const [current] = await tx
    .select()
    .from(partnerAccountServiceAgreements)
    .where(
      eq(
        partnerAccountServiceAgreements.partnerAccountId,
        input.partnerAccountId,
      ),
    )
    .for("update")
    .limit(1);
  const expected = current ? String(current.revision) : "0";
  if (input.expectedVersion !== expected) {
    throw new TeamMutationFailure(
      "conflict",
      "The account agreement changed. Refresh before saving.",
      { status: 412, retryable: true },
    );
  }
  await validateAgreementReferences(tx, {
    partnerAccountId: input.partnerAccountId,
    values,
    now,
  });
  const rowValues = {
    active: values.active,
    agreementLabel: values.agreementLabel,
    currency: values.currency,
    effectiveFrom: new Date(values.effectiveFrom),
    effectiveTo: values.effectiveTo ? new Date(values.effectiveTo) : null,
    inclusions: values.inclusions,
    exclusions: values.exclusions,
    quoteRules: values.quoteRules,
    serviceEntitlements: values.services,
    agreementDocumentId: values.agreementDocumentId,
    updatedByTeamMemberId: input.changedByTeamMemberId,
    updatedAt: now,
  };
  let updated: AgreementRow | undefined;
  if (current) {
    [updated] = await tx
      .update(partnerAccountServiceAgreements)
      .set({
        ...rowValues,
        revision: sql`${partnerAccountServiceAgreements.revision} + 1`,
      })
      .where(
        and(
          eq(
            partnerAccountServiceAgreements.partnerAccountId,
            input.partnerAccountId,
          ),
          eq(partnerAccountServiceAgreements.revision, current.revision),
        ),
      )
      .returning();
  } else {
    [updated] = await tx
      .insert(partnerAccountServiceAgreements)
      .values({
        partnerAccountId: input.partnerAccountId,
        ...rowValues,
        revision: 1,
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning();
  }
  if (!updated) {
    throw new TeamMutationFailure(
      "conflict",
      "The account agreement changed while it was being saved. Refresh and retry.",
      { status: 409, retryable: true },
    );
  }
  return {
    before: staffSnapshot(current ?? null),
    after: staffSnapshot(updated),
    agreement: updated,
  };
}
