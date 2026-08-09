import { randomUUID } from "node:crypto";
import React, { type ReactElement } from "react";
import {
  hasTeamPermission,
  requireCurrentTeamPrincipal,
} from "@/lib/team-principal";
import { callAdminApiAs } from "../lib/api";
import type { ContactSummary, PaginationInfo } from "./contacts.types";
import { TEAM_EMPTY_STATE, teamButtonClass } from "./team-ui";
import { ContactsAddContactClient } from "./ContactsAddContactClient";
import { ContactsDetailsPaneClient } from "./ContactsDetailsPaneClient";
import {
  badgeClassForPipelineStage,
  labelForPipelineStage,
} from "./pipeline.stages";
import { TEAM_TIME_ZONE } from "../lib/timezone";
import { formatStoredContactSource } from "../lib/booking-details";
import { teamSurfaceHref } from "../surface-registry";
import { ContactRecoveryRestoreForm } from "./ContactRecoveryRestoreForm";
import {
  loadInstantQuoteHandoff,
  verifyInstantQuoteHandoffSelection,
  type InstantQuoteHandoff,
} from "../lib/instant-quote-handoff";
import {
  contactWorkspaceHref,
  normalizeContactSubview,
  type ContactSubview,
  type ContactWorkspaceCapabilities,
} from "../contacts-workspace";

const PAGE_SIZE = 25;

type ContactsView = "inbound" | "all" | "outbound" | "recovery";
type ContactsLoadFailure =
  | "forbidden"
  | "not-found"
  | "server-error"
  | "malformed"
  | "unavailable";

function contactsLoadFailureCopy(failure: ContactsLoadFailure): {
  title: string;
  message: string;
} {
  switch (failure) {
    case "forbidden":
      return {
        title: "Contacts access denied",
        message:
          "Your current session does not have permission to read contacts.",
      };
    case "not-found":
      return {
        title: "Contacts service was not found",
        message:
          "The contacts endpoint is unavailable in this deployment. This is not an empty list.",
      };
    case "server-error":
      return {
        title: "Contacts service failed",
        message:
          "The server could not load contacts. Wait for service recovery, then retry.",
      };
    case "malformed":
      return {
        title: "Contacts response was incomplete",
        message:
          "The service returned data the CRM could not safely read. Nothing is being shown as empty.",
      };
    case "unavailable":
      return {
        title: "Contacts are temporarily unavailable",
        message:
          "The contacts service could not be reached. Check the connection and try again.",
      };
  }
}

function isContactSummary(value: unknown): value is ContactSummary {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["id"] === "string" &&
    typeof record["name"] === "string" &&
    typeof record["updatedAt"] === "string" &&
    Array.isArray(record["properties"]) &&
    Array.isArray(record["notes"]) &&
    Array.isArray(record["reminders"]) &&
    Boolean(record["pipeline"]) &&
    typeof record["pipeline"] === "object"
  );
}

function isPaginationInfo(value: unknown): value is PaginationInfo {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["limit"] === "number" &&
    record["limit"] > 0 &&
    typeof record["offset"] === "number" &&
    record["offset"] >= 0 &&
    typeof record["total"] === "number" &&
    record["total"] >= 0 &&
    (record["nextOffset"] === null ||
      (typeof record["nextOffset"] === "number" && record["nextOffset"] >= 0))
  );
}

function normalizeView(args: {
  includeOutbound?: boolean;
  onlyOutbound?: boolean;
  deletedOnly?: boolean;
}): ContactsView {
  if (args.deletedOnly) return "recovery";
  if (args.onlyOutbound) return "outbound";
  if (args.includeOutbound) return "all";
  return "inbound";
}

function buildHref(args: {
  search?: string;
  offset?: number;
  view?: ContactsView;
}): string {
  const query = new URLSearchParams();
  if (args.search && args.search.trim().length > 0) {
    query.set("q", args.search.trim());
  }
  if (typeof args.offset === "number" && args.offset > 0) {
    query.set("offset", String(args.offset));
  }
  if (args.view && args.view !== "inbound") {
    query.set("view", args.view);
  }
  return teamSurfaceHref("contacts", { query });
}

