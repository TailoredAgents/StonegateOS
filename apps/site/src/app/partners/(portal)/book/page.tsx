import type { Metadata } from "next";
import Link from "next/link";
import { CalendarClock, MapPin, PhoneCall } from "lucide-react";
import { callPartnerApi } from "@/app/partners/lib/api";
import { getPartnerPortalContext } from "@/app/partners/lib/portal-context";
import type {
  PartnerDraft,
  PartnerLocation,
} from "@/app/partners/lib/portal-v2";
import {
  PartnerBookingWizard,
  type BookingWizardAddOn,
  type BookingWizardBaseOption,
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

export const metadata: Metadata = { title: "Schedule job" };

type CatalogItem = {
  key?: string;
  label?: string | null;
  description?: string | null;
  pricingStatus?: string;
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
      basePrice: parseMoney(item.basePrice),
      baseOptions: parseCatalogBaseOptions(item.baseOptions),
      addOns: parseCatalogAddOns(item.addOns),
    });
  }
  return [...services.values()].sort((left, right) =>
    left.label.localeCompare(right.label),
  );
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
  const company = getPublicCompanyProfile();
  if (context.status !== "authenticated" || !context.permissions.scheduleJobs) {
    return (
      <div className="space-y-5 sm:space-y-6">
        <PartnerPageHeader
          eyebrow="Service scheduling"
          title="Schedule a job"
          description="Your current portal role doesn’t include permission to create service requests."
          breadcrumbs={[
            { label: "Overview", href: "/partners" },
            { label: "Schedule job", href: "/partners/book" },
          ]}
        />
        <PartnerPanel>
          <PartnerEmptyState
            title="Scheduling access is limited"
            description="Ask an account administrator to update your role, or contact Stonegate for help with this job."
            action={{ href: "/partners/help", label: "Contact Stonegate" }}
            icon={<CalendarClock className="h-6 w-6" aria-hidden="true" />}
          />
        </PartnerPanel>
      </div>
    );
  }

  const [locationsResponse, catalogResponse] = await Promise.all([
    callPartnerApi("/api/portal/v2/locations?limit=100").catch(() => null),
    callPartnerApi("/api/portal/v2/service-catalog").catch(() => null),
  ]);

  if (!locationsResponse?.ok) {
    const unavailable = [404, 409, 501, 503].includes(
      locationsResponse?.status ?? 503,
    );
    return (
      <div className="space-y-5 sm:space-y-6">
        <PartnerPageHeader
          eyebrow="Service scheduling"
          title="Schedule a job"
          description="Create a saved request, choose a live service time, and send the complete job details to Stonegate."
          breadcrumbs={[
            { label: "Overview", href: "/partners" },
            { label: "Schedule job", href: "/partners/book" },
          ]}
        />
        {unavailable ? (
          <PartnerPanel>
            <PartnerEmptyState
              title="Live scheduling is not enabled for this account yet"
              description="No request has been submitted. Your existing jobs are unchanged. Stonegate can schedule this service and confirm capacity by phone."
              action={{ href: "/partners/help", label: "Get scheduling help" }}
              icon={<PhoneCall className="h-6 w-6" aria-hidden="true" />}
            />
          </PartnerPanel>
        ) : (
          <PartnerErrorState
            title="We couldn’t load live scheduling"
            description="No request has been submitted. Try again in a moment or contact Stonegate for immediate scheduling help."
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
        eyebrow="Live service scheduling"
        title="Schedule a job"
        description="Build a saved request and choose a capacity-backed window. Eligible work confirms instantly; anything uncertain is saved as a clearly labeled review request."
        breadcrumbs={[
          { label: "Overview", href: "/partners" },
          { label: "Schedule job", href: "/partners/book" },
        ]}
      >
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-slate-600">
          <span className="inline-flex items-center gap-1.5">
            <ShieldCheckIcon />
            Private account workspace
          </span>
          <span className="inline-flex items-center gap-1.5">
            <CalendarClock
              className="h-4 w-4 text-primary-700"
              aria-hidden="true"
            />
            Live schedule availability
          </span>
          <a
            href={`tel:${company.phoneE164}`}
            className="font-semibold text-primary-800 underline-offset-4 hover:underline"
          >
            Need help? {company.phoneDisplay}
          </a>
        </div>
      </PartnerPageHeader>

      {draftRecoveryFailed ? (
        <PartnerNotice tone="warning">
          That saved-draft link is no longer available. A new draft will begin
          below; no job has been submitted.
        </PartnerNotice>
      ) : null}

      <PartnerRepeatWorkManager />

      {locations.length === 0 && !context.permissions.manageLocations ? (
        <PartnerPanel>
          <PartnerEmptyState
            title="Add a service location first"
            description="A verified account location is required before Stonegate can calculate service availability."
            action={{ href: "/partners/properties", label: "Manage locations" }}
            icon={<MapPin className="h-6 w-6" aria-hidden="true" />}
          />
        </PartnerPanel>
      ) : services.length === 0 ? (
        <PartnerPanel>
          <PartnerEmptyState
            title="Your service catalog is not ready"
            description="No configured services are currently available for online scheduling. Contact Stonegate to prepare this request safely."
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
