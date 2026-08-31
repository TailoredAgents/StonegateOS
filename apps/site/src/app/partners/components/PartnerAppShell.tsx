"use client";

import Image from "next/image";
import Link from "next/link";
import type { Route } from "next";
import { usePathname } from "next/navigation";
import * as React from "react";
import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  BriefcaseBusiness,
  CalendarPlus2,
  Camera,
  CircleDollarSign,
  ClipboardCheck,
  HelpCircle,
  Home,
  LogOut,
  MapPin,
  Menu,
  Settings,
  UserRound,
  X,
} from "lucide-react";
import { cn } from "@myst-os/ui";
import type {
  PartnerCapabilities,
  PartnerCapability,
} from "../lib/portal-context";

const MAIN_ID = "partner-main-content";
const DRAWER_ID = "partner-mobile-navigation";
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

type PartnerNavItem = {
  href: string;
  label: string;
  shortLabel?: string;
  capability: PartnerCapability;
  icon: LucideIcon;
  exact?: boolean;
};

const NAV_ITEMS: PartnerNavItem[] = [
  {
    href: "/partners",
    label: "Overview",
    capability: "overview",
    icon: Home,
    exact: true,
  },
  {
    href: "/partners/book",
    label: "Schedule job",
    shortLabel: "Schedule",
    capability: "schedule",
    icon: CalendarPlus2,
  },
  {
    href: "/partners/bookings",
    label: "Jobs",
    capability: "jobs",
    icon: BriefcaseBusiness,
  },
  {
    href: "/partners/approvals",
    label: "Approvals",
    capability: "approvals",
    icon: ClipboardCheck,
  },
  {
    href: "/partners/properties",
    label: "Locations",
    capability: "locations",
    icon: MapPin,
  },
  {
    href: "/partners/photos",
    label: "Photos & proof",
    capability: "proof",
    icon: Camera,
  },
  {
    href: "/partners/billing",
    label: "Billing & documents",
    capability: "billing",
    icon: CircleDollarSign,
  },
  {
    href: "/partners/reports",
    label: "Reports",
    capability: "reports",
    icon: BarChart3,
  },
  {
    href: "/partners/help",
    label: "Help",
    capability: "help",
    icon: HelpCircle,
  },
];

const PAGE_TITLES: Array<{ prefix: string; title: string }> = [
  { prefix: "/partners/approvals", title: "Approvals" },
  { prefix: "/partners/bookings", title: "Jobs" },
  { prefix: "/partners/book", title: "Schedule job" },
  { prefix: "/partners/properties", title: "Locations" },
  { prefix: "/partners/photos", title: "Photos & proof" },
  { prefix: "/partners/billing", title: "Billing & documents" },
  { prefix: "/partners/reports", title: "Reports" },
  { prefix: "/partners/help", title: "Help" },
  { prefix: "/partners/settings", title: "Account & security" },
];

function isActivePath(pathname: string, item: PartnerNavItem): boolean {
  if (item.exact) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

function getPageTitle(pathname: string): string {
  return PAGE_TITLES.find((entry) => pathname.startsWith(entry.prefix))?.title ?? "Overview";
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) =>
      !element.closest('[hidden], [inert], [aria-hidden="true"]') &&
      element.getClientRects().length > 0,
  );
}

