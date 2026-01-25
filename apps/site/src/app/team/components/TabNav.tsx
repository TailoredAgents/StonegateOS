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

type AccessRequirement = "owner" | "office" | "crew";

function isRoleRequirement(value: string): value is AccessRequirement {
  return value === "owner" || value === "office" || value === "crew";
}

function permissionMatches(granted: string, required: string): boolean {
  if (granted === "*") return true;
  if (required === "read") return granted === "read";
  if (granted === "read") {
    return required === "read" || required.endsWith(".read");
  }
  if (granted.endsWith(".*")) {
    const prefix = granted.slice(0, -2);
    return required.startsWith(prefix);
  }
  return granted === required;
}

function hasPermission(permissions: string[], required: string): boolean {
  return permissions.some((permission) => permissionMatches(permission, required));
}

export interface TabNavItem {
  id: string;
  label: string;
  href: string;
  requires?: string | string[];
}

export interface TabNavGroup {
  id: string;
  label: string;
  itemIds: string[];
  variant?: "dropdown" | "single";
}

export const teamTabTokens = {
  container:
    "flex flex-wrap gap-2 overflow-visible rounded-2xl border border-slate-200/80 bg-white/80 p-2 shadow-sm shadow-slate-200/50 backdrop-blur supports-[backdrop-filter]:bg-white/60 sm:items-center sm:justify-start sm:sticky sm:top-4 z-50",
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
  groups?: TabNavGroup[];
  activeId: string;
  hasOwner: boolean;
  hasCrew: boolean;
  hasOffice?: boolean;
  permissions?: string[];
  "aria-label"?: string;
}

