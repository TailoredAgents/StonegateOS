"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@myst-os/ui";
import {
  PARTNER_EQUIPMENT_OPTIONS,
  PARTNER_HAZARD_OPTIONS,
} from "../lib/partner-booking-add-ons";
import { partnerFieldClass } from "./PartnerPortalUi";

export type PartnerRequestScopeValues = {
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

export type PartnerRequestQuestionProps = {
  value: PartnerRequestScopeValues;
  onChange: <K extends keyof PartnerRequestScopeValues>(
    key: K,
    value: PartnerRequestScopeValues[K],
  ) => void;
  fieldErrors: Record<string, string>;
};

const WORK_OPTIONS = [
  {
    key: "heavy_lift",
    id: "partner-book-heavy-items",
    label: "Very heavy or oversized items",
  },
  {
    key: "disassembly",
    id: "partner-book-disassembly",
    label: "Items need to be taken apart",
  },
] as const;

const ACCESS_OPTIONS = [
  { key: "stairs", label: "Stairs" },
  { key: "elevator", label: "Elevator" },
  { key: "loading_dock", label: "Loading dock" },
] as const;

// Customer wording only. Persisted keys and staff-facing catalog labels stay unchanged.
const MATERIAL_LABELS: Record<
  (typeof PARTNER_HAZARD_OPTIONS)[number]["key"],
  string
> = {
  chemicals: "Chemicals or solvents",
  paint: "Paint",
  fuel_oil: "Fuel or oil",
  batteries: "Batteries",
  pressurized: "Propane tanks or other pressurized containers",
  biohazard: "Sharps or contaminated materials",
  asbestos_lead: "Known or suspected asbestos or lead",
  unknown: "Not sure / unknown materials",
};

function errorsFor(
  fieldErrors: Record<string, string>,
  ...fields: string[]
): string[] {
  return [
    ...new Set(
      Object.entries(fieldErrors)
        .filter(([rawPath]) => {
          const path = rawPath.replace(/\[(\d+)\]/gu, ".$1");
          return fields.some(
            (field) =>
              path === `scope.${field}` || path.startsWith(`scope.${field}.`),
          );
        })
        .map(([, message]) => message),
    ),
  ];
}

function submittedEquipmentKeys(value: PartnerRequestScopeValues): string[] {
  return [...new Set(value.equipmentNeeds)]
    .filter((key) =>
      PARTNER_EQUIPMENT_OPTIONS.some((option) => option.key === key),
    )
    .sort();
}

function equipmentErrors(
  { value, fieldErrors }: PartnerRequestQuestionProps,
  group: "work" | "access",
): string[] {
  // Validation indices refer to the sorted scope payload, not click order.
  const submittedKeys = submittedEquipmentKeys(value);
  return [
    ...new Set(
      Object.entries(fieldErrors)
        .filter(([rawPath]) => {
          const path = rawPath.replace(/\[(\d+)\]/gu, ".$1");
          if (
            path !== "scope.equipmentNeeds" &&
            !path.startsWith("scope.equipmentNeeds.")
          )
            return false;
          const index = /^scope\.equipmentNeeds\.(\d+)(?:\.|$)/u.exec(
            path,
          )?.[1];
          const key =
            index === undefined ? undefined : submittedKeys[Number(index)];
          const isWorkOption = WORK_OPTIONS.some(
            (option) => option.key === key,
          );
          if (group === "work") return isWorkOption;
          // Older lift-gate/demolition errors belong to Saved request details.
          return (
            key === undefined ||
            ACCESS_OPTIONS.some((option) => option.key === key)
          );
        })
        .map(([, message]) => message),
    ),
  ];
}

function toggleOption(
  props: PartnerRequestQuestionProps,
  field: "equipmentNeeds" | "hazardCategories",
  key: string,
  checked: boolean,
): void {
  const current = props.value[field];
  // Change only this selection; the other question and older saved options share this array.
  props.onChange(
    field,
    checked
      ? [...new Set([...current, key])]
      : current.filter((item) => item !== key),
  );
}

function QuestionErrors({ id, errors }: { id: string; errors: string[] }) {
  return errors.length ? (
    <div id={id} className="space-y-1 text-sm font-medium text-rose-700">
      {errors.map((error) => (
        <p key={error}>{error}</p>
      ))}
    </div>
  ) : null;
}

function Choice({
  id,
  label,
  checked,
  onChange,
  errorId,
  equipmentIndex,
  equipmentSection,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  errorId?: string;
  equipmentIndex?: number;
  equipmentSection?: "service" | "contact";
}) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center gap-3 py-1.5 text-sm leading-5 text-slate-800">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        aria-invalid={errorId ? true : undefined}
        aria-describedby={errorId}
        data-partner-equipment-index={
          equipmentIndex !== undefined && equipmentIndex >= 0
            ? equipmentIndex
            : undefined
        }
        data-partner-equipment-section={equipmentSection}
        className="h-5 w-5 shrink-0 rounded border-slate-300 accent-primary-700 focus:ring-primary-500"
      />
      <span>{label}</span>
    </label>
  );
}

