import Link from "next/link";
import { Button, Cta } from "@myst-os/ui";
import { getPublicCompanyProfile } from "@/lib/company";

export function Footer() {
  const company = getPublicCompanyProfile();
  const hqLabel = company.hqCity?.trim().length ? `${company.hqCity} HQ` : "Local HQ";
  const locationLine = company.serviceAreaSummary?.trim().length ? company.serviceAreaSummary : "";

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
              <a href={`tel:${company.phoneE164}`}>Call {company.phoneDisplay}</a>
            </Button>
          }
        />
        <div className="mt-12 grid gap-6 text-sm text-neutral-500 md:grid-cols-3">
          <div>
            <p className="font-semibold text-neutral-800">{company.name}</p>
            <p className="mt-2">{hqLabel}{locationLine ? ` — ${locationLine}` : ""}</p>
          </div>
          <div>
            <p className="font-semibold text-neutral-800">Contact</p>
            <ul className="mt-2 space-y-1">
              <li>
                <a href={`tel:${company.phoneE164}`} className="text-neutral-700 hover:text-primary-700">
                  {company.phoneDisplay}
                </a>
              </li>
              <li>
                <a href={`sms:${company.phoneE164}`} className="text-neutral-700 hover:text-primary-700">
                  Text the crew
                </a>
              </li>
              <li>
                <a href={`mailto:${company.email}`} className="text-neutral-700 hover:text-primary-700">
                  {company.email}
                </a>
              </li>
            </ul>
          </div>
          <div>
            <p className="font-semibold text-neutral-800">Hours</p>
            <p className="mt-2">{company.hoursSummary}</p>
          </div>
        </div>
        <p className="mt-12 text-xs text-neutral-600">
          <span>
            Copyright {new Date().getFullYear()} {company.name}. Licensed & insured. All rights reserved.
          </span>
          <span className="mx-2 text-neutral-400">•</span>
          <Link href="/privacy" className="text-neutral-700 hover:text-primary-700">
            Privacy Policy
          </Link>
          <span className="mx-2 text-neutral-400">•</span>
          <Link href="/terms" className="text-neutral-700 hover:text-primary-700">
            Terms
          </Link>
        </p>
      </div>
    </footer>
  );
}
