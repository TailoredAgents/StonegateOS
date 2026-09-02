"use client";

import * as React from "react";
import type { Route } from "next";
import Link from "next/link";
import {
  ArrowRight,
  Check,
  CheckCircle2,
  Circle,
  LoaderCircle,
  X,
} from "lucide-react";
import { cn } from "@myst-os/ui";
import { partnerPortalFetch } from "../lib/portal-v2";
import { getPartnerPersonaPresentation } from "../lib/persona-presentation";
import {
  PartnerNotice,
  PartnerPanel,
  partnerSecondaryButtonClass,
} from "./PartnerPortalUi";

export type PartnerOnboardingChecklistState = {
  version: 1;
  dismissed: boolean;
  dismissedAt: string | null;
  completedCount: number;
  totalCount: number;
  steps: Array<{
    id:
      | "first_location"
      | "communication_preferences"
      | "proof_defaults"
      | "billing_details"
      | "teammates";
    title: string;
    description: string;
    href: Route;
    completed: boolean;
    completion: "automatic" | "acknowledged";
  }>;
};

type ChecklistResponse = {
  ok: true;
  checklist: PartnerOnboardingChecklistState;
};

export function PartnerOnboardingChecklist({
  initialChecklist,
  initialEtag,
  persona,
}: {
  initialChecklist: PartnerOnboardingChecklistState;
  initialEtag: string;
  persona: string | null;
}) {
  const presentation = getPartnerPersonaPresentation(persona);
  const [checklist, setChecklist] = React.useState(initialChecklist);
  const [etag, setEtag] = React.useState(initialEtag);
  const [busyAction, setBusyAction] = React.useState<string | null>(null);
  const [feedback, setFeedback] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    const result = await partnerPortalFetch<ChecklistResponse>(
      "onboarding-checklist",
    ).catch(() => null);
    if (!result?.ok) return false;
    setChecklist(result.data.checklist);
    const nextEtag = result.response.headers.get("etag");
    if (nextEtag) setEtag(nextEtag);
    return true;
  }, []);

  React.useEffect(() => {
    const refreshAfterReturn = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", refreshAfterReturn);
    document.addEventListener("visibilitychange", refreshAfterReturn);
    return () => {
      window.removeEventListener("focus", refreshAfterReturn);
      document.removeEventListener("visibilitychange", refreshAfterReturn);
    };
  }, [refresh]);

  const update = async (
    action: { action: "complete_step"; step: string } | { action: "dismiss" },
  ) => {
    if (busyAction) return;
    const actionKey =
      action.action === "dismiss" ? "dismiss" : `complete:${action.step}`;
    setBusyAction(actionKey);
    setFeedback(null);
    const result = await partnerPortalFetch<ChecklistResponse>(
      "onboarding-checklist",
      {
        method: "PATCH",
        headers: { "If-Match": etag },
        body: JSON.stringify(action),
      },
    ).catch(() => null);
    setBusyAction(null);
    if (!result?.ok) {
      if (result?.response.status === 412) {
        await refresh();
        setFeedback(
          "This checklist changed in another tab. We refreshed the latest progress.",
        );
      } else {
        setFeedback(
          result?.error.message ??
            "Checklist progress could not be saved. Try again.",
        );
      }
      return;
    }
    setChecklist(result.data.checklist);
    const nextEtag = result.response.headers.get("etag");
    if (nextEtag) setEtag(nextEtag);
  };

  if (checklist.dismissed) return null;

  const complete = checklist.completedCount === checklist.totalCount;
  const percentage = Math.round(
    (checklist.completedCount / Math.max(1, checklist.totalCount)) * 100,
  );

  return (
    <section aria-labelledby="partner-setup-heading">
      <PartnerPanel className="overflow-hidden p-0">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 bg-gradient-to-r from-primary-50 to-white px-5 py-5 sm:px-6">
          <div>
            <div className="flex items-center gap-2">
              <CheckCircle2
                className="h-5 w-5 text-primary-700"
                aria-hidden="true"
              />
              <h2
                id="partner-setup-heading"
                className="text-lg font-semibold text-slate-950"
              >
                {complete ? "Account setup complete" : "Finish account setup"}
              </h2>
            </div>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              {complete
                ? "Your workspace has the essentials for scheduling and handoff."
                : `${checklist.completedCount} of ${checklist.totalCount} setup steps complete`}
            </p>
            {!complete ? (
              <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
                {presentation.onboarding.checklistLead}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => void update({ action: "dismiss" })}
            disabled={Boolean(busyAction)}
            className={cn(
              partnerSecondaryButtonClass,
              "min-h-11 px-3 text-slate-700",
            )}
          >
            {busyAction === "dismiss" ? (
              <LoaderCircle
                className="h-4 w-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : (
              <X className="h-4 w-4" aria-hidden="true" />
            )}
            Dismiss
          </button>
          <div
            className="basis-full overflow-hidden rounded-full bg-slate-200"
            role="progressbar"
            aria-label="Account setup progress"
            aria-valuemin={0}
            aria-valuemax={checklist.totalCount}
            aria-valuenow={checklist.completedCount}
          >
            <div
              className="h-2 rounded-full bg-primary-700 transition-[width] motion-reduce:transition-none"
              style={{ width: `${percentage}%` }}
            />
          </div>
        </div>

        {feedback ? (
          <div className="px-5 pt-4 sm:px-6">
            <PartnerNotice tone="warning">{feedback}</PartnerNotice>
          </div>
        ) : null}

        <ol className="divide-y divide-slate-200">
          {checklist.steps.map((step) => {
            const actionKey = `complete:${step.id}`;
            return (
              <li
                key={step.id}
                className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6"
              >
                <div className="flex min-w-0 items-start gap-3">
                  {step.completed ? (
                    <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-emerald-100 text-emerald-700">
                      <Check className="h-4 w-4" aria-hidden="true" />
                      <span className="sr-only">Complete</span>
                    </span>
                  ) : (
                    <Circle
                      className="mt-0.5 h-6 w-6 shrink-0 text-slate-300"
                      aria-hidden="true"
                    />
                  )}
                  <div>
                    <p
                      className={cn(
                        "font-semibold",
                        step.completed ? "text-slate-600" : "text-slate-950",
                      )}
                    >
                      {step.title}
                    </p>
                    <p className="mt-1 text-sm leading-5 text-slate-600">
                      {step.description}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2 pl-9 sm:pl-0">
                  <Link
                    href={step.href}
                    className={cn(partnerSecondaryButtonClass, "min-h-11")}
                  >
                    {step.completed ? "Review" : "Open"}
                    <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  </Link>
                  {!step.completed && step.completion === "acknowledged" ? (
                    <button
                      type="button"
                      disabled={Boolean(busyAction)}
                      onClick={() =>
                        void update({
                          action: "complete_step",
                          step: step.id,
                        })
                      }
                      className={cn(
                        partnerSecondaryButtonClass,
                        "min-h-11 border-primary-200 text-primary-800",
                      )}
                    >
                      {busyAction === actionKey ? (
                        <LoaderCircle
                          className="h-4 w-4 animate-spin motion-reduce:animate-none"
                          aria-hidden="true"
                        />
                      ) : (
                        <Check className="h-4 w-4" aria-hidden="true" />
                      )}
                      Mark reviewed
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      </PartnerPanel>
    </section>
  );
}
