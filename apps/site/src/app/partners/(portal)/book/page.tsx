import type { Metadata } from "next";
import Link from "next/link";
import { CalendarClock, MapPin, PhoneCall } from "lucide-react";
import { callPartnerApi } from "@/app/partners/lib/api";
import { getPartnerPortalContext } from "@/app/partners/lib/portal-context";
import { getPartnerPersonaPresentation } from "@/app/partners/lib/persona-presentation";
import type {
  PartnerDraft,
  PartnerLocation,
} from "@/app/partners/lib/portal-v2";
import {
  PartnerBookingWizard,
  type BookingWizardAddOn,
  type BookingWizardBaseOption,
  type BookingWizardCancellationPolicy,
  type BookingWizardLocation,
  type BookingWizardMoney,
  type BookingWizardService,
} from "@/app/partners/components/PartnerBookingWizard";
import { PartnerRepeatWorkManager } from "@/app/partners/components/PartnerRepeatWorkManager";
import {
  PartnerEmptyState,
  PartnerErrorState,
  PartnerNotice,
  PartnerPageHeader,
  PartnerPanel,
  partnerSecondaryButtonClass,
} from "@/app/partners/components/PartnerPortalUi";
import { getPublicCompanyProfile } from "@/lib/company";

export const metadata: Metadata = { title: "Request service" };

