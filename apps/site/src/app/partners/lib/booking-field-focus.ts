export type BookingErrorSection =
  | "service"
  | "scope"
  | "commercial"
  | "contact"
  | "proof"
  | "addons"
  | "address"
  | "scheduling";

function fieldPath(field: string): string {
  return field.trim().replace(/\[(\d+)\]/gu, ".$1");
}

function belongsTo(field: string, root: string): boolean {
  return field === root || field.startsWith(`${root}.`);
}

export function bookingErrorSection(field: string): BookingErrorSection {
  const path = fieldPath(field);
  if (path.startsWith("location")) return "address";
  if (belongsTo(path, "selectedAddOns")) return "addons";
  if (belongsTo(path, "scope.alternateContact")) return "contact";
  if (belongsTo(path, "scope")) return "scope";
  if (belongsTo(path, "commercial") || path.startsWith("billingContact"))
    return "commercial";
  if (
    path.startsWith("onSiteContact") ||
    path === "contactMethod" ||
    path === "accessDetails" ||
    path === "crewInstructions"
  )
    return "contact";
  if (path.startsWith("proof")) return "proof";
  if (path.startsWith("preferred")) return "scheduling";
  return "service";
}

const SECTION_FALLBACK_IDS: Readonly<Record<BookingErrorSection, string>> = {
  service: "partner-book-description",
  scope: "partner-book-scope",
  commercial: "partner-book-billing-name",
  contact: "partner-book-contact-name",
  proof: "partner-book-proof",
  addons: "partner-book-add-ons",
  address: "partner-book-location",
  scheduling: "partner-book-preferred-date-1",
};

/** Fixed form IDs only: server field paths never become selectors or DOM IDs. */
export function bookingFieldElementId(field: string): string {
  const path = fieldPath(field);
  if (path.startsWith("location")) return "partner-book-location";
  if (path.startsWith("service")) return "partner-book-service";
  if (path.startsWith("tier")) return "partner-book-base-option";
  if (belongsTo(path, "selectedAddOns")) return "partner-book-add-ons";
  if (belongsTo(path, "scope.alternateContact")) {
    if (path === "scope.alternateContact.phone")
      return "partner-book-alternate-phone";
    if (path === "scope.alternateContact.email")
      return "partner-book-alternate-email";
    return "partner-book-alternate-name";
  }
  if (
    belongsTo(path, "commercial.billingContact") ||
    path.startsWith("billingContact")
  ) {
    return path.endsWith(".email") || path === "billingContactEmail"
      ? "partner-book-billing-email"
      : "partner-book-billing-name";
  }
  const exactIds: Readonly<Record<string, string>> = {
    description: "partner-book-description",
    "scope.itemCount": "partner-book-item-count",
    "scope.volumeCubicYards": "partner-book-volume",
    "scope.requiredCompletion": "partner-book-required-date",
    "scope.requiredCompletion.localDate": "partner-book-required-date",
    "scope.requiredCompletion.localTime": "partner-book-required-time",
    "scope.multiStopDetails": "partner-book-multi-stop-details",
    "commercial.poNumber": "partner-book-po",
    "commercial.costCenter": "partner-book-cost-center",
    "commercial.projectReference": "partner-book-project",
    "onSiteContact.name": "partner-book-contact-name",
    "onSiteContact.phone": "partner-book-contact-phone",
    "onSiteContact.email": "partner-book-contact-email",
    contactMethod: "partner-book-contact-phone",
    accessDetails: "partner-book-access",
    crewInstructions: "partner-book-crew-instructions",
    preferredDateOne: "partner-book-preferred-date-1",
    preferredDateTwo: "partner-book-preferred-date-2",
    preferredDateThree: "partner-book-preferred-date-3",
    preferredTimeOfDay: "partner-book-preferred-time",
  };
  if (Object.hasOwn(exactIds, path)) return exactIds[path]!;
  if (belongsTo(path, "preferredWindows")) {
    if (path.endsWith(".timeOfDay")) return "partner-book-preferred-time";
    const index = /^preferredWindows\.([012])(?:\.|$)/u.exec(path)?.[1];
    if (index) return `partner-book-preferred-date-${Number(index) + 1}`;
  }
  return SECTION_FALLBACK_IDS[bookingErrorSection(path)];
}

/** Call after the owning wizard step is rendered. Never closes a disclosure. */
export function focusBookingField(field: string): boolean {
  if (typeof document === "undefined") return false;
  const target =
    document.getElementById(bookingFieldElementId(field)) ??
    document.getElementById(SECTION_FALLBACK_IDS[bookingErrorSection(field)]);
  if (!target) return false;
  for (
    let ancestor: HTMLElement | null = target;
    ancestor;
    ancestor = ancestor.parentElement
  ) {
    if (ancestor.tagName === "DETAILS")
      (ancestor as HTMLDetailsElement).open = true;
  }
  target.focus();
  return true;
}
