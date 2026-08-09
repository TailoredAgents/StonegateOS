import { and, eq, isNotNull, isNull, or } from "drizzle-orm";
import { contacts } from "@/db";
import type { DatabaseClient } from "@/db";
import type { InferModel } from "drizzle-orm";
import { getDefaultSalesAssigneeMemberId } from "@/lib/sales-scorecard";
import {
  resolveOrCreateContactProperty,
  type PropertyRecord,
} from "@/lib/property-write";

type Database = DatabaseClient;
type TransactionExecutor = Parameters<Database["transaction"]>[0] extends (
  tx: infer Tx
) => Promise<unknown>
  ? Tx
  : never;

type DbExecutor = Database | TransactionExecutor;

export type ContactRecord = InferModel<typeof contacts, "select">;
export type { PropertyRecord } from "@/lib/property-write";

const CONTACT_SELECT = {
  id: contacts.id,
  firstName: contacts.firstName,
  lastName: contacts.lastName,
  company: contacts.company,
  email: contacts.email,
  phone: contacts.phone,
  phoneE164: contacts.phoneE164,
  salespersonMemberId: contacts.salespersonMemberId,
  partnerAccountId: contacts.partnerAccountId,
  partnerStatus: contacts.partnerStatus,
  partnerType: contacts.partnerType,
  partnerOwnerMemberId: contacts.partnerOwnerMemberId,
  partnerSince: contacts.partnerSince,
  partnerLastTouchAt: contacts.partnerLastTouchAt,
  partnerNextTouchAt: contacts.partnerNextTouchAt,
  partnerReferralCount: contacts.partnerReferralCount,
  partnerLastReferralAt: contacts.partnerLastReferralAt,
  doNotContact: contacts.doNotContact,
  doNotContactAt: contacts.doNotContactAt,
  doNotContactBy: contacts.doNotContactBy,
  doNotContactReason: contacts.doNotContactReason,
  preferredContactMethod: contacts.preferredContactMethod,
  source: contacts.source,
  deletedAt: contacts.deletedAt,
  deletedBy: contacts.deletedBy,
  purgeEligibleAt: contacts.purgeEligibleAt,
  mergedIntoContactId: contacts.mergedIntoContactId,
  mergeRecoveryLedgerId: contacts.mergeRecoveryLedgerId,
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

export class PublicContactPersistenceError extends Error {
  readonly code: "contact_deleted";
  readonly status = 409;
  readonly publicCode = "contact_unavailable" as const;
  readonly publicMessage =
    "We could not safely save this request online. Please contact the office for help.";

  constructor() {
    super("contact_deleted");
    this.name = "PublicContactPersistenceError";
    this.code = "contact_deleted";
  }
}

export async function upsertContact(
  db: DbExecutor,
  input: UpsertContactInput
): Promise<ContactRecord> {
  const email = input.email?.trim().toLowerCase();
  const deletedIdentityConditions = [
    eq(contacts.phoneE164, input.phoneE164),
    eq(contacts.phone, input.phoneRaw),
  ];
  if (email) {
    deletedIdentityConditions.push(eq(contacts.email, email));
  }
  const [deletedIdentity] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      and(
        isNotNull(contacts.deletedAt),
        or(...deletedIdentityConditions),
      ),
    )
    .limit(1);
  if (deletedIdentity?.id) {
    throw new PublicContactPersistenceError();
  }

  const defaultAssigneeMemberId = await getDefaultSalesAssigneeMemberId(db);
  let contact: ContactRecord | undefined;

  if (email) {
    const [existingByEmail] = await db
      .select(CONTACT_SELECT)
      .from(contacts)
      .where(and(eq(contacts.email, email), isNull(contacts.deletedAt)))
      .limit(1);
    contact = existingByEmail ?? undefined;
  }

  if (!contact) {
    const [existingByPhone] = await db
      .select(CONTACT_SELECT)
      .from(contacts)
      .where(
        and(
          or(
            eq(contacts.phoneE164, input.phoneE164),
            eq(contacts.phone, input.phoneRaw),
          ),
          isNull(contacts.deletedAt),
        ),
      )
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
      .where(and(eq(contacts.id, contact.id), isNull(contacts.deletedAt)))
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
      .where(and(eq(contacts.email, email), isNull(contacts.deletedAt)))
      .limit(1);
    if (existingByEmail) return existingByEmail;
  }

  const [existingByPhone] = await db
    .select(CONTACT_SELECT)
    .from(contacts)
    .where(
      and(
        or(
          eq(contacts.phoneE164, input.phoneE164),
          eq(contacts.phone, input.phoneRaw),
        ),
        isNull(contacts.deletedAt),
      ),
    )
    .limit(1);

  if (existingByPhone) return existingByPhone;

  // Re-check after the failed insert so a concurrent soft deletion cannot be
  // misreported as a generic persistence outage.
  const [deletedIdentityAfterConflict] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      and(
        isNotNull(contacts.deletedAt),
        or(...deletedIdentityConditions),
      ),
    )
    .limit(1);
  if (deletedIdentityAfterConflict?.id) {
    throw new PublicContactPersistenceError();
  }

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
  const { property } = await resolveOrCreateContactProperty(db, input);
  return property;
}
