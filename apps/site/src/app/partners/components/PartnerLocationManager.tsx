"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import {
  Archive,
  CalendarPlus2,
  CheckCircle2,
  KeyRound,
  LoaderCircle,
  MapPin,
  Pencil,
  Plus,
  Search,
  UserRound,
  X,
} from "lucide-react";
import { cn } from "@myst-os/ui";
import type { PartnerLocation } from "../lib/portal-v2";
import { createPortalOperationKey, partnerPortalFetch } from "../lib/portal-v2";
import {
  PartnerEmptyState,
  PartnerNotice,
  partnerFieldClass,
  partnerPrimaryButtonClass,
  partnerSecondaryButtonClass,
} from "./PartnerPortalUi";

type LocationForm = {
  siteName: string;
  externalPropertyId: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  postalCode: string;
  accessDetails: string;
  parking: string;
  loading: string;
  accessSecret: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
};

const EMPTY_LOCATION: LocationForm = {
  siteName: "",
  externalPropertyId: "",
  line1: "",
  line2: "",
  city: "",
  state: "GA",
  postalCode: "",
  accessDetails: "",
  parking: "",
  loading: "",
  accessSecret: "",
  contactName: "",
  contactPhone: "",
  contactEmail: "",
};

function text(record: Record<string, unknown> | null, key: string): string {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}

function formFromLocation(location: PartnerLocation): LocationForm {
  return {
    siteName: location.siteName ?? "",
    externalPropertyId: location.externalPropertyId ?? "",
    line1: location.address.line1,
    line2: location.address.line2 ?? "",
    city: location.address.city,
    state: location.address.state,
    postalCode: location.address.postalCode,
    accessDetails: location.access.details ?? "",
    parking: location.access.parking ?? "",
    loading: location.access.loading ?? "",
    accessSecret: "",
    contactName: text(location.onSiteContact, "name"),
    contactPhone: text(location.onSiteContact, "phone"),
    contactEmail: text(location.onSiteContact, "email"),
  };
}

function locationPayload(form: LocationForm, editing: boolean) {
  return {
    siteName: form.siteName,
    externalPropertyId: form.externalPropertyId || null,
    address: {
      line1: form.line1,
      line2: form.line2 || null,
      city: form.city,
      state: form.state,
      postalCode: form.postalCode,
    },
    timezone: "America/New_York",
    locale: "en-US",
    access: {
      details: form.accessDetails || null,
      parking: form.parking || null,
      loading: form.loading || null,
    },
    ...(form.accessSecret ? { accessSecret: form.accessSecret } : editing ? {} : { accessSecret: null }),
    onSiteContact:
      form.contactName || form.contactPhone || form.contactEmail
        ? {
            name: form.contactName || null,
            phone: form.contactPhone || null,
            email: form.contactEmail || null,
          }
        : null,
  };
}

