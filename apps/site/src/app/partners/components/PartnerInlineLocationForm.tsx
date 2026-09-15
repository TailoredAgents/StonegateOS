"use client";

import * as React from "react";
import { CheckCircle2, LoaderCircle, MapPin, Plus, X } from "lucide-react";
import { cn } from "@myst-os/ui";
import {
  createPortalOperationKey,
  partnerPortalFetch,
  portalSupportReferenceFromResponse,
  withPortalSupportReference,
  type PartnerLocation,
} from "../lib/portal-v2";
import type { BookingWizardLocation } from "./PartnerBookingWizard";
import { toBookingLocation, isPartnerLocation } from "../lib/booking-location";
import {
  PartnerAddressAutocomplete,
  type SuggestedPartnerAddress,
} from "./PartnerAddressAutocomplete";
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
  return toBookingLocation(location);
}

export function PartnerInlineLocationForm({
  canManage,
  onCreated,
  embedded = false,
  formId,
  onPendingChange,
  onUnsavedChange,
  disabled = false,
}: {
  canManage: boolean;
  onCreated: (location: BookingWizardLocation) => void | Promise<void>;
  embedded?: boolean;
  formId?: string;
  onPendingChange?: (pending: boolean) => void;
  onUnsavedChange?: (unsaved: boolean) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const pendingRef = React.useRef(false);
  const [form, setForm] = React.useState(EMPTY_FORM);
  const [message, setMessage] = React.useState<{
    tone: "error" | "success" | "warning";
    text: string;
  } | null>(null);
  const headingId = React.useId();
  const selectedAddress = React.useRef<SuggestedPartnerAddress | null>(null);
  const createAttempt = React.useRef<{ body: string; key: string } | null>(
    null,
  );
  const hasUnsavedAddress = (
    Object.keys(EMPTY_FORM) as (keyof InlineLocationForm)[]
  ).some((key) => form[key] !== EMPTY_FORM[key]);

  React.useEffect(() => {
    onUnsavedChange?.(hasUnsavedAddress);
  }, [hasUnsavedAddress, onUnsavedChange]);

  if (!canManage) {
    return (
      <PartnerNotice tone="info" className="mt-4">
        Contact your account administrator to add a service address.
      </PartnerNotice>
    );
  }

  const update = (key: keyof InlineLocationForm, value: string): void => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pendingRef.current || disabled || !event.currentTarget.reportValidity())
      return;
    pendingRef.current = true;
    setPending(true);
    onPendingChange?.(true);
    setMessage(null);
    try {
      const body = JSON.stringify({
        siteName: form.siteName.trim() || form.line1.trim().slice(0, 120),
        externalPropertyId: null,
        address: {
          line1: form.line1.trim(),
          line2: form.line2.trim() || null,
          city: form.city.trim(),
          state: form.state.trim().toUpperCase(),
          postalCode: form.postalCode.trim(),
        },
        timezone: "America/New_York",
        locale: "en-US",
        access: { details: null, parking: null, loading: null },
        accessSecret: null,
        onSiteContact: null,
      });
      const attempt =
        createAttempt.current?.body === body
          ? createAttempt.current
          : { body, key: createPortalOperationKey("inline-location") };
      createAttempt.current = attempt;
      const result = await partnerPortalFetch<{
        ok: true;
        location: PartnerLocation;
      }>("locations", {
        method: "POST",
        headers: {
          "Idempotency-Key": attempt.key,
        },
        body: attempt.body,
      }).catch(() => null);
      if (!result?.ok) {
        setMessage({
          tone: "error",
          text:
            result?.error.message ??
            "The location could not be verified and saved. Check the address and try again.",
        });
        return;
      }
      if (!isPartnerLocation(result.data.location)) {
        setMessage({
          tone: "error",
          text: withPortalSupportReference(
            "We couldn’t confirm the saved location. Keep these details and try again to safely recover the same location.",
            portalSupportReferenceFromResponse(result.response),
          ),
        });
        return;
      }
      createAttempt.current = null;
      const location = toWizardLocation(result.data.location);
      setMessage({
        tone:
          result.data.location.serviceArea.status === "eligible"
            ? "success"
            : "warning",
        text:
          result.data.location.serviceArea.status === "eligible"
            ? "Service address saved and verified."
            : "Service address saved. Stonegate will review service availability before confirming the request.",
      });
      setForm(EMPTY_FORM);
      onUnsavedChange?.(false);
      selectedAddress.current = null;
      setOpen(false);
      try {
        await onCreated(location);
      } catch {
        // The address is already saved. The parent owns any draft-save failure.
      }
    } finally {
      pendingRef.current = false;
      setPending(false);
      onPendingChange?.(false);
    }
  };

  const addressForm = (
    <form
      id={formId}
      aria-label="Service address"
      className={embedded ? undefined : "mt-4"}
      onSubmit={(event) => void submit(event)}
    >
      <fieldset
        disabled={pending || disabled}
        className="grid min-w-0 gap-4 sm:grid-cols-2"
      >
        <div className="sm:col-span-2">
          <PartnerAddressAutocomplete
            id={`${headingId}-line1`}
            value={form.line1}
            disabled={pending || disabled}
            onChange={(value) => {
              const selected = selectedAddress.current;
              selectedAddress.current = null;
              setForm((current) => ({
                ...current,
                line1: value,
                ...(selected && value !== selected.line1
                  ? {
                      city: current.city === selected.city ? "" : current.city,
                      state:
                        current.state === selected.state ? "" : current.state,
                      postalCode:
                        current.postalCode === selected.postalCode
                          ? ""
                          : current.postalCode,
                    }
                  : {}),
              }));
            }}
            onSelect={(address) => {
              selectedAddress.current = address;
              setForm((current) => ({ ...current, ...address }));
            }}
          />
        </div>
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
            <span className="text-sm font-semibold text-slate-700">State</span>
            <input
              id={`${headingId}-state`}
              required
              maxLength={2}
              pattern="[A-Z]{2}"
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
              pattern="[0-9]{5}(-[0-9]{4})?"
              autoComplete="postal-code"
              inputMode="numeric"
              value={form.postalCode}
              onChange={(event) => update("postalCode", event.target.value)}
              className={partnerFieldClass}
            />
          </label>
        </div>
        <label className="sm:col-span-2" htmlFor={`${headingId}-name`}>
          <span className="text-sm font-semibold text-slate-700">
            Location label{" "}
            <span className="font-normal text-slate-500">(optional)</span>
          </span>
          <input
            id={`${headingId}-name`}
            maxLength={120}
            value={form.siteName}
            onChange={(event) => update("siteName", event.target.value)}
            className={partnerFieldClass}
            placeholder="Office, building, or property name"
          />
        </label>
        {!embedded ? (
          <button
            type="submit"
            disabled={pending || disabled}
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
            {pending ? "Saving address…" : "Use this address"}
          </button>
        ) : null}
      </fieldset>
    </form>
  );

  return (
    <div className={embedded ? undefined : "mt-4"}>
      {message ? (
        <PartnerNotice tone={message.tone} className="mb-3">
          {message.text}
        </PartnerNotice>
      ) : null}
      {embedded ? (
        addressForm
      ) : (
        <>
          <button
            type="button"
            onClick={() => setOpen((current) => !current)}
            disabled={pending || disabled}
            className={partnerSecondaryButtonClass}
            aria-expanded={open}
            aria-controls={headingId}
          >
            {open ? (
              <X className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Plus className="h-4 w-4" aria-hidden="true" />
            )}
            {open ? "Cancel address entry" : "Enter a new address"}
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
                    Service address
                  </h3>
                  <p className="mt-1 text-sm leading-6 text-slate-600">
                    Enter the address where service is needed.
                  </p>
                </div>
              </div>
              {addressForm}
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
