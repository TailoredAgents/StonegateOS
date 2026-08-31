import { eq, sql } from "drizzle-orm";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { z } from "zod";
import { contacts } from "@/db";
import {
  TeamMutationFailure,
  type TeamMutationTransaction,
} from "@/lib/team-mutation";

export type ActiveOutboundContact = {
  id: string;
  deletedAt: null;
  doNotContact: boolean;
  email: string | null;
  phone: string | null;
  phoneE164: string | null;
};

export type QuoteDeliveryChannels = {
  email: string | null;
  phone: string | null;
};

const DeliverableEmailSchema = z.string().trim().email();

function normalizeOutboundPhone(value: string): string | null {
  try {
    const parsed = parsePhoneNumberFromString(value, "US");
    if (parsed?.isValid() === true) return parsed.number;
  } catch {
    // Some constrained ESM/test runtimes cannot load the optional package
    // metadata. Fail over to a narrow syntax-only normalizer so a valid email
    // channel is never blocked by a malformed secondary phone field.
  }
  if (!/^\+?[0-9().\-\s]+$/u.test(value)) return null;
  const digits = value.replace(/\D/gu, "");
  if (value.startsWith("+") && /^\d{8,15}$/u.test(digits)) {
    return `+${digits}`;
  }
  if (/^\d{10}$/u.test(digits)) return `+1${digits}`;
  if (/^1\d{10}$/u.test(digits)) return `+${digits}`;
  return null;
}

/**
 * Return only provider-usable quote destinations. A malformed secondary
 * destination must not be queued merely because the contact has another
 * valid destination.
 */
export function resolveUsableQuoteDeliveryChannels(input: {
  email?: string | null;
  phone?: string | null;
  phoneE164?: string | null;
}): QuoteDeliveryChannels {
  const parsedEmail = DeliverableEmailSchema.safeParse(input.email ?? "");
  const phone = [input.phoneE164, input.phone]
    .map((candidate) => candidate?.trim() ?? "")
    .filter(Boolean)
    .map(normalizeOutboundPhone)
    .find((candidate): candidate is string => candidate !== null);

  return {
    email: parsedEmail.success ? parsedEmail.data.toLowerCase() : null,
    phone: phone ?? null,
  };
}

/**
 * Serialize direct outbound acceptance with contact deletion, then reread the
 * authoritative lifecycle state. Call this inside the same transaction that
 * creates or reactivates the message/outbox row.
 */
export async function requireActiveContactForDirectOutbound(
  tx: TeamMutationTransaction,
  contactId: string,
): Promise<ActiveOutboundContact> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${contactId}, 0))`,
  );
  const [contact] = await tx
    .select({
      id: contacts.id,
      deletedAt: contacts.deletedAt,
      doNotContact: contacts.doNotContact,
      email: contacts.email,
      phone: contacts.phone,
      phoneE164: contacts.phoneE164,
    })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .for("update")
    .limit(1);

  if (!contact?.id) {
    throw new TeamMutationFailure(
      "conflict",
      "This contact no longer exists. Refresh before sending a message.",
    );
  }
  if (contact.deletedAt) {
    throw new TeamMutationFailure(
      "conflict",
      "This contact is in recovery. Restore it before sending a new message.",
    );
  }
  return {
    id: contact.id,
    deletedAt: null,
    doNotContact: contact.doNotContact,
    email: contact.email,
    phone: contact.phone,
    phoneE164: contact.phoneE164,
  };
}
