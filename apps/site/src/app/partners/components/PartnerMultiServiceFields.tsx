"use client";

import * as React from "react";
import type { PartnerServiceDefinition } from "@myst-os/pricing";
import type { PartnerRequestServiceLine } from "../lib/portal-v2";
import type { BookingWizardService } from "./PartnerBookingWizard";
import { clampPartnerAddOnQuantity } from "../lib/partner-booking-add-ons";
import { partnerFieldClass } from "./PartnerPortalUi";

export type PartnerServiceFormDefinition = PartnerServiceDefinition;

export function PartnerMultiServiceFields({
  definitions,
  lines,
  onToggle,
  onChange,
  fieldErrors,
  disabled,
  renderRates,
  services,
}: {
  definitions: readonly PartnerServiceFormDefinition[];
  lines: readonly PartnerRequestServiceLine[];
  onToggle: (key: string, selected: boolean) => void;
  onChange: (line: PartnerRequestServiceLine) => void;
  fieldErrors: Record<string, string>;
  disabled: boolean;
  renderRates?: (serviceKey: string) => React.ReactNode;
  services: readonly BookingWizardService[];
}) {
  const [activeService, setActiveService] = React.useState(
    lines[0]?.serviceKey ?? "",
  );
  const activeLine =
    lines.find((line) => line.serviceKey === activeService) ?? lines[0];
  const definition = definitions.find(
    (item) => item.key === activeLine?.serviceKey,
  );
  const index = activeLine
    ? lines.findIndex((line) => line.id === activeLine.id)
    : -1;
  const prefix = `serviceLines.${index}`;
  const offeredExtras =
    services.find((service) => service.key === activeLine?.serviceKey)
      ?.addOns ?? [];
  const extras = [
    ...offeredExtras,
    ...(activeLine?.selectedAddOns ?? [])
      .filter(
        (extra) => !offeredExtras.some((offered) => offered.key === extra.key),
      )
      .map((extra) => ({
        key: extra.key,
        label: `Saved extra: ${extra.key}`,
        minimumQuantity: 1,
        maximumQuantity: 100,
        unitLabel: "items",
      })),
  ];
  const changeExtra = (key: string, quantity: number | null) => {
    if (!activeLine) return;
    onChange({
      ...activeLine,
      selectedAddOns: [
        ...activeLine.selectedAddOns.filter((extra) => extra.key !== key),
        ...(quantity === null ? [] : [{ key, quantity }]),
      ],
    });
  };
  const editorRef = React.useRef<HTMLElement>(null);

  React.useEffect(() => {
    const focusField = (event: Event) => {
      const path = (event as CustomEvent<unknown>).detail;
      if (typeof path !== "string") return;
      const match = /^serviceLines\.(\d+)(?:\.(.*))?$/u.exec(path);
      const line = match ? lines[Number(match[1])] : undefined;
      if (!line) {
        document.getElementById("partner-book-services")?.focus();
        return;
      }
      setActiveService(line.serviceKey);
      const config = definitions.find((item) => item.key === line.serviceKey);
      const field =
        match?.[2] === "description"
          ? "description"
          : config?.scopeFields.find(
              (field) => `scope.${field.key}` === match?.[2],
            )?.key;
      window.requestAnimationFrame(() => {
        const target = field
          ? document.getElementById(`partner-service-line-${line.id}-${field}`)
          : editorRef.current;
        target?.focus();
      });
    };
    window.addEventListener("partner-service-field-focus", focusField);
    return () =>
      window.removeEventListener("partner-service-field-focus", focusField);
  }, [lines, definitions]);

  const changeScope = (key: string, value: string) => {
    if (!activeLine) return;
    const scope = { ...activeLine.scope };
    if (value) scope[key] = value;
    else delete scope[key];
    onChange({ ...activeLine, scope });
  };
  const error = (path: string) =>
    fieldErrors[path] ?? fieldErrors[path.replace(/\.(\d+)(?=\.|$)/gu, "[$1]")];

  return (
    <div className="min-w-0 space-y-5">
      <fieldset
        id="partner-book-services"
        tabIndex={-1}
        disabled={disabled}
        aria-describedby="partner-book-services-help"
        className="min-w-0 scroll-mt-6 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
      >
        <legend className="text-base font-semibold text-slate-950">
          Services for this request
        </legend>
        <p
          id="partner-book-services-help"
          className="mt-1 text-sm leading-6 text-slate-600"
        >
          Choose all the work you need. Add details for one service at a time.
        </p>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {definitions.map((item) => {
            const selectedIndex = lines.findIndex(
              (line) => line.serviceKey === item.key,
            );
            const selected = selectedIndex >= 0;
            const hasError =
              selected &&
              Object.keys(fieldErrors).some((field) =>
                field
                  .replace(/\[(\d+)\]/gu, ".$1")
                  .startsWith(`serviceLines.${selectedIndex}.`),
              );
            return (
              <div
                key={item.key}
                className={`flex min-w-0 items-center gap-1 rounded-xl border px-3 ${selected ? "border-primary-500 bg-primary-50/60" : "border-slate-200 bg-white"}`}
              >
                <label className="flex min-h-12 min-w-0 flex-1 cursor-pointer items-center gap-3 py-2 text-sm font-semibold text-slate-900">
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={(event) => {
                      onToggle(item.key, event.target.checked);
                      if (event.target.checked) setActiveService(item.key);
                    }}
                    className="h-5 w-5 shrink-0 rounded border-slate-300 accent-primary-700"
                  />
                  <span className="min-w-0 break-words">
                    {item.label}
                    {hasError ? (
                      <span className="block text-xs font-medium text-rose-700">
                        Details needed
                      </span>
                    ) : null}
                  </span>
                </label>
                {selected ? (
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      setActiveService(item.key);
                      window.requestAnimationFrame(() =>
                        editorRef.current?.focus(),
                      );
                    }}
                    aria-label={`Edit ${item.label} details`}
                    aria-pressed={activeLine?.serviceKey === item.key}
                    className="min-h-11 shrink-0 rounded-lg px-2 text-xs font-semibold text-primary-800 underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2"
                  >
                    Details
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
        {error("serviceLines") ? (
          <p className="mt-2 text-sm font-medium text-rose-700">
            {error("serviceLines")}
          </p>
        ) : null}
      </fieldset>
      {activeLine && definition ? (
        <section
          ref={editorRef}
          tabIndex={-1}
          aria-labelledby="partner-service-editor-heading"
          className="min-w-0 space-y-4 rounded-xl border border-slate-200 bg-white p-4 outline-none focus-visible:ring-2 focus-visible:ring-primary-500 sm:p-5"
        >
          <div>
            <h3
              id="partner-service-editor-heading"
              className="text-base font-semibold text-slate-950"
            >
              {definition.label} details
            </h3>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              {definition.description}
            </p>
            {definition.inclusions.map((inclusion) => (
              <p
                key={inclusion}
                className="mt-1 text-xs leading-5 text-slate-600"
              >
                {inclusion}
              </p>
            ))}
          </div>
          <label
            className="block text-sm font-semibold text-slate-700"
            htmlFor={`partner-service-line-${activeLine.id}-description`}
          >
            What needs to be done?
            <textarea
              id={`partner-service-line-${activeLine.id}-description`}
              value={activeLine.description}
              onChange={(event) =>
                onChange({ ...activeLine, description: event.target.value })
              }
              rows={3}
              maxLength={10000}
              required
              disabled={disabled}
              className={partnerFieldClass}
              placeholder="Describe the work and where it is at the property."
              aria-invalid={Boolean(error(`${prefix}.description`))}
              aria-describedby={
                error(`${prefix}.description`)
                  ? "partner-service-description-error"
                  : undefined
              }
            />
            {error(`${prefix}.description`) ? (
              <span
                id="partner-service-description-error"
                className="mt-1 block text-sm font-medium text-rose-700"
              >
                {error(`${prefix}.description`)}
              </span>
            ) : null}
          </label>
          <div className="grid min-w-0 gap-4 sm:grid-cols-2">
            {definition.scopeFields.map((field) => {
              const id = `partner-service-line-${activeLine.id}-${field.key}`;
              const value =
                typeof activeLine.scope[field.key] === "string"
                  ? (activeLine.scope[field.key] as string)
                  : "";
              const problem = error(`${prefix}.scope.${field.key}`);
              return (
                <label
                  key={field.key}
                  className="block min-w-0 text-sm font-semibold text-slate-700"
                  htmlFor={id}
                >
                  {field.label.replace(/\s*\(optional\)$/u, "")}{" "}
                  <span className="font-normal text-slate-500">(if known)</span>
                  {field.options ? (
                    <select
                      id={id}
                      value={value}
                      disabled={disabled}
                      onChange={(event) =>
                        changeScope(field.key, event.target.value)
                      }
                      className={partnerFieldClass}
                      aria-invalid={Boolean(problem)}
                      aria-describedby={problem ? `${id}-error` : undefined}
                    >
                      <option value="">Not specified</option>
                      {field.options.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      id={id}
                      value={value}
                      disabled={disabled}
                      onChange={(event) =>
                        changeScope(field.key, event.target.value)
                      }
                      maxLength={2000}
                      className={partnerFieldClass}
                      placeholder={
                        field.placeholder ??
                        "Approximate is fine, or enter Not sure"
                      }
                      aria-invalid={Boolean(problem)}
                      aria-describedby={problem ? `${id}-error` : undefined}
                    />
                  )}
                  {problem ? (
                    <span
                      id={`${id}-error`}
                      className="mt-1 block text-sm font-medium text-rose-700"
                    >
                      {problem}
                    </span>
                  ) : null}
                </label>
              );
            })}
          </div>
          {definition.removalRelated && extras.length ? (
            <details className="border-t border-slate-200 pt-2">
              <summary className="min-h-11 cursor-pointer py-2 text-sm font-semibold text-slate-700">
                Removal extras
                {activeLine.selectedAddOns.length
                  ? ` (${activeLine.selectedAddOns.length} selected)`
                  : " (optional)"}
              </summary>
              <p className="mb-2 text-xs text-slate-600">
                Only add work beyond the service’s included removal and
                disposal.
              </p>
              <div className="space-y-3">
                {extras.map((extra) => {
                  const selected = activeLine.selectedAddOns.find(
                    (item) => item.key === extra.key,
                  );
                  return (
                    <div
                      key={extra.key}
                      className="rounded-lg border border-slate-200 p-3"
                    >
                      <label className="flex min-h-11 items-center gap-3 text-sm font-semibold">
                        <input
                          type="checkbox"
                          className="h-5 w-5"
                          disabled={disabled}
                          checked={Boolean(selected)}
                          onChange={(event) =>
                            changeExtra(
                              extra.key,
                              event.target.checked
                                ? extra.minimumQuantity
                                : null,
                            )
                          }
                        />
                        {extra.label}
                      </label>
                      {selected ? (
                        <label className="block text-xs font-semibold text-slate-700">
                          Quantity ({extra.unitLabel})
                          <input
                            type="number"
                            disabled={disabled}
                            min={extra.minimumQuantity}
                            max={extra.maximumQuantity}
                            step={1}
                            inputMode="numeric"
                            value={selected.quantity}
                            onChange={(event) =>
                              changeExtra(
                                extra.key,
                                clampPartnerAddOnQuantity({
                                  value: Number(event.target.value),
                                  minimum: extra.minimumQuantity,
                                  maximum: extra.maximumQuantity,
                                }),
                              )
                            }
                            className={partnerFieldClass}
                          />
                        </label>
                      ) : null}
                    </div>
                  );
                })}
              </div>
              {error(`${prefix}.selectedAddOns`) ? (
                <p className="mt-2 text-sm text-rose-700">
                  {error(`${prefix}.selectedAddOns`)}
                </p>
              ) : null}
            </details>
          ) : null}
          {renderRates?.(activeLine.serviceKey)}
        </section>
      ) : null}
      {lines.length > 1 ? (
        <p className="text-xs leading-5 text-slate-500">
          {lines.length} services in one request. Use Details to review each
          service. Deselecting keeps its answers while you edit this request.
        </p>
      ) : null}
    </div>
  );
}

export function PartnerServiceLineSummary({
  lines,
  definitions,
  renderRates,
  services,
}: {
  lines: readonly PartnerRequestServiceLine[];
  definitions: readonly PartnerServiceFormDefinition[];
  services: readonly BookingWizardService[];
  renderRates?: (serviceKey: string) => React.ReactNode;
}) {
  return (
    <div className="space-y-4 rounded-xl border border-slate-200 p-4 sm:col-span-2">
      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        Requested services
      </dt>
      <dd className="space-y-4">
        {lines.map((line) => {
          const definition = definitions.find(
            (item) => item.key === line.serviceKey,
          );
          return (
            <section
              key={line.id}
              className="min-w-0 border-t border-slate-200 pt-3 first:border-t-0 first:pt-0"
            >
              <h3 className="font-semibold text-slate-950">
                {definition?.label ?? line.serviceKey}
              </h3>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-700">
                {line.description}
              </p>
              <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
                {definition?.scopeFields.map((field) => {
                  const value = line.scope[field.key];
                  return typeof value === "string" && value ? (
                    <div key={field.key} className="min-w-0">
                      <dt className="text-slate-500">{field.label}</dt>
                      <dd className="break-words text-slate-800">
                        {field.options?.find((option) => option.value === value)
                          ?.label ?? value}
                      </dd>
                    </div>
                  ) : null;
                })}
              </dl>
              {line.selectedAddOns.length ? (
                <p className="mt-2 text-sm text-slate-700">
                  <strong>Removal extras: </strong>
                  {line.selectedAddOns
                    .map(
                      (extra) =>
                        `${services.find((service) => service.key === line.serviceKey)?.addOns?.find((item) => item.key === extra.key)?.label ?? extra.key} × ${extra.quantity}`,
                    )
                    .join(", ")}
                </p>
              ) : null}
              {renderRates?.(line.serviceKey)}
            </section>
          );
        })}
      </dd>
    </div>
  );
}
