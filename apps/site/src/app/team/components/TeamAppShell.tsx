"use client";

import React from "react";
import Image from "next/image";
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

type TeamBrand = {
  shortName: string;
  logoPath: string;
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

function IconClipboardCheck(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path
        d="M8.25 4.75h7.5m-6.5 0a2 2 0 0 0-2 2v12.5c0 1.105.895 2 2 2h9.5c1.105 0 2-.895 2-2V6.75c0-1.105-.895-2-2-2m-8.25 10.25 2 2 4.5-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconReceipt(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path
        d="M7 3.75h10c.966 0 1.75.784 1.75 1.75v15l-1.5-.9-1.5.9-1.5-.9-1.5.9-1.5-.9-1.5.9-1.5-.9-1.5.9v-15c0-.966.784-1.75 1.75-1.75Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M9 8.25h6M9 11.25h6M9 14.25h4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconDocument(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path
        d="M7 3.75h7.5l2.5 2.5V20.25c0 .966-.784 1.75-1.75 1.75H7c-.966 0-1.75-.784-1.75-1.75V5.5c0-.966.784-1.75 1.75-1.75Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M14.5 3.75v2.5c0 .552.448 1 1 1H18"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M8.75 11h6.5M8.75 14h6.5M8.75 17h4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconColumns(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path
        d="M6.25 4.75h3.5c.828 0 1.5.672 1.5 1.5v11.5c0 .828-.672 1.5-1.5 1.5h-3.5c-.828 0-1.5-.672-1.5-1.5V6.25c0-.828.672-1.5 1.5-1.5Zm8 0h3.5c.828 0 1.5.672 1.5 1.5v11.5c0 .828-.672 1.5-1.5 1.5h-3.5c-.828 0-1.5-.672-1.5-1.5V6.25c0-.828.672-1.5 1.5-1.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconMegaphone(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path
        d="M4.75 11.25v1.5c0 .966.784 1.75 1.75 1.75h1.25l1.5 4h1.75l-.75-4h5.75l4.25 2.5V7.25l-4.25 2.5H6.5c-.966 0-1.75.784-1.75 1.75Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M18.5 10.25v3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconChart(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path
        d="M5.5 19.5V6.5M5.5 19.5h13M8.5 16v-5M11.5 16v-8M14.5 16v-3M17.5 16v-10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconSearch(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path
        d="M10.5 18.25a7.75 7.75 0 1 1 0-15.5 7.75 7.75 0 0 1 0 15.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M16.25 16.25 20.5 20.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconSpark(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path
        d="M12 2.75l1.4 5.1 5.1 1.4-5.1 1.4L12 15.75l-1.4-5.1-5.1-1.4 5.1-1.4L12 2.75Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M18.25 12.75l.8 2.9 2.9.8-2.9.8-.8 2.9-.8-2.9-2.9-.8 2.9-.8.8-2.9Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconShield(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path
        d="M12 3.75 19 6.75v5.4c0 4.43-3.05 7.98-7 9.1-3.95-1.12-7-4.67-7-9.1v-5.4l7-3Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M9.5 12.25 11.25 14l3.75-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconKey(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path
        d="M14.5 10.25a4.75 4.75 0 1 0-1.64 3.6l3.39 3.4h2.5v-2.5h-2l-.5-.5V13.5l-.75-.75"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M10.25 8.75h.01"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconList(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path
        d="M7.5 7.25h13M7.5 12h13M7.5 16.75h13"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M4.25 7.25h.01M4.25 12h.01M4.25 16.75h.01"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconMerge(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path
        d="M7 5.5v13M7 5.5a1.75 1.75 0 1 0 0 .01M7 18.5a1.75 1.75 0 1 0 0 .01"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M17 5.5v5.1c0 .9-.36 1.76-1 2.4l-2 2c-.64.64-1 1.5-1 2.4v-.1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M17 5.5a1.75 1.75 0 1 0 0 .01"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconGear(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path
        d="M12 14.75a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M19.25 12a7.18 7.18 0 0 0-.1-1.2l2.05-1.6-2-3.46-2.48 1a7.6 7.6 0 0 0-2.06-1.2l-.38-2.64h-4l-.38 2.64a7.6 7.6 0 0 0-2.06 1.2l-2.48-1-2 3.46 2.05 1.6A7.18 7.18 0 0 0 4.75 12c0 .41.03.81.1 1.2l-2.05 1.6 2 3.46 2.48-1c.64.5 1.33.9 2.06 1.2l.38 2.64h4l.38-2.64c.73-.3 1.42-.7 2.06-1.2l2.48 1 2-3.46-2.05-1.6c.07-.39.1-.79.1-1.2Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
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

function IconChevronDown(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path
        d="M6.75 9.75 12 15.25l5.25-5.5"
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
    case "myday":
      return <IconClipboardCheck className={className} />;
    case "expenses":
      return <IconReceipt className={className} />;
    case "quotes":
      return <IconDocument className={className} />;
    case "pipeline":
      return <IconColumns className={className} />;
    case "outbound":
      return <IconMegaphone className={className} />;
    case "calendar":
      return <IconCalendar className={className} />;
    case "sales-hq":
      return <IconPhone className={className} />;
    case "owner":
      return <IconChart className={className} />;
    case "commissions":
      return <IconReceipt className={className} />;
    case "google-ads":
    case "web-analytics":
    case "marketing":
      return <IconChart className={className} />;
    case "seo":
      return <IconSearch className={className} />;
    case "automation":
      return <IconSpark className={className} />;
    case "policy":
      return <IconShield className={className} />;
    case "access":
      return <IconKey className={className} />;
    case "sales-log":
    case "audit":
      return <IconList className={className} />;
    case "merge":
      return <IconMerge className={className} />;
    case "settings":
      return <IconGear className={className} />;
    case "chat":
      return <IconSpark className={className} />;
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
const GROUPS_STORAGE_KEY = "team.sidebar.groups.collapsed.v1";

export function TeamAppShell(props: {
  activeId: string;
  title: string;
  quickItems: TeamNavItem[];
  groups: TeamNavGroup[];
  access: AccessPills;
  user?: TeamUser | null;
  brand?: TeamBrand;
  classicHref: string;
  children: React.ReactNode;
}): React.ReactElement {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = React.useTransition();
  const [collapsed, setCollapsed] = React.useState(false);
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const [collapsedGroups, setCollapsedGroups] = React.useState<Record<string, boolean>>({});

  React.useEffect(() => {
    const stored = globalThis.localStorage?.getItem(SIDEBAR_STORAGE_KEY);
    if (stored === "1") setCollapsed(true);

    const groupsStored = globalThis.localStorage?.getItem(GROUPS_STORAGE_KEY);
    if (!groupsStored) return;
    try {
      const parsed = JSON.parse(groupsStored) as unknown;
      if (!Array.isArray(parsed)) return;
      setCollapsedGroups(
        parsed.reduce<Record<string, boolean>>((acc, groupId) => {
          if (typeof groupId === "string") acc[groupId] = true;
          return acc;
        }, {})
      );
    } catch {
      // ignore invalid JSON
    }
  }, []);

  const handleToggleCollapse = React.useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      globalThis.localStorage?.setItem(SIDEBAR_STORAGE_KEY, next ? "1" : "0");
      return next;
    });
  }, []);

  const toggleGroupCollapsed = React.useCallback((groupId: string) => {
    setCollapsedGroups((prev) => {
      const next = { ...prev, [groupId]: !prev[groupId] };
      try {
        const collapsedIds = Object.entries(next)
          .filter(([, isCollapsed]) => isCollapsed)
          .map(([id]) => id);
        globalThis.localStorage?.setItem(GROUPS_STORAGE_KEY, JSON.stringify(collapsedIds));
      } catch {
        // ignore persistence issues
      }
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
          <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            {props.brand?.logoPath ? (
              <Image src={props.brand.logoPath} alt="" aria-hidden="true" width={32} height={32} className="h-8 w-8 object-contain" />
            ) : (
              <IconGrid className="h-5 w-5 text-slate-700" />
            )}
          </div>
          {collapsed ? null : (
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
                {props.brand?.shortName ?? "Team"}
              </div>
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
                title={collapsed ? item.label : undefined}
                className={cn(
                  "group flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-primary-200",
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
          {props.groups.map((group) => {
            const isGroupCollapsed = collapsed ? false : Boolean(collapsedGroups[group.id]);
            return (
              <div key={group.id} className="space-y-2">
                {collapsed ? null : (
                  <button
                    type="button"
                    onClick={() => toggleGroupCollapsed(group.id)}
                    className="flex w-full items-center justify-between rounded-2xl px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500 transition hover:bg-white hover:text-slate-700 focus:outline-none focus:ring-2 focus:ring-primary-200"
                    aria-expanded={!isGroupCollapsed}
                  >
                    <span>{group.label}</span>
                    <span
                      className={cn(
                        "inline-flex h-6 w-6 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 transition",
                        isGroupCollapsed ? "rotate-[-90deg]" : "rotate-0"
                      )}
                    >
                      <IconChevronDown className="h-4 w-4" />
                    </span>
                  </button>
                )}
                {isGroupCollapsed ? null : (
                  <div className="space-y-1">
                    {group.items.map((item) => {
                      const active = item.id === props.activeId;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => handleNavigate(item.href)}
                          title={collapsed ? item.label : undefined}
                          className={cn(
                            "group flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-primary-200",
                            active
                              ? "bg-primary-50 text-primary-800 shadow-sm shadow-primary-100/60"
                              : "text-slate-700 hover:bg-white hover:text-slate-900"
                          )}
                          aria-current={active ? "page" : undefined}
                        >
                          <span
                            className={cn(
                              "flex h-9 w-9 items-center justify-center rounded-2xl border",
                              active
                                ? "border-primary-100 bg-white text-primary-700"
                                : "border-slate-200 bg-white text-slate-500 group-hover:text-slate-700"
                            )}
                          >
                            {iconForTab(item.id)}
                          </span>
                          {collapsed ? null : <span className="truncate">{item.label}</span>}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
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
      <div className="flex min-h-screen w-full">
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
            <div className="flex w-full items-center justify-between gap-4 px-4 py-3 sm:px-6">
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
                {isPending ? <span className="text-xs font-semibold text-slate-400">Loading...</span> : null}
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
            <main className="w-full space-y-6 px-4 py-6 sm:px-6 sm:py-8">
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
