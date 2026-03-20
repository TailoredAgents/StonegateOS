"use client";

import React from "react";
import {
  APPOINTMENT_SERVICE_TYPE_OPTIONS,
  DEMOLITION_TYPE_OPTIONS,
  DUMPSTER_SIZE_OPTIONS,
  LAND_CLEARING_ACCESS_OPTIONS,
  LOAD_SIZE_OPTIONS,
  PRICE_INPUT_MODE_OPTIONS,
  resolveAppointmentServiceType,
  type AppointmentBookingDetails,
  type AppointmentLeadSource,
  type AppointmentServiceType,
  type DemolitionType,
  type DumpsterSizeKind,
  type LandClearingAccessDifficulty,
  type LoadSizeKind,
  type PriceInputMode,
} from "../lib/booking-details";
import { LeadSourceFields } from "./LeadSourceFields";

type TeamMember = {
  id: string;
  name: string;
};

type Props = {
  teamMembers: TeamMember[];
  bookingDetails?: AppointmentBookingDetails | null;
  quotedTotalCents?: number | null;
  labelClassName: string;
  fieldClassName: string;
  sectionClassName?: string;
  sourceLabel?: string;
  hideLeadSource?: boolean;
  fixedSource?: AppointmentLeadSource | null;
  serviceType?: AppointmentServiceType | null;
  allowServiceTypeSelection?: boolean;
};

function centsToInputValue(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  return (value / 100).toFixed(2);
}

function customLoadsToInputValue(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return "";
  }
  return value % 1 === 0
    ? String(value)
    : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function dateToInputValue(value: string | null | undefined): string {
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return value.trim();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value.trim();
  return parsed.toISOString().slice(0, 10);
}

function yesNoValue(value: boolean | null | undefined): string {
  if (value === true) return "yes";
  if (value === false) return "no";
  return "";
}

