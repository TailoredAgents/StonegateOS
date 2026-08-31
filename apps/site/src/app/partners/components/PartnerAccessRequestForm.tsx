"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowRight,
  Building2,
  CheckCircle2,
  LoaderCircle,
  ShieldCheck,
} from "lucide-react";
import { cn } from "@myst-os/ui";
import { createPortalOperationKey, partnerPortalFetch } from "../lib/portal-v2";
import {
  PartnerNotice,
  partnerFieldClass,
  partnerPrimaryButtonClass,
} from "./PartnerPortalUi";

const PERSONA_LABELS: Record<string, string> = {
  contractor: "Contractor",
  real_estate_agent: "Real-estate professional",
  property_manager: "Property manager",
  commercial_client: "Commercial client",
  other: "Other partner",
};

const NEEDS = [
  ["schedule_jobs", "Schedule pickups and jobs"],
  ["manage_locations", "Manage multiple locations"],
  ["photos_and_proof", "Upload photos and receive completion proof"],
  ["invoices_and_documents", "Access invoices and documents"],
  ["reporting", "Review account reporting"],
  ["recurring_service", "Coordinate recurring service"],
] as const;

function commaSeparated(value: string): string[] {
  return [...new Set(value.split(/[\n,]/u).map((item) => item.trim()).filter(Boolean))].slice(0, 20);
}

