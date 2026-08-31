"use client";

import Image from "next/image";
import Link from "next/link";
import type { Route } from "next";
import { usePathname } from "next/navigation";
import type { PublicCompanyProfile } from "@/lib/company";

export function PartnerPublicShell({
  company,
  children,
  showSignIn = true,
}: {
  company: PublicCompanyProfile;
  children: React.ReactNode;
  showSignIn?: boolean;
}) {
  const pathname = usePathname();
  const entryLink: { href: Route; label: string } =
    pathname === "/partners/request-access"
      ? { href: "/partners/login", label: "Sign in" }
      : { href: "/partners/request-access", label: "Request access" };
  return (
    <div className="flex min-h-screen flex-col bg-slate-50 text-slate-950">
      <a
        href="#partner-public-main"
        className="sr-only fixed left-4 top-4 z-50 rounded-lg bg-primary-800 px-4 py-3 font-semibold text-white shadow-xl focus:not-sr-only"
      >
        Skip to main content
      </a>
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex min-h-16 w-full max-w-6xl items-center justify-between gap-4 px-4 py-2 sm:px-6 lg:px-8">
          <Link
            href="/partners/login"
            className="flex min-w-0 items-center gap-3 rounded-lg"
          >
            <Image
              src={company.logoPath}
              alt=""
              width={48}
              height={48}
              className="h-11 w-11 object-contain"
              priority
            />
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold text-slate-950">
                {company.name}
              </span>
              <span className="block text-xs text-slate-500">Partner Portal</span>
            </span>
          </Link>
          <div className="flex items-center gap-2">
            <a
              href={`tel:${company.phoneE164}`}
              className="inline-flex min-h-11 items-center rounded-xl px-3 text-sm font-semibold text-slate-600 hover:bg-slate-100 hover:text-primary-800"
            >
              <span className="hidden sm:inline">Need help? </span>
              <span className="sm:ml-1">Call</span>
            </a>
            {showSignIn ? (
              <Link
                href={entryLink.href}
                className="inline-flex min-h-11 items-center rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 shadow-sm hover:border-primary-300 hover:text-primary-800"
              >
                {entryLink.label}
              </Link>
            ) : null}
          </div>
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
            <Link className="underline-offset-4 hover:underline" href="/privacy">
              Privacy
            </Link>
            <Link className="underline-offset-4 hover:underline" href="/terms">
              Terms
            </Link>
            <Link
              className="underline-offset-4 hover:underline"
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
