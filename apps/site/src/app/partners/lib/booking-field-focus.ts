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

const EQUIPMENT_FIELDS = [
  { id: "partner-book-heavy-items", section: "service" },
  { id: "partner-book-disassembly", section: "service" },
  { id: "partner-book-access-stairs", section: "contact" },
  { id: "partner-book-access-elevator", section: "contact" },
  { id: "partner-book-access-loading_dock", section: "contact" },
  { id: "partner-book-saved-option-lift_gate", section: "scope" },
  { id: "partner-book-saved-option-demolition", section: "scope" },
] as const;

/** Indices follow the complete, normalized equipment array, across all sections. */
function indexedEquipmentField(path: string) {
  const index = /^scope\.equipmentNeeds\.([0-6])$/u.exec(path)?.[1];
  if (index === undefined || typeof document === "undefined") return undefined;
  return EQUIPMENT_FIELDS.find(({ id, section }) => {
    const element = document.getElementById(id);
    return (
      element?.dataset["partnerEquipmentIndex"] === index &&
      element.dataset["partnerEquipmentSection"] === section
    );
  });
}

export function bookingErrorSection(field: string): BookingErrorSection {
  const path = fieldPath(field);
  if (
    path.startsWith("location") ||
    belongsTo(path, "scope.multiStop") ||
    belongsTo(path, "scope.multiStopDetails")
  )
    return "address";
  if (belongsTo(path, "scope.requiredCompletion")) return "scheduling";
  if (belongsTo(path, "selectedAddOns")) return "addons";
  if (belongsTo(path, "scope.alternateContact")) return "contact";
  if (belongsTo(path, "scope.equipmentNeeds"))
    return indexedEquipmentField(path)?.section ?? "contact";
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

export function bookingFieldStep(field: string): 0 | 1 | 2 {
  const section = bookingErrorSection(field);
  if (section === "address") return 0;
  if (section === "scheduling") return 2;
  return 1;
}

const SECTION_FALLBACK_IDS: Readonly<Record<BookingErrorSection, string>> = {
  service: "partner-book-description",
  scope: "partner-book-work-questions",
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
  if (belongsTo(path, "scope.hazardCategories"))
    return "partner-book-materials";
  if (belongsTo(path, "scope.equipmentNeeds"))
    return indexedEquipmentField(path)?.id ?? "partner-book-equipment";
  if (belongsTo(path, "scope.multiStopDetails"))
    return "partner-book-multi-stop-details";
  if (belongsTo(path, "scope.multiStop")) return "partner-book-multi-stop";
  if (belongsTo(path, "scope.requiredCompletion"))
    return belongsTo(path, "scope.requiredCompletion.localTime")
      ? "partner-book-required-time"
      : "partner-book-required-date";
  const exactIds: Readonly<Record<string, string>> = {
    description: "partner-book-description",
    "scope.nonStandard": "partner-book-non-standard",
    "scope.restrictedItems": "partner-book-restricted-items",
    "scope.itemCount": "partner-book-item-count",
    "scope.volumeCubicYards": "partner-book-volume",
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
  const path = fieldPath(field);
  const savedDetail = [
    "scope.nonStandard",
    "scope.restrictedItems",
    "scope.itemCount",
    "scope.volumeCubicYards",
  ].some((root) => belongsTo(path, root));
  const target =
    document.getElementById(bookingFieldElementId(field)) ??
    (savedDetail
      ? document.getElementById("partner-book-saved-details")
      : null) ??
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