function buildSelectHref(args: {
  contactId: string;
  subview?: ContactSubview;
  search?: string;
  offset?: number;
  view?: ContactsView;
  propertyId?: string;
  instantQuoteId?: string;
  action?: string;
}): string {
  return contactWorkspaceHref({
    contactId: args.contactId,
    subview: args.subview,
    search: args.search,
    offset: args.offset,
    view: args.view === "recovery" ? "inbound" : args.view,
    propertyId: args.propertyId,
    instantQuoteId: args.instantQuoteId,
    action: args.action,
  });
}

function formatRange(pagination: PaginationInfo, count: number): string {
  if (pagination.total === 0) {
    return "Showing 0 of 0";
  }
  const start = pagination.offset + 1;
  const end = pagination.offset + count;
  return `Showing ${start}-${end} of ${pagination.total}`;
}

function formatLastActivity(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TEAM_TIME_ZONE,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(parsed);
}

function formatRecoveryDate(value: string | null): string {
  if (!value) return "Pending retention review";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Pending retention review";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TEAM_TIME_ZONE,
    dateStyle: "medium",
  }).format(parsed);
}

function PaginationControl({
  enabled,
  href,
  children,
}: {
  enabled: boolean;
  href: string;
  children: string;
}): ReactElement {
  const className = `${teamButtonClass("secondary", "sm")} min-h-11 ${
    enabled ? "" : "cursor-not-allowed opacity-40"
  }`;
  return enabled ? (
    <a className={className} href={href}>
      {children}
    </a>
  ) : (
    <span className={className} aria-disabled="true">
      {children}
    </span>
  );
}

type ContactsSectionProps = {
  search?: string;
  offset?: number;
  contactId?: string;
  subview?: string;
  propertyId?: string;
  instantQuoteId?: string;
  bookingRequested?: boolean;
  excludeOutbound?: boolean;
  onlyOutbound?: boolean;
  deletedOnly?: boolean;
};

