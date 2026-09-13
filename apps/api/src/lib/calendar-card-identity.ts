import type { AppointmentBookingDetails } from "@/db/schema";

export type CalendarPartnerAffiliation = {
  accountId: string | null;
  bookingId: string | null;
  displayName: string | null;
  basis: "partner_booking" | "appointment_account" | "contact_partner";
};

export type CalendarCardIdentityRow = {
  appointmentId: string;
  bookingId?: string | null;
  bookingAccountId?: string | null;
  appointmentAccountId?: string | null;
  contactAccountId?: string | null;
  contactPartnerStatus?: string | null;
  accountName?: string | null;
  legacyPartnerCompany?: string | null;
  legacyPartnerFirstName?: string | null;
  legacyPartnerLastName?: string | null;
  contactCompany?: string | null;
  contactFirstName?: string | null;
  contactLastName?: string | null;
  partnerServiceKey?: string | null;
  partnerServiceLabel?: string | null;
};

const SERVICE_LABELS = new Map<string, string>([
  ["junk_removal", "Junk Removal"],
  ["demolition", "Demo"],
  ["moving", "Moving"],
  ["land_clearing", "Land Clearing"],
  ["rental_dumpster", "Dumpster Rental"],
]);

// Only exact canonical spellings are aliases. Keys such as demo-hauloff,
// moving_labor or standard_pickup retain the linked catalog's service label.
const PARTNER_SERVICE_LABELS = new Map([
  ...SERVICE_LABELS,
  ["junk-removal", "Junk Removal"],
  ["land-clearing", "Land Clearing"],
  ["rental-dumpster", "Dumpster Rental"],
]);

function text(value: string | null | undefined): string | null {
  return typeof value === "string" ? value.trim() || null : null;
}

function displayText(value: string | null | undefined): string | null {
  return text(value)?.replace(/\s+/gu, " ").slice(0, 200) ?? null;
}

export function hasCalendarPartnerAccountConflict(
  row: CalendarCardIdentityRow,
): boolean {
  const bookingAccountId = text(row.bookingAccountId);
  const appointmentAccountId = text(row.appointmentAccountId);
  return Boolean(
    text(row.bookingId) &&
      bookingAccountId &&
      appointmentAccountId &&
      bookingAccountId !== appointmentAccountId,
  );
}

function partnerAffiliation(
  row: CalendarCardIdentityRow | null | undefined,
): CalendarPartnerAffiliation | null {
  if (!row) return null;
  const bookingId = text(row.bookingId);
  const appointmentAccountId = text(row.appointmentAccountId);
  if (bookingId) {
    const conflict = hasCalendarPartnerAccountConflict(row);
    const accountId = conflict
      ? null
      : (text(row.bookingAccountId) ?? appointmentAccountId);
    return {
      accountId,
      bookingId,
      displayName: conflict
        ? null
        : accountId
          ? displayText(row.accountName)
          : (displayText(row.legacyPartnerCompany) ??
            displayText(
              [row.legacyPartnerFirstName, row.legacyPartnerLastName]
                .filter(Boolean)
                .join(" "),
            )),
      basis: "partner_booking",
    };
  }
  if (appointmentAccountId) {
    return {
      accountId: appointmentAccountId,
      bookingId: null,
      displayName: displayText(row.accountName),
      basis: "appointment_account",
    };
  }
  if (row.contactPartnerStatus === "partner") {
    return {
      accountId: text(row.contactAccountId),
      bookingId: null,
      displayName:
        (text(row.contactAccountId) ? displayText(row.accountName) : null) ??
        displayText(row.contactCompany) ??
        displayText(
          [row.contactFirstName, row.contactLastName].filter(Boolean).join(" "),
        ),
      basis: "contact_partner",
    };
  }
  return null;
}

/** Informational projection only; never use this to authorize job actions. */
export function resolveCalendarCardIdentity(input: {
  bookingDetails: AppointmentBookingDetails | null;
  enrichment?: CalendarCardIdentityRow | null;
}): {
  serviceCategoryLabel: string | null;
  partnerAffiliation: CalendarPartnerAffiliation | null;
} {
  const savedLabel = input.bookingDetails
    ? (SERVICE_LABELS.get(input.bookingDetails.serviceType) ?? null)
    : null;
  const partner = input.enrichment;
  const partnerKey = text(partner?.partnerServiceKey);
  const partnerLabel = text(partner?.bookingId)
    ? ((partnerKey ? PARTNER_SERVICE_LABELS.get(partnerKey) : null) ??
      displayText(partner?.partnerServiceLabel))
    : null;
  return {
    serviceCategoryLabel: savedLabel ?? partnerLabel ?? null,
    partnerAffiliation: partnerAffiliation(partner),
  };
}

/**
 * Optional presentation data has one batch and a fixed response-time budget.
 * A late or rejected read is observed but cannot reject the calendar response.
 */
export async function loadCalendarCardIdentityRows(
  appointmentIds: readonly string[],
  readRows: () => PromiseLike<CalendarCardIdentityRow[]>,
  report: (event: "unavailable" | "account_conflict") => void,
): Promise<Map<string, CalendarCardIdentityRow>> {
  const allowedIds = new Set(appointmentIds);
  if (!allowedIds.size) return new Map();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const rows = await Promise.race([
      Promise.resolve().then(readRows),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 1_000);
      }),
    ]);
    if (rows === null) {
      report("unavailable");
      return new Map();
    }
    const result = new Map<string, CalendarCardIdentityRow>();
    for (const row of rows) {
      if (allowedIds.has(row.appointmentId) && !result.has(row.appointmentId)) {
        result.set(row.appointmentId, row);
      }
    }
    if ([...result.values()].some(hasCalendarPartnerAccountConflict)) {
      report("account_conflict");
    }
    return result;
  } catch {
    report("unavailable");
    return new Map();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