function formString(data: FormData, key: string): string {
  const value = data.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export function PartnerAccessRequestForm({
  termsVersion,
  privacyVersion,
  partnerTypes,
}: {
  termsVersion: string;
  privacyVersion: string;
  partnerTypes: string[];
}) {
  const [pending, setPending] = React.useState(false);
  const [complete, setComplete] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    const requestedNeeds = NEEDS.flatMap(([key]) => (data.get(key) === "on" ? [key] : []));
    setPending(true);
    setMessage(null);
    const result = await partnerPortalFetch<{
      ok: true;
      status: string;
      message: string;
    }>("access-applications", {
      method: "POST",
      headers: { "Idempotency-Key": createPortalOperationKey("access-application") },
      body: JSON.stringify({
        name: formString(data, "name"),
        email: formString(data, "email"),
        phone: formString(data, "phone") || null,
        companyName: formString(data, "companyName"),
        website: formString(data, "website") || null,
        partnerType: formString(data, "partnerType"),
        serviceAreas: commaSeparated(formString(data, "serviceAreas")),
        requestedNeeds,
        termsAccepted: data.get("termsAccepted") === "on",
        termsVersion,
        privacyAccepted: data.get("privacyAccepted") === "on",
        privacyVersion,
      }),
    }).catch(() => null);
    setPending(false);
    if (!result?.ok) {
      setMessage(
        result?.response.status === 429
          ? "Too many requests were submitted. Wait a few minutes before trying again."
          : result?.error.message ?? "Your request could not be sent. Try again or contact Stonegate.",
      );
      return;
    }
    setComplete(true);
    setMessage(result.data.message);
    document.getElementById("partner-access-success")?.focus();
  };

  if (complete) {
    return (
      <div id="partner-access-success" tabIndex={-1} className="rounded-3xl border border-emerald-200 bg-white p-6 text-center shadow-xl shadow-slate-200/60 focus:outline-none sm:p-10">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200"><CheckCircle2 className="h-7 w-7" aria-hidden="true" /></div>
        <h1 className="mt-5 text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">Check your email</h1>
        <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-slate-600 sm:text-base">{message ?? "Application received. We sent a secure sign-in link if the email can receive portal access."}</p>
        <div className="mt-6 flex flex-col justify-center gap-3 sm:flex-row"><Link href="/partners/login" className={partnerPrimaryButtonClass}>Go to sign in<ArrowRight className="h-4 w-4" aria-hidden="true" /></Link><Link href="/" className="inline-flex min-h-11 items-center justify-center rounded-xl px-4 text-sm font-semibold text-primary-800 underline-offset-4 hover:underline">Return to website</Link></div>
      </div>
    );
  }

  return (
    <div className="grid overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-xl shadow-slate-200/60 lg:grid-cols-[0.8fr_1.2fr]">
      <section className="relative overflow-hidden bg-primary-900 px-6 py-8 text-white sm:px-8 sm:py-10 lg:p-10">
        <div className="absolute -left-20 -top-20 h-64 w-64 rounded-full bg-accent-500/20 blur-3xl" aria-hidden="true" />
        <div className="relative"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent-200">Partner with Stonegate</p><h1 className="mt-3 text-3xl font-semibold tracking-tight">One service workspace for every property and job.</h1><p className="mt-4 text-sm leading-6 text-primary-100 sm:text-base">Tell us who you work with and what your team needs. We’ll create the right account path and send a secure sign-in link.</p><ul className="mt-8 space-y-4 text-sm text-primary-50">{["No password required to begin", "Account-scoped jobs, locations, and proof", "Role-aware access for operations and billing"].map((item) => <li key={item} className="flex items-start gap-3"><ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-accent-200" aria-hidden="true" />{item}</li>)}</ul></div>
      </section>
      <section className="p-6 sm:p-8 lg:p-10" aria-labelledby="partner-access-heading">
        <div className="flex items-center gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary-50 text-primary-700"><Building2 className="h-5 w-5" aria-hidden="true" /></div><div><p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary-700">Account request</p><h2 id="partner-access-heading" className="text-xl font-semibold text-slate-950">Request partner access</h2></div></div>
        <p className="mt-3 text-sm leading-6 text-slate-600">Required fields are marked. We use this information only to establish and support your partner account.</p>
        {message ? <PartnerNotice tone="error" className="mt-5">{message}</PartnerNotice> : null}
        <form onSubmit={(event) => void submit(event)} className="mt-6 space-y-6" data-partner-analytics="access_request">
          <fieldset><legend className="text-sm font-semibold text-slate-950">Your contact</legend><div className="mt-3 grid gap-4 sm:grid-cols-2"><label htmlFor="access-name"><span className="text-sm font-semibold text-slate-700">Full name</span><input id="access-name" name="name" required minLength={2} maxLength={120} autoComplete="name" className={partnerFieldClass} /></label><label htmlFor="access-email"><span className="text-sm font-semibold text-slate-700">Work email</span><input id="access-email" name="email" type="email" required maxLength={254} autoComplete="email" inputMode="email" className={partnerFieldClass} /></label><label htmlFor="access-phone"><span className="text-sm font-semibold text-slate-700">Mobile phone <span className="font-normal text-slate-500">(optional)</span></span><input id="access-phone" name="phone" type="tel" maxLength={32} autoComplete="tel" inputMode="tel" className={partnerFieldClass} /></label></div></fieldset>
          <fieldset className="border-t border-slate-200 pt-5"><legend className="text-sm font-semibold text-slate-950">Company</legend><div className="mt-3 grid gap-4 sm:grid-cols-2"><label htmlFor="access-company"><span className="text-sm font-semibold text-slate-700">Company name</span><input id="access-company" name="companyName" required minLength={2} maxLength={160} autoComplete="organization" className={partnerFieldClass} /></label><label htmlFor="access-website"><span className="text-sm font-semibold text-slate-700">Company website <span className="font-normal text-slate-500">(optional)</span></span><input id="access-website" name="website" type="url" maxLength={500} autoComplete="url" inputMode="url" placeholder="https://example.com" className={partnerFieldClass} /></label><label className="sm:col-span-2" htmlFor="access-persona"><span className="text-sm font-semibold text-slate-700">Partner type</span><select id="access-persona" name="partnerType" required defaultValue="" className={partnerFieldClass}><option value="" disabled>Choose the closest match</option>{partnerTypes.map((value) => <option key={value} value={value}>{PERSONA_LABELS[value] ?? value}</option>)}</select></label><label className="sm:col-span-2" htmlFor="access-areas"><span className="text-sm font-semibold text-slate-700">Primary service areas <span className="font-normal text-slate-500">(optional)</span></span><textarea id="access-areas" name="serviceAreas" rows={3} maxLength={2_000} className={partnerFieldClass} placeholder="Cities, ZIP codes, counties, or portfolio areas — separated by commas" /></label></div></fieldset>
          <fieldset className="border-t border-slate-200 pt-5"><legend className="text-sm font-semibold text-slate-950">What should the portal help with?</legend><div className="mt-3 grid gap-2 sm:grid-cols-2">{NEEDS.map(([key, label]) => <label key={key} className="flex min-h-11 items-start gap-3 rounded-xl border border-slate-200 px-3 py-3 text-sm text-slate-700"><input type="checkbox" name={key} className="mt-0.5 h-5 w-5 rounded border-slate-300 text-primary-700" />{label}</label>)}</div></fieldset>
          <fieldset className="border-t border-slate-200 pt-5"><legend className="sr-only">Agreements</legend><div className="space-y-3"><label className="flex items-start gap-3 text-sm leading-6 text-slate-700"><input type="checkbox" name="termsAccepted" required className="mt-0.5 h-5 w-5 shrink-0 rounded border-slate-300 text-primary-700" /><span>I agree to the <Link href="/terms" target="_blank" className="font-semibold text-primary-800 underline">Terms</Link> and <Link href="/service-agreement" target="_blank" className="font-semibold text-primary-800 underline">Service Agreement</Link>.</span></label><label className="flex items-start gap-3 text-sm leading-6 text-slate-700"><input type="checkbox" name="privacyAccepted" required className="mt-0.5 h-5 w-5 shrink-0 rounded border-slate-300 text-primary-700" /><span>I acknowledge the <Link href="/privacy" target="_blank" className="font-semibold text-primary-800 underline">Privacy Policy</Link> and consent to account-related contact.</span></label></div></fieldset>
          <button type="submit" disabled={pending} className={cn(partnerPrimaryButtonClass, "w-full")}>{pending ? <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <ArrowRight className="h-4 w-4" aria-hidden="true" />}{pending ? "Sending request…" : "Request partner access"}</button>
        </form>
      </section>
    </div>
  );
}
