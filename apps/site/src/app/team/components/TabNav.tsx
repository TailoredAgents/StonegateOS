"use client";

import React from "react";
import { cn } from "@myst-os/ui";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import { teamPermissionMatches } from "@/lib/team-permissions";

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

function hasPermission(permissions: string[], required: string): boolean {
  return permissions.some((permission) =>
    teamPermissionMatches(permission, required),
  );
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
    "flex flex-wrap gap-2 overflow-visible rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-card)] p-2 shadow-[0_18px_36px_var(--team-card-shadow)] backdrop-blur sm:items-center sm:justify-start sm:sticky sm:top-4 z-50",
  item: {
    base: "relative flex min-h-[44px] items-center justify-center rounded-xl border border-transparent px-4 py-2 text-sm font-medium leading-tight transition duration-150 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--team-surface)]",
    active:
      "border-primary-200 bg-[color:var(--team-surface)] text-primary-700 shadow-[0_10px_24px_var(--team-card-shadow)] ring-1 ring-primary-200",
    inactive:
      "text-[color:var(--team-text-muted)] hover:bg-[color:var(--team-surface)] hover:text-primary-700 focus-visible:bg-[color:var(--team-surface)] focus-visible:text-primary-700",
    disabled: "opacity-45",
  },
  label: "relative z-10 whitespace-nowrap",
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
  "aria-label": ariaLabel,
}: TabNavProps) {
  const router = useRouter();
  const [isPending, startTransition] = React.useTransition();
  const [openGroupId, setOpenGroupId] = React.useState<string | null>(null);
  const navRef = React.useRef<HTMLElement>(null);
  const groupTriggerRefs = React.useRef<
    Record<string, HTMLButtonElement | null>
  >({});
  const groupMenuRefs = React.useRef<Record<string, HTMLDivElement | null>>({});

  const describeRequirement = React.useCallback(
    (requires?: TabNavItem["requires"]): string | null => {
      if (!requires) return null;
      const list = Array.isArray(requires) ? requires : [requires];
      const first = list[0];
      if (
        list.length === 1 &&
        typeof first === "string" &&
        isRoleRequirement(first)
      ) {
        if (first === "owner") return "Owner access required";
        if (first === "office") return "Office access required";
        if (first === "crew") return "Crew access required";
      }
      if (list.length === 1 && typeof first === "string")
        return `Requires ${first}`;
      return "Access required";
    },
    [],
  );

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
        items: resolved,
      };
    });

    const leftovers = items.filter((item) => !groupedIds.has(item.id));
    if (leftovers.length > 0) {
      hydrated.push({
        id: "more",
        label: "More",
        itemIds: leftovers.map((item) => item.id),
        items: leftovers,
        variant: "dropdown",
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
    [router],
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

    function handleEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      const closingGroupId = openGroupId;
      if (!closingGroupId) return;
      event.preventDefault();
      setOpenGroupId(null);
      groupTriggerRefs.current[closingGroupId]?.focus();
    }

    document.addEventListener("click", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("click", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [openGroupId]);

  const focusMenuItem = React.useCallback(
    (groupId: string, edge: "first" | "last") => {
      globalThis.requestAnimationFrame(() => {
        const items = Array.from(
          groupMenuRefs.current[groupId]?.querySelectorAll<HTMLButtonElement>(
            '[role="menuitem"]:not(:disabled)',
          ) ?? [],
        );
        const target = edge === "first" ? items[0] : items.at(-1);
        target?.focus();
      });
    },
    [],
  );

  const handleMenuKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>, groupId: string) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpenGroupId(null);
        groupTriggerRefs.current[groupId]?.focus();
        return;
      }
      if (event.key === "Tab") {
        setOpenGroupId(null);
        return;
      }
      if (
        event.key !== "ArrowDown" &&
        event.key !== "ArrowUp" &&
        event.key !== "Home" &&
        event.key !== "End"
      ) {
        return;
      }

      const items = Array.from(
        groupMenuRefs.current[groupId]?.querySelectorAll<HTMLButtonElement>(
          '[role="menuitem"]:not(:disabled)',
        ) ?? [],
      );
      if (items.length === 0) return;
      event.preventDefault();
      const activeIndex = items.findIndex(
        (item) => item === document.activeElement,
      );
      if (event.key === "Home") {
        items[0]?.focus();
        return;
      }
      if (event.key === "End") {
        items.at(-1)?.focus();
        return;
      }
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const nextIndex =
        activeIndex < 0
          ? delta > 0
            ? 0
            : items.length - 1
          : (activeIndex + delta + items.length) % items.length;
      items[nextIndex]?.focus();
    },
    [],
  );

  const mobileAllowedIds = resolvedGroups
    ? resolvedGroups.flatMap((group) =>
        group.items
          .filter((item) => resolveAllowed(item.requires))
          .map((item) => item.id),
      )
    : items
        .filter((item) => resolveAllowed(item.requires))
        .map((item) => item.id);

  const mobileValue = mobileAllowedIds.includes(activeId)
    ? activeId
    : (mobileAllowedIds[0] ?? activeId);

  return (
    <div className="flex flex-col gap-3">
      <div className="sm:hidden">
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          <span className="text-[color:var(--team-text-muted)]">Section</span>
          <select
            className="min-h-[44px] w-full rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] px-3 py-2 text-sm text-[color:var(--team-text)] shadow-sm focus:border-primary-400 focus:outline-none focus:ring-2 focus:ring-primary-200"
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
                    items: group.items.filter((item) =>
                      resolveAllowed(item.requires),
                    ),
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
        aria-busy={isPending}
        ref={navRef}
      >
        {resolvedGroups
          ? resolvedGroups.map((group) => {
              if (group.items.length === 0) {
                return null;
              }

              const isSingle =
                group.variant === "single" ||
                (group.items.length === 1 && group.variant !== "dropdown");
              const groupHasActive = group.items.some(
                (item) => item.id === activeId,
              );
              const allowedItems = group.items.filter((item) =>
                resolveAllowed(item.requires),
              );
              const groupAllowed = allowedItems.length > 0;
              const requiredKinds = new Set<string>();
              group.items.forEach((item) => {
                const req = item.requires;
                if (!req) return;
                (Array.isArray(req) ? req : [req]).forEach((entry) =>
                  requiredKinds.add(entry),
                );
              });
              const requiredRoles = Array.from(requiredKinds).filter(
                (entry): entry is AccessRequirement => isRoleRequirement(entry),
              );
              const hasNonRoleRequirements =
                requiredKinds.size > requiredRoles.length;
              const groupRestricted =
                !groupAllowed && requiredKinds.size > 0
                  ? requiredRoles.length === 1 &&
                    !hasNonRoleRequirements &&
                    requiredKinds.size === 1
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
                  isActive
                    ? teamTabTokens.item.active
                    : teamTabTokens.item.inactive,
                  isRestricted && teamTabTokens.item.disabled,
                );

                return (
                  <a
                    key={group.id}
                    href={item.href}
                    onClick={(event) => {
                      if (isRestricted) event.preventDefault();
                    }}
                    className={className}
                    aria-current={isActive ? "page" : undefined}
                    aria-disabled={isRestricted ? "true" : undefined}
                    data-state={isActive ? "active" : "inactive"}
                    data-access={item.requires ?? "all"}
                    title={
                      !allowed
                        ? (describeRequirement(item.requires) ?? undefined)
                        : undefined
                    }
                  >
                    <span className={teamTabTokens.label}>{group.label}</span>
                  </a>
                );
              }

              const isOpenGroup = openGroupId === group.id;

              return (
                <div key={group.id} className="relative">
                  <button
                    ref={(node) => {
                      groupTriggerRefs.current[group.id] = node;
                    }}
                    id={`tab-group-trigger-${group.id}`}
                    type="button"
                    className={cn(
                      "inline-flex min-h-[44px] items-center gap-2 rounded-xl border px-4 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white",
                      groupHasActive
                        ? "border-primary-200 bg-white text-primary-700 shadow-[0_10px_24px_rgba(15,23,42,0.12)] ring-1 ring-primary-200"
                        : "border-slate-200/70 bg-white/70 text-slate-700 hover:border-primary-200 hover:text-primary-700",
                      !groupAllowed && "cursor-not-allowed opacity-45",
                    )}
                    onClick={() => {
                      if (!groupAllowed) {
                        return;
                      }
                      setOpenGroupId((value) =>
                        value === group.id ? null : group.id,
                      );
                    }}
                    onKeyDown={(event) => {
                      if (!groupAllowed) return;
                      if (event.key === "ArrowDown") {
                        event.preventDefault();
                        setOpenGroupId(group.id);
                        focusMenuItem(group.id, "first");
                      } else if (event.key === "ArrowUp") {
                        event.preventDefault();
                        setOpenGroupId(group.id);
                        focusMenuItem(group.id, "last");
                      } else if (event.key === "Escape" && isOpenGroup) {
                        event.preventDefault();
                        setOpenGroupId(null);
                      }
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
                        isOpenGroup ? "rotate-180" : "rotate-0",
                      )}
                    />
                  </button>
                  <div
                    ref={(node) => {
                      groupMenuRefs.current[group.id] = node;
                    }}
                    id={`tab-group-${group.id}`}
                    className={cn(
                      "absolute left-0 top-full z-[70] mt-2 min-w-[12rem] rounded-2xl border border-slate-200 bg-white p-2 shadow-xl shadow-slate-200/60",
                      isOpenGroup ? "block" : "hidden",
                    )}
                    role="menu"
                    aria-labelledby={`tab-group-trigger-${group.id}`}
                    hidden={!isOpenGroup}
                    onKeyDown={(event) => handleMenuKeyDown(event, group.id)}
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
                            "flex min-h-[44px] w-full items-center justify-between rounded-xl px-3 py-2 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500",
                            isActive
                              ? "bg-primary-50 text-primary-700"
                              : "text-slate-600 hover:bg-slate-100",
                            !allowed && "cursor-not-allowed opacity-45",
                          )}
                          title={
                            !allowed
                              ? (describeRequirement(item.requires) ??
                                undefined)
                              : undefined
                          }
                          role="menuitem"
                        >
                          <span>{item.label}</span>
                          {isActive ? (
                            <span className="text-[10px] font-semibold uppercase text-primary-600">
                              Active
                            </span>
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
                isActive
                  ? teamTabTokens.item.active
                  : teamTabTokens.item.inactive,
                isRestricted && teamTabTokens.item.disabled,
              );

              return (
                <a
                  key={item.id}
                  href={item.href}
                  onClick={(event) => {
                    if (isRestricted) event.preventDefault();
                  }}
                  className={className}
                  aria-current={isActive ? "page" : undefined}
                  aria-disabled={isRestricted ? "true" : undefined}
                  data-state={isActive ? "active" : "inactive"}
                  data-access={item.requires ?? "all"}
                  title={
                    !allowed
                      ? (describeRequirement(item.requires) ?? undefined)
                      : undefined
                  }
                >
                  <span className={teamTabTokens.label}>{item.label}</span>
                </a>
              );
            })}
      </nav>
      {isPending ? (
        <p
          className="px-1 text-xs text-slate-500"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          Loading section...
        </p>
      ) : null}
    </div>
  );
}
