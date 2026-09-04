import type { Route } from "next";
import Link from "next/link";
import {
  AlertTriangle,
  CalendarCheck2,
  FileCheck2,
  LockKeyhole,
  Mail,
  MessageSquareText,
  Phone,
} from "lucide-react";
import type { PublicCompanyProfile } from "@/lib/company";
import { PartnerPortalPreview } from "./PartnerPortalPreview";

const primaryButtonClass =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-primary-900 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 motion-reduce:transition-none";

const secondaryButtonClass =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-accent-200 hover:bg-primary-50 hover:text-primary-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 motion-reduce:transition-none";

const PERSONAS = [
  "Contractors",
  "Real estate teams",
  "Property managers",
  "Commercial clients",
] as const;

const OUTCOMES = [
  {
    icon: CalendarCheck2,
    title: "Request service quickly",
    body: "Choose a saved site, add photos and instructions, and send the request.",
  },
  {
    icon: MessageSquareText,
    title: "Pick the right time",
    body: "See eligible arrival windows and choose the one that works best.",
  },
  {
    icon: FileCheck2,
    title: "Stay updated",
    body: "Find job progress, messages, proof, and billing in one place.",
  },
] as const;

const JOB_STEPS = [
  [
    "Request service",
    "Choose a saved location and add the details, photos, and instructions.",
  ],
  ["Choose a window", "Select an eligible two-hour arrival window."],
  ["Stay updated", "See confirmation, status, changes, and messages."],
  [
    "Get the records",
    "Review proof, completion details, and billing documents.",
  ],
] as const;

const ACCESS_STEPS = [
  [
    "Verify your email",
    "Confirm your work email and tell us about your company.",
  ],
  [
    "Get approved",
    "Stonegate reviews new companies. Your company administrator or Stonegate reviews requests to join an existing workspace.",
  ],
  ["Activate your access", "Create a password and sign in to your workspace."],
] as const;

const FAQS = [
  [
    "Can I use the portal after verifying my email?",
    "No. Verification opens only the application. Access begins after approval and secure activation.",
  ],
  [
    "What if my job needs review?",
    "Stonegate reviews the saved request and preferred windows without promising a slot.",
  ],
  [
    "Can I manage more than one company or location?",
    "Yes. Approved accounts stay separate, while permitted locations remain organized inside each account.",
  ],
] as const;

function LandingLink({
  href,
  label,
  primary = false,
  analyticsKey,
}: {
  href: Route;
  label: string;
  primary?: boolean;
  analyticsKey: string;
}) {
  return (
    <Link
      href={href}
      className={primary ? primaryButtonClass : secondaryButtonClass}
      data-partner-analytics={analyticsKey}
    >
      {label}
    </Link>
  );
}