export function PartnerLocationManager({
  initialLocations,
  canManage,
}: {
  initialLocations: PartnerLocation[];
  canManage: boolean;
}) {
  const [locations, setLocations] = React.useState(initialLocations);
  const [search, setSearch] = React.useState("");
  const [showArchived, setShowArchived] = React.useState(false);
  const [adding, setAdding] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<{ tone: "success" | "error"; text: string } | null>(null);

  const visible = locations.filter((location) => {
    if (!showArchived && !location.active) return false;
    const haystack = [
      location.siteName,
      location.externalPropertyId,
      location.address.line1,
      location.address.city,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(search.trim().toLowerCase());
  });

  const createLocation = async (form: LocationForm): Promise<boolean> => {
    setBusyId("new");
    setMessage(null);
    const result = await partnerPortalFetch<{ ok: true; location: PartnerLocation }>("locations", {
      method: "POST",
      headers: { "Idempotency-Key": createPortalOperationKey("location-create") },
      body: JSON.stringify(locationPayload(form, false)),
    }).catch(() => null);
    setBusyId(null);
    if (!result?.ok) {
      setMessage({ tone: "error", text: result?.error.message ?? "The location was not added." });
      return false;
    }
    setLocations((current) => [...current, result.data.location].sort((a, b) => (a.siteName ?? "").localeCompare(b.siteName ?? "")));
    setAdding(false);
    setMessage({ tone: "success", text: "Location added. Service-area status is shown below." });
    return true;
  };

  const updateLocation = async (location: PartnerLocation, form: LocationForm): Promise<boolean> => {
    setBusyId(location.id);
    setMessage(null);
    const result = await partnerPortalFetch<{ ok: true; location: PartnerLocation }>(
      `locations/${location.id}`,
      {
        method: "PATCH",
        headers: { "If-Match": location.etag },
        body: JSON.stringify(locationPayload(form, true)),
      },
    ).catch(() => null);
    setBusyId(null);
    if (!result?.ok) {
      setMessage({ tone: "error", text: result?.error.message ?? "The location changes were not saved." });
      return false;
    }
    setLocations((current) => current.map((item) => (item.id === location.id ? result.data.location : item)));
    setEditingId(null);
    setMessage({ tone: "success", text: "Location changes saved." });
    return true;
  };

  const archiveLocation = async (location: PartnerLocation): Promise<void> => {
    setBusyId(location.id);
    setMessage(null);
    const result = await partnerPortalFetch<{ ok: true; location: PartnerLocation }>(
      `locations/${location.id}`,
      { method: "DELETE", headers: { "If-Match": location.etag } },
    ).catch(() => null);
    setBusyId(null);
    if (!result?.ok) {
      setMessage({ tone: "error", text: result?.error.message ?? "The location was not archived." });
      return;
    }
    setLocations((current) => current.map((item) => (item.id === location.id ? result.data.location : item)));
    setEditingId(null);
    setMessage({ tone: "success", text: "Location archived. Existing job records remain unchanged." });
  };

  return (
    <div className="space-y-5">
      {message ? <PartnerNotice tone={message.tone}>{message.text}</PartnerNotice> : null}
      {canManage ? (
        <div className="flex justify-end">
          <button type="button" onClick={() => setAdding((current) => !current)} className={partnerPrimaryButtonClass} aria-expanded={adding} aria-controls="partner-add-location">
            {adding ? <X className="h-4 w-4" aria-hidden="true" /> : <Plus className="h-4 w-4" aria-hidden="true" />}
            {adding ? "Close form" : "Add location"}
          </button>
        </div>
      ) : null}
      {adding ? (
        <section id="partner-add-location" aria-labelledby="partner-add-location-heading" className="rounded-2xl border border-primary-200 bg-primary-50/40 p-4 sm:p-5">
          <h2 id="partner-add-location-heading" className="text-lg font-semibold text-slate-950">Add a service location</h2>
          <p className="mt-1 text-sm leading-6 text-slate-600">Save public address and instructions here. Gate codes and other secrets are encrypted separately.</p>
          <LocationFormFields initial={EMPTY_LOCATION} submitLabel="Add location" pending={busyId === "new"} onSubmit={createLocation} />
        </section>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <label htmlFor="partner-location-search"><span className="text-sm font-semibold text-slate-700">Search locations</span><div className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" /><input id="partner-location-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} className={`${partnerFieldClass} pl-10`} placeholder="Name, address, or property ID" /></div></label>
        <label className="flex min-h-11 items-center gap-3 rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700"><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} className="h-5 w-5 rounded border-slate-300 text-primary-700" />Show archived</label>
      </div>

      {visible.length === 0 ? (
        <PartnerEmptyState title={search ? "No locations match that search" : "No active locations"} description={search ? "Try a different name, address, or property ID." : canManage ? "Add a location to begin scheduling service." : "No service locations are currently visible to your role."} icon={<MapPin className="h-6 w-6" aria-hidden="true" />} />
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {visible.map((location) => {
            const editing = editingId === location.id;
            return (
              <li key={location.id} className={cn("rounded-2xl border bg-white p-4", location.active ? "border-slate-200" : "border-slate-200 bg-slate-50 opacity-80")}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h2 className="font-semibold text-slate-950">{location.siteName || location.address.line1}</h2>{!location.active ? <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-semibold text-slate-700">Archived</span> : null}</div><p className="mt-1 text-sm leading-6 text-slate-600">{[location.address.line1, location.address.line2, `${location.address.city}, ${location.address.state} ${location.address.postalCode}`].filter(Boolean).join(", ")}</p>{location.externalPropertyId ? <p className="mt-1 text-xs text-slate-600">Property ID: {location.externalPropertyId}</p> : null}<div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">{location.access.hasSecret ? <span className="inline-flex items-center gap-1.5"><KeyRound className="h-3.5 w-3.5" aria-hidden="true" />Private access code saved</span> : null}{location.access.details || location.access.parking || location.access.loading ? <span>Access instructions saved</span> : null}{text(location.onSiteContact, "name") ? <span className="inline-flex items-center gap-1.5"><UserRound className="h-3.5 w-3.5" aria-hidden="true" />{text(location.onSiteContact, "name")}</span> : null}</div>{location.serviceArea.reason ? <p className="mt-2 text-xs leading-5 text-amber-800">{location.serviceArea.reason}</p> : null}</div>
                  <ServiceAreaBadge status={location.serviceArea.status} />
                </div>
                <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-200 pt-3">
                  {location.active ? <Link href={`/partners/book?locationId=${encodeURIComponent(location.id)}` as Route} className={partnerSecondaryButtonClass}><CalendarPlus2 className="h-4 w-4" aria-hidden="true" />Schedule here</Link> : null}
                  {canManage && location.active ? <button type="button" onClick={() => setEditingId(editing ? null : location.id)} className={partnerSecondaryButtonClass} aria-expanded={editing}><Pencil className="h-4 w-4" aria-hidden="true" />{editing ? "Close edit" : "Edit"}</button> : null}
                </div>
                {editing ? (
                  <div className="mt-4 border-t border-slate-200 pt-4">
                    <LocationFormFields initial={formFromLocation(location)} submitLabel="Save changes" pending={busyId === location.id} onSubmit={(form) => updateLocation(location, form)} />
                    <details className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-3"><summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 font-semibold text-rose-800 [&::-webkit-details-marker]:hidden"><Archive className="h-4 w-4" aria-hidden="true" />Archive location</summary><p className="mt-2 text-sm leading-6 text-rose-800">This removes the location from new scheduling. Existing jobs and records remain linked.</p><button type="button" onClick={() => void archiveLocation(location)} disabled={busyId === location.id} className={cn(partnerSecondaryButtonClass, "mt-3 border-rose-300 text-rose-800 hover:bg-rose-100")}>{busyId === location.id ? <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Archive className="h-4 w-4" aria-hidden="true" />}Confirm archive</button></details>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function LocationFormFields({ initial, submitLabel, pending, onSubmit }: { initial: LocationForm; submitLabel: string; pending: boolean; onSubmit: (form: LocationForm) => Promise<boolean> }) {
  const [form, setForm] = React.useState(initial);
  const fieldPrefix = `partner-location-${React.useId().replace(/:/gu, "")}`;
  const update = (key: keyof LocationForm, value: string): void => setForm((current) => ({ ...current, [key]: value }));
  return (
    <form className="mt-4 grid gap-4 sm:grid-cols-2" onSubmit={(event) => { event.preventDefault(); void onSubmit(form); }}>
      <label htmlFor={`${fieldPrefix}-site-name`}><span className="text-sm font-semibold text-slate-700">Location name</span><input id={`${fieldPrefix}-site-name`} required maxLength={120} value={form.siteName} onChange={(event) => update("siteName", event.target.value)} className={partnerFieldClass} placeholder="Building, listing, jobsite, or property" /></label>
      <label htmlFor={`${fieldPrefix}-property-id`}><span className="text-sm font-semibold text-slate-700">Internal property ID <span className="font-normal text-slate-500">(optional)</span></span><input id={`${fieldPrefix}-property-id`} maxLength={100} value={form.externalPropertyId} onChange={(event) => update("externalPropertyId", event.target.value)} className={partnerFieldClass} /></label>
      <label className="sm:col-span-2" htmlFor={`${fieldPrefix}-line1`}><span className="text-sm font-semibold text-slate-700">Street address</span><input id={`${fieldPrefix}-line1`} required autoComplete="address-line1" value={form.line1} onChange={(event) => update("line1", event.target.value)} className={partnerFieldClass} /></label>
      <label className="sm:col-span-2" htmlFor={`${fieldPrefix}-line2`}><span className="text-sm font-semibold text-slate-700">Suite, unit, building, or floor <span className="font-normal text-slate-500">(optional)</span></span><input id={`${fieldPrefix}-line2`} autoComplete="address-line2" value={form.line2} onChange={(event) => update("line2", event.target.value)} className={partnerFieldClass} /></label>
      <label htmlFor={`${fieldPrefix}-city`}><span className="text-sm font-semibold text-slate-700">City</span><input id={`${fieldPrefix}-city`} required autoComplete="address-level2" value={form.city} onChange={(event) => update("city", event.target.value)} className={partnerFieldClass} /></label>
      <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3"><label htmlFor={`${fieldPrefix}-state`}><span className="text-sm font-semibold text-slate-700">State</span><input id={`${fieldPrefix}-state`} required maxLength={2} autoComplete="address-level1" value={form.state} onChange={(event) => update("state", event.target.value.toUpperCase())} className={`${partnerFieldClass} uppercase`} /></label><label htmlFor={`${fieldPrefix}-zip`}><span className="text-sm font-semibold text-slate-700">ZIP code</span><input id={`${fieldPrefix}-zip`} required autoComplete="postal-code" inputMode="numeric" value={form.postalCode} onChange={(event) => update("postalCode", event.target.value)} className={partnerFieldClass} /></label></div>
      <label className="sm:col-span-2" htmlFor={`${fieldPrefix}-access`}><span className="text-sm font-semibold text-slate-700">General access details <span className="font-normal text-slate-500">(optional)</span></span><textarea id={`${fieldPrefix}-access`} rows={3} maxLength={2_000} value={form.accessDetails} onChange={(event) => update("accessDetails", event.target.value)} className={partnerFieldClass} /></label>
      <label htmlFor={`${fieldPrefix}-parking`}><span className="text-sm font-semibold text-slate-700">Parking instructions <span className="font-normal text-slate-500">(optional)</span></span><textarea id={`${fieldPrefix}-parking`} rows={3} maxLength={2_000} value={form.parking} onChange={(event) => update("parking", event.target.value)} className={partnerFieldClass} /></label>
      <label htmlFor={`${fieldPrefix}-loading`}><span className="text-sm font-semibold text-slate-700">Loading instructions <span className="font-normal text-slate-500">(optional)</span></span><textarea id={`${fieldPrefix}-loading`} rows={3} maxLength={2_000} value={form.loading} onChange={(event) => update("loading", event.target.value)} className={partnerFieldClass} /></label>
      <label className="sm:col-span-2" htmlFor={`${fieldPrefix}-secret`}><span className="text-sm font-semibold text-slate-700">Gate code or private access secret <span className="font-normal text-slate-500">(optional)</span></span><input id={`${fieldPrefix}-secret`} type="password" autoComplete="off" maxLength={2_000} value={form.accessSecret} onChange={(event) => update("accessSecret", event.target.value)} className={partnerFieldClass} placeholder={submitLabel === "Save changes" ? "Leave blank to keep the current secret" : "Stored encrypted and never shown back"} /><span className="mt-1 block text-xs text-slate-500">Use this only for sensitive codes. Put ordinary directions in general access details.</span></label>
      <label htmlFor={`${fieldPrefix}-contact-name`}><span className="text-sm font-semibold text-slate-700">Default on-site contact</span><input id={`${fieldPrefix}-contact-name`} autoComplete="name" maxLength={120} value={form.contactName} onChange={(event) => update("contactName", event.target.value)} className={partnerFieldClass} /></label>
      <div className="grid gap-3"><label htmlFor={`${fieldPrefix}-contact-phone`}><span className="text-sm font-semibold text-slate-700">Contact phone</span><input id={`${fieldPrefix}-contact-phone`} type="tel" inputMode="tel" autoComplete="tel" value={form.contactPhone} onChange={(event) => update("contactPhone", event.target.value)} className={partnerFieldClass} /></label><label htmlFor={`${fieldPrefix}-contact-email`}><span className="text-sm font-semibold text-slate-700">Contact email</span><input id={`${fieldPrefix}-contact-email`} type="email" inputMode="email" autoComplete="email" value={form.contactEmail} onChange={(event) => update("contactEmail", event.target.value)} className={partnerFieldClass} /></label></div>
      <button type="submit" disabled={pending} className={cn(partnerPrimaryButtonClass, "sm:col-span-2")}>{pending ? <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <CheckCircle2 className="h-4 w-4" aria-hidden="true" />}{pending ? "Saving…" : submitLabel}</button>
    </form>
  );
}

function ServiceAreaBadge({ status }: { status: string }) {
  const eligible = status === "eligible";
  return <span className={cn("shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset", eligible ? "bg-emerald-50 text-emerald-800 ring-emerald-200" : "bg-amber-50 text-amber-900 ring-amber-200")}>{eligible ? "Serviceable" : "Needs review"}</span>;
}
