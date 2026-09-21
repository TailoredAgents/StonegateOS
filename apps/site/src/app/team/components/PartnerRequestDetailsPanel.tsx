"use client";

import * as React from "react";
import {
  parsePartnerRequestDetails,
  parsePartnerRequestPhotos,
  type PartnerRequestDetails,
  type PartnerRequestPhoto,
} from "@myst-os/sdk";
import { loadPartnerServiceReviews } from "../actions/partner-service-reviews";
import { requestedPartnerWindow } from "../lib/partner-request-presentation";
import {
  PARTNER_EQUIPMENT_OPTIONS,
  PARTNER_HAZARD_OPTIONS,
} from "../../partners/lib/partner-booking-add-ons";

function readable(value: string): string {
  return value.replace(/([a-z])([A-Z])/gu, "$1 $2").replace(/[_-]+/gu, " ");
}

function optionLabel(
  options: readonly { key: string; label: string }[],
  value: string,
): string {
  return (
    options.find((option) => option.key === value)?.label ?? readable(value)
  );
}

function localDate(value: string): string {
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("en-US", {
        dateStyle: "medium",
        timeZone: "UTC",
      }).format(date)
    : value;
}

function dateTime(value: string, timezone: string | null): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  try {
    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: timezone ?? "UTC",
    }).format(date);
  } catch {
    return value;
  }
}

function money(amount: number | null, currency: string | null): string | null {
  if (amount === null || !currency) return null;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).format(amount / 100);
  } catch {
    return null;
  }
}

function photoUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? value : null;
  } catch {
    return null;
  }
}

