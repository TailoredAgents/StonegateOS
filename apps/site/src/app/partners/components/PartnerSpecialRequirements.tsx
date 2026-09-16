"use client";

import * as React from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@myst-os/ui";
import {
  PARTNER_EQUIPMENT_OPTIONS,
  PARTNER_HAZARD_OPTIONS,
} from "../lib/partner-booking-add-ons";
import { partnerFieldClass } from "./PartnerPortalUi";

export type PartnerSpecialRequirementsValues = {
  itemCount: string;
  volume: string;
  restrictedItems: boolean;
  nonStandard: boolean;
  hazardCategories: string[];
  equipmentNeeds: string[];
  requiredCompletionDate: string;
  requiredCompletionTime: string;
  multiStop: boolean;
  multiStopDetails: string;
};

function RequirementGroup({
  title,
  summary,
  added,
  errors,
  validationErrors,
  errorId,
  children,
}: {
  title: string;
  summary: string;
  added: boolean;
  errors: string[];
  validationErrors: Record<string, string>;
  errorId: string;
  children: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDetailsElement>(null);
  const hasErrors = errors.length > 0;
  React.useEffect(() => {
    // A new validation result can reopen an error; editing never closes a group.
    if (hasErrors && ref.current) ref.current.open = true;
  }, [hasErrors, validationErrors]);

  return (
    <details
      ref={ref}
      className="group/requirement border-b border-slate-200 last:border-b-0"
    >
      <summary className="flex min-h-16 cursor-pointer list-none items-center gap-3 rounded-lg px-3 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 sm:px-4 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-slate-900">
            {title}
          </span>
          <span
            className={cn(
              "mt-0.5 block truncate text-xs",
              added ? "text-primary-800" : "text-slate-500",
            )}
            title={summary}
          >
            {summary}
          </span>
        </span>
        {added ? (
          <Check
            className="h-4 w-4 shrink-0 text-primary-700"
            aria-hidden="true"
          />
        ) : null}
        <ChevronDown
          className="h-4 w-4 shrink-0 text-slate-500 transition-transform group-open/requirement:rotate-180 motion-reduce:transition-none"
          aria-hidden="true"
        />
      </summary>
      <div className="space-y-4 px-3 pb-4 pt-1 sm:px-4">
        {children}
        {errors.length ? (
          <div
            id={errorId}
            className="space-y-1 text-sm font-medium text-rose-700"
          >
            {errors.map((error) => (
              <p key={error}>{error}</p>
            ))}
          </div>
        ) : null}
      </div>
    </details>
  );
}

function Choice({
  id,
  label,
  checked,
  onChange,
  errorId,
}: {
  id?: string;
  label: string;
  checked: boolean;
  errorId?: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center gap-3 py-1.5 text-sm leading-5 text-slate-800">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        aria-invalid={errorId ? true : undefined}
        aria-describedby={errorId}
        onChange={(event) => onChange(event.target.checked)}
        className="h-5 w-5 shrink-0 rounded border-slate-300 text-primary-700 accent-primary-700 focus:ring-primary-500"
      />
      <span>{label}</span>
    </label>
  );
}

function selectedSummary(
  keys: string[],
  options: readonly { key: string; label: string }[],
): string {
  return options
    .filter((option) => keys.includes(option.key))
    .map((option) => option.label)
    .join(" · ");
}

function deadlineSummary(date: string, time: string): string {
  if (!date)
    return time
      ? "Add a date for your completion time"
      : "Add a deadline if the work is time-sensitive";
  const parsed = new Date(`${date}T12:00:00Z`);
  const day = Number.isFinite(parsed.getTime())
    ? new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      }).format(parsed)
    : date;
  const [hour, minute] = time.split(":");
  return time
    ? `${day} · ${Number(hour) % 12 || 12}:${minute} ${Number(hour) >= 12 ? "PM" : "AM"}`
    : day;
}