export function AppointmentBookingDetailsFields({
  teamMembers,
  bookingDetails = null,
  quotedTotalCents = null,
  labelClassName,
  fieldClassName,
  sectionClassName = "sm:col-span-2",
  sourceLabel = "Where from?",
  hideLeadSource = false,
  fixedSource = null,
  serviceType = null,
  allowServiceTypeSelection = false,
}: Props): React.ReactElement {
  const initialServiceType =
    serviceType ?? resolveAppointmentServiceType(bookingDetails) ?? null;
  const [selectedServiceType, setSelectedServiceType] = React.useState<
    AppointmentServiceType | ""
  >(initialServiceType ?? "");
  const [priceMode, setPriceMode] = React.useState<PriceInputMode | "">(
    bookingDetails?.pricing.mode ?? "",
  );
  const [loadSize, setLoadSize] = React.useState<LoadSizeKind | "">(
    bookingDetails?.loadSize?.kind ?? "",
  );
  const [landClearingAccess, setLandClearingAccess] = React.useState<
    LandClearingAccessDifficulty | ""
  >(bookingDetails?.landClearing?.accessDifficulty ?? "");
  const [demolitionType, setDemolitionType] = React.useState<
    DemolitionType | ""
  >(bookingDetails?.demolition?.demoType ?? "");
  const [dumpsterSize, setDumpsterSize] = React.useState<DumpsterSizeKind | "">(
    bookingDetails?.rentalDumpster?.dumpsterSize ?? "",
  );
  const resolvedSource = fixedSource ?? bookingDetails?.source ?? null;

  React.useEffect(() => {
    setSelectedServiceType(initialServiceType ?? "");
  }, [initialServiceType]);

  React.useEffect(() => {
    setPriceMode(bookingDetails?.pricing.mode ?? "");
    setLoadSize(bookingDetails?.loadSize?.kind ?? "");
    setLandClearingAccess(bookingDetails?.landClearing?.accessDifficulty ?? "");
    setDemolitionType(bookingDetails?.demolition?.demoType ?? "");
    setDumpsterSize(bookingDetails?.rentalDumpster?.dumpsterSize ?? "");
  }, [bookingDetails]);

  const effectiveServiceType = allowServiceTypeSelection
    ? selectedServiceType
    : (initialServiceType ?? "");
  React.useEffect(() => {
    if (effectiveServiceType === "rental_dumpster") {
      setPriceMode("exact");
    }
  }, [effectiveServiceType]);

  const showPriceModeSelector =
    effectiveServiceType !== "" && effectiveServiceType !== "rental_dumpster";
  const effectivePriceMode =
    effectiveServiceType === "rental_dumpster" ? "exact" : priceMode;
  const exactPriceLabel =
    effectiveServiceType === "rental_dumpster" ? "Exact price" : "Exact quote";

  return (
    <>
      <div className={sectionClassName}>
        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Job details
        </div>
      </div>

      {allowServiceTypeSelection ? (
        <label className={labelClassName}>
          <span>Job type</span>
          <select
            name="serviceType"
            required
            value={selectedServiceType}
            onChange={(event) =>
              setSelectedServiceType(
                event.target.value as AppointmentServiceType | "",
              )
            }
            className={fieldClassName}
          >
            <option value="">(Select)</option>
            {APPOINTMENT_SERVICE_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      ) : initialServiceType ? (
        <input type="hidden" name="serviceType" value={initialServiceType} />
      ) : null}

      {hideLeadSource ? (
        resolvedSource ? (
          <>
            <input
              type="hidden"
              name="sourceType"
              value={resolvedSource.type}
            />
            {resolvedSource.type === "team_member" &&
            resolvedSource.teamMemberId ? (
              <input
                type="hidden"
                name="sourceTeamMemberId"
                value={resolvedSource.teamMemberId}
              />
            ) : null}
            {resolvedSource.type === "referral" &&
            resolvedSource.referralName ? (
              <input
                type="hidden"
                name="sourceReferralName"
                value={resolvedSource.referralName}
              />
            ) : null}
          </>
        ) : null
      ) : (
        <LeadSourceFields
          teamMembers={teamMembers}
          defaultType={resolvedSource?.type ?? ""}
          defaultTeamMemberId={resolvedSource?.teamMemberId ?? null}
          defaultReferralName={resolvedSource?.referralName ?? null}
          required
          label={sourceLabel}
          labelClassName={labelClassName}
          fieldClassName={fieldClassName}
        />
      )}

      {showPriceModeSelector ? (
        <label className={labelClassName}>
          <span>Price range, exact quote, or both?</span>
          <select
            name="priceInputMode"
            required
            value={priceMode}
            onChange={(event) =>
              setPriceMode(event.target.value as PriceInputMode | "")
            }
            className={fieldClassName}
          >
            <option value="">(Select)</option>
            {PRICE_INPUT_MODE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      ) : effectiveServiceType === "rental_dumpster" ? (
        <input type="hidden" name="priceInputMode" value="exact" />
      ) : null}

      {effectivePriceMode === "exact" || effectivePriceMode === "both" ? (
        <label className={labelClassName}>
          <span>{exactPriceLabel}</span>
          <input
            name="quotedTotal"
            type="number"
            min={0}
            step="0.01"
            required
            defaultValue={centsToInputValue(quotedTotalCents)}
            placeholder="e.g. 350"
            className={fieldClassName}
          />
        </label>
      ) : null}

      {effectivePriceMode === "range" || effectivePriceMode === "both" ? (
        <>
          <label className={labelClassName}>
            <span>Price range min</span>
            <input
              name="priceRangeMin"
              type="number"
              min={0}
              step="0.01"
              required
              defaultValue={centsToInputValue(
                bookingDetails?.pricing.rangeMinCents,
              )}
              placeholder="e.g. 300"
              className={fieldClassName}
            />
          </label>
          <label className={labelClassName}>
            <span>Price range max</span>
            <input
              name="priceRangeMax"
              type="number"
              min={0}
              step="0.01"
              required
              defaultValue={centsToInputValue(
                bookingDetails?.pricing.rangeMaxCents,
              )}
              placeholder="e.g. 450"
              className={fieldClassName}
            />
          </label>
        </>
      ) : null}

      {effectiveServiceType === "junk_removal" ? (
        <>
          <label className={labelClassName}>
            <span>How big is this load?</span>
            <select
              name="loadSize"
              required
              value={loadSize}
              onChange={(event) =>
                setLoadSize(event.target.value as LoadSizeKind | "")
              }
              className={fieldClassName}
            >
              <option value="">(Select)</option>
              {LOAD_SIZE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          {loadSize === "custom" ? (
            <label className={labelClassName}>
              <span>How many loads?</span>
              <input
                name="customLoads"
                type="number"
                min={0.25}
                step={0.25}
                required
                defaultValue={customLoadsToInputValue(
                  bookingDetails?.loadSize?.customLoads,
                )}
                placeholder="e.g. 1.5"
                className={fieldClassName}
              />
            </label>
          ) : null}
        </>
      ) : null}

      {effectiveServiceType === "land_clearing" ? (
        <>
          <label className={labelClassName}>
            <span>Property size / area</span>
            <input
              name="landClearingAreaScope"
              required
              defaultValue={bookingDetails?.landClearing?.areaScope ?? ""}
              placeholder="e.g. backyard brush line, 1/4 acre"
              className={fieldClassName}
            />
          </label>
          <label className={labelClassName}>
            <span>Access difficulty</span>
            <select
              name="landClearingAccessDifficulty"
              required
              value={landClearingAccess}
              onChange={(event) =>
                setLandClearingAccess(
                  event.target.value as LandClearingAccessDifficulty | "",
                )
              }
              className={fieldClassName}
            >
              <option value="">(Select)</option>
              {LAND_CLEARING_ACCESS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className={labelClassName}>
            <span>Haul-away needed?</span>
            <select
              name="landClearingHaulAway"
              required
              defaultValue={yesNoValue(bookingDetails?.landClearing?.haulAway)}
              className={fieldClassName}
            >
              <option value="">(Select)</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </label>
        </>
      ) : null}

      {effectiveServiceType === "demolition" ? (
        <>
          <label className={labelClassName}>
            <span>Demolition type</span>
            <select
              name="demolitionType"
              required
              value={demolitionType}
              onChange={(event) =>
                setDemolitionType(event.target.value as DemolitionType | "")
              }
              className={fieldClassName}
            >
              <option value="">(Select)</option>
              {DEMOLITION_TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className={labelClassName}>
            <span>Scope size</span>
            <input
              name="demolitionScopeSize"
              required
              defaultValue={bookingDetails?.demolition?.scopeSize ?? ""}
              placeholder="e.g. 12x16 deck and stairs"
              className={fieldClassName}
            />
          </label>
          <label className={labelClassName}>
            <span>Haul-away needed?</span>
            <select
              name="demolitionHaulAway"
              required
              defaultValue={yesNoValue(bookingDetails?.demolition?.haulAway)}
              className={fieldClassName}
            >
              <option value="">(Select)</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </label>
        </>
      ) : null}

      {effectiveServiceType === "rental_dumpster" ? (
        <>
          <label className={labelClassName}>
            <span>Dumpster size</span>
            <select
              name="dumpsterSize"
              required
              value={dumpsterSize}
              onChange={(event) =>
                setDumpsterSize(event.target.value as DumpsterSizeKind | "")
              }
              className={fieldClassName}
            >
              <option value="">(Select)</option>
              {DUMPSTER_SIZE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className={labelClassName}>
            <span>Pickup date</span>
            <input
              name="dumpsterPickupDate"
              type="date"
              required
              defaultValue={dateToInputValue(
                bookingDetails?.rentalDumpster?.pickupDate,
              )}
              className={fieldClassName}
            />
          </label>
          <label className={labelClassName}>
            <span>Placement location</span>
            <input
              name="dumpsterPlacementLocation"
              required
              defaultValue={
                bookingDetails?.rentalDumpster?.placementLocation ?? ""
              }
              placeholder="e.g. left side of driveway"
              className={fieldClassName}
            />
          </label>
        </>
      ) : null}
    </>
  );
}
