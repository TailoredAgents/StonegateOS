type LeadIntakeOptions = {
  services?: string[];
  name?: string;
  phone?: string;
  email?: string;
  addressLine1?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  appointmentType?: "in_person_estimate" | "web_lead";
  preferredDate?: string;
  scheduling?: Record<string, unknown>;
  utm?: Record<string, string | undefined>;
  consent?: boolean;
};

export function buildLeadIntakePayload(overrides: LeadIntakeOptions = {}) {
  const now = new Date();
  const defaultPreferred = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const defaultAlternate = new Date(now.getTime() + 4 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  return {
    services: overrides.services ?? ["furniture"],
    name: overrides.name ?? "Playwright Lead",
    phone: overrides.phone ?? "(404) 555-0100",
    email: overrides.email ?? "playwright@mystos.test",
    addressLine1: overrides.addressLine1 ?? "456 Quote Lifecycle Ave",
    city: overrides.city ?? "Roswell",
    state: overrides.state ?? "GA",
    postalCode: overrides.postalCode ?? "30075",
    appointmentType: overrides.appointmentType ?? "in_person_estimate",
    scheduling: overrides.scheduling ?? {
      preferredDate: overrides.preferredDate ?? defaultPreferred,
      alternateDate: defaultAlternate,
      timeWindow: "window-am"
    },
    consent: overrides.consent ?? true,
    utm: {
      source: "playwright",
      medium: "e2e",
      campaign: "quote-lifecycle",
      ...overrides.utm
    }
  };
}