export function PartnerSpecialRequirements({
  value,
  onChange,
  fieldErrors,
}: {
  value: PartnerSpecialRequirementsValues;
  onChange: <K extends keyof PartnerSpecialRequirementsValues>(
    key: K,
    value: PartnerSpecialRequirementsValues[K],
  ) => void;
  fieldErrors: Record<string, string>;
}) {
  const errorsFor = (...fields: string[]) => [
    ...new Set(
      Object.entries(fieldErrors)
        .filter(([path]) =>
          fields.some(
            (field) =>
              path === `scope.${field}` ||
              path.startsWith(`scope.${field}.`) ||
              path.startsWith(`scope.${field}[`),
          ),
        )
        .map(([, message]) => message),
    ),
  ];
  const equipmentSummary = [
    value.nonStandard ? "Heavy items or unusual work" : "",
    selectedSummary(value.equipmentNeeds, PARTNER_EQUIPMENT_OPTIONS),
  ]
    .filter(Boolean)
    .join(" · ");
  const materialsSummary =
    selectedSummary(value.hazardCategories, PARTNER_HAZARD_OPTIONS) ||
    (value.restrictedItems
      ? "Special handling needed"
      : "Paint, chemicals, batteries, or unknown materials");
  const quantitySummary = [
    value.itemCount
      ? `${value.itemCount} ${Number(value.itemCount) === 1 ? "item" : "items"}`
      : "",
    value.volume ? `${value.volume} cubic yards` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const toggleSelection = (
    key: "equipmentNeeds" | "hazardCategories",
    option: string,
    checked: boolean,
  ) =>
    onChange(
      key,
      checked
        ? [...value[key], option]
        : value[key].filter((item) => item !== option),
    );

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">
        Add only what applies. You can skip this section.
      </p>
      <div className="rounded-xl border border-slate-200 bg-slate-50/50">
        <RequirementGroup
          validationErrors={fieldErrors}
          errorId="partner-book-handling-error"
          title="Handling and access"
          summary={
            equipmentSummary || "Heavy items, stairs, or equipment needs"
          }
          added={Boolean(value.nonStandard || value.equipmentNeeds.length)}
          errors={errorsFor("nonStandard", "equipmentNeeds")}
        >
          <Choice
            id="partner-book-non-standard"
            errorId={
              errorsFor("nonStandard").length
                ? "partner-book-handling-error"
                : undefined
            }
            label="Heavy items or unusual work"
            checked={value.nonStandard}
            onChange={(checked) => onChange("nonStandard", checked)}
          />
          <fieldset
            id="partner-book-equipment"
            aria-invalid={Boolean(errorsFor("equipmentNeeds").length)}
            aria-describedby={
              errorsFor("equipmentNeeds").length
                ? "partner-book-handling-error"
                : undefined
            }
            tabIndex={-1}
            className="border-t border-slate-200 pt-2"
          >
            <legend className="text-xs font-semibold text-slate-600">
              Access and equipment needed
            </legend>
            <div className="grid gap-x-5 sm:grid-cols-2">
              {PARTNER_EQUIPMENT_OPTIONS.map((option) => (
                <Choice
                  key={option.key}
                  label={option.label}
                  checked={value.equipmentNeeds.includes(option.key)}
                  onChange={(checked) =>
                    toggleSelection("equipmentNeeds", option.key, checked)
                  }
                />
              ))}
            </div>
          </fieldset>
        </RequirementGroup>
        <RequirementGroup
          validationErrors={fieldErrors}
          errorId="partner-book-materials-error"
          title="Materials needing review"
          summary={materialsSummary}
          added={Boolean(
            value.restrictedItems || value.hazardCategories.length,
          )}
          errors={errorsFor("restrictedItems", "hazardCategories")}
        >
          <p className="text-xs leading-5 text-slate-600">
            Select any that may be present. Stonegate will confirm what can be
            collected.
          </p>
          <Choice
            id="partner-book-restricted-items"
            errorId={
              errorsFor("restrictedItems").length
                ? "partner-book-materials-error"
                : undefined
            }
            label="Materials needing special handling"
            checked={value.restrictedItems}
            onChange={(checked) => onChange("restrictedItems", checked)}
          />
          <fieldset
            id="partner-book-materials"
            aria-invalid={Boolean(errorsFor("hazardCategories").length)}
            aria-describedby={
              errorsFor("hazardCategories").length
                ? "partner-book-materials-error"
                : undefined
            }
            tabIndex={-1}
            className="border-t border-slate-200 pt-2"
          >
            <legend className="text-xs font-semibold text-slate-600">
              Material types
            </legend>
            <div className="grid gap-x-5 sm:grid-cols-2">
              {PARTNER_HAZARD_OPTIONS.map((option) => (
                <Choice
                  key={option.key}
                  label={option.label}
                  checked={value.hazardCategories.includes(option.key)}
                  onChange={(checked) =>
                    toggleSelection("hazardCategories", option.key, checked)
                  }
                />
              ))}
            </div>
          </fieldset>
        </RequirementGroup>
        <RequirementGroup
          validationErrors={fieldErrors}
          errorId="partner-book-deadline-error"
          title="Completion deadline"
          summary={deadlineSummary(
            value.requiredCompletionDate,
            value.requiredCompletionTime,
          )}
          added={Boolean(
            value.requiredCompletionDate || value.requiredCompletionTime,
          )}
          errors={errorsFor("requiredCompletion")}
        >
          <p className="text-xs leading-5 text-slate-600">
            Stonegate will review this deadline. Choose your preferred service
            date in Scheduling.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <label
              htmlFor="partner-book-required-date"
              className="text-sm font-semibold text-slate-700"
            >
              Complete by date
              <input
                id="partner-book-required-date"
                type="date"
                value={value.requiredCompletionDate}
                onChange={(event) =>
                  onChange("requiredCompletionDate", event.target.value)
                }
                className={partnerFieldClass}
                aria-invalid={Boolean(
                  fieldErrors["scope.requiredCompletion"] ||
                    errorsFor("requiredCompletion.localDate").length,
                )}
                aria-describedby={
                  fieldErrors["scope.requiredCompletion"] ||
                  errorsFor("requiredCompletion.localDate").length
                    ? "partner-book-deadline-error"
                    : undefined
                }
              />
            </label>
            <label
              htmlFor="partner-book-required-time"
              className="text-sm font-semibold text-slate-700"
            >
              Time{" "}
              <span className="font-normal text-slate-500">(optional)</span>
              <input
                id="partner-book-required-time"
                type="time"
                aria-invalid={Boolean(
                  errorsFor("requiredCompletion.localTime").length,
                )}
                aria-describedby={
                  errorsFor("requiredCompletion.localTime").length
                    ? "partner-book-deadline-error"
                    : undefined
                }
                value={value.requiredCompletionTime}
                onChange={(event) =>
                  onChange("requiredCompletionTime", event.target.value)
                }
                disabled={
                  !value.requiredCompletionDate && !value.requiredCompletionTime
                }
                className={partnerFieldClass}
              />
            </label>
          </div>
        </RequirementGroup>
        <RequirementGroup
          validationErrors={fieldErrors}
          errorId="partner-book-stops-error"
          title="Additional stops"
          summary={
            value.multiStop
              ? value.multiStopDetails.trim() || "More than one service stop"
              : "Add another pickup or service address"
          }
          added={value.multiStop}
          errors={errorsFor("multiStop", "multiStopDetails")}
        >
          <Choice
            id="partner-book-multi-stop"
            errorId={
              errorsFor("multiStop").length
                ? "partner-book-stops-error"
                : undefined
            }
            label="More than one service stop"
            checked={value.multiStop}
            onChange={(checked) => onChange("multiStop", checked)}
          />
          {value.multiStop ? (
            <label
              className="block text-sm font-semibold text-slate-700"
              htmlFor="partner-book-multi-stop-details"
            >
              Stops and sequence
              <textarea
                id="partner-book-multi-stop-details"
                value={value.multiStopDetails}
                onChange={(event) =>
                  onChange("multiStopDetails", event.target.value)
                }
                rows={3}
                aria-invalid={Boolean(errorsFor("multiStopDetails").length)}
                aria-describedby={
                  errorsFor("multiStopDetails").length
                    ? "partner-book-stops-error"
                    : undefined
                }
                maxLength={1000}
                className={partnerFieldClass}
                placeholder="List the addresses and the order of stops."
              />
            </label>
          ) : null}
        </RequirementGroup>
        <RequirementGroup
          validationErrors={fieldErrors}
          errorId="partner-book-quantity-error"
          title="Quantity estimate"
          summary={quantitySummary || "Item count or volume, if known"}
          added={Boolean(value.itemCount || value.volume)}
          errors={errorsFor("itemCount", "volumeCubicYards")}
        >
          <p className="text-xs leading-5 text-slate-600">
            Use either estimate if you know it.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <label
              htmlFor="partner-book-item-count"
              className="text-sm font-semibold text-slate-700"
            >
              Approximate item count
              <input
                id="partner-book-item-count"
                type="number"
                min="0"
                step="1"
                inputMode="numeric"
                value={value.itemCount}
                onChange={(event) => onChange("itemCount", event.target.value)}
                className={partnerFieldClass}
                aria-invalid={Boolean(errorsFor("itemCount").length)}
                aria-describedby={
                  errorsFor("itemCount").length
                    ? "partner-book-quantity-error"
                    : undefined
                }
              />
            </label>
            <label
              htmlFor="partner-book-volume"
              className="text-sm font-semibold text-slate-700"
            >
              Estimated volume{" "}
              <span className="font-normal text-slate-500">(cubic yards)</span>
              <input
                id="partner-book-volume"
                type="number"
                min="0"
                step="0.5"
                inputMode="decimal"
                value={value.volume}
                onChange={(event) => onChange("volume", event.target.value)}
                className={partnerFieldClass}
                aria-invalid={Boolean(errorsFor("volumeCubicYards").length)}
                aria-describedby={
                  errorsFor("volumeCubicYards").length
                    ? "partner-book-quantity-error"
                    : undefined
                }
              />
            </label>
          </div>
        </RequirementGroup>
      </div>
    </div>
  );
}
