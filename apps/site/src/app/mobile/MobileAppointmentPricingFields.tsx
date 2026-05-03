"use client";

import React from "react";

type AppointmentType = "job" | "in_person_quote";
type ServiceType = "junk_removal" | "land_clearing" | "demolition" | "rental_dumpster";
type PriceMode = "range" | "exact" | "both";

const inputClass =
  "mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-base text-white outline-none focus:border-cyan-300";
const labelClass = "block";

export function MobileAppointmentPricingFields({
  sourceTeamMemberId
}: {
  sourceTeamMemberId: string;
}) {
  const [appointmentType, setAppointmentType] = React.useState<AppointmentType>("job");
  const [serviceType, setServiceType] = React.useState<ServiceType>("junk_removal");
  const [priceMode, setPriceMode] = React.useState<PriceMode>("range");
  const [loadSize, setLoadSize] = React.useState("quarter_to_half");

  React.useEffect(() => {
    if (serviceType === "rental_dumpster") {
      setPriceMode("exact");
    }
  }, [serviceType]);

  const isJob = appointmentType === "job";
  const effectivePriceMode = serviceType === "rental_dumpster" ? "exact" : priceMode;
  const showExact = isJob && (effectivePriceMode === "exact" || effectivePriceMode === "both");
  const showRange = isJob && (effectivePriceMode === "range" || effectivePriceMode === "both");

  return (
    <div className="space-y-3 rounded-lg border border-cyan-300/20 bg-cyan-300/10 p-3">
      <input type="hidden" name="sourceType" value="team_member" />
      <input type="hidden" name="sourceTeamMemberId" value={sourceTeamMemberId} />

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => setAppointmentType("job")}
          className={`rounded-md border px-3 py-2 text-sm font-semibold ${
            appointmentType === "job"
              ? "border-cyan-300 bg-cyan-300 text-slate-950"
              : "border-white/10 bg-slate-950 text-slate-200"
          }`}
        >
          Job
        </button>
        <button
          type="button"
          onClick={() => setAppointmentType("in_person_quote")}
          className={`rounded-md border px-3 py-2 text-sm font-semibold ${
            appointmentType === "in_person_quote"
              ? "border-cyan-300 bg-cyan-300 text-slate-950"
              : "border-white/10 bg-slate-950 text-slate-200"
          }`}
        >
          Quote visit
        </button>
      </div>
      <input type="hidden" name="appointmentType" value={appointmentType} />

      {isJob ? (
        <>
          <label className={labelClass}>
            <span className="text-xs font-semibold text-slate-300">Job type</span>
            <select
              name="serviceType"
              value={serviceType}
              onChange={(event) => setServiceType(event.target.value as ServiceType)}
              className={inputClass}
              required
            >
              <option value="junk_removal">Junk removal</option>
              <option value="land_clearing">Land clearing</option>
              <option value="demolition">Demolition</option>
              <option value="rental_dumpster">Rental dumpster</option>
            </select>
          </label>

          {serviceType !== "rental_dumpster" ? (
            <div>
              <p className="text-xs font-semibold text-slate-300">Price</p>
              <div className="mt-1 grid grid-cols-3 gap-1.5">
                {[
                  ["range", "Range"],
                  ["exact", "Exact"],
                  ["both", "Both"]
                ].map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setPriceMode(value as PriceMode)}
                    className={`rounded-md border px-2 py-2 text-xs font-semibold ${
                      effectivePriceMode === value
                        ? "border-cyan-300 bg-cyan-300 text-slate-950"
                        : "border-white/10 bg-slate-950 text-slate-200"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <input type="hidden" name="priceInputMode" value={effectivePriceMode} />

          <div className={showRange && showExact ? "grid grid-cols-2 gap-2" : "space-y-2"}>
            {showRange ? (
              <>
                <label className={labelClass}>
                  <span className="text-xs font-semibold text-slate-300">Range min $</span>
                  <input name="priceRangeMin" inputMode="decimal" required={showRange} placeholder="300" className={inputClass} />
                </label>
                <label className={labelClass}>
                  <span className="text-xs font-semibold text-slate-300">Range max $</span>
                  <input name="priceRangeMax" inputMode="decimal" required={showRange} placeholder="450" className={inputClass} />
                </label>
              </>
            ) : null}
            {showExact ? (
              <label className={showRange ? "col-span-2 block" : labelClass}>
                <span className="text-xs font-semibold text-slate-300">
                  {serviceType === "rental_dumpster" ? "Exact price $" : "Exact quote $"}
                </span>
                <input name="quotedTotal" inputMode="decimal" required={showExact} placeholder="450" className={inputClass} />
              </label>
            ) : null}
          </div>

          {serviceType === "junk_removal" ? (
            <div className="grid grid-cols-2 gap-2">
              <label className={labelClass}>
                <span className="text-xs font-semibold text-slate-300">Load size</span>
                <select
                  name="loadSize"
                  value={loadSize}
                  onChange={(event) => setLoadSize(event.target.value)}
                  className={inputClass}
                  required
                >
                  <option value="quarter_to_half">1/4 - 1/2</option>
                  <option value="half_to_three_quarters">1/2 - 3/4</option>
                  <option value="three_quarters_to_full">3/4 - Full</option>
                  <option value="custom">Custom</option>
                </select>
              </label>
              {loadSize === "custom" ? (
                <label className={labelClass}>
                  <span className="text-xs font-semibold text-slate-300">Loads</span>
                  <input name="customLoads" type="number" min={0.25} step={0.25} required className={inputClass} placeholder="1.5" />
                </label>
              ) : null}
            </div>
          ) : null}

          {serviceType === "land_clearing" ? (
            <div className="space-y-2">
              <label className={labelClass}>
                <span className="text-xs font-semibold text-slate-300">Area / scope</span>
                <input name="landClearingAreaScope" required className={inputClass} placeholder="Backyard brush line" />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className={labelClass}>
                  <span className="text-xs font-semibold text-slate-300">Access</span>
                  <select name="landClearingAccessDifficulty" required className={inputClass} defaultValue="moderate">
                    <option value="easy">Easy</option>
                    <option value="moderate">Moderate</option>
                    <option value="hard">Hard</option>
                  </select>
                </label>
                <label className={labelClass}>
                  <span className="text-xs font-semibold text-slate-300">Haul away</span>
                  <select name="landClearingHaulAway" required className={inputClass} defaultValue="yes">
                    <option value="yes">Yes</option>
                    <option value="no">No</option>
                  </select>
                </label>
              </div>
            </div>
          ) : null}

          {serviceType === "demolition" ? (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <label className={labelClass}>
                  <span className="text-xs font-semibold text-slate-300">Demo type</span>
                  <select name="demolitionType" required className={inputClass} defaultValue="shed">
                    <option value="shed">Shed</option>
                    <option value="deck">Deck</option>
                    <option value="fence">Fence</option>
                    <option value="interior">Interior</option>
                    <option value="concrete">Concrete</option>
                    <option value="other">Other</option>
                  </select>
                </label>
                <label className={labelClass}>
                  <span className="text-xs font-semibold text-slate-300">Haul away</span>
                  <select name="demolitionHaulAway" required className={inputClass} defaultValue="yes">
                    <option value="yes">Yes</option>
                    <option value="no">No</option>
                  </select>
                </label>
              </div>
              <label className={labelClass}>
                <span className="text-xs font-semibold text-slate-300">Scope size</span>
                <input name="demolitionScopeSize" required className={inputClass} placeholder="10x12 shed" />
              </label>
            </div>
          ) : null}

          {serviceType === "rental_dumpster" ? (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <label className={labelClass}>
                  <span className="text-xs font-semibold text-slate-300">Dumpster</span>
                  <select name="dumpsterSize" required className={inputClass} defaultValue="15_yard">
                    <option value="10_yard">10-yard</option>
                    <option value="15_yard">15-yard</option>
                    <option value="20_yard">20-yard</option>
                  </select>
                </label>
                <label className={labelClass}>
                  <span className="text-xs font-semibold text-slate-300">Pickup</span>
                  <input name="dumpsterPickupDate" type="date" required className={inputClass} />
                </label>
              </div>
              <label className={labelClass}>
                <span className="text-xs font-semibold text-slate-300">Placement</span>
                <input name="dumpsterPlacementLocation" required className={inputClass} placeholder="Driveway, right side" />
              </label>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