export function PartnerLandingContent({
  company,
  sessionUnavailable = false,
}: {
  company: PublicCompanyProfile;
  sessionUnavailable?: boolean;
}) {
  return (
    <div className="w-full space-y-14 pb-4 sm:space-y-20 sm:pb-8">
      {sessionUnavailable ? (
        <div
          className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950"
          role="status"
          aria-live="polite"
        >
          <AlertTriangle
            className="mt-0.5 h-5 w-5 shrink-0"
            aria-hidden="true"
          />
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p>
              We couldn’t verify your session. No account or job information was
              changed.
            </p>
            <Link
              href="/partners"
              className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-xl border border-amber-300 bg-white px-4 py-2 text-sm font-semibold text-amber-950 shadow-sm hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2"
              data-partner-analytics="unavailable_retry"
            >
              Try again
            </Link>
          </div>
        </div>
      ) : null}

      <section
        aria-labelledby="partner-landing-title"
        className="grid items-center gap-10 py-2 lg:grid-cols-[minmax(0,1.02fr)_minmax(0,0.98fr)] lg:py-8"
      >
        <div>
          <p className="text-sm font-semibold uppercase tracking-widest text-primary-900">
            Stonegate Partner Portal
          </p>
          <h1
            id="partner-landing-title"
            className="mt-4 max-w-3xl text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl lg:text-6xl"
          >
            Quick and easy service for our partners.
          </h1>
          <p className="mt-6 max-w-2xl text-base leading-7 text-slate-600 sm:text-lg">
            Request Stonegate junk removal without the usual back-and-forth.
            Reuse saved locations, add photos and instructions, choose an
            eligible arrival window, and find updates, proof, and billing in one
            place.
          </p>
          <nav
            className="mt-7 flex flex-col gap-3 sm:flex-row"
            aria-label="Partner access options"
          >
            <LandingLink
              href="/partners/login"
              label="Sign in"
              primary
              analyticsKey="landing_sign_in_hero"
            />
            <LandingLink
              href="/partners/request-access"
              label="Request access"
              analyticsKey="landing_request_access_hero"
            />
          </nav>
          <ul
            className="mt-7 flex flex-wrap gap-x-5 gap-y-2 text-sm text-slate-600"
            aria-label="Portal service highlights"
          >
            {[
              company.serviceAreaSummary,
              "Licensed and insured",
              "Two-hour windows for eligible work",
            ].map((item) => (
              <li key={item} className="flex items-center gap-2">
                <span
                  className="h-1.5 w-1.5 rounded-full bg-accent-500"
                  aria-hidden="true"
                />
                {item}
              </li>
            ))}
          </ul>
        </div>

        <PartnerPortalPreview />
      </section>

      <section aria-labelledby="partner-outcomes-heading">
        <ul
          className="flex flex-wrap gap-2"
          aria-label="Teams served by the Partner Portal"
        >
          {PERSONAS.map((persona) => (
            <li
              key={persona}
              className="inline-flex min-h-9 items-center rounded-full border border-accent-200 bg-primary-50 px-3 py-1.5 text-sm font-semibold text-primary-900"
            >
              {persona}
            </li>
          ))}
        </ul>
        <div className="mt-6 max-w-3xl">
          <h2
            id="partner-outcomes-heading"
            className="text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl"
          >
            Less back-and-forth from request to completion.
          </h2>
        </div>
        <div className="mt-9 grid gap-8 md:grid-cols-3 md:gap-0">
          {OUTCOMES.map(({ icon: Icon, title, body }, index) => (
            <article
              key={title}
              className={
                index === 0
                  ? "md:pr-7"
                  : "border-t border-slate-200 pt-8 md:border-l md:border-t-0 md:px-7 md:pt-0"
              }
            >
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary-50 text-primary-900 ring-1 ring-accent-200">
                <Icon className="h-5 w-5" aria-hidden="true" />
              </div>
              <h3 className="mt-5 text-lg font-semibold text-slate-950">
                {title}
              </h3>
              <p className="mt-2 text-sm leading-6 text-slate-600">{body}</p>
            </article>
          ))}
        </div>
      </section>

      <section
        aria-labelledby="partner-job-record-heading"
        className="rounded-3xl bg-sand-100 p-6 sm:p-8 lg:p-10"
      >
        <p className="text-sm font-semibold uppercase tracking-widest text-primary-900">
          One simple process
        </p>
        <h2
          id="partner-job-record-heading"
          className="mt-3 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl"
        >
          Tell us what you need. We keep the rest organized.
        </h2>
        <ol className="mt-9 grid gap-6 md:grid-cols-4 md:gap-0">
          {JOB_STEPS.map(([title, body], index) => (
            <li
              key={title}
              className="relative border-l border-slate-200 pb-2 pl-6 last:pb-0 md:border-l-0 md:border-t md:px-4 md:pb-0 md:pt-7 md:first:pl-0 md:last:pr-0"
            >
              <span className="absolute -left-4 -top-1 flex h-8 w-8 items-center justify-center rounded-full bg-primary-900 text-sm font-semibold text-white ring-4 ring-white md:-top-4 md:left-4 md:first:left-0">
                <span className="sr-only">Step </span>
                {index + 1}
              </span>
              <h3 className="text-lg font-semibold text-slate-950">{title}</h3>
              <p className="mt-2 text-sm leading-6 text-slate-600">{body}</p>
            </li>
          ))}
        </ol>
        <p className="mt-8 rounded-2xl border border-accent-200 bg-white p-4 text-sm leading-6 text-slate-700">
          If a job needs a closer review for scope, service area, pricing, or
          availability, we save your request and preferred windows. Stonegate
          confirms the details before promising a time.
        </p>
      </section>

      <section
        aria-labelledby="partner-access-heading"
        className="grid gap-10 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-14"
      >
        <div>
          <h2
            id="partner-access-heading"
            className="text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl"
          >
            Easy to get started. Secure for your team.
          </h2>
          <ol className="mt-7 space-y-6">
            {ACCESS_STEPS.map(([title, body], index) => (
              <li key={title} className="grid grid-cols-[2.5rem_1fr] gap-4">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-primary-900 font-semibold text-white">
                  <span className="sr-only">Step </span>
                  {index + 1}
                </span>
                <div>
                  <h3 className="font-semibold text-slate-950">{title}</h3>
                  <p className="mt-1 text-sm leading-6 text-slate-600">
                    {body}
                  </p>
                </div>
              </li>
            ))}
          </ol>
          <div className="mt-7 flex items-start gap-3 rounded-2xl bg-primary-50 p-4 text-sm leading-6 text-primary-900 ring-1 ring-accent-200">
            <LockKeyhole
              className="mt-0.5 h-5 w-5 shrink-0"
              aria-hidden="true"
            />
            <p>
              Each person sees only the approved companies, locations, and tools
              assigned to their role.
            </p>
          </div>
        </div>

        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">
            Common questions
          </h2>
          <div className="mt-6 divide-y divide-slate-200 border-y border-slate-200">
            {FAQS.map(([question, answer]) => (
              <details key={question} className="group py-3">
                <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 rounded-lg font-semibold text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 [&::-webkit-details-marker]:hidden">
                  {question}
                  <span
                    className="text-xl font-normal text-slate-500 transition-transform group-open:rotate-45 motion-reduce:transition-none"
                    aria-hidden="true"
                  >
                    +
                  </span>
                </summary>
                <p className="pb-3 pr-8 text-sm leading-6 text-slate-600">
                  {answer}
                </p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section
        aria-labelledby="partner-final-cta"
        className="relative overflow-hidden rounded-3xl bg-primary-900 p-6 text-white shadow-float sm:p-8 lg:p-10"
      >
        <div
          className="absolute -right-20 -top-24 h-64 w-64 rounded-full bg-accent-500/25 blur-3xl"
          aria-hidden="true"
        />
        <div className="relative grid gap-8 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
          <div>
            <h2
              id="partner-final-cta"
              className="text-3xl font-semibold tracking-tight text-white sm:text-4xl"
            >
              Make your next Stonegate service request easier.
            </h2>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-200 sm:text-base">
              Sign in to request service, or verify your work email to request
              partner access.
            </p>
          </div>
          <nav
            className="flex flex-col gap-3 sm:flex-row lg:flex-col"
            aria-label="Partner portal next steps"
          >
            <Link
              href="/partners/login"
              className="inline-flex min-h-11 items-center justify-center rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-primary-900 shadow-sm transition hover:bg-sand-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-primary-900 motion-reduce:transition-none"
              data-partner-analytics="landing_sign_in_footer"
            >
              Sign in
            </Link>
            <Link
              href="/partners/request-access"
              className="inline-flex min-h-11 items-center justify-center rounded-xl border border-white/50 bg-transparent px-4 py-2.5 text-sm font-semibold text-white transition hover:border-white hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-primary-900 motion-reduce:transition-none"
              data-partner-analytics="landing_request_access_footer"
            >
              Request access
            </Link>
          </nav>
        </div>
        <div className="relative mt-8 grid gap-3 border-t border-white/20 pt-6 text-sm text-slate-200 sm:grid-cols-2 lg:grid-cols-4">
          <a
            href={`tel:${company.phoneE164}`}
            className="inline-flex min-h-11 items-center gap-2 rounded-lg hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
            data-partner-analytics="landing_call_support"
          >
            <Phone className="h-4 w-4 shrink-0" aria-hidden="true" />
            {company.phoneDisplay}
          </a>
          <a
            href={`mailto:${company.email}`}
            className="inline-flex min-h-11 min-w-0 items-center gap-2 rounded-lg hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
            data-partner-analytics="landing_email_support"
          >
            <Mail className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 break-all">{company.email}</span>
          </a>
          <p className="flex min-h-11 items-center">
            {company.serviceAreaSummary}
          </p>
          <p className="flex min-h-11 items-center">{company.hoursSummary}</p>
        </div>
      </section>
    </div>
  );
}
