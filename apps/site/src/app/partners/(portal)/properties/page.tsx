import type { Metadata } from "next";
import { MapPin, ShieldCheck } from "lucide-react";
import { callPartnerApi } from "@/app/partners/lib/api";
import { getPartnerPortalContext } from "@/app/partners/lib/portal-context";
import {
  loadPartnerPortalResource,
  portalLoadErrorMessage,
} from "../../lib/portal-load";
import { isPartnerLocation } from "../../lib/booking-location";
import type { PartnerLocation } from "@/app/partners/lib/portal-v2";
import { PartnerLocationManager } from "@/app/partners/components/PartnerLocationManager";
import {
  PartnerEmptyState,
  PartnerErrorState,
  PartnerNotice,
  PartnerPageHeader,
  PartnerPanel,
} from "@/app/partners/components/PartnerPortalUi";

export const metadata: Metadata = { title: "Locations" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ParsedLocationDirectory = {
  locations: PartnerLocation[];
  nextCursor: string | null;
  directoryEtag: string;
  canManagePortfolio: boolean;
  canCreateLocation: boolean;
};

function parseLocations(payload: unknown): ParsedLocationDirectory | null {
  if (
    !isRecord(payload) ||
    payload["ok"] !== true ||
    !Array.isArray(payload["locations"]) ||
    !isRecord(payload["page"]) ||
    !isRecord(payload["directory"])
  ) {
    return null;
  }
  const locations = payload["locations"];
  const valid = locations.every(isPartnerLocation);
  const nextCursor = payload["page"]["nextCursor"];
  const directoryEtag = payload["directory"]["etag"];
  const canManagePortfolio = payload["directory"]["canManagePortfolio"];
  const canCreateLocation = payload["directory"]["canCreateLocation"];
  return valid &&
    (nextCursor === null || typeof nextCursor === "string") &&
    typeof directoryEtag === "string" &&
    typeof canManagePortfolio === "boolean" &&
    typeof canCreateLocation === "boolean"
    ? {
        locations,
        nextCursor,
        directoryEtag,
        canManagePortfolio,
        canCreateLocation,
      }
    : null;
}

export default async function PartnerPropertiesPage() {
  const context = await getPartnerPortalContext();
  if (context.status !== "authenticated" || !context.availability.reads)
    return null;
  const canView =
    context.status === "authenticated" && context.capabilities.locations;
  const canManage =
    context.status === "authenticated" && context.permissions.manageLocations;
  const result = canView
    ? await loadPartnerPortalResource(
        () => callPartnerApi("/api/portal/v2/locations?active=all&limit=100"),
        parseLocations,
      )
    : null;
  const directory = result?.status === "ok" ? result.value : null;

  return (
    <div className="space-y-5 sm:space-y-6">
      <PartnerPageHeader
        eyebrow="Saved service locations"
        title="Locations"
        description="Save each site’s address, contact, parking, and access details once so future bookings are faster and clearer."
        breadcrumbs={[
          { label: "Overview", href: "/partners/overview" },
          { label: "Locations", href: "/partners/properties" },
        ]}
      >
        <div className="flex items-start gap-2 text-xs leading-5 text-slate-600">
          <ShieldCheck
            className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700"
            aria-hidden="true"
          />
          Private access codes stay separate from ordinary directions, are
          encrypted, and are never shown back after saving.
        </div>
      </PartnerPageHeader>

      {!canView ? (
        <PartnerPanel>
          <PartnerEmptyState
            title="Location access is limited"
            description="Your role cannot view this account’s saved locations. Ask an account administrator for access, or contact Stonegate for help with a booking."
            action={{ href: "/partners/help", label: "Get help" }}
            icon={<MapPin className="h-6 w-6" aria-hidden="true" />}
          />
        </PartnerPanel>
      ) : directory ? (
        <PartnerPanel>
          {!canManage ? (
            <PartnerNotice tone="info" className="mb-5">
              {context.availability.writes
                ? "Your role can view account locations but cannot add, edit, or archive them."
                : "Location changes are temporarily unavailable. You can still view saved locations."}
            </PartnerNotice>
          ) : null}
          <PartnerLocationManager
            initialLocations={directory.locations}
            initialNextCursor={directory.nextCursor}
            initialDirectoryEtag={directory.directoryEtag}
            canManage={canManage}
            canCreateLocation={canManage && directory.canCreateLocation}
            canFavorite={context.availability.writes}
            canRequestService={context.permissions.scheduleJobs}
            canManagePortfolio={
              canManage &&
              directory.canManagePortfolio &&
              context.status === "authenticated" &&
              context.tools?.["portfolio"] === true
            }
            canExport={
              context.status === "authenticated" &&
              context.tools?.["portfolio"] === true &&
              context.permissions.exportOperationalReports
            }
          />
        </PartnerPanel>
      ) : (
        <PartnerErrorState
          title="We couldn’t load your locations"
          description={
            result?.status === "error"
              ? portalLoadErrorMessage(
                  result,
                  "Please refresh to load your saved locations.",
                )
              : "Please refresh to load your saved locations."
          }
          retryHref="/partners/properties"
        />
      )}
    </div>
  );
}
