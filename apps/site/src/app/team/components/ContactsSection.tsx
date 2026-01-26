import React, { type ReactElement } from "react";
import { callAdminApi } from "../lib/api";
import type { ContactSummary, PaginationInfo } from "./contacts.types";
import { TEAM_EMPTY_STATE, teamButtonClass } from "./team-ui";
import { ContactsAddContactClient } from "./ContactsAddContactClient";
import { ContactsDetailsPaneClient } from "./ContactsDetailsPaneClient";
import { badgeClassForPipelineStage, labelForPipelineStage } from "./pipeline.stages";
import { TEAM_TIME_ZONE } from "../lib/timezone";

const PAGE_SIZE = 25;

type ContactsView = "inbound" | "all" | "outbound";

function normalizeView(args: { includeOutbound?: boolean; onlyOutbound?: boolean }): ContactsView {
  if (args.onlyOutbound) return "outbound";
  if (args.includeOutbound) return "all";
  return "inbound";
}

function buildHref(args: { search?: string; offset?: number; view?: ContactsView }): string {
  const query = new URLSearchParams();
  query.set("tab", "contacts");
  if (args.search && args.search.trim().length > 0) {
    query.set("q", args.search.trim());
  }
  if (typeof args.offset === "number" && args.offset > 0) {
    query.set("offset", String(args.offset));
  }
  if (args.view && args.view !== "inbound") {
    query.set("view", args.view);
  }
  return `/team?${query.toString()}`;
}

function buildSelectHref(args: {
  contactId: string;
  search?: string;
  offset?: number;
  view?: ContactsView;
}): string {
  const query = new URLSearchParams();
  query.set("tab", "contacts");
  query.set("contactId", args.contactId);
  if (args.search && args.search.trim().length > 0) {
    query.set("q", args.search.trim());
  }
  if (typeof args.offset === "number" && args.offset > 0) {
    query.set("offset", String(args.offset));
  }
  if (args.view && args.view !== "inbound") {
    query.set("view", args.view);
  }
  return `/team?${query.toString()}`;
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
    minute: "2-digit"
  }).format(parsed);
}

type ContactsSectionProps = {
  search?: string;
  offset?: number;
  contactId?: string;
  excludeOutbound?: boolean;
  onlyOutbound?: boolean;
};

