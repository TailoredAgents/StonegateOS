"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRight, Sparkles, X } from "lucide-react";
import { cn } from "@myst-os/ui";
import {
  getPartnerPersonaPresentation,
  type PartnerPersonaTaskId,
} from "../lib/persona-presentation";
import { PartnerPanel, partnerSecondaryButtonClass } from "./PartnerPortalUi";

export function PartnerPersonaOverviewGuide({
  persona,
  visibleTaskIds,
}: {
  persona: string | null;
  visibleTaskIds: readonly PartnerPersonaTaskId[];
}) {
  const presentation = getPartnerPersonaPresentation(persona);
  const storageKey = `partner-persona-overview:${presentation.key}`;
  const [dismissed, setDismissed] = React.useState(false);

  React.useEffect(() => {
    setDismissed(window.sessionStorage.getItem(storageKey) === "dismissed");
  }, [storageKey]);

  const actions = presentation.overview.nextActions.filter((action) =>
    visibleTaskIds.includes(action.id),
  );
  if (dismissed || actions.length === 0) return null;

  const dismiss = (): void => {
    window.sessionStorage.setItem(storageKey, "dismissed");
    setDismissed(true);
  };

  return (
    <section aria-labelledby="partner-persona-next-actions-heading">
      <PartnerPanel className="relative overflow-hidden border-primary-100 bg-gradient-to-br from-primary-50 via-white to-white">
        <div className="flex flex-wrap items-start justify-between gap-4 pr-0 sm:pr-24">
          <div className="max-w-3xl">
            <p className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-primary-700">
              <Sparkles className="h-4 w-4" aria-hidden="true" />
              Suggested shortcuts
            </p>
            <h2
              id="partner-persona-next-actions-heading"
              className="mt-2 text-lg font-semibold text-slate-950"
            >
              {presentation.overview.nextActionHeading}
            </h2>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              {presentation.overview.nextActionLead}
            </p>
          </div>
          <button
            type="button"
            onClick={dismiss}
            className={cn(partnerSecondaryButtonClass, "min-h-11 px-3")}
            aria-label="Dismiss persona suggestions"
          >
            <X className="h-4 w-4" aria-hidden="true" />
            Dismiss
          </button>
        </div>
        <ul className="mt-5 grid gap-3 md:grid-cols-3">
          {actions.map((action) => (
            <li key={action.id} className="min-w-0">
              <Link
                href={action.href}
                className="flex h-full min-h-11 flex-col rounded-xl border border-primary-100 bg-white p-4 shadow-sm transition hover:border-primary-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
              >
                <span className="font-semibold text-slate-950">
                  {action.label}
                </span>
                <span className="mt-1 text-sm leading-5 text-slate-600">
                  {action.description}
                </span>
                <span className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-primary-800">
                  Start
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </span>
              </Link>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs leading-5 text-slate-600">
          These shortcuts are based on how your team uses Stonegate. Suggestions
          change presentation only; they do not change your account access.
        </p>
      </PartnerPanel>
    </section>
  );
}
