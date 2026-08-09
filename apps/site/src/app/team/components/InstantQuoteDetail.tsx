import React from "react";
import { randomUUID } from "node:crypto";
import Link from "next/link";
import { requireCurrentTeamPrincipal } from "@/lib/team-principal";
import { hasTeamPermissionValue } from "@/lib/team-permissions";
import { callAdminApiAs } from "../lib/api";
import { deleteInstantQuoteAction } from "../actions";
import { DeleteInstantQuoteForm } from "./DeleteInstantQuoteForm";
import { TEAM_TIME_ZONE } from "../lib/timezone";
import {
  loadInstantQuoteHandoff,
  verifyInstantQuoteHandoffSelection,
} from "../lib/instant-quote-handoff";
import { quoteWorkspaceHref } from "../quotes-workspace";
import { teamSurfaceHref } from "../surface-registry";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function formatLabel(value: string | null | undefined): string {
  if (typeof value !== "string" || value.trim().length === 0) return "Unknown";
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

type InstantQuoteDto = {
  id: string;
  createdAt: string;
  contactName: string;
  contactPhone: string;
  timeframe: string;
  zip: string;
  jobTypes: string[];
  perceivedSize: string;
  notes: string | null;
  photoUrls: string[];
  aiResult: {
    loadFractionEstimate: number;
    priceLow: number;
    priceHigh: number;
    priceLowDiscounted?: number;
    priceHighDiscounted?: number;
    discountPercent?: number;
    addOnTotal?: number;
    displayTierLabel: string;
    reasonSummary: string;
    needsInPersonEstimate: boolean;
    mediaAnalysis?: {
      source?: string;
      visibleVolumeRange?: string;
      mergedVolumeRange?: string;
      visibleMattressCount?: number;
      visiblePaintCanCount?: number;
      confidence?: "low" | "medium" | "high";
      missingViews?: string[];
    };
  };
  isMediaInformed?: boolean;
  hasBookedAppointment?: boolean;
  tightenedAfterMoreMedia?: boolean;
};

export async function InstantQuoteDetail({ quoteId }: { quoteId: string }) {
  if (!UUID_PATTERN.test(quoteId)) {
    return (
      <div
        className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        role="alert"
      >
        Quote not found.
      </div>
    );
  }
  const principal = await requireCurrentTeamPrincipal();
  const canDelete = hasTeamPermissionValue(
    principal.permissions,
    "quotes.delete",
  );
  const [res, loadedHandoff] = await Promise.all([
    callAdminApiAs(
      principal,
      `/api/admin/instant-quotes?id=${encodeURIComponent(quoteId)}`,
    ),
    loadInstantQuoteHandoff(principal, quoteId),
  ]);
  if (!res.ok) {
    const failure = (await res.json().catch(() => null)) as {
      message?: unknown;
      error?: unknown;
    } | null;
    const message =
      typeof failure?.message === "string" && failure.message.trim()
        ? failure.message
        : res.status === 404
          ? "Quote not found."
          : "The instant quote could not be loaded. Try again.";
    return (
      <div
        className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        role="alert"
      >
        {message}
      </div>
    );
  }
  const data = (await res.json()) as { quotes?: InstantQuoteDto[] };
  const quote = (data.quotes ?? []).find((q) => q.id === quoteId);
  if (!quote) {
    return (
      <div
        className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        role="alert"
      >
        The instant quote response was incomplete. Refresh and try again.
      </div>
    );
  }
  const discount = quote.aiResult.discountPercent ?? 0;
  const low = quote.aiResult.priceLowDiscounted ?? quote.aiResult.priceLow;
  const high = quote.aiResult.priceHighDiscounted ?? quote.aiResult.priceHigh;
  const handoffResult = verifyInstantQuoteHandoffSelection(loadedHandoff, {
    instantQuoteId: quote.id,
  });
  const bookingHref = handoffResult.ok
    ? teamSurfaceHref("contacts", {
        query: {
          action: "book",
          contactId: handoffResult.handoff.contactId,
          propertyId: handoffResult.handoff.propertyId,
          instantQuoteId: handoffResult.handoff.instantQuoteId,
        },
      })
    : null;
  const fullQuoteHref = handoffResult.ok
    ? quoteWorkspaceHref("create", {
        query: {
          contactId: handoffResult.handoff.contactId,
          propertyId: handoffResult.handoff.propertyId,
          instantQuoteId: handoffResult.handoff.instantQuoteId,
        },
      })
    : null;

  return (
    <div className="space-y-3 rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-sm">
      <div className="flex items-center justify-between text-sm">
        <div className="font-semibold text-slate-900">{quote.contactName}</div>
        <div className="text-[11px] text-slate-500">
          {new Date(quote.createdAt).toLocaleString(undefined, {
            timeZone: TEAM_TIME_ZONE,
          })}
        </div>
      </div>
      <div className="text-xs text-slate-600">
        {quote.contactPhone} - {quote.zip} - timeframe: {quote.timeframe}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {quote.isMediaInformed ? (
          <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-semibold text-sky-800">
            Media-informed quote
          </span>
        ) : null}
        {quote.hasBookedAppointment ? (
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-800">
            Booked from quote
          </span>
        ) : null}
        {quote.tightenedAfterMoreMedia ? (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
            Tightened after more media
          </span>
        ) : null}
      </div>
      <div className="text-lg font-semibold text-primary-900">
        ${low} – ${high}{" "}
        {discount > 0 ? (
          <span className="ml-2 rounded-full bg-primary-100 px-2 py-0.5 text-[10px] font-bold text-primary-800">
            {Math.round(discount * 100)}% off
          </span>
        ) : null}
      </div>
      <div className="text-xs text-slate-600">
        {quote.aiResult.displayTierLabel} -{" "}
        {quote.aiResult.loadFractionEstimate.toFixed(2)} trailer -{" "}
        {quote.aiResult.reasonSummary}
      </div>
      {quote.aiResult.mediaAnalysis ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
          <div>
            Visible:{" "}
            {formatLabel(quote.aiResult.mediaAnalysis.visibleVolumeRange)} |
            Merged:{" "}
            {formatLabel(quote.aiResult.mediaAnalysis.mergedVolumeRange)} |
            Confidence: {formatLabel(quote.aiResult.mediaAnalysis.confidence)}
          </div>
          {(quote.aiResult.mediaAnalysis.visibleMattressCount ?? 0) > 0 ||
          (quote.aiResult.mediaAnalysis.visiblePaintCanCount ?? 0) > 0 ||
          (quote.aiResult.addOnTotal ?? 0) > 0 ? (
            <div className="mt-1">
              Add-ons included: mattresses{" "}
              {quote.aiResult.mediaAnalysis.visibleMattressCount ?? 0}, paint
              cans {quote.aiResult.mediaAnalysis.visiblePaintCanCount ?? 0}
              {(quote.aiResult.addOnTotal ?? 0) > 0
                ? `, total +$${quote.aiResult.addOnTotal}`
                : ""}
            </div>
          ) : null}
          {Array.isArray(quote.aiResult.mediaAnalysis.missingViews) &&
          quote.aiResult.mediaAnalysis.missingViews.length > 0 ? (
            <div className="mt-1">
              Missing views:{" "}
              {quote.aiResult.mediaAnalysis.missingViews.join(", ")}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="text-xs text-slate-600">
        Types: {quote.jobTypes.join(", ")} | Size: {quote.perceivedSize} |
        Photos: {quote.photoUrls.length}
      </div>
      {quote.notes ? (
        <div className="text-xs text-slate-600">Notes: {quote.notes}</div>
      ) : null}
      {quote.photoUrls.length ? (
        <div className="flex flex-wrap gap-2">
          {quote.photoUrls.map((url, idx) => (
            <a
              key={idx}
              href={url}
              target="_blank"
              rel="noreferrer"
              className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] text-slate-700"
            >
              Photo {idx + 1}
            </a>
          ))}
        </div>
      ) : null}
      {quote.aiResult.needsInPersonEstimate ? (
        <div className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
          Needs in-person review
        </div>
      ) : null}
      <div className="pt-2">
        <div className="flex flex-wrap items-center gap-2">
          {bookingHref && !quote.hasBookedAppointment ? (
            <Link
              href={bookingHref}
              className="inline-flex min-h-11 items-center rounded-md bg-primary-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-primary-700"
            >
              Book from this quote
            </Link>
          ) : null}
          {bookingHref && quote.hasBookedAppointment ? (
            <Link
              href={teamSurfaceHref("contacts", {
                query: {
                  contactId: handoffResult.ok
                    ? handoffResult.handoff.contactId
                    : undefined,
                },
              })}
              className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:border-primary-300 hover:text-primary-700"
            >
              Open booked customer
            </Link>
          ) : null}
          {fullQuoteHref ? (
            <Link
              href={fullQuoteHref}
              className="inline-flex min-h-11 items-center rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm font-semibold text-primary-800 shadow-sm hover:border-primary-300 hover:bg-primary-100"
            >
              Create full quote
            </Link>
          ) : null}
          {canDelete ? (
            <DeleteInstantQuoteForm
              instantQuoteId={quote.id}
              expectedVersion={quote.createdAt}
              idempotencyKey={`instant-quote-delete:${randomUUID()}`}
              action={deleteInstantQuoteAction}
            />
          ) : null}
        </div>
        {!handoffResult.ok ? (
          <p
            className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900"
            role="status"
          >
            Booking and full-quote handoff unavailable: {handoffResult.error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
