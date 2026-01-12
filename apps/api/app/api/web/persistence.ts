import { eq, sql } from "drizzle-orm";
import { contacts, properties } from "@/db";
import type { DatabaseClient } from "@/db";
import type { InferModel } from "drizzle-orm";

type Database = DatabaseClient;
type TransactionExecutor = Parameters<Database["transaction"]>[0] extends (
  tx: infer Tx
) => Promise<unknown>
  ? Tx
  : never;

type DbExecutor = Database | TransactionExecutor;

export type ContactRecord = InferModel<typeof contacts, "select">;
export type PropertyRecord = InferModel<typeof properties, "select">;

const CONTACT_SELECT = {
  id: contacts.id,
  firstName: contacts.firstName,
  lastName: contacts.lastName,
  email: contacts.email,
  phone: contacts.phone,
  phoneE164: contacts.phoneE164,
  preferredContactMethod: contacts.preferredContactMethod,
  source: contacts.source,
  createdAt: contacts.createdAt,
  updatedAt: contacts.updatedAt
} as const;

type ContactRecordCompat = Omit<ContactRecord, "salespersonMemberId">;

function toContactRecord(row: ContactRecordCompat): ContactRecord {
  return { ...row, salespersonMemberId: null } as ContactRecord;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractPgCode(error: unknown): string | null {
  const direct = isRecord(error) ? error : null;
  const directCode = direct && typeof direct["code"] === "string" ? direct["code"] : null;
  if (directCode) return directCode;
  const cause = direct && isRecord(direct["cause"]) ? (direct["cause"] as Record<string, unknown>) : null;
  const causeCode = cause && typeof cause["code"] === "string" ? cause["code"] : null;
  return causeCode;
}

interface UpsertContactInput {
  firstName: string;
  lastName: string;
  phoneRaw: string;
  phoneE164: string;
  email?: string | null;
  source?: string;
}

export async function upsertContact(
  db: DbExecutor,
  input: UpsertContactInput
): Promise<ContactRecord> {
  const email = input.email?.trim().toLowerCase();
  let contact: ContactRecord | undefined;

  if (email) {
    const [existingByEmail] = await db
      .select(CONTACT_SELECT)
      .from(contacts)
      .where(eq(contacts.email, email))
      .limit(1);
    contact = existingByEmail ? toContactRecord(existingByEmail) : undefined;
  }

  if (!contact) {
    const [existingByPhone] = await db
      .select(CONTACT_SELECT)
      .from(contacts)
      .where(eq(contacts.phoneE164, input.phoneE164))
      .limit(1);
    contact = existingByPhone ? toContactRecord(existingByPhone) : undefined;
  }

  if (contact) {
    const updatePayload: Partial<ContactRecord> = {
      firstName: input.firstName,
      lastName: input.lastName,
      phone: input.phoneRaw,
      phoneE164: input.phoneE164,
      updatedAt: new Date()
    };

    if (email && !contact.email) {
      updatePayload.email = email;
    }

    const [updated] = await db
      .update(contacts)
      .set(updatePayload)
      .where(eq(contacts.id, contact.id))
      .returning(CONTACT_SELECT);

    if (!updated) {
      return contact;
    }

    return toContactRecord(updated);
  }

  let inserted: ContactRecordCompat | undefined;
  const exec =
    typeof (db as unknown as { execute?: unknown }).execute === "function"
      ? (db as unknown as { execute: (query: unknown) => Promise<unknown> }).execute.bind(db)
      : null;
  const canSavepoint = Boolean(exec);
  try {
    if (canSavepoint) {
      await exec!(sql`savepoint upsert_contact_insert`);
    }
    const [row] = await db
      .insert(contacts)
      .values({
        firstName: input.firstName,
        lastName: input.lastName,
        phone: input.phoneRaw,
        phoneE164: input.phoneE164,
        email,
        source: input.source ?? "web"
      })
      .returning(CONTACT_SELECT);
    inserted = row;
    if (canSavepoint) {
      await exec!(sql`release savepoint upsert_contact_insert`);
    }
  } catch (error) {
    if (canSavepoint) {
      try {
        await exec!(sql`rollback to savepoint upsert_contact_insert`);
        await exec!(sql`release savepoint upsert_contact_insert`);
      } catch {
        // If the connection doesn't support savepoints here, the original error will be thrown below.
      }
    }

    const code = extractPgCode(error);
    if (code !== "42703") {
      throw error;
    }

    const rows = await (db as any).execute(
      sql`
        insert into "contacts" ("first_name", "last_name", "phone", "phone_e164", "email", "source")
        values (${input.firstName}, ${input.lastName}, ${input.phoneRaw}, ${input.phoneE164}, ${email ?? null}, ${input.source ?? "web"})
        returning "id"
      `
    );
    const insertedId = Array.isArray(rows) ? (rows[0] as any)?.id : null;
    if (typeof insertedId !== "string" || !insertedId) {
      throw new Error("contact_insert_failed");
    }

    const [selected] = await db.select(CONTACT_SELECT).from(contacts).where(eq(contacts.id, insertedId)).limit(1);
    inserted = selected ?? undefined;
  }

  if (!inserted) {
    throw new Error("contact_insert_failed");
  }

  return toContactRecord(inserted);
}

interface UpsertPropertyInput {
  contactId: string;
  addressLine1: string;
  city: string;
  state: string;
  postalCode: string;
  gated?: boolean;
}

export async function upsertProperty(
  db: DbExecutor,
  input: UpsertPropertyInput
): Promise<PropertyRecord> {
  const trimmedAddress = input.addressLine1.trim();
  const trimmedCity = input.city.trim();
  const normalizedState = input.state.trim().toUpperCase();
  const trimmedPostalCode = input.postalCode.trim();
  const gated = input.gated ?? false;

  const [inserted] = await db
    .insert(properties)
    .values({
      contactId: input.contactId,
      addressLine1: trimmedAddress,
      city: trimmedCity,
      state: normalizedState,
      postalCode: trimmedPostalCode,
      gated
    })
    .onConflictDoUpdate({
      target: [properties.addressLine1, properties.postalCode, properties.state],
      set: {
        contactId: input.contactId,
        city: trimmedCity,
        gated,
        updatedAt: new Date()
      }
    })
    .returning();

  return inserted as PropertyRecord;
}
