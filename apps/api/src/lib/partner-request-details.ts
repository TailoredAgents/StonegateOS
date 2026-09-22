import type { PartnerRequestDetails } from "@myst-os/sdk";
import { readPartnerJobLocationSnapshot } from "./partner-job-location";

export type PartnerRequestDetailsSource = {
  jobId: string;
  accountId: string;
  accountName: string;
  serviceKey: string | null;
  serviceLabel: string | null;
  tierKey: string | null;
  publicStatus: string;
  confirmationMode: string;
  originalJobId: string | null;
  scopeSnapshot: unknown;
  rateSnapshot: unknown;
  addOnsSnapshot: unknown;
  proofRequirementsSnapshot: unknown;
  poNumber: string | null;
  costCenter: string | null;
  projectReference: string | null;
  billingContactSnapshot: unknown;
  appointmentStatus: string | null;
  appointmentStartAt: Date | null;
  schedulingTimezone: string | null;
  promisedArrivalStartAt: Date | null;
  promisedArrivalEndAt: Date | null;
  arrivalWindowStartAt: Date | null;
  arrivalWindowEndAt: Date | null;
  draftPreferredWindows?: unknown;
  draftAssistancePreference?: unknown;
};

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown, maximum = 4_000): string | null =>
  typeof value === "string" && value.trim().length > 0
    ? value.slice(0, maximum)
    : null;
const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
const count = (value: unknown): number | null =>
  value === false
    ? 0
    : value === true
      ? 1
      : typeof value === "number" &&
          Number.isSafeInteger(value) &&
          value >= 0 &&
          value <= 20
        ? value
        : null;
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.slice(0, 30).flatMap((entry) => {
        const result = text(entry, 100);
        return result ? [result] : [];
      })
    : [];