export async function ContactsSection({
  search,
  offset,
  contactId,
  excludeOutbound,
  onlyOutbound
}: ContactsSectionProps): Promise<ReactElement> {
  const safeOffset = typeof offset === "number" && offset > 0 ? offset : 0;
  const shouldOnlyOutbound = onlyOutbound === true;
  const shouldExcludeOutbound = shouldOnlyOutbound ? false : excludeOutbound !== false;
  const includeOutbound = !shouldExcludeOutbound;
  const view = normalizeView({ includeOutbound, onlyOutbound: shouldOnlyOutbound });

  let teamMembers: Array<{ id: string; name: string }> = [];
  try {
    const membersRes = await callAdminApi("/api/admin/team/directory");
    if (membersRes.ok) {
      const payload = (await membersRes.json()) as { members?: Array<{ id: string; name: string; active?: boolean }> };
      teamMembers = (payload.members ?? []).filter((m) => m.active !== false).map((m) => ({ id: m.id, name: m.name }));
    }
  } catch {
    teamMembers = [];
  }

  const memberNameById = new Map(teamMembers.map((member) => [member.id, member.name]));

  const params = new URLSearchParams();
  params.set("limit", String(PAGE_SIZE));
  if (safeOffset > 0) params.set("offset", String(safeOffset));
  if (search && search.trim().length > 0) params.set("q", search.trim());
  if (shouldOnlyOutbound) {
    params.set("onlyOutbound", "1");
  } else if (shouldExcludeOutbound) {
    params.set("excludeOutbound", "1");
  }

  const response = await callAdminApi(`/api/admin/contacts?${params.toString()}`);
  if (!response.ok) {
    throw new Error("Failed to load contacts");
  }

  const payload = (await response.json()) as {
    contacts: ContactSummary[];
    pagination?: PaginationInfo;
  };

  const contacts = payload.contacts ?? [];
  const pagination: PaginationInfo = payload.pagination ?? {
    limit: PAGE_SIZE,
    offset: safeOffset,
    total: contacts.length,
    nextOffset: null
  };

  const hasPrev = pagination.offset > 0;
  const prevOffset = hasPrev ? Math.max(pagination.offset - pagination.limit, 0) : 0;
  const hasNext =
    typeof pagination.nextOffset === "number" && pagination.nextOffset > pagination.offset;
  const nextOffset = hasNext
    ? pagination.nextOffset ?? pagination.offset + contacts.length
    : pagination.offset;

  const selectedContactId = typeof contactId === "string" && contactId.trim().length > 0 ? contactId.trim() : null;
  let selectedContact: ContactSummary | null = null;
  if (selectedContactId) {
    selectedContact = contacts.find((contact) => contact.id === selectedContactId) ?? null;
    if (!selectedContact) {
      try {
        const selectedParams = new URLSearchParams();
        selectedParams.set("contactId", selectedContactId);
        selectedParams.set("limit", "1");
        const selectedRes = await callAdminApi(`/api/admin/contacts?${selectedParams.toString()}`);
        if (selectedRes.ok) {
          const selectedPayload = (await selectedRes.json()) as { contacts?: ContactSummary[] };
          selectedContact = (selectedPayload.contacts ?? [])[0] ?? null;
        }
      } catch {
        selectedContact = null;
      }
    }
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white/90 px-4 py-4 shadow-md shadow-slate-200/50 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">Contacts</h2>
          <p className="mt-1 text-sm text-slate-600">Search, assign, and keep follow-ups tight.</p>
        </div>
        <ContactsAddContactClient teamMembers={teamMembers} />
      </div>

      <form
        method="get"
        className="flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200 bg-white/90 px-4 py-3 text-sm text-slate-600 shadow-md shadow-slate-200/50"
      >
        <input type="hidden" name="tab" value="contacts" />
        <input type="hidden" name="offset" value="0" />
        <input
          name="q"
          defaultValue={search ?? ""}
          placeholder="Search name, email, phone, address"
          className="min-w-[240px] flex-1 rounded-xl border border-slate-200 bg-white px-4 py-2 text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
        />
        <div className="flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
          <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">View</span>
          <label className="inline-flex items-center gap-1">
            <input type="radio" name="view" value="inbound" defaultChecked={view === "inbound"} className="text-primary-600" />
            Inbound
          </label>
          <label className="inline-flex items-center gap-1">
            <input type="radio" name="view" value="all" defaultChecked={view === "all"} className="text-primary-600" />
            All
          </label>
          <label className="inline-flex items-center gap-1">
            <input type="radio" name="view" value="outbound" defaultChecked={view === "outbound"} className="text-primary-600" />
            Outbound
          </label>
        </div>
        <button type="submit" className={teamButtonClass("secondary")}>
          Search
        </button>
      </form>

      <div className="grid gap-4 lg:grid-cols-[minmax(520px,1fr)_420px]">
        <div className="space-y-3">
          {contacts.length === 0 ? (
            <p className={TEAM_EMPTY_STATE}>No contacts yet.</p>
          ) : (
            <>
              <div className="flex flex-col gap-2 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between">
                <span>{formatRange(pagination, contacts.length)}</span>
                <div className="flex gap-2">
                  <a
                    aria-disabled={!hasPrev}
                    className={`rounded-full border border-slate-200 px-4 py-1.5 ${
                      hasPrev ? "text-slate-600 hover:border-primary-300 hover:text-primary-700" : "pointer-events-none opacity-40"
                    }`}
                    href={hasPrev ? buildHref({ search, offset: prevOffset, view }) : "#"}
                  >
                    Previous
                  </a>
                  <a
                    aria-disabled={!hasNext}
                    className={`rounded-full border border-slate-200 px-4 py-1.5 ${
                      hasNext ? "text-slate-600 hover:border-primary-300 hover:text-primary-700" : "pointer-events-none opacity-40"
                    }`}
                    href={hasNext ? buildHref({ search, offset: nextOffset, view }) : "#"}
                  >
                    Next
                  </a>
                </div>
              </div>

              <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white/90 shadow-md shadow-slate-200/50">
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
                        const assignedLabel = contact.salespersonMemberId ? memberNameById.get(contact.salespersonMemberId) ?? "Assigned" : "Unassigned";
                        return (
                          <tr key={contact.id} className={isSelected ? "bg-primary-50/40" : "hover:bg-slate-50/70"}>
                            <td className="px-4 py-3">
                              <a href={buildSelectHref({ contactId: contact.id, search, offset: safeOffset, view })} className="font-semibold text-slate-900 hover:text-primary-700">
                                {contact.name}
                              </a>
                              {contact.source ? (
                                <div className="mt-1 text-xs text-slate-500">{contact.source}</div>
                              ) : null}
                            </td>
                            <td className="px-4 py-3 text-slate-700">{contact.phone ?? <span className="text-slate-400">—</span>}</td>
                            <td className="px-4 py-3 text-slate-700">{contact.email ?? <span className="text-slate-400">—</span>}</td>
                            <td className="px-4 py-3">
                              <span className={`inline-flex items-center rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-wide ${badgeClassForPipelineStage(contact.pipeline.stage)}`}>
                                {labelForPipelineStage(contact.pipeline.stage)}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-slate-700">{assignedLabel}</td>
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

        <div className="rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-md shadow-slate-200/50">
          {selectedContact ? (
            <ContactsDetailsPaneClient contact={selectedContact} teamMembers={teamMembers} />
          ) : (
            <div className="text-sm text-slate-600">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Details</div>
              <p className="mt-2">Select a contact on the left to see details, notes, and reminders.</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