type CatalogItem = {
  key?: string;
  label?: string | null;
  description?: string | null;
  pricingStatus?: string;
  bookable?: unknown;
  priceState?: unknown;
  agreement?: unknown;
  inclusions?: unknown;
  exclusions?: unknown;
  quoteRule?: unknown;
  basePrice?: unknown;
  baseOptions?: unknown;
  addOns?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLocations(payload: unknown): PartnerLocation[] {
  if (!isRecord(payload)) return [];
  const candidate = Array.isArray(payload["data"])
    ? payload["data"]
    : Array.isArray(payload["locations"])
      ? payload["locations"]
      : [];
  return candidate.filter((item): item is PartnerLocation => {
    if (
      !isRecord(item) ||
      typeof item["id"] !== "string" ||
      !isRecord(item["address"])
    ) {
      return false;
    }
    const address = item["address"];
    return (
      typeof address["line1"] === "string" &&
      typeof address["city"] === "string" &&
      typeof address["state"] === "string" &&
      typeof address["postalCode"] === "string" &&
      item["active"] !== false
    );
  });
}

function wizardLocation(location: PartnerLocation): BookingWizardLocation {
  const address = location.address;
  return {
    id: location.id,
    name: location.siteName?.trim() || address.line1,
    address: [
      address.line1,
      address.line2,
      `${address.city}, ${address.state} ${address.postalCode}`,
    ]
      .filter(Boolean)
      .join(", "),
    serviceAreaStatus: location.serviceArea?.status,
    timezone: location.timezone ?? "America/New_York",
  };
}

function parseMoney(value: unknown): BookingWizardMoney | null {
  if (!isRecord(value)) return null;
  const amountMinor = value["amountMinor"];
  const currency = value["currency"];
  const minorUnit = value["minorUnit"];
  if (
    typeof amountMinor !== "number" ||
    !Number.isSafeInteger(amountMinor) ||
    amountMinor < 0 ||
    typeof currency !== "string" ||
    !/^[A-Z]{3}$/u.test(currency) ||
    minorUnit !== 2
  ) {
    return null;
  }
  return { amountMinor, currency, minorUnit };
}

function parsePricingStatus(
  value: unknown,
): "contracted" | "review_required" | "hidden" {
  return value === "contracted" ||
    value === "review_required" ||
    value === "hidden"
    ? value
    : "review_required";
}

function parsePriceState(
  value: unknown,
): "contracted" | "estimate" | "quote_required" | "standard_rate" | null {
  return value === "contracted" ||
    value === "estimate" ||
    value === "quote_required" ||
    value === "standard_rate"
    ? value
    : null;
}

function parseRateBearingPriceState(
  value: unknown,
): "contracted" | "estimate" | "standard_rate" {
  const state = parsePriceState(value);
  return state === "contracted" || state === "standard_rate"
    ? state
    : "estimate";
}

function parseBoundedTextList(value: unknown): string[] {
  return Array.isArray(value) && value.length <= 40
    ? value.filter(
        (item): item is string =>
          typeof item === "string" &&
          item.trim() === item &&
          item.length > 0 &&
          item.length <= 500,
      )
    : [];
}

function parseAgreement(value: unknown): BookingWizardService["agreement"] {
  if (!isRecord(value)) return null;
  const label = value["label"];
  const currency = value["currency"];
  const effectiveFrom = value["effectiveFrom"];
  const effectiveTo = value["effectiveTo"];
  if (
    typeof label !== "string" ||
    !label.trim() ||
    typeof currency !== "string" ||
    !/^[A-Z]{3}$/u.test(currency) ||
    typeof effectiveFrom !== "string" ||
    Number.isNaN(new Date(effectiveFrom).getTime()) ||
    (effectiveTo !== null &&
      (typeof effectiveTo !== "string" ||
        Number.isNaN(new Date(effectiveTo).getTime())))
  ) {
    return null;
  }
  return { label: label.trim(), currency, effectiveFrom, effectiveTo };
}

function parseCatalogAddOns(value: unknown): BookingWizardAddOn[] {
  if (!Array.isArray(value)) return [];
  const result: BookingWizardAddOn[] = [];
  const seen = new Set<string>();
  for (const raw of value.slice(0, 20)) {
    if (!isRecord(raw)) continue;
    const key = typeof raw["key"] === "string" ? raw["key"] : "";
    const label = typeof raw["label"] === "string" ? raw["label"].trim() : "";
    const unitLabel =
      typeof raw["unitLabel"] === "string" ? raw["unitLabel"].trim() : "";
    const minimumQuantity = raw["minimumQuantity"];
    const maximumQuantity = raw["maximumQuantity"];
    const instantMaximum = raw["instantConfirmationMaxQuantity"];
    if (
      !/^[a-z][a-z0-9_-]{1,79}$/u.test(key) ||
      !label ||
      !unitLabel ||
      seen.has(key) ||
      typeof minimumQuantity !== "number" ||
      !Number.isSafeInteger(minimumQuantity) ||
      typeof maximumQuantity !== "number" ||
      !Number.isSafeInteger(maximumQuantity) ||
      minimumQuantity < 1 ||
      maximumQuantity < minimumQuantity ||
      maximumQuantity > 100 ||
      (instantMaximum !== null &&
        (typeof instantMaximum !== "number" ||
          !Number.isSafeInteger(instantMaximum) ||
          instantMaximum < minimumQuantity ||
          instantMaximum > maximumQuantity))
    ) {
      continue;
    }
    seen.add(key);
    result.push({
      key,
      label,
      priceState: parseRateBearingPriceState(raw["priceState"]),
      ...(typeof raw["description"] === "string" && raw["description"].trim()
        ? { detail: raw["description"].trim() }
        : {}),
      unitLabel,
      minimumQuantity,
      maximumQuantity,
      instantConfirmationMaxQuantity: instantMaximum,
      requiresReview: raw["requiresReview"] === true,
      pricingStatus: parsePricingStatus(raw["pricingStatus"]),
      unitPrice: parseMoney(raw["unitPrice"]),
    });
  }
  return result;
}

function parseCatalogBaseOptions(value: unknown): BookingWizardBaseOption[] {
  if (!Array.isArray(value)) return [];
  const result: BookingWizardBaseOption[] = [];
  const seen = new Set<string>();
  for (const raw of value.slice(0, 100)) {
    if (!isRecord(raw)) continue;
    const tierKey =
      typeof raw["tierKey"] === "string" ? raw["tierKey"].trim() : "";
    const label = typeof raw["label"] === "string" ? raw["label"].trim() : "";
    if (
      !/^[a-z0-9][a-z0-9_-]{0,99}$/u.test(tierKey) ||
      !label ||
      seen.has(tierKey)
    ) {
      continue;
    }
    seen.add(tierKey);
    result.push({
      tierKey,
      label,
      priceState: parseRateBearingPriceState(raw["priceState"]),
      pricingStatus: parsePricingStatus(raw["pricingStatus"]),
      price: parseMoney(raw["price"]),
    });
  }
  return result;
}

function parseCatalogServices(payload: unknown): BookingWizardService[] {
  if (!isRecord(payload) || !Array.isArray(payload["services"])) return [];
  const services = new Map<string, BookingWizardService>();
  for (const raw of payload["services"]) {
    if (!isRecord(raw)) continue;
    const item = raw as CatalogItem;
    const key = item.key?.trim().toLowerCase() ?? "";
    const label = item.label?.trim() ?? "";
    if (!/^[a-z][a-z0-9_-]{1,79}$/u.test(key) || !label) continue;
    services.set(key, {
      key,
      label,
      ...(item.description?.trim() ? { detail: item.description.trim() } : {}),
      pricingStatus: parsePricingStatus(item.pricingStatus),
      bookable: item.bookable === true,
      priceState: parsePriceState(item.priceState) ?? "quote_required",
      agreement: parseAgreement(item.agreement),
      inclusions: parseBoundedTextList(item.inclusions),
      exclusions: parseBoundedTextList(item.exclusions),
      quoteRule:
        typeof item.quoteRule === "string" && item.quoteRule.trim()
          ? item.quoteRule.trim().slice(0, 1_000)
          : null,
      basePrice: parseMoney(item.basePrice),
      baseOptions: parseCatalogBaseOptions(item.baseOptions),
      addOns: parseCatalogAddOns(item.addOns),
    });
  }
  return [...services.values()].sort((left, right) =>
    left.label.localeCompare(right.label),
  );
}

function parseProofDefaults(payload: unknown): {
  before: number;
  after: number;
} {
  const defaults = { before: 1, after: 1 };
  if (!isRecord(payload) || !Array.isArray(payload["requirements"])) {
    return defaults;
  }
  for (const raw of payload["requirements"]) {
    if (!isRecord(raw)) continue;
    const category = raw["category"];
    const minimumCount = raw["minimumCount"];
    const required = raw["required"];
    if (
      (category === "before" || category === "after") &&
      typeof minimumCount === "number" &&
      Number.isSafeInteger(minimumCount) &&
      minimumCount >= 0 &&
      minimumCount <= 40 &&
      typeof required === "boolean"
    ) {
      defaults[category] = required ? minimumCount : 0;
    }
  }
  return defaults;
}

function parseCancellationPolicy(
  payload: unknown,
): BookingWizardCancellationPolicy | null {
  if (!isRecord(payload) || !isRecord(payload["policy"])) return null;
  const policy = payload["policy"];
  const minimumNoticeMinutes = policy["minimumNoticeMinutes"];
  const revision = policy["revision"];
  const source = policy["source"];
  if (
    typeof minimumNoticeMinutes !== "number" ||
    !Number.isSafeInteger(minimumNoticeMinutes) ||
    minimumNoticeMinutes < 1_440 ||
    minimumNoticeMinutes > 525_600 ||
    typeof policy["directCancellationEnabled"] !== "boolean" ||
    policy["lateCancellationDisposition"] !== "staff_review" ||
    policy["automaticFeeMinor"] !== null ||
    !["configured", "unconfigured", "launch_default"].includes(
      String(source),
    ) ||
    (revision !== null &&
      (typeof revision !== "number" ||
        !Number.isSafeInteger(revision) ||
        revision < 1))
  ) {
    return null;
  }
  return {
    minimumNoticeMinutes,
    directCancellationEnabled: policy["directCancellationEnabled"],
    lateCancellationDisposition: "staff_review",
    automaticFeeMinor: null,
    source: source as BookingWizardCancellationPolicy["source"],
    revision,
  };
}

export default async function PartnerBookPage({
  searchParams,
}: {
  searchParams?: Promise<{
    draftId?: string;
    locationId?: string;
    propertyId?: string;
    serviceKey?: string;
  }>;
}) {
  const params = (await searchParams) ?? {};
  const context = await getPartnerPortalContext();
  const personaPresentation = getPartnerPersonaPresentation(
    context.status === "authenticated" ? context.partnerType : null,
  );
  const company = getPublicCompanyProfile();
  if (context.status !== "authenticated" || !context.permissions.scheduleJobs) {
    return (
      <div className="space-y-5 sm:space-y-6">
        <PartnerPageHeader
          eyebrow="Quick service request"
          title={personaPresentation.taskLabels.schedule}
          description="Your current role doesn’t include permission to request service."
          breadcrumbs={[
            { label: "Overview", href: "/partners/overview" },
            { label: "Request service", href: "/partners/book" },
          ]}
        />
        <PartnerPanel>
          <PartnerEmptyState
            title="Scheduling access is limited"
            description="Ask your account administrator to update your role, or contact Stonegate for help requesting service."
            action={{ href: "/partners/help", label: "Contact Stonegate" }}
            icon={<CalendarClock className="h-6 w-6" aria-hidden="true" />}
          />
        </PartnerPanel>
      </div>
    );
  }

  const [
    locationsResponse,
    catalogResponse,
    proofDefaultsResponse,
    cancellationPolicyResponse,
  ] = await Promise.all([
    callPartnerApi("/api/portal/v2/locations?limit=100").catch(() => null),
    callPartnerApi("/api/portal/v2/service-catalog").catch(() => null),
    callPartnerApi("/api/portal/v2/proof-requirements").catch(() => null),
    callPartnerApi("/api/portal/v2/cancellation-policy").catch(() => null),
  ]);

  if (!locationsResponse?.ok) {
    const unavailable = [404, 409, 501, 503].includes(
      locationsResponse?.status ?? 503,
    );
    return (
      <div className="space-y-5 sm:space-y-6">
        <PartnerPageHeader
          eyebrow="Quick service request"
          title={personaPresentation.taskLabels.schedule}
          description="Choose a saved location, add what you need, and select an available service window."
          breadcrumbs={[
            { label: "Overview", href: "/partners/overview" },
            { label: "Request service", href: "/partners/book" },
          ]}
        />
        {unavailable ? (
          <PartnerPanel>
            <PartnerEmptyState
              title="Online requests are not available for this account yet"
              description="Nothing was submitted and your existing jobs are unchanged. Contact Stonegate and we’ll help start the request."
              action={{ href: "/partners/help", label: "Get help" }}
              icon={<PhoneCall className="h-6 w-6" aria-hidden="true" />}
            />
          </PartnerPanel>
        ) : (
          <PartnerErrorState
            title="We couldn’t start your request"
            description="Nothing was submitted. Try again in a moment or contact Stonegate for help."
            retryHref="/partners/book"
          />
        )}
      </div>
    );
  }

  const locationPayload = (await locationsResponse
    .json()
    .catch(() => null)) as unknown;
  const locations = parseLocations(locationPayload).map(wizardLocation);
  const catalogPayload = catalogResponse?.ok
    ? ((await catalogResponse.json().catch(() => null)) as unknown)
    : null;
  const services = parseCatalogServices(catalogPayload);
  const proofDefaultsPayload = proofDefaultsResponse?.ok
    ? ((await proofDefaultsResponse.json().catch(() => null)) as unknown)
    : null;
  const defaultProofRequirements = parseProofDefaults(proofDefaultsPayload);
  const cancellationPolicyPayload = cancellationPolicyResponse?.ok
    ? ((await cancellationPolicyResponse.json().catch(() => null)) as unknown)
    : null;
  const cancellationPolicy = parseCancellationPolicy(cancellationPolicyPayload);

  if (!cancellationPolicy) {
    return (
      <div className="space-y-5 sm:space-y-6">
        <PartnerPageHeader
          eyebrow="Quick service request"
          title={personaPresentation.taskLabels.schedule}
          description="Choose a saved location, add what you need, and select an available service window."
          breadcrumbs={[
            { label: "Overview", href: "/partners/overview" },
            { label: "Request service", href: "/partners/book" },
          ]}
        />
        <PartnerErrorState
          title="Cancellation terms are temporarily unavailable"
          description="Nothing was submitted. Refresh so you can review the current cancellation and schedule-change terms before sending your request."
          retryHref="/partners/book"
        />
      </div>
    );
  }

  const draftId =
    typeof params.draftId === "string" ? params.draftId.trim() : "";
  let initialDraft: PartnerDraft | null = null;
  let draftRecoveryFailed = false;
  if (draftId) {
    const response = await callPartnerApi(
      `/api/portal/v2/booking-drafts/${encodeURIComponent(draftId)}`,
    ).catch(() => null);
    if (response?.ok) {
      const payload = (await response.json().catch(() => null)) as {
        draft?: PartnerDraft;
      } | null;
      initialDraft = payload?.draft ?? null;
    } else {
      draftRecoveryFailed = true;
    }
  }

  const defaultLocationId =
    typeof params.locationId === "string"
      ? params.locationId.trim()
      : typeof params.propertyId === "string"
        ? params.propertyId.trim()
        : "";
  const defaultServiceKey =
    typeof params.serviceKey === "string"
      ? params.serviceKey.trim().toLowerCase()
      : "";

  return (
    <div className="space-y-5 sm:space-y-6">
      <PartnerPageHeader
        eyebrow="Quick service request"
        title={personaPresentation.taskLabels.schedule}
        description="Choose a saved location, add only what this job needs, and select an available two-hour window. Your work saves as you go; requests that need review are labeled clearly before you send them."
        breadcrumbs={[
          { label: "Overview", href: "/partners/overview" },
          { label: "Request service", href: "/partners/book" },
        ]}
      >
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-slate-600">
          <span className="inline-flex items-center gap-1.5">
            <ShieldCheckIcon />
            Details save as you go
          </span>
          <span className="inline-flex items-center gap-1.5">
            <CalendarClock
              className="h-4 w-4 text-primary-700"
              aria-hidden="true"
            />
            Clear availability and review status
          </span>
          <a
            href={`tel:${company.phoneE164}`}
            className="inline-flex min-h-11 items-center font-semibold text-primary-800 underline-offset-4 hover:underline"
          >
            Need help? {company.phoneDisplay}
          </a>
        </div>
      </PartnerPageHeader>

      {draftRecoveryFailed ? (
        <PartnerNotice tone="warning">
          That saved request link is no longer available. A new request will
          begin below; nothing has been submitted.
        </PartnerNotice>
      ) : null}

      <PartnerRepeatWorkManager
        canManageSeries={context.permissions.updateJobs}
        persona={context.partnerType}
      />

      {locations.length === 0 && !context.permissions.manageLocations ? (
        <PartnerPanel>
          <PartnerEmptyState
            title="Choose or add a location first"
            description="Save the location once so Stonegate can check service availability and you can reuse its details next time."
            action={{ href: "/partners/properties", label: "Manage locations" }}
            icon={<MapPin className="h-6 w-6" aria-hidden="true" />}
          />
        </PartnerPanel>
      ) : services.length === 0 ? (
        <PartnerPanel>
          <PartnerEmptyState
            title="Online service choices are not ready"
            description="No services are currently available for online requests. Contact Stonegate and we’ll help start the request."
            action={{ href: "/partners/help", label: "Contact Stonegate" }}
            icon={<CalendarClock className="h-6 w-6" aria-hidden="true" />}
          />
        </PartnerPanel>
      ) : (
        <PartnerBookingWizard
          locations={locations}
          services={services}
          initialDraft={initialDraft}
          defaultLocationId={
            locations.some((item) => item.id === defaultLocationId)
              ? defaultLocationId
              : ""
          }
          defaultServiceKey={
            services.some((item) => item.key === defaultServiceKey)
              ? defaultServiceKey
              : ""
          }
          canUploadPhotos={context.permissions.uploadMedia}
          canManageLocations={context.permissions.manageLocations}
          defaultProofRequirements={defaultProofRequirements}
          cancellationPolicy={cancellationPolicy}
          persona={context.partnerType}
          supportPhoneE164={company.phoneE164}
          supportPhoneDisplay={company.phoneDisplay}
        />
      )}

      <div className="text-center">
        <Link href="/partners/bookings" className={partnerSecondaryButtonClass}>
          View existing jobs
        </Link>
      </div>
    </div>
  );
}

function ShieldCheckIcon() {
  return (
    <span
      aria-hidden="true"
      className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-emerald-100 text-[10px] font-bold text-emerald-700"
    >
      ✓
    </span>
  );
}
