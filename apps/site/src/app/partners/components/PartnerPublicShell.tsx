import Link from "next/link";
import { Phone } from "lucide-react";
import type { PublicCompanyProfile } from "@/lib/company";
import { PartnerPublicHeaderAction } from "./PartnerPublicHeaderAction";

export function PartnerPublicShell({
  company,
  children,
  showSignIn = true,
}: {
  company: PublicCompanyProfile;
  children: React.ReactNode;
  showSignIn?: boolean;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-white text-slate-950">
      <a
        href="#partner-public-main"
        className="sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:not-sr-only focus:rounded-lg focus:bg-primary-900 focus:px-4 focus:py-3 focus:font-semibold focus:text-white focus:shadow-xl"
      >
        Skip to main content
      </a>
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex min-h-16 w-full max-w-6xl items-center justify-between gap-4 px-4 py-2 sm:px-6 lg:px-8">
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <Link
              href="/"
              className="flex min-w-0 items-center gap-2 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2"
              aria-label={`${company.name} home`}
            >
              {/* This source is a dedicated 96 px WebP; explicit dimensions reserve layout space without a client image wrapper. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/images/brand/stonegate-partner-mark-96.webp"
                alt=""
                width="48"
                height="48"
                decoding="async"
                className="h-12 w-12 shrink-0 object-contain"
              />
              <span className="hidden truncate text-sm font-semibold text-slate-950 md:block">
                {company.name}
              </span>
            </Link>
            <span
              className="h-7 w-px shrink-0 bg-slate-200"
              aria-hidden="true"
            />
            <Link
              href="/partners"
              className="inline-flex min-h-11 items-center whitespace-nowrap rounded-lg px-1 text-xs font-semibold text-primary-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 sm:text-sm"
            >
              Partner Portal
            </Link>
          </div>
          <nav
            className="flex items-center gap-2"
            aria-label="Partner account actions"
          >
            <a
              href={`tel:${company.phoneE164}`}
              className="hidden min-h-11 items-center gap-2 rounded-xl px-3 text-sm font-semibold text-slate-600 hover:bg-slate-100 hover:text-primary-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 sm:inline-flex"
              data-partner-analytics="landing_call_support"
            >
              <Phone className="h-4 w-4" aria-hidden="true" />
              Call {company.phoneDisplay}
            </a>
            <PartnerPublicHeaderAction enabled={showSignIn} />
          </nav>
        </div>
      </header>
      <main
        id="partner-public-main"
        tabIndex={-1}
        className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 items-center px-4 py-8 focus:outline-none sm:px-6 sm:py-12 lg:px-8"
      >
        <div className="w-full">{children}</div>
      </main>
      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-6 text-xs text-slate-600 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
          <p>
            © {new Date().getFullYear()} {company.name}. Licensed and insured.
          </p>
          <nav aria-label="Legal" className="flex flex-wrap gap-x-4 gap-y-2">
            <a
              className="inline-flex min-h-11 min-w-11 items-center justify-center px-1 font-semibold text-primary-900 underline-offset-4 hover:underline sm:hidden"
              href={`tel:${company.phoneE164}`}
              data-partner-analytics="landing_call_support"
            >
              Call
            </a>
            <Link
              className="inline-flex min-h-11 min-w-11 items-center justify-center px-1 underline-offset-4 hover:underline"
              href="/privacy"
            >
              Privacy
            </Link>
            <Link
              className="inline-flex min-h-11 min-w-11 items-center justify-center px-1 underline-offset-4 hover:underline"
              href="/terms"
            >
              Terms
            </Link>
            <Link
              className="inline-flex min-h-11 min-w-11 items-center justify-center px-1 underline-offset-4 hover:underline"
              href="/service-agreement"
            >
              Service agreement
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
