import { SubmitButton } from "@/components/SubmitButton";
import { callAdminApi } from "../lib/api";
import {
  importOutboundProspectsAction,
  bulkOutboundAction,
  draftOutboundFirstTouchAction,
  draftOutboundFollowupAction,
  openContactThreadAction,
  setOutboundDispositionAction,
  startContactCallAction
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

type OutboundAccountBrief = {
  summary: string;
  whyFit: string;
  serviceAngle: string;
  bestOpener: string;
  likelyObjections: string[];
  recommendedNextMove: string;
  partnerFit: "portal_first" | "managed_direct" | "hybrid" | "not_a_fit";
  fitScore: number;
  fitReason: string;
  provider: "openai" | "fallback";
  model: string | null;
  updatedAt: string;
};

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
  primaryTaskId: string;
  primaryContactId: string;
  taskIds: string[];
  contactCount: number;
  openTaskCount: number;
  account: {
    id: string;
    name: string;
    status: string | null;
    segment: string | null;
    portalFit?: string | null;
    fitScore?: number | null;
    lastTouchAt: string | null;
    nextTouchAt: string | null;
    brief?: OutboundAccountBrief | null;
  };
  contacts: Array<{
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    source?: string | null;
  }>;
  tasks: Array<{
    id: string;
    title: string | null;
    dueAt: string | null;
    attempt: number;
    lastDisposition: string | null;
    contactId: string;
    contactName: string;
  }>;
};

type OutboundQueueSummary = {
  dueNow: number;
  overdue: number;
  callbacksToday: number;
  notStarted?: number;
  scoreboard?: {
    accountsTouched: number;
    conversationsStarted: number;
    qualifiedPartners: number;
    activePartners: number;
    avgFitScore: number | null;
    partnerPathMix: {
      portalFirst: number;
      managedDirect: number;
      hybrid: number;
      notAFit: number;
    };
  };
};
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
  accountId?: string;
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