export function TabNav({
  items,
  groups,
  activeId,
  hasCrew,
  hasOwner,
  hasOffice = false,
  permissions = [],
  "aria-label": ariaLabel
}: TabNavProps) {
  const router = useRouter();
  const [isPending, startTransition] = React.useTransition();
  const [openGroupId, setOpenGroupId] = React.useState<string | null>(null);
  const navRef = React.useRef<HTMLElement>(null);

  const describeRequirement = React.useCallback((requires?: TabNavItem["requires"]): string | null => {
    if (!requires) return null;
    const list = Array.isArray(requires) ? requires : [requires];
    const first = list[0];
    if (list.length === 1 && typeof first === "string" && isRoleRequirement(first)) {
      if (first === "owner") return "Owner access required";
      if (first === "office") return "Office access required";
      if (first === "crew") return "Crew access required";
    }
    if (list.length === 1 && typeof first === "string") return `Requires ${first}`;
    return "Access required";
  }, []);

  const resolveAllowed = (requires?: TabNavItem["requires"]): boolean => {
    if (!requires) return true;
    const list = Array.isArray(requires) ? requires : [requires];
    return list.some((entry) => {
      if (isRoleRequirement(entry)) {
        if (entry === "owner") return hasOwner;
        if (entry === "office") return hasOffice || hasOwner;
        if (entry === "crew") return hasCrew || hasOwner;
        return false;
      }
      if (hasOwner) return true;
      return hasPermission(permissions, entry);
    });
  };

  const resolvedGroups = React.useMemo(() => {
    if (!groups || groups.length === 0) return null;
    const itemMap = new Map(items.map((item) => [item.id, item]));
    const groupedIds = new Set<string>();
    const hydrated = groups.map((group) => {
      const resolved = group.itemIds
        .map((id) => itemMap.get(id))
        .filter((item): item is TabNavItem => Boolean(item));
      resolved.forEach((item) => groupedIds.add(item.id));
      return {
        ...group,
        items: resolved
      };
    });

    const leftovers = items.filter((item) => !groupedIds.has(item.id));
    if (leftovers.length > 0) {
      hydrated.push({
        id: "more",
        label: "More",
        itemIds: leftovers.map((item) => item.id),
        items: leftovers,
        variant: "dropdown"
      });
    }

    return hydrated;
  }, [groups, items]);

  const handleNavigate = React.useCallback(
    (href: string) => {
      startTransition(() => {
        router.push(href as Route);
      });
    },
    [router]
  );

  React.useEffect(() => {
    setOpenGroupId(null);
  }, [activeId]);

  React.useEffect(() => {
    if (!openGroupId) {
      return;
    }

    function handleClickOutside(event: MouseEvent) {
      if (navRef.current && !navRef.current.contains(event.target as Node)) {
        setOpenGroupId(null);
      }
    }

    document.addEventListener("click", handleClickOutside);
    return () => document.removeEventListener("click", handleClickOutside);
  }, [openGroupId]);

  const mobileAllowedIds = resolvedGroups
    ? resolvedGroups.flatMap((group) =>
        group.items.filter((item) => resolveAllowed(item.requires)).map((item) => item.id)
      )
    : items.filter((item) => resolveAllowed(item.requires)).map((item) => item.id);

  const mobileValue = mobileAllowedIds.includes(activeId) ? activeId : mobileAllowedIds[0] ?? activeId;

  return (
    <div className="flex flex-col gap-3">
      <div className="sm:hidden">
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          <span>Section</span>
          <select
            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-primary-400 focus:outline-none focus:ring-2 focus:ring-primary-200"
            value={mobileValue}
            onChange={(event) => {
              const nextId = event.target.value;
              const item = items.find((candidate) => candidate.id === nextId);
              if (!item) return;
              if (!resolveAllowed(item.requires)) return;
              handleNavigate(item.href);
            }}
          >
            {resolvedGroups
              ? resolvedGroups
                  .map((group) => ({
                    label: group.label,
                    items: group.items.filter((item) => resolveAllowed(item.requires))
                  }))
                  .filter((group) => group.items.length > 0)
                  .map((group) => (
                    <optgroup key={group.label} label={group.label}>
                      {group.items.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.label}
                        </option>
                      ))}
                    </optgroup>
                  ))
              : items
                  .filter((item) => resolveAllowed(item.requires))
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
          </select>
        </label>
      </div>
      <nav
        className={cn(teamTabTokens.container, "hidden sm:flex")}
        aria-label={ariaLabel ?? "Team console sections"}
        ref={navRef}
      >
        {resolvedGroups
          ? resolvedGroups.map((group) => {
              if (group.items.length === 0) {
                return null;
              }

              const isSingle = group.variant === "single" || (group.items.length === 1 && group.variant !== "dropdown");
              const groupHasActive = group.items.some((item) => item.id === activeId);
              const allowedItems = group.items.filter((item) => resolveAllowed(item.requires));
              const groupAllowed = allowedItems.length > 0;
              const requiredKinds = new Set<string>();
              group.items.forEach((item) => {
                const req = item.requires;
                if (!req) return;
                (Array.isArray(req) ? req : [req]).forEach((entry) => requiredKinds.add(entry));
              });
              const requiredRoles = Array.from(requiredKinds).filter((entry): entry is AccessRequirement =>
                isRoleRequirement(entry)
              );
              const hasNonRoleRequirements = requiredKinds.size > requiredRoles.length;
              const groupRestricted =
                !groupAllowed && requiredKinds.size > 0
                  ? requiredRoles.length === 1 && !hasNonRoleRequirements && requiredKinds.size === 1
                    ? requiredRoles[0] === "owner"
                      ? "Owner access required"
                      : requiredRoles[0] === "crew"
                        ? "Crew access required"
                        : "Office access required"
                    : "Access required"
                  : undefined;

              if (isSingle) {
                const item = group.items[0];
                if (!item) {
                  return null;
                }
                const allowed = resolveAllowed(item.requires);
                const isRestricted = !allowed;
                const isActive = item.id === activeId;
                const className = cn(
                  teamTabTokens.item.base,
                  isActive ? teamTabTokens.item.active : teamTabTokens.item.inactive,
                  isRestricted && teamTabTokens.item.disabled
                );

                return (
                  <a
                    key={group.id}
                    href={item.href}
                    className={className}
                    aria-current={isActive ? "page" : undefined}
                    aria-disabled={isRestricted ? "true" : undefined}
                    data-state={isActive ? "active" : "inactive"}
                    data-access={item.requires ?? "all"}
                    title={!allowed ? describeRequirement(item.requires) ?? undefined : undefined}
                  >
                    <span className={teamTabTokens.label}>{group.label}</span>
                  </a>
                );
              }

              const isOpenGroup = openGroupId === group.id;

              return (
                <div key={group.id} className="relative">
                  <button
                    type="button"
                    className={cn(
                      "inline-flex items-center gap-2 rounded-xl border px-4 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white",
                      groupHasActive
                        ? "border-primary-200 bg-white text-primary-700 shadow-[0_10px_24px_rgba(15,23,42,0.12)] ring-1 ring-primary-200"
                        : "border-slate-200/70 bg-white/70 text-slate-700 hover:border-primary-200 hover:text-primary-700",
                      !groupAllowed && "cursor-not-allowed opacity-45"
                    )}
                    onClick={() => {
                      if (!groupAllowed) {
                        return;
                      }
                      setOpenGroupId((value) => (value === group.id ? null : group.id));
                    }}
                    disabled={!groupAllowed}
                    aria-expanded={isOpenGroup}
                    aria-haspopup="menu"
                    aria-controls={`tab-group-${group.id}`}
                    title={!groupAllowed ? groupRestricted : undefined}
                  >
                    <span>{group.label}</span>
                    <ChevronDown
                      className={cn(
                        "h-4 w-4 text-slate-500 transition-transform",
                        isOpenGroup ? "rotate-180" : "rotate-0"
                      )}
                    />
                  </button>
                  <div
                    id={`tab-group-${group.id}`}
                    className={cn(
                      "absolute left-0 top-full z-[70] mt-2 min-w-[12rem] rounded-2xl border border-slate-200 bg-white p-2 shadow-xl shadow-slate-200/60",
                      isOpenGroup ? "block" : "hidden"
                    )}
                    role="menu"
                  >
                    {group.items.map((item) => {
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
                            setOpenGroupId(null);
                            handleNavigate(item.href);
                          }}
                          className={cn(
                            "flex w-full items-center justify-between rounded-xl px-3 py-2 text-sm font-medium transition",
                            isActive ? "bg-primary-50 text-primary-700" : "text-slate-600 hover:bg-slate-100",
                            !allowed && "cursor-not-allowed opacity-45"
                          )}
                          title={!allowed ? describeRequirement(item.requires) ?? undefined : undefined}
                          role="menuitem"
                        >
                          <span>{item.label}</span>
                          {isActive ? (
                            <span className="text-[10px] font-semibold uppercase text-primary-600">Active</span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })
          : items.map((item) => {
              const allowed = resolveAllowed(item.requires);
              const isRestricted = !allowed;
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
                  title={!allowed ? describeRequirement(item.requires) ?? undefined : undefined}
                >
                  <span className={teamTabTokens.label}>{item.label}</span>
                </a>
              );
            })}
      </nav>
      {isPending ? <p className="px-1 text-xs text-slate-500">Loading section...</p> : null}
    </div>
  );
}

