"use client";

import Image from "next/image";
import Link from "next/link";
import type { Route } from "next";
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { Button } from "@myst-os/ui";
import { PRICING_ESTIMATOR_QUERY_KEYS } from "@/lib/pricing-estimator";

const FALLBACK_COMPANY_NAME = "Stonegate Junk Removal";
const FALLBACK_PHONE_DISPLAY = "(404) 777-2631";
const FALLBACK_PHONE_E164 = "+14047772631";
const FALLBACK_LOGO_PATH = "/images/brand/Stonegatelogo.png";
const MOBILE_NAVIGATION_ID = "mobile-navigation";
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function normalizePhoneE164(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return FALLBACK_PHONE_E164;
  if (trimmed.startsWith("+")) return trimmed;
  const digits = trimmed.replace(/[^\d]/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return trimmed;
}

const navItems = [
  { href: "/services", label: "Services" },
  { href: "/pricing", label: "Pricing" },
  { href: "/areas", label: "Service Areas" },
  { href: "/about", label: "About" },
  { href: "/partners", label: "For Partners" },
] satisfies Array<{ href: Route; label: string }>;

function isActiveNavItem(pathname: string, href: Route): boolean {
  if (pathname === href) return true;
  return pathname.startsWith(`${href}/`);
}

export function Header() {
  const pathname = usePathname();
  const isBookingLanding = pathname === "/book" || pathname === "/bookdemo";
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const headerRef = useRef<HTMLElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const companyName =
    process.env["NEXT_PUBLIC_COMPANY_NAME"] ?? FALLBACK_COMPANY_NAME;
  const phoneE164 = normalizePhoneE164(
    process.env["NEXT_PUBLIC_COMPANY_PHONE_E164"] ?? FALLBACK_PHONE_E164,
  );
  const phoneDisplay =
    process.env["NEXT_PUBLIC_COMPANY_PHONE_DISPLAY"] ?? FALLBACK_PHONE_DISPLAY;
  const logoPath =
    process.env["NEXT_PUBLIC_COMPANY_LOGO_PATH"] ?? FALLBACK_LOGO_PATH;

  const closeMenu = useCallback(() => setIsMenuOpen(false), []);

  const openMenu = useCallback(() => {
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : menuButtonRef.current;
    setIsMenuOpen(true);
  }, []);

  useEffect(() => {
    closeMenu();
  }, [closeMenu, pathname]);

  useEffect(() => {
    const desktopMedia = globalThis.matchMedia?.("(min-width: 1280px)");
    if (!desktopMedia) return;
    const closeAtDesktop = (event: MediaQueryListEvent): void => {
      if (event.matches) closeMenu();
    };
    desktopMedia.addEventListener("change", closeAtDesktop);
    return () => desktopMedia.removeEventListener("change", closeAtDesktop);
  }, [closeMenu]);

  useEffect(() => {
    if (!isMenuOpen) return;

    const { body } = document;
    const previousOverflow = body.style.overflow;
    const fallbackTrigger = menuButtonRef.current;
    const header = headerRef.current;
    const layout = header?.parentElement;
    const inertSiblings = layout
      ? Array.from(layout.children).filter(
          (element): element is HTMLElement =>
            element instanceof HTMLElement && element !== header,
        )
      : [];
    const previousInert = inertSiblings.map((element) => element.inert);

    body.style.overflow = "hidden";
    for (const element of inertSiblings) element.inert = true;
    closeButtonRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        closeMenu();
        return;
      }
      if (event.key !== "Tab") return;

      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter(
        (element) =>
          !element.closest('[hidden], [inert], [aria-hidden="true"]') &&
          element.getClientRects().length > 0,
      );
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !dialog.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      body.style.overflow = previousOverflow;
      inertSiblings.forEach((element, index) => {
        element.inert = previousInert[index] ?? false;
      });
      const restoreTarget = restoreFocusRef.current ?? fallbackTrigger;
      if (restoreTarget?.isConnected && restoreTarget.getClientRects().length) {
        restoreTarget.focus();
      }
      restoreFocusRef.current = null;
    };
  }, [closeMenu, isMenuOpen]);

  return (
    <header
      ref={headerRef}
      className="sticky top-0 z-[60] border-b border-neutral-300/50 bg-white/95"
    >
      <div
        inert={isMenuOpen ? true : undefined}
        className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3 md:px-10"
      >
        <Link href="/" className="flex items-center gap-2 text-primary-800">
          <Image
            src={logoPath}
            alt=""
            aria-hidden="true"
            width={80}
            height={80}
            className="h-12 w-12 object-contain"
            priority
          />
          <span className="sr-only">{companyName}</span>
        </Link>
        {!isBookingLanding ? (
          <nav
            aria-label="Primary"
            className="hidden items-center gap-4 xl:flex"
          >
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-current={
                  isActiveNavItem(pathname, item.href) ? "page" : undefined
                }
                className="inline-flex min-h-11 items-center rounded text-sm font-medium text-neutral-600 transition hover:text-primary-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
              >
                {item.label}
              </Link>
            ))}
          </nav>
        ) : null}
        <div className="hidden items-center gap-3 xl:flex">
          {!isBookingLanding ? (
            <Suspense
              fallback={
                <Button asChild>
                  <Link href="/book">Get instant quote</Link>
                </Button>
              }
            >
              <GetQuoteButton />
            </Suspense>
          ) : null}
          <Button
            asChild
            variant="ghost"
            className="border border-neutral-300/70 text-primary-800 hover:border-primary-300"
          >
            <a
              href={`tel:${phoneE164}`}
              data-cta={pathname === "/book" ? "book-call" : undefined}
            >
              {isBookingLanding ? `Call ${phoneDisplay}` : "Call"}
            </a>
          </Button>
        </div>
        {isBookingLanding ? (
          <Button
            asChild
            variant="ghost"
            className="border border-neutral-300/70 text-primary-800 hover:border-primary-300 xl:hidden"
          >
            <a
              href={`tel:${phoneE164}`}
              data-cta={pathname === "/book" ? "book-call" : undefined}
            >
              Call
            </a>
          </Button>
        ) : (
          <button
            ref={menuButtonRef}
            type="button"
            onClick={openMenu}
            className="inline-flex min-h-11 items-center gap-2 rounded-md border border-neutral-300/60 px-4 py-2 text-sm font-semibold text-neutral-700 shadow-soft transition hover:border-primary-300 hover:text-primary-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500 xl:hidden"
            aria-controls={MOBILE_NAVIGATION_ID}
            aria-expanded={isMenuOpen}
            aria-haspopup="dialog"
            aria-label="Open navigation"
          >
            <span>Menu</span>
          </button>
        )}
      </div>
      {!isBookingLanding && isMenuOpen ? (
        <div className="fixed inset-0 z-50 xl:hidden">
          <button
            type="button"
            onClick={closeMenu}
            aria-hidden="true"
            className="absolute inset-0 bg-neutral-900/40 motion-safe:animate-in motion-safe:fade-in"
            tabIndex={-1}
          />
          <div
            ref={dialogRef}
            id={MOBILE_NAVIGATION_ID}
            role="dialog"
            aria-modal="true"
            aria-label="Site navigation"
            tabIndex={-1}
            className="absolute inset-y-0 right-0 flex w-[min(88vw,22rem)] flex-col gap-6 border-l border-neutral-200 bg-white px-6 pb-[calc(env(safe-area-inset-bottom,0px)+2rem)] pt-6 shadow-xl motion-safe:animate-in motion-safe:slide-in-from-right"
          >
            <div className="flex items-center justify-between">
              <span className="text-lg font-semibold text-primary-900">
                Menu
              </span>
              <button
                ref={closeButtonRef}
                type="button"
                onClick={closeMenu}
                className="inline-flex h-11 w-11 items-center justify-center rounded-md text-2xl leading-none text-neutral-500 transition hover:bg-neutral-100 hover:text-primary-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
                aria-label="Close navigation"
              >
                ×
              </button>
            </div>
            <nav
              aria-label="Mobile primary"
              className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto text-base"
            >
              {navItems.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={closeMenu}
                  aria-current={
                    isActiveNavItem(pathname, item.href) ? "page" : undefined
                  }
                  className="flex min-h-11 items-center rounded-md px-3 py-2 font-medium text-neutral-700 transition hover:bg-neutral-100 hover:text-primary-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
            <div className="flex flex-col gap-3">
              <Suspense
                fallback={
                  <Button asChild size="lg" className="w-full">
                    <Link href="/book">Get instant quote</Link>
                  </Button>
                }
              >
                <GetQuoteButton size="lg" className="w-full" />
              </Suspense>
              <Button
                asChild
                variant="ghost"
                size="lg"
                className="w-full border border-neutral-300/70 text-primary-800 hover:border-primary-300"
              >
                <a href={`tel:${phoneE164}`}>Call {phoneDisplay}</a>
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </header>
  );
}

function GetQuoteButton({
  size,
  className,
}: {
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const quoteHref = useMemo(() => {
    if (pathname !== "/pricing") {
      return "/book";
    }

    const params = new URLSearchParams(searchParams.toString());
    const hasEstimatorParams =
      params.has(PRICING_ESTIMATOR_QUERY_KEYS.load) ||
      params.has(PRICING_ESTIMATOR_QUERY_KEYS.mattress) ||
      params.has(PRICING_ESTIMATOR_QUERY_KEYS.paint) ||
      params.has(PRICING_ESTIMATOR_QUERY_KEYS.tire);

    if (!hasEstimatorParams) {
      return "/book";
    }

    params.set("intent", "pricing-estimator");
    return `/book?${params.toString()}`;
  }, [pathname, searchParams]);

  return (
    <Button asChild size={size} className={className}>
      <Link href={quoteHref as Route}>Get instant quote</Link>
    </Button>
  );
}
