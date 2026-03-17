"use client";

import React from "react";
import {
  LOAD_SIZE_OPTIONS,
  PRICE_INPUT_MODE_OPTIONS,
  type AppointmentBookingDetails,
  type AppointmentLeadSource,
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
};

function centsToInputValue(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  return (value / 100).toFixed(2);
}

function customLoadsToInputValue(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return "";
  return value % 1 === 0
    ? String(value)
    : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
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
}: Props): React.ReactElement {
  const [priceMode, setPriceMode] = React.useState<PriceInputMode | "">(
    bookingDetails?.pricing.mode ?? "",
  );
  const [loadSize, setLoadSize] = React.useState<LoadSizeKind | "">(
    bookingDetails?.loadSize.kind ?? "",
  );
  const resolvedSource = fixedSource ?? bookingDetails?.source ?? null;

  React.useEffect(() => {
    setPriceMode(bookingDetails?.pricing.mode ?? "");
    setLoadSize(bookingDetails?.loadSize.kind ?? "");
  }, [bookingDetails]);

  return (
    <>
      <div className={sectionClassName}>
        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Lead details
        </div>
      </div>

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

      {priceMode === "exact" || priceMode === "both" ? (
        <label className={labelClassName}>
          <span>Exact quote</span>
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

      {priceMode === "range" || priceMode === "both" ? (
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
            step="0.25"
            required
            defaultValue={customLoadsToInputValue(
              bookingDetails?.loadSize.customLoads,
            )}
            placeholder="e.g. 1.5"
            className={fieldClassName}
          />
        </label>
      ) : null}
    </>
  );
}
