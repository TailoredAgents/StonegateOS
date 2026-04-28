"use client";

import React from "react";
import {
  APPOINTMENT_BOOKING_SELECTION_OPTIONS,
  DEMOLITION_TYPE_OPTIONS,
  DUMPSTER_SIZE_OPTIONS,
  LAND_CLEARING_ACCESS_OPTIONS,
  LOAD_SIZE_OPTIONS,
  PRICE_INPUT_MODE_OPTIONS,
  type AppointmentBookingSelection,
  type AppointmentServiceType,
  type DemolitionType,
  type DumpsterSizeKind,
  type LandClearingAccessDifficulty,
  type LeadSourceType,
  type LoadSizeKind,
  type PriceInputMode,
} from "../team/lib/booking-details";

type MobileLeadSourceType = Exclude<LeadSourceType, "team_member">;

type Props = {
  threadChannel?: string | null;
};

const fieldClassName =
  "mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-base text-white outline-none focus:border-cyan-300";
const labelClassName = "block";
const labelTextClassName = "text-xs font-semibold text-slate-300";

function defaultLeadSourceForChannel(
  channel: string | null | undefined,
): MobileLeadSourceType {
  const normalized = channel?.toLowerCase() ?? "";
  if (normalized.includes("facebook") || normalized.includes("messenger")) {
    return "facebook";
  }
  return "google";
}

