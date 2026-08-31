import { and, eq, sql } from "drizzle-orm";
import { contacts, quoteVersions, quotes } from "@/db";
import {
  TeamMutationFailure,
  type TeamMutationTransaction,
} from "@/lib/team-mutation";

type QuoteV2ContactLocator = { quoteId: string } | { versionId: string };

export type ActiveQuoteV2Contact = {
  quoteId: string;
  contactId: string;
  deletedAt: null;
};

async function resolveQuoteContact(
  tx: TeamMutationTransaction,
  locator: QuoteV2ContactLocator,
): Promise<{ quoteId: string; contactId: string } | null> {
  if ("quoteId" in locator) {
    const [row] = await tx
      .select({ quoteId: quotes.id, contactId: quotes.contactId })
      .from(quotes)
      .where(
        and(eq(quotes.id, locator.quoteId), eq(quotes.engineVersion, "v2")),
      )
      .limit(1);
    return row ?? null;
  }

  const [row] = await tx
    .select({ quoteId: quotes.id, contactId: quotes.contactId })
    .from(quoteVersions)
    .innerJoin(quotes, eq(quotes.id, quoteVersions.quoteId))
    .where(
      and(
        eq(quoteVersions.id, locator.versionId),
        eq(quotes.engineVersion, "v2"),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Serialize every Quote V2 capability mint with contact deletion. The first
 * read intentionally takes no row lock: taking the shared per-contact
 * advisory lock first preserves the contact -> quote lock order used by the
 * deletion transaction and prevents a delete-versus-issue deadlock.
 */
export async function requireActiveQuoteV2ContactForCapabilityMint(
  tx: TeamMutationTransaction,
  locator: QuoteV2ContactLocator,
): Promise<ActiveQuoteV2Contact> {
  const candidate = await resolveQuoteContact(tx, locator);
  if (!candidate) {
    throw new TeamMutationFailure(
      "conflict",
      "This proposal is no longer available. Refresh before continuing.",
    );
  }

  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${candidate.contactId}, 0))`,
  );

  const [locked] = await tx
    .select({
      quoteId: quotes.id,
      contactId: quotes.contactId,
      deletedAt: contacts.deletedAt,
    })
    .from(quotes)
    .innerJoin(contacts, eq(contacts.id, quotes.contactId))
    .where(
      and(eq(quotes.id, candidate.quoteId), eq(quotes.engineVersion, "v2")),
    )
    .for("update")
    .limit(1);

  if (!locked || locked.contactId !== candidate.contactId) {
    throw new TeamMutationFailure(
      "conflict",
      "The proposal contact changed before access could be created. Refresh and retry.",
      { retryable: true },
    );
  }
  if (locked.deletedAt) {
    throw new TeamMutationFailure(
      "conflict",
      "This contact is in recovery. Restore it before creating a customer proposal link.",
    );
  }

  return {
    quoteId: locked.quoteId,
    contactId: locked.contactId,
    deletedAt: null,
  };
}