function contact(value: unknown) {
  const source = record(value);
  const result = {
    name: text(source["name"], 200),
    phone: text(source["phone"], 50),
    email: text(source["email"], 320),
  };
  return Object.values(result).some(Boolean) ? result : null;
}
function iso(value: unknown): string | null {
  const date =
    value instanceof Date
      ? value
      : typeof value === "string"
        ? new Date(value)
        : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function window(start: unknown, end: unknown) {
  const startAt = iso(start),
    endAt = iso(end);
  return startAt && endAt && startAt < endAt ? { startAt, endAt } : null;
}

export function hasConfirmedPartnerSchedule(source: {
  publicStatus: string;
  appointmentStatus: string | null;
  appointmentStartAt: Date | null;
}): boolean {
  return (
    source.appointmentStartAt !== null &&
    ["confirmed", "completed", "no_show"].includes(
      source.appointmentStatus ?? "",
    ) &&
    [
      "confirmed",
      "en_route",
      "on_site",
      "in_progress",
      "completed",
      "no_show",
    ].includes(source.publicStatus)
  );
}

/** Explicit public operational fields only. Never spread source JSON into staff responses. */
export function buildPartnerRequestDetails(
  source: PartnerRequestDetailsSource,
  visibility: PartnerRequestDetails["visibility"],
  photoCount = 0,
): PartnerRequestDetails {
  const snapshot = record(source.scopeSnapshot);
  const scope = record(snapshot["scope"]);
  const rate = record(source.rateSnapshot);
  const proof = record(source.proofRequirementsSnapshot);
  const location = readPartnerJobLocationSnapshot(snapshot);
  const timezone = location?.timezone ?? source.schedulingTimezone;
  const completion = record(scope["requiredCompletion"]);
  const completionDate = text(completion["localDate"], 10);
  const billingContact = record(source.billingContactSnapshot);
  const requested = record(snapshot["requestedArrivalWindow"]);
  const scheduled = hasConfirmedPartnerSchedule(source);
  const pending = ["requested", "under_review", "approval_needed"].includes(
    source.publicStatus,
  );
  const preferred =
    snapshot["preferredWindows"] ?? source.draftPreferredWindows;
  const assistance =
    snapshot["scheduleAssistancePreference"] ??
    source.draftAssistancePreference;
  const hazardCategories = strings(scope["hazardCategories"]);
  const equipmentNeeds = strings(scope["equipmentNeeds"]);
  const legacyRestrictedItems = strings(scope["restrictedItems"]);
  return {
    version: 1,
    jobId: source.jobId,
    accountId: source.accountId,
    accountName: source.accountName,
    service: {
      key: source.serviceKey,
      label:
        text(snapshot["serviceLabel"], 200) ??
        source.serviceLabel ??
        source.serviceKey?.replaceAll("_", " ") ??
        "Service request",
      tierKey: source.tierKey,
      tierLabel:
        text(rate["tierLabel"], 200) ??
        source.tierKey?.replaceAll("_", " ") ??
        null,
    },
    publicStatus: source.publicStatus,
    confirmationMode: source.confirmationMode,
    originalJob: source.originalJobId ? { jobId: source.originalJobId } : null,
    visibility: { ...visibility },
    location,
    description: text(snapshot["description"]),
    onSiteContact: contact(snapshot["onSiteContact"]),
    alternateContact: contact(scope["alternateContact"]),
    accessDetails: text(snapshot["accessDetails"]),
    crewInstructions: text(snapshot["crewInstructions"]),
    scope: {
      itemCount: number(scope["itemCount"]),
      volumeCubicYards: number(scope["volumeCubicYards"]),
      restrictedItems:
        scope["restrictedItems"] === true ||
        hazardCategories.length > 0 ||
        legacyRestrictedItems.length > 0,
      nonStandard:
        scope["nonStandard"] === true ||
        equipmentNeeds.length > 0 ||
        scope["multiStop"] === true,
      hazardCategories,
      equipmentNeeds,
      requiredCompletion:
        completionDate && /^\d{4}-\d{2}-\d{2}$/u.test(completionDate)
          ? {
              localDate: completionDate,
              localTime: text(completion["localTime"], 5),
            }
          : null,
      multiStop: scope["multiStop"] === true,
      multiStopDetails: text(scope["multiStopDetails"], 1_000),
      // Every supported form field is mapped above. Unknown historical/custom keys
      // are not safe to expose: they may contain billing or private access metadata.
      additionalFields: [
        ...(number(scope["quantity"]) !== null
          ? [{ key: "quantity", value: number(scope["quantity"])! }]
          : []),
        ...(legacyRestrictedItems.length > 0
          ? [
              {
                key: "restrictedItems",
                value: legacyRestrictedItems.join(", "),
              },
            ]
          : []),
      ],
    },
    addOns: Array.isArray(source.addOnsSnapshot)
      ? source.addOnsSnapshot.flatMap((value) => {
          const addon = record(value),
            key = text(addon["key"], 100),
            label = text(addon["label"], 200),
            quantity = number(addon["quantity"]);
          if (!key || !label || quantity === null) return [];
          return [
            {
              key,
              label,
              quantity,
              unitLabel: text(addon["unitLabel"], 100) ?? "item",
              unitAmountMinor: visibility.financials
                ? number(addon["unitAmountMinor"])
                : null,
              lineTotalMinor: visibility.financials
                ? number(addon["lineTotalMinor"])
                : null,
              currency: visibility.financials
                ? text(addon["currency"], 3)
                : null,
              requiresReview: addon["requiresReview"] === true,
            },
          ];
        })
      : [],
    commercial: {
      poNumber: source.poNumber,
      costCenter: source.costCenter,
      projectReference: source.projectReference,
      billingContact:
        visibility.financials &&
        (text(billingContact["name"]) || text(billingContact["email"]))
          ? {
              name: text(billingContact["name"], 200),
              email: text(billingContact["email"], 320),
            }
          : null,
    },
    proof: {
      before: count(proof["before"]),
      after: count(proof["after"]),
      package: proof["package"] === true,
    },
    scheduling: {
      timezone,
      preferredWindows: Array.isArray(preferred)
        ? preferred.slice(0, 3).flatMap((value) => {
            const entry = record(value),
              localDate = text(entry["localDate"], 10),
              timeOfDay = entry["timeOfDay"];
            return localDate &&
              /^\d{4}-\d{2}-\d{2}$/u.test(localDate) &&
              (timeOfDay === "morning" ||
                timeOfDay === "afternoon" ||
                timeOfDay === "anytime")
              ? [
                  {
                    localDate,
                    timeOfDay,
                    timezone: text(entry["timezone"], 100) ?? timezone,
                  },
                ]
              : [];
          })
        : [],
      requestedWindow:
        window(requested["startAt"], requested["endAt"]) ??
        (pending
          ? window(source.arrivalWindowStartAt, source.arrivalWindowEndAt)
          : null),
      confirmedWindow: scheduled
        ? (window(source.promisedArrivalStartAt, source.promisedArrivalEndAt) ??
          window(source.arrivalWindowStartAt, source.arrivalWindowEndAt))
        : null,
      confirmedStartAt: scheduled ? iso(source.appointmentStartAt) : null,
      assistancePreference:
        assistance === "waitlist" || assistance === "callback"
          ? assistance
          : "none",
    },
    photos: {
      count: Math.max(0, Math.trunc(photoCount)),
      detailPath: visibility.photos
        ? `/api/admin/partner-management/v1/service-requests/${encodeURIComponent(source.jobId)}?accountId=${encodeURIComponent(source.accountId)}`
        : null,
    },
  };
}