function formatPartnerFit(value: string | null | undefined): string {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "portal_first") return "Portal first";
  if (normalized === "managed_direct") return "Managed direct";
  if (normalized === "hybrid") return "Hybrid";
  if (normalized === "not_a_fit") return "Not a fit";
  return "Unclassified";
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
  setIf("out_account", merged.accountId);
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
  if (resolvedFilters.accountId?.trim()) apiQs.set("accountId", resolvedFilters.accountId.trim());
  if (resolvedFilters.taskId?.trim()) apiQs.set("taskId", resolvedFilters.taskId.trim());

  const queueRes = await callAdminApi(`/api/admin/outbound/queue?${apiQs.toString()}`);
  if (!queueRes.ok) {
    throw new Error("Failed to load outbound queue");
  }

  const queuePayload = (await queueRes.json()) as OutboundQueueResponse;
  const items = queuePayload.items ?? [];
  const resolvedMemberId = typeof queuePayload.memberId === "string" ? queuePayload.memberId : memberId ?? "";
  const memberLabel = resolvedMemberId ? members.find((m) => m.id === resolvedMemberId)?.name ?? null : null;

  const selectedAccountId = normalizeFilterValue(resolvedFilters.accountId);
  const selectedTaskId = normalizeFilterValue(resolvedFilters.taskId);
  const selected = selectedAccountId
    ? items.find((item) => item.id === selectedAccountId) ?? null
    : selectedTaskId
      ? items.find((item) => item.primaryTaskId === selectedTaskId || item.taskIds.includes(selectedTaskId)) ?? null
      : null;

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
                {pagination.total} accounts
              </span>
            ) : (
              <span>No open outbound accounts</span>
            )}
          </div>
        </div>
      </header>

      <div className={TEAM_CARD_PADDED}>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Accounts touched</div>
            <div className="mt-2 text-2xl font-semibold text-slate-900">
              {queuePayload.summary?.scoreboard?.accountsTouched ?? 0}
            </div>
            <div className="mt-1 text-xs text-slate-500">Accounts with at least one logged touch</div>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Conversations</div>
            <div className="mt-2 text-2xl font-semibold text-slate-900">
              {queuePayload.summary?.scoreboard?.conversationsStarted ?? 0}
            </div>
            <div className="mt-1 text-xs text-slate-500">Accounts past cold outreach into real dialogue</div>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Qualified partners</div>
            <div className="mt-2 text-2xl font-semibold text-slate-900">
              {queuePayload.summary?.scoreboard?.qualifiedPartners ?? 0}
            </div>
            <div className="mt-1 text-xs text-slate-500">Accounts that look strong enough to convert</div>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Active partners</div>
            <div className="mt-2 text-2xl font-semibold text-slate-900">
              {queuePayload.summary?.scoreboard?.activePartners ?? 0}
            </div>
            <div className="mt-1 text-xs text-slate-500">Converted accounts now in active partner status</div>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Avg fit score</div>
            <div className="mt-2 text-2xl font-semibold text-slate-900">
              {queuePayload.summary?.scoreboard?.avgFitScore ?? 0}
            </div>
            <div className="mt-1 text-xs text-slate-500">Average AI partner-fit score across the owned book</div>
          </div>
        </div>

        <div className="mt-3 rounded-2xl border border-slate-200 bg-white px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Partner path mix</div>
              <div className="mt-1 text-xs text-slate-500">How the current outbound book is leaning by recommended partner model</div>
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 font-semibold text-slate-700">
                Portal first {queuePayload.summary?.scoreboard?.partnerPathMix.portalFirst ?? 0}
              </span>
              <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 font-semibold text-slate-700">
                Managed direct {queuePayload.summary?.scoreboard?.partnerPathMix.managedDirect ?? 0}
              </span>
              <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 font-semibold text-slate-700">
                Hybrid {queuePayload.summary?.scoreboard?.partnerPathMix.hybrid ?? 0}
              </span>
              <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 font-semibold text-slate-700">
                Not a fit {queuePayload.summary?.scoreboard?.partnerPathMix.notAFit ?? 0}
              </span>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-base font-semibold text-slate-900">Queue</h3>
            <p className="mt-1 text-sm text-slate-600">Account-first outreach. Select a row to work one business relationship with linked contacts and tasks.</p>
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
          <div className={`${TEAM_EMPTY_STATE} mt-4`}>No outbound accounts match these filters.</div>
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
                  <select name="action" defaultValue="assign" className={TEAM_INPUT_COMPACT}>
                    <option value="assign">Assign</option>
                    <option value="assign_start">Assign + start cadence (override)</option>
                    <option value="start">Start cadence (override)</option>
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

            <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px] xl:grid-cols-[minmax(0,1fr)_360px]">
            <div className="rounded-2xl border border-slate-200 bg-white">
              <table className="w-full table-fixed text-left text-xs">
                <thead className="sticky top-0 z-10 bg-slate-50 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  <tr>
                    <th className="w-[52px] px-4 py-3">
                      <span className="sr-only">Select</span>
                    </th>
                    <th className="w-[130px] px-4 py-3">Due</th>
                    <th className="w-[76px] px-4 py-3">Attempt</th>
                    <th className="px-4 py-3">Prospect</th>
                    <th className="hidden w-[176px] px-4 py-3 text-right md:table-cell">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {items.map((item) => {
                    const dueBadge = formatDueBadge(item);
                    const primaryContact = item.contacts.find((contact) => contact.id === item.primaryContactId) ?? item.contacts[0] ?? null;
                    const isSelected = Boolean(selected?.id === item.id);
                    return (
                      <tr key={item.id} className={isSelected ? "bg-primary-50/40" : "hover:bg-slate-50"}>
                        <td className="px-4 py-3">
                          <input form="outboundBulkForm" type="checkbox" name="taskIds" value={item.taskIds.join(",")} />
                        </td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${dueBadge.tone}`}>
                            {dueBadge.label}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-slate-600">{item.attempt}</td>
                        <td className="min-w-0 overflow-hidden px-4 py-3">
                          <a href={buildOutboundHref({ memberId: resolvedMemberId, filters: resolvedFilters, patch: { accountId: item.id, taskId: item.primaryTaskId } })} className="block min-w-0">
                            <div className="truncate text-sm font-semibold text-slate-900">{item.account.name}</div>
                            <div className="mt-0.5 truncate text-[11px] text-slate-500">
                              {primaryContact?.name ?? "No primary contact"}
                              {item.account.segment ? ` / ${item.account.segment}` : item.campaign ? ` / ${item.campaign}` : ""}
                            </div>
                            <div className="mt-1 truncate text-[11px] text-slate-500">
                              <span>{primaryContact?.phone ?? "No phone"}</span>
                              <span className="mx-1">{"\u2022"}</span>
                              <span>{primaryContact?.email ?? "No email"}</span>
                              <span className="mx-1">{"\u2022"}</span>
                              <span>{item.lastDisposition ? item.lastDisposition.replace(/_/g, " ") : "No disposition yet"}</span>
                            </div>
                            <div className="mt-1 truncate text-[11px] text-slate-500">
                              {item.contactCount} contact{item.contactCount === 1 ? "" : "s"} / {item.openTaskCount} open task{item.openTaskCount === 1 ? "" : "s"} / Account {item.account.status?.replace(/_/g, " ") ?? "linked"}
                            </div>
                          </a>
                        </td>
                        <td className="relative hidden w-[176px] border-l border-slate-100 bg-white px-4 py-3 md:table-cell">
                          <div className="flex flex-col items-end gap-2">
                            <form action={startContactCallAction}>
                              <input type="hidden" name="contactId" value={primaryContact?.id ?? item.primaryContactId} />
                              <input type="hidden" name="taskId" value={item.primaryTaskId} />
                              <SubmitButton className={teamButtonClass("primary", "sm")} pendingLabel="Calling...">
                                Call
                              </SubmitButton>
                            </form>
                            <form action={openContactThreadAction}>
                              <input type="hidden" name="contactId" value={primaryContact?.id ?? item.primaryContactId} />
                              <input type="hidden" name="channel" value={primaryContact?.email ? "email" : "sms"} />
                              <SubmitButton className={teamButtonClass("secondary", "sm")} pendingLabel="Opening...">
                                Msg
                              </SubmitButton>
                            </form>
                            <form action={draftOutboundFirstTouchAction}>
                              <input type="hidden" name="contactId" value={primaryContact?.id ?? item.primaryContactId} />
                              <input type="hidden" name="taskId" value={item.primaryTaskId} />
                              <input type="hidden" name="channel" value={primaryContact?.email ? "email" : "sms"} />
                              <SubmitButton className={teamButtonClass("secondary", "sm")} pendingLabel="Drafting...">
                                Draft
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
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Selected account</p>
                    <p className="mt-1 text-base font-semibold text-slate-900">{selected.account.name}</p>
                    <p className="mt-1 text-xs text-slate-600">
                      {selected.contactCount} contact{selected.contactCount === 1 ? "" : "s"} / {selected.openTaskCount} open task{selected.openTaskCount === 1 ? "" : "s"}
                    </p>
                      <p className="mt-1 text-[11px] text-slate-500">
                        Account {selected.account.status?.replace(/_/g, " ") ?? "linked"}
                        {selected.account.segment ? ` / ${selected.account.segment}` : ""}
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
                      {selected.account.lastTouchAt ? (
                        <p className="mt-1 text-[11px] text-slate-500">Account last touch {formatTimestamp(selected.account.lastTouchAt)}</p>
                      ) : null}
                      {selected.account.nextTouchAt ? (
                        <p className="mt-1 text-[11px] text-slate-500">Account next touch {formatTimestamp(selected.account.nextTouchAt)}</p>
                      ) : null}
                      {selected.noteSnippet ? (
                        <p className="mt-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">{selected.noteSnippet}</p>
                      ) : null}
                    </div>

                  {selected.account.brief ? (
                    <div className="rounded-xl border border-primary-200 bg-primary-50/70 p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-primary-700">AI account brief</p>
                          <p className="mt-1 text-xs text-primary-900">
                            Prep for the next real outreach touch.
                          </p>
                        </div>
                        <div className="text-right text-[11px] text-primary-700">
                          <div>{selected.account.brief.provider === "openai" ? "AI brief" : "Fallback brief"}</div>
                          <div>{formatTimestamp(selected.account.brief.updatedAt) ?? selected.account.brief.updatedAt}</div>
                        </div>
                      </div>
                      <div className="mt-3 space-y-3 text-xs text-slate-700">
                        <div>
                          <p className="font-semibold text-slate-900">Who they are</p>
                          <p className="mt-1">{selected.account.brief.summary}</p>
                        </div>
                        <div>
                          <p className="font-semibold text-slate-900">Why they matter</p>
                          <p className="mt-1">{selected.account.brief.whyFit}</p>
                        </div>
                        <div>
                          <p className="font-semibold text-slate-900">Service angle</p>
                          <p className="mt-1">{selected.account.brief.serviceAngle}</p>
                        </div>
                        <div>
                          <p className="font-semibold text-slate-900">Best opener</p>
                          <p className="mt-1 rounded-lg border border-primary-200 bg-white px-3 py-2 text-slate-900">
                            {selected.account.brief.bestOpener}
                          </p>
                        </div>
                        {selected.account.brief.likelyObjections.length ? (
                          <div>
                            <p className="font-semibold text-slate-900">Likely objections</p>
                            <div className="mt-2 flex flex-wrap gap-2">
                              {selected.account.brief.likelyObjections.map((item) => (
                                <span
                                  key={item}
                                  className="rounded-full border border-primary-200 bg-white px-2.5 py-1 text-[11px] text-slate-700"
                                >
                                  {item}
                                </span>
                              ))}
                            </div>
                          </div>
                        ) : null}
                        <div>
                          <p className="font-semibold text-slate-900">Best next move</p>
                          <p className="mt-1">{selected.account.brief.recommendedNextMove}</p>
                        </div>
                        <div className="rounded-lg border border-primary-200 bg-white px-3 py-3">
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <p className="font-semibold text-slate-900">Suggested partner path</p>
                              <p className="mt-1 text-slate-700">{selected.account.brief.fitReason}</p>
                            </div>
                            <div className="text-right">
                              <div className="rounded-full border border-primary-200 bg-primary-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-primary-700">
                                {formatPartnerFit(selected.account.brief.partnerFit)}
                              </div>
                              <div className="mt-2 text-[11px] text-slate-500">
                                Fit score {selected.account.brief.fitScore}/100
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : null}

                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Linked contacts</p>
                    <div className="mt-2 space-y-3">
                      {selected.contacts.map((contact) => (
                        <div key={contact.id} className="rounded-xl border border-slate-200 bg-white p-3">
                          <div className="text-sm font-semibold text-slate-900">{contact.name}</div>
                          <div className="mt-1 text-xs text-slate-600">
                            {contact.phone ?? "No phone"} / {contact.email ?? "No email"}
                          </div>
                          <div className="mt-2 flex flex-wrap gap-2">
                            <form action={startContactCallAction}>
                              <input type="hidden" name="contactId" value={contact.id} />
                              <input type="hidden" name="taskId" value={selected.primaryTaskId} />
                              <SubmitButton className={teamButtonClass("primary", "sm")} pendingLabel="Calling...">
                                Call
                              </SubmitButton>
                            </form>
                            <form action={openContactThreadAction}>
                              <input type="hidden" name="contactId" value={contact.id} />
                              <input type="hidden" name="channel" value={contact.email ? "email" : "sms"} />
                              <SubmitButton className={teamButtonClass("secondary", "sm")} pendingLabel="Opening...">
                                Message
                              </SubmitButton>
                            </form>
                            <form action={draftOutboundFirstTouchAction}>
                              <input type="hidden" name="contactId" value={contact.id} />
                              <input type="hidden" name="taskId" value={selected.primaryTaskId} />
                              <input type="hidden" name="channel" value={contact.email ? "email" : "sms"} />
                              <SubmitButton className={teamButtonClass("secondary", "sm")} pendingLabel="Drafting...">
                                Draft outreach
                              </SubmitButton>
                            </form>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {!selected.dueAt ? (
                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Kickoff</p>
                      <p className="mt-1 text-xs text-slate-600">
                        Make your first outreach (call/email), then click a disposition below (Connected / No answer / Left VM / Emailed). That first
                        disposition starts the cadence and schedules the follow-ups.
                      </p>
                    </div>
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
                      { key: "partner", label: "Partner" },
                      { key: "no_answer", label: "No answer" },
                      { key: "left_voicemail", label: "Left VM" },
                      { key: "email_sent", label: "Emailed" },
                      { key: "not_interested", label: "Not interested" },
                      { key: "dnc", label: "DNC" }
                    ].map((d) => (
                      <form key={d.key} action={setOutboundDispositionAction}>
                        <input type="hidden" name="taskId" value={selected.primaryTaskId} />
                        <input type="hidden" name="disposition" value={d.key} />
                        <SubmitButton className={teamButtonClass("secondary", "sm")} pendingLabel="Saving...">
                          {d.label}
                        </SubmitButton>
                      </form>
                    ))}
                    </div>

                  <div className="rounded-xl border border-slate-200 bg-white p-3">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Detailed update</p>
                    <p className="mt-1 text-xs text-slate-600">
                      Save a quick recap from the call or reply so the next move is easier to pick up later.
                    </p>
                    <form action={setOutboundDispositionAction} className="mt-3 flex flex-col gap-2">
                      <input type="hidden" name="taskId" value={selected.primaryTaskId} />
                      <select
                        name="disposition"
                        defaultValue={selected.lastDisposition ?? ""}
                        className={TEAM_INPUT_COMPACT}
                      >
                        <option value="">Choose disposition</option>
                        <option value="connected">Connected</option>
                        <option value="partner">Partner</option>
                        <option value="no_answer">No answer</option>
                        <option value="left_voicemail">Left voicemail</option>
                        <option value="email_sent">Email sent</option>
                        <option value="callback_requested">Callback requested</option>
                        <option value="not_interested">Not interested</option>
                        <option value="dnc">DNC</option>
                      </select>
                      <textarea
                        name="recap"
                        className={`${TEAM_INPUT_COMPACT} min-h-[96px]`}
                        placeholder="Quick recap: who you spoke with, what they said, what they want next, anything useful for the next touch..."
                      />
                      <input
                        name="callbackAt"
                        type="datetime-local"
                        className={TEAM_INPUT_COMPACT}
                      />
                      <SubmitButton className={teamButtonClass("primary", "sm")} pendingLabel="Saving...">
                        Save detailed update
                      </SubmitButton>
                    </form>
                  </div>

                  <div className="rounded-xl border border-slate-200 bg-white p-3">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Draft follow-up</p>
                    <p className="mt-1 text-xs text-slate-600">
                      Use the latest outcome and your recap to prep the second touch for Inbox.
                    </p>
                    <form action={draftOutboundFollowupAction} className="mt-3 flex flex-col gap-2">
                      <input type="hidden" name="taskId" value={selected.primaryTaskId} />
                      <label className="flex flex-col gap-1 text-xs text-slate-600">
                        <span className="font-semibold uppercase tracking-[0.18em] text-slate-500">Contact</span>
                        <select
                          name="contactId"
                          defaultValue={selected.primaryContactId}
                          className={TEAM_INPUT_COMPACT}
                        >
                          {selected.contacts.map((contact) => (
                            <option key={contact.id} value={contact.id}>
                              {contact.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="flex flex-col gap-1 text-xs text-slate-600">
                        <span className="font-semibold uppercase tracking-[0.18em] text-slate-500">Channel</span>
                        <select
                          name="channel"
                          defaultValue={
                            (selected.contacts.find((contact) => contact.id === selected.primaryContactId) ??
                              selected.contacts[0])?.email
                              ? "email"
                              : "sms"
                          }
                          className={TEAM_INPUT_COMPACT}
                        >
                          <option value="sms">SMS</option>
                          <option value="email">Email</option>
                        </select>
                      </label>
                      <label className="flex flex-col gap-1 text-xs text-slate-600">
                        <span className="font-semibold uppercase tracking-[0.18em] text-slate-500">Latest outcome</span>
                        <select
                          name="disposition"
                          defaultValue={selected.lastDisposition ?? ""}
                          className={TEAM_INPUT_COMPACT}
                        >
                          <option value="">Use task context</option>
                          <option value="connected">Connected</option>
                          <option value="partner">Partner</option>
                          <option value="no_answer">No answer</option>
                          <option value="left_voicemail">Left voicemail</option>
                          <option value="email_sent">Email sent</option>
                          <option value="callback_requested">Callback requested</option>
                          <option value="not_interested">Not interested</option>
                        </select>
                      </label>
                      <textarea
                        name="recap"
                        className={`${TEAM_INPUT_COMPACT} min-h-[88px]`}
                        placeholder="Optional recap to steer the follow-up draft..."
                      />
                      <SubmitButton className={teamButtonClass("secondary", "sm")} pendingLabel="Drafting...">
                        Draft follow-up
                      </SubmitButton>
                    </form>
                  </div>

                  <div className="rounded-xl border border-slate-200 bg-white p-3">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Schedule callback</p>
                    <form action={setOutboundDispositionAction} className="mt-2 flex flex-col gap-2">
                      <input type="hidden" name="taskId" value={selected.primaryTaskId} />
                      <input type="hidden" name="disposition" value="callback_requested" />
                      <input name="callbackAt" type="datetime-local" className={TEAM_INPUT_COMPACT} />
                      <SubmitButton className={teamButtonClass("primary", "sm")} pendingLabel="Scheduling...">
                        Set callback
                      </SubmitButton>
                    </form>
                  </div>

                  <div className="rounded-xl border border-slate-200 bg-white p-3">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Open tasks</p>
                    <div className="mt-2 space-y-2">
                      {selected.tasks.map((task) => (
                        <div key={task.id} className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-700">
                          <div className="font-semibold text-slate-900">
                            {task.title ?? "Outbound task"} / {task.contactName}
                          </div>
                          <div className="mt-1 text-[11px] text-slate-500">
                            Attempt {task.attempt}
                            {task.lastDisposition ? ` / ${task.lastDisposition.replace(/_/g, " ")}` : ""}
                            {task.dueAt ? ` / Due ${formatTimestamp(task.dueAt)}` : " / Not started"}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="text-sm text-slate-600">
                  <p className="font-semibold text-slate-900">Select an account</p>
                  <p className="mt-1 text-xs text-slate-600">Click a row to work one company with linked contacts, open tasks, and quick outreach actions.</p>
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
                "company,contactName,title,email,phone,website,city,state,zip,notes\nAcme Property Mgmt,Jane Doe,Regional PM,jane@acme.com,555-555-5555,acmepm.com,Atlanta,GA,30303,prefers email"
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
