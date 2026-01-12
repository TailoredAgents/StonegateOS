import { eq } from "drizzle-orm";
import { contacts, properties } from "@/db";
import type { DatabaseClient } from "@/db";
import type { InferModel } from "drizzle-orm";
import { getDefaultSalesAssigneeMemberId } from "@/lib/sales-scorecard";

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
  salespersonMemberId: contacts.salespersonMemberId,
  preferredContactMethod: contacts.preferredContactMethod,
  source: contacts.source,
  createdAt: contacts.createdAt,
  updatedAt: contacts.updatedAt
} as const;

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
  const defaultAssigneeMemberId = await getDefaultSalesAssigneeMemberId(db as any);
  let contact: ContactRecord | undefined;

  if (email) {
    const [existingByEmail] = await db
      .select(CONTACT_SELECT)
      .from(contacts)
      .where(eq(contacts.email, email))
      .limit(1);
    contact = existingByEmail ?? undefined;
  }

  if (!contact) {
    const [existingByPhone] = await db
      .select(CONTACT_SELECT)
      .from(contacts)
      .where(eq(contacts.phoneE164, input.phoneE164))
      .limit(1);
    contact = existingByPhone ?? undefined;
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
    if (!contact.salespersonMemberId) {
      updatePayload.salespersonMemberId = defaultAssigneeMemberId;
    }

    const [updated] = await db
      .update(contacts)
      .set(updatePayload)
      .where(eq(contacts.id, contact.id))
      .returning(CONTACT_SELECT);

    if (!updated) {
      return contact;
    }

    return updated;
  }

  const [inserted] = await db
    .insert(contacts)
    .values({
      firstName: input.firstName,
      lastName: input.lastName,
      phone: input.phoneRaw,
      phoneE164: input.phoneE164,
      email: email ?? null,
      salespersonMemberId: defaultAssigneeMemberId,
      source: input.source ?? "web"
    })
    .onConflictDoNothing()
    .returning(CONTACT_SELECT);

  if (inserted) {
    return inserted;
  }

  if (email) {
    const [existingByEmail] = await db
      .select(CONTACT_SELECT)
      .from(contacts)
      .where(eq(contacts.email, email))
      .limit(1);
    if (existingByEmail) return existingByEmail;
  }

  const [existingByPhone] = await db
    .select(CONTACT_SELECT)
    .from(contacts)
    .where(eq(contacts.phoneE164, input.phoneE164))
    .limit(1);

  if (existingByPhone) return existingByPhone;

  throw new Error("contact_insert_failed");
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