/** Read-only client preferences sit beside the staff's separate confirmation form. */
export function PartnerRequestScheduleSummary({
  details,
  hidePreferredDates = false,
}: {
  details: PartnerRequestDetails;
  hidePreferredDates?: boolean;
}) {
  const data = parsePartnerRequestDetails(details);
  if (!data) return null;
  const scheduling = data.scheduling;
  const hasStatusNotice = ["canceled", "declined", "approval_needed"].includes(
    data.publicStatus,
  );
  if (
    hidePreferredDates &&
    !scheduling.requestedWindow &&
    !scheduling.confirmedWindow &&
    !scheduling.confirmedStartAt &&
    scheduling.assistancePreference === "none" &&
    scheduling.timezone === "America/New_York" &&
    !hasStatusNotice
  )
    return null;
  const window = (value: { startAt: string; endAt: string }) =>
    `${dateTime(value.startAt, scheduling.timezone)} – ${dateTime(value.endAt, scheduling.timezone)}`;
  return (
    <section
      aria-label="Client scheduling preferences"
      className="space-y-3 border-b border-slate-200 pb-5 text-sm"
    >
      {!hidePreferredDates ? (
        <h4 className="font-semibold text-slate-900">
          Client’s requested timing
        </h4>
      ) : null}
      {!hidePreferredDates && scheduling.preferredWindows.length ? (
        <ul className="space-y-2 text-slate-700">
          {scheduling.preferredWindows.map((value, index) => (
            <li key={`${value.localDate}:${value.timeOfDay}:${index}`}>
              <span className="block">
                {index ? `Alternative ${index}: ` : ""}
                {requestedPartnerWindow(value)}
              </span>
              {value.timezone && value.timezone !== scheduling.timezone ? (
                <span className="text-xs text-slate-500">{value.timezone}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : !hidePreferredDates ? (
        <p className="text-slate-600">No preferred date provided.</p>
      ) : null}
      {scheduling.requestedWindow ? (
        <p className="text-slate-700">
          <span className="block text-xs text-slate-500">
            Requested arrival window
          </span>
          {window(scheduling.requestedWindow)}
        </p>
      ) : null}
      {scheduling.confirmedWindow ? (
        <p className="text-slate-700">
          <span className="block text-xs text-slate-500">
            Confirmed arrival window
          </span>
          {window(scheduling.confirmedWindow)}
        </p>
      ) : null}
      {scheduling.confirmedStartAt ? (
        <p className="text-slate-700">
          <span className="block text-xs text-slate-500">Scheduled start</span>
          {dateTime(scheduling.confirmedStartAt, scheduling.timezone)}
        </p>
      ) : null}
      {scheduling.assistancePreference === "waitlist" ||
      scheduling.assistancePreference === "callback" ? (
        <p className="font-medium text-slate-700">
          {scheduling.assistancePreference === "waitlist"
            ? "Client asked to join the waitlist."
            : "Client asked for a call to arrange service."}
        </p>
      ) : null}
      {!hidePreferredDates ||
      scheduling.timezone !== "America/New_York" ||
      hasStatusNotice ? (
        <p className="text-xs leading-5 text-slate-500">
          {scheduling.timezone === "America/New_York"
            ? "Eastern time"
            : (scheduling.timezone ?? "Time zone not provided")}
          {data.publicStatus === "canceled"
            ? " · Request canceled."
            : data.publicStatus === "declined"
              ? " · Request declined."
              : data.publicStatus === "approval_needed"
                ? " · Waiting for client approval."
                : !scheduling.confirmedWindow && !scheduling.confirmedStartAt
                  ? " · Awaiting Stonegate confirmation."
                  : ""}
        </p>
      ) : null}
    </section>
  );
}

type Field = [label: string, value: React.ReactNode];

function RequestGroups({
  compact,
  summary,
  dark,
  children,
}: {
  compact: boolean;
  summary: string;
  dark: boolean;
  children: React.ReactNode;
}) {
  if (!compact) return <>{children}</>;
  return (
    <details
      className={`border-t ${dark ? "border-white/10" : "border-slate-200"}`}
    >
      <summary className="min-h-12 cursor-pointer break-words py-3 text-sm [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2">
        <span
          className={`font-semibold ${dark ? "text-slate-100" : "text-slate-900"}`}
        >
          Request details
        </span>
        {summary ? (
          <span
            className={`mt-1 block text-xs ${dark ? "text-slate-400" : "text-slate-600"}`}
          >
            {summary}
          </span>
        ) : null}
      </summary>
      <div className="pb-2">{children}</div>
    </details>
  );
}

/** Read-only partner information, shared by scheduling review and staff job cards. */
export function PartnerRequestDetailsPanel({
  details,
  photos,
  appearance = "light",
  compact = false,
  hideHeader = false,
  review = false,
}: {
  details: PartnerRequestDetails;
  photos?: PartnerRequestPhoto[];
  appearance?: "light" | "dark";
  compact?: boolean;
  hideHeader?: boolean;
  review?: boolean;
}) {
  const data = React.useMemo(
    () => parsePartnerRequestDetails(details),
    [details],
  );
  const headingId = React.useId();
  const [photoItems, setPhotoItems] = React.useState<
    PartnerRequestPhoto[] | null
  >(photos ?? null);
  const [photoBusy, setPhotoBusy] = React.useState(false);
  const [photoError, setPhotoError] = React.useState<string | null>(null);
  const [failedPhotos, setFailedPhotos] = React.useState<Set<string>>(
    () => new Set(),
  );
  const generation = React.useRef(0);
  React.useEffect(() => {
    generation.current += 1;
    setPhotoItems(photos ?? null);
    setPhotoBusy(false);
    setPhotoError(null);
    setFailedPhotos(new Set());
    return () => {
      generation.current += 1;
    };
  }, [
    data?.jobId,
    data?.photos.count,
    data?.photos.detailPath,
    data?.visibility.photos,
    photos,
  ]);

  if (!data) {
    return (
      <p
        role="alert"
        className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950"
      >
        Partner request details could not be verified. Refresh this booking
        before reviewing the request.
      </p>
    );
  }

  const dark = appearance === "dark";
  const text = dark ? "text-slate-100" : "text-slate-900";
  const muted = dark ? "text-slate-400" : "text-slate-600";
  const border = dark ? "border-white/10" : "border-slate-200";
  const button = dark
    ? "border-white/20 bg-slate-800 text-slate-100 hover:bg-slate-700"
    : "border-slate-300 bg-white text-slate-800 hover:bg-slate-50";
  const rows = (fields: Field[]) => (
    <dl className="grid gap-x-5 gap-y-3 sm:grid-cols-2">
      {fields
        .filter(
          ([, value]) => value !== null && value !== undefined && value !== "",
        )
        .map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className={`text-xs font-medium ${muted}`}>{label}</dt>
            <dd
              className={`mt-1 whitespace-pre-wrap break-words text-sm leading-6 [overflow-wrap:anywhere] ${text}`}
            >
              {value}
            </dd>
          </div>
        ))}
    </dl>
  );
  const group = (title: string, summary: string, children: React.ReactNode) =>
    review && title === "Service details" ? (
      <div className="pb-5">{children}</div>
    ) : (
      <details className={`border-t ${border}`}>
        <summary className="min-h-12 cursor-pointer break-words py-3 text-sm [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2">
          <span className={`font-semibold ${text}`}>{title}</span>
          {summary ? (
            <span className={`ml-2 font-normal ${muted}`}>{summary}</span>
          ) : null}
        </summary>
        <div className="pb-4">{children}</div>
      </details>
    );
  const contactRows = (
    contact: PartnerRequestDetails["onSiteContact"],
    prefix = "",
  ): Field[] => [
    [`${prefix}Name`, contact?.name],
    [
      `${prefix}Phone`,
      contact?.phone ? (
        <a
          className="underline underline-offset-4"
          href={`tel:${contact.phone}`}
        >
          {contact.phone}
        </a>
      ) : null,
    ],
    [
      `${prefix}Email`,
      contact?.email ? (
        <a
          className="underline underline-offset-4"
          href={`mailto:${contact.email}`}
        >
          {contact.email}
        </a>
      ) : null,
    ],
  ];
  const safety = [
    data.scope.restrictedItems ? "Restricted items reported" : null,
    data.scope.nonStandard ? "Nonstandard work reported" : null,
    ...data.scope.hazardCategories.map((value) =>
      optionLabel(PARTNER_HAZARD_OPTIONS, value),
    ),
  ].filter(Boolean);
  const deadline = data.scope.requiredCompletion
    ? `${localDate(data.scope.requiredCompletion.localDate)}${data.scope.requiredCompletion.localTime ? ` at ${data.scope.requiredCompletion.localTime}` : ""}${data.scheduling.timezone ? ` (${data.scheduling.timezone})` : ""}`
    : null;
  const special: Field[] = [
    ["Restricted items", data.scope.restrictedItems ? "Yes" : null],
    ["Nonstandard work", data.scope.nonStandard ? "Yes" : null],
    [
      "Hazards reported",
      data.scope.hazardCategories
        .map((value) => optionLabel(PARTNER_HAZARD_OPTIONS, value))
        .join(", "),
    ],
    [
      "Equipment needed",
      data.scope.equipmentNeeds
        .map((value) => optionLabel(PARTNER_EQUIPMENT_OPTIONS, value))
        .join(", "),
    ],
    ["Requested completion deadline", deadline],
    ["Multiple stops", data.scope.multiStop ? "Yes" : null],
    ["Additional stops", data.scope.multiStopDetails],
    ...data.scope.additionalFields.map(
      (field): Field => [
        readable(field.key),
        typeof field.value === "boolean"
          ? field.value
            ? "Yes"
            : "No"
          : String(field.value),
      ],
    ),
  ];
  const hasSpecial = special.some(
    ([, value]) => value !== null && value !== "",
  );
  const workFields: Field[] = [
    ["Service option", data.service.tierLabel ?? data.service.tierKey],
    ["Item count", data.scope.itemCount],
    [
      "Approximate volume",
      data.scope.volumeCubicYards === null
        ? null
        : `${data.scope.volumeCubicYards} cubic yards`,
    ],
  ];
  const billingFields: Field[] = [
    ["Purchase order", data.commercial.poNumber],
    ["Cost center", data.commercial.costCenter],
    ["Project reference", data.commercial.projectReference],
    [
      "Billing contact",
      data.visibility.financials ? data.commercial.billingContact?.name : null,
    ],
    [
      "Billing email",
      data.visibility.financials ? data.commercial.billingContact?.email : null,
    ],
  ];
  const proofCount = (count: number | null) =>
    count === null ? "Not recorded" : `${count} photo${count === 1 ? "" : "s"}`;
  const count = photoItems?.length ?? data.photos.count;
  const verifiedEmptyPhotos =
    data.visibility.photos &&
    data.photos.count === 0 &&
    count === 0 &&
    !photoError &&
    !photoBusy &&
    failedPhotos.size === 0;
  const hasContactDetails = Boolean(
    data.location ||
      data.onSiteContact ||
      data.alternateContact ||
      data.accessDetails,
  );
  const hasReviewRequirements =
    hasSpecial ||
    data.proof.before !== 0 ||
    data.proof.after !== 0 ||
    data.proof.package;
  const proofSummary = review
    ? [
        data.proof.before !== 0
          ? `Before: ${proofCount(data.proof.before)}`
          : null,
        data.proof.after !== 0
          ? `After: ${proofCount(data.proof.after)}`
          : null,
        data.proof.package ? "Proof package" : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : `Before: ${proofCount(data.proof.before)} · After: ${proofCount(data.proof.after)}`;
  const timezone = data.scheduling.timezone;
  const formatWindow = (window: { startAt: string; endAt: string } | null) =>
    window
      ? `${dateTime(window.startAt, timezone)} – ${dateTime(window.endAt, timezone)}`
      : null;
  async function refreshPhotos() {
    if (!data?.visibility.photos || !data.photos.detailPath || photoBusy)
      return;
    const current = ++generation.current;
    setPhotoBusy(true);
    setPhotoError(null);
    const result = await loadPartnerServiceReviews({
      id: data.jobId,
      accountId: data.accountId,
    }).catch(() => null);
    if (generation.current !== current) return;
    setPhotoBusy(false);
    const refreshedPhotos = result?.ok
      ? parsePartnerRequestPhotos(result.detail?.photos)
      : null;
    if (
      !result?.ok ||
      !result.detail ||
      !refreshedPhotos ||
      result.detail.id !== data.jobId ||
      result.detail.accountId !== data.accountId
    ) {
      setPhotoError(
        result && !result.ok
          ? result.message
          : "Photos could not be loaded. Try again.",
      );
      return;
    }
    setPhotoItems(refreshedPhotos);
    setFailedPhotos(new Set());
  }

  const photoSection = (
    <details
      className={`border-t ${border}`}
      open={review && count > 0 ? true : undefined}
      onToggle={(event) => {
        if (event.currentTarget.open && photoItems === null && !photoError)
          void refreshPhotos();
      }}
    >
      <summary
        className={`min-h-12 cursor-pointer py-3 text-sm font-semibold ${text}`}
      >
        {review ? "Customer photos" : "Photos"}{" "}
        <span className={`ml-2 font-normal ${muted}`}>{count} attached</span>
      </summary>
      <div className="space-y-3 pb-3">
        {!data.visibility.photos ? (
          <p className={`text-sm ${muted}`}>
            Your role cannot view these partner photos.
          </p>
        ) : !data.photos.detailPath ? (
          <p className={`text-sm ${muted}`}>
            {count === 0
              ? "No photos were attached."
              : "Photo previews are unavailable. Reopen this booking to refresh access."}
          </p>
        ) : (
          <>
            {photoError ? (
              <p
                role="alert"
                className={`text-sm ${dark ? "text-amber-200" : "text-amber-900"}`}
              >
                {photoError}
              </p>
            ) : null}
            {photoBusy ? (
              <p role="status" className={`text-sm ${muted}`}>
                Loading photos…
              </p>
            ) : null}
            {photoItems?.length ? (
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {photoItems.map((photo) => {
                  const url = photoUrl(photo.url);
                  return (
                    <li key={photo.id} className="min-w-0">
                      {url && !failedPhotos.has(photo.id) ? (
                        <a
                          href={url}
                          target="_blank"
                          rel="noreferrer"
                          className="block rounded-lg focus-visible:outline-2"
                        >
                          {/* Signed account media bypasses image optimization. */}
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={url}
                            alt={
                              photo.caption ||
                              `${readable(photo.category)} photo supplied with this request`
                            }
                            width={320}
                            height={240}
                            loading="lazy"
                            referrerPolicy="no-referrer"
                            className="aspect-[4/3] w-full rounded-lg object-cover"
                            onError={() =>
                              setFailedPhotos(
                                (current) => new Set([...current, photo.id]),
                              )
                            }
                          />
                        </a>
                      ) : (
                        <p
                          className={`rounded-lg border p-3 text-xs leading-5 ${border} ${muted}`}
                        >
                          {photo.status === "ready"
                            ? "Preview unavailable. Refresh photos to try again."
                            : `Photo ${readable(photo.status)}.`}
                        </p>
                      )}
                      <p
                        className={`mt-1 break-words text-xs font-medium ${text}`}
                      >
                        {readable(photo.category)}
                      </p>
                      {photo.filename ? (
                        <p
                          className={`mt-1 break-words text-xs [overflow-wrap:anywhere] ${muted}`}
                        >
                          {photo.filename}
                        </p>
                      ) : null}
                      {photo.caption ? (
                        <p
                          className={`mt-1 whitespace-pre-wrap break-words text-xs leading-5 [overflow-wrap:anywhere] ${muted}`}
                        >
                          {photo.caption}
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : photoItems ? (
              <p className={`text-sm ${muted}`}>No photos were attached.</p>
            ) : null}
            <button
              type="button"
              onClick={() => void refreshPhotos()}
              disabled={photoBusy}
              className={`inline-flex min-h-11 items-center rounded-lg border px-3 py-2 text-sm font-semibold ${button}`}
            >
              {photoError ? "Try loading photos again" : "Refresh photos"}
            </button>
            {photoItems?.length ? (
              <p className={`text-xs ${muted}`}>
                Photo links expire. Refresh photos if a preview stops opening.
              </p>
            ) : null}
          </>
        )}
      </div>
    </details>
  );

  return (
    <section
      aria-labelledby={hideHeader ? undefined : headingId}
      aria-label={hideHeader ? "Submitted request details" : undefined}
      className={
        hideHeader ? "min-w-0" : `mt-4 min-w-0 border-t pt-4 ${border}`
      }
      data-partner-request={data.jobId}
    >
      {!hideHeader ? (
        <div className="mb-3">
          <h4 id={headingId} className={`text-sm font-semibold ${text}`}>
            Partner request
          </h4>
          <p
            className={`mt-1 break-words text-xs [overflow-wrap:anywhere] ${muted}`}
          >
            {data.accountName} · {data.service.label}
            {data.service.tierLabel ? ` · ${data.service.tierLabel}` : ""}
          </p>
        </div>
      ) : null}
      <div className="mb-4">
        <h5 className={`text-xs font-medium ${muted}`}>Requested work</h5>
        <p
          className={`mt-1 whitespace-pre-wrap break-words text-sm leading-6 [overflow-wrap:anywhere] ${text}`}
        >
          {data.description || "A description was not provided."}
        </p>
      </div>
      {data.originalJob ? (
        <p className={`mb-3 text-xs ${muted}`}>
          Additional service for original job{" "}
          {data.originalJob.jobId.slice(0, 8).toUpperCase()}.
        </p>
      ) : null}
      {review && data.onSiteContact ? (
        <p className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-slate-700">
          <span className="text-slate-500">On-site contact</span>
          <span className="font-medium">{data.onSiteContact.name}</span>
          {data.onSiteContact.phone ? (
            <a
              className="inline-flex min-h-11 min-w-11 items-center justify-center px-2 text-teal-800 underline underline-offset-4"
              href={`tel:${data.onSiteContact.phone}`}
              aria-label={`Call ${data.onSiteContact.name || "on-site contact"}`}
              title={data.onSiteContact.phone}
            >
              Call
            </a>
          ) : null}
          {data.onSiteContact.email ? (
            <a
              className="inline-flex min-h-11 min-w-11 items-center justify-center px-2 text-teal-800 underline underline-offset-4"
              href={`mailto:${data.onSiteContact.email}`}
              aria-label={`Email ${data.onSiteContact.name || "on-site contact"}`}
              title={data.onSiteContact.email}
            >
              Email
            </a>
          ) : null}
        </p>
      ) : null}
      {data.crewInstructions || safety.length > 0 || deadline ? (
        <aside
          aria-label="Important work instructions"
          className={`mb-4 rounded-lg border-l-4 px-3 py-2 ${dark ? "border-amber-300 bg-amber-300/10 text-amber-100" : "border-amber-400 bg-amber-50 text-amber-950"}`}
        >
          <h5 className="text-sm font-semibold">Important work instructions</h5>
          {safety.length ? (
            <p className="mt-1 break-words text-sm leading-6">
              {safety.join(" · ")}
            </p>
          ) : null}
          {deadline ? (
            <p className="mt-1 text-sm leading-6">
              Completion requested by {deadline}.
            </p>
          ) : null}
          {data.crewInstructions ? (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 [overflow-wrap:anywhere]">
              {data.crewInstructions}
            </p>
          ) : null}
        </aside>
      ) : null}
      {review && !verifiedEmptyPhotos ? (
        <div className="mb-2">{photoSection}</div>
      ) : null}
      <RequestGroups
        compact={compact}
        dark={dark}
        summary={[
          data.onSiteContact?.name,
          count > 0 ? `${count} photo${count === 1 ? "" : "s"}` : null,
          data.commercial.poNumber
            ? review
              ? data.commercial.poNumber
              : `PO ${data.commercial.poNumber}`
            : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      >
        {workFields.some(([, value]) => value !== null && value !== "") ||
        data.addOns.length
          ? group(
              "Service details",
              data.addOns.length
                ? `${data.addOns.length} additional service${data.addOns.length === 1 ? "" : "s"}`
                : "",
              <div className="space-y-4">
                {rows(workFields)}
                {data.addOns.length ? (
                  <ul className={`divide-y ${border}`}>
                    {data.addOns.map((item) => (
                      <li key={item.key} className="py-2 text-sm">
                        <p className={`font-medium ${text}`}>
                          {item.label} · {item.quantity} {item.unitLabel}
                        </p>
                        {data.visibility.financials ? (
                          <p className={`mt-1 text-xs ${muted}`}>
                            {money(item.lineTotalMinor, item.currency) ??
                              "Price to confirm"}
                            {money(item.unitAmountMinor, item.currency)
                              ? ` · ${money(item.unitAmountMinor, item.currency)} per ${item.unitLabel}`
                              : ""}
                          </p>
                        ) : null}
                        {item.requiresReview ? (
                          <p className={`mt-1 text-xs ${muted}`}>
                            Staff review required
                          </p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>,
            )
          : null}
        {!review || hasContactDetails
          ? group(
              "Contact and access",
              review
                ? [
                    data.accessDetails ? "Arrival instructions" : null,
                    data.alternateContact ? "Backup contact" : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : (data.onSiteContact?.name ?? "Contact not recorded"),
              <div className="space-y-4">
                {data.location
                  ? rows([
                      ["Service location", data.location.name],
                      [
                        "Service address",
                        [
                          data.location.address.line1,
                          data.location.address.line2,
                          data.location.address.city,
                          data.location.address.state,
                          data.location.address.postalCode,
                        ]
                          .filter(Boolean)
                          .join(", "),
                      ],
                      ["Property reference", data.location.externalPropertyId],
                    ])
                  : null}
                {data.onSiteContact ? (
                  rows(contactRows(data.onSiteContact, "On-site "))
                ) : (
                  <p className={`text-sm ${muted}`}>
                    An on-site contact was not provided.
                  </p>
                )}
                {data.alternateContact
                  ? rows(contactRows(data.alternateContact, "Alternate "))
                  : null}
                {data.accessDetails
                  ? rows([["Access, parking and loading", data.accessDetails]])
                  : null}
              </div>,
            )
          : null}
        {hasSpecial && !review
          ? group(
              "Special requirements",
              data.scope.multiStop ? "Multiple stops" : "",
              rows(special),
            )
          : null}
        {billingFields.some(
          ([, value]) => value !== null && value !== undefined && value !== "",
        )
          ? group(
              "Work order and billing",
              data.commercial.poNumber
                ? review
                  ? data.commercial.poNumber
                  : `PO ${data.commercial.poNumber}`
                : "",
              rows(billingFields),
            )
          : null}
        {!review || hasReviewRequirements
          ? group(
              review ? "Job requirements" : "Completion photos",
              proofSummary,
              <div className="space-y-4">
                {review && hasSpecial ? rows(special) : null}
                {rows([
                  [
                    "Before service",
                    review && data.proof.before === 0
                      ? null
                      : proofCount(data.proof.before),
                  ],
                  [
                    "After service",
                    review && data.proof.after === 0
                      ? null
                      : proofCount(data.proof.after),
                  ],
                  [
                    "Formal proof package",
                    data.proof.package
                      ? "Requested"
                      : review
                        ? null
                        : "Not requested",
                  ],
                ])}
              </div>,
            )
          : null}
        {!review
          ? group(
              "Scheduling",
              data.publicStatus === "canceled"
                ? "Request canceled"
                : data.publicStatus === "declined"
                  ? "Request declined"
                  : data.scheduling.confirmedWindow ||
                      data.scheduling.confirmedStartAt
                    ? "Arrival confirmed"
                    : "Staff confirmation required",
              <div className="space-y-3">
                {rows([
                  ["Time zone", timezone ?? "Not recorded"],
                  [
                    "Preferred dates",
                    data.scheduling.preferredWindows.length
                      ? data.scheduling.preferredWindows
                          .map(
                            (window) =>
                              `${localDate(window.localDate)} · ${window.timeOfDay === "anytime" ? "Any time" : readable(window.timeOfDay)}${window.timezone && window.timezone !== timezone ? ` (${window.timezone})` : ""}`,
                          )
                          .join("\n")
                      : "None provided",
                  ],
                  [
                    "Requested arrival window",
                    formatWindow(data.scheduling.requestedWindow),
                  ],
                  [
                    "Confirmed arrival window",
                    formatWindow(data.scheduling.confirmedWindow),
                  ],
                  [
                    "Scheduled start",
                    data.scheduling.confirmedStartAt
                      ? dateTime(data.scheduling.confirmedStartAt, timezone)
                      : null,
                  ],
                  [
                    "Scheduling follow-up",
                    data.scheduling.assistancePreference === "waitlist"
                      ? "Add to waitlist"
                      : data.scheduling.assistancePreference === "callback"
                        ? "Call to arrange service"
                        : "No additional follow-up requested",
                  ],
                ])}
                {data.scheduling.preferredWindows.length ? (
                  <p className={`text-xs ${muted}`}>
                    Preferred dates are requests. Use the confirmed arrival
                    window for the agreed schedule.
                  </p>
                ) : null}
              </div>,
            )
          : null}
        {!review ? photoSection : null}
      </RequestGroups>
    </section>
  );
}
