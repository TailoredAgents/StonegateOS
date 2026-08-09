import type { Route } from "next";
import { teamSurfaceHref } from "./surface-registry";

export const CONTACT_SUBVIEWS = [
  "overview",
  "properties",
  "activity",
  "jobs-quotes",
  "communications",
  "intelligence",
] as const;

export type ContactSubview = (typeof CONTACT_SUBVIEWS)[number];

export type ContactWorkspaceCapabilities = {
  callAttemptKeySeed: string;
  canWriteContact: boolean;
  canDeleteContact: boolean;
  canReadProperties: boolean;
  canWriteProperties: boolean;
  canDeleteProperties: boolean;
  canUpdatePipeline: boolean;
  canCall: boolean;
  canReadMessages: boolean;
  canMessage: boolean;
  canBook: boolean;
  canReadCalendar: boolean;
  canReadQuotes: boolean;
  canWriteQuotes: boolean;
  canReadPartners: boolean;
  canInvitePartners: boolean;
};

const CONTACT_SUBVIEW_SET = new Set<string>(CONTACT_SUBVIEWS);

export function normalizeContactSubview(
  value: string | null | undefined,
  options: { bookingRequested?: boolean } = {},
): ContactSubview {
  if (options.bookingRequested) return "jobs-quotes";
  const normalized = value?.trim().toLowerCase() ?? "";
  return CONTACT_SUBVIEW_SET.has(normalized)
    ? (normalized as ContactSubview)
    : "overview";
}

export type ContactWorkspaceLocation = {
  contactId: string;
  subview?: ContactSubview;
  search?: string;
  offset?: number;
  view?: "inbound" | "all" | "outbound";
  propertyId?: string;
  instantQuoteId?: string;
  action?: string;
};

/**
 * Creates a canonical, copyable Contacts detail URL. List filters and paging
 * stay in the URL so selecting a subview never loses the user's return point.
 */
export function contactWorkspaceHref(
  location: ContactWorkspaceLocation,
): Route {
  const query = new URLSearchParams();
  query.set("contactId", location.contactId.trim());
  query.set("subview", location.subview ?? "overview");

  const search = location.search?.trim();
  if (search) query.set("q", search);
  if (typeof location.offset === "number" && location.offset > 0) {
    query.set("offset", String(location.offset));
  }
  if (location.view && location.view !== "inbound") {
    query.set("view", location.view);
  }

  const propertyId = location.propertyId?.trim();
  if (propertyId) query.set("propertyId", propertyId);
  const instantQuoteId = location.instantQuoteId?.trim();
  if (instantQuoteId) query.set("instantQuoteId", instantQuoteId);
  const action = location.action?.trim();
  if (action) query.set("action", action);

  return teamSurfaceHref("contacts", { query });
}
