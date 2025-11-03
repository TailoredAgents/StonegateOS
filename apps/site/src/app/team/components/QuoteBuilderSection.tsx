import React, { type ReactElement } from "react";
import { serviceRates, zones } from "@myst-os/pricing/src/config/defaults";
import { callAdminApi } from "../lib/api";
import type { ContactSummary } from "./contacts.types";
import QuoteBuilderClient, {
  type QuoteBuilderContactOption,
  type QuoteBuilderServiceOption,
  type QuoteBuilderZoneOption
} from "./QuoteBuilderClient";

type ContactsResponse = {
  contacts: ContactSummary[];
};

export async function QuoteBuilderSection({ initialContactId }: { initialContactId?: string }): Promise<ReactElement> {
  const response = await callAdminApi("/api/admin/contacts?limit=100");
  if (!response.ok) {
    throw new Error("Failed to load contacts");
  }

  const payload = (await response.json()) as ContactsResponse;
  const contacts: QuoteBuilderContactOption[] = (payload.contacts ?? []).map((contact) => ({
    id: contact.id,
    name: contact.name,
    email: contact.email,
    phone: contact.phone,
    properties: contact.properties.map((property) => ({
      id: property.id,
      label: `${property.addressLine1}, ${property.city}, ${property.state} ${property.postalCode}`
    }))
  }));

  const junkOnly = new Set([
    "single-item",
    "furniture",
    "appliances",
    "yard-waste",
    "construction-debris",
    "hot-tub"
  ]);
  const serviceOptions: QuoteBuilderServiceOption[] = serviceRates
    .filter((svc) => junkOnly.has(svc.service))
    .map((service) => ({
      id: service.service,
      label: service.label,
      description: service.description ?? null,
      allowCustomPrice: true,
      autoPricingNote: null
    }));

  const zoneOptions: QuoteBuilderZoneOption[] = zones.map((zone) => ({
    id: zone.id,
    name: zone.name
  }));

  return (
    <QuoteBuilderClient
      contacts={contacts}
      services={serviceOptions}
      zones={zoneOptions}
      defaultZoneId={zones[0]?.id ?? null}
      initialContactId={initialContactId}
    />
  );
}
