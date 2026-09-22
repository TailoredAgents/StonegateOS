import type { Metadata } from "next";
import styles from "./request-page.module.css";
import Link from "next/link";
import { CalendarClock, MapPin } from "lucide-react";
import { callPartnerApi } from "@/app/partners/lib/api";
import {
  loadPartnerPortalResource,
  portalLoadErrorMessage,
} from "../../lib/portal-load";
import {
  parseLocations,
  wizardLocation,
  parseBookingCatalog,
  parseProofDefaults,
  parseCancellationPolicy,
  parseBookingDraft,
} from "../../lib/booking-page-data";
import { getPartnerPortalContext } from "@/app/partners/lib/portal-context";
import { getPartnerPersonaPresentation } from "@/app/partners/lib/persona-presentation";
import type {
  PartnerDraft,
  PartnerLocation,
} from "@/app/partners/lib/portal-v2";
import { PartnerBookingWizard } from "@/app/partners/components/PartnerBookingWizard";
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
import { sortBookingLocations } from "../../lib/booking-location";

export const metadata: Metadata = { title: "Request service" };

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
  const retryQuery = new URLSearchParams();
  for (const key of [
    "draftId",
    "locationId",
    "propertyId",
    "serviceKey",
  ] as const) {
    if (typeof params[key] === "string") retryQuery.set(key, params[key]);
  }
  const retryHref = `/partners/book${retryQuery.size ? `?${retryQuery}` : ""}`;
  const context = await getPartnerPortalContext();
  const personaPresentation = getPartnerPersonaPresentation(
    context.status === "authenticated" ? context.partnerType : null,
  );
  const company = getPublicCompanyProfile();
  if (context.status === "authenticated" && !context.availability.reads)
    return null;
  if (context.status === "authenticated" && !context.availability.writes)
    return (
      <PartnerErrorState
        title="New service requests are temporarily unavailable"
        description="You can still view your jobs and contact Stonegate for help."
        retryHref="/partners/book"
      />
    );
  if (context.status !== "authenticated" || !context.permissions.scheduleJobs) {
    return (
      <div className="space-y-5 sm:space-y-6">
        <PartnerPageHeader
          eyebrow="Partner service request"
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

  const [locationResult, catalogResult, proofResult, cancellationResult] =
    await Promise.all([
      loadPartnerPortalResource(
        () => callPartnerApi("/api/portal/v2/locations?limit=100"),
        (payload) => {
          const locations = parseLocations(payload);
          if (!locations || !payload || typeof payload !== "object")
            return null;
          const directory = (
            payload as {
              directory: {
                canCreateLocation: boolean;
              };
            }
          ).directory;
          return { locations, directory };
        },
      ),
      loadPartnerPortalResource(
        () => callPartnerApi("/api/portal/v2/service-catalog"),
        parseBookingCatalog,
      ),
      loadPartnerPortalResource(
        () => callPartnerApi("/api/portal/v2/proof-requirements"),
        parseProofDefaults,
      ),
      loadPartnerPortalResource(
        () => callPartnerApi("/api/portal/v2/cancellation-policy"),
        parseCancellationPolicy,
      ),
    ]);
  const failure = [
    locationResult,
    catalogResult,
    proofResult,
    cancellationResult,
  ].find((result) => result.status === "error");
  if (failure?.status === "error")
    return (
      <PartnerErrorState
        title="We couldn’t start your request"
        description={portalLoadErrorMessage(
          failure,
          "Some request information could not be loaded. Please refresh to try again. Nothing has been submitted.",
        )}
        retryHref={retryHref}
      />
    );
  if (
    locationResult.status !== "ok" ||
    catalogResult.status !== "ok" ||
    proofResult.status !== "ok" ||
    cancellationResult.status !== "ok"
  )
    return null;
  const locations = locationResult.value.locations.map(wizardLocation);
  const directory = locationResult.value.directory;
  const canCreateLocation =
    directory.canCreateLocation && context.permissions.manageLocations;
  let catalog = catalogResult.value;
  const defaultProofRequirements = proofResult.value;
  const cancellationPolicy = cancellationResult.value;

  const draftId =
    typeof params.draftId === "string" ? params.draftId.trim() : "";
  let initialDraft: PartnerDraft | null = null;
  if (draftId) {
    const result = await loadPartnerPortalResource(
      () =>
        callPartnerApi(
          `/api/portal/v2/booking-drafts/${encodeURIComponent(draftId)}`,
        ),
      (payload) => {
        const draft = parseBookingDraft(payload);
        return draft?.id === draftId ? draft : null;
      },
    );
    if (result.status === "error")
      return (
        <PartnerErrorState
          title="We couldn’t reopen your saved request"
          description={portalLoadErrorMessage(
            result,
            "Please try again to reopen this request. A new request has not been started.",
          )}
          retryHref={`/partners/book?draftId=${encodeURIComponent(draftId)}`}
        />
      );
    initialDraft = result.value;
  }

  // A saved single-service request keeps its negotiated load options and
  // add-ons when its company moves to the new multi-service request form.
  if (
    initialDraft &&
    initialDraft.modelVersion !== 2 &&
    catalog.multiServiceRequestsEnabled
  ) {
    const legacyCatalogResult = await loadPartnerPortalResource(
      () =>
        callPartnerApi("/api/portal/v2/service-catalog?requestModelVersion=1"),
      parseBookingCatalog,
    );
    if (legacyCatalogResult.status === "error")
      return (
        <PartnerErrorState
          title="We couldn’t load this saved request’s service choices"
          description={portalLoadErrorMessage(
            legacyCatalogResult,
            "Please try again. Your saved work and service selections are unchanged.",
          )}
          retryHref={retryHref}
        />
      );
    catalog = legacyCatalogResult.value;
  }
  const services = catalog.services;

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

  // Preserve an explicit address or a saved request even when it is outside page one.
  const requestedLocationId = initialDraft?.locationId || defaultLocationId;
  if (
    requestedLocationId &&
    !locations.some((item) => item.id === requestedLocationId)
  ) {
    const result = await loadPartnerPortalResource(
      () =>
        callPartnerApi(
          `/api/portal/v2/locations/${encodeURIComponent(requestedLocationId)}`,
        ),
      (payload) => {
        if (!payload || typeof payload !== "object") return null;
        const location = (payload as { location?: PartnerLocation }).location;
        const parsed = parseLocations({
          ok: true,
          locations: [location],
          directory: { canCreateLocation },
        });
        return parsed?.[0]?.id === requestedLocationId ? parsed[0] : null;
      },
    );
    if (result.status === "error")
      return (
        <PartnerErrorState
          title="We couldn’t load the selected location"
          description={portalLoadErrorMessage(
            result,
            "Please try again before continuing this request. No other location has been selected.",
          )}
          retryHref={retryHref}
        />
      );
    locations.push(wizardLocation(result.value));
  }

  return (
    <div className={`space-y-5 sm:space-y-6 ${styles["page"]}`}>
      <div className={styles["compactHeading"]}>
        <h1 className="text-xl font-semibold tracking-tight text-slate-950 sm:text-2xl">
          Request service
        </h1>
      </div>
      <div className={styles["introduction"]}>
        <PartnerPageHeader
          eyebrow="Partner service request"
          title={personaPresentation.taskLabels.schedule}
          description={
            context.availability.instantConfirmation
              ? "Enter the service address, describe the work, and review available service times."
              : "Enter the service address, describe the work, and provide preferred dates. Stonegate will review the request and confirm pricing and scheduling."
          }
          breadcrumbs={[
            { label: "Overview", href: "/partners/overview" },
            { label: "Request service", href: "/partners/book" },
          ]}
        >
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-slate-600">
            <span className="inline-flex items-center gap-1.5">
              <ShieldCheckIcon />
              Continue saves your service address
            </span>
            <span className="inline-flex items-center gap-1.5">
              <CalendarClock
                className="h-4 w-4 text-primary-700"
                aria-hidden="true"
              />
              Review before submitting
            </span>
            <a
              href={`tel:${company.phoneE164}`}
              className="inline-flex min-h-11 items-center font-semibold text-primary-800 underline-offset-4 hover:underline"
            >
              Contact Stonegate: {company.phoneDisplay}
            </a>
          </div>
        </PartnerPageHeader>
      </div>

      {initialDraft?.additionalServiceFromJobId ? (
        <PartnerNotice tone="info">
          <strong>Request additional service.</strong> This is a separate job
          with its own price, schedule, and billing. The original bill and
          payment stay unchanged. Describe only the additional work below.{" "}
          <Link
            href={`/partners/bookings/${encodeURIComponent(initialDraft.additionalServiceFromJobId)}`}
            className="inline-flex min-h-11 items-center font-semibold underline underline-offset-2"
          >
            View original job
          </Link>
        </PartnerNotice>
      ) : null}

      {locations.length === 0 && !canCreateLocation ? (
        <PartnerPanel>
          <PartnerEmptyState
            title="A service address is required"
            description="No service addresses are available for this request. Ask your account administrator to add an address or give you access to an existing one, or contact Stonegate for assistance."
            action={{ href: "/partners/help", label: "Contact Stonegate" }}
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
          canDiscardDrafts={context.permissions.updateJobs}
          key={`${context.accountId}:${initialDraft?.id ?? "new"}`}
          locations={sortBookingLocations(locations)}
          services={services}
          multiServiceRequestsEnabled={catalog.multiServiceRequestsEnabled}
          structuredRates={catalog.structuredRates}
          structuredRatesStatus={catalog.structuredRatesStatus}
          initialDraft={initialDraft}
          defaultLocationId={
            locations.some((item) => item.id === requestedLocationId)
              ? requestedLocationId
              : ""
          }
          defaultServiceKey={
            services.some((item) => item.key === defaultServiceKey)
              ? defaultServiceKey
              : ""
          }
          canUploadPhotos={context.permissions.uploadMedia}
          instantConfirmationAvailable={
            context.availability.instantConfirmation
          }
          canManageLocations={canCreateLocation}
          requesterContact={{
            name: context.user.name,
            email: context.user.email,
            phone: "",
          }}
          defaultProofRequirements={defaultProofRequirements}
          cancellationPolicy={cancellationPolicy}
          persona={context.partnerType}
          supportPhoneE164={company.phoneE164}
          supportPhoneDisplay={company.phoneDisplay}
        />
      )}

      {context.tools?.["templates"] ||
      context.tools?.["recurring"] ||
      context.tools?.["bulk"] ? (
        <details className="rounded-xl border border-slate-200 bg-white p-4">
          <summary className="flex min-h-11 cursor-pointer items-center font-semibold text-slate-800">
            Templates, recurring service, and bulk requests
          </summary>
          <div className="mt-4">
            <PartnerRepeatWorkManager
              key={context.accountId}
              enabledTools={{
                templates: context.tools?.["templates"] === true,
                recurring: context.tools?.["recurring"] === true,
                bulk: context.tools?.["bulk"] === true,
              }}
              canManageSeries={context.permissions.updateJobs}
              instantConfirmation={context.availability.instantConfirmation}
              persona={context.partnerType}
            />
          </div>
        </details>
      ) : null}

      <div className={`text-center ${styles["jobsLink"]}`}>
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
