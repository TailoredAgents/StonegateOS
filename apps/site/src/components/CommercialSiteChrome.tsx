import Image from "next/image";
import Link from "next/link";
import { CommercialContactActions } from "@/components/CommercialContactActions";
import { getPublicCompanyProfile } from "@/lib/company";
import styles from "./CommercialTheme.module.css";

const textLinkClass =
  "inline-flex min-h-12 items-center rounded text-sm text-neutral-700 hover:text-primary-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary-500";

export function CommercialHeader() {
  const company = getPublicCompanyProfile();

  return (
    <header className={`${styles["header"]} sticky top-0 z-40 border-b`}>
      <a
        href="#main-content"
        className="sr-only rounded bg-white px-4 py-3 text-primary-800 focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-50 focus:outline focus:outline-2 focus:outline-primary-500"
      >
        Skip to content
      </a>
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6 md:px-10">
        <Link
          href="/"
          aria-label={`${company.name} home`}
          className="flex min-h-12 shrink-0 items-center gap-3 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary-500"
        >
          <Image
            src={company.logoPath}
            alt=""
            aria-hidden="true"
            width={80}
            height={80}
            className="h-12 w-12 object-contain"
            priority
          />
          <span className="hidden text-sm font-semibold text-primary-900 xl:inline">
            {company.name}
          </span>
        </Link>
        <nav aria-label="Commercial services" className="hidden gap-5 xl:flex">
          <a href="#services" className={textLinkClass}>
            Our services
          </a>
          <a href="#project" className={textLinkClass}>
            Your project
          </a>
        </nav>
        <CommercialContactActions
          placement="header"
          compact
          showEmail={false}
        />
      </div>
    </header>
  );
}

export function CommercialFooter() {
  const company = getPublicCompanyProfile();

  return (
    <footer className={`${styles["footer"]} border-t`}>
      <div className="mx-auto max-w-6xl px-6 py-10 md:px-10">
        <div className="grid gap-8 md:grid-cols-[1fr_auto] md:items-start">
          <div className="space-y-3 text-sm text-neutral-600">
            <p className="font-semibold text-primary-900">{company.name}</p>
            <p>We’re here to discuss your project.</p>
            <div>
              <p className="font-medium text-neutral-800">Our hours</p>
              <p className="mt-1">{company.hoursSummary}</p>
            </div>
          </div>
          <div>
            <p className="mb-3 text-sm font-semibold text-primary-900">
              Talk with us
            </p>
            <CommercialContactActions placement="footer" />
          </div>
        </div>
        <div className="mt-8 flex flex-col gap-3 border-t border-neutral-200 pt-5 text-xs text-neutral-600 md:flex-row md:items-center md:justify-between">
          <p>
            © {new Date().getFullYear()} {company.name}. All rights reserved.
          </p>
          <nav aria-label="Legal" className="flex flex-wrap gap-x-5">
            <Link href="/privacy" className={textLinkClass}>
              Privacy Policy
            </Link>
            <Link href="/terms" className={textLinkClass}>
              Terms
            </Link>
            <Link href="/service-agreement" className={textLinkClass}>
              Service Agreement
            </Link>
          </nav>
        </div>
      </div>
    </footer>
  );
}

export function CommercialStickyContactBar() {
  return (
    <nav
      aria-label="Contact us about your project"
      className={`${styles["sticky"]} fixed inset-x-0 bottom-0 z-50 px-4 pt-3 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] shadow-[0_-6px_20px_rgba(15,23,42,0.08)] md:hidden`}
    >
      <div className="mx-auto max-w-xl">
        <CommercialContactActions
          placement="sticky"
          compact
          showEmail={false}
        />
      </div>
    </nav>
  );
}
