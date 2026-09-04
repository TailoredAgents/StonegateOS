"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import {
  Archive,
  Building2,
  CalendarPlus2,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  KeyRound,
  LoaderCircle,
  MapPin,
  Pencil,
  Plus,
  Search,
  Star,
  Upload,
  UserRound,
  X,
} from "lucide-react";
import { cn } from "@myst-os/ui";
import type { PartnerLocation, PartnerLocationImport } from "../lib/portal-v2";
import { createPortalOperationKey, partnerPortalFetch } from "../lib/portal-v2";
import {
  PartnerEmptyState,
  PartnerNotice,
  partnerFieldClass,
  partnerPrimaryButtonClass,
  partnerSecondaryButtonClass,
} from "./PartnerPortalUi";

type LocationForm = {
  siteName: string;
  externalPropertyId: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  postalCode: string;
  accessDetails: string;
  parking: string;
  loading: string;
  accessSecret: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
  parentLocationId: string;
  makeDefault: boolean;
};

type ArchiveImpact = {
  isDefault: boolean;
  activeChildCount: number;
  activeAlternativeCount: number;
  openDraftCount: number;
  activeTemplateCount: number;
  jobHistoryCount: number;
  canonicalQuoteV2Count: number;
  issuedActionableQuoteV2Count: number;
};

type LocationValidation = {
  status: "verified" | "review_required" | "duplicate";
  verification: {
    status: "verified" | "suggested_correction" | "review_required";
    suggestedAddress: {
      addressLine1: string;
      addressLine2: string | null;
      city: string;
      state: string;
      postalCode: string;
    } | null;
  };
  duplicates: Array<{
    id: string;
    siteName: string;
    confidence: number;
  }>;
  canCreateForReview: boolean;
};

type PendingAddressSuggestion = {
  mode: "create" | "update";
  locationId: string | null;
  form: LocationForm;
  suggestedAddress: NonNullable<
    LocationValidation["verification"]["suggestedAddress"]
  >;
};

const EMPTY_LOCATION: LocationForm = {
  siteName: "",
  externalPropertyId: "",
  line1: "",
  line2: "",
  city: "",
  state: "GA",
  postalCode: "",
  accessDetails: "",
  parking: "",
  loading: "",
  accessSecret: "",
  contactName: "",
  contactPhone: "",
  contactEmail: "",
  parentLocationId: "",
  makeDefault: false,
};

function text(record: Record<string, unknown> | null, key: string): string {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}

function formFromLocation(location: PartnerLocation): LocationForm {
  return {
    siteName: location.siteName ?? "",
    externalPropertyId: location.externalPropertyId ?? "",
    line1: location.address.line1,
    line2: location.address.line2 ?? "",
    city: location.address.city,
    state: location.address.state,
    postalCode: location.address.postalCode,
    accessDetails: location.access.details ?? "",
    parking: location.access.parking ?? "",
    loading: location.access.loading ?? "",
    accessSecret: "",
    contactName: text(location.onSiteContact, "name"),
    contactPhone: text(location.onSiteContact, "phone"),
    contactEmail: text(location.onSiteContact, "email"),
    parentLocationId: location.portfolio.parentLocationId ?? "",
    makeDefault: location.portfolio.isDefault,
  };
}

function locationPayload(
  form: LocationForm,
  editing: boolean,
  includePortfolio: boolean,
) {
  return {
    siteName: form.siteName,
    externalPropertyId: form.externalPropertyId || null,
    address: {
      line1: form.line1,
      line2: form.line2 || null,
      city: form.city,
      state: form.state,
      postalCode: form.postalCode,
    },
    timezone: "America/New_York",
    locale: "en-US",
    access: {
      details: form.accessDetails || null,
      parking: form.parking || null,
      loading: form.loading || null,
    },
    ...(form.accessSecret
      ? { accessSecret: form.accessSecret }
      : editing
        ? {}
        : { accessSecret: null }),
    onSiteContact:
      form.contactName || form.contactPhone || form.contactEmail
        ? {
            name: form.contactName || null,
            phone: form.contactPhone || null,
            email: form.contactEmail || null,
          }
        : null,
    ...(includePortfolio
      ? {
          parentLocationId: form.parentLocationId || null,
          makeDefault: form.makeDefault,
        }
      : {}),
  };
}

