import { createHash, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  closeDbForTests,
  contacts,
  getDb,
  teamCallOperations,
  teamCallOperationTaskIntents,
} from "@/db";

const describeWithDatabase = process.env["DATABASE_URL"]
  ? describe
  : describe.skip;
const DAY_MS = 24 * 60 * 60 * 1_000;

type DatabaseError = Readonly<{
  code?: unknown;
  constraint_name?: unknown;
  message?: unknown;
}>;

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

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

function eligibleContact(id: string) {
  const deletedAt = new Date(Date.now() - 31 * DAY_MS);
  return {
    id,
    firstName: "Purge",
    lastName: "Regression",
    source: "contact_purge_postgres_regression",
    deletedAt,
    purgeEligibleAt: new Date(deletedAt.getTime() + 30 * DAY_MS),
  } as const;
}

describeWithDatabase("contact purge PostgreSQL trigger repair", () => {
  afterAll(async () => {
    await closeDbForTests();
  });

  it("allows the authorized dependency-free purge path", async () => {
    const contactId = randomUUID();
    const db = getDb();

    await db.transaction(async (tx) => {
      await tx.insert(contacts).values(eligibleContact(contactId));
      await tx.execute(
        sql`select public.contact_purge_lock_dependency_tables()`,
      );
      await tx.execute(
        sql`select set_config('app.contact_purge_authorized_id', ${contactId}, true)`,
      );
      const deleted = await tx
        .delete(contacts)
        .where(eq(contacts.id, contactId))
        .returning({ id: contacts.id });
      expect(deleted).toEqual([{ id: contactId }]);
    });

    const remaining = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.id, contactId));
    expect(remaining).toEqual([]);
  });

  it("still rejects a hard delete that lacks the exact transaction opt-in", async () => {
    const contactId = randomUUID();
    const db = getDb();
    const error = await captureDatabaseError(() =>
      db.transaction(async (tx) => {
        await tx.insert(contacts).values(eligibleContact(contactId));
        await tx.delete(contacts).where(eq(contacts.id, contactId));
      }),
    );

    expect(error.code).toBe("42501");
    expect(error.message).toContain(
      "contacts may only be hard-deleted by the authorized purge maintenance process",
    );
  });

  it("still rejects an authorized purge before the recovery window elapses", async () => {
    const contactId = randomUUID();
    const db = getDb();
    const deletedAt = new Date(Date.now() - DAY_MS);
    const error = await captureDatabaseError(() =>
      db.transaction(async (tx) => {
        await tx.insert(contacts).values({
          id: contactId,
          firstName: "Recovery",
          lastName: "Protected",
          source: "contact_purge_postgres_regression",
          deletedAt,
          purgeEligibleAt: new Date(deletedAt.getTime() + 30 * DAY_MS),
        });
        await tx.execute(
          sql`select public.contact_purge_lock_dependency_tables()`,
        );
        await tx.execute(
          sql`select set_config('app.contact_purge_authorized_id', ${contactId}, true)`,
        );
        await tx.delete(contacts).where(eq(contacts.id, contactId));
      }),
    );

    expect(error.code).toBe("23514");
    expect(error.constraint_name).toBe("contact_purge_recovery_window_guard");
  });

  it("uses call_operation_id to keep an active task-intent snapshot blocking", async () => {
    const contactId = randomUUID();
    const operationId = randomUUID();
    const db = getDb();
    const error = await captureDatabaseError(() =>
      db.transaction(async (tx) => {
        await tx.insert(contacts).values(eligibleContact(contactId));
        await tx.insert(teamCallOperations).values({
          id: operationId,
          mutationClaimId: randomUUID(),
          // Deliberately differs from the purge target so only the task-intent
          // relationship can activate this guard branch.
          contactId: randomUUID(),
          agentMemberId: randomUUID(),
          actorMemberId: randomUUID(),
          sessionId: randomUUID(),
          authMethod: "team_session",
          correlationId: `contact-purge-regression-${randomUUID()}`,
          idempotencyKeyHash: digest(`idempotency:${randomUUID()}`),
          requestHash: digest(`request:${randomUUID()}`),
          providerRequestKey: randomUUID(),
        });
        await tx.insert(teamCallOperationTaskIntents).values({
          callOperationId: operationId,
          taskId: randomUUID(),
          kind: "explicit",
          expectedContactId: contactId,
          expectedAssignedTo: "contact-purge-regression",
          expectedUpdatedAt: new Date(),
        });
        await tx.execute(
          sql`select public.contact_purge_lock_dependency_tables()`,
        );
        await tx.execute(
          sql`select set_config('app.contact_purge_authorized_id', ${contactId}, true)`,
        );
        await tx.delete(contacts).where(eq(contacts.id, contactId));
      }),
    );

    expect(error.code).toBe("23503");
    expect(error.constraint_name).toBe("contact_purge_active_operation_guard");
    expect(error.message).toContain(
      "contact purge is blocked by unresolved external or queued work",
    );
  });
});