function OptionalQuestion({
  id,
  title,
  summary,
  added,
  errors,
  fieldErrors,
  errorId,
  children,
}: {
  id: string;
  title: string;
  summary: string;
  added: boolean;
  errors: string[];
  fieldErrors: Record<string, string>;
  errorId: string;
  children: React.ReactNode;
}) {
  const detailsRef = React.useRef<HTMLDetailsElement>(null);
  const hasErrors = errors.length > 0;
  React.useEffect(() => {
    // Native state avoids delayed WebKit toggle events undoing validation-driven opens.
    if (hasErrors && detailsRef.current) detailsRef.current.open = true;
  }, [hasErrors, fieldErrors]);

  return (
    <details
      id={id}
      ref={detailsRef}
      tabIndex={-1}
      className="group/question border-t border-slate-200"
    >
      <summary className="flex min-h-14 cursor-pointer list-none items-center gap-3 rounded-lg py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-slate-900">
            {title}{" "}
            <span className="font-normal text-slate-500">(optional)</span>
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
        <ChevronDown
          className="h-4 w-4 shrink-0 text-slate-500 transition-transform group-open/question:rotate-180 motion-reduce:transition-none"
          aria-hidden="true"
        />
      </summary>
      <div className="space-y-3 pb-4 pt-1">
        {children}
        <QuestionErrors id={errorId} errors={errors} />
      </div>
    </details>
  );
}

export function PartnerWorkQuestions(props: PartnerRequestQuestionProps) {
  const submittedKeys = submittedEquipmentKeys(props.value);
  const errors = equipmentErrors(props, "work");
  const errorId = errors.length
    ? "partner-book-work-questions-error"
    : undefined;
  return (
    <fieldset
      id="partner-book-work-questions"
      tabIndex={-1}
      aria-invalid={Boolean(errors.length)}
      aria-describedby={errorId}
    >
      <legend className="text-sm font-semibold text-slate-700">
        About the items{" "}
        <span className="font-normal text-slate-500">(optional)</span>
      </legend>
      <div className="mt-1 grid gap-x-5 sm:grid-cols-2">
        {WORK_OPTIONS.map((option) => (
          <Choice
            key={option.key}
            id={option.id}
            label={option.label}
            checked={props.value.equipmentNeeds.includes(option.key)}
            equipmentIndex={submittedKeys.indexOf(option.key)}
            equipmentSection="service"
            errorId={
              errorsFor(
                props.fieldErrors,
                `equipmentNeeds.${submittedKeys.indexOf(option.key)}`,
              ).length
                ? errorId
                : undefined
            }
            onChange={(checked) =>
              toggleOption(props, "equipmentNeeds", option.key, checked)
            }
          />
        ))}
      </div>
      <QuestionErrors id="partner-book-work-questions-error" errors={errors} />
    </fieldset>
  );
}

export function PartnerAccessQuestions(props: PartnerRequestQuestionProps) {
  const submittedKeys = submittedEquipmentKeys(props.value);
  const errors = equipmentErrors(props, "access");
  const errorId = errors.length ? "partner-book-equipment-error" : undefined;
  return (
    <fieldset
      id="partner-book-equipment"
      tabIndex={-1}
      aria-invalid={Boolean(errors.length)}
      aria-describedby={errorId}
    >
      <legend className="text-sm font-semibold text-slate-700">
        Access at the property{" "}
        <span className="font-normal text-slate-500">(optional)</span>
      </legend>
      <div className="mt-1 grid gap-x-5 sm:grid-cols-3">
        {ACCESS_OPTIONS.map((option) => (
          <Choice
            key={option.key}
            id={`partner-book-access-${option.key}`}
            label={option.label}
            checked={props.value.equipmentNeeds.includes(option.key)}
            equipmentIndex={submittedKeys.indexOf(option.key)}
            equipmentSection="contact"
            errorId={
              errorsFor(
                props.fieldErrors,
                `equipmentNeeds.${submittedKeys.indexOf(option.key)}`,
              ).length
                ? errorId
                : undefined
            }
            onChange={(checked) =>
              toggleOption(props, "equipmentNeeds", option.key, checked)
            }
          />
        ))}
      </div>
      <QuestionErrors id="partner-book-equipment-error" errors={errors} />
    </fieldset>
  );
}

export function PartnerMaterialsQuestion(props: PartnerRequestQuestionProps) {
  const { value, fieldErrors } = props;
  const errors = errorsFor(fieldErrors, "hazardCategories");
  const selected = PARTNER_HAZARD_OPTIONS.filter((option) =>
    value.hazardCategories.includes(option.key),
  ).map((option) => MATERIAL_LABELS[option.key]);
  const summary =
    selected.join(" · ") || "For example: paint, chemicals, or batteries";
  return (
    <OptionalQuestion
      id="partner-book-materials-question"
      title="Any materials we should review?"
      summary={summary}
      added={selected.length > 0}
      errors={errors}
      fieldErrors={fieldErrors}
      errorId="partner-book-materials-error"
    >
      <p className="text-xs leading-5 text-slate-600">
        Select any that may be present. Stonegate will confirm what can be
        collected.
      </p>
      <fieldset
        id="partner-book-materials"
        tabIndex={-1}
        aria-invalid={Boolean(errors.length)}
        aria-describedby={
          errors.length ? "partner-book-materials-error" : undefined
        }
      >
        <legend className="sr-only">Materials to review</legend>
        <div className="grid gap-x-5 sm:grid-cols-2">
          {PARTNER_HAZARD_OPTIONS.map((option) => (
            <Choice
              key={option.key}
              id={`partner-book-material-${option.key}`}
              label={MATERIAL_LABELS[option.key]}
              checked={value.hazardCategories.includes(option.key)}
              onChange={(checked) =>
                toggleOption(props, "hazardCategories", option.key, checked)
              }
            />
          ))}
        </div>
      </fieldset>
    </OptionalQuestion>
  );
}

