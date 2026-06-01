"use client";

import React from "react";
import { SubmitButton } from "@/components/SubmitButton";
// Removed concrete surface handling for junk removal
import { createQuoteAction } from "../actions";

export type QuoteBuilderPropertyOption = {
  id: string;
  label: string;
};

export type QuoteBuilderContactOption = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  properties: QuoteBuilderPropertyOption[];
};

export type QuoteBuilderServiceOption = {
  id: string;
  label: string;
  description?: string | null;
  allowCustomPrice: boolean;
  autoPricingNote?: string | null;
};

export type QuoteBuilderZoneOption = {
  id: string;
  name: string;
};

// Concrete surface UI removed

interface QuoteBuilderClientProps {
  contacts: QuoteBuilderContactOption[];
  services: QuoteBuilderServiceOption[];
  zones: QuoteBuilderZoneOption[];
  defaultZoneId: string | null;
  initialContactId?: string;
  workflow?: "canvass" | null;
}

export function QuoteBuilderClient({
  contacts,
  services,
  zones,
  defaultZoneId,
  initialContactId,
  workflow
}: QuoteBuilderClientProps) {
  const [contactId, setContactId] = React.useState<string>(() => {
    if (initialContactId) {
      const match = contacts.find((contact) => contact.id === initialContactId);
      if (match) {
        return match.id;
      }
    }
    return contacts[0]?.id ?? "";
  });
  const [propertyId, setPropertyId] = React.useState<string>(() => {
    if (initialContactId) {
      const match = contacts.find((contact) => contact.id === initialContactId);
      if (match) {
        return match.properties[0]?.id ?? "";
      }
    }
    return contacts[0]?.properties[0]?.id ?? "";
  });
  const zoneId = React.useMemo(() => defaultZoneId ?? zones[0]?.id ?? "", [defaultZoneId, zones]);
  const [selectedServices, setSelectedServices] = React.useState<string[]>([]);
  const [sendQuote, setSendQuote] = React.useState<boolean>(() => {
    if (initialContactId) {
      const match = contacts.find((contact) => contact.id === initialContactId);
      if (match) {
        return Boolean(match.email || match.phone);
      }
    }
    return Boolean(contacts[0]?.email || contacts[0]?.phone);
  });
  const [servicePrices, setServicePrices] = React.useState<Record<string, string>>({});
  const [jobDurationMinutes, setJobDurationMinutes] = React.useState("120");
  const [depositRate, setDepositRate] = React.useState("0");
  const [scopeNotes, setScopeNotes] = React.useState("");
  const [clientScope, setClientScope] = React.useState("");
  const [scopeDrafting, setScopeDrafting] = React.useState(false);
  const [scopeDraftError, setScopeDraftError] = React.useState<string | null>(null);
  // Concrete surface state removed

  const selectedContact = React.useMemo(
    () => contacts.find((contact) => contact.id === contactId) ?? null,
    [contactId, contacts]
  );

  const canSendQuote = Boolean(selectedContact?.email || selectedContact?.phone);
  const serviceLookup = React.useMemo(() => new Map(services.map((service) => [service.id, service])), [services]);
  const selectableServices = services;
  // Concrete computations removed

  // No automatic driveway management

  // No concrete-driven price cleanup

  const serviceOverrides = React.useMemo(() => {
    const overrides: Record<string, number> = {};
    for (const serviceId of selectedServices) {
      const service = serviceLookup.get(serviceId);
      if (!service || !service.allowCustomPrice) continue;
      const raw = servicePrices[serviceId];
      if (typeof raw !== "string") continue;
      const trimmed = raw.trim();
      if (trimmed.length === 0) continue;
      const value = Number(trimmed);
      if (Number.isFinite(value) && value > 0) {
        overrides[serviceId] = value;
      }
    }
    return overrides;
  }, [
    selectedServices,
    serviceLookup,
    servicePrices
  ]);

  const hasAllCustomPrices = React.useMemo(() => {
    return selectedServices.every((serviceId) => {
      const service = serviceLookup.get(serviceId);
      if (!service || !service.allowCustomPrice) {
        return true;
      }
      const raw = servicePrices[serviceId];
      if (typeof raw !== "string") {
        return false;
      }
      const trimmed = raw.trim();
      if (trimmed.length === 0) {
        return false;
      }
      const value = Number(trimmed);
      return Number.isFinite(value) && value > 0;
    });
  }, [selectedServices, serviceLookup, servicePrices]);
  const serializedOverrides = React.useMemo(() => JSON.stringify(serviceOverrides), [serviceOverrides]);
  const estimatedTotal = React.useMemo(() => {
    return Object.values(serviceOverrides).reduce((sum, value) => sum + value, 0);
  }, [serviceOverrides]);

  React.useEffect(() => {
    if (!initialContactId) return;
    const match = contacts.find((contact) => contact.id === initialContactId);
    if (!match) return;
    if (match.id === contactId) return;
    setContactId(match.id);
    setPropertyId(match.properties[0]?.id ?? "");
    setSendQuote(Boolean(match.email || match.phone));
  }, [initialContactId, contacts, contactId]);

  React.useEffect(() => {
    if (!selectedContact) {
      setPropertyId("");
      return;
    }
    const current = selectedContact.properties.find((property) => property.id === propertyId);
    if (!current) {
      setPropertyId(selectedContact.properties[0]?.id ?? "");
    }
  }, [propertyId, selectedContact]);

  React.useEffect(() => {
    if (!canSendQuote) {
      setSendQuote(false);
    }
  }, [canSendQuote]);

  const toggleService = React.useCallback(
    (serviceId: string) => {
      setSelectedServices((prev) => {
        if (prev.includes(serviceId)) {
          setServicePrices((current) => {
            if (!(serviceId in current)) {
              return current;
            }
            const { [serviceId]: _removed, ...rest } = current;
            return rest;
          });
          return prev.filter((id) => id !== serviceId);
        }
        return [...prev, serviceId];
      });
    },
    [setServicePrices]
  );

  const handlePriceChange = React.useCallback(
    (serviceId: string, value: string) => {
      setServicePrices((prev) => ({
        ...prev,
        [serviceId]: value
      }));
    },
    [setServicePrices]
  );

  const draftClientScope = React.useCallback(async () => {
    setScopeDrafting(true);
    setScopeDraftError(null);
    try {
      const response = await fetch("/api/team/quotes/scope-draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerName: selectedContact?.name ?? null,
          services: selectedServices,
          total: estimatedTotal > 0 ? estimatedTotal : undefined,
          roughNotes: scopeNotes
        })
      });
      const payload = (await response.json().catch(() => null)) as { draft?: string; error?: string } | null;
      if (!response.ok || !payload?.draft) {
        setScopeDraftError(payload?.error ?? "Unable to draft scope.");
        return;
      }
      setClientScope(payload.draft);
    } catch (error) {
      setScopeDraftError(error instanceof Error ? error.message : "Unable to draft scope.");
    } finally {
      setScopeDrafting(false);
    }
  }, [estimatedTotal, scopeNotes, selectedContact?.name, selectedServices]);

  const canSubmit =
    selectedContact !== null &&
    propertyId.length > 0 &&
    selectedServices.length > 0 &&
    zoneId.length > 0 &&
    hasAllCustomPrices;

  if (contacts.length === 0) {
    return (
      <section className="rounded-3xl border border-slate-200 bg-white/90 p-6 text-sm text-slate-600 shadow-xl shadow-slate-200/60">
        <h2 className="text-xl font-semibold text-slate-900">No contacts yet</h2>
        <p className="mt-2">
          Add a contact with property details before creating an email-ready quote. Once a lead exists, you can build a
          proposal here and send it to their inbox in one step.
        </p>
      </section>
    );
  }

  const propertyOptions = selectedContact?.properties ?? [];

  return (
    <section className="space-y-6">
      <div className="rounded-3xl border border-slate-200 bg-white/90 p-6 shadow-xl shadow-slate-200/60 backdrop-blur">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between">
          <div>
            <h2 className="text-xl font-semibold text-slate-900">
              {workflow === "canvass" ? "Build a canvass quote" : "Build and send a quote"}
            </h2>
            <p className="text-sm text-slate-600">
              {workflow === "canvass"
                ? "Create the quote, then the system prepares an SMS draft for you to send from the Unified Inbox."
                : "Choose a saved contact and property, bundle the services, and optionally email the proposal right away."}
            </p>
          </div>
        </div>

          <form action={createQuoteAction} className="mt-5 space-y-6">
            <input type="hidden" name="services" value={JSON.stringify(selectedServices)} />
            <input type="hidden" name="serviceOverrides" value={serializedOverrides} />
            <input type="hidden" name="zoneId" value={zoneId} />
            {workflow ? <input type="hidden" name="workflow" value={workflow} /> : null}

          <div className="grid gap-4 lg:grid-cols-2">
            <label className="flex flex-col gap-2 text-sm text-slate-600">
              <span>Contact</span>
              <select
                name="contactId"
                value={contactId}
                onChange={(event) => setContactId(event.target.value)}
                className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
              >
                {contacts.map((contact) => (
                  <option key={contact.id} value={contact.id}>
                    {contact.name}
                  </option>
                ))}
              </select>
              {selectedContact?.email || selectedContact?.phone ? (
                <span className="text-xs text-slate-500">
                  Send to: {[selectedContact.email, selectedContact.phone].filter(Boolean).join(" / ")}
                </span>
              ) : (
                <span className="text-xs text-slate-400">
                  This contact does not have an email or phone yet. Add one to send quotes.
                </span>
              )}
            </label>

            <label className="flex flex-col gap-2 text-sm text-slate-600">
              <span>Property</span>
              <select
                name="propertyId"
                value={propertyId}
                onChange={(event) => setPropertyId(event.target.value)}
                className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                disabled={propertyOptions.length === 0}
              >
                {propertyOptions.length === 0 ? (
                  <option value="">
                    {selectedContact ? "No property on file" : "Select a contact first"}
                  </option>
                ) : (
                  propertyOptions.map((property) => (
                    <option key={property.id} value={property.id}>
                      {property.label}
                    </option>
                  ))
                )}
              </select>
              {propertyOptions.length === 0 ? (
                <span className="text-xs text-slate-400">
                  Save a property for this contact in the Contacts tab to enable quoting.
                </span>
              ) : null}
            </label>
          </div>

          {/* Removed concrete surfaces UI for junk removal */}

          <fieldset className="space-y-3">
            <legend className="text-sm font-semibold text-slate-700">Services included</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {selectableServices.map((service) => {
                const checked = selectedServices.includes(service.id);
                const containerClasses = checked
                  ? "border-primary-300 bg-primary-50 text-primary-800 shadow-sm"
                  : "border-slate-200 bg-white text-slate-600 hover:border-primary-200 hover:bg-primary-50/40";
                const priceValue = servicePrices[service.id] ?? "";
                const requiresCustomPrice = service.allowCustomPrice;
                const trimmedPrice = priceValue.trim();
                const numericPrice = Number(trimmedPrice);
                const priceInvalid =
                  requiresCustomPrice &&
                  checked &&
                  (trimmedPrice.length === 0 || !Number.isFinite(numericPrice) || numericPrice <= 0);
                return (
                  <div
                    key={service.id}
                    className={`rounded-2xl border px-4 py-3 transition ${containerClasses}`}
                  >
                    <label className="flex cursor-pointer items-start gap-3">
                      <input
                        type="checkbox"
                        value={service.id}
                        checked={checked}
                        onChange={() => toggleService(service.id)}
                        className="mt-1 rounded border-slate-300 text-primary-600 focus:ring-primary-400"
                      />
                      <div className="flex-1">
                        <span className="block text-sm font-semibold">{service.label}</span>
                        {service.description ? (
                          <span className="mt-1 block text-xs text-slate-500">{service.description}</span>
                        ) : null}
                      </div>
                    </label>
                    {requiresCustomPrice ? (
                      <div className="mt-3 space-y-1 pl-8">
                        <label className="flex flex-col gap-1 text-xs text-slate-600">
                          <span className="font-medium text-slate-700">Custom price (total)</span>
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            inputMode="decimal"
                            value={priceValue}
                            onChange={(event) => handlePriceChange(service.id, event.target.value)}
                            disabled={!checked}
                            placeholder="Enter total price"
                            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-200 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
                          />
                        </label>
                        {checked ? (
                          <p className="text-[11px] text-slate-500">Provide the total for this service.</p>
                        ) : (
                          <p className="text-[11px] text-slate-400">Select this service to enter a price.</p>
                        )}
                        {priceInvalid ? (
                          <p className="text-[11px] text-rose-500">Enter a positive amount.</p>
                        ) : null}
                      </div>
                    ) : service.autoPricingNote ? (
                      <p className="mt-3 pl-8 text-[11px] text-slate-500">{service.autoPricingNote}</p>
                    ) : null}
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-slate-500">
              Select at least one service to calculate pricing and generate the quote link.
            </p>
          </fieldset>

          <div className="grid gap-4 lg:grid-cols-3">
            <label className="flex flex-col gap-2 text-sm text-slate-600">
              <span>Job duration</span>
              <select
                name="jobDurationMinutes"
                value={jobDurationMinutes}
                onChange={(event) => setJobDurationMinutes(event.target.value)}
                className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
              >
                <option value="60">1 hour</option>
                <option value="120">2 hours</option>
                <option value="180">3 hours</option>
                <option value="240">Half day</option>
                <option value="480">Full day</option>
              </select>
            </label>
            <label className="flex flex-col gap-2 text-sm text-slate-600">
              <span>Deposit terms</span>
              <select
                name="depositRate"
                value={depositRate}
                onChange={(event) => setDepositRate(event.target.value)}
                className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
              >
                <option value="0">No deposit</option>
                <option value="0.1">10% deposit listed</option>
                <option value="0.25">25% deposit listed</option>
                <option value="0.5">50% deposit listed</option>
              </select>
              <span className="text-xs text-slate-500">Deposits are shown as terms only; online collection is not enabled.</span>
            </label>
            <label className="flex flex-col gap-2 text-sm text-slate-600">
              <span>Quote validity</span>
              <input
                name="expiresInDays"
                type="number"
                min="1"
                max="90"
                defaultValue="7"
                className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
              />
            </label>
          </div>

          <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
            <div>
              <h3 className="text-sm font-semibold text-slate-800">Client-facing scope</h3>
              <p className="mt-1 text-xs text-slate-500">
                Add rough notes, draft polished proposal language, then review/edit before sending.
              </p>
            </div>
            <label className="flex flex-col gap-2 text-sm text-slate-600">
              <span>Rough notes for AI draft</span>
              <textarea
                value={scopeNotes}
                onChange={(event) => setScopeNotes(event.target.value)}
                rows={3}
                placeholder="Example: garage cleanout, appliances included, driveway access is clear..."
                className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
              />
            </label>
            <button
              type="button"
              onClick={() => void draftClientScope()}
              disabled={scopeDrafting || selectedServices.length === 0}
              className="rounded-full border border-primary-200 bg-primary-50 px-4 py-2 text-xs font-semibold text-primary-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {scopeDrafting ? "Drafting..." : "Draft polished scope"}
            </button>
            {scopeDraftError ? <p className="text-xs text-rose-600">{scopeDraftError}</p> : null}
            <label className="flex flex-col gap-2 text-sm text-slate-600">
              <span>Scope shown to customer</span>
              <textarea
                name="clientScope"
                value={clientScope}
                onChange={(event) => setClientScope(event.target.value)}
                rows={5}
                placeholder="This scope appears on the public quote page."
                className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
              />
            </label>
          </div>

          <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-slate-50/70 p-4 text-sm text-slate-600">
            <label className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                name="sendQuote"
                checked={sendQuote}
                onChange={(event) => setSendQuote(event.target.checked)}
                disabled={!canSendQuote}
                className="rounded border-slate-300 text-primary-600 focus:ring-primary-400 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-300"
                title={!canSendQuote ? "Add an email or phone to this contact to enable sending" : undefined}
              />
              Send the quote link by SMS/email immediately
            </label>
            <p className="text-xs text-slate-500">
              We&apos;ll still show the share link so you can copy it into chat, even when messages go out.
            </p>
            {!canSendQuote ? (
              <p className="text-xs font-medium text-amber-600">
                Add an email address or phone to this contact to enable sending the quote automatically.
              </p>
            ) : null}
          </div>

          <label className="flex flex-col gap-2 text-sm text-slate-600">
            <span>Internal notes</span>
            <textarea
              name="notes"
              rows={4}
              placeholder="Optional details for the homeowner or crew"
              className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
            />
          </label>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-slate-500">
              {selectedContact ? (
                <>
                  Sending to <span className="font-medium text-slate-700">{selectedContact.name}</span>
                  {selectedContact.email ? ` (${selectedContact.email})` : ""}.
                </>
              ) : (
                "Choose a contact to enable quoting."
              )}
            </div>
            <SubmitButton
              className="inline-flex items-center rounded-full bg-primary-600 px-6 py-2 text-sm font-semibold text-white shadow-lg shadow-primary-200/50 transition hover:bg-primary-700 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-600"
              pendingLabel="Creating quote..."
              disabled={!canSubmit}
            >
              Create quote
            </SubmitButton>
            {hasAllCustomPrices ? null : (
              <p className="w-full text-[11px] text-rose-500">Enter a custom price for each selected service.</p>
            )}
            {/* No concrete validation needed */}
          </div>
        </form>
      </div>

      <div className="rounded-3xl border border-slate-200 bg-white/80 p-5 text-xs text-slate-500 shadow-md shadow-slate-200/60">
        <h3 className="text-sm font-semibold text-slate-700">Workflow tips</h3>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>Need a new contact? Add them in the Contacts tab first so their property details are available here.</li>
          <li>You can uncheck the email option to copy the share link and send it manually via SMS or chat.</li>
          <li>Bundle discounts apply automatically when qualifying services are selected together.</li>
        </ul>
      </div>
    </section>
  );
}

export default QuoteBuilderClient;
