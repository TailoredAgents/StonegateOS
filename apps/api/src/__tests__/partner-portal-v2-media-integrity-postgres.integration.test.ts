import { randomUUID } from "node:crypto";
import {
  closeDbForTests,
  getDb,
  mediaAssets,
  partnerAccountMemberships,
  partnerAccounts,
  partnerBookingDrafts,
  partnerDraftMedia,
  partnerMediaMutationOperations,
  partnerUsers,
} from "@/db";

const describeWithDatabase = process.env["DATABASE_URL"]
  ? describe
  : describe.skip;

type DatabaseError = Readonly<{
  code?: unknown;
  constraint_name?: unknown;
}>;

function deepestDatabaseError(error: unknown): DatabaseError {
  let current: unknown = error;
  const visited = new Set<unknown>();
  while (
    typeof current === "object" &&
    current !== null &&
    !visited.has(current)
  ) {
    visited.add(current);
    const record = current as Record<string, unknown>;
    if (!record["cause"]) return record;
    current = record["cause"];
  }
  return {};
}

async function captureDatabaseError(
  operation: () => Promise<unknown>,
): Promise<DatabaseError> {
  try {
    await operation();
  } catch (error) {
    return deepestDatabaseError(error);
  }
  throw new Error("expected_database_rejection");
}

async function insertAccountIdentity(
  tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
  label: string,
) {
  const suffix = randomUUID().replaceAll("-", "");
  const accountId = randomUUID();
  const userId = randomUUID();
  const membershipId = randomUUID();
  const email = `${label.toLowerCase().replaceAll(" ", "-")}-${suffix}@example.test`;
  await tx.insert(partnerAccounts).values({
    id: accountId,
    name: `${label} ${suffix.slice(0, 8)}`,
    normalizedName: `${label.toLowerCase()} ${suffix.slice(0, 8)}`,
  });
  await tx.insert(partnerUsers).values({
    id: userId,
    email,
    normalizedEmail: email,
    name: label,
  });
  await tx.insert(partnerAccountMemberships).values({
    id: membershipId,
    partnerAccountId: accountId,
    partnerUserId: userId,
    roleKey: "operations",
    status: "active",
    acceptedAt: new Date(),
  });
  return { accountId, membershipId };
}

describeWithDatabase("partner media PostgreSQL tenant integrity", () => {
  afterAll(async () => {
    await closeDbForTests();
  });

  it("rejects an asset associated to a draft from another account", async () => {
    const error = await captureDatabaseError(() =>
      getDb().transaction(async (tx) => {
        const owner = await insertAccountIdentity(tx, "Media owner");
        const other = await insertAccountIdentity(tx, "Other tenant");
        const draftId = randomUUID();
        const assetId = randomUUID();
        await tx.insert(partnerBookingDrafts).values({
          id: draftId,
          partnerAccountId: owner.accountId,
          createdByMembershipId: owner.membershipId,
        });
        await tx.insert(mediaAssets).values({
          id: assetId,
          partnerAccountId: other.accountId,
          storageBucket: "partner-media-test",
          originalObjectKey: `tenant-integrity/${assetId}`,
        });
        await tx.insert(partnerDraftMedia).values({
          partnerAccountId: owner.accountId,
          bookingDraftId: draftId,
          mediaAssetId: assetId,
          uploadedByMembershipId: owner.membershipId,
        });
      }),
    );

    expect(error.code).toBe("23503");
    expect(error.constraint_name).toBe("partner_draft_media_asset_account_fk");
  });

  it("rejects reuse of one finalization key for another request", async () => {
    const error = await captureDatabaseError(() =>
      getDb().transaction(async (tx) => {
        const owner = await insertAccountIdentity(tx, "Media operation");
        const idempotencyKeyHash = "a".repeat(64);
        const common = {
          partnerAccountId: owner.accountId,
          actorMembershipId: owner.membershipId,
          action: "finalize",
          idempotencyKeyHash,
          parentKind: "draft",
          status: "in_progress",
          claimExpiresAt: new Date(Date.now() + 60_000),
        } as const;
        await tx.insert(partnerMediaMutationOperations).values({
          ...common,
          requestHash: "b".repeat(64),
          parentId: randomUUID(),
          associationId: randomUUID(),
          claimToken: randomUUID(),
        });
        await tx.insert(partnerMediaMutationOperations).values({
          ...common,
          requestHash: "c".repeat(64),
          parentId: randomUUID(),
          associationId: randomUUID(),
          claimToken: randomUUID(),
        });
      }),
    );

    expect(error.code).toBe("23505");
    expect(error.constraint_name).toBe(
      "partner_media_mutation_operations_actor_action_key",
    );
  });
});