function PortalNavigation({
  pathname,
  capabilities,
  onNavigate,
}: {
  pathname: string;
  capabilities: PartnerCapabilities;
  onNavigate?: () => void;
}) {
  return (
    <nav aria-label="Partner portal" className="space-y-1">
      {NAV_ITEMS.filter((item) => capabilities[item.capability]).map((item) => {
        const active = isActivePath(pathname, item);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href as Route}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "group flex min-h-11 items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500",
              active
                ? "bg-primary-50 text-primary-900 ring-1 ring-inset ring-primary-100"
                : "text-slate-600 hover:bg-slate-100 hover:text-slate-950",
            )}
          >
            <Icon
              className={cn(
                "h-5 w-5 shrink-0",
                active ? "text-primary-700" : "text-slate-400 group-hover:text-slate-700",
              )}
              aria-hidden="true"
            />
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

export function PartnerAppShell({
  children,
  companyName,
  logoPath,
  accountLabel,
  userName,
  userEmail,
  capabilities,
}: {
  children: React.ReactNode;
  companyName: string;
  logoPath: string;
  accountLabel: string;
  userName: string;
  userEmail: string;
  capabilities: PartnerCapabilities;
}) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const drawerRef = React.useRef<HTMLDivElement>(null);
  const closeButtonRef = React.useRef<HTMLButtonElement>(null);
  const menuButtonRef = React.useRef<HTMLButtonElement>(null);
  const activeTriggerRef = React.useRef<HTMLElement | null>(null);
  const previousPathnameRef = React.useRef(pathname);
  const focusDestinationRef = React.useRef<"trigger" | "main">("trigger");
  const pageTitle = getPageTitle(pathname);

  const openNavigation = React.useCallback(() => {
    focusDestinationRef.current = "trigger";
    activeTriggerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setMobileOpen(true);
  }, []);

  const closeNavigation = React.useCallback(() => {
    focusDestinationRef.current = "trigger";
    setMobileOpen(false);
  }, []);

  const navigateFromDrawer = React.useCallback(() => {
    focusDestinationRef.current = "main";
    setMobileOpen(false);
  }, []);

  React.useEffect(() => {
    const previousPathname = previousPathnameRef.current;
    previousPathnameRef.current = pathname;
    if (previousPathname !== pathname && mobileOpen) {
      navigateFromDrawer();
    }
  }, [mobileOpen, navigateFromDrawer, pathname]);

  React.useEffect(() => {
    const desktopMedia = globalThis.matchMedia?.("(min-width: 1024px)");
    if (!desktopMedia) return;
    const closeAtDesktop = (event: MediaQueryListEvent): void => {
      if (event.matches) closeNavigation();
    };
    if (desktopMedia.matches && mobileOpen) closeNavigation();
    desktopMedia.addEventListener("change", closeAtDesktop);
    return () => desktopMedia.removeEventListener("change", closeAtDesktop);
  }, [closeNavigation, mobileOpen]);

  React.useEffect(() => {
    if (!mobileOpen) return;

    const previousOverflow = document.body.style.overflow;
    const trigger = activeTriggerRef.current ?? menuButtonRef.current;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        closeNavigation();
        return;
      }
      if (event.key !== "Tab") return;

      const drawer = drawerRef.current;
      if (!drawer) return;
      const focusable = focusableElements(drawer);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        drawer.focus();
        return;
      }

      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !drawer.contains(active)) {
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
      document.body.style.overflow = previousOverflow;
      const main = document.getElementById(MAIN_ID);
      const preferredTarget = focusDestinationRef.current === "main" ? main : trigger;
      const target = preferredTarget?.getClientRects().length ? preferredTarget : main;
      target?.focus();
      activeTriggerRef.current = null;
      focusDestinationRef.current = "trigger";
    };
  }, [closeNavigation, mobileOpen]);

  const brand = (
    <Link href="/partners" className="flex min-w-0 items-center gap-3 rounded-lg">
      <Image
        src={logoPath}
        alt=""
        width={48}
        height={48}
        className="h-11 w-11 shrink-0 object-contain"
        priority
      />
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold text-slate-950">
          {companyName}
        </span>
        <span className="block truncate text-xs text-slate-500">Partner Portal</span>
      </span>
    </Link>
  );

  return (
    <div className="min-h-screen bg-slate-100 text-slate-950">
      <div inert={mobileOpen ? true : undefined} className="min-h-screen">
        <a
          href={`#${MAIN_ID}`}
          className="sr-only fixed left-4 top-4 z-[100] rounded-lg bg-primary-800 px-4 py-3 font-semibold text-white shadow-xl focus:not-sr-only"
        >
          Skip to main content
        </a>

        <div className="flex min-h-screen">
          <aside className="sticky top-0 hidden h-screen w-72 shrink-0 border-r border-slate-200 bg-white lg:flex lg:flex-col">
            <div className="border-b border-slate-200 px-5 py-4">{brand}</div>
            <div className="border-b border-slate-100 px-5 py-4">
              <p className="text-xs font-medium uppercase tracking-[0.14em] text-slate-500">
                Working for
              </p>
              <p className="mt-1 truncate text-sm font-semibold text-slate-900">
                {accountLabel}
              </p>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
              {capabilities.schedule ? (
                <Link
                  href="/partners/book"
                  className="mb-4 flex min-h-11 items-center justify-center gap-2 rounded-xl bg-primary-700 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-primary-800"
                >
                  <CalendarPlus2 className="h-4 w-4" aria-hidden="true" />
                  Schedule job
                </Link>
              ) : null}
              <PortalNavigation pathname={pathname} capabilities={capabilities} />
            </div>
            <div className="border-t border-slate-200 p-4">
              <div className="flex items-center gap-3 px-2 py-2">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-600">
                  <UserRound className="h-5 w-5" aria-hidden="true" />
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-slate-900">{userName}</p>
                  <p className="truncate text-xs text-slate-500">{userEmail}</p>
                </div>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {capabilities.settings ? (
                  <Link
                    href="/partners/settings"
                    className="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-slate-200 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    <Settings className="h-4 w-4" aria-hidden="true" />
                    Settings
                  </Link>
                ) : null}
                <form action="/partners/logout" method="post">
                  <button
                    type="submit"
                    className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-slate-200 text-xs font-semibold text-slate-700 hover:border-rose-200 hover:bg-rose-50 hover:text-rose-800"
                  >
                    <LogOut className="h-4 w-4" aria-hidden="true" />
                    Sign out
                  </button>
                </form>
              </div>
            </div>
          </aside>

          <div className="flex min-w-0 flex-1 flex-col">
            <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur lg:bg-white/90">
              <div className="flex min-h-16 items-center justify-between gap-3 px-4 sm:px-6 lg:px-8">
                <div className="flex min-w-0 items-center gap-3">
                  <button
                    ref={menuButtonRef}
                    type="button"
                    onClick={openNavigation}
                    className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-700 shadow-sm hover:bg-slate-50 lg:hidden"
                    aria-label="Open navigation"
                    aria-expanded={mobileOpen}
                    aria-controls={DRAWER_ID}
                    aria-haspopup="dialog"
                  >
                    <Menu className="h-5 w-5" aria-hidden="true" />
                  </button>
                  <div className="min-w-0">
                    <p className="truncate text-base font-semibold text-slate-950 sm:text-lg">
                      {pageTitle}
                    </p>
                    <p className="truncate text-xs text-slate-500 lg:hidden">{accountLabel}</p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {capabilities.help ? (
                    <Link
                      href={"/partners/help" as Route}
                      className="hidden min-h-11 items-center gap-2 rounded-xl px-3 text-sm font-semibold text-slate-600 hover:bg-slate-100 hover:text-primary-800 sm:inline-flex"
                    >
                      <HelpCircle className="h-4 w-4" aria-hidden="true" />
                      Help
                    </Link>
                  ) : null}
                  {capabilities.settings ? (
                    <Link
                      href="/partners/settings"
                      className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 shadow-sm hover:text-primary-800"
                      aria-label="Account and security"
                    >
                      <UserRound className="h-5 w-5" aria-hidden="true" />
                    </Link>
                  ) : null}
                </div>
              </div>
            </header>

            <main
              id={MAIN_ID}
              tabIndex={-1}
              className="mx-auto min-h-0 w-full max-w-7xl flex-1 px-4 pb-28 pt-5 focus:outline-none sm:px-6 sm:pt-6 lg:px-8 lg:pb-10 lg:pt-8"
            >
              {children}
            </main>
          </div>
        </div>

        <nav
          aria-label="Quick navigation"
          className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
        >
          <div className="grid grid-flow-col auto-cols-fr">
            {NAV_ITEMS.filter((item) =>
              ["overview", "schedule", "jobs"].includes(item.capability),
            )
              .filter((item) => capabilities[item.capability])
              .map((item) => {
                const active = isActivePath(pathname, item);
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href as Route}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex min-h-[64px] flex-col items-center justify-center gap-1 px-1 py-2 text-[11px] font-semibold",
                      active ? "text-primary-800" : "text-slate-500",
                    )}
                  >
                    <Icon className="h-5 w-5" aria-hidden="true" />
                    <span>{item.shortLabel ?? item.label}</span>
                  </Link>
                );
              })}
            <button
              type="button"
              onClick={openNavigation}
              className="flex min-h-[64px] flex-col items-center justify-center gap-1 px-1 py-2 text-[11px] font-semibold text-slate-500"
              aria-label="Open all navigation"
              aria-expanded={mobileOpen}
              aria-controls={DRAWER_ID}
            >
              <Menu className="h-5 w-5" aria-hidden="true" />
              <span>More</span>
            </button>
          </div>
        </nav>
      </div>

      {mobileOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-hidden="true"
            tabIndex={-1}
            className="absolute inset-0 bg-slate-950/45"
            onClick={closeNavigation}
          />
          <div
            ref={drawerRef}
            id={DRAWER_ID}
            role="dialog"
            aria-modal="true"
            aria-label="Partner portal navigation"
            tabIndex={-1}
            className="absolute inset-y-0 left-0 flex w-[min(88vw,22rem)] flex-col bg-white shadow-2xl"
          >
            <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
              {brand}
              <button
                ref={closeButtonRef}
                type="button"
                onClick={closeNavigation}
                className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-600 hover:bg-slate-100"
                aria-label="Close navigation"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>
            <div className="border-b border-slate-100 px-5 py-4">
              <p className="text-xs font-medium uppercase tracking-[0.14em] text-slate-500">
                Working for
              </p>
              <p className="mt-1 text-sm font-semibold text-slate-900">{accountLabel}</p>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
              <PortalNavigation
                pathname={pathname}
                capabilities={capabilities}
                onNavigate={navigateFromDrawer}
              />
            </div>
            <div className="border-t border-slate-200 p-4 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
              <p className="truncate px-2 text-sm font-semibold text-slate-900">{userName}</p>
              <p className="truncate px-2 text-xs text-slate-500">{userEmail}</p>
              <div className={cn("mt-3 grid gap-2", capabilities.settings ? "grid-cols-2" : "grid-cols-1")}>
                {capabilities.settings ? (
                  <Link
                    href="/partners/settings"
                    onClick={navigateFromDrawer}
                    className="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-slate-200 text-sm font-semibold text-slate-700"
                  >
                    <Settings className="h-4 w-4" aria-hidden="true" />
                    Settings
                  </Link>
                ) : null}
                <form action="/partners/logout" method="post">
                  <button
                    type="submit"
                    className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-slate-200 text-sm font-semibold text-slate-700"
                  >
                    <LogOut className="h-4 w-4" aria-hidden="true" />
                    Sign out
                  </button>
                </form>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
