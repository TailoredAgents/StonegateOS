"use client";

import * as React from "react";
import { CheckCircle2, LoaderCircle, MapPin, Plus, X } from "lucide-react";
import { cn } from "@myst-os/ui";
import {
  createPortalOperationKey,
  partnerPortalFetch,
  type PartnerLocation,
} from "../lib/portal-v2";
import type { BookingWizardLocation } from "./PartnerBookingWizard";
import {
  PartnerNotice,
  partnerFieldClass,
  partnerPrimaryButtonClass,
  partnerSecondaryButtonClass,
} from "./PartnerPortalUi";

type InlineLocationForm = {
  siteName: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  postalCode: string;
};

const EMPTY_FORM: InlineLocationForm = {
  siteName: "",
  line1: "",
  line2: "",
  city: "",
  state: "GA",
  postalCode: "",
};

function toWizardLocation(location: PartnerLocation): BookingWizardLocation {
  return {
    id: location.id,
    name: location.siteName?.trim() || location.address.line1,
    address: [
      location.address.line1,
      location.address.line2,
      `${location.address.city}, ${location.address.state} ${location.address.postalCode}`,
    ]
      .filter(Boolean)
      .join(", "),
    serviceAreaStatus: location.serviceArea.status,
  };
}

export function PartnerInlineLocationForm({
  canManage,
  onCreated,
}: {
  canManage: boolean;
  onCreated: (location: BookingWizardLocation) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [form, setForm] = React.useState(EMPTY_FORM);
  const [message, setMessage] = React.useState<{
    tone: "error" | "success" | "warning";
    text: string;
  } | null>(null);
  const headingId = React.useId();

  if (!canManage) {
    return (
      <PartnerNotice tone="info" className="mt-4">
        Need another address? Ask an account administrator to add it under
        Locations.
      </PartnerNotice>
    );
  }

  const update = (key: keyof InlineLocationForm, value: string): void => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setMessage(null);
    const result = await partnerPortalFetch<{
      ok: true;
      location: PartnerLocation;
    }>("locations", {
      method: "POST",
      headers: {
        "Idempotency-Key": createPortalOperationKey("inline-location"),
      },
      body: JSON.stringify({
        siteName: form.siteName,
        externalPropertyId: null,
        address: {
          line1: form.line1,
          line2: form.line2 || null,
          city: form.city,
          state: form.state,
          postalCode: form.postalCode,
        },
        timezone: "America/New_York",
        locale: "en-US",
        access: { details: null, parking: null, loading: null },
        accessSecret: null,
        onSiteContact: null,
      }),
    }).catch(() => null);
    setPending(false);
    if (!result?.ok) {
      setMessage({
        tone: "error",
        text:
          result?.error.message ??
          "The location could not be verified and saved. Check the address and try again.",
      });
      return;
    }
    const location = toWizardLocation(result.data.location);
    onCreated(location);
    setMessage({
      tone:
        result.data.location.serviceArea.status === "eligible"
          ? "success"
          : "warning",
      text:
        result.data.location.serviceArea.status === "eligible"
          ? "Location saved, verified, and selected for this request."
          : "Location saved and selected. Stonegate will review its service area before confirming.",
    });
    setForm(EMPTY_FORM);
    setOpen(false);
  };

  return (
    <div className="mt-4">
      {message ? (
        <PartnerNotice tone={message.tone} className="mb-3">
          {message.text}
        </PartnerNotice>
      ) : null}
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className={partnerSecondaryButtonClass}
        aria-expanded={open}
        aria-controls={headingId}
      >
        {open ? (
          <X className="h-4 w-4" aria-hidden="true" />
        ) : (
          <Plus className="h-4 w-4" aria-hidden="true" />
        )}
        {open ? "Close location form" : "Add a location without leaving"}
      </button>

      {open ? (
        <section
          id={headingId}
          className="mt-3 rounded-2xl border border-primary-200 bg-primary-50/40 p-4 sm:p-5"
          aria-labelledby={`${headingId}-title`}
        >
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white text-primary-700 ring-1 ring-primary-100">
              <MapPin className="h-5 w-5" aria-hidden="true" />
            </span>
            <div>
              <h3
                id={`${headingId}-title`}
                className="font-semibold text-slate-950"
              >
                Add and verify a service location
              </h3>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                Your saved booking draft stays open. The new location will be
                selected automatically after the address check.
              </p>
            </div>
          </div>
          <form
            className="mt-4 grid gap-4 sm:grid-cols-2"
            onSubmit={(event) => void submit(event)}
          >
            <label htmlFor={`${headingId}-name`}>
              <span className="text-sm font-semibold text-slate-700">
                Location name
              </span>
              <input
                id={`${headingId}-name`}
                required
                maxLength={120}
                value={form.siteName}
                onChange={(event) => update("siteName", event.target.value)}
                className={partnerFieldClass}
                placeholder="Property, listing, building, or jobsite"
              />
            </label>
            <label htmlFor={`${headingId}-line1`}>
              <span className="text-sm font-semibold text-slate-700">
                Street address
              </span>
              <input
                id={`${headingId}-line1`}
                required
                maxLength={200}
                autoComplete="address-line1"
                value={form.line1}
                onChange={(event) => update("line1", event.target.value)}
                className={partnerFieldClass}
              />
            </label>
            <label className="sm:col-span-2" htmlFor={`${headingId}-line2`}>
              <span className="text-sm font-semibold text-slate-700">
                Suite, unit, building, or floor{" "}
                <span className="font-normal text-slate-500">(optional)</span>
              </span>
              <input
                id={`${headingId}-line2`}
                maxLength={100}
                autoComplete="address-line2"
                value={form.line2}
                onChange={(event) => update("line2", event.target.value)}
                className={partnerFieldClass}
              />
            </label>
            <label htmlFor={`${headingId}-city`}>
              <span className="text-sm font-semibold text-slate-700">City</span>
              <input
                id={`${headingId}-city`}
                required
                maxLength={100}
                autoComplete="address-level2"
                value={form.city}
                onChange={(event) => update("city", event.target.value)}
                className={partnerFieldClass}
              />
            </label>
            <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3">
              <label htmlFor={`${headingId}-state`}>
                <span className="text-sm font-semibold text-slate-700">
                  State
                </span>
                <input
                  id={`${headingId}-state`}
                  required
                  maxLength={2}
                  autoComplete="address-level1"
                  value={form.state}
                  onChange={(event) =>
                    update("state", event.target.value.toUpperCase())
                  }
                  className={cn(partnerFieldClass, "uppercase")}
                />
              </label>
              <label htmlFor={`${headingId}-postal`}>
                <span className="text-sm font-semibold text-slate-700">
                  ZIP code
                </span>
                <input
                  id={`${headingId}-postal`}
                  required
                  maxLength={16}
                  autoComplete="postal-code"
                  inputMode="numeric"
                  value={form.postalCode}
                  onChange={(event) => update("postalCode", event.target.value)}
                  className={partnerFieldClass}
                />
              </label>
            </div>
            <button
              type="submit"
              disabled={pending}
              className={cn(partnerPrimaryButtonClass, "sm:col-span-2")}
            >
              {pending ? (
                <LoaderCircle
                  className="h-4 w-4 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : (
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
              )}
              {pending ? "Verifying address…" : "Save and use this location"}
            </button>
          </form>
        </section>
      ) : null}
    </div>
  );
}
