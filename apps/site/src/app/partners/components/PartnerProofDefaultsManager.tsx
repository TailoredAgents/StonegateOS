"use client";

import * as React from "react";
import { Camera, CheckCircle2, LoaderCircle } from "lucide-react";
import { cn } from "@myst-os/ui";
import { partnerPortalFetch } from "../lib/portal-v2";
import {
  PartnerNotice,
  PartnerPanel,
  partnerFieldClass,
  partnerPrimaryButtonClass,
} from "./PartnerPortalUi";

const CATEGORIES = [
  {
    key: "intake",
    label: "Intake",
    description: "Condition and scope supplied before arrival.",
  },
  {
    key: "before",
    label: "Before",
    description: "Starting condition before work begins.",
  },
  {
    key: "after",
    label: "After",
    description: "Final condition after the work is complete.",
  },
  {
    key: "completion",
    label: "Completion",
    description: "Additional completion or handoff evidence.",
  },
  {
    key: "issue",
    label: "Issue",
    description: "Exceptions, damage, or blocked work.",
  },
  {
    key: "document",
    label: "Document",
    description: "Receipts, manifests, or other job documents.",
  },
] as const;

type Category = (typeof CATEGORIES)[number]["key"];

export type PartnerProofDefault = {
  id?: string;
  category: Category;
  required: boolean;
  minimumCount: number;
  source?: string;
  updatedAt?: string;
};

function normalizedDefaults(
  requirements: readonly PartnerProofDefault[],
): PartnerProofDefault[] {
  const byCategory = new Map(
    requirements.map((requirement) => [requirement.category, requirement]),
  );
  return CATEGORIES.map(({ key }) => {
    const existing = byCategory.get(key);
    if (existing) return { ...existing };
    const required = key === "before" || key === "after";
    return {
      category: key,
      required,
      minimumCount: required ? 1 : 0,
      source: "launch_default",
    };
  });
}

function comparable(requirements: readonly PartnerProofDefault[]): string {
  return JSON.stringify(
    requirements.map(({ category, required, minimumCount }) => ({
      category,
      required,
      minimumCount,
    })),
  );
}

export function PartnerProofDefaultsManager({
  requirements,
  etag,
  canEdit,
}: {
  requirements: PartnerProofDefault[];
  etag: string;
  canEdit: boolean;
}) {
  const initial = React.useMemo(
    () => normalizedDefaults(requirements),
    [requirements],
  );
  const [rows, setRows] = React.useState(initial);
  const [currentEtag, setCurrentEtag] = React.useState(etag);
  const [saving, setSaving] = React.useState(false);
  const [feedback, setFeedback] = React.useState<{
    tone: "success" | "error";
    message: string;
  } | null>(null);
  const baselineRef = React.useRef(comparable(initial));
  const changed = comparable(rows) !== baselineRef.current;

  React.useEffect(() => {
    if (!changed) return;
    const protect = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [changed]);

  const update = (
    category: Category,
    patch: Partial<Pick<PartnerProofDefault, "required" | "minimumCount">>,
  ) => {
    setRows((current) =>
      current.map((row) =>
        row.category === category ? { ...row, ...patch } : row,
      ),
    );
    setFeedback(null);
  };

  const save = async () => {
    if (!canEdit || !changed || saving) return;
    setSaving(true);
    setFeedback(null);
    const result = await partnerPortalFetch<{
      ok: true;
      requirements: PartnerProofDefault[];
    }>("proof-requirements", {
      method: "PATCH",
      headers: { "If-Match": currentEtag },
      body: JSON.stringify({
        requirements: rows.map(({ category, required, minimumCount }) => ({
          category,
          required,
          minimumCount: required ? minimumCount : 0,
        })),
      }),
    }).catch(() => null);
    setSaving(false);
    if (!result?.ok) {
      setFeedback({
        tone: "error",
        message:
          result?.error.message ??
          "Proof defaults were not saved. Refresh and try again.",
      });
      return;
    }
    const next = normalizedDefaults(result.data.requirements);
    const nextEtag = result.response.headers.get("etag");
    setRows(next);
    baselineRef.current = comparable(next);
    if (nextEtag) setCurrentEtag(nextEtag);
    setFeedback({
      tone: "success",
      message: "Default proof requirements saved for future jobs.",
    });
  };

  return (
    <PartnerPanel
      className="space-y-5"
      data-partner-unsaved={changed ? "true" : undefined}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Camera className="h-5 w-5 text-primary-700" aria-hidden="true" />
            <h2 className="text-lg font-semibold text-slate-950">
              Default photo requirements
            </h2>
          </div>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
            Set the usual photo requirements once. New bookings start with these
            choices, and an authorized scheduler can still adjust a specific
            job.
          </p>
        </div>
        {!canEdit ? (
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700 ring-1 ring-slate-200">
            Read only
          </span>
        ) : null}
      </div>

      {feedback ? (
        <PartnerNotice tone={feedback.tone}>{feedback.message}</PartnerNotice>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {CATEGORIES.map((category) => {
          const row = rows.find((item) => item.category === category.key)!;
          const countId = `partner-proof-default-${category.key}`;
          return (
            <div
              key={category.key}
              className={cn(
                "rounded-2xl border p-4",
                row.required
                  ? "border-primary-300 bg-primary-50/60"
                  : "border-slate-200 bg-white",
              )}
            >
              <label className="flex min-h-11 cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  checked={row.required}
                  disabled={!canEdit || saving}
                  onChange={(event) =>
                    update(category.key, {
                      required: event.target.checked,
                      minimumCount: event.target.checked
                        ? Math.max(1, row.minimumCount)
                        : 0,
                    })
                  }
                  className="mt-0.5 h-5 w-5 rounded border-slate-300 text-primary-700 disabled:cursor-not-allowed"
                />
                <span>
                  <span className="block font-semibold text-slate-950">
                    {category.label}
                  </span>
                  <span className="mt-1 block text-sm leading-5 text-slate-600">
                    {category.description}
                  </span>
                </span>
              </label>
              {row.required ? (
                <label
                  htmlFor={countId}
                  className="mt-3 block text-xs font-semibold text-slate-700"
                >
                  Minimum files
                  <input
                    id={countId}
                    type="number"
                    min={1}
                    max={40}
                    step={1}
                    inputMode="numeric"
                    disabled={!canEdit || saving}
                    value={row.minimumCount}
                    onChange={(event) =>
                      update(category.key, {
                        minimumCount: Math.min(
                          40,
                          Math.max(1, Number(event.target.value) || 1),
                        ),
                      })
                    }
                    className={cn(partnerFieldClass, "mt-1")}
                  />
                </label>
              ) : null}
            </div>
          );
        })}
      </div>

      {canEdit ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-4">
          <span
            className="text-sm text-slate-600"
            role="status"
            aria-live="polite"
          >
            {changed
              ? "Photo defaults have unsaved changes"
              : "Photo defaults saved"}
          </span>
          <button
            type="button"
            onClick={() => void save()}
            disabled={!changed || saving}
            className={partnerPrimaryButtonClass}
          >
            {saving ? (
              <LoaderCircle
                className="h-4 w-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : (
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            )}
            {saving ? "Saving…" : "Save photo defaults"}
          </button>
        </div>
      ) : null}
    </PartnerPanel>
  );
}
