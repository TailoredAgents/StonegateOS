import { randomUUID } from "node:crypto";
import React, { type ReactElement } from "react";
import { serviceRates, zones } from "@myst-os/pricing/src/config/defaults";
import { requireCurrentTeamPrincipal } from "@/lib/team-principal";
import { hasTeamPermissionValue } from "@/lib/team-permissions";
import { callAdminApiAs } from "../lib/api";
import { quoteWorkspaceHref } from "../quotes-workspace";
import type { ContactSummary } from "./contacts.types";
import QuoteBuilderClient, {
  type QuoteBuilderContactOption,
  type QuoteBuilderServiceOption,
  type QuoteBuilderZoneOption,
} from "./QuoteBuilderClient";
import {
  loadInstantQuoteHandoff,
  verifyInstantQuoteHandoffSelection,
  type InstantQuoteHandoff,
} from "../lib/instant-quote-handoff";
import { teamButtonClass } from "./team-ui";
import { isQuoteV2StaffFeatureEnabled } from "../lib/quote-v2-staff-feature";

type ContactsResponse = {
  contacts: ContactSummary[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isQuoteBuilderContact(value: unknown): value is ContactSummary {
  if (!isRecord(value) || !Array.isArray(value["properties"])) return false;
  return (
    typeof value["id"] === "string" &&
    typeof value["name"] === "string" &&
    (value["email"] === null || typeof value["email"] === "string") &&
    (value["phone"] === null || typeof value["phone"] === "string") &&
    value["properties"].every(
      (property) =>
        isRecord(property) &&
        typeof property["id"] === "string" &&
        typeof property["addressLine1"] === "string" &&
        typeof property["city"] === "string" &&
        typeof property["state"] === "string" &&
        typeof property["postalCode"] === "string",
    )
  );
}

function QuoteBuilderUnavailable({
  title,
  detail,
  denied = false,
  retryHref,
}: {
  title: string;
  detail: string;
  denied?: boolean;
  retryHref?: string;
}): ReactElement {
  return (
    <section
      className={`rounded-2xl border p-5 text-sm ${
        denied
          ? "border-amber-200 bg-amber-50 text-amber-900"
          : "border-rose-200 bg-rose-50 text-rose-900"
      }`}
      role={denied ? "status" : "alert"}
      aria-labelledby="quote-builder-unavailable-title"
    >
      <h3 id="quote-builder-unavailable-title" className="font-semibold">
        {title}
      </h3>
      <p className="mt-1">{detail}</p>
      <a
        className={`mt-3 ${teamButtonClass("secondary", "sm")}`}
        href={retryHref ?? quoteWorkspaceHref("manage")}
      >
        {retryHref ? "Retry quote creation" : "Open quote management"}
      </a>
    </section>
  );
}

export async function QuoteBuilderSection({
  initialContactId,
  initialPropertyId,
  instantQuoteId,
}: {
  initialContactId?: string;
  initialPropertyId?: string;
  instantQuoteId?: string;
  workflow?: "canvass" | null;
}): Promise<ReactElement> {
  const principal = await requireCurrentTeamPrincipal();
  if (!hasTeamPermissionValue(principal.permissions, "quotes.write")) {
    return (
      <QuoteBuilderUnavailable
        denied
        title="Quote creation is read-only"
        detail="You can review quotes, but your current access does not allow creating or editing them."
      />
    );
  }

  // Instant-quote conversion remains on the compatibility adapter until the
  // verified handoff can create a V2 opportunity and immutable draft.
  if (isQuoteV2StaffFeatureEnabled() && !instantQuoteId) {
    const { QuoteV2BuilderSection } = await import("./QuoteV2BuilderSection");
    return QuoteV2BuilderSection({
      principal,
      initialContactId,
      initialPropertyId,
    });
  }

  const retryHref = quoteWorkspaceHref("create", {
    query: {
      contactId: initialContactId,
      propertyId: initialPropertyId,
      instantQuoteId,
      retry: "1",
    },
  });
  let response: Response;
  try {
    response = await callAdminApiAs(principal, "/api/admin/contacts?limit=100");
  } catch {
    return (
      <QuoteBuilderUnavailable
        title="Quote creation is unavailable"
        detail="The contact service could not be reached. Your selected customer and property remain in the URL."
        retryHref={retryHref}
      />
    );
  }
  if (!response.ok) {
    return (
      <QuoteBuilderUnavailable
        title="Quote creation is unavailable"
        detail={`The contact service returned HTTP ${response.status}. This is not an empty customer list.`}
        retryHref={retryHref}
      />
    );
  }

  const payload = (await response.json().catch(() => null)) as {
    contacts?: unknown;
  } | null;
  if (
    !payload ||
    !Array.isArray(payload.contacts) ||
    !payload.contacts.every(isQuoteBuilderContact)
  ) {
    return (
      <QuoteBuilderUnavailable
        title="Quote creation is unavailable"
        detail="The contact service returned an unreadable response. This is not an empty customer list."
        retryHref={retryHref}
      />
    );
  }
  let contactRecords = payload.contacts;
  if (
    initialContactId &&
    !contactRecords.some((contact) => contact.id === initialContactId)
  ) {
    try {
      const selectedResponse = await callAdminApiAs(
        principal,
        `/api/admin/contacts?contactId=${encodeURIComponent(initialContactId)}&limit=1`,
      );
      const selectedPayload = (await selectedResponse
        .json()
        .catch(() => null)) as ContactsResponse | null;
      if (
        !selectedResponse.ok ||
        !selectedPayload ||
        !Array.isArray(selectedPayload.contacts) ||
        !selectedPayload.contacts.every(isQuoteBuilderContact) ||
        selectedPayload.contacts.length !== 1
      ) {
        return (
          <QuoteBuilderUnavailable
            title="Selected customer is unavailable"
            detail="The requested customer could not be loaded safely. Refresh the contact before building a quote."
            retryHref={retryHref}
          />
        );
      }
      contactRecords = [...selectedPayload.contacts, ...contactRecords];
    } catch {
      return (
        <QuoteBuilderUnavailable
          title="Selected customer is unavailable"
          detail="The requested customer could not be loaded safely. Your selection remains in the URL."
          retryHref={retryHref}
        />
      );
    }
  }

  let instantQuoteHandoff: InstantQuoteHandoff | null = null;
  let instantQuoteHandoffError: string | null = null;
  if (instantQuoteId) {
    if (!initialContactId || !initialPropertyId) {
      instantQuoteHandoffError =
        "This full-quote link is incomplete. Open the instant quote and try again.";
    } else {
      const result = verifyInstantQuoteHandoffSelection(
        await loadInstantQuoteHandoff(principal, instantQuoteId),
        {
          instantQuoteId,
          contactId: initialContactId,
          propertyId: initialPropertyId,
        },
      );
      if (result.ok) {
        const contact = contactRecords.find(
          (candidate) => candidate.id === result.handoff.contactId,
        );
        const propertyIsVisible = contact?.properties.some(
          (property) => property.id === result.handoff.propertyId,
        );
        if (contact && propertyIsVisible) {
          instantQuoteHandoff = result.handoff;
        } else {
          instantQuoteHandoffError =
            "The verified quote property is not available on this customer record. Refresh or repair the relationship before creating a full quote.";
        }
      } else {
        instantQuoteHandoffError = result.error;
      }
    }
  }

  const contacts: QuoteBuilderContactOption[] = contactRecords.map(
    (contact) => ({
      id: contact.id,
      name: contact.name,
      email: contact.email,
      phone: contact.phone,
      properties: contact.properties.map((property) => ({
        id: property.id,
        label: `${property.addressLine1}, ${property.city}, ${property.state} ${property.postalCode}`,
      })),
    }),
  );

  const junkOnly = new Set([
    "single-item",
    "furniture",
    "appliances",
    "yard-waste",
    "construction-debris",
    "hot-tub",
    "other",
  ]);
  const serviceOptions: QuoteBuilderServiceOption[] = serviceRates
    .filter((svc) => junkOnly.has(svc.service))
    .map((service) => ({
      id: service.service,
      label: service.label,
      description: service.description ?? null,
      allowCustomPrice: true,
      autoPricingNote: null,
    }));

  const zoneOptions: QuoteBuilderZoneOption[] = zones.map((zone) => ({
    id: zone.id,
    name: zone.name,
  }));

  return (
    <QuoteBuilderClient
      mutationKey={`quote-create:${randomUUID()}`}
      canSend={hasTeamPermissionValue(principal.permissions, "quotes.send")}
      contacts={contacts}
      services={serviceOptions}
      zones={zoneOptions}
      defaultZoneId={zones[0]?.id ?? null}
      initialContactId={
        instantQuoteId ? instantQuoteHandoff?.contactId : initialContactId
      }
      initialPropertyId={instantQuoteHandoff?.propertyId}
      instantQuoteId={instantQuoteHandoff?.instantQuoteId}
      instantQuotePrefill={instantQuoteHandoff?.fullQuotePrefill ?? null}
      instantQuoteHandoffError={instantQuoteHandoffError}
    />
  );
}
