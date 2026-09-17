export type BookingContactDetails = {
  name: string;
  phone: string;
  email: string;
};

export type PartnerContactAccessValues = {
  contactName: string;
  contactPhone: string;
  contactEmail: string;
  alternateContactName: string;
  alternateContactPhone: string;
  alternateContactEmail: string;
  accessDetails: string;
  crewInstructions: string;
};

export function normalizeBookingContact(
  contact?: Partial<BookingContactDetails> | null,
): BookingContactDetails {
  const text = (value: unknown): string =>
    typeof value === "string" ? value.trim() : "";
  return {
    name: text(contact?.name),
    phone: text(contact?.phone),
    email: text(contact?.email),
  };
}

/** Choose one person's details; missing fields never come from another person. */
export function chooseBookingContact(
  locationContact?: Partial<BookingContactDetails> | null,
  requesterContact?: Partial<BookingContactDetails> | null,
): BookingContactDetails {
  const location = normalizeBookingContact(locationContact);
  return location.name || location.phone || location.email
    ? location
    : normalizeBookingContact(requesterContact);
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export function bookingContactErrors(
  values: PartnerContactAccessValues,
): Record<string, string> {
  const errors: Record<string, string> = {};
  const primary = normalizeBookingContact({
    name: values.contactName,
    phone: values.contactPhone,
    email: values.contactEmail,
  });
  if (!primary.name)
    errors["onSiteContact"] = "Add the on-site contact’s name.";
  if (!primary.phone && !primary.email)
    errors["contactMethod"] =
      "Add a phone number or email for the on-site contact.";
  if (primary.email && !EMAIL_PATTERN.test(primary.email))
    errors["onSiteContact.email"] = "Enter a valid on-site contact email.";

  // Match the backup contact normalization and bounds used by draft PATCH.
  const backup = normalizeBookingContact({
    name: values.alternateContactName.normalize("NFKC"),
    phone: values.alternateContactPhone.normalize("NFKC"),
    email: values.alternateContactEmail.normalize("NFKC"),
  });
  if (!backup.name && !backup.phone && !backup.email) return errors;
  if (!backup.name)
    errors["scope.alternateContact.name"] = "Add the backup contact’s name.";
  if (!backup.phone && !backup.email)
    errors["scope.alternateContact.phone"] =
      "Add a phone number or email for the backup contact.";
  if (backup.email && !EMAIL_PATTERN.test(backup.email))
    errors["scope.alternateContact.email"] =
      "Enter a valid backup contact email.";

  for (const [key, maximum] of [
    ["name", 200],
    ["phone", 50],
    ["email", 320],
  ] as const) {
    const text = backup[key];
    const hasDisallowedControl = [...text].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (
        codePoint === 127 ||
        (codePoint < 32 && ![9, 10, 13].includes(codePoint))
      );
    });
    if (text.length > maximum || hasDisallowedControl)
      errors[`scope.alternateContact.${key}`] =
        `Use ${maximum} characters or fewer.`;
  }
  return errors;
}
