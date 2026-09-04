import type { Metadata } from "next";
import { MapPin, ShieldCheck } from "lucide-react";
import { callPartnerApi } from "@/app/partners/lib/api";
import { getPartnerPortalContext } from "@/app/partners/lib/portal-context";
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
  const valid = locations.every((value): value is PartnerLocation => {
    if (
      !isRecord(value) ||
      typeof value["id"] !== "string" ||
      !isRecord(value["address"])
    ) {
      return false;
    }
    const address = value["address"];
    return (
      typeof address["line1"] === "string" &&
      typeof address["city"] === "string" &&
      typeof value["etag"] === "string"
    );
  });
  const nextCursor = payload["page"]["nextCursor"];
  const directoryEtag = payload["directory"]["etag"];
  const canManagePortfolio = payload["directory"]["canManagePortfolio"];
  return valid &&
    (nextCursor === null || typeof nextCursor === "string") &&
    typeof directoryEtag === "string" &&
    typeof canManagePortfolio === "boolean"
    ? { locations, nextCursor, directoryEtag, canManagePortfolio }
    : null;
}

export default async function PartnerPropertiesPage() {
  const context = await getPartnerPortalContext();
  const canView =
    context.status === "authenticated" && context.capabilities.locations;
  const canManage =
    context.status === "authenticated" && context.permissions.manageLocations;
  const response = canView
    ? await callPartnerApi(
        "/api/portal/v2/locations?active=all&limit=100",
      ).catch(() => null)
    : null;

  let directory: ParsedLocationDirectory | null = null;
  if (response?.ok) {
    directory = parseLocations(
      (await response.json().catch(() => null)) as unknown,
    );
  }

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
              Your role can view account locations but cannot add, edit, or
              archive them.
            </PartnerNotice>
          ) : null}
          <PartnerLocationManager
            initialLocations={directory.locations}
            initialNextCursor={directory.nextCursor}
            initialDirectoryEtag={directory.directoryEtag}
            canManage={canManage}
            canManagePortfolio={directory.canManagePortfolio}
            canExport={
              context.status === "authenticated" &&
              context.permissions.exportOperationalReports
            }
          />
        </PartnerPanel>
      ) : (
        <PartnerErrorState
          title="We couldn’t load your locations"
          description="We couldn’t verify this account’s saved locations. No address was shown or changed. Try again in a moment."
          retryHref="/partners/properties"
        />
      )}
    </div>
  );
}