export function MobileAppointmentBookingFields({
  threadChannel = null,
}: Props): React.ReactElement {
  const [appointmentType, setAppointmentType] =
    React.useState<AppointmentBookingSelection>("junk_removal");
  const [sourceType, setSourceType] = React.useState<MobileLeadSourceType>(() =>
    defaultLeadSourceForChannel(threadChannel),
  );
  const [priceMode, setPriceMode] = React.useState<PriceInputMode | "exact">(
    "exact",
  );
  const [loadSize, setLoadSize] = React.useState<LoadSizeKind | "">("");
  const [landClearingAccess, setLandClearingAccess] = React.useState<
    LandClearingAccessDifficulty | ""
  >("");
  const [demolitionType, setDemolitionType] = React.useState<
    DemolitionType | ""
  >("");
  const [dumpsterSize, setDumpsterSize] = React.useState<DumpsterSizeKind | "">(
    "",
  );

  const isInPersonQuote = appointmentType === "in_person_quote";
  const serviceType: AppointmentServiceType | null = isInPersonQuote
    ? null
    : appointmentType;
  const effectivePriceMode =
    serviceType === "rental_dumpster" ? "exact" : priceMode;

  React.useEffect(() => {
    if (serviceType === "rental_dumpster") {
      setPriceMode("exact");
    }
  }, [serviceType]);

  return (
    <section className="rounded-lg border border-cyan-300/20 bg-cyan-300/5 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-white">Quote and job size</p>
          <p className="mt-1 text-xs leading-5 text-slate-300">
            This controls the calendar price, projected revenue, and job
            details.
          </p>
        </div>
        <span className="rounded-full border border-cyan-300/25 px-2 py-1 text-[11px] font-semibold text-cyan-100">
          Required
        </span>
      </div>

      <div className="mt-3 space-y-3">
        <label className={labelClassName}>
          <span className={labelTextClassName}>Booking type</span>
          <select
            name="appointmentType"
            required
            value={appointmentType}
            onChange={(event) =>
              setAppointmentType(
                event.target.value as AppointmentBookingSelection,
              )
            }
            className={fieldClassName}
          >
            {APPOINTMENT_BOOKING_SELECTION_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        {serviceType ? (
          <>
            <input type="hidden" name="serviceType" value={serviceType} />

            <label className={labelClassName}>
              <span className={labelTextClassName}>Lead source</span>
              <select
                name="sourceType"
                required
                value={sourceType}
                onChange={(event) =>
                  setSourceType(event.target.value as MobileLeadSourceType)
                }
                className={fieldClassName}
              >
                <option value="google">Google</option>
                <option value="facebook">Facebook</option>
                <option value="referral">Referral</option>
              </select>
            </label>

            {sourceType === "referral" ? (
              <label className={labelClassName}>
                <span className={labelTextClassName}>Referral name</span>
                <input
                  name="sourceReferralName"
                  required
                  placeholder="Who referred them?"
                  className={fieldClassName}
                />
              </label>
            ) : null}

            {serviceType !== "rental_dumpster" ? (
              <label className={labelClassName}>
                <span className={labelTextClassName}>Price style</span>
                <select
                  name="priceInputMode"
                  required
                  value={priceMode}
                  onChange={(event) =>
                    setPriceMode(event.target.value as PriceInputMode)
                  }
                  className={fieldClassName}
                >
                  {PRICE_INPUT_MODE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <input type="hidden" name="priceInputMode" value="exact" />
            )}

            {effectivePriceMode === "exact" || effectivePriceMode === "both" ? (
              <label className={labelClassName}>
                <span className={labelTextClassName}>
                  {serviceType === "rental_dumpster"
                    ? "Exact price"
                    : "Exact quote"}
                </span>
                <input
                  name="quotedTotal"
                  type="number"
                  min={0}
                  step="0.01"
                  required
                  inputMode="decimal"
                  placeholder="450"
                  className={fieldClassName}
                />
              </label>
            ) : null}

            {effectivePriceMode === "range" || effectivePriceMode === "both" ? (
              <div className="grid grid-cols-2 gap-2">
                <label className={labelClassName}>
                  <span className={labelTextClassName}>Range min</span>
                  <input
                    name="priceRangeMin"
                    type="number"
                    min={0}
                    step="0.01"
                    required
                    inputMode="decimal"
                    placeholder="300"
                    className={fieldClassName}
                  />
                </label>
                <label className={labelClassName}>
                  <span className={labelTextClassName}>Range max</span>
                  <input
                    name="priceRangeMax"
                    type="number"
                    min={0}
                    step="0.01"
                    required
                    inputMode="decimal"
                    placeholder="500"
                    className={fieldClassName}
                  />
                </label>
              </div>
            ) : null}

            {serviceType === "junk_removal" ? (
              <>
                <label className={labelClassName}>
                  <span className={labelTextClassName}>Load size</span>
                  <select
                    name="loadSize"
                    required
                    value={loadSize}
                    onChange={(event) =>
                      setLoadSize(event.target.value as LoadSizeKind | "")
                    }
                    className={fieldClassName}
                  >
                    <option value="">Select load size</option>
                    {LOAD_SIZE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                {loadSize === "custom" ? (
                  <label className={labelClassName}>
                    <span className={labelTextClassName}>How many loads?</span>
                    <input
                      name="customLoads"
                      type="number"
                      min={0.25}
                      step={0.25}
                      required
                      inputMode="decimal"
                      placeholder="1.5"
                      className={fieldClassName}
                    />
                  </label>
                ) : null}
              </>
            ) : null}

            {serviceType === "land_clearing" ? (
              <>
                <label className={labelClassName}>
                  <span className={labelTextClassName}>
                    Property size / area
                  </span>
                  <input
                    name="landClearingAreaScope"
                    required
                    placeholder="Backyard brush line, 1/4 acre"
                    className={fieldClassName}
                  />
                </label>
                <label className={labelClassName}>
                  <span className={labelTextClassName}>Access difficulty</span>
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
                    <option value="">Select access</option>
                    {LAND_CLEARING_ACCESS_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={labelClassName}>
                  <span className={labelTextClassName}>Haul-away needed?</span>
                  <select
                    name="landClearingHaulAway"
                    required
                    className={fieldClassName}
                  >
                    <option value="">Select</option>
                    <option value="yes">Yes</option>
                    <option value="no">No</option>
                  </select>
                </label>
              </>
            ) : null}

            {serviceType === "demolition" ? (
              <>
                <label className={labelClassName}>
                  <span className={labelTextClassName}>Demolition type</span>
                  <select
                    name="demolitionType"
                    required
                    value={demolitionType}
                    onChange={(event) =>
                      setDemolitionType(
                        event.target.value as DemolitionType | "",
                      )
                    }
                    className={fieldClassName}
                  >
                    <option value="">Select demo type</option>
                    {DEMOLITION_TYPE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={labelClassName}>
                  <span className={labelTextClassName}>Scope size</span>
                  <input
                    name="demolitionScopeSize"
                    required
                    placeholder="12x16 deck and stairs"
                    className={fieldClassName}
                  />
                </label>
                <label className={labelClassName}>
                  <span className={labelTextClassName}>Haul-away needed?</span>
                  <select
                    name="demolitionHaulAway"
                    required
                    className={fieldClassName}
                  >
                    <option value="">Select</option>
                    <option value="yes">Yes</option>
                    <option value="no">No</option>
                  </select>
                </label>
              </>
            ) : null}

            {serviceType === "rental_dumpster" ? (
              <>
                <label className={labelClassName}>
                  <span className={labelTextClassName}>Dumpster size</span>
                  <select
                    name="dumpsterSize"
                    required
                    value={dumpsterSize}
                    onChange={(event) =>
                      setDumpsterSize(
                        event.target.value as DumpsterSizeKind | "",
                      )
                    }
                    className={fieldClassName}
                  >
                    <option value="">Select dumpster</option>
                    {DUMPSTER_SIZE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={labelClassName}>
                  <span className={labelTextClassName}>Pickup date</span>
                  <input
                    name="dumpsterPickupDate"
                    type="date"
                    required
                    className={fieldClassName}
                  />
                </label>
                <label className={labelClassName}>
                  <span className={labelTextClassName}>Placement location</span>
                  <input
                    name="dumpsterPlacementLocation"
                    required
                    placeholder="Left side of driveway"
                    className={fieldClassName}
                  />
                </label>
              </>
            ) : null}
          </>
        ) : (
          <div className="rounded-md border border-white/10 bg-slate-950 p-3 text-xs leading-5 text-slate-300">
            Use this when the appointment is only to look at the job in person.
            Exact price and job size can be added later.
          </div>
        )}
      </div>
    </section>
  );
}
