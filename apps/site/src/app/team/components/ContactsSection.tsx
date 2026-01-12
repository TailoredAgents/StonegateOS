import React, { type ReactElement } from "react";
import { SubmitButton } from "@/components/SubmitButton";
import { callAdminApi } from "../lib/api";
import ContactsListClient from "./ContactsListClient";
import type { ContactSummary, PaginationInfo } from "./contacts.types";
import { PIPELINE_STAGES, labelForPipelineStage } from "./pipeline.stages";
import { TEAM_CARD_PADDED, TEAM_EMPTY_STATE, TEAM_INPUT, teamButtonClass } from "./team-ui";

const PAGE_SIZE = 25;

function buildHref(args: { search?: string; offset?: number }): string {
  const query = new URLSearchParams();
  query.set("tab", "contacts");
  if (args.search && args.search.trim().length > 0) {
    query.set("q", args.search.trim());
  }
  if (typeof args.offset === "number" && args.offset > 0) {
    query.set("offset", String(args.offset));
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

type ContactsSectionProps = {
  search?: string;
  offset?: number;
  contactId?: string;
};

export async function ContactsSection({ search, offset, contactId }: ContactsSectionProps): Promise<ReactElement> {
  const safeOffset = typeof offset === "number" && offset > 0 ? offset : 0;

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

  const params = new URLSearchParams();
  params.set("limit", String(PAGE_SIZE));
  if (safeOffset > 0) params.set("offset", String(safeOffset));
  if (search && search.trim().length > 0) params.set("q", search.trim());
  if (contactId) params.set("contactId", contactId);

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

  return (
    <section className="space-y-6">
      <div className={TEAM_CARD_PADDED}>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-xl font-semibold text-slate-900">Add a contact</h2>
            <p className="mt-1 text-sm text-slate-600">Capture new homeowners or manual leads. Address is optional and can be added later.</p>
          </div>
        </div>
        <form action="/api/team/contacts" method="post" className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm text-slate-600">
            <span>First name</span>
            <input
              name="firstName"
              required
              className={TEAM_INPUT}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-slate-600">
            <span>Last name</span>
            <input
              name="lastName"
              required
              className={TEAM_INPUT}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-slate-600">
            <span>Email</span>
            <input
              name="email"
              type="email"
              placeholder="optional"
              className={TEAM_INPUT}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-slate-600">
            <span>Phone</span>
            <input
              name="phone"
              type="tel"
              placeholder="optional"
              className={TEAM_INPUT}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-slate-600">
            <span>Assigned to</span>
            <select
              name="salespersonMemberId"
              defaultValue=""
              className={TEAM_INPUT}
            >
              <option value="">(Select)</option>
              {teamMembers.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm text-slate-600">
            <span>Pipeline stage</span>
            <select
              name="pipelineStage"
              defaultValue="new"
              className={TEAM_INPUT}
            >
              {PIPELINE_STAGES.map((stage) => (
                <option key={stage} value={stage}>
                  {labelForPipelineStage(stage)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm text-slate-600 sm:col-span-2">
            <span>Notes</span>
            <textarea
              name="pipelineNotes"
              rows={2}
              placeholder="Optional"
              className={TEAM_INPUT}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-slate-600 sm:col-span-2">
            <span>Street address</span>
            <input
              name="addressLine1"
              placeholder="Optional (can add later)"
              className={TEAM_INPUT}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-slate-600">
            <span>City</span>
            <input
              name="city"
              placeholder="Optional"
              className={TEAM_INPUT}
            />
          </label>
          <div className="grid grid-cols-2 gap-4">
            <label className="flex flex-col gap-1 text-sm text-slate-600">
              <span>State</span>
              <input
                name="state"
                maxLength={2}
                placeholder="Optional"
                className={`${TEAM_INPUT} uppercase`}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm text-slate-600">
              <span>Postal code</span>
              <input
                name="postalCode"
                placeholder="Optional"
                className={TEAM_INPUT}
              />
            </label>
          </div>
          <div className="sm:col-span-2">
            <SubmitButton className={teamButtonClass("primary")} pendingLabel="Saving...">
              Save contact
            </SubmitButton>
          </div>
        </form>
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
          placeholder="Search name, email, address"
          className="min-w-[220px] flex-1 rounded-xl border border-slate-200 bg-white px-4 py-2 text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
        />
        <button
          type="submit"
          className={teamButtonClass("secondary")}
        >
          Search
        </button>
      </form>

      {contacts.length === 0 ? (
        <p className={TEAM_EMPTY_STATE}>
          No contacts yet. Add your first lead above.
        </p>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-col gap-2 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between">
            <span>{formatRange(pagination, contacts.length)}</span>
            <div className="flex gap-2">
              <a
                aria-disabled={!hasPrev}
                className={`rounded-full border border-slate-200 px-4 py-1.5 ${
                  hasPrev ? "text-slate-600 hover:border-primary-300 hover:text-primary-700" : "pointer-events-none opacity-40"
                }`}
                href={hasPrev ? buildHref({ search, offset: prevOffset }) : "#"}
              >
                Previous
              </a>
              <a
                aria-disabled={!hasNext}
                className={`rounded-full border border-slate-200 px-4 py-1.5 ${
                  hasNext ? "text-slate-600 hover:border-primary-300 hover:text-primary-700" : "pointer-events-none opacity-40"
                }`}
                href={hasNext ? buildHref({ search, offset: nextOffset }) : "#"}
              >
                Next
              </a>
            </div>
          </div>

          <ContactsListClient contacts={contacts} teamMembers={teamMembers} />

          <div className="flex flex-col gap-2 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between">
            <span>{formatRange(pagination, contacts.length)}</span>
            <div className="flex gap-2">
              <a
                aria-disabled={!hasPrev}
                className={`rounded-full border border-slate-200 px-4 py-1.5 ${
                  hasPrev ? "text-slate-600 hover:border-primary-300 hover:text-primary-700" : "pointer-events-none opacity-40"
                }`}
                href={hasPrev ? buildHref({ search, offset: prevOffset }) : "#"}
              >
                Previous
              </a>
              <a
                aria-disabled={!hasNext}
                className={`rounded-full border border-slate-200 px-4 py-1.5 ${
                  hasNext ? "text-slate-600 hover:border-primary-300 hover:text-primary-700" : "pointer-events-none opacity-40"
                }`}
                href={hasNext ? buildHref({ search, offset: nextOffset }) : "#"}
              >
                Next
              </a>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
