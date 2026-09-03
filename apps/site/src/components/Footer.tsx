import Link from "next/link";
import { Button, Cta } from "@myst-os/ui";
import { getPublicCompanyProfile } from "@/lib/company";

export function Footer() {
  const company = getPublicCompanyProfile();
  const hqLabel = company.hqCity?.trim().length
    ? `${company.hqCity} HQ`
    : "Local HQ";
  const locationLine = company.serviceAreaSummary?.trim().length
    ? company.serviceAreaSummary
    : "";

  return (
    <footer className="mt-24 border-t border-neutral-300/60 bg-white">
      <div className="mx-auto max-w-6xl px-6 py-16 md:px-10">
        <Cta
          eyebrow="Book Today"
          title="Ready to reclaim your space?"
          description="Schedule an on-site estimate or call the crew now. We are standing by with premium service windows across North Metro Atlanta."
          primaryAction={
            <Button asChild>
              <Link href="/estimate">Schedule Estimate</Link>
            </Button>
          }
          secondaryAction={
            <Button variant="secondary" asChild>
              <a href={`tel:${company.phoneE164}`} data-cta="footer-call">
                Call {company.phoneDisplay}
              </a>
            </Button>
          }
        />
        <div className="mt-12 grid gap-6 text-sm text-neutral-500 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <p className="font-semibold text-neutral-800">{company.name}</p>
            <p className="mt-2">
              {hqLabel}
              {locationLine ? ` — ${locationLine}` : ""}
            </p>
            <nav aria-label="Company" className="mt-3">
              <ul>
                <li>
                  <Link
                    href="/about"
                    className="inline-flex min-h-11 items-center text-neutral-700 hover:text-primary-700"
                  >
                    About Stonegate
                  </Link>
                </li>
                <li>
                  <Link
                    href="/blog"
                    className="inline-flex min-h-11 items-center text-neutral-700 hover:text-primary-700"
                  >
                    Blog
                  </Link>
                </li>
              </ul>
            </nav>
          </div>
          <nav aria-label="Contact Stonegate">
            <p className="font-semibold text-neutral-800">Contact</p>
            <ul className="mt-2">
              <li>
                <a
                  href={`tel:${company.phoneE164}`}
                  className="inline-flex min-h-11 items-center text-neutral-700 hover:text-primary-700"
                  data-cta="footer-call"
                >
                  {company.phoneDisplay}
                </a>
              </li>
              <li>
                <a
                  href={`sms:${company.phoneE164}`}
                  className="inline-flex min-h-11 items-center text-neutral-700 hover:text-primary-700"
                >
                  Text the crew
                </a>
              </li>
              <li>
                <a
                  href={`mailto:${company.email}`}
                  className="inline-flex min-h-11 items-center break-all text-neutral-700 hover:text-primary-700"
                >
                  {company.email}
                </a>
              </li>
              <li>
                <Link
                  href="/contact"
                  className="inline-flex min-h-11 items-center text-neutral-700 hover:text-primary-700"
                >
                  Contact form
                </Link>
              </li>
            </ul>
          </nav>
          <div>
            <p className="font-semibold text-neutral-800">Hours</p>
            <p className="mt-2">{company.hoursSummary}</p>
          </div>
          <nav aria-label="Partner resources">
            <p className="font-semibold text-neutral-800">For partners</p>
            <ul className="mt-2">
              <li>
                <Link
                  href="/partners"
                  className="inline-flex min-h-11 items-center text-neutral-700 hover:text-primary-700"
                >
                  For Partners
                </Link>
              </li>
              <li>
                <Link
                  href="/partners/login"
                  className="inline-flex min-h-11 items-center text-neutral-700 hover:text-primary-700"
                >
                  Partner sign in
                </Link>
              </li>
              <li>
                <Link
                  href="/partners/request-access"
                  className="inline-flex min-h-11 items-center text-neutral-700 hover:text-primary-700"
                >
                  Request partner access
                </Link>
              </li>
              <li>
                <Link
                  href="/contractors"
                  className="inline-flex min-h-11 items-center text-neutral-700 hover:text-primary-700"
                >
                  Contractor services
                </Link>
              </li>
            </ul>
          </nav>
        </div>
        <div className="mt-10 flex flex-col gap-2 text-xs text-neutral-600 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-5">
          <p>
            Copyright {new Date().getFullYear()} {company.name}. Licensed &
            insured. All rights reserved.
          </p>
          <nav
            aria-label="Legal"
            className="flex flex-wrap gap-x-5 text-neutral-700"
          >
            <Link
              href="/privacy"
              className="inline-flex min-h-11 items-center hover:text-primary-700"
            >
              Privacy Policy
            </Link>
            <Link
              href="/terms"
              className="inline-flex min-h-11 items-center hover:text-primary-700"
            >
              Terms
            </Link>
            <Link
              href="/service-agreement"
              className="inline-flex min-h-11 items-center hover:text-primary-700"
            >
              Service Agreement
            </Link>
          </nav>
        </div>
      </div>
    </footer>
  );
}
