"use client";

import { PartnerBookingDetailsRow } from "./PartnerBookingDetailsRow";
import { partnerFieldClass } from "./PartnerPortalUi";
import { PARTNER_EQUIPMENT_OPTIONS } from "../lib/partner-booking-add-ons";
import type {
  PartnerRequestQuestionProps,
  PartnerRequestScopeValues,
} from "./PartnerRequestQuestions";

/** Keep older requests editable without adding these questions to ordinary new requests. */
export function PartnerSavedScopeDetails({
  value,
  onChange,
  fieldErrors,
  initialValue,
  requiredFields = [],
}: PartnerRequestQuestionProps & {
  initialValue: PartnerRequestScopeValues;
  requiredFields?: readonly string[];
}) {
  const required = new Set(
    requiredFields.map((field) => field.replace(/^scope\./u, "")),
  );
  const submittedEquipment = [...new Set(value.equipmentNeeds)]
    .filter((key) =>
      PARTNER_EQUIPMENT_OPTIONS.some((option) => option.key === key),
    )
    .sort();
  const oldEquipmentErrors = Object.entries(fieldErrors).flatMap(
    ([field, message]) => {
      const index = /^scope\.equipmentNeeds\.(\d+)(?:\.|$)/u.exec(
        field.replace(/\[(\d+)\]/gu, ".$1"),
      )?.[1];
      const key =
        index === undefined ? undefined : submittedEquipment[Number(index)];
      return key === "lift_gate" || key === "demolition"
        ? [{ key, message }]
        : [];
    },
  );
  const quantities = [
    {
      key: "itemCount",
      field: "itemCount",
      id: "partner-book-item-count",
      label: "Item count",
      step: "1",
    },
    {
      key: "volume",
      field: "volumeCubicYards",
      id: "partner-book-volume",
      label: "Estimated volume (cubic yards)",
      step: "any",
    },
  ] as const;
  const visibleQuantities = quantities.filter(
    ({ key, field }) =>
      initialValue[key] !== "" ||
      value[key] !== "" ||
      required.has(field) ||
      fieldErrors[`scope.${field}`],
  );
  const oldOptions = [
    { key: "lift_gate", label: "Lift gate requested" },
    { key: "demolition", label: "Light demolition requested" },
  ].filter(
    ({ key }) =>
      initialValue.equipmentNeeds.includes(key) ||
      value.equipmentNeeds.includes(key),
  );
  const showHandling =
    ((initialValue.nonStandard || value.nonStandard) &&
      !value.equipmentNeeds.length &&
      !value.multiStop) ||
    Boolean(fieldErrors["scope.nonStandard"]);
  const showMaterials =
    ((initialValue.restrictedItems || value.restrictedItems) &&
      !value.hazardCategories.length) ||
    Boolean(fieldErrors["scope.restrictedItems"]);
  const errorFields = [
    "itemCount",
    "volumeCubicYards",
    "nonStandard",
    "restrictedItems",
  ];
  const hasErrors =
    oldEquipmentErrors.length > 0 ||
    errorFields.some((key) => fieldErrors[`scope.${key}`]);
  if (
    !visibleQuantities.length &&
    !oldOptions.length &&
    !showHandling &&
    !showMaterials
  )
    return null;
  const hasSavedDetails = Boolean(
    initialValue.itemCount !== "" ||
      initialValue.volume !== "" ||
      oldOptions.length ||
      showHandling ||
      showMaterials,
  );
  return (
    <PartnerBookingDetailsRow
      id="partner-book-saved-details"
      title={
        hasSavedDetails ? "Saved request details" : "Required service details"
      }
      summary={
        hasSavedDetails
          ? "Review details kept from this request"
          : "This service requires a quantity"
      }
      reveal={
        hasErrors ||
        (!hasSavedDetails &&
          visibleQuantities.some(({ field }) => required.has(field)))
      }
      validationErrors={fieldErrors}
    >
      <div className="space-y-4">
        {hasSavedDetails ? (
          <p className="text-xs leading-5 text-slate-500">
            These details are saved with this request. Update or clear anything
            that no longer applies.
          </p>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          {visibleQuantities.map(({ key, field, id, label, step }) => (
            <label
              key={key}
              htmlFor={id}
              className="block text-sm font-semibold text-slate-700"
            >
              {label}
              {required.has(field) ? " (required)" : ""}
              <input
                id={id}
                type="number"
                min="0"
                step={step}
                required={required.has(field)}
                value={value[key]}
                onChange={(event) => onChange(key, event.target.value)}
                className={partnerFieldClass}
                aria-invalid={Boolean(fieldErrors[`scope.${field}`])}
                aria-describedby={
                  fieldErrors[`scope.${field}`] ? `${id}-error` : undefined
                }
              />
              {fieldErrors[`scope.${field}`] ? (
                <span
                  id={`${id}-error`}
                  className="mt-1 block text-sm font-medium text-rose-700"
                >
                  {fieldErrors[`scope.${field}`]}
                </span>
              ) : null}
            </label>
          ))}
        </div>
        {oldOptions.map(({ key, label }) => (
          <label
            key={key}
            className="flex min-h-11 items-center gap-3 text-sm text-slate-800"
          >
            <input
              id={`partner-book-saved-option-${key}`}
              data-partner-equipment-index={
                submittedEquipment.includes(key)
                  ? submittedEquipment.indexOf(key)
                  : undefined
              }
              data-partner-equipment-section="scope"
              aria-invalid={oldEquipmentErrors.some(
                (error) => error.key === key,
              )}
              aria-describedby={
                oldEquipmentErrors.some((error) => error.key === key)
                  ? "partner-book-saved-equipment-error"
                  : undefined
              }
              type="checkbox"
              checked={value.equipmentNeeds.includes(key)}
              onChange={(event) =>
                onChange(
                  "equipmentNeeds",
                  event.target.checked
                    ? [...new Set([...value.equipmentNeeds, key])]
                    : value.equipmentNeeds.filter((item) => item !== key),
                )
              }
              className="h-5 w-5 rounded accent-primary-700"
            />
            {label}
          </label>
        ))}
        {oldEquipmentErrors.length ? (
          <div
            id="partner-book-saved-equipment-error"
            className="space-y-1 text-sm font-medium text-rose-700"
          >
            {oldEquipmentErrors.map(({ key, message }) => (
              <p key={key}>{message}</p>
            ))}
          </div>
        ) : null}
        {(
          [
            {
              key: "nonStandard",
              id: "partner-book-non-standard",
              show: showHandling,
              label: "Handling review requested",
            },
            {
              key: "restrictedItems",
              id: "partner-book-restricted-items",
              show: showMaterials,
              label: "Material review requested",
            },
          ] as const
        )
          .filter(({ show }) => show)
          .map(({ key, id, label }) => (
            <div key={key}>
              <label className="flex min-h-11 items-center gap-3 text-sm text-slate-800">
                <input
                  id={id}
                  type="checkbox"
                  checked={value[key]}
                  onChange={(event) => onChange(key, event.target.checked)}
                  className="h-5 w-5 rounded accent-primary-700"
                  aria-invalid={Boolean(fieldErrors[`scope.${key}`])}
                  aria-describedby={
                    fieldErrors[`scope.${key}`] ? `${id}-error` : undefined
                  }
                />
                {label}
              </label>
              {fieldErrors[`scope.${key}`] ? (
                <p
                  id={`${id}-error`}
                  className="text-sm font-medium text-rose-700"
                >
                  {fieldErrors[`scope.${key}`]}
                </p>
              ) : null}
            </div>
          ))}
      </div>
    </PartnerBookingDetailsRow>
  );
}