export async function ContactsSection({
  search,
  offset,
  contactId,
  subview,
  propertyId,
  instantQuoteId,
  bookingRequested = false,
  excludeOutbound,
  onlyOutbound,
  deletedOnly,
}: ContactsSectionProps): Promise<ReactElement> {
  const principal = await requireCurrentTeamPrincipal();
  const selectedSubview = normalizeContactSubview(subview, {
    bookingRequested,
  });
  const canRestoreContacts = hasTeamPermission(principal, "contacts.restore");
  const capabilities: ContactWorkspaceCapabilities = {
    callAttemptKeySeed: randomUUID(),
    canWriteContact: hasTeamPermission(principal, "contacts.write"),
    canDeleteContact: hasTeamPermission(principal, "contacts.delete"),
    canReadProperties: hasTeamPermission(principal, "properties.read"),
    canWriteProperties: hasTeamPermission(principal, "properties.write"),
    canDeleteProperties: hasTeamPermission(principal, "properties.delete"),
    canUpdatePipeline: hasTeamPermission(principal, "pipeline.write"),
    canCall: hasTeamPermission(principal, "calls.place"),
    canReadMessages: hasTeamPermission(principal, "messages.read"),
    canMessage:
      hasTeamPermission(principal, "messages.read") &&
      hasTeamPermission(principal, "messages.send"),
    canBook: hasTeamPermission(principal, "bookings.manage"),
    canReadCalendar: hasTeamPermission(principal, "appointments.read"),
    canReadQuotes: hasTeamPermission(principal, "quotes.read"),
    canWriteQuotes: hasTeamPermission(principal, "quotes.write"),
    canReadPartners: hasTeamPermission(principal, "partners.read"),
    canInvitePartners: hasTeamPermission(principal, "partners.invite"),
  };
  let bookingHandoff: InstantQuoteHandoff | null = null;
  let bookingHandoffError: string | null = null;
  if (bookingRequested) {
    if (!instantQuoteId || !contactId || !propertyId) {
      bookingHandoffError =
        "This booking link is incomplete. Open the instant quote and try the handoff again.";
    } else {
      const result = verifyInstantQuoteHandoffSelection(
        await loadInstantQuoteHandoff(principal, instantQuoteId),
        { instantQuoteId, contactId, propertyId },
      );
      if (result.ok) {
        bookingHandoff = result.handoff;
      } else {
        bookingHandoffError = result.error;
      }
    }
  }
  if (deletedOnly && !canRestoreContacts) {
    return (
      <section
        className="rounded-2xl border border-amber-300 bg-amber-50 p-5 text-amber-950"
        aria-labelledby="contacts-recovery-denied-title"
      >
        <h2
          id="contacts-recovery-denied-title"
          className="text-lg font-semibold"
        >
          Recovery access required
        </h2>
        <p className="mt-2 text-sm">
          You can work with active contacts, but your current permissions do not
          allow viewing or restoring removed contacts.
        </p>
        <a
          href={teamSurfaceHref("contacts")}
          className={`${teamButtonClass("secondary", "sm")} mt-4 min-h-11`}
        >
          Return to active contacts
        </a>
      </section>
    );
  }
  const safeOffset = typeof offset === "number" && offset > 0 ? offset : 0;
  const shouldOnlyOutbound = onlyOutbound === true;
  const shouldExcludeOutbound = shouldOnlyOutbound
    ? false
    : excludeOutbound !== false;
  const includeOutbound = !shouldExcludeOutbound;
  const view = normalizeView({
    includeOutbound,
    onlyOutbound: shouldOnlyOutbound,
    deletedOnly,
  });

  let teamMembers: Array<{ id: string; name: string }> = [];
  let teamMembersUnavailable = false;
  if (!deletedOnly) {
    try {
      const membersRes = await callAdminApiAs(
        principal,
        "/api/admin/team/directory",
      );
      if (membersRes.ok) {
        const payload = (await membersRes.json()) as {
          members?: Array<{ id: string; name: string; active?: boolean }>;
        };
        teamMembers = (payload.members ?? [])
          .filter((m) => m.active !== false)
          .map((m) => ({ id: m.id, name: m.name }));
      } else {
        teamMembersUnavailable = true;
      }
    } catch {
      teamMembers = [];
      teamMembersUnavailable = true;
    }
  }

  const memberNameById = new Map(
    teamMembers.map((member) => [member.id, member.name]),
  );

  const params = new URLSearchParams();
  params.set("limit", String(PAGE_SIZE));
  if (safeOffset > 0) params.set("offset", String(safeOffset));
  if (search && search.trim().length > 0) params.set("q", search.trim());
  if (deletedOnly) {
    params.set("deleted", "only");
  } else if (shouldOnlyOutbound) {
    params.set("onlyOutbound", "1");
  } else if (shouldExcludeOutbound) {
    params.set("excludeOutbound", "1");
  }

  let payload: {
    contacts: ContactSummary[];
    pagination?: PaginationInfo;
  } | null = null;
  let contactsFailure: ContactsLoadFailure | null = null;
  try {
    const response = await callAdminApiAs(
      principal,
      `/api/admin/contacts?${params.toString()}`,
    );
    if (!response.ok) {
      contactsFailure =
        response.status === 403
          ? "forbidden"
          : response.status === 404
            ? "not-found"
            : response.status >= 500
              ? "server-error"
              : "unavailable";
    } else {
      const candidate = (await response.json()) as {
        contacts?: ContactSummary[];
        pagination?: PaginationInfo;
      };
      if (
        !Array.isArray(candidate.contacts) ||
        !candidate.contacts.every(isContactSummary) ||
        (candidate.pagination !== undefined &&
          !isPaginationInfo(candidate.pagination))
      ) {
        contactsFailure = "malformed";
      } else {
        payload = {
          contacts: candidate.contacts,
          pagination: candidate.pagination,
        };
      }
    }
  } catch {
    contactsFailure = "unavailable";
  }

  if (!payload) {
    const failureCopy = contactsLoadFailureCopy(
      contactsFailure ?? "unavailable",
    );
    return (
      <section
        className="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-950"
        role="alert"
        aria-labelledby="contacts-load-error-title"
      >
        <h2 id="contacts-load-error-title" className="text-lg font-semibold">
          {failureCopy.title}
        </h2>
        <p className="mt-2">{failureCopy.message}</p>
        <p className="mt-1">
          This is a load failure, not an empty contact list. No records have
          been changed.
        </p>
        <a
          href={buildHref({ search, offset: safeOffset, view })}
          className={`${teamButtonClass("secondary", "sm")} mt-4 min-h-11`}
        >
          Retry contacts
        </a>
      </section>
    );
  }

  const contacts = payload.contacts ?? [];
  const pagination: PaginationInfo = payload.pagination ?? {
    limit: PAGE_SIZE,
    offset: safeOffset,
    total: contacts.length,
    nextOffset: null,
  };

  const hasPrev = pagination.offset > 0;
  const prevOffset = hasPrev
    ? Math.max(pagination.offset - pagination.limit, 0)
    : 0;
  const hasNext =
    typeof pagination.nextOffset === "number" &&
    pagination.nextOffset > pagination.offset;
  const nextOffset = hasNext
    ? (pagination.nextOffset ?? pagination.offset + contacts.length)
    : pagination.offset;

  if (view === "recovery") {
    return (
      <section className="space-y-4" aria-labelledby="contacts-recovery-title">
        <div className="flex flex-col gap-3 rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-card)] px-4 py-4 shadow-[0_18px_36px_var(--team-card-shadow)] sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2
              id="contacts-recovery-title"
              className="text-xl font-semibold text-[color:var(--team-text)]"
            >
              Contact recovery
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-[color:var(--team-text-muted)]">
              Removed contacts remain linked to their history for at least 30
              days. Restoring a contact does not restart automation or release
              quarantined operations.
            </p>
          </div>
          <a
            href={teamSurfaceHref("contacts")}
            className={`${teamButtonClass("secondary", "sm")} min-h-11`}
          >
            Back to active contacts
          </a>
        </div>

        <form
          method="get"
          className="flex flex-col gap-3 rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-card)] p-4 sm:flex-row sm:items-end"
        >
          <input type="hidden" name="view" value="recovery" />
          <label className="flex flex-1 flex-col gap-1 text-sm font-medium text-[color:var(--team-text)]">
            Search recovery
            <input
              name="q"
              defaultValue={search ?? ""}
              placeholder="Name, email, phone, or address"
              className="rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] px-4 py-3 text-sm text-[color:var(--team-text)] shadow-sm placeholder:text-[color:var(--team-text-soft)] focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
            />
          </label>
          <button type="submit" className={teamButtonClass("secondary")}>
            Search
          </button>
        </form>

        {contacts.length === 0 ? (
          <p className={TEAM_EMPTY_STATE} role="status">
            No contacts are currently in recovery.
          </p>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[color:var(--team-text-muted)]">
              <span>{formatRange(pagination, contacts.length)}</span>
              <div className="flex gap-2">
                <PaginationControl
                  enabled={hasPrev}
                  href={buildHref({
                    search,
                    offset: prevOffset,
                    view: "recovery",
                  })}
                >
                  Previous
                </PaginationControl>
                <PaginationControl
                  enabled={hasNext}
                  href={buildHref({
                    search,
                    offset: nextOffset,
                    view: "recovery",
                  })}
                >
                  Next
                </PaginationControl>
              </div>
            </div>

            <ul className="grid gap-3 xl:grid-cols-2">
              {contacts.map((contact) => (
                <li
                  key={contact.id}
                  className="rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-card)] p-4 shadow-sm"
                >
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <p className="font-semibold text-[color:var(--team-text)]">
                        {contact.name || "Unnamed contact"}
                      </p>
                      <p className="mt-1 break-words text-sm text-[color:var(--team-text-muted)]">
                        {contact.phone ?? contact.email ?? "No contact details"}
                      </p>
                      <dl className="mt-3 grid gap-1 text-xs text-[color:var(--team-text-soft)]">
                        <div className="flex flex-wrap gap-1">
                          <dt className="font-semibold">Removed:</dt>
                          <dd>{formatLastActivity(contact.deletedAt)}</dd>
                        </div>
                        <div className="flex flex-wrap gap-1">
                          <dt className="font-semibold">Review after:</dt>
                          <dd>
                            {formatRecoveryDate(contact.recoverableUntil)}
                          </dd>
                        </div>
                      </dl>
                    </div>
                    <ContactRecoveryRestoreForm
                      contactId={contact.id}
                      contactName={contact.name || "this contact"}
                      expectedVersion={contact.updatedAt}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    );
  }

  const selectedContactId =
    typeof contactId === "string" && contactId.trim().length > 0
      ? contactId.trim()
      : null;
  let selectedContact: ContactSummary | null = null;
  let selectedContactErrorTitle = "Selected contact was not opened";
  let selectedContactError = "";
  if (selectedContactId) {
    selectedContact =
      contacts.find((contact) => contact.id === selectedContactId) ?? null;
    if (!selectedContact) {
      try {
        const selectedParams = new URLSearchParams();
        selectedParams.set("contactId", selectedContactId);
        selectedParams.set("limit", "1");
        const selectedRes = await callAdminApiAs(
          principal,
          `/api/admin/contacts?${selectedParams.toString()}`,
        );
        if (selectedRes.ok) {
          const selectedPayload = (await selectedRes.json()) as {
            contacts?: ContactSummary[];
          };
          if (
            Array.isArray(selectedPayload.contacts) &&
            selectedPayload.contacts.every(isContactSummary)
          ) {
            selectedContact = selectedPayload.contacts[0] ?? null;
            if (!selectedContact) {
              selectedContactErrorTitle = "Contact not found";
              selectedContactError = "That contact no longer exists.";
            }
          } else {
            selectedContactErrorTitle = "Contact response was incomplete";
            selectedContactError =
              "The service returned data the CRM could not safely read. This is not an empty contact.";
          }
        } else if (selectedRes.status === 403) {
          selectedContactErrorTitle = "Contact access denied";
          selectedContactError =
            "Your current session cannot read the selected contact.";
        } else if (selectedRes.status === 404) {
          selectedContactErrorTitle = "Contact not found";
          selectedContactError = "That contact no longer exists.";
        } else if (selectedRes.status >= 500) {
          selectedContactErrorTitle = "Contact service failed";
          selectedContactError =
            "The server could not load this contact. Wait for service recovery, then retry.";
        } else {
          selectedContactErrorTitle = "Contact is temporarily unavailable";
          selectedContactError =
            "The selected contact could not be loaded. Try again in a moment.";
        }
      } catch {
        selectedContact = null;
        selectedContactErrorTitle = "Contact could not be reached";
        selectedContactError =
          "Check the connection and retry. This is not an empty contact.";
      }
    }
  }
  const selectedContactForWorkspace = selectedContact
    ? {
        ...selectedContact,
        properties: capabilities.canReadProperties
          ? selectedContact.properties
          : [],
        stats: {
          appointments: capabilities.canReadCalendar
            ? selectedContact.stats.appointments
            : 0,
          quotes: capabilities.canReadQuotes ? selectedContact.stats.quotes : 0,
        },
      }
    : null;

  return (
    <section className="space-y-4 [&_button]:min-h-11 [&_input:not([type=hidden]):not([type=radio])]:min-h-11 [&_select]:min-h-11">
      <div className="flex flex-col gap-3 rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-card)] px-4 py-4 shadow-[0_18px_36px_var(--team-card-shadow)] sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold text-[color:var(--team-text)]">
            Contacts
          </h2>
          <p className="mt-1 text-sm text-[color:var(--team-text-muted)]">
            Search, assign, and keep follow-ups tight.
          </p>
        </div>
        {capabilities.canWriteContact ? (
          <ContactsAddContactClient teamMembers={teamMembers} />
        ) : null}
      </div>

      {bookingHandoffError ? (
        <div
          className="rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950"
          role="alert"
        >
          <p className="font-semibold">Instant-quote booking was not loaded</p>
          <p className="mt-1">{bookingHandoffError}</p>
        </div>
      ) : null}

      {teamMembersUnavailable ? (
        <div
          className="rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950"
          role="status"
        >
          Team assignments are temporarily unavailable. Contacts remain usable,
          but assignee names and assignment controls may be limited.
        </div>
      ) : null}

      {selectedContactError ? (
        <div
          className="rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950"
          role="alert"
        >
          <p className="font-semibold">{selectedContactErrorTitle}</p>
          <p className="mt-1">{selectedContactError}</p>
          <a
            className={`${teamButtonClass("secondary", "sm")} mt-3 min-h-11`}
            href={buildHref({ search, offset: safeOffset, view })}
          >
            Return to this contact list
          </a>
        </div>
      ) : null}

      <form
        method="get"
        className="flex flex-wrap items-center gap-3 rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-card)] px-4 py-3 text-sm text-[color:var(--team-text-muted)] shadow-[0_18px_36px_var(--team-card-shadow)]"
      >
        <input type="hidden" name="offset" value="0" />
        <input
          name="q"
          defaultValue={search ?? ""}
          placeholder="Search name, email, phone, address"
          className="w-full flex-1 rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] px-4 py-2 text-[color:var(--team-text)] shadow-sm placeholder:text-[color:var(--team-text-soft)] focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100 sm:min-w-[240px]"
        />
        <div className="flex w-full flex-wrap items-center gap-2 rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] px-3 py-2 text-xs text-[color:var(--team-text-muted)] sm:w-auto sm:rounded-full">
          <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--team-text-soft)]">
            View
          </span>
          <label className="inline-flex min-h-11 items-center gap-1 px-1">
            <input
              type="radio"
              name="view"
              value="inbound"
              defaultChecked={view === "inbound"}
              className="text-primary-600"
            />
            Inbound
          </label>
          <label className="inline-flex min-h-11 items-center gap-1 px-1">
            <input
              type="radio"
              name="view"
              value="all"
              defaultChecked={view === "all"}
              className="text-primary-600"
            />
            All
          </label>
          <label className="inline-flex min-h-11 items-center gap-1 px-1">
            <input
              type="radio"
              name="view"
              value="outbound"
              defaultChecked={view === "outbound"}
              className="text-primary-600"
            />
            Outbound
          </label>
          {canRestoreContacts ? (
            <label className="inline-flex min-h-11 items-center gap-1 px-1">
              <input
                type="radio"
                name="view"
                value="recovery"
                className="text-primary-600"
              />
              Recovery
            </label>
          ) : null}
        </div>
        <button
          type="submit"
          className={`${teamButtonClass("secondary")} w-full sm:w-auto`}
        >
          Search
        </button>
      </form>

      {selectedContactForWorkspace ? (
        <div className="lg:hidden">
          <div className="mb-3">
            <a
              href={buildHref({ search, offset: safeOffset, view })}
              className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-slate-600 hover:text-primary-700"
            >
              <span aria-hidden>←</span>
              Back to contacts
            </a>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-md shadow-slate-200/50">
            <ContactsDetailsPaneClient
              key={`${selectedContactForWorkspace.id}:${bookingHandoff?.instantQuoteId ?? "standard"}`}
              contact={selectedContactForWorkspace}
              actorId={principal.memberId}
              teamMembers={teamMembers}
              contactWorkspace
              subview={selectedSubview}
              workspaceLocation={{
                search,
                offset: safeOffset,
                view,
                propertyId,
                instantQuoteId,
                action: bookingRequested ? "book" : undefined,
              }}
              capabilities={capabilities}
              teamDirectoryAvailable={!teamMembersUnavailable}
              instantQuoteHandoff={bookingHandoff}
            />
          </div>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(520px,1fr)_420px]">
        <div
          className={`space-y-3 ${selectedContactForWorkspace ? "hidden lg:block" : ""}`}
        >
          {contacts.length === 0 ? (
            <p className={TEAM_EMPTY_STATE}>No contacts yet.</p>
          ) : (
            <>
              <div className="flex flex-col gap-2 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between">
                <span>{formatRange(pagination, contacts.length)}</span>
                <div className="flex gap-2">
                  <PaginationControl
                    enabled={hasPrev}
                    href={buildHref({ search, offset: prevOffset, view })}
                  >
                    Previous
                  </PaginationControl>
                  <PaginationControl
                    enabled={hasNext}
                    href={buildHref({ search, offset: nextOffset, view })}
                  >
                    Next
                  </PaginationControl>
                </div>
              </div>

              <div className="space-y-3 lg:hidden">
                {contacts.map((contact) => {
                  const isSelected = selectedContactId === contact.id;
                  const assignedLabel = contact.salespersonMemberId
                    ? (memberNameById.get(contact.salespersonMemberId) ??
                      "Assigned")
                    : "Unassigned";
                  const sourceLabel = formatStoredContactSource(
                    contact.source,
                    memberNameById,
                  );

                  return (
                    <a
                      key={contact.id}
                      href={buildSelectHref({
                        contactId: contact.id,
                        subview: selectedSubview,
                        search,
                        offset: safeOffset,
                        view,
                      })}
                      className={`block rounded-2xl border px-4 py-4 shadow-sm transition ${
                        isSelected
                          ? "border-primary-300 bg-primary-50/70"
                          : "border-slate-200 bg-white/90 hover:border-primary-200 hover:bg-white"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-base font-semibold text-slate-900">
                            {contact.name}
                          </div>
                          {sourceLabel ? (
                            <div className="mt-1 text-xs text-slate-500">
                              {sourceLabel}
                            </div>
                          ) : null}
                        </div>
                        <span
                          className={`inline-flex items-center rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-wide ${badgeClassForPipelineStage(contact.pipeline.stage)}`}
                        >
                          {labelForPipelineStage(contact.pipeline.stage)}
                        </span>
                      </div>
                      <div className="mt-3 grid gap-2 text-sm text-slate-700">
                        <div>{contact.phone ?? "No phone on file"}</div>
                        <div className="truncate">
                          {contact.email ?? "No email on file"}
                        </div>
                      </div>
                      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                        <span>Assigned: {assignedLabel}</span>
                        <span>
                          {formatLastActivity(contact.lastActivityAt)}
                        </span>
                      </div>
                    </a>
                  );
                })}
              </div>

              <div className="hidden overflow-hidden rounded-2xl border border-slate-200 bg-white/90 shadow-md shadow-slate-200/50 lg:block">
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                      <tr>
                        <th className="px-4 py-3 text-left">Name</th>
                        <th className="px-4 py-3 text-left">Phone</th>
                        <th className="px-4 py-3 text-left">Email</th>
                        <th className="px-4 py-3 text-left">Stage</th>
                        <th className="px-4 py-3 text-left">Assigned</th>
                        <th className="px-4 py-3 text-right">Last activity</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {contacts.map((contact) => {
                        const isSelected = selectedContactId === contact.id;
                        const assignedLabel = contact.salespersonMemberId
                          ? (memberNameById.get(contact.salespersonMemberId) ??
                            "Assigned")
                          : "Unassigned";
                        const sourceLabel = formatStoredContactSource(
                          contact.source,
                          memberNameById,
                        );
                        return (
                          <tr
                            key={contact.id}
                            className={
                              isSelected
                                ? "bg-primary-50/40"
                                : "hover:bg-slate-50/70"
                            }
                          >
                            <td className="px-4 py-3">
                              <a
                                href={buildSelectHref({
                                  contactId: contact.id,
                                  subview: selectedSubview,
                                  search,
                                  offset: safeOffset,
                                  view,
                                })}
                                className="font-semibold text-slate-900 hover:text-primary-700"
                              >
                                {contact.name}
                              </a>
                              {sourceLabel ? (
                                <div className="mt-1 text-xs text-slate-500">
                                  {sourceLabel}
                                </div>
                              ) : null}
                            </td>
                            <td className="px-4 py-3 text-slate-700">
                              {contact.phone ?? (
                                <span className="text-slate-400">—</span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-slate-700">
                              {contact.email ?? (
                                <span className="text-slate-400">—</span>
                              )}
                            </td>
                            <td className="px-4 py-3">
                              <span
                                className={`inline-flex items-center rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-wide ${badgeClassForPipelineStage(contact.pipeline.stage)}`}
                              >
                                {labelForPipelineStage(contact.pipeline.stage)}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-slate-700">
                              {assignedLabel}
                            </td>
                            <td className="px-4 py-3 text-right text-xs text-slate-500">
                              {formatLastActivity(contact.lastActivityAt)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>

        <div className="hidden rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-md shadow-slate-200/50 lg:block">
          {selectedContactForWorkspace ? (
            <ContactsDetailsPaneClient
              key={`${selectedContactForWorkspace.id}:${bookingHandoff?.instantQuoteId ?? "standard"}`}
              contact={selectedContactForWorkspace}
              actorId={principal.memberId}
              teamMembers={teamMembers}
              contactWorkspace
              subview={selectedSubview}
              workspaceLocation={{
                search,
                offset: safeOffset,
                view,
                propertyId,
                instantQuoteId,
                action: bookingRequested ? "book" : undefined,
              }}
              capabilities={capabilities}
              teamDirectoryAvailable={!teamMembersUnavailable}
              instantQuoteHandoff={bookingHandoff}
            />
          ) : (
            <div className="text-sm text-slate-600">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Details
              </div>
              <p className="mt-2">
                Select a contact on the left to see details, notes, and
                reminders.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
