"use client";

import React from "react";
import { cn } from "@myst-os/ui";
import { useRouter } from "next/navigation";
import type { Route } from "next";

function ChevronDown(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path
        d="M6.75 9.75 12 15l5.25-5.25"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

type AccessRequirement = "owner" | "crew";

export interface TabNavItem {
  id: string;
  label: string;
  href: string;
  requires?: AccessRequirement;
}

export const teamTabTokens = {
  container:
    "hidden gap-2 rounded-2xl border border-slate-200/80 bg-white/80 p-2 shadow-sm shadow-slate-200/50 backdrop-blur supports-[backdrop-filter]:bg-white/60 sm:flex sm:flex-wrap sm:items-center sm:justify-start sm:sticky sm:top-4 sm:z-30",
  item: {
    base:
      "relative flex min-h-[44px] items-center justify-center rounded-xl border border-transparent px-4 py-2 text-sm font-medium leading-tight transition duration-150 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white",
    active:
      "border-primary-200 bg-white text-primary-700 shadow-[0_10px_24px_rgba(15,23,42,0.12)] ring-1 ring-primary-200",
    inactive:
      "text-slate-600 hover:bg-white/80 hover:text-primary-700 focus-visible:bg-white focus-visible:text-primary-700",
    disabled: "opacity-45"
  },
  label: "relative z-10 whitespace-nowrap"
};

interface TabNavProps {
  items: TabNavItem[];
  activeId: string;
  hasOwner: boolean;
  hasCrew: boolean;
  "aria-label"?: string;
}

export function TabNav({ items, activeId, hasCrew, hasOwner, "aria-label": ariaLabel }: TabNavProps) {
  const router = useRouter();
  const [isPending, startTransition] = React.useTransition();
  const [isOpen, setIsOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);

  const resolveAllowed = (requires?: AccessRequirement): boolean => {
    if (requires === "owner") {
      return hasOwner;
    }
    if (requires === "crew") {
      return hasCrew || hasOwner;
    }
    return true;
  };

  const activeItem = items.find((item) => item.id === activeId) ?? null;

  const handleNavigate = React.useCallback(
    (href: string) => {
      startTransition(() => {
        router.push(href as Route);
      });
    },
    [router]
  );

  React.useEffect(() => {
    setIsOpen(false);
  }, [activeId]);

  React.useEffect(() => {
    if (!isOpen) {
      return;
    }

    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    document.addEventListener("click", handleClickOutside);
    return () => document.removeEventListener("click", handleClickOutside);
  }, [isOpen]);

  return (
    <div className="flex flex-col gap-3">
      <div className="sm:hidden" ref={containerRef}>
        <button
          type="button"
          className="flex w-full items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-3 text-left text-sm font-medium text-slate-700 shadow-sm transition focus:outline-none focus:ring-2 focus:ring-primary-200"
          onClick={() => setIsOpen((value) => !value)}
          aria-expanded={isOpen}
          aria-label={ariaLabel ?? "Team console sections"}
        >
          <span>{activeItem?.label ?? "Select section"}</span>
          <ChevronDown
            className={cn("h-4 w-4 text-slate-500 transition-transform", isOpen ? "rotate-180" : "rotate-0")}
          />
        </button>
        <div
          className={cn(
            "mt-2 space-y-1 rounded-2xl border border-slate-200 bg-white p-2 shadow-lg shadow-slate-200/70",
            isOpen ? "block" : "hidden"
          )}
        >
          {items.map((item) => {
            const allowed = resolveAllowed(item.requires);
            const isActive = item.id === activeId;
            return (
              <button
                key={item.id}
                type="button"
                disabled={!allowed}
                onClick={() => {
                  if (!allowed) {
                    return;
                  }
                  setIsOpen(false);
                  handleNavigate(item.href);
                }}
                className={cn(
                  "flex w-full items-center justify-between rounded-xl px-3 py-2 text-sm font-medium transition",
                  isActive ? "bg-primary-50 text-primary-700" : "text-slate-600 hover:bg-slate-100",
                  !allowed && "cursor-not-allowed opacity-45"
                )}
              >
                <span>{item.label}</span>
                {isActive ? <span className="text-[10px] font-semibold uppercase text-primary-600">Active</span> : null}
              </button>
            );
          })}
        </div>
        {isPending ? <p className="mt-1 text-xs text-slate-500">Loading section...</p> : null}
      </div>

      <nav className={teamTabTokens.container} aria-label={ariaLabel ?? "Team console sections"}>
        {items.map((item) => {
          const allowed = resolveAllowed(item.requires);
          const isRestricted =
            item.requires === "owner"
              ? !hasOwner
              : item.requires === "crew"
                ? !hasCrew && !hasOwner
                : false;
          const isActive = item.id === activeId;
          const className = cn(
            teamTabTokens.item.base,
            isActive ? teamTabTokens.item.active : teamTabTokens.item.inactive,
            isRestricted && teamTabTokens.item.disabled
          );

          return (
            <a
              key={item.id}
              href={item.href}
              className={className}
              aria-current={isActive ? "page" : undefined}
              aria-disabled={isRestricted ? "true" : undefined}
              data-state={isActive ? "active" : "inactive"}
              data-access={item.requires ?? "all"}
              title={
                !allowed
                  ? item.requires === "owner"
                    ? "Owner access required"
                    : "Crew access required"
                  : undefined
              }
            >
              <span className={teamTabTokens.label}>{item.label}</span>
            </a>
          );
        })}
      </nav>
    </div>
  );
}

