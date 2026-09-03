import type { Metadata, Route } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  ArrowRight,
  Building2,
  CalendarCheck2,
  Camera,
  CheckCircle2,
  ClipboardCheck,
  FileText,
  KeyRound,
  LockKeyhole,
  Mail,
  MapPin,
  MessageSquareText,
  Phone,
  ShieldCheck,
  UsersRound,
} from "lucide-react";
import { absoluteUrl } from "@/lib/metadata";
import {
  getPublicCompanyProfile,
  type PublicCompanyProfile,
} from "@/lib/company";
import { PARTNER_SESSION_COOKIE } from "@/lib/partner-session";
import { PARTNER_APPLICATION_SESSION_COOKIE } from "@/lib/partner-application-session";
import { getPartnerPortalContext } from "@/app/partners/lib/portal-context";
import {
  partnerLandingDestination,
  type PartnerLandingPortalState,
} from "@/app/partners/lib/public-route-policy";
import {
  PartnerNotice,
  partnerPrimaryButtonClass,
  partnerSecondaryButtonClass,
} from "@/app/partners/components/PartnerPortalUi";

const title = "Partner Portal for Property and Commercial Teams";
const description =
  "Schedule Stonegate service, manage locations, share job details, review completion proof, and keep billing organized in one secure partner workspace.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: absoluteUrl("/partners") },
  robots: { index: true, follow: true },
  openGraph: {
    title,
    description,
    type: "website",
    url: absoluteUrl("/partners"),
  },
  twitter: { card: "summary_large_image", title, description },
};

const CAPABILITIES = [
  {
    icon: CalendarCheck2,
    title: "Schedule with confidence",
    body: "Choose real service windows, reuse saved locations, and keep every request tied to the right site and project.",
  },
  {
    icon: Camera,
    title: "Photos and completion proof",
    body: "Add scope photos before a job and receive organized before-and-after proof when the work is complete.",
  },
  {
    icon: MessageSquareText,
    title: "One job conversation",
    body: "Keep access notes, changes, questions, and updates with the job instead of searching across disconnected messages.",
  },
  {
    icon: FileText,
    title: "Billing and documents",
    body: "Track quotes, approvals, invoices, receipts, purchase orders, cost centers, and downloadable records.",
  },
  {
    icon: MapPin,
    title: "Every service location",
    body: "Organize addresses, contacts, parking, loading, and private access instructions across your portfolio.",
  },
  {
    icon: UsersRound,
    title: "Access for the whole team",
    body: "Give Administrators, Operations, Billing/Approvers, and Viewers only the account and location access their work requires.",
  },
] as const;

const PERSONAS = [
  [
    "Contractors",
    "Coordinate pickups and site service without interrupting the crew.",
  ],
  [
    "Real-estate teams",
    "Prepare listings, closings, cleanouts, and client properties with documented results.",
  ],
  [
    "Property managers",
    "Keep recurring and one-time work organized across every managed location.",
  ],
  [
    "Commercial clients",
    "Connect service requests to approvals, project references, billing, and reporting.",
  ],
] as const;

