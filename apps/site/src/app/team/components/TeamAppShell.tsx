"use client";

import React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { Route } from "next";
import { cn } from "@myst-os/ui";

export type TeamNavItem = {
  id: string;
  label: string;
  href: string;
};

export type TeamNavGroup = {
  id: string;
  label: string;
  items: TeamNavItem[];
};

type AccessPills = {
  hasCrew: boolean;
  hasOffice: boolean;
  hasOwner: boolean;
};

type TeamUser = {
  name: string;
  email?: string | null;
};

function IconGrid(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path
        d="M4.75 5.75h5.5v5.5h-5.5v-5.5Zm9 0h5.5v5.5h-5.5v-5.5Zm-9 9h5.5v5.5h-5.5v-5.5Zm9 0h5.5v5.5h-5.5v-5.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconInbox(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path
        d="M4.75 12.25V6.75c0-1.105.895-2 2-2h10.5c1.105 0 2 .895 2 2v5.5M4.75 12.25l2.7 5.4c.338.676 1.03 1.1 1.786 1.1h5.528c.756 0 1.448-.424 1.786-1.1l2.7-5.4M4.75 12.25h4.5l1.2 1.6c.19.253.488.4.804.4h1.492c.316 0 .614-.147.804-.4l1.2-1.6h4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconUsers(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path
        d="M8.25 10.5a3.75 3.75 0 1 0 0-7.5 3.75 3.75 0 0 0 0 7.5Zm10.5-1.25a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3.75 21v-1.25A6 6 0 0 1 9.75 13.75h-3a6 6 0 0 0-6 6V21m6 0v-1.25a6 6 0 0 1 6-6h3a6 6 0 0 1 6 6V21"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconCalendar(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path
        d="M7 3.75v2.5m10-2.5v2.5M4.75 8.25h14.5m-13 2.5h11.5c.828 0 1.5.672 1.5 1.5v6.5c0 .828-.672 1.5-1.5 1.5H6.25c-.828 0-1.5-.672-1.5-1.5v-6.5c0-.828.672-1.5 1.5-1.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconPhone(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path
        d="M7.5 4.75h2.25c.46 0 .86.31.97.76l.8 3.22a1 1 0 0 1-.25.95l-1.7 1.7a12.5 12.5 0 0 0 5.05 5.05l1.7-1.7a1 1 0 0 1 .95-.25l3.22.8c.45.11.76.51.76.97V18.5c0 1.105-.895 2-2 2h-.75C9.32 20.5 3.5 14.68 3.5 7.25V6.5c0-1.105.895-2 2-2Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconChevronLeft(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path
        d="M15.25 6.75 9.75 12l5.5 5.25"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconChevronRight(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path
        d="M8.75 6.75 14.25 12l-5.5 5.25"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconMenu(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path
        d="M5 7h14M5 12h14M5 17h14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function iconForTab(id: string): React.ReactElement {
  const className = "h-5 w-5";
  switch (id) {
    case "inbox":
      return <IconInbox className={className} />;
    case "contacts":
    case "partners":
      return <IconUsers className={className} />;
    case "calendar":
    case "myday":
      return <IconCalendar className={className} />;
    case "sales-hq":
      return <IconPhone className={className} />;
    default:
      return <IconGrid className={className} />;
  }
}

function AccessPill({ label, enabled, tone }: { label: string; enabled: boolean; tone: "emerald" | "sky" | "primary" }) {
  const base = "inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold";
  const classes =
    tone === "emerald"
      ? enabled
        ? "bg-emerald-100 text-emerald-800"
        : "bg-slate-100 text-slate-500"
      : tone === "sky"
        ? enabled
          ? "bg-sky-100 text-sky-800"
          : "bg-slate-100 text-slate-500"
        : enabled
          ? "bg-primary-100 text-primary-800"
          : "bg-slate-100 text-slate-500";
  return <span className={cn(base, classes)}>{label}</span>;
}

const SIDEBAR_STORAGE_KEY = "team.sidebar.collapsed.v1";

export function TeamAppShell(props: {
  activeId: string;
  title: string;
  quickItems: TeamNavItem[];
  groups: TeamNavGroup[];
  access: AccessPills;
  user?: TeamUser | null;
  classicHref: string;
  children: React.ReactNode;
}): React.ReactElement {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = React.useTransition();
  const [collapsed, setCollapsed] = React.useState(false);
  const [mobileOpen, setMobileOpen] = React.useState(false);

  React.useEffect(() => {
    const stored = globalThis.localStorage?.getItem(SIDEBAR_STORAGE_KEY);
    if (stored === "1") setCollapsed(true);
  }, []);

  const handleToggleCollapse = React.useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      globalThis.localStorage?.setItem(SIDEBAR_STORAGE_KEY, next ? "1" : "0");
      return next;
    });
  }, []);

  const handleNavigate = React.useCallback(
    (href: string) => {
      startTransition(() => {
        router.push(href as Route);
      });
    },
    [router]
  );

  const switchToClassic = React.useCallback(() => {
    startTransition(() => {
      router.push(props.classicHref as Route);
    });
  }, [props.classicHref, router]);

  const hasClassic = Boolean(props.classicHref);
  const hasLayoutParam = searchParams.get("layout");
  const isClassic = hasLayoutParam === "classic";

  const sidebarWidth = collapsed ? "w-[72px]" : "w-[280px]";

  const SidebarContent = (
    <div className={cn("flex h-full flex-col gap-5 px-3 py-4", collapsed ? "px-2" : "px-3")}>
      <div className={cn("flex items-center justify-between", collapsed ? "px-1" : "px-2")}>
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-slate-900 text-white shadow-lg shadow-slate-300/60">
            <IconGrid className="h-5 w-5" />
          </div>
          {collapsed ? null : (
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Stonegate</div>
              <div className="text-sm font-semibold text-slate-900">Team Console</div>
            </div>
          )}
        </div>
      </div>

      <div className="space-y-2">
        {collapsed ? null : <div className="px-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Quick</div>}
        <div className="space-y-1">
          {props.quickItems.map((item) => {
            const active = item.id === props.activeId;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => handleNavigate(item.href)}
                className={cn(
                  "group flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left text-sm font-semibold transition focus:outline-none focus:ring-2 focus:ring-primary-200",
                  active
                    ? "bg-primary-50 text-primary-800 shadow-sm shadow-primary-100/60"
                    : "text-slate-700 hover:bg-white hover:text-slate-900"
                )}
                aria-current={active ? "page" : undefined}
              >
                <span
                  className={cn(
                    "flex h-9 w-9 items-center justify-center rounded-2xl border",
                    active ? "border-primary-100 bg-white text-primary-700" : "border-slate-200 bg-white text-slate-500 group-hover:text-slate-700"
                  )}
                >
                  {iconForTab(item.id)}
                </span>
                {collapsed ? null : <span className="truncate">{item.label}</span>}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto pr-1">
        <div className="space-y-4">
          {props.groups.map((group) => (
            <div key={group.id} className="space-y-2">
              {collapsed ? null : (
                <div className="px-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  {group.label}
                </div>
              )}
              <div className="space-y-1">
                {group.items.map((item) => {
                  const active = item.id === props.activeId;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => handleNavigate(item.href)}
                      className={cn(
                        "group flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-primary-200",
                        active
                          ? "bg-slate-900 text-white shadow-md shadow-slate-300/50"
                          : "text-slate-700 hover:bg-white hover:text-slate-900"
                      )}
                      aria-current={active ? "page" : undefined}
                    >
                      <span
                        className={cn(
                          "flex h-9 w-9 items-center justify-center rounded-2xl border",
                          active ? "border-white/20 bg-white/10 text-white" : "border-slate-200 bg-white text-slate-500 group-hover:text-slate-700"
                        )}
                      >
                        {iconForTab(item.id)}
                      </span>
                      {collapsed ? null : <span className="truncate">{item.label}</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className={cn("mt-auto space-y-2", collapsed ? "px-1" : "px-2")}>
        <button
          type="button"
          onClick={handleToggleCollapse}
          className={cn(
            "flex w-full items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 shadow-sm transition hover:border-primary-200 hover:text-primary-800 focus:outline-none focus:ring-2 focus:ring-primary-200"
          )}
        >
          {collapsed ? <IconChevronRight className="h-4 w-4" /> : <IconChevronLeft className="h-4 w-4" />}
          {collapsed ? null : <span>Collapse</span>}
        </button>
        {hasClassic ? (
          <button
            type="button"
            onClick={switchToClassic}
            className={cn(
              "flex w-full items-center justify-center rounded-2xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 shadow-sm transition hover:border-slate-300 hover:text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-200",
              isClassic ? "opacity-60" : ""
            )}
            disabled={isClassic}
          >
            {collapsed ? "Classic" : "Classic layout"}
          </button>
        ) : null}
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-100">
      <div className="mx-auto flex min-h-screen max-w-[1920px]">
        <aside
          className={cn(
            "hidden shrink-0 border-r border-slate-200/70 bg-slate-50/80 backdrop-blur supports-[backdrop-filter]:bg-slate-50/70 lg:block",
            sidebarWidth
          )}
        >
          {SidebarContent}
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-40 border-b border-slate-200/70 bg-white/70 backdrop-blur supports-[backdrop-filter]:bg-white/60">
            <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-4 px-4 py-3 sm:px-6">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setMobileOpen(true)}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-2xl border border-slate-200 bg-white text-slate-700 shadow-sm transition hover:border-primary-200 hover:text-primary-800 focus:outline-none focus:ring-2 focus:ring-primary-200 lg:hidden"
                  aria-label="Open navigation"
                >
                  <IconMenu className="h-5 w-5" />
                </button>
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">Team</div>
                  <div className="text-lg font-semibold text-slate-900">{props.title}</div>
                </div>
                {isPending ? <span className="text-xs font-semibold text-slate-400">Loading…</span> : null}
              </div>
              <div className="flex items-center gap-2 sm:gap-3">
                <div className="hidden items-center gap-2 md:flex">
                  <AccessPill label="Crew" enabled={props.access.hasCrew || props.access.hasOwner} tone="emerald" />
                  <AccessPill label="Office" enabled={props.access.hasOffice || props.access.hasOwner} tone="sky" />
                  <AccessPill label="Owner" enabled={props.access.hasOwner} tone="primary" />
                </div>
                {props.user ? (
                  <div className="hidden text-right text-xs text-slate-600 sm:block">
                    <div className="font-semibold text-slate-900">{props.user.name}</div>
                    {props.user.email ? <div className="truncate">{props.user.email}</div> : null}
                  </div>
                ) : null}
              </div>
            </div>
          </header>

          <div className="flex-1">
            <main className="mx-auto w-full max-w-[1600px] space-y-6 px-4 py-6 sm:px-6 sm:py-8">
              {props.children}
            </main>
          </div>
        </div>
      </div>

      {mobileOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-slate-900/30 backdrop-blur-sm" onClick={() => setMobileOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-[300px] max-w-[85vw] border-r border-slate-200 bg-slate-50 shadow-2xl">
            <div className="flex items-center justify-between px-3 py-3">
              <div className="text-sm font-semibold text-slate-900">Navigation</div>
              <button
                type="button"
                onClick={() => setMobileOpen(false)}
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 shadow-sm"
              >
                Close
              </button>
            </div>
            <div
              className="h-[calc(100vh-52px)] overflow-y-auto"
              onClick={(event) => {
                const target = event.target as HTMLElement;
                if (target.closest("button")) setMobileOpen(false);
              }}
            >
              {SidebarContent}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