function deadlineSummary(date: string, time: string): string {
  if (!date)
    return time
      ? "Add a date for your completion time"
      : "Only if the work must be finished by a certain date";
  const parsed = new Date(`${date}T12:00:00Z`);
  const day = Number.isFinite(parsed.getTime())
    ? new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      }).format(parsed)
    : date;
  if (!time) return day;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(time);
  if (!match) return `${day} · ${time}`;
  const hour = Number(match[1]);
  return `${day} · ${hour % 12 || 12}:${match[2]} ${hour >= 12 ? "PM" : "AM"}`;
}

export function PartnerCompletionDeadline({
  value,
  onChange,
  fieldErrors,
}: PartnerRequestQuestionProps) {
  const errors = errorsFor(fieldErrors, "requiredCompletion");
  const dateInvalid = Boolean(
    fieldErrors["scope.requiredCompletion"] ||
      errorsFor(fieldErrors, "requiredCompletion.localDate").length,
  );
  const timeInvalid =
    errorsFor(fieldErrors, "requiredCompletion.localTime").length > 0;
  return (
    <OptionalQuestion
      id="partner-book-completion-deadline"
      title="Completion deadline"
      summary={deadlineSummary(
        value.requiredCompletionDate,
        value.requiredCompletionTime,
      )}
      added={Boolean(
        value.requiredCompletionDate || value.requiredCompletionTime,
      )}
      errors={errors}
      fieldErrors={fieldErrors}
      errorId="partner-book-deadline-error"
    >
      <p className="text-xs leading-5 text-slate-600">
        Tell us if there is a deadline. Stonegate will confirm whether it can be
        met.
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
            aria-invalid={dateInvalid}
            aria-describedby={
              dateInvalid ? "partner-book-deadline-error" : undefined
            }
          />
        </label>
        <label
          htmlFor="partner-book-required-time"
          className="text-sm font-semibold text-slate-700"
        >
          Time <span className="font-normal text-slate-500">(optional)</span>
          <input
            id="partner-book-required-time"
            type="time"
            value={value.requiredCompletionTime}
            onChange={(event) =>
              onChange("requiredCompletionTime", event.target.value)
            }
            disabled={
              !value.requiredCompletionDate && !value.requiredCompletionTime
            }
            className={partnerFieldClass}
            aria-invalid={timeInvalid}
            aria-describedby={
              timeInvalid ? "partner-book-deadline-error" : undefined
            }
          />
        </label>
      </div>
    </OptionalQuestion>
  );
}

export function PartnerAdditionalAddresses({
  value,
  onChange,
  fieldErrors,
}: PartnerRequestQuestionProps) {
  const errors = errorsFor(fieldErrors, "multiStop", "multiStopDetails");
  const notesInvalid = errorsFor(fieldErrors, "multiStopDetails").length > 0;
  return (
    <OptionalQuestion
      id="partner-book-additional-addresses"
      title="Add another service address"
      summary={
        value.multiStop
          ? value.multiStopDetails.trim() || "Additional address requested"
          : "For work at more than one address"
      }
      added={value.multiStop}
      errors={errors}
      fieldErrors={fieldErrors}
      errorId="partner-book-stops-error"
    >
      <p className="text-xs leading-5 text-slate-600">
        Stonegate will review the additional addresses and confirm the plan
        before scheduling.
      </p>
      <Choice
        id="partner-book-multi-stop"
        label="This request includes another address"
        checked={value.multiStop}
        onChange={(checked) => onChange("multiStop", checked)}
        errorId={
          errorsFor(fieldErrors, "multiStop").length
            ? "partner-book-stops-error"
            : undefined
        }
      />
      <div hidden={!value.multiStop && !notesInvalid}>
        <label
          className="block text-sm font-semibold text-slate-700"
          htmlFor="partner-book-multi-stop-details"
        >
          Additional addresses and instructions
          <textarea
            id="partner-book-multi-stop-details"
            value={value.multiStopDetails}
            onChange={(event) =>
              onChange("multiStopDetails", event.target.value)
            }
            rows={3}
            maxLength={1000}
            className={partnerFieldClass}
            placeholder="List the other addresses, the work needed at each, and any required order."
            aria-invalid={notesInvalid}
            aria-describedby={
              notesInvalid ? "partner-book-stops-error" : undefined
            }
          />
        </label>
      </div>
    </OptionalQuestion>
  );
}