function PartnerLanding({
  sessionUnavailable,
  company,
}: {
  sessionUnavailable: boolean;
  company: PublicCompanyProfile;
}) {
  return (
    <div className="w-full space-y-16 pb-8 sm:space-y-20">
      {sessionUnavailable ? (
        <PartnerNotice tone="warning">
          We couldn’t verify an existing portal session. You can still learn
          about the portal or sign in again; no account information was changed.
        </PartnerNotice>
      ) : null}

      <section className="grid items-center gap-10 py-4 lg:grid-cols-[1.08fr_0.92fr] lg:py-10">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-primary-700">
            Stonegate Partner Portal
          </p>
          <h1 className="mt-4 max-w-3xl text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl lg:text-6xl">
            Service operations that keep pace with your properties and projects.
          </h1>
          <p className="mt-6 max-w-2xl text-base leading-7 text-slate-600 sm:text-lg">
            Schedule jobs, share exact site details, upload photos, request
            proof, communicate with Stonegate, and keep commercial records
            together in one secure workspace.
          </p>
          <p className="mt-8 text-sm font-medium text-slate-700">
            Already approved? Sign in. New company or teammate? Request access.
          </p>
          <div
            className="mt-4 flex flex-col gap-3 sm:flex-row"
            aria-label="Partner access options"
          >
            <Link href="/partners/login" className={partnerPrimaryButtonClass}>
              <KeyRound className="h-4 w-4" aria-hidden="true" />
              Sign in
            </Link>
            <Link
              href="/partners/request-access"
              className={partnerSecondaryButtonClass}
            >
              Request partner access
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </div>
          <ul
            className="mt-7 flex flex-wrap gap-x-6 gap-y-3 text-sm text-slate-600"
            aria-label="Portal trust highlights"
          >
            {[
              "Verified-email onboarding",
              "Account-scoped access",
              "Licensed and insured service",
            ].map((item) => (
              <li key={item} className="flex items-center gap-2">
                <CheckCircle2
                  className="h-4 w-4 text-emerald-700"
                  aria-hidden="true"
                />
                {item}
              </li>
            ))}
          </ul>
        </div>

        <div className="relative overflow-hidden rounded-3xl bg-primary-950 p-6 text-white shadow-2xl shadow-primary-950/20 sm:p-8">
          <div
            className="absolute -right-16 -top-20 h-64 w-64 rounded-full bg-accent-400/20 blur-3xl"
            aria-hidden="true"
          />
          <div className="relative">
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/10 ring-1 ring-white/20">
                <ClipboardCheck
                  className="h-6 w-6 text-accent-200"
                  aria-hidden="true"
                />
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary-200">
                  A complete job record
                </p>
                <h2 className="mt-1 text-xl font-semibold">
                  From request to proof
                </h2>
              </div>
            </div>
            <ol className="mt-8 space-y-5">
              {[
                [
                  "1",
                  "Tell us what the site needs",
                  "Choose a saved location, add scope, access details, contacts, references, and photos.",
                ],
                [
                  "2",
                  "Choose an available window",
                  "See clear arrival windows or submit preferred times when operational review is needed.",
                ],
                [
                  "3",
                  "Follow the work through completion",
                  "Track status, messages, proof, documents, invoices, and payment in the same record.",
                ],
              ].map(([step, heading, body]) => (
                <li key={step} className="grid grid-cols-[2.25rem_1fr] gap-3">
                  <span
                    className="flex h-9 w-9 items-center justify-center rounded-full bg-accent-400 font-semibold text-primary-950"
                    aria-hidden="true"
                  >
                    {step}
                  </span>
                  <div>
                    <h3 className="font-semibold">{heading}</h3>
                    <p className="mt-1 text-sm leading-6 text-primary-100">
                      {body}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </section>

      <section aria-labelledby="partner-personas-heading">
        <div className="max-w-3xl">
          <p className="text-sm font-semibold uppercase tracking-[0.16em] text-primary-700">
            Built around real partner work
          </p>
          <h2
            id="partner-personas-heading"
            className="mt-3 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl"
          >
            One workspace, adapted to how your team operates.
          </h2>
        </div>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {PERSONAS.map(([persona, body]) => (
            <article
              key={persona}
              className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
            >
              <Building2
                className="h-5 w-5 text-primary-700"
                aria-hidden="true"
              />
              <h3 className="mt-4 font-semibold text-slate-950">{persona}</h3>
              <p className="mt-2 text-sm leading-6 text-slate-600">{body}</p>
            </article>
          ))}
        </div>
      </section>

      <section aria-labelledby="partner-capabilities-heading">
        <div className="max-w-3xl">
          <p className="text-sm font-semibold uppercase tracking-[0.16em] text-primary-700">
            Everything in context
          </p>
          <h2
            id="partner-capabilities-heading"
            className="mt-3 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl"
          >
            The details your job needs—before, during, and after service.
          </h2>
        </div>
        <div className="mt-8 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {CAPABILITIES.map(({ icon: Icon, title: capabilityTitle, body }) => (
            <article
              key={capabilityTitle}
              className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
            >
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary-50 text-primary-700 ring-1 ring-primary-100">
                <Icon className="h-5 w-5" aria-hidden="true" />
              </div>
              <h3 className="mt-5 text-lg font-semibold text-slate-950">
                {capabilityTitle}
              </h3>
              <p className="mt-2 text-sm leading-6 text-slate-600">{body}</p>
            </article>
          ))}
        </div>
      </section>

      <section aria-labelledby="partner-access-process-heading">
        <div className="max-w-3xl">
          <p className="text-sm font-semibold uppercase tracking-[0.16em] text-primary-700">
            A deliberate access process
          </p>
          <h2
            id="partner-access-process-heading"
            className="mt-3 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl"
          >
            Verify, get approved, then operate securely.
          </h2>
          <p className="mt-3 text-sm leading-6 text-slate-600 sm:text-base">
            Applying never creates a company workspace or grants authority on
            its own. Stonegate confirms the correct company and access before
            activation.
          </p>
        </div>
        <ol className="mt-8 grid gap-4 md:grid-cols-3">
          {[
            [
              "1",
              "Verify and apply",
              "Open a one-use email link and complete a resumable application with your company and service needs.",
            ],
            [
              "2",
              "Company review",
              "Stonegate reviews new companies. Verified existing-company join requests may also be reviewed by a company Administrator.",
            ],
            [
              "3",
              "Activate and work",
              "Create your password, enroll an authenticator when your role requires it, and enter only the approved workspace.",
            ],
          ].map(([step, heading, body]) => (
            <li
              key={step}
              className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
            >
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-primary-800 font-semibold text-white">
                <span className="sr-only">Step </span>
                {step}
              </span>
              <h3 className="mt-5 text-lg font-semibold text-slate-950">
                {heading}
              </h3>
              <p className="mt-2 text-sm leading-6 text-slate-600">{body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section
        aria-labelledby="partner-trust-heading"
        className="grid gap-5 lg:grid-cols-2"
      >
        <h2 id="partner-trust-heading" className="sr-only">
          Portal security and service planning
        </h2>
        <article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary-50 text-primary-700 ring-1 ring-primary-100">
            <LockKeyhole className="h-5 w-5" aria-hidden="true" />
          </div>
          <h3 className="mt-5 text-xl font-semibold text-slate-950">
            Security that follows the account
          </h3>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Routine access uses email and password. Privileged roles add
            authenticator verification, and every membership is limited to its
            approved company and optional location or cost-center scope.
          </p>
        </article>
        <article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary-50 text-primary-700 ring-1 ring-primary-100">
            <CalendarCheck2 className="h-5 w-5" aria-hidden="true" />
          </div>
          <h3 className="mt-5 text-xl font-semibold text-slate-950">
            Honest scheduling promises
          </h3>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Eligible work receives clear two-hour arrival windows. Work that
            needs pricing, hazard, territory, capacity, or calendar review is
            preserved as a review request instead of showing an unverified
            confirmation.
          </p>
          <p className="mt-3 text-sm font-medium text-slate-700">
            {company.serviceAreaSummary}
          </p>
        </article>
      </section>

      <section aria-labelledby="partner-faq-heading">
        <div className="max-w-3xl">
          <p className="text-sm font-semibold uppercase tracking-[0.16em] text-primary-700">
            Common questions
          </p>
          <h2
            id="partner-faq-heading"
            className="mt-3 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl"
          >
            What to expect before requesting access.
          </h2>
        </div>
        <div className="mt-7 divide-y divide-slate-200 rounded-2xl border border-slate-200 bg-white px-5 shadow-sm sm:px-6">
          {[
            [
              "Does verification grant portal access?",
              "No. Email verification opens only the application. A partner identity, account, and membership are created only after the correct company path is approved.",
            ],
            [
              "Can one person work with more than one company account?",
              "Yes. An approved identity can hold memberships in multiple accounts and switch between them without mixing account data.",
            ],
            [
              "What happens when a job cannot be confirmed instantly?",
              "The portal keeps the scope, photos, site details, and preferred windows as a clearly labeled review request. It does not promise an unverified slot.",
            ],
            [
              "Can partners request before-and-after proof?",
              "Yes. Proof requirements can default at the account level and be adjusted per job by an authorized user. Completed evidence stays attached to the job record.",
            ],
          ].map(([question, answer]) => (
            <details key={question} className="group py-4">
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 font-semibold text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 [&::-webkit-details-marker]:hidden">
                {question}
                <span
                  className="text-xl font-normal text-slate-400 transition group-open:rotate-45 motion-reduce:transition-none"
                  aria-hidden="true"
                >
                  +
                </span>
              </summary>
              <p className="pb-2 pr-8 text-sm leading-6 text-slate-600">
                {answer}
              </p>
            </details>
          ))}
        </div>
      </section>

      <section
        aria-labelledby="partner-support-heading"
        className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8"
      >
        <h2
          id="partner-support-heading"
          className="text-2xl font-semibold tracking-tight text-slate-950"
        >
          Questions before you apply?
        </h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
          Contact {company.name} for company-match, service-area, or access
          questions. We do not publish an unverified response-time promise.
        </p>
        <div className="mt-5 flex flex-col gap-3 sm:flex-row">
          <a
            href={`tel:${company.phoneE164}`}
            className={partnerSecondaryButtonClass}
          >
            <Phone className="h-4 w-4" aria-hidden="true" />
            Call {company.phoneDisplay}
          </a>
          <a
            href={`mailto:${company.email}`}
            className={partnerSecondaryButtonClass}
          >
            <Mail className="h-4 w-4" aria-hidden="true" />
            Email partner support
          </a>
        </div>
      </section>

      <section
        className="grid gap-6 rounded-3xl border border-primary-100 bg-primary-50 p-6 sm:p-8 lg:grid-cols-[1fr_auto] lg:items-center lg:p-10"
        aria-labelledby="partner-access-cta"
      >
        <div>
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-white text-primary-700 ring-1 ring-primary-100">
            <ShieldCheck className="h-5 w-5" aria-hidden="true" />
          </div>
          <h2
            id="partner-access-cta"
            className="mt-5 text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl"
          >
            Ready to bring your service work into one place?
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600 sm:text-base">
            Verify your work email, tell us about your company, and Stonegate
            will review the right account path before any workspace access is
            created.
          </p>
        </div>
        <Link
          href="/partners/request-access"
          className={partnerPrimaryButtonClass}
        >
          Start access request
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </Link>
      </section>
    </div>
  );
}

export default async function PartnerLandingPage() {
  const company = getPublicCompanyProfile();
  const jar = await cookies();
  const hasPartnerSession = Boolean(jar.get(PARTNER_SESSION_COOKIE)?.value);
  const hasApplicationSession = Boolean(
    jar.get(PARTNER_APPLICATION_SESSION_COOKIE)?.value,
  );

  let sessionUnavailable = false;
  let portalState: PartnerLandingPortalState = "absent";
  if (hasPartnerSession) {
    const context = await getPartnerPortalContext();
    portalState = context.status;
    sessionUnavailable = context.status === "unavailable";
  }
  const destination = partnerLandingDestination({
    applicationSessionPresent: hasApplicationSession,
    portalState,
  });
  if (destination) {
    redirect(destination as Route);
  }

  return (
    <PartnerLanding sessionUnavailable={sessionUnavailable} company={company} />
  );
}
