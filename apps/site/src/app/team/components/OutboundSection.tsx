import { SubmitButton } from "@/components/SubmitButton";
import { callAdminApi } from "../lib/api";
import {
  importOutboundProspectsAction,
  bulkOutboundAction,
  openContactThreadAction,
  setOutboundDispositionAction,
  startContactCallAction,
  startOutboundCadenceAction
} from "../actions";
import {
  TEAM_CARD_PADDED,
  TEAM_EMPTY_STATE,
  TEAM_INPUT,
  TEAM_INPUT_COMPACT,
  TEAM_SECTION_SUBTITLE,
  TEAM_SECTION_TITLE,
  teamButtonClass
} from "./team-ui";
import { OutboundBulkSelectionControls } from "./OutboundBulkSelectionControls";

type TeamMember = { id: string; name: string; active?: boolean };

type OutboundQueueItem = {
  id: string;
  title: string | null;
  dueAt: string | null;
  overdue: boolean;
  minutesUntilDue: number | null;
  attempt: number;
  campaign: string | null;
  lastDisposition: string | null;
  company: string | null;
  noteSnippet: string | null;
  startedAt?: string | null;
  reminderAt?: string | null;
  contact: {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    source?: string | null;
  };
};

type OutboundQueueSummary = { dueNow: number; overdue: number; callbacksToday: number; notStarted?: number };
type OutboundQueueFacets = { campaigns: string[]; dispositions: string[]; attempts: string[] };

type OutboundQueueResponse = {
  ok: true;
  memberId: string;
  q: string | null;
  total: number;
  offset: number;
  limit: number;
  nextOffset: number | null;
  summary: OutboundQueueSummary;
  facets: OutboundQueueFacets;
  items: OutboundQueueItem[];
};

type OutboundFilters = {
  q?: string;
  campaign?: string;
  attempt?: string;
  due?: string;
  has?: string;
  disposition?: string;
  taskId?: string;
  offset?: string;
};

function normalizeFilterValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function formatDue(item: OutboundQueueItem): string {
  if (!item.dueAt) return "Not started";
  const due = new Date(item.dueAt);
  if (Number.isNaN(due.getTime())) return item.dueAt;
  return due.toLocaleString();
}

function formatTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}

function formatDueBadge(item: OutboundQueueItem): { label: string; tone: string } {
  if (!item.dueAt) return { label: "Not started", tone: "bg-slate-100 text-slate-600" };
  if (item.overdue) return { label: "Overdue", tone: "bg-rose-100 text-rose-700" };
  if (typeof item.minutesUntilDue === "number") {
    if (item.minutesUntilDue <= 0) return { label: "Due now", tone: "bg-amber-100 text-amber-700" };
    if (item.minutesUntilDue < 60) return { label: `Due in ${item.minutesUntilDue}m`, tone: "bg-amber-50 text-amber-700" };
  }
  return { label: "Scheduled", tone: "bg-slate-100 text-slate-600" };
}

function buildOutboundHref(args: { memberId?: string; filters: OutboundFilters; patch?: Partial<OutboundFilters> }): string {
  const qs = new URLSearchParams();
  qs.set("tab", "outbound");
  if (args.memberId) qs.set("memberId", args.memberId);

  const merged: OutboundFilters = { ...args.filters, ...(args.patch ?? {}) };
  const setIf = (key: string, value: string | undefined) => {
    if (!value) return;
    const trimmed = value.trim();
    if (!trimmed) return;
    qs.set(key, trimmed);
  };

  setIf("out_q", merged.q);
  setIf("out_campaign", merged.campaign);
  setIf("out_attempt", merged.attempt);
  setIf("out_due", merged.due);
  setIf("out_has", merged.has);
  setIf("out_disposition", merged.disposition);
  setIf("out_taskId", merged.taskId);
  setIf("out_offset", merged.offset);

  return `/team?${qs.toString()}`;
}