export function PartnerLocationManager({
  initialLocations,
  initialNextCursor,
  initialDirectoryEtag,
  canManage,
  canManagePortfolio,
  canExport,
}: {
  initialLocations: PartnerLocation[];
  initialNextCursor: string | null;
  initialDirectoryEtag: string;
  canManage: boolean;
  canManagePortfolio: boolean;
  canExport: boolean;
}) {
  const [locations, setLocations] = React.useState(initialLocations);
  const [nextCursor, setNextCursor] = React.useState(initialNextCursor);
  const [directoryEtag, setDirectoryEtag] =
    React.useState(initialDirectoryEtag);
  const [search, setSearch] = React.useState("");
  const [showArchived, setShowArchived] = React.useState(false);
  const [adding, setAdding] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [archiveReview, setArchiveReview] = React.useState<{
    locationId: string;
    impact: ArchiveImpact;
  } | null>(null);
  const [message, setMessage] = React.useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);
  const [pendingAddressSuggestion, setPendingAddressSuggestion] =
    React.useState<PendingAddressSuggestion | null>(null);

  const visible = locations
    .filter((location) => {
      if (!showArchived && !location.active) return false;
      const haystack = [
        location.siteName,
        location.externalPropertyId,
        location.address.line1,
        location.address.city,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(search.trim().toLowerCase());
    })
    .sort(
      (left, right) =>
        Number(right.portfolio.isDefault) - Number(left.portfolio.isDefault) ||
        Number(right.portfolio.isFavorite) -
          Number(left.portfolio.isFavorite) ||
        (left.siteName ?? "").localeCompare(right.siteName ?? ""),
    );

  const validateLocation = async (
    form: LocationForm,
    excludeLocationId?: string,
  ): Promise<LocationValidation | null> => {
    const result = await partnerPortalFetch<{
      ok: true;
      validation: LocationValidation;
    }>("locations/validate", {
      method: "POST",
      body: JSON.stringify({
        address: {
          line1: form.line1,
          line2: form.line2 || null,
          city: form.city,
          state: form.state,
          postalCode: form.postalCode,
        },
        externalPropertyId: form.externalPropertyId || null,
        ...(excludeLocationId ? { excludeLocationId } : {}),
      }),
    }).catch(() => null);
    if (!result?.ok) {
      setMessage({
        tone: "error",
        text:
          result?.error.message ??
          "The address could not be checked. Try again before saving.",
      });
      return null;
    }
    if (result.data.validation.status === "duplicate") {
      const names = result.data.validation.duplicates
        .slice(0, 2)
        .map((candidate) => candidate.siteName)
        .join(" or ");
      setMessage({
        tone: "error",
        text: names
          ? `This appears to duplicate ${names}. Use the existing location or merge the duplicate record.`
          : "This address already exists in the account. Use the existing location.",
      });
      return null;
    }
    return result.data.validation;
  };

  const createLocation = async (
    form: LocationForm,
    addressDecisionMade = false,
  ): Promise<boolean> => {
    setBusyId("new");
    setMessage(null);
    const validation = await validateLocation(form);
    if (!validation) {
      setBusyId(null);
      return false;
    }
    if (
      !addressDecisionMade &&
      validation.verification.status === "suggested_correction" &&
      validation.verification.suggestedAddress
    ) {
      setBusyId(null);
      setPendingAddressSuggestion({
        mode: "create",
        locationId: null,
        form,
        suggestedAddress: validation.verification.suggestedAddress,
      });
      return false;
    }
    const result = await partnerPortalFetch<{
      ok: true;
      location: PartnerLocation;
    }>("locations", {
      method: "POST",
      headers: {
        "Idempotency-Key": createPortalOperationKey("location-create"),
      },
      body: JSON.stringify(locationPayload(form, false, true)),
    }).catch(() => null);
    setBusyId(null);
    if (!result?.ok) {
      setMessage({
        tone: "error",
        text: result?.error.message ?? "The location was not added.",
      });
      return false;
    }
    setDirectoryEtag(
      result.response.headers.get("x-location-directory-etag") ?? directoryEtag,
    );
    setLocations((current) =>
      [...current, result.data.location].sort((a, b) =>
        (a.siteName ?? "").localeCompare(b.siteName ?? ""),
      ),
    );
    setAdding(false);
    setPendingAddressSuggestion(null);
    setMessage({
      tone: "success",
      text:
        validation.status === "verified"
          ? "Location added and address verified. Service-area status is shown below."
          : "Location added for Stonegate address review. It can be used for review requests, but it will not receive instant confirmation yet.",
    });
    return true;
  };

  const updateLocation = async (
    location: PartnerLocation,
    form: LocationForm,
    addressDecisionMade = false,
  ): Promise<boolean> => {
    setBusyId(location.id);
    setMessage(null);
    const validation = await validateLocation(form, location.id);
    if (!validation) {
      setBusyId(null);
      return false;
    }
    if (
      !addressDecisionMade &&
      validation.verification.status === "suggested_correction" &&
      validation.verification.suggestedAddress
    ) {
      setBusyId(null);
      setPendingAddressSuggestion({
        mode: "update",
        locationId: location.id,
        form,
        suggestedAddress: validation.verification.suggestedAddress,
      });
      return false;
    }
    const result = await partnerPortalFetch<{
      ok: true;
      location: PartnerLocation;
    }>(`locations/${location.id}`, {
      method: "PATCH",
      headers: {
        "If-Match": location.etag,
        "Idempotency-Key": createPortalOperationKey("location-update"),
      },
      body: JSON.stringify(locationPayload(form, true, canManagePortfolio)),
    }).catch(() => null);
    setBusyId(null);
    if (!result?.ok) {
      setMessage({
        tone: "error",
        text: result?.error.message ?? "The location changes were not saved.",
      });
      return false;
    }
    setDirectoryEtag(
      result.response.headers.get("x-location-directory-etag") ?? directoryEtag,
    );
    setLocations((current) =>
      current.map((item) =>
        item.id === location.id ? result.data.location : item,
      ),
    );
    setEditingId(null);
    setPendingAddressSuggestion(null);
    setMessage({
      tone: "success",
      text:
        validation.status === "verified"
          ? "Location changes saved and address verified."
          : "Location changes saved and sent to Stonegate for address review.",
    });
    return true;
  };

  const continueSuggestedAddress = async (
    useSuggestedAddress: boolean,
  ): Promise<void> => {
    const pending = pendingAddressSuggestion;
    if (!pending) return;
    const form = useSuggestedAddress
      ? {
          ...pending.form,
          line1: pending.suggestedAddress.addressLine1,
          line2: pending.suggestedAddress.addressLine2 ?? "",
          city: pending.suggestedAddress.city,
          state: pending.suggestedAddress.state,
          postalCode: pending.suggestedAddress.postalCode,
        }
      : pending.form;
    setPendingAddressSuggestion(null);
    if (pending.mode === "create") {
      await createLocation(form, true);
      return;
    }
    const location = locations.find(
      (candidate) => candidate.id === pending.locationId,
    );
    if (!location) {
      setMessage({
        tone: "error",
        text: "The location changed before the address decision. Refresh and try again.",
      });
      return;
    }
    await updateLocation(location, form, true);
  };

  const reviewArchive = async (location: PartnerLocation): Promise<void> => {
    setBusyId(location.id);
    setMessage(null);
    const result = await partnerPortalFetch<{
      ok: true;
      impact: ArchiveImpact;
    }>(`locations/${location.id}/archive-impact`).catch(() => null);
    setBusyId(null);
    if (!result?.ok) {
      setMessage({
        tone: "error",
        text:
          result?.error.message ?? "The archive impact could not be loaded.",
      });
      return;
    }
    setArchiveReview({ locationId: location.id, impact: result.data.impact });
  };

  const archiveLocation = async (
    location: PartnerLocation,
    input: {
      reason: string;
      replacementDefaultLocationId?: string;
      childDisposition?: "promote" | "move";
      replacementParentLocationId?: string;
    },
  ): Promise<boolean> => {
    setBusyId(location.id);
    setMessage(null);
    const result = await partnerPortalFetch<{
      ok: true;
      location: PartnerLocation;
    }>(`locations/${location.id}`, {
      method: "DELETE",
      headers: {
        "If-Match": location.etag,
        "Idempotency-Key": createPortalOperationKey("location-archive"),
      },
      body: JSON.stringify({
        ...input,
        confirmation: "ARCHIVE LOCATION",
      }),
    }).catch(() => null);
    setBusyId(null);
    if (!result?.ok) {
      setMessage({
        tone: "error",
        text: result?.error.message ?? "The location was not archived.",
      });
      return false;
    }
    setDirectoryEtag(
      result.response.headers.get("x-location-directory-etag") ?? directoryEtag,
    );
    setLocations((current) =>
      current.map((item) =>
        item.id === location.id ? result.data.location : item,
      ),
    );
    setEditingId(null);
    setArchiveReview(null);
    setMessage({
      tone: "success",
      text: "Location archived. Existing job records remain unchanged.",
    });
    return true;
  };

  const mergeLocation = async (
    location: PartnerLocation,
    targetLocationId: string,
    reason: string,
  ): Promise<boolean> => {
    setBusyId(`merge:${location.id}`);
    setMessage(null);
    const result = await partnerPortalFetch<{
      ok: true;
      location: PartnerLocation;
      duplicateConfidence: number;
    }>(`locations/${location.id}/merge`, {
      method: "POST",
      headers: {
        "If-Match": location.etag,
        "Idempotency-Key": createPortalOperationKey("location-merge"),
      },
      body: JSON.stringify({
        targetLocationId,
        reason,
        confirmation: "MERGE DUPLICATE LOCATION",
      }),
    }).catch(() => null);
    setBusyId(null);
    if (!result?.ok) {
      setMessage({
        tone: "error",
        text:
          result?.error.message ??
          "The locations could not be merged. Resolve linked saved requests, templates, or quotes and try again.",
      });
      return false;
    }
    setDirectoryEtag(
      result.response.headers.get("x-location-directory-etag") ?? directoryEtag,
    );
    setLocations((current) =>
      current.map((item) =>
        item.id === location.id ? result.data.location : item,
      ),
    );
    setEditingId(null);
    setMessage({
      tone: "success",
      text: "Duplicate merged. Historical jobs and documents still reference the original record, and the merge can be restored.",
    });
    return true;
  };

  const restoreMergedLocation = async (
    location: PartnerLocation,
  ): Promise<void> => {
    setBusyId(`restore:${location.id}`);
    setMessage(null);
    const result = await partnerPortalFetch<{
      ok: true;
      location: PartnerLocation;
    }>(`locations/${location.id}/restore`, {
      method: "POST",
      headers: {
        "If-Match": location.etag,
        "Idempotency-Key": createPortalOperationKey("location-restore"),
      },
      body: JSON.stringify({
        reason: "Account administrator restored the merged location.",
        confirmation: "RESTORE MERGED LOCATION",
      }),
    }).catch(() => null);
    setBusyId(null);
    if (!result?.ok) {
      setMessage({
        tone: "error",
        text: result?.error.message ?? "The merged location was not restored.",
      });
      return;
    }
    setDirectoryEtag(
      result.response.headers.get("x-location-directory-etag") ?? directoryEtag,
    );
    setLocations((current) =>
      current.map((item) =>
        item.id === location.id ? result.data.location : item,
      ),
    );
    setMessage({ tone: "success", text: "Merged location restored." });
  };

  const toggleFavorite = async (location: PartnerLocation): Promise<void> => {
    setBusyId(`favorite:${location.id}`);
    setMessage(null);
    const result = await partnerPortalFetch<{
      ok: true;
      location: PartnerLocation;
    }>(`locations/${location.id}/favorite`, {
      method: "PUT",
      headers: {
        "If-Match": location.etag,
        "Idempotency-Key": createPortalOperationKey("location-favorite"),
      },
      body: JSON.stringify({ favorite: !location.portfolio.isFavorite }),
    }).catch(() => null);
    setBusyId(null);
    if (!result?.ok) {
      setMessage({
        tone: "error",
        text: result?.error.message ?? "The favorite could not be changed.",
      });
      return;
    }
    setLocations((current) =>
      current.map((item) =>
        item.id === location.id ? result.data.location : item,
      ),
    );
    setMessage({
      tone: "success",
      text: result.data.location.portfolio.isFavorite
        ? "Location added to your favorites."
        : "Location removed from your favorites.",
    });
  };

  const makeDefault = async (location: PartnerLocation): Promise<void> => {
    setBusyId(`default:${location.id}`);
    setMessage(null);
    const result = await partnerPortalFetch<{
      ok: true;
      location: PartnerLocation;
    }>(`locations/${location.id}`, {
      method: "PATCH",
      headers: {
        "If-Match": location.etag,
        "Idempotency-Key": createPortalOperationKey("location-default"),
      },
      body: JSON.stringify({ makeDefault: true }),
    }).catch(() => null);
    setBusyId(null);
    if (!result?.ok) {
      setMessage({
        tone: "error",
        text: result?.error.message ?? "The default location was not changed.",
      });
      return;
    }
    setDirectoryEtag(
      result.response.headers.get("x-location-directory-etag") ?? directoryEtag,
    );
    setLocations((current) =>
      current.map((item) => ({
        ...item,
        ...(item.id === location.id ? result.data.location : {}),
        portfolio: {
          ...(item.id === location.id
            ? result.data.location.portfolio
            : item.portfolio),
          isDefault: item.id === location.id,
        },
      })),
    );
    setMessage({ tone: "success", text: "Default location updated." });
  };

  const loadMore = async (): Promise<void> => {
    if (!nextCursor) return;
    setBusyId("load-more");
    const result = await partnerPortalFetch<{
      ok: true;
      locations: PartnerLocation[];
      directory: { etag: string };
      page: { nextCursor: string | null };
    }>(
      `locations?active=all&limit=100&cursor=${encodeURIComponent(nextCursor)}`,
    ).catch(() => null);
    setBusyId(null);
    if (!result?.ok) {
      setMessage({
        tone: "error",
        text: result?.error.message ?? "More locations could not be loaded.",
      });
      return;
    }
    setLocations((current) => {
      const merged = new Map(
        current.map((location) => [location.id, location]),
      );
      for (const location of result.data.locations)
        merged.set(location.id, location);
      return [...merged.values()];
    });
    setNextCursor(result.data.page.nextCursor);
    setDirectoryEtag(result.data.directory.etag);
  };

  const exportLocations = async (): Promise<void> => {
    setBusyId("export");
    setMessage(null);
    const response = await fetch("/api/partners/portal/locations/export", {
      cache: "no-store",
    }).catch(() => null);
    setBusyId(null);
    if (
      !response?.ok ||
      !(response.headers.get("content-type") ?? "").includes("text/csv")
    ) {
      setMessage({
        tone: "error",
        text: "The location export could not be prepared.",
      });
      return;
    }
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = "stonegate-locations.csv";
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return (
    <div className="space-y-5">
      {message ? (
        <PartnerNotice tone={message.tone}>{message.text}</PartnerNotice>
      ) : null}
      {pendingAddressSuggestion ? (
        <section
          className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-amber-950"
          aria-labelledby="partner-address-suggestion-title"
        >
          <h2
            id="partner-address-suggestion-title"
            className="text-base font-semibold"
          >
            Review the suggested address
          </h2>
          <p className="mt-1 text-sm leading-6">
            The address provider found a material correction. Choose the
            verified suggestion, or keep your entry and send it to Stonegate for
            review. Neither choice reserves a service time.
          </p>
          <address className="mt-3 not-italic text-sm font-medium">
            {pendingAddressSuggestion.suggestedAddress.addressLine1}
            {pendingAddressSuggestion.suggestedAddress.addressLine2
              ? `, ${pendingAddressSuggestion.suggestedAddress.addressLine2}`
              : ""}
            <br />
            {pendingAddressSuggestion.suggestedAddress.city},{" "}
            {pendingAddressSuggestion.suggestedAddress.state}{" "}
            {pendingAddressSuggestion.suggestedAddress.postalCode}
          </address>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              className={partnerPrimaryButtonClass}
              onClick={() => void continueSuggestedAddress(true)}
            >
              Use suggested address
            </button>
            <button
              type="button"
              className={partnerSecondaryButtonClass}
              onClick={() => void continueSuggestedAddress(false)}
            >
              Keep mine and request review
            </button>
            <button
              type="button"
              className={partnerSecondaryButtonClass}
              onClick={() => setPendingAddressSuggestion(null)}
            >
              Return to editing
            </button>
          </div>
        </section>
      ) : null}
      {canManagePortfolio || canExport ? (
        <div className="flex flex-wrap justify-end gap-2">
          {canExport ? (
            <button
              type="button"
              onClick={() => void exportLocations()}
              disabled={busyId === "export"}
              className={partnerSecondaryButtonClass}
            >
              {busyId === "export" ? (
                <LoaderCircle
                  className="h-4 w-4 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : (
                <Download className="h-4 w-4" aria-hidden="true" />
              )}
              {busyId === "export" ? "Preparing…" : "Export CSV"}
            </button>
          ) : null}
          {canManagePortfolio ? (
            <button
              type="button"
              onClick={() => setAdding((current) => !current)}
              className={partnerPrimaryButtonClass}
              aria-expanded={adding}
              aria-controls="partner-add-location"
            >
              {adding ? (
                <X className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Plus className="h-4 w-4" aria-hidden="true" />
              )}
              {adding ? "Close form" : "Add location"}
            </button>
          ) : null}
        </div>
      ) : null}
      {canManagePortfolio ? (
        <LocationImportPanel
          directoryEtag={directoryEtag}
          onDirectoryEtag={setDirectoryEtag}
        />
      ) : null}
      {adding ? (
        <section
          id="partner-add-location"
          aria-labelledby="partner-add-location-heading"
          className="rounded-2xl border border-primary-200 bg-primary-50/40 p-4 sm:p-5"
        >
          <h2
            id="partner-add-location-heading"
            className="text-lg font-semibold text-slate-950"
          >
            Save a service location
          </h2>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            Add the site details once, then select this location on future
            bookings. Gate codes and other secrets are encrypted separately.
          </p>
          <LocationFormFields
            initial={EMPTY_LOCATION}
            submitLabel="Add location"
            pending={busyId === "new"}
            onSubmit={createLocation}
            locations={locations}
            currentLocationId={null}
            canManagePortfolio={canManagePortfolio}
          />
        </section>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <label htmlFor="partner-location-search">
          <span className="text-sm font-semibold text-slate-700">
            Search locations
          </span>
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
              aria-hidden="true"
            />
            <input
              id="partner-location-search"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className={`${partnerFieldClass} pl-10`}
              placeholder="Name, address, or property ID"
            />
          </div>
        </label>
        <label className="flex min-h-11 items-center gap-3 rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(event) => setShowArchived(event.target.checked)}
            className="h-5 w-5 rounded border-slate-300 text-primary-700"
          />
          Show archived
        </label>
      </div>

      <p className="sr-only" role="status" aria-live="polite">
        {visible.length} {visible.length === 1 ? "location" : "locations"}{" "}
        shown.
      </p>

      {visible.length === 0 ? (
        <PartnerEmptyState
          title={
            search ? "No locations match that search" : "No active locations"
          }
          description={
            search
              ? "Try a different name, address, or property ID."
              : canManage
                ? "Save your first service location now so future bookings need less typing."
                : "No service locations are currently visible to your role."
          }
          icon={<MapPin className="h-6 w-6" aria-hidden="true" />}
        />
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {visible.map((location) => {
            const editing = editingId === location.id;
            return (
              <li
                key={location.id}
                className={cn(
                  "rounded-2xl border bg-white p-4",
                  location.active
                    ? "border-slate-200"
                    : "border-slate-200 bg-slate-50 opacity-80",
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-semibold text-slate-950">
                        {location.siteName || location.address.line1}
                      </h2>
                      {!location.active ? (
                        <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-semibold text-slate-700">
                          {location.portfolio.mergedIntoLocationId
                            ? "Merged duplicate"
                            : "Archived"}
                        </span>
                      ) : null}
                      {location.portfolio.isDefault ? (
                        <span className="rounded-full bg-primary-100 px-2 py-0.5 text-xs font-semibold text-primary-800">
                          Default
                        </span>
                      ) : null}
                      {location.portfolio.isFavorite ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-900">
                          <Star
                            className="h-3 w-3 fill-current"
                            aria-hidden="true"
                          />
                          Favorite
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 text-sm leading-6 text-slate-600">
                      {[
                        location.address.line1,
                        location.address.line2,
                        `${location.address.city}, ${location.address.state} ${location.address.postalCode}`,
                      ]
                        .filter(Boolean)
                        .join(", ")}
                    </p>
                    {location.externalPropertyId ? (
                      <p className="mt-1 text-xs text-slate-600">
                        Property ID: {location.externalPropertyId}
                      </p>
                    ) : null}
                    {location.portfolio.parentLocationId ? (
                      <p className="mt-1 inline-flex items-center gap-1.5 text-xs text-slate-600">
                        <Building2 className="h-3.5 w-3.5" aria-hidden="true" />
                        Grouped under{" "}
                        {locations.find(
                          (parent) =>
                            parent.id === location.portfolio.parentLocationId,
                        )?.siteName ?? "another account location"}
                      </p>
                    ) : location.portfolio.childCount > 0 ? (
                      <p className="mt-1 text-xs text-slate-600">
                        {location.portfolio.childCount}{" "}
                        {location.portfolio.childCount === 1 ? "site" : "sites"}{" "}
                        in this group
                      </p>
                    ) : null}
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
                      {location.access.hasSecret ? (
                        <span className="inline-flex items-center gap-1.5">
                          <KeyRound
                            className="h-3.5 w-3.5"
                            aria-hidden="true"
                          />
                          Private access code saved
                        </span>
                      ) : null}
                      {location.access.details ||
                      location.access.parking ||
                      location.access.loading ? (
                        <span>Access instructions saved</span>
                      ) : null}
                      {text(location.onSiteContact, "name") ? (
                        <span className="inline-flex items-center gap-1.5">
                          <UserRound
                            className="h-3.5 w-3.5"
                            aria-hidden="true"
                          />
                          {text(location.onSiteContact, "name")}
                        </span>
                      ) : null}
                    </div>
                    {location.serviceArea.reason ? (
                      <p className="mt-2 text-xs leading-5 text-amber-800">
                        {location.serviceArea.reason}
                      </p>
                    ) : null}
                    {location.addressVerification.status ===
                    "suggested_correction" ? (
                      <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-950">
                        <p className="font-semibold">
                          Stonegate is reviewing this address.
                        </p>
                        {location.addressVerification.suggestedAddress ? (
                          <p>
                            Provider suggestion:{" "}
                            {[
                              location.addressVerification.suggestedAddress
                                .line1,
                              location.addressVerification.suggestedAddress
                                .line2,
                              location.addressVerification.suggestedAddress
                                .city,
                              location.addressVerification.suggestedAddress
                                .state,
                              location.addressVerification.suggestedAddress
                                .postalCode,
                            ]
                              .filter(Boolean)
                              .join(", ")}
                          </p>
                        ) : null}
                        <p>
                          Review requests remain available; instant confirmation
                          stays off until verification is complete.
                        </p>
                      </div>
                    ) : location.addressVerification.status ===
                      "review_required" ? (
                      <p className="mt-2 text-xs leading-5 text-amber-800">
                        Address review is queued. Instant confirmation remains
                        off until Stonegate verifies this site.
                      </p>
                    ) : null}
                  </div>
                  <ServiceAreaBadge status={location.serviceArea.status} />
                </div>
                <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-200 pt-3">
                  {location.active ? (
                    <button
                      type="button"
                      onClick={() => void toggleFavorite(location)}
                      disabled={busyId === `favorite:${location.id}`}
                      className={partnerSecondaryButtonClass}
                      aria-pressed={location.portfolio.isFavorite}
                    >
                      <Star
                        className={cn(
                          "h-4 w-4",
                          location.portfolio.isFavorite && "fill-current",
                        )}
                        aria-hidden="true"
                      />
                      {location.portfolio.isFavorite
                        ? "Unfavorite"
                        : "Favorite"}
                    </button>
                  ) : null}
                  {location.active ? (
                    <Link
                      href={
                        `/partners/book?locationId=${encodeURIComponent(location.id)}` as Route
                      }
                      className={partnerSecondaryButtonClass}
                    >
                      <CalendarPlus2 className="h-4 w-4" aria-hidden="true" />
                      Request service here
                    </Link>
                  ) : null}
                  {canManage && location.active ? (
                    <button
                      type="button"
                      onClick={() => setEditingId(editing ? null : location.id)}
                      className={partnerSecondaryButtonClass}
                      aria-expanded={editing}
                      aria-controls={`partner-location-edit-${location.id}`}
                    >
                      <Pencil className="h-4 w-4" aria-hidden="true" />
                      {editing ? "Close edit" : "Edit"}
                    </button>
                  ) : null}
                  {canManagePortfolio &&
                  location.active &&
                  !location.portfolio.isDefault ? (
                    <button
                      type="button"
                      onClick={() => void makeDefault(location)}
                      disabled={busyId === `default:${location.id}`}
                      className={partnerSecondaryButtonClass}
                    >
                      <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                      Make default
                    </button>
                  ) : null}
                  {canManagePortfolio &&
                  !location.active &&
                  location.portfolio.mergedIntoLocationId ? (
                    <button
                      type="button"
                      onClick={() => void restoreMergedLocation(location)}
                      disabled={busyId === `restore:${location.id}`}
                      className={partnerSecondaryButtonClass}
                    >
                      {busyId === `restore:${location.id}` ? (
                        <LoaderCircle
                          className="h-4 w-4 animate-spin motion-reduce:animate-none"
                          aria-hidden="true"
                        />
                      ) : (
                        <Building2 className="h-4 w-4" aria-hidden="true" />
                      )}
                      Restore merged location
                    </button>
                  ) : null}
                </div>
                {editing ? (
                  <div
                    id={`partner-location-edit-${location.id}`}
                    className="mt-4 border-t border-slate-200 pt-4"
                  >
                    <LocationFormFields
                      initial={formFromLocation(location)}
                      submitLabel="Save changes"
                      pending={busyId === location.id}
                      onSubmit={(form) => updateLocation(location, form)}
                      locations={locations}
                      currentLocationId={location.id}
                      canManagePortfolio={canManagePortfolio}
                    />
                    <details className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-3">
                      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg font-semibold text-rose-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 [&::-webkit-details-marker]:hidden">
                        <Archive className="h-4 w-4" aria-hidden="true" />
                        Archive location
                      </summary>
                      {archiveReview?.locationId === location.id ? (
                        <ArchiveLocationForm
                          location={location}
                          locations={locations}
                          impact={archiveReview.impact}
                          pending={busyId === location.id}
                          onCancel={() => setArchiveReview(null)}
                          onArchive={(input) =>
                            archiveLocation(location, input)
                          }
                        />
                      ) : (
                        <>
                          <p className="mt-2 text-sm leading-6 text-rose-800">
                            Review linked jobs, saved requests, groups, and the
                            account default before this location is removed from
                            new scheduling.
                          </p>
                          <button
                            type="button"
                            onClick={() => void reviewArchive(location)}
                            disabled={busyId === location.id}
                            className={cn(
                              partnerSecondaryButtonClass,
                              "mt-3 border-rose-300 text-rose-800 hover:bg-rose-100",
                            )}
                          >
                            {busyId === location.id ? (
                              <LoaderCircle
                                className="h-4 w-4 animate-spin motion-reduce:animate-none"
                                aria-hidden="true"
                              />
                            ) : (
                              <Archive className="h-4 w-4" aria-hidden="true" />
                            )}
                            Review archive impact
                          </button>
                        </>
                      )}
                    </details>
                    {canManagePortfolio ? (
                      <MergeLocationForm
                        location={location}
                        locations={locations}
                        pending={busyId === `merge:${location.id}`}
                        onMerge={(targetLocationId, reason) =>
                          mergeLocation(location, targetLocationId, reason)
                        }
                      />
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {nextCursor ? (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={busyId === "load-more"}
            className={partnerSecondaryButtonClass}
          >
            {busyId === "load-more" ? (
              <LoaderCircle
                className="h-4 w-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : null}
            {busyId === "load-more" ? "Loading…" : "Load more locations"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function LocationFormFields({
  initial,
  submitLabel,
  pending,
  onSubmit,
  locations,
  currentLocationId,
  canManagePortfolio,
}: {
  initial: LocationForm;
  submitLabel: string;
  pending: boolean;
  onSubmit: (form: LocationForm) => Promise<boolean>;
  locations: PartnerLocation[];
  currentLocationId: string | null;
  canManagePortfolio: boolean;
}) {
  const [form, setForm] = React.useState(initial);
  const fieldPrefix = `partner-location-${React.useId().replace(/:/gu, "")}`;
  const update = (key: keyof LocationForm, value: string): void =>
    setForm((current) => ({ ...current, [key]: value }));
  const unavailableParents = new Set<string>();
  if (currentLocationId) {
    unavailableParents.add(currentLocationId);
    let changed = true;
    while (changed) {
      changed = false;
      for (const location of locations) {
        if (
          location.portfolio.parentLocationId &&
          unavailableParents.has(location.portfolio.parentLocationId) &&
          !unavailableParents.has(location.id)
        ) {
          unavailableParents.add(location.id);
          changed = true;
        }
      }
    }
  }
  return (
    <form
      className="mt-4 grid gap-4 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit(form);
      }}
    >
      <label htmlFor={`${fieldPrefix}-site-name`}>
        <span className="text-sm font-semibold text-slate-700">
          Location name
        </span>
        <input
          id={`${fieldPrefix}-site-name`}
          required
          maxLength={120}
          value={form.siteName}
          onChange={(event) => update("siteName", event.target.value)}
          className={partnerFieldClass}
          placeholder="Building, listing, jobsite, or property"
        />
      </label>
      <label htmlFor={`${fieldPrefix}-property-id`}>
        <span className="text-sm font-semibold text-slate-700">
          Internal property ID{" "}
          <span className="font-normal text-slate-500">(optional)</span>
        </span>
        <input
          id={`${fieldPrefix}-property-id`}
          maxLength={100}
          value={form.externalPropertyId}
          onChange={(event) => update("externalPropertyId", event.target.value)}
          className={partnerFieldClass}
        />
      </label>
      {canManagePortfolio ? (
        <>
          <label htmlFor={`${fieldPrefix}-parent-location`}>
            <span className="text-sm font-semibold text-slate-700">
              Parent group{" "}
              <span className="font-normal text-slate-500">(optional)</span>
            </span>
            <select
              id={`${fieldPrefix}-parent-location`}
              value={form.parentLocationId}
              onChange={(event) =>
                update("parentLocationId", event.target.value)
              }
              className={partnerFieldClass}
            >
              <option value="">No parent group</option>
              {locations
                .filter(
                  (location) =>
                    location.active && !unavailableParents.has(location.id),
                )
                .map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.siteName || location.address.line1}
                  </option>
                ))}
            </select>
          </label>
          <label className="flex min-h-11 items-center gap-3 self-end rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700">
            <input
              type="checkbox"
              checked={form.makeDefault}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  makeDefault: event.target.checked,
                }))
              }
              className="h-5 w-5 rounded border-slate-300 text-primary-700"
            />
            Use as the account default
          </label>
        </>
      ) : null}
      <label className="sm:col-span-2" htmlFor={`${fieldPrefix}-line1`}>
        <span className="text-sm font-semibold text-slate-700">
          Street address
        </span>
        <input
          id={`${fieldPrefix}-line1`}
          required
          autoComplete="address-line1"
          value={form.line1}
          onChange={(event) => update("line1", event.target.value)}
          className={partnerFieldClass}
        />
      </label>
      <label className="sm:col-span-2" htmlFor={`${fieldPrefix}-line2`}>
        <span className="text-sm font-semibold text-slate-700">
          Suite, unit, building, or floor{" "}
          <span className="font-normal text-slate-500">(optional)</span>
        </span>
        <input
          id={`${fieldPrefix}-line2`}
          autoComplete="address-line2"
          value={form.line2}
          onChange={(event) => update("line2", event.target.value)}
          className={partnerFieldClass}
        />
      </label>
      <label htmlFor={`${fieldPrefix}-city`}>
        <span className="text-sm font-semibold text-slate-700">City</span>
        <input
          id={`${fieldPrefix}-city`}
          required
          autoComplete="address-level2"
          value={form.city}
          onChange={(event) => update("city", event.target.value)}
          className={partnerFieldClass}
        />
      </label>
      <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3">
        <label htmlFor={`${fieldPrefix}-state`}>
          <span className="text-sm font-semibold text-slate-700">State</span>
          <input
            id={`${fieldPrefix}-state`}
            required
            maxLength={2}
            autoComplete="address-level1"
            value={form.state}
            onChange={(event) =>
              update("state", event.target.value.toUpperCase())
            }
            className={`${partnerFieldClass} uppercase`}
          />
        </label>
        <label htmlFor={`${fieldPrefix}-zip`}>
          <span className="text-sm font-semibold text-slate-700">ZIP code</span>
          <input
            id={`${fieldPrefix}-zip`}
            required
            autoComplete="postal-code"
            inputMode="numeric"
            value={form.postalCode}
            onChange={(event) => update("postalCode", event.target.value)}
            className={partnerFieldClass}
          />
        </label>
      </div>
      <label className="sm:col-span-2" htmlFor={`${fieldPrefix}-access`}>
        <span className="text-sm font-semibold text-slate-700">
          General access details{" "}
          <span className="font-normal text-slate-500">(optional)</span>
        </span>
        <textarea
          id={`${fieldPrefix}-access`}
          rows={3}
          maxLength={2_000}
          value={form.accessDetails}
          onChange={(event) => update("accessDetails", event.target.value)}
          className={partnerFieldClass}
        />
      </label>
      <label htmlFor={`${fieldPrefix}-parking`}>
        <span className="text-sm font-semibold text-slate-700">
          Parking instructions{" "}
          <span className="font-normal text-slate-500">(optional)</span>
        </span>
        <textarea
          id={`${fieldPrefix}-parking`}
          rows={3}
          maxLength={2_000}
          value={form.parking}
          onChange={(event) => update("parking", event.target.value)}
          className={partnerFieldClass}
        />
      </label>
      <label htmlFor={`${fieldPrefix}-loading`}>
        <span className="text-sm font-semibold text-slate-700">
          Loading instructions{" "}
          <span className="font-normal text-slate-500">(optional)</span>
        </span>
        <textarea
          id={`${fieldPrefix}-loading`}
          rows={3}
          maxLength={2_000}
          value={form.loading}
          onChange={(event) => update("loading", event.target.value)}
          className={partnerFieldClass}
        />
      </label>
      <label className="sm:col-span-2" htmlFor={`${fieldPrefix}-secret`}>
        <span className="text-sm font-semibold text-slate-700">
          Gate code or private access secret{" "}
          <span className="font-normal text-slate-500">(optional)</span>
        </span>
        <input
          id={`${fieldPrefix}-secret`}
          type="password"
          autoComplete="off"
          maxLength={2_000}
          value={form.accessSecret}
          onChange={(event) => update("accessSecret", event.target.value)}
          className={partnerFieldClass}
          placeholder={
            submitLabel === "Save changes"
              ? "Leave blank to keep the current secret"
              : "Stored encrypted and never shown back"
          }
        />
        <span className="mt-1 block text-xs text-slate-500">
          Use this only for sensitive codes. Put ordinary directions in general
          access details.
        </span>
      </label>
      <label htmlFor={`${fieldPrefix}-contact-name`}>
        <span className="text-sm font-semibold text-slate-700">
          Default on-site contact
        </span>
        <input
          id={`${fieldPrefix}-contact-name`}
          autoComplete="name"
          maxLength={120}
          value={form.contactName}
          onChange={(event) => update("contactName", event.target.value)}
          className={partnerFieldClass}
        />
      </label>
      <div className="grid gap-3">
        <label htmlFor={`${fieldPrefix}-contact-phone`}>
          <span className="text-sm font-semibold text-slate-700">
            Contact phone
          </span>
          <input
            id={`${fieldPrefix}-contact-phone`}
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={form.contactPhone}
            onChange={(event) => update("contactPhone", event.target.value)}
            className={partnerFieldClass}
          />
        </label>
        <label htmlFor={`${fieldPrefix}-contact-email`}>
          <span className="text-sm font-semibold text-slate-700">
            Contact email
          </span>
          <input
            id={`${fieldPrefix}-contact-email`}
            type="email"
            inputMode="email"
            autoComplete="email"
            value={form.contactEmail}
            onChange={(event) => update("contactEmail", event.target.value)}
            className={partnerFieldClass}
          />
        </label>
      </div>
      <button
        type="submit"
        disabled={pending}
        className={cn(partnerPrimaryButtonClass, "sm:col-span-2")}
      >
        {pending ? (
          <LoaderCircle
            className="h-4 w-4 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
        ) : (
          <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
        )}
        {pending ? "Saving…" : submitLabel}
      </button>
    </form>
  );
}

function MergeLocationForm({
  location,
  locations,
  pending,
  onMerge,
}: {
  location: PartnerLocation;
  locations: PartnerLocation[];
  pending: boolean;
  onMerge: (targetLocationId: string, reason: string) => Promise<boolean>;
}) {
  const [targetLocationId, setTargetLocationId] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [confirmation, setConfirmation] = React.useState("");
  const fieldId = `merge-location-${React.useId().replace(/:/gu, "")}`;
  const targets = locations.filter(
    (candidate) => candidate.active && candidate.id !== location.id,
  );
  if (targets.length === 0) return null;
  return (
    <details className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg font-semibold text-amber-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-600 [&::-webkit-details-marker]:hidden">
        <Building2 className="h-4 w-4" aria-hidden="true" />
        Merge a duplicate location
      </summary>
      <p className="mt-2 text-sm leading-6 text-amber-950">
        Use this only when two records represent the same physical service site.
        The duplicate is archived; job, quote, proof, and financial history is
        preserved. Linked saved requests or active quotes must be resolved
        first.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label htmlFor={`${fieldId}-target`}>
          <span className="text-sm font-semibold text-amber-950">
            Keep this location
          </span>
          <select
            id={`${fieldId}-target`}
            value={targetLocationId}
            onChange={(event) => setTargetLocationId(event.target.value)}
            className={partnerFieldClass}
          >
            <option value="">Choose a matching location</option>
            {targets.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.siteName || candidate.address.line1} —{` `}
                {candidate.address.line1}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor={`${fieldId}-reason`}>
          <span className="text-sm font-semibold text-amber-950">Reason</span>
          <input
            id={`${fieldId}-reason`}
            minLength={5}
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            className={partnerFieldClass}
            placeholder="How the duplicate was confirmed"
          />
        </label>
        <label className="sm:col-span-2" htmlFor={`${fieldId}-confirmation`}>
          <span className="text-sm font-semibold text-amber-950">
            Type MERGE DUPLICATE LOCATION to confirm
          </span>
          <input
            id={`${fieldId}-confirmation`}
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            className={partnerFieldClass}
            autoComplete="off"
          />
        </label>
      </div>
      <button
        type="button"
        onClick={() => void onMerge(targetLocationId, reason)}
        disabled={
          pending ||
          !targetLocationId ||
          reason.trim().length < 5 ||
          confirmation !== "MERGE DUPLICATE LOCATION"
        }
        className={cn(
          partnerSecondaryButtonClass,
          "mt-3 border-amber-400 text-amber-950 hover:bg-amber-100",
        )}
      >
        {pending ? (
          <LoaderCircle
            className="h-4 w-4 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
        ) : (
          <Building2 className="h-4 w-4" aria-hidden="true" />
        )}
        Merge duplicate
      </button>
    </details>
  );
}

function ArchiveLocationForm({
  location,
  locations,
  impact,
  pending,
  onCancel,
  onArchive,
}: {
  location: PartnerLocation;
  locations: PartnerLocation[];
  impact: ArchiveImpact;
  pending: boolean;
  onCancel: () => void;
  onArchive: (input: {
    reason: string;
    replacementDefaultLocationId?: string;
    childDisposition?: "promote" | "move";
    replacementParentLocationId?: string;
  }) => Promise<boolean>;
}) {
  const [reason, setReason] = React.useState("");
  const [replacementDefaultLocationId, setReplacementDefaultLocationId] =
    React.useState("");
  const [childDisposition, setChildDisposition] = React.useState<
    "promote" | "move"
  >("promote");
  const [replacementParentLocationId, setReplacementParentLocationId] =
    React.useState("");
  const [confirmed, setConfirmed] = React.useState(false);
  const unavailableParents = new Set([location.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of locations) {
      if (
        candidate.portfolio.parentLocationId &&
        unavailableParents.has(candidate.portfolio.parentLocationId) &&
        !unavailableParents.has(candidate.id)
      ) {
        unavailableParents.add(candidate.id);
        changed = true;
      }
    }
  }
  const alternatives = locations.filter(
    (candidate) => candidate.active && candidate.id !== location.id,
  );
  const parentCandidates = alternatives.filter(
    (candidate) => !unavailableParents.has(candidate.id),
  );

  return (
    <form
      className="mt-3 grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void onArchive({
          reason,
          ...(impact.isDefault && replacementDefaultLocationId
            ? { replacementDefaultLocationId }
            : {}),
          ...(impact.activeChildCount > 0
            ? {
                childDisposition,
                ...(childDisposition === "move" && replacementParentLocationId
                  ? { replacementParentLocationId }
                  : {}),
              }
            : {}),
        });
      }}
    >
      <div className="rounded-lg bg-white/70 p-3 text-sm leading-6 text-rose-900">
        <p className="font-semibold">What archiving affects</p>
        <ul className="mt-1 list-disc pl-5">
          <li>{impact.openDraftCount} open service requests</li>
          <li>{impact.activeTemplateCount} active saved templates</li>
          <li>{impact.canonicalQuoteV2Count} active quotes</li>
          <li>
            {impact.issuedActionableQuoteV2Count} issued quotes awaiting a
            response
          </li>
          <li>{impact.jobHistoryCount} historical jobs remain linked</li>
          <li>{impact.activeChildCount} active grouped locations</li>
        </ul>
      </div>
      {impact.issuedActionableQuoteV2Count > 0 ? (
        <div
          role="alert"
          className="rounded-lg border border-rose-400 bg-rose-100 p-3 text-sm leading-6 text-rose-950"
        >
          <p className="font-semibold">Archiving is blocked</p>
          <p>
            Resolve, expire, supersede, or void every issued quote for this
            location first. The quote and its documents will remain available as
            financial evidence after a later archive.
          </p>
        </div>
      ) : null}
      {impact.isDefault && impact.activeAlternativeCount > 0 ? (
        <label>
          <span className="text-sm font-semibold text-rose-900">
            New account default
          </span>
          <select
            required
            value={replacementDefaultLocationId}
            onChange={(event) =>
              setReplacementDefaultLocationId(event.target.value)
            }
            className={partnerFieldClass}
          >
            <option value="">Choose a replacement</option>
            {alternatives.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.siteName || candidate.address.line1}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {impact.activeChildCount > 0 ? (
        <>
          <fieldset>
            <legend className="text-sm font-semibold text-rose-900">
              Grouped locations
            </legend>
            <div className="mt-1 grid gap-2 sm:grid-cols-2">
              {(["promote", "move"] as const).map((value) => (
                <label
                  key={value}
                  className="flex min-h-11 items-center gap-2 rounded-lg border border-rose-200 bg-white/70 px-3 py-2 text-sm"
                >
                  <input
                    type="radio"
                    name={`archive-children-${location.id}`}
                    value={value}
                    checked={childDisposition === value}
                    onChange={() => setChildDisposition(value)}
                  />
                  {value === "promote"
                    ? "Promote to this location’s parent"
                    : "Move to another group"}
                </label>
              ))}
            </div>
          </fieldset>
          {childDisposition === "move" ? (
            <label>
              <span className="text-sm font-semibold text-rose-900">
                Replacement parent group
              </span>
              <select
                required
                value={replacementParentLocationId}
                onChange={(event) =>
                  setReplacementParentLocationId(event.target.value)
                }
                className={partnerFieldClass}
              >
                <option value="">Choose a parent</option>
                {parentCandidates.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.siteName || candidate.address.line1}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </>
      ) : null}
      <label>
        <span className="text-sm font-semibold text-rose-900">
          Reason for archiving
        </span>
        <textarea
          required
          minLength={5}
          maxLength={500}
          rows={2}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          className={partnerFieldClass}
        />
      </label>
      <label className="flex min-h-11 items-start gap-3 rounded-lg border border-rose-300 bg-white/70 p-3 text-sm text-rose-950">
        <input
          type="checkbox"
          required
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
          className="mt-0.5 h-5 w-5"
        />
        I understand this location will no longer be available for new jobs.
      </label>
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={
            pending ||
            impact.issuedActionableQuoteV2Count > 0 ||
            !confirmed ||
            reason.trim().length < 5 ||
            (impact.isDefault &&
              impact.activeAlternativeCount > 0 &&
              !replacementDefaultLocationId) ||
            (impact.activeChildCount > 0 &&
              childDisposition === "move" &&
              !replacementParentLocationId)
          }
          className={cn(
            partnerSecondaryButtonClass,
            "border-rose-300 text-rose-800 hover:bg-rose-100",
          )}
        >
          {pending ? (
            <LoaderCircle
              className="h-4 w-4 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : (
            <Archive className="h-4 w-4" aria-hidden="true" />
          )}
          {pending ? "Archiving…" : "Archive location"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          className={partnerSecondaryButtonClass}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function LocationImportPanel({
  directoryEtag,
  onDirectoryEtag,
}: {
  directoryEtag: string;
  onDirectoryEtag: (etag: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [csv, setCsv] = React.useState("");
  const [operation, setOperation] =
    React.useState<PartnerLocationImport | null>(null);
  const [busy, setBusy] = React.useState<"dry-run" | "commit" | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);

  const dryRun = async (): Promise<void> => {
    setBusy("dry-run");
    setMessage(null);
    const result = await partnerPortalFetch<{
      ok: true;
      import: PartnerLocationImport;
    }>("locations/imports/dry-run", {
      method: "POST",
      headers: {
        "Idempotency-Key": createPortalOperationKey("location-import-dry-run"),
      },
      body: JSON.stringify({ csv }),
    }).catch(() => null);
    setBusy(null);
    if (!result?.ok) {
      setMessage(
        result?.error.message ?? "The CSV could not be validated safely.",
      );
      return;
    }
    setOperation(result.data.import);
    const nextDirectoryEtag = result.response.headers.get(
      "x-location-directory-etag",
    );
    if (nextDirectoryEtag) onDirectoryEtag(nextDirectoryEtag);
    setMessage(
      result.data.import.invalidRowCount === 0
        ? `${result.data.import.rowCount} rows are ready to import.`
        : `${result.data.import.invalidRowCount} rows need correction. Nothing was imported.`,
    );
  };

  const commit = async (): Promise<void> => {
    if (!operation) return;
    setBusy("commit");
    setMessage(null);
    const result = await partnerPortalFetch<{
      ok: true;
      import: PartnerLocationImport;
      createdCount: number;
    }>(`locations/imports/${operation.id}/commit`, {
      method: "POST",
      headers: {
        "If-Match": directoryEtag,
        "Idempotency-Key": createPortalOperationKey("location-import-commit"),
      },
      body: JSON.stringify({
        confirmation: `IMPORT ${operation.rowCount} LOCATIONS`,
      }),
    }).catch(() => null);
    setBusy(null);
    if (!result?.ok) {
      setMessage(
        result?.error.error === "revision_mismatch" ||
          result?.error.error === "conflict"
          ? "The location directory changed. Run the dry-run again before importing."
          : (result?.error.message ?? "No locations were imported."),
      );
      return;
    }
    const nextDirectoryEtag = result.response.headers.get(
      "x-location-directory-etag",
    );
    if (nextDirectoryEtag) onDirectoryEtag(nextDirectoryEtag);
    setOperation(result.data.import);
    setCsv("");
    setMessage(
      `${result.data.createdCount} locations imported. Refreshing the directory…`,
    );
    window.location.reload();
  };

  const downloadTemplate = (): void => {
    const header =
      "site_name,external_property_id,address_line_1,address_line_2,city,state,postal_code,timezone,parent_external_property_id,make_default\r\n";
    const url = URL.createObjectURL(
      new Blob([header], { type: "text/csv;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "stonegate-location-import-template.csv";
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return (
    <section className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold text-slate-950">
            Add many locations at once
          </h2>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            Use a CSV to check and add up to 500 locations in one batch. The
            first check does not import anything.{" "}
            <span>CSV files never include gate codes or access secrets.</span>
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          className={partnerSecondaryButtonClass}
          aria-expanded={open}
          aria-controls="partner-location-import"
        >
          <FileSpreadsheet className="h-4 w-4" aria-hidden="true" />
          {open ? "Close import" : "Import CSV"}
        </button>
      </div>
      {open ? (
        <div id="partner-location-import" className="mt-4 grid gap-4">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={downloadTemplate}
              className={partnerSecondaryButtonClass}
            >
              <Download className="h-4 w-4" aria-hidden="true" />
              Download template
            </button>
            {operation?.invalidRowCount ? (
              <a
                href={`/api/partners/portal/locations/imports/${operation.id}/corrections`}
                className={partnerSecondaryButtonClass}
              >
                <Download className="h-4 w-4" aria-hidden="true" />
                Download corrections
              </a>
            ) : null}
          </div>
          <label>
            <span className="text-sm font-semibold text-slate-700">
              Choose a CSV file
            </span>
            <input
              type="file"
              accept=".csv,text/csv"
              className={`${partnerFieldClass} file:mr-3 file:rounded-lg file:border-0 file:bg-primary-50 file:px-3 file:py-2 file:font-semibold file:text-primary-800`}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                if (file.size > 262_144) {
                  setMessage("Choose a CSV no larger than 256 KB.");
                  return;
                }
                void file.text().then((value) => {
                  setCsv(value);
                  setOperation(null);
                  setMessage(null);
                });
              }}
            />
          </label>
          <button
            type="button"
            onClick={() => void dryRun()}
            disabled={!csv || busy !== null}
            className={partnerPrimaryButtonClass}
          >
            {busy === "dry-run" ? (
              <LoaderCircle
                className="h-4 w-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : (
              <Upload className="h-4 w-4" aria-hidden="true" />
            )}
            {busy === "dry-run" ? "Validating…" : "Validate file"}
          </button>
          {message ? (
            <p
              className="text-sm leading-6 text-slate-700"
              role="status"
              aria-live="polite"
            >
              {message}
            </p>
          ) : null}
          {operation ? (
            <div className="grid gap-3">
              <div className="grid grid-cols-3 gap-2 text-center text-sm">
                <div className="rounded-lg bg-white p-3">
                  <span className="block text-lg font-semibold text-slate-950">
                    {operation.rowCount}
                  </span>
                  Total rows
                </div>
                <div className="rounded-lg bg-emerald-50 p-3 text-emerald-900">
                  <span className="block text-lg font-semibold">
                    {operation.validRowCount}
                  </span>
                  Valid
                </div>
                <div className="rounded-lg bg-rose-50 p-3 text-rose-900">
                  <span className="block text-lg font-semibold">
                    {operation.invalidRowCount}
                  </span>
                  Needs correction
                </div>
              </div>
              <div className="max-h-80 overflow-auto rounded-xl border border-slate-200 bg-white">
                <table className="w-full min-w-[38rem] text-left text-sm">
                  <caption className="sr-only">
                    Location import validation results
                  </caption>
                  <thead className="sticky top-0 bg-slate-100 text-slate-700">
                    <tr>
                      <th scope="col" className="px-3 py-2">
                        Row
                      </th>
                      <th scope="col" className="px-3 py-2">
                        Site
                      </th>
                      <th scope="col" className="px-3 py-2">
                        Status
                      </th>
                      <th scope="col" className="px-3 py-2">
                        Feedback
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {operation.rows.map((row) => (
                      <tr
                        key={row.rowNumber}
                        className="border-t border-slate-100 align-top"
                      >
                        <td className="px-3 py-2">{row.rowNumber}</td>
                        <td className="px-3 py-2">
                          {row.values["site_name"] || "—"}
                        </td>
                        <td className="px-3 py-2">
                          {row.status === "valid" ? "Ready" : "Fix"}
                        </td>
                        <td className="px-3 py-2">
                          {row.errors.length
                            ? row.errors.map((error) => error.message).join(" ")
                            : "No errors"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {operation.canCommit ? (
                <button
                  type="button"
                  onClick={() => void commit()}
                  disabled={busy !== null}
                  className={partnerPrimaryButtonClass}
                >
                  {busy === "commit" ? (
                    <LoaderCircle
                      className="h-4 w-4 animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                  ) : (
                    <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                  )}
                  {busy === "commit"
                    ? "Importing…"
                    : `Import ${operation.rowCount} locations`}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function ServiceAreaBadge({ status }: { status: string }) {
  const eligible = status === "eligible";
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset",
        eligible
          ? "bg-emerald-50 text-emerald-800 ring-emerald-200"
          : "bg-amber-50 text-amber-900 ring-amber-200",
      )}
    >
      {eligible ? "Serviceable" : "Needs review"}
    </span>
  );
}
