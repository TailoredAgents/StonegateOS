import { formatPartnerDateTime } from "../lib/partner-date-time";
import Link from "next/link";
import type { PartnerMultiServiceRequest } from "@myst-os/sdk";
import { getPartnerServiceDefinition } from "@myst-os/pricing";
import { formatPartnerArrivalWindow } from "../lib/partner-arrival-window";
import { PartnerServiceRates } from "./PartnerServiceRates";
import { PartnerStatusBadge } from "./PartnerStatusBadge";
import { PartnerPanel } from "./PartnerPortalUi";
import { PartnerVisitDateChange } from "./PartnerVisitDateChange";

export function PartnerMultiServiceRequestDetails({
  request,
  currency = "USD",
  jobId,
  etag,
  canChangeVisits = false,
}: {
  request: PartnerMultiServiceRequest;
  currency?: string;
  jobId?: string;
  etag?: string | null;
  canChangeVisits?: boolean;
}) {
  const visits = [...request.visits].sort(
    (left, right) => Date.parse(left.startAt) - Date.parse(right.startAt),
  );
  return (
    <>
      <PartnerPanel>
        <h2 className="text-lg font-semibold text-slate-950">Service visits</h2>
        {visits.length && request.unscheduledServiceLineIds?.length ? (
          <p className="mt-2 text-sm text-amber-900">
            Some services are still awaiting scheduling. The visits below cover
            only the work listed for each date.
          </p>
        ) : null}
        {visits.length ? (
          <ol className="mt-4 space-y-3">
            {visits.map((visit, index) => {
              const arrival =
                visit.arrivalStartAt && visit.arrivalEndAt
                  ? {
                      startAt: visit.arrivalStartAt,
                      endAt: visit.arrivalEndAt,
                      timezone: visit.timezone,
                    }
                  : null;
              return (
                <li
                  key={visit.id}
                  className="rounded-xl border border-slate-200 p-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="font-semibold text-slate-950">
                      Visit {index + 1}
                    </h3>
                    <PartnerStatusBadge status={visit.status} />
                  </div>
                  <p className="mt-2 text-sm font-semibold text-slate-800">
                    {arrival
                      ? `Arrival: ${formatPartnerArrivalWindow(arrival)}`
                      : `Scheduled start: ${formatPartnerDateTime(new Date(visit.startAt), visit.timezone)}`}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {visit.timezone.replaceAll("_", " ")}
                  </p>
                  <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-slate-700">
                    {request.serviceLines
                      .filter((line) => visit.serviceLineIds.includes(line.id))
                      .map((line) => (
                        <li key={line.id}>{line.label}</li>
                      ))}
                  </ul>
                  {canChangeVisits &&
                  jobId &&
                  etag &&
                  visit.status === "scheduled" ? (
                    <PartnerVisitDateChange
                      key={`${visit.id}:${etag}`}
                      jobId={jobId}
                      visitId={visit.id}
                      etag={etag}
                      timezone={visit.timezone}
                    />
                  ) : null}
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="mt-3 text-sm leading-6 text-slate-600">
            No visits are scheduled yet. Stonegate will review the work and
            confirm which services will be completed on each visit. Your
            preferred dates are requests, not reservations.
          </p>
        )}
      </PartnerPanel>
      <PartnerPanel>
        <h2 className="text-lg font-semibold text-slate-950">
          Requested services
        </h2>
        <div className="mt-4 space-y-5">
          {request.serviceLines.map((line) => {
            const definition = getPartnerServiceDefinition(line.serviceKey);
            const activeVisits = visits.filter(
              (visit) =>
                visit.status !== "canceled" &&
                visit.serviceLineIds.includes(line.id),
            );
            const snapshot = line.pricingSnapshot ?? line.rateSnapshot;
            return (
              <section
                key={line.id}
                aria-label={line.label}
                className="min-w-0 border-t border-slate-200 pt-5 first:border-t-0 first:pt-0"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <h3 className="font-semibold text-slate-950">{line.label}</h3>
                  <PartnerStatusBadge status={line.status} />
                </div>
                {line.status === "pending" && !activeVisits.length ? (
                  <p className="mt-1 text-xs font-medium text-amber-800">
                    Awaiting scheduling
                  </p>
                ) : null}
                <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-slate-700">
                  {line.description}
                </p>
                <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
                  {Object.entries(line.scope)
                    .filter(([, value]) => value.trim())
                    .map(([key, value]) => {
                      const field = definition?.scopeFields.find(
                        (item) => item.key === key,
                      );
                      return (
                        <div key={key} className="min-w-0">
                          <dt className="text-xs font-semibold text-slate-500">
                            {field?.label ??
                              key.replace(/([a-z])([A-Z])/gu, "$1 $2")}
                          </dt>
                          <dd className="mt-1 whitespace-pre-wrap break-words text-slate-700">
                            {field?.options?.find(
                              (option) => option.value === value,
                            )?.label ?? value}
                          </dd>
                        </div>
                      );
                    })}
                </dl>
                {line.selectedAddOns.length ? (
                  <p className="mt-3 text-sm text-slate-700">
                    <strong>Removal extras: </strong>
                    {line.selectedAddOns
                      .map(
                        (extra) =>
                          `${extra.key.replaceAll("_", " ").replaceAll("-", " ")} × ${extra.quantity}`,
                      )
                      .join(", ")}
                  </p>
                ) : null}
                {jobId && line.photoEvidenceIds?.length ? (
                  <div className="mt-3">
                    <p className="text-xs font-semibold text-slate-500">
                      Reference photos for this service
                    </p>
                    <div className="mt-1 flex flex-wrap gap-2">
                      {line.photoEvidenceIds.map((id, index) => (
                        <Link
                          key={id}
                          href={`/partners/media/${encodeURIComponent(jobId)}/${encodeURIComponent(id)}`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex min-h-11 items-center rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-primary-800 underline"
                        >
                          Photo {index + 1}
                          <span className="sr-only">
                            {" "}
                            for {line.label}; opens in a new tab
                          </span>
                        </Link>
                      ))}
                    </div>
                  </div>
                ) : null}
                <PartnerServiceRates
                  serviceKey={line.serviceKey}
                  status={snapshot?.status ?? "missing"}
                  card={
                    snapshot && snapshot.status === "published"
                      ? {
                          versionId: snapshot.versionId ?? "saved",
                          currency: snapshot.currency,
                          visitMinimum: snapshot.visitMinimum,
                          rates: snapshot.rates,
                        }
                      : null
                  }
                />
                {line.quotedAmountCents !== null ? (
                  <p className="mt-3 text-sm font-semibold text-slate-900">
                    Reviewed service price:{" "}
                    {new Intl.NumberFormat("en-US", {
                      style: "currency",
                      currency: snapshot?.currency ?? currency,
                    }).format(line.quotedAmountCents / 100)}
                  </p>
                ) : null}
                {line.priceDescription ? (
                  <p className="mt-3 whitespace-pre-wrap break-words text-sm text-slate-700">
                    {line.priceDescription}
                  </p>
                ) : null}
              </section>
            );
          })}
        </div>
        <p className="mt-5 border-t border-slate-200 pt-4 text-xs leading-5 text-slate-500">
          Service rates do not calculate a job total. Stonegate confirms the
          scope and price after review.
        </p>
      </PartnerPanel>
    </>
  );
}