export async function OutboundSection({
  memberId,
  filters
}: {
  memberId?: string;
  filters?: OutboundFilters;
}): Promise<React.ReactElement> {
  const resolvedFilters: OutboundFilters = filters ?? {};

  let members: TeamMember[] = [];
  try {
    const membersRes = await callAdminApi("/api/admin/team/directory");
    if (membersRes.ok) {
      const payload = (await membersRes.json()) as { members?: TeamMember[] };
      members = (payload.members ?? []).filter((m) => m.active !== false);
    }
  } catch {
    members = [];
  }

  const apiQs = new URLSearchParams({ limit: "50" });
  if (memberId) apiQs.set("memberId", memberId);

  const apiFilterMap: Array<[string, string, string]> = [
    ["offset", "offset", normalizeFilterValue(resolvedFilters.offset)],
    ["q", "q", normalizeFilterValue(resolvedFilters.q)],
    ["campaign", "campaign", normalizeFilterValue(resolvedFilters.campaign)],
    ["attempt", "attempt", normalizeFilterValue(resolvedFilters.attempt)],
    ["due", "due", normalizeFilterValue(resolvedFilters.due)],
    ["has", "has", normalizeFilterValue(resolvedFilters.has)],
    ["disposition", "disposition", normalizeFilterValue(resolvedFilters.disposition)]
  ];
  for (const [, apiKey, value] of apiFilterMap) {
    if (value) apiQs.set(apiKey, value);
  }

  const queueRes = await callAdminApi(`/api/admin/outbound/queue?${apiQs.toString()}`);
  if (!queueRes.ok) {
    throw new Error("Failed to load outbound queue");
  }

  const queuePayload = (await queueRes.json()) as OutboundQueueResponse;
  const items = queuePayload.items ?? [];
  const resolvedMemberId = typeof queuePayload.memberId === "string" ? queuePayload.memberId : memberId ?? "";
  const memberLabel = resolvedMemberId ? members.find((m) => m.id === resolvedMemberId)?.name ?? null : null;

  const selectedTaskId = normalizeFilterValue(resolvedFilters.taskId);
  const selected = selectedTaskId ? items.find((item) => item.id === selectedTaskId) ?? null : null;

  const pagination = {
    total: queuePayload.total ?? 0,
    offset: queuePayload.offset ?? 0,
    limit: queuePayload.limit ?? 50,
    nextOffset: queuePayload.nextOffset ?? null
  };

  const hasPrev = pagination.offset > 0;
  const prevOffset = hasPrev ? Math.max(pagination.offset - pagination.limit, 0) : 0;
  const hasNext = typeof pagination.nextOffset === "number" && pagination.nextOffset > pagination.offset;
  const nextOffset = hasNext ? pagination.nextOffset : null;

  return (
    <section className="space-y-6">
      <header className={TEAM_CARD_PADDED}>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className={TEAM_SECTION_TITLE}>Outbound Prospects</h2>
            <p className={TEAM_SECTION_SUBTITLE}>
              Cold commercial outreach list. This queue is intentionally separate from inbound leads and Sales HQ.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-600">
              <span className="rounded-full bg-slate-100 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
                Outbound / Cold commercial / Property managers
              </span>
              {memberLabel ? (
                <span className="rounded-full bg-primary-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-primary-700">
                  Assigned to {memberLabel}
                </span>
              ) : null}
            </div>
          </div>
          <div className="text-right text-xs text-slate-500">
            {pagination.total > 0 ? (
              <span>
                Showing {Math.min(pagination.offset + 1, pagination.total)}-{Math.min(pagination.offset + items.length, pagination.total)} of{" "}
                {pagination.total}
              </span>
            ) : (
              <span>No open outbound tasks</span>
            )}
          </div>
        </div>
      </header>

      <div className={TEAM_CARD_PADDED}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-base font-semibold text-slate-900">Queue</h3>
            <p className="mt-1 text-sm text-slate-600">Call-first outreach. Select a row to see script + quick dispositions.</p>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <a
              className="rounded-full bg-slate-100 px-3 py-1 font-semibold text-slate-600 hover:bg-slate-200"
              href={buildOutboundHref({
                memberId: resolvedMemberId,
                filters: resolvedFilters,
                patch: { due: undefined, disposition: undefined, offset: "0" }
              })}
            >
              All ({pagination.total})
            </a>
            <a
              className="rounded-full bg-slate-50 px-3 py-1 font-semibold text-slate-700 hover:bg-slate-100"
              href={buildOutboundHref({ memberId: resolvedMemberId, filters: resolvedFilters, patch: { due: "not_started", offset: "0" } })}
            >
              Not started ({queuePayload.summary?.notStarted ?? 0})
            </a>
            <a
              className="rounded-full bg-amber-50 px-3 py-1 font-semibold text-amber-700 hover:bg-amber-100"
              href={buildOutboundHref({ memberId: resolvedMemberId, filters: resolvedFilters, patch: { due: "due_now", offset: "0" } })}
            >
              Due now ({queuePayload.summary?.dueNow ?? 0})
            </a>
            <a
              className="rounded-full bg-rose-50 px-3 py-1 font-semibold text-rose-700 hover:bg-rose-100"
              href={buildOutboundHref({ memberId: resolvedMemberId, filters: resolvedFilters, patch: { due: "overdue", offset: "0" } })}
            >
              Overdue ({queuePayload.summary?.overdue ?? 0})
            </a>
            <a
              className="rounded-full bg-primary-50 px-3 py-1 font-semibold text-primary-700 hover:bg-primary-100"
              href={buildOutboundHref({
                memberId: resolvedMemberId,
                filters: resolvedFilters,
                patch: { due: "today", disposition: "callback_requested", offset: "0" }
              })}
            >
              Callbacks today ({queuePayload.summary?.callbacksToday ?? 0})
            </a>
            <a className="rounded-full bg-white px-3 py-1 font-semibold text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50" href="#outbound-import">
              Import
            </a>
          </div>
        </div>

        <form method="get" action="/team" className="mt-4 grid gap-3 rounded-2xl border border-slate-200 bg-white p-4">
          <input type="hidden" name="tab" value="outbound" />

          <label className="flex flex-col gap-1 text-xs text-slate-600 sm:max-w-xs">
            <span className="font-semibold uppercase tracking-[0.18em] text-slate-500">Assigned to</span>
            <select name="memberId" defaultValue={resolvedMemberId} className={TEAM_INPUT_COMPACT}>
              <option value="">Default assignee</option>
              {members.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                </option>
              ))}
            </select>
          </label>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
            <label className="flex flex-col gap-1 text-xs text-slate-600 lg:col-span-2">
              <span className="font-semibold uppercase tracking-[0.18em] text-slate-500">Search</span>
              <input name="out_q" defaultValue={resolvedFilters.q ?? ""} className={TEAM_INPUT_COMPACT} placeholder="Company, name, phone, email..." />
            </label>

            <label className="flex flex-col gap-1 text-xs text-slate-600">
              <span className="font-semibold uppercase tracking-[0.18em] text-slate-500">Campaign</span>
              <select name="out_campaign" defaultValue={resolvedFilters.campaign ?? ""} className={TEAM_INPUT_COMPACT}>
                <option value="">All</option>
                {(queuePayload.facets?.campaigns ?? []).map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-xs text-slate-600">
              <span className="font-semibold uppercase tracking-[0.18em] text-slate-500">Attempt</span>
              <select name="out_attempt" defaultValue={resolvedFilters.attempt ?? ""} className={TEAM_INPUT_COMPACT}>
                <option value="">All</option>
                {(queuePayload.facets?.attempts ?? []).map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-xs text-slate-600">
              <span className="font-semibold uppercase tracking-[0.18em] text-slate-500">Due</span>
              <select name="out_due" defaultValue={resolvedFilters.due ?? ""} className={TEAM_INPUT_COMPACT}>
                <option value="">All</option>
                <option value="not_started">Not started</option>
                <option value="due_now">Due now</option>
                <option value="overdue">Overdue</option>
                <option value="today">Today</option>
              </select>
            </label>

            <label className="flex flex-col gap-1 text-xs text-slate-600">
              <span className="font-semibold uppercase tracking-[0.18em] text-slate-500">Has</span>
              <select name="out_has" defaultValue={resolvedFilters.has ?? ""} className={TEAM_INPUT_COMPACT}>
                <option value="">Any</option>
                <option value="phone">Phone</option>
                <option value="email">Email</option>
                <option value="both">Both</option>
              </select>
            </label>

            <label className="flex flex-col gap-1 text-xs text-slate-600 lg:col-span-2">
              <span className="font-semibold uppercase tracking-[0.18em] text-slate-500">Disposition</span>
              <select name="out_disposition" defaultValue={resolvedFilters.disposition ?? ""} className={TEAM_INPUT_COMPACT}>
                <option value="">All</option>
                {(queuePayload.facets?.dispositions ?? []).map((value) => (
                  <option key={value} value={value}>
                    {value.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </label>

            <div className="flex items-end gap-2">
              <SubmitButton className={teamButtonClass("primary", "sm")} pendingLabel="Filtering...">
                Filter
              </SubmitButton>
              <a className="text-xs font-semibold text-slate-500 hover:text-slate-700" href={buildOutboundHref({ memberId: resolvedMemberId, filters: {} })}>
                Reset
              </a>
            </div>
          </div>
        </form>

        {items.length === 0 ? (
          <div className={`${TEAM_EMPTY_STATE} mt-4`}>No outbound tasks match these filters.</div>
        ) : (
          <>
            <form
              id="outboundBulkForm"
              action={bulkOutboundAction}
              className="mt-4 flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 sm:flex-row sm:items-end sm:justify-between"
            >
              <div className="grid w-full gap-3 sm:grid-cols-3">
                <label className="flex flex-col gap-1 text-xs text-slate-600">
                  <span className="font-semibold uppercase tracking-[0.18em] text-slate-500">Bulk action</span>
                  <select name="action" defaultValue="assign_start" className={TEAM_INPUT_COMPACT}>
                    <option value="assign_start">Assign + start cadence</option>
                    <option value="assign">Assign only</option>
                    <option value="start">Start cadence only</option>
                    <option value="snooze">Snooze</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs text-slate-600">
                  <span className="font-semibold uppercase tracking-[0.18em] text-slate-500">Assign to</span>
                  <select name="assignedToMemberId" defaultValue={resolvedMemberId} className={TEAM_INPUT_COMPACT}>
                    <option value="">Default assignee</option>
                    {members.map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs text-slate-600">
                  <span className="font-semibold uppercase tracking-[0.18em] text-slate-500">Snooze until</span>
                  <select name="snoozePreset" defaultValue="tomorrow_9am" className={TEAM_INPUT_COMPACT}>
                    <option value="today_5pm">Later today (5pm ET)</option>
                    <option value="tomorrow_9am">Tomorrow (9am ET)</option>
                    <option value="plus_3d_9am">+3 days (9am ET)</option>
                    <option value="next_monday_9am">Next Monday (9am ET)</option>
                    <option value="plus_7d_9am">+7 days (9am ET)</option>
                  </select>
                  <span className="text-[11px] text-slate-500">Snooze skips rows that are not started yet.</span>
                </label>
                <OutboundBulkSelectionControls formId="outboundBulkForm" />
              </div>
              <SubmitButton className={teamButtonClass("primary", "sm")} pendingLabel="Applying...">
                Apply
              </SubmitButton>
            </form>

            <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
            <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
              <table className="min-w-full text-left text-xs">
                <thead className="sticky top-0 z-10 bg-slate-50 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  <tr>
                    <th className="px-4 py-3">
                      <span className="sr-only">Select</span>
                    </th>
                    <th className="px-4 py-3">Due</th>
                    <th className="px-4 py-3">Attempt</th>
                    <th className="px-4 py-3">Prospect</th>
                    <th className="hidden px-4 py-3 lg:table-cell">Phone</th>
                    <th className="hidden px-4 py-3 lg:table-cell">Email</th>
                    <th className="hidden px-4 py-3 md:table-cell">Last</th>
                    <th className="hidden px-4 py-3 text-right md:table-cell">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {items.map((item) => {
                    const dueBadge = formatDueBadge(item);
                    const isSelected = Boolean(selectedTaskId && item.id === selectedTaskId);
                    return (
                      <tr key={item.id} className={isSelected ? "bg-primary-50/40" : "hover:bg-slate-50"}>
                        <td className="px-4 py-3">
                          <input form="outboundBulkForm" type="checkbox" name="taskIds" value={item.id} />
                        </td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${dueBadge.tone}`}>
                            {dueBadge.label}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-slate-600">{item.attempt}</td>
                        <td className="px-4 py-3">
                          <a href={buildOutboundHref({ memberId: resolvedMemberId, filters: resolvedFilters, patch: { taskId: item.id } })} className="block max-w-[320px]">
                            <div className="truncate text-sm font-semibold text-slate-900">{item.company ? item.company : item.contact.name}</div>
                            <div className="mt-0.5 truncate text-[11px] text-slate-500">{item.company ? item.contact.name : item.campaign ? item.campaign : "Outbound"}</div>
                            <div className="mt-1 text-[11px] text-slate-500 lg:hidden">
                              {(item.contact.phone ?? "No phone") + " / " + (item.contact.email ?? "No email")}
                            </div>
                            <div className="mt-1 text-[11px] text-slate-500 md:hidden">
                              {item.lastDisposition ? item.lastDisposition.replace(/_/g, " ") : "No disposition yet"}
                            </div>
                          </a>
                        </td>
                        <td className="hidden px-4 py-3 text-slate-600 lg:table-cell">{item.contact.phone ?? "-"}</td>
                        <td className="hidden px-4 py-3 text-slate-600 lg:table-cell">{item.contact.email ?? "-"}</td>
                        <td className="hidden px-4 py-3 text-slate-600 md:table-cell">{item.lastDisposition ? item.lastDisposition.replace(/_/g, " ") : "-"}</td>
                        <td className="hidden px-4 py-3 md:table-cell">
                          <div className="flex flex-wrap justify-end gap-2">
                            <form action={startContactCallAction}>
                              <input type="hidden" name="contactId" value={item.contact.id} />
                              <SubmitButton className={teamButtonClass("primary", "sm")} pendingLabel="Calling...">
                                Call
                              </SubmitButton>
                            </form>
                            <form action={openContactThreadAction}>
                              <input type="hidden" name="contactId" value={item.contact.id} />
                              <input type="hidden" name="channel" value={item.contact.email ? "email" : "sms"} />
                              <SubmitButton className={teamButtonClass("secondary", "sm")} pendingLabel="Opening...">
                                Msg
                              </SubmitButton>
                            </form>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <aside className="rounded-2xl border border-slate-200 bg-white p-4">
              {selected ? (
                <div className="space-y-4">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Selected</p>
                    <p className="mt-1 text-base font-semibold text-slate-900">{selected.company ? selected.company : selected.contact.name}</p>
                    <p className="mt-1 text-xs text-slate-600">{selected.contact.name}</p>
                    <p className="mt-2 text-xs text-slate-600">
                      {selected.contact.phone ?? "No phone"} / {selected.contact.email ?? "No email"}
                    </p>
                      <p className="mt-1 text-[11px] text-slate-500">
                        Attempt {selected.attempt} / {selected.campaign ?? "outbound"} / Due {formatDue(selected)}
                      </p>
                      <p className="mt-1 text-[11px] text-slate-500">
                        {selected.dueAt ? "Cadence started" : "Cadence not started"}
                        {formatTimestamp(selected.startedAt) ? ` (${formatTimestamp(selected.startedAt)})` : ""}
                      </p>
                      {formatTimestamp(selected.reminderAt) ? (
                        <p className="mt-1 text-[11px] text-slate-500">Reminder scheduled {formatTimestamp(selected.reminderAt)}</p>
                      ) : null}
                      {selected.noteSnippet ? (
                        <p className="mt-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">{selected.noteSnippet}</p>
                      ) : null}
                    </div>

                  <div className="flex flex-wrap gap-2">
                    <form action={startContactCallAction}>
                      <input type="hidden" name="contactId" value={selected.contact.id} />
                      <SubmitButton className={teamButtonClass("primary", "sm")} pendingLabel="Calling...">
                        Call
                      </SubmitButton>
                    </form>
                    <form action={openContactThreadAction}>
                      <input type="hidden" name="contactId" value={selected.contact.id} />
                      <input type="hidden" name="channel" value={selected.contact.email ? "email" : "sms"} />
                      <SubmitButton className={teamButtonClass("secondary", "sm")} pendingLabel="Opening...">
                        Message
                      </SubmitButton>
                    </form>
                  </div>

                  {!selected.dueAt ? (
                    <form action={startOutboundCadenceAction} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                      <input type="hidden" name="taskId" value={selected.id} />
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Kickoff</p>
                      <p className="mt-1 text-xs text-slate-600">
                        Start the cadence when you&apos;re ready. After your first touch, follow-ups will schedule automatically.
                      </p>
                      <div className="mt-2">
                        <SubmitButton className={teamButtonClass("primary", "sm")} pendingLabel="Starting...">
                          Start cadence
                        </SubmitButton>
                      </div>
                    </form>
                  ) : null}

                  <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-700">Call script</p>
                    <p className="mt-1">
                      Hi, this is Stonegate Junk Removal in Georgia. We help property managers with unit cleanouts and bulk pickup. Do you handle any properties that need haul-off this month?
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {[
                      { key: "connected", label: "Connected" },
                      { key: "no_answer", label: "No answer" },
                      { key: "left_voicemail", label: "Left VM" },
                      { key: "email_sent", label: "Emailed" },
                      { key: "not_interested", label: "Not interested" },
                      { key: "dnc", label: "DNC" }
                    ].map((d) => (
                      <form key={d.key} action={setOutboundDispositionAction}>
                        <input type="hidden" name="taskId" value={selected.id} />
                        <input type="hidden" name="disposition" value={d.key} />
                        <SubmitButton className={teamButtonClass("secondary", "sm")} pendingLabel="Saving...">
                          {d.label}
                        </SubmitButton>
                      </form>
                    ))}
                  </div>

                  <div className="rounded-xl border border-slate-200 bg-white p-3">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Schedule callback</p>
                    <form action={setOutboundDispositionAction} className="mt-2 flex flex-col gap-2">
                      <input type="hidden" name="taskId" value={selected.id} />
                      <input type="hidden" name="disposition" value="callback_requested" />
                      <input name="callbackAt" type="datetime-local" className={TEAM_INPUT_COMPACT} />
                      <SubmitButton className={teamButtonClass("primary", "sm")} pendingLabel="Scheduling...">
                        Set callback
                      </SubmitButton>
                    </form>
                  </div>

                  <a href={`/team?tab=contacts&contactId=${encodeURIComponent(selected.contact.id)}`} className="text-xs font-semibold text-primary-700 hover:text-primary-900">
                    Open contact &gt;
                  </a>
                </div>
              ) : (
                <div className="text-sm text-slate-600">
                  <p className="font-semibold text-slate-900">Select a prospect</p>
                  <p className="mt-1 text-xs text-slate-600">Click a row to see company notes, a quick script, and one-click dispositions.</p>
                </div>
              )}
            </aside>
          </div>
          </>
        )}

        <div className="mt-4 flex items-center justify-between text-xs text-slate-600">
          <div className="flex items-center gap-2">
            {hasPrev ? (
              <a className={teamButtonClass("secondary", "sm")} href={buildOutboundHref({ memberId: resolvedMemberId, filters: resolvedFilters, patch: { offset: String(prevOffset) } })}>
                Prev
              </a>
            ) : (
              <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-2 font-semibold text-slate-400">Prev</span>
            )}
            {hasNext && nextOffset !== null ? (
              <a className={teamButtonClass("secondary", "sm")} href={buildOutboundHref({ memberId: resolvedMemberId, filters: resolvedFilters, patch: { offset: String(nextOffset) } })}>
                Next
              </a>
            ) : (
              <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-2 font-semibold text-slate-400">Next</span>
            )}
          </div>
          <span className="text-[11px] text-slate-500">Tip: outbound dispositions schedule the next touch automatically.</span>
        </div>
      </div>

      <details id="outbound-import" className={TEAM_CARD_PADDED}>
        <summary className="cursor-pointer select-none text-base font-semibold text-slate-900">
          Import prospects
          <span className="ml-2 text-xs font-normal text-slate-500">(CSV)</span>
        </summary>
        <p className="mt-2 text-sm text-slate-600">
          Paste a CSV (or upload one) and we&apos;ll create contacts + an outbound task. These will be labeled clearly as outbound.
        </p>
        <form action={importOutboundProspectsAction} className="mt-4 grid gap-4">
          <div className="grid gap-4 md:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm text-slate-600">
              <span>Campaign</span>
              <input name="campaign" className={TEAM_INPUT} defaultValue="property_management" />
            </label>
            <label className="flex flex-col gap-1 text-sm text-slate-600">
              <span>Assign to</span>
              <select name="assignedToMemberId" defaultValue={resolvedMemberId} className={TEAM_INPUT}>
                <option value="">Default assignee</option>
                {members.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="flex flex-col gap-1 text-sm text-slate-600">
            <span>CSV</span>
            <textarea
              name="csv"
              className={`${TEAM_INPUT} min-h-[160px] font-mono text-xs`}
              placeholder={
                "company,contactName,phone,email,city,state,zip,notes\nAcme Property Mgmt,Jane Doe,555-555-5555,jane@acme.com,Atlanta,GA,30303,prefers email"
              }
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-slate-600">
            <span>Or upload CSV</span>
            <input name="file" type="file" accept=".csv,text/csv,text/plain" className="text-sm text-slate-600" />
          </label>

          <div className="flex flex-wrap items-center gap-3">
            <SubmitButton className={teamButtonClass("primary")} pendingLabel="Importing...">
              Import outbound list
            </SubmitButton>
            <p className="text-xs text-slate-500">Required per row: email or phone. Max 2000 rows per import.</p>
          </div>
        </form>
      </details>
    </section>
  );
}
