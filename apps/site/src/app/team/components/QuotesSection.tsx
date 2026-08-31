import React, { type ReactElement } from "react";
import { randomUUID } from "node:crypto";
import { requireCurrentTeamPrincipal } from "@/lib/team-principal";
import { hasTeamPermissionValue } from "@/lib/team-permissions";
import { QuotesList } from "../QuotesList";
import { callAdminApiAs } from "../lib/api";
import { quoteWorkspaceHref } from "../quotes-workspace";
import { teamButtonClass } from "./team-ui";
import {
  isQuoteV2SenderFeatureEnabled,
  isQuoteV2StaffFeatureEnabled,
} from "../lib/quote-v2-staff-feature";
import { normalizeQuoteV2ManagePage } from "../lib/quote-v2-management-model";
import {
  deleteQuoteAction,
  quoteDecisionAction,
  sendQuoteAction,
} from "../actions";

interface QuoteDto {
  id: string;
  status: string;
  services: string[];
  addOns: string[] | null;
  total: number;
  quoteNumber: string | null;
  displayStatus: string;
  jobDurationMinutes: number;
  clientScope: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
  expiresAt: string | null;
  viewedAt: string | null;
  lastViewedAt: string | null;
  viewCount: number;
  decisionAt: string | null;
  decisionNotes: string | null;
  refreshRequestedAt: string | null;
  acceptedAppointmentId: string | null;
  shareToken: string | null;
  pdfDownloadCount: number;
  lastPdfDownloadedAt: string | null;
  changeRequestCount: number;
  latestChangeRequest: {
    reason: string | null;
    message: string | null;
    createdAt: string;
  } | null;
  deliveryState: string | null;
  deliveryAttemptId: string | null;
  contact: { name: string; email: string | null; phone: string | null };
  property: {
    addressLine1: string;
    city: string;
    state: string;
    postalCode: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isQuoteDto(value: unknown): value is QuoteDto {
  if (!isRecord(value)) return false;
  const contact = value["contact"];
  const property = value["property"];
  const latestChangeRequest = value["latestChangeRequest"];
  return (
    typeof value["id"] === "string" &&
    typeof value["status"] === "string" &&
    Array.isArray(value["services"]) &&
    value["services"].every((entry) => typeof entry === "string") &&
    (value["addOns"] === null ||
      (Array.isArray(value["addOns"]) &&
        value["addOns"].every((entry) => typeof entry === "string"))) &&
    typeof value["total"] === "number" &&
    Number.isFinite(value["total"]) &&
    isNullableString(value["quoteNumber"]) &&
    typeof value["displayStatus"] === "string" &&
    typeof value["jobDurationMinutes"] === "number" &&
    isNullableString(value["clientScope"]) &&
    typeof value["revision"] === "number" &&
    typeof value["createdAt"] === "string" &&
    typeof value["updatedAt"] === "string" &&
    isNullableString(value["sentAt"]) &&
    isNullableString(value["expiresAt"]) &&
    isNullableString(value["viewedAt"]) &&
    isNullableString(value["lastViewedAt"]) &&
    typeof value["viewCount"] === "number" &&
    isNullableString(value["decisionAt"]) &&
    isNullableString(value["decisionNotes"]) &&
    isNullableString(value["refreshRequestedAt"]) &&
    isNullableString(value["acceptedAppointmentId"]) &&
    isNullableString(value["shareToken"]) &&
    typeof value["pdfDownloadCount"] === "number" &&
    isNullableString(value["lastPdfDownloadedAt"]) &&
    typeof value["changeRequestCount"] === "number" &&
    isNullableString(value["deliveryState"]) &&
    isNullableString(value["deliveryAttemptId"]) &&
    (latestChangeRequest === null ||
      (isRecord(latestChangeRequest) &&
        isNullableString(latestChangeRequest["reason"]) &&
        isNullableString(latestChangeRequest["message"]) &&
        typeof latestChangeRequest["createdAt"] === "string")) &&
    isRecord(contact) &&
    typeof contact["name"] === "string" &&
    isNullableString(contact["email"]) &&
    isNullableString(contact["phone"]) &&
    isRecord(property) &&
    typeof property["addressLine1"] === "string" &&
    typeof property["city"] === "string" &&
    typeof property["state"] === "string" &&
    typeof property["postalCode"] === "string"
  );
}

function QuotesUnavailable({ detail }: { detail: string }): ReactElement {
  return (
    <section
      className="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-900"
      role="alert"
      aria-labelledby="quotes-unavailable-title"
    >
      <h3 id="quotes-unavailable-title" className="font-semibold">
        Quote management is unavailable
      </h3>
      <p className="mt-1">{detail} This is not an empty quote list.</p>
      <a
        className={`mt-3 ${teamButtonClass("secondary", "sm")}`}
        href={quoteWorkspaceHref("manage", {
          query: { retry: "1" },
        })}
      >
        Retry quote management
      </a>
    </section>
  );
}

export async function QuotesSection(): Promise<ReactElement> {
  const principal = await requireCurrentTeamPrincipal();
  if (isQuoteV2StaffFeatureEnabled()) {
    let response: Response;
    try {
      response = await callAdminApiAs(
        principal,
        "/api/quotes?engine=v2&limit=40&sort=next_action",
      );
    } catch {
      return (
        <QuotesUnavailable detail="The versioned quote service could not be reached." />
      );
    }
    const page = normalizeQuoteV2ManagePage(
      await response.json().catch(() => null),
    );
    if (!response.ok || !page) {
      return (
        <QuotesUnavailable
          detail={
            response.ok
              ? "The versioned quote service returned an unreadable response."
              : `The versioned quote service returned HTTP ${response.status}.`
          }
        />
      );
    }
    const { default: QuoteV2ManageClient } = await import(
      "./QuoteV2ManageClient"
    );
    return (
      <QuoteV2ManageClient
        initialPage={page}
        canSend={
          isQuoteV2SenderFeatureEnabled() &&
          hasTeamPermissionValue(principal.permissions, "quotes.send")
        }
        canUpdate={hasTeamPermissionValue(
          principal.permissions,
          "quotes.update",
        )}
      />
    );
  }
  let res: Response;
  try {
    res = await callAdminApiAs(principal, "/api/quotes");
  } catch {
    return <QuotesUnavailable detail="The CRM service could not be reached." />;
  }
  if (!res.ok) {
    return (
      <QuotesUnavailable detail={`The CRM returned HTTP ${res.status}.`} />
    );
  }

  const payload = (await res.json().catch(() => null)) as {
    quotes?: unknown;
  } | null;
  if (
    !payload ||
    !Array.isArray(payload.quotes) ||
    !payload.quotes.every(isQuoteDto)
  ) {
    return (
      <QuotesUnavailable detail="The CRM returned an unreadable quote response." />
    );
  }

  return (
    <QuotesList
      initial={payload.quotes.map((quote) => ({
        ...quote,
        mutationKey: randomUUID(),
      }))}
      sendAction={sendQuoteAction}
      decisionAction={quoteDecisionAction}
      deleteAction={deleteQuoteAction}
      canSend={hasTeamPermissionValue(principal.permissions, "quotes.send")}
      canUpdate={hasTeamPermissionValue(principal.permissions, "quotes.update")}
      canDelete={hasTeamPermissionValue(principal.permissions, "quotes.delete")}
    />
  );
}
