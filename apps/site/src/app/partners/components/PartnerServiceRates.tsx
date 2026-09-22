import {
  formatPartnerServiceRate,
  getPartnerServiceDefinition,
} from "@myst-os/pricing";
import type {
  BookingStructuredRates,
  BookingStructuredRatesStatus,
} from "../lib/booking-page-data";

export function PartnerServiceRates({
  serviceKey,
  card,
  status,
  compact = false,
}: {
  serviceKey: string;
  card: BookingStructuredRates | null;
  status: BookingStructuredRatesStatus;
  compact?: boolean;
}) {
  const definition = getPartnerServiceDefinition(serviceKey);
  const rates =
    card?.rates.filter((rate) => rate.serviceKey === serviceKey) ?? [];
  const missing =
    definition?.variants.filter(
      (variant) => !rates.some((rate) => rate.variantKey === variant.key),
    ) ?? [];
  if (compact && (status === "hidden" || !rates.length))
    return (
      <p className="mt-2 text-xs text-slate-600">
        {status === "hidden"
          ? "Rates available to authorized users."
          : "Rate not set yet."}
      </p>
    );
  return (
    <div className="mt-4 rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
      <p className="font-semibold text-slate-900">Your service rates</p>
      {status === "hidden" ? (
        <p className="mt-1">
          Account rates are available to authorized billing and rate users. You
          can still send this request for review.
        </p>
      ) : (
        <>
          {rates.map((rate) => (
            <div
              key={rate.key}
              className="mt-3 border-t border-slate-200 pt-3 first:mt-0"
            >
              <p className="flex flex-wrap justify-between gap-x-3 gap-y-1">
                <span>{rate.label}</span>
                <strong>
                  {formatPartnerServiceRate(rate, card!.currency)}
                </strong>
              </p>
              <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-5">
                Measured by: {rate.measurement}
              </p>
              {rate.fullLoadCubicYards ? (
                <p className="mt-1 text-xs">
                  One full load: {rate.fullLoadCubicYards} cubic yards.
                </p>
              ) : null}
              {rate.unit === "room" &&
              rate.roomMaxSquareFeet &&
              rate.roomMaxHeightFeet ? (
                <p className="mt-1 text-xs">
                  Room limit: {rate.roomMaxSquareFeet} sq ft floor area;{" "}
                  {rate.roomMaxHeightFeet} ft ceiling height.
                </p>
              ) : null}
              {rate.materials ? (
                <p className="mt-1 text-xs">
                  Materials:{" "}
                  {rate.materials === "stonegate"
                    ? "provided by Stonegate"
                    : rate.materials === "partner"
                      ? "provided by your company"
                      : "shared responsibility; see inclusions"}
                  .{rate.coats ? ` Paint coats: ${rate.coats}.` : ""}
                </p>
              ) : null}
              {rate.inclusions.length || rate.exclusions.length ? (
                <details className="mt-2">
                  <summary className="min-h-11 cursor-pointer py-3 text-xs font-semibold">
                    Included and excluded work
                  </summary>
                  {rate.inclusions.length ? (
                    <p className="mt-1 text-xs leading-5">
                      Included: {rate.inclusions.join("; ")}
                    </p>
                  ) : null}
                  {rate.exclusions.length ? (
                    <p className="mt-1 text-xs leading-5">
                      Excluded: {rate.exclusions.join("; ")}
                    </p>
                  ) : null}
                </details>
              ) : null}
            </div>
          ))}
          {missing.length ? (
            <p className="mt-2 text-xs leading-5">
              Rate not set yet.
              {rates.length
                ? ` This applies to ${missing.map((variant) => variant.label.toLowerCase()).join(" and ")}.`
                : ""}{" "}
              Stonegate will confirm pricing during review. You can still
              include this service.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

export function PartnerRequestRateNote({
  card,
  status,
}: {
  card: BookingStructuredRates | null;
  status: BookingStructuredRatesStatus;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-700">
      <p>
        These are your company’s service rates. Stonegate will confirm
        measurements, scope, service visits, and the price after reviewing this
        request.
      </p>
      {status === "published" &&
      card?.visitMinimum !== null &&
      card?.visitMinimum !== undefined ? (
        <p className="mt-1 font-semibold">
          Visit minimum:{" "}
          {new Intl.NumberFormat("en-US", {
            style: "currency",
            currency: card.currency,
            minimumFractionDigits: 2,
            maximumFractionDigits: 4,
          }).format(Number(card.visitMinimum))}
          . This is a visit minimum, not a separate charge for each selected
          service.
        </p>
      ) : null}
      {status === "published" && card?.legacyItems?.length ? (
        <details className="mt-2">
          <summary className="min-h-11 cursor-pointer py-3 text-sm font-semibold">
            Existing flat rates
          </summary>
          <p className="text-xs leading-5">
            These saved flat rates remain unchanged. Stonegate will confirm how
            they apply to the requested work.
          </p>
          <ul className="mt-2 space-y-2 text-xs">
            {card.legacyItems.map((item) => (
              <li
                key={item.id}
                className="flex flex-wrap justify-between gap-2"
              >
                <span>
                  {item.label ?? item.tierKey} ·{" "}
                  {item.serviceKey.replaceAll("_", " ").replaceAll("-", " ")}
                </span>
                <strong>
                  {new Intl.NumberFormat("en-US", {
                    style: "currency",
                    currency: card.currency,
                  }).format(item.amountCents / 100)}
                </strong>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
