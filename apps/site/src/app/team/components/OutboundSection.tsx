import { randomUUID } from "node:crypto";
import { SubmitButton } from "@/components/SubmitButton";
import {
  hasTeamPermission,
  requireCurrentTeamPrincipal,
} from "@/lib/team-principal";
import { callAdminApiAs } from "../lib/api";
import {
  buildOutboundHref,
  buildOutboundPartnersHref,
  type OutboundFilters,
} from "../outbound-navigation";
import {
  formatOutboundEasternTime,
  OUTBOUND_TIME_ZONE,
  parseOutboundQueueResponse,
  type OutboundHistoryEntry,
  type OutboundQueueItem,
  type OutboundQueueResponse,
  type TeamMember,
} from "../outbound-queue";
import {
  bulkOutboundAction,
  draftOutboundFirstTouchAction,
  draftOutboundFollowupAction,
  openContactThreadAction,
  setOutboundDispositionAction,
  startContactCallAction,
} from "../actions";
import {
  TEAM_CARD_PADDED,
  TEAM_EMPTY_STATE,
  TEAM_INPUT_COMPACT,
  TEAM_SECTION_SUBTITLE,
  TEAM_SECTION_TITLE,
  teamButtonClass,
} from "./team-ui";
import { OutboundBulkSelectionControls } from "./OutboundBulkSelectionControls";
import { OutboundImportClient } from "./OutboundImportClient";

function normalizeFilterValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function formatDue(item: OutboundQueueItem): string {
  if (!item.dueAt) return "Not started";
  return formatOutboundEasternTime(item.dueAt) ?? "Not started";
}

function formatTimestamp(value: string | null | undefined): string | null {
  return formatOutboundEasternTime(value);
}

function formatDueBadge(item: OutboundQueueItem): {
  label: string;
  tone: string;
} {
  if (!item.dueAt)
    return { label: "Not started", tone: "bg-slate-100 text-slate-600" };
  if (item.overdue)
    return { label: "Overdue", tone: "bg-rose-100 text-rose-700" };
  if (typeof item.minutesUntilDue === "number") {
    if (item.minutesUntilDue <= 0)
      return { label: "Due now", tone: "bg-amber-100 text-amber-700" };
    if (item.minutesUntilDue < 60)
      return {
        label: `Due in ${item.minutesUntilDue}m`,
        tone: "bg-amber-50 text-amber-700",
      };
  }
  return { label: "Scheduled", tone: "bg-slate-100 text-slate-600" };
}

function formatPartnerFit(value: string | null | undefined): string {
  const normalized =
    typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "portal_first") return "Portal first";
  if (normalized === "managed_direct") return "Managed direct";
  if (normalized === "hybrid") return "Hybrid";
  if (normalized === "not_a_fit") return "Not a fit";
  return "Unclassified";
}

function formatDisposition(value: string | null | undefined): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) return "No disposition yet";
  return normalized
    .split("_")
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function assigneeLabel(
  assignedToMemberId: string,
  members: readonly TeamMember[],
): string {
  return (
    members.find((member) => member.id === assignedToMemberId)?.name ??
    `Unknown member (${assignedToMemberId.slice(0, 8)})`
  );
}

function primaryContact(item: OutboundQueueItem) {
  return (
    item.contacts.find((contact) => contact.id === item.primaryContactId) ??
    item.contacts[0]!
  );
}

function formatHistoryKind(value: OutboundHistoryEntry["kind"]): {
  label: string;
  tone: string;
} {
  if (value === "import")
    return { label: "Import", tone: "bg-slate-100 text-slate-700" };
  if (value === "draft")
    return { label: "Suggestion", tone: "bg-primary-50 text-primary-700" };
  if (value === "disposition")
    return { label: "Disposition", tone: "bg-amber-50 text-amber-700" };
  if (value === "recap")
    return { label: "Recap", tone: "bg-emerald-50 text-emerald-700" };
  if (value === "partner")
    return { label: "Partner", tone: "bg-violet-50 text-violet-700" };
  if (value === "task")
    return { label: "Task", tone: "bg-slate-100 text-slate-700" };
  return { label: "Note", tone: "bg-slate-100 text-slate-700" };
}

export async function OutboundSection({
  memberId,
  filters,
  view,
}: {
  memberId?: string;
  filters?: OutboundFilters;
  view?: string;
}): Promise<React.ReactElement> {
  const principal = await requireCurrentTeamPrincipal();
  const canPlaceCalls = hasTeamPermission(principal, "calls.place");
  const canImport = hasTeamPermission(principal, "outbound.import");
  const resolvedFilters: OutboundFilters = filters ?? {};
  const currentView = view === "import" ? "import" : "queue";
  const queueHref = buildOutboundHref({
    memberId,
    view: "queue",
    filters: resolvedFilters,
  });
  const importHref = buildOutboundHref({
    memberId,
    view: "import",
    filters: resolvedFilters,
  });
  const partnersHref = buildOutboundPartnersHref({
    memberId,
    view: currentView,
    filters: resolvedFilters,
  });

  if (view === "import" && !canImport) {
    return (
      <section
        aria-labelledby="outbound-import-denied-title"
        className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-950"
      >
        <h2 id="outbound-import-denied-title" className="font-semibold">
          Import access is required
        </h2>
        <p className="mt-1">
          Your current access can view Outbound, but it cannot import contact,
          pipeline, partner, or task records.
        </p>
        <a
          href={queueHref}
          className={`${teamButtonClass("secondary")} mt-4 min-h-[44px]`}
        >
          Return to Outbound queue
        </a>
      </section>
    );
  }

  let members: TeamMember[] = [];
  let directoryUnavailable = false;
  try {
    const membersRes = await callAdminApiAs(
      principal,
      "/api/admin/team/directory",
    );
    if (membersRes.ok) {
      const payload = (await membersRes.json()) as { members?: TeamMember[] };
      members = (payload.members ?? []).filter((m) => m.active !== false);
    } else {
      directoryUnavailable = true;
    }
  } catch {
    members = [];
    directoryUnavailable = true;
  }

  if (view === "import") {
    return (
      <section className="space-y-6">
        <nav
          aria-label="Outbound views"
          className="flex flex-wrap gap-2 rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] p-2"
        >
          <a
            href={queueHref}
            className="inline-flex min-h-[44px] items-center rounded-xl px-4 py-2 text-sm font-semibold text-[color:var(--team-text-muted)] hover:bg-[color:var(--team-surface-muted)] hover:text-[color:var(--team-text)]"
          >
            Queue
          </a>
          <a
            href={importHref}
            aria-current="page"
            className="inline-flex min-h-[44px] items-center rounded-xl bg-primary-50 px-4 py-2 text-sm font-semibold text-primary-800"
          >
            Import
          </a>
          <a
            href={partnersHref}
            className="inline-flex min-h-[44px] items-center rounded-xl px-4 py-2 text-sm font-semibold text-[color:var(--team-text-muted)] hover:bg-[color:var(--team-surface-muted)] hover:text-[color:var(--team-text)]"
          >
            Partners
          </a>
        </nav>
        <header className={TEAM_CARD_PADDED}>
          <h2 className={TEAM_SECTION_TITLE}>Import outbound prospects</h2>
          <p className={TEAM_SECTION_SUBTITLE}>
            Preview normalization, duplicates, conflicts, assignment, and every
            excluded row before one transaction changes CRM data.
          </p>
        </header>
        <div className={TEAM_CARD_PADDED}>
          <OutboundImportClient
            members={members.map((member) => ({
              id: member.id,
              name: member.name,
            }))}
            defaultMemberId={memberId ?? ""}
            directoryUnavailable={directoryUnavailable}
          />
        </div>
      </section>
    );
  }

  const apiQs = new URLSearchParams({ limit: "50" });
  if (memberId) apiQs.set("memberId", memberId);

  const apiFilterMap: Array<[string, string, string]> = [
    ["cursor", "cursor", normalizeFilterValue(resolvedFilters.cursor)],
    ["direction", "direction", normalizeFilterValue(resolvedFilters.direction)],
    ["q", "q", normalizeFilterValue(resolvedFilters.q)],
    ["campaign", "campaign", normalizeFilterValue(resolvedFilters.campaign)],
    ["attempt", "attempt", normalizeFilterValue(resolvedFilters.attempt)],
    ["due", "due", normalizeFilterValue(resolvedFilters.due)],
    ["has", "has", normalizeFilterValue(resolvedFilters.has)],
    [
      "disposition",
      "disposition",
      normalizeFilterValue(resolvedFilters.disposition),
    ],
  ];
  for (const [, apiKey, value] of apiFilterMap) {
    if (value) apiQs.set(apiKey, value);
  }
  if (resolvedFilters.accountId?.trim())
    apiQs.set("accountId", resolvedFilters.accountId.trim());
  if (resolvedFilters.taskId?.trim())
    apiQs.set("taskId", resolvedFilters.taskId.trim());

  let queuePayload: OutboundQueueResponse | null = null;
  let queueError = "";
  try {
    const queueRes = await callAdminApiAs(
      principal,
      `/api/admin/outbound/queue?${apiQs.toString()}`,
    );
    if (!queueRes.ok) {
      queueError = `The outbound queue could not be loaded (HTTP ${queueRes.status}).`;
    } else {
      queuePayload = parseOutboundQueueResponse(
        await queueRes.json().catch(() => null),
      );
      if (!queuePayload) {
        queueError =
          "The outbound queue returned an incomplete safety response. DNC and assignment state could not be verified.";
      }
    }
  } catch {
    queueError = "The outbound queue could not be reached.";
  }

  if (!queuePayload) {
    return (
      <section className="space-y-6">
        <nav
          aria-label="Outbound views"
          className="flex flex-wrap gap-2 rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] p-2"
        >
          <a
            href={queueHref}
            aria-current="page"
            className="inline-flex min-h-[44px] items-center rounded-xl bg-primary-50 px-4 py-2 text-sm font-semibold text-primary-800"
          >
            Queue
          </a>
          {canImport ? (
            <a
              href={importHref}
              className="inline-flex min-h-[44px] items-center rounded-xl px-4 py-2 text-sm font-semibold text-[color:var(--team-text-muted)] hover:bg-[color:var(--team-surface-muted)] hover:text-[color:var(--team-text)]"
            >
              Import
            </a>
          ) : null}
          <a
            href={partnersHref}
            className="inline-flex min-h-[44px] items-center rounded-xl px-4 py-2 text-sm font-semibold text-[color:var(--team-text-muted)] hover:bg-[color:var(--team-surface-muted)] hover:text-[color:var(--team-text)]"
          >
            Partners
          </a>
        </nav>
        <div
          role="alert"
          className="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-900"
        >
          <h2 className="font-semibold">Outbound is temporarily unavailable</h2>
          <p className="mt-1">{queueError}</p>
          <p className="mt-1">
            No queue totals or records are being shown as zero.
          </p>
          <a
            className={`${teamButtonClass("secondary", "sm")} mt-4`}
            href={buildOutboundHref({
              memberId,
              filters: resolvedFilters,
            })}
          >
            Retry outbound
          </a>
        </div>
      </section>
    );
  }

  const items = queuePayload.items ?? [];
  const resolvedMemberId =
    typeof queuePayload.memberId === "string"
      ? queuePayload.memberId
      : (memberId ?? "");
  const memberLabel = resolvedMemberId
    ? (members.find((m) => m.id === resolvedMemberId)?.name ?? null)
    : null;
  const resolvedQueueHref = buildOutboundHref({
    memberId: resolvedMemberId,
    view: "queue",
    filters: resolvedFilters,
  });
  const resolvedImportHref = buildOutboundHref({
    memberId: resolvedMemberId,
    view: "import",
    filters: resolvedFilters,
  });
  const resolvedPartnersHref = buildOutboundPartnersHref({
    memberId: resolvedMemberId,
    view: "queue",
    filters: resolvedFilters,
  });

  const selectedAccountId = normalizeFilterValue(resolvedFilters.accountId);
  const selectedTaskId = normalizeFilterValue(resolvedFilters.taskId);
  const selected = selectedAccountId
    ? (items.find((item) => item.id === selectedAccountId) ?? null)
    : selectedTaskId
      ? (items.find(
          (item) =>
            item.primaryTaskId === selectedTaskId ||
            item.taskIds.includes(selectedTaskId),
        ) ?? null)
      : null;
  const selectedPrimary = selected ? primaryContact(selected) : null;
  const selectedOutreachBlocked = selectedPrimary?.doNotContact === true;

  const pagination = {
    total: queuePayload.total ?? 0,
    offset: queuePayload.offset ?? 0,
    limit: queuePayload.limit ?? 50,
    nextOffset: queuePayload.nextOffset ?? null,
    nextCursor: queuePayload.nextCursor,
    previousCursor: queuePayload.previousCursor,
  };

  const hasPrev = Boolean(pagination.previousCursor);
  const hasNext = Boolean(pagination.nextCursor);

  return (
    <section className="space-y-6">
      <nav
        aria-label="Outbound views"
        className="flex flex-wrap gap-2 rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] p-2"
      >
        <a
          href={resolvedQueueHref}
          aria-current="page"
          className="inline-flex min-h-[44px] items-center rounded-xl bg-primary-50 px-4 py-2 text-sm font-semibold text-primary-800"
        >
          Queue
        </a>
        {canImport ? (
          <a
            href={resolvedImportHref}
            className="inline-flex min-h-[44px] items-center rounded-xl px-4 py-2 text-sm font-semibold text-[color:var(--team-text-muted)] hover:bg-[color:var(--team-surface-muted)] hover:text-[color:var(--team-text)]"
          >
            Import
          </a>
        ) : null}
        <a
          href={resolvedPartnersHref}
          className="inline-flex min-h-[44px] items-center rounded-xl px-4 py-2 text-sm font-semibold text-[color:var(--team-text-muted)] hover:bg-[color:var(--team-surface-muted)] hover:text-[color:var(--team-text)]"
        >
          Partners
        </a>
      </nav>
      <header className={TEAM_CARD_PADDED}>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className={TEAM_SECTION_TITLE}>Outbound Prospects</h2>
            <p className={TEAM_SECTION_SUBTITLE}>
              Cold commercial outreach list. This queue is intentionally
              separate from inbound leads and Sales HQ.
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
                Showing {Math.min(pagination.offset + 1, pagination.total)}-
                {Math.min(pagination.offset + items.length, pagination.total)}{" "}
                of {pagination.total}
                accounts
              </span>
            ) : (
              <span>No open outbound accounts</span>
            )}
            <div className="mt-1">
              Snapshot {formatOutboundEasternTime(queuePayload.snapshotAt)}
            </div>
          </div>
        </div>
      </header>

      {directoryUnavailable ? (
        <div
          role="status"
          className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
        >
          Team assignments are temporarily unavailable. The queue is still
          current, but assignment names and assignment controls may be limited.
        </div>
      ) : null}

      <div className={TEAM_CARD_PADDED}>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              Accounts touched
            </div>
            <div className="mt-2 text-2xl font-semibold text-slate-900">
              {queuePayload.summary?.scoreboard?.accountsTouched ?? 0}
            </div>
            <div className="mt-1 text-xs text-slate-500">
              Accounts with at least one logged touch
            </div>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              Conversations
            </div>
            <div className="mt-2 text-2xl font-semibold text-slate-900">
              {queuePayload.summary?.scoreboard?.conversationsStarted ?? 0}
            </div>
            <div className="mt-1 text-xs text-slate-500">
              Accounts past cold outreach into real dialogue
            </div>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              Qualified partners
            </div>
            <div className="mt-2 text-2xl font-semibold text-slate-900">
              {queuePayload.summary?.scoreboard?.qualifiedPartners ?? 0}
            </div>
            <div className="mt-1 text-xs text-slate-500">
              Accounts that look strong enough to convert
            </div>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              Active partners
            </div>
            <div className="mt-2 text-2xl font-semibold text-slate-900">
              {queuePayload.summary?.scoreboard?.activePartners ?? 0}
            </div>
            <div className="mt-1 text-xs text-slate-500">
              Converted accounts now in active partner status
            </div>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              Avg fit score
            </div>
            <div className="mt-2 text-2xl font-semibold text-slate-900">
              {queuePayload.summary?.scoreboard?.avgFitScore ?? 0}
            </div>
            <div className="mt-1 text-xs text-slate-500">
              Average AI partner-fit score across the owned book
            </div>
          </div>
        </div>

        <div className="mt-3 rounded-2xl border border-slate-200 bg-white px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                Partner path mix
              </div>
              <div className="mt-1 text-xs text-slate-500">
                How the current outbound book is leaning by recommended partner
                model
              </div>
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 font-semibold text-slate-700">
                Portal first{" "}
                {queuePayload.summary?.scoreboard?.partnerPathMix.portalFirst ??
                  0}
              </span>
              <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 font-semibold text-slate-700">
                Managed direct{" "}
                {queuePayload.summary?.scoreboard?.partnerPathMix
                  .managedDirect ?? 0}
              </span>
              <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 font-semibold text-slate-700">
                Hybrid{" "}
                {queuePayload.summary?.scoreboard?.partnerPathMix.hybrid ?? 0}
              </span>
              <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 font-semibold text-slate-700">
                Not a fit{" "}
                {queuePayload.summary?.scoreboard?.partnerPathMix.notAFit ?? 0}
              </span>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-base font-semibold text-slate-900">Queue</h3>
            <p className="mt-1 text-sm text-slate-600">
              Account-first outreach. Select a row to work one business
              relationship with linked contacts and tasks.
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <a
              className="inline-flex min-h-11 items-center rounded-full bg-slate-100 px-3 py-2 font-semibold text-slate-600 hover:bg-slate-200"
              href={buildOutboundHref({
                memberId: resolvedMemberId,
                filters: resolvedFilters,
                patch: {
                  due: "",
                  disposition: "",
                  cursor: "",
                  direction: "",
                },
              })}
            >
              All ({pagination.total})
            </a>
            <a
              className="inline-flex min-h-11 items-center rounded-full bg-slate-50 px-3 py-2 font-semibold text-slate-700 hover:bg-slate-100"
              href={buildOutboundHref({
                memberId: resolvedMemberId,
                filters: resolvedFilters,
                patch: {
                  due: "not_started",
                  cursor: "",
                  direction: "",
                },
              })}
            >
              Not started ({queuePayload.summary?.notStarted ?? 0})
            </a>
            <a
              className="inline-flex min-h-11 items-center rounded-full bg-amber-50 px-3 py-2 font-semibold text-amber-700 hover:bg-amber-100"
              href={buildOutboundHref({
                memberId: resolvedMemberId,
                filters: resolvedFilters,
                patch: {
                  due: "due_now",
                  cursor: "",
                  direction: "",
                },
              })}
            >
              Due now ({queuePayload.summary?.dueNow ?? 0})
            </a>
            <a
              className="inline-flex min-h-11 items-center rounded-full bg-rose-50 px-3 py-2 font-semibold text-rose-700 hover:bg-rose-100"
              href={buildOutboundHref({
                memberId: resolvedMemberId,
                filters: resolvedFilters,
                patch: {
                  due: "overdue",
                  cursor: "",
                  direction: "",
                },
              })}
            >
              Overdue ({queuePayload.summary?.overdue ?? 0})
            </a>
            <a
              className="inline-flex min-h-11 items-center rounded-full bg-primary-50 px-3 py-2 font-semibold text-primary-700 hover:bg-primary-100"
              href={buildOutboundHref({
                memberId: resolvedMemberId,
                filters: resolvedFilters,
                patch: {
                  due: "today",
                  disposition: "callback_requested",
                  cursor: "",
                  direction: "",
                },
              })}
            >
              Callbacks today ({queuePayload.summary?.callbacksToday ?? 0})
            </a>
            {canImport ? (
              <a
                className="inline-flex min-h-11 items-center rounded-full bg-white px-3 py-2 font-semibold text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"
                href={resolvedImportHref}
              >
                Import
              </a>
            ) : null}
          </div>
        </div>

        <form
          method="get"
          action="/team/sales/outbound"
          className="mt-4 grid gap-3 rounded-2xl border border-slate-200 bg-white p-4"
        >
          <input
            type="hidden"
            name="out_account"
            value={resolvedFilters.accountId ?? ""}
          />
          <input
            type="hidden"
            name="out_taskId"
            value={resolvedFilters.taskId ?? ""}
          />

          <label className="flex w-full flex-col gap-1 text-xs text-slate-600 sm:max-w-xs">
            <span className="font-semibold uppercase tracking-[0.18em] text-slate-500">
              Assigned to
            </span>
            <select
              name="memberId"
              defaultValue={resolvedMemberId}
              className={TEAM_INPUT_COMPACT}
            >
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
              <span className="font-semibold uppercase tracking-[0.18em] text-slate-500">
                Search
              </span>
              <input
                name="out_q"
                defaultValue={resolvedFilters.q ?? ""}
                className={TEAM_INPUT_COMPACT}
                placeholder="Company, name, phone, email..."
              />
            </label>

            <label className="flex flex-col gap-1 text-xs text-slate-600">
              <span className="font-semibold uppercase tracking-[0.18em] text-slate-500">
                Campaign
              </span>
              <select
                name="out_campaign"
                defaultValue={resolvedFilters.campaign ?? ""}
                className={TEAM_INPUT_COMPACT}
              >
                <option value="">All</option>
                {(queuePayload.facets?.campaigns ?? []).map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-xs text-slate-600">
              <span className="font-semibold uppercase tracking-[0.18em] text-slate-500">
                Attempt
              </span>
              <select
                name="out_attempt"
                defaultValue={resolvedFilters.attempt ?? ""}
                className={TEAM_INPUT_COMPACT}
              >
                <option value="">All</option>
                {(queuePayload.facets?.attempts ?? []).map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-xs text-slate-600">
              <span className="font-semibold uppercase tracking-[0.18em] text-slate-500">
                Due
              </span>
              <select
                name="out_due"
                defaultValue={resolvedFilters.due ?? ""}
                className={TEAM_INPUT_COMPACT}
              >
                <option value="">All</option>
                <option value="not_started">Not started</option>
                <option value="due_now">Due now</option>
                <option value="overdue">Overdue</option>
                <option value="today">Today</option>
              </select>
            </label>

            <label className="flex flex-col gap-1 text-xs text-slate-600">
              <span className="font-semibold uppercase tracking-[0.18em] text-slate-500">
                Has
              </span>
              <select
                name="out_has"
                defaultValue={resolvedFilters.has ?? ""}
                className={TEAM_INPUT_COMPACT}
              >
                <option value="">Any</option>
                <option value="phone">Phone</option>
                <option value="email">Email</option>
                <option value="both">Both</option>
              </select>
            </label>

            <label className="flex flex-col gap-1 text-xs text-slate-600 lg:col-span-2">
              <span className="font-semibold uppercase tracking-[0.18em] text-slate-500">
                Disposition
              </span>
              <select
                name="out_disposition"
                defaultValue={resolvedFilters.disposition ?? ""}
                className={TEAM_INPUT_COMPACT}
              >
                <option value="">All</option>
                {(queuePayload.facets?.dispositions ?? []).map((value) => (
                  <option key={value} value={value}>
                    {value.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </label>

            <div className="flex items-end gap-2">
              <SubmitButton
                className={`${teamButtonClass("primary", "sm")} w-full sm:w-auto`}
                pendingLabel="Filtering..."
              >
                Filter
              </SubmitButton>
              <a
                className="inline-flex min-h-11 items-center text-xs font-semibold text-slate-500 hover:text-slate-700"
                href={buildOutboundHref({
                  memberId: resolvedMemberId,
                  filters: {},
                })}
              >
                Reset
              </a>
            </div>
          </div>
        </form>

        {items.length === 0 ? (
          <div className={`${TEAM_EMPTY_STATE} mt-4`}>
            No outbound accounts match these filters.
          </div>
        ) : (
          <>
            <form
              id="outboundBulkForm"
              action={bulkOutboundAction}
              className="mt-4 grid gap-4 rounded-2xl border border-slate-200 bg-white p-4"
            >
              <input
                type="hidden"
                name="idempotencyKey"
                value={`outbound-bulk:${randomUUID()}`}
              />
              <div className="grid w-full gap-3 sm:grid-cols-3">
                <label className="flex flex-col gap-1 text-xs text-slate-600">
                  <span className="font-semibold uppercase tracking-[0.18em] text-slate-500">
                    Bulk action
                  </span>
                  <select
                    name="action"
                    defaultValue="assign"
                    className={TEAM_INPUT_COMPACT}
                  >
                    <option value="assign">Assign</option>
                    <option value="assign_start">Assign + start cadence</option>
                    <option value="start">Start cadence</option>
                    <option value="snooze">Snooze</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs text-slate-600">
                  <span className="font-semibold uppercase tracking-[0.18em] text-slate-500">
                    Assign to
                  </span>
                  <select
                    name="assignedToMemberId"
                    defaultValue={resolvedMemberId}
                    className={TEAM_INPUT_COMPACT}
                  >
                    <option value="">Default assignee</option>
                    {members.map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs text-slate-600">
                  <span className="font-semibold uppercase tracking-[0.18em] text-slate-500">
                    Snooze until
                  </span>
                  <select
                    name="snoozePreset"
                    defaultValue="tomorrow_9am"
                    className={TEAM_INPUT_COMPACT}
                  >
                    <option value="today_5pm">Later today (5pm ET)</option>
                    <option value="tomorrow_9am">Tomorrow (9am ET)</option>
                    <option value="plus_3d_9am">+3 days (9am ET)</option>
                    <option value="next_monday_9am">
                      Next Monday (9am ET)
                    </option>
                    <option value="plus_7d_9am">+7 days (9am ET)</option>
                  </select>
                  <span className="text-[11px] text-slate-500">
                    Snooze skips rows that are not started yet.
                  </span>
                </label>
              </div>
              <details className="rounded-xl border border-slate-200 bg-slate-50">
                <summary className="flex min-h-11 cursor-pointer items-center px-3 py-2 text-sm font-semibold text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500">
                  Choose accounts for this bulk action
                </summary>
                <div className="grid gap-2 border-t border-slate-200 p-3 sm:grid-cols-2 xl:grid-cols-3">
                  {items.map((item) => {
                    const hasDnc = item.dncContactCount > 0;
                    return (
                      <label
                        key={item.id}
                        className={`flex min-h-11 items-start gap-3 rounded-xl border px-3 py-2 text-xs ${
                          hasDnc
                            ? "cursor-not-allowed border-rose-200 bg-rose-50 text-rose-900"
                            : "cursor-pointer border-slate-200 bg-white text-slate-700"
                        }`}
                      >
                        <input
                          form="outboundBulkForm"
                          type="checkbox"
                          name="taskRefs"
                          value={JSON.stringify(
                            item.tasks.map((task) => ({
                              id: task.id,
                              version: task.version,
                            })),
                          )}
                          disabled={hasDnc}
                          className="mt-0.5 h-5 w-5 shrink-0"
                        />
                        <span>
                          <span className="block font-semibold text-slate-900">
                            {item.account.name}
                          </span>
                          <span className="mt-0.5 block">
                            {hasDnc
                              ? "Not eligible: account contains a DNC contact"
                              : `${item.openTaskCount} eligible task${item.openTaskCount === 1 ? "" : "s"}`}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </details>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <OutboundBulkSelectionControls formId="outboundBulkForm" />
                <SubmitButton
                  className={teamButtonClass("primary", "sm")}
                  pendingLabel="Applying..."
                >
                  Apply bulk action
                </SubmitButton>
              </div>
            </form>

            {selected ? (
              <div className="mt-4 rounded-2xl border border-primary-200 bg-primary-50/60 p-4 lg:hidden">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-primary-700">
                      Selected account
                    </p>
                    <p className="mt-1 text-base font-semibold text-slate-900">
                      {selected.account.name}
                    </p>
                    <p className="mt-1 text-xs text-slate-600">
                      {selected.contactCount} contact
                      {selected.contactCount === 1 ? "" : "s"} /{" "}
                      {selected.openTaskCount} open task
                      {selected.openTaskCount === 1 ? "" : "s"}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2 text-[11px] font-semibold">
                      <span className="rounded-full border border-primary-200 bg-white px-2.5 py-1 text-slate-800">
                        Owner:{" "}
                        {assigneeLabel(selected.assignedToMemberId, members)}
                      </span>
                      <span className="rounded-full border border-primary-200 bg-white px-2.5 py-1 text-slate-800">
                        Cadence: {selected.dueAt ? "Active" : "Not started"}
                      </span>
                      <span className="rounded-full border border-primary-200 bg-white px-2.5 py-1 text-slate-800">
                        Disposition:{" "}
                        {formatDisposition(selected.lastDisposition)}
                      </span>
                      {selectedOutreachBlocked ? (
                        <span className="rounded-full border border-rose-300 bg-rose-50 px-2.5 py-1 text-rose-950">
                          Do Not Contact — outreach blocked
                        </span>
                      ) : selected.dncContactCount > 0 ? (
                        <span className="rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-amber-950">
                          {selected.dncContactCount} linked DNC contact
                          {selected.dncContactCount === 1 ? "" : "s"}
                        </span>
                      ) : null}
                    </div>
                    {selected.account.brief?.summary ? (
                      <p className="mt-2 text-sm text-slate-600">
                        {selected.account.brief.summary}
                      </p>
                    ) : null}
                  </div>
                  <a
                    href={buildOutboundHref({
                      memberId: resolvedMemberId,
                      filters: resolvedFilters,
                      patch: { accountId: "", taskId: "" },
                    })}
                    className="inline-flex min-h-11 min-w-11 items-center justify-center text-xs font-semibold text-primary-700 hover:text-primary-800"
                  >
                    Close
                  </a>
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-3">
                  <div className="rounded-xl border border-white/80 bg-white px-3 py-2 text-xs text-slate-600">
                    <div className="font-semibold text-slate-900">
                      Last touch
                    </div>
                    <div className="mt-1">
                      {formatTimestamp(selected.account.lastTouchAt) ??
                        "No touch yet"}
                    </div>
                  </div>
                  <div className="rounded-xl border border-white/80 bg-white px-3 py-2 text-xs text-slate-600">
                    <div className="font-semibold text-slate-900">
                      Next touch
                    </div>
                    <div className="mt-1">
                      {formatTimestamp(selected.account.nextTouchAt) ??
                        "Not scheduled"}
                    </div>
                  </div>
                  <div className="rounded-xl border border-white/80 bg-white px-3 py-2 text-xs text-slate-600">
                    <div className="font-semibold text-slate-900">Fit</div>
                    <div className="mt-1">
                      {selected.account.fitScore !== null &&
                      selected.account.fitScore !== undefined
                        ? `${selected.account.fitScore}/100 · ${formatPartnerFit(selected.account.portalFit)}`
                        : formatPartnerFit(selected.account.portalFit)}
                    </div>
                  </div>
                </div>
                {selectedOutreachBlocked && selectedPrimary ? (
                  <div
                    role="status"
                    className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-950"
                  >
                    <p className="font-semibold">Outreach is blocked</p>
                    <p className="mt-1">
                      {selectedPrimary.name} is marked Do Not Contact. Call,
                      message, suggestion, callback, and cadence controls are
                      unavailable.
                    </p>
                    {selectedPrimary.doNotContactReason ? (
                      <p className="mt-1 text-xs">
                        Recorded reason: {selectedPrimary.doNotContactReason}
                      </p>
                    ) : null}
                  </div>
                ) : selectedPrimary ? (
                  <div className="mt-3 grid gap-3 rounded-xl border border-primary-200 bg-white p-3">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-600">
                        Record outcome
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {[
                          { key: "connected", label: "Connected" },
                          { key: "no_answer", label: "No answer" },
                          { key: "left_voicemail", label: "Left voicemail" },
                          { key: "email_sent", label: "Email sent" },
                          { key: "not_interested", label: "Not interested" },
                          { key: "dnc", label: "Mark DNC" },
                        ].map((outcome) => (
                          <form
                            key={outcome.key}
                            action={setOutboundDispositionAction}
                          >
                            <input
                              type="hidden"
                              name="taskId"
                              value={selected.primaryTaskId}
                            />
                            <input
                              type="hidden"
                              name="disposition"
                              value={outcome.key}
                            />
                            <input
                              type="hidden"
                              name="expectedVersion"
                              value={selected.primaryTaskVersion}
                            />
                            <input
                              type="hidden"
                              name="idempotencyKey"
                              value={`outbound-disposition:${randomUUID()}`}
                            />
                            <SubmitButton
                              className={teamButtonClass("secondary", "sm")}
                              pendingLabel="Saving..."
                            >
                              {outcome.label}
                            </SubmitButton>
                          </form>
                        ))}
                      </div>
                    </div>
                    <form
                      action={setOutboundDispositionAction}
                      className="grid gap-2"
                    >
                      <input
                        type="hidden"
                        name="taskId"
                        value={selected.primaryTaskId}
                      />
                      <input
                        type="hidden"
                        name="disposition"
                        value="callback_requested"
                      />
                      <input
                        type="hidden"
                        name="expectedVersion"
                        value={selected.primaryTaskVersion}
                      />
                      <input
                        type="hidden"
                        name="idempotencyKey"
                        value={`outbound-disposition:${randomUUID()}`}
                      />
                      <label className="grid gap-1 text-xs text-slate-700">
                        <span className="font-semibold">
                          Callback date and time — {OUTBOUND_TIME_ZONE}
                        </span>
                        <span>
                          Eastern time; DST gaps and repeated times fail closed.
                        </span>
                        <input
                          name="callbackAt"
                          type="datetime-local"
                          required
                          className={TEAM_INPUT_COMPACT}
                        />
                      </label>
                      <SubmitButton
                        className={teamButtonClass("primary", "sm")}
                        pendingLabel="Scheduling..."
                      >
                        Schedule callback
                      </SubmitButton>
                    </form>
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="mt-4 space-y-3 lg:hidden">
              {items.map((item) => {
                const dueBadge = formatDueBadge(item);
                const primary = primaryContact(item);
                const outreachBlocked = primary.doNotContact;
                const isSelected = Boolean(selected?.id === item.id);
                return (
                  <div
                    key={item.id}
                    className={`rounded-2xl border px-4 py-4 shadow-sm ${
                      isSelected
                        ? "border-primary-300 bg-primary-50/70"
                        : "border-slate-200 bg-white"
                    }`}
                  >
                    <a
                      href={buildOutboundHref({
                        memberId: resolvedMemberId,
                        filters: resolvedFilters,
                        patch: {
                          accountId: item.id,
                          taskId: item.primaryTaskId,
                        },
                      })}
                      className="block"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-base font-semibold text-slate-900">
                            {item.account.name}
                          </div>
                          <div className="mt-1 text-xs text-slate-500">
                            Owner:{" "}
                            {assigneeLabel(item.assignedToMemberId, members)}
                          </div>
                        </div>
                        <div className="max-w-[12rem] text-right">
                          <span
                            className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${dueBadge.tone}`}
                          >
                            {dueBadge.label}
                          </span>
                          <span className="mt-1 block text-[11px] text-slate-600">
                            {formatTimestamp(item.dueAt) ??
                              "Cadence not started"}
                          </span>
                        </div>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2 text-[11px] font-semibold">
                        <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-slate-700">
                          Cadence: {item.dueAt ? "Active" : "Not started"}
                        </span>
                        <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-slate-700">
                          Disposition: {formatDisposition(item.lastDisposition)}
                        </span>
                        {outreachBlocked ? (
                          <span className="rounded-full border border-rose-300 bg-rose-50 px-2.5 py-1 text-rose-900">
                            Do Not Contact — outreach blocked
                          </span>
                        ) : (
                          <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-emerald-900">
                            Contactable
                          </span>
                        )}
                        {!outreachBlocked && item.dncContactCount > 0 ? (
                          <span className="rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-amber-950">
                            {item.dncContactCount} other linked DNC contact
                            {item.dncContactCount === 1 ? "" : "s"}
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-3 space-y-1 text-sm text-slate-700">
                        <div>{primary.name}</div>
                        <div className="break-words text-xs text-slate-500">
                          {primary.phone ?? "No phone"} ·{" "}
                          {primary.email ?? "No email"}
                        </div>
                        <div className="text-xs text-slate-500">
                          {item.contactCount} contact
                          {item.contactCount === 1 ? "" : "s"} /{" "}
                          {item.openTaskCount} open task
                          {item.openTaskCount === 1 ? "" : "s"}
                        </div>
                      </div>
                    </a>
                    {outreachBlocked ? (
                      <div
                        role="status"
                        className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs font-medium text-rose-950"
                      >
                        Call, message, suggestions, callbacks, and cadence
                        controls are unavailable because {primary.name} is
                        marked Do Not Contact.
                      </div>
                    ) : (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {canPlaceCalls ? (
                          <form action={startContactCallAction}>
                            <input
                              type="hidden"
                              name="contactId"
                              value={primary.id}
                            />
                            <input
                              type="hidden"
                              name="idempotencyKey"
                              value={`team-call:${randomUUID()}`}
                            />
                            <input
                              type="hidden"
                              name="explicitNewAttempt"
                              value="START NEW CALL"
                            />
                            <input
                              type="hidden"
                              name="taskId"
                              value={item.primaryTaskId}
                            />
                            <SubmitButton
                              className={teamButtonClass("primary", "sm")}
                              pendingLabel="Calling..."
                            >
                              Call
                            </SubmitButton>
                          </form>
                        ) : null}
                        <form action={openContactThreadAction}>
                          <input
                            type="hidden"
                            name="contactId"
                            value={primary.id}
                          />
                          <input
                            type="hidden"
                            name="channel"
                            value={primary.email ? "email" : "sms"}
                          />
                          <SubmitButton
                            className={teamButtonClass("secondary", "sm")}
                            pendingLabel="Opening..."
                          >
                            Message
                          </SubmitButton>
                        </form>
                        <form action={draftOutboundFirstTouchAction}>
                          <input
                            type="hidden"
                            name="contactId"
                            value={primary.id}
                          />
                          <input
                            type="hidden"
                            name="taskId"
                            value={item.primaryTaskId}
                          />
                          <input
                            type="hidden"
                            name="channel"
                            value={primary.email ? "email" : "sms"}
                          />
                          <SubmitButton
                            className={teamButtonClass("secondary", "sm")}
                            pendingLabel="Suggesting..."
                          >
                            Suggest
                          </SubmitButton>
                        </form>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="mt-4 hidden gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_320px] xl:grid-cols-[minmax(0,1fr)_360px]">
              <div className="rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)]">
                <table className="w-full table-fixed text-left text-xs">
                  <thead className="sticky top-0 z-10 bg-[color:var(--team-surface-muted)] text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--team-text-soft)]">
                    <tr>
                      <th className="w-[164px] px-4 py-3">Cadence / due</th>
                      <th className="w-[132px] px-4 py-3">Owner</th>
                      <th className="w-[76px] px-4 py-3">Attempt</th>
                      <th className="px-4 py-3">Prospect</th>
                      <th className="hidden w-[176px] px-4 py-3 text-right md:table-cell">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[color:var(--team-border)]">
                    {items.map((item) => {
                      const dueBadge = formatDueBadge(item);
                      const primary = primaryContact(item);
                      const outreachBlocked = primary.doNotContact;
                      const isSelected = Boolean(selected?.id === item.id);
                      return (
                        <tr
                          key={item.id}
                          className={
                            isSelected
                              ? "bg-primary-50/40"
                              : "hover:bg-slate-50"
                          }
                        >
                          <td className="px-4 py-3">
                            <span
                              className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${dueBadge.tone}`}
                            >
                              {dueBadge.label}
                            </span>
                            <span className="mt-1 block text-[11px] text-[color:var(--team-text-soft)]">
                              {item.dueAt ? "Cadence active" : "Not started"}
                            </span>
                            {item.dueAt ? (
                              <span className="mt-1 block break-words text-[10px] leading-4 text-[color:var(--team-text-soft)]">
                                {formatTimestamp(item.dueAt)}
                              </span>
                            ) : null}
                          </td>
                          <td className="px-4 py-3 text-[11px] font-medium text-[color:var(--team-text-muted)]">
                            {assigneeLabel(item.assignedToMemberId, members)}
                          </td>
                          <td className="px-4 py-3 text-[color:var(--team-text-muted)]">
                            {item.attempt}
                          </td>
                          <td className="min-w-0 overflow-hidden px-4 py-3">
                            <a
                              href={buildOutboundHref({
                                memberId: resolvedMemberId,
                                filters: resolvedFilters,
                                patch: {
                                  accountId: item.id,
                                  taskId: item.primaryTaskId,
                                },
                              })}
                              className="block min-w-0"
                            >
                              <div className="truncate text-sm font-semibold text-[color:var(--team-text)]">
                                {item.account.name}
                              </div>
                              <div className="mt-0.5 truncate text-[11px] text-[color:var(--team-text-soft)]">
                                {primary.name}
                                {item.account.segment
                                  ? ` / ${item.account.segment}`
                                  : item.campaign
                                    ? ` / ${item.campaign}`
                                    : ""}
                              </div>
                              <div className="mt-1 truncate text-[11px] text-[color:var(--team-text-soft)]">
                                <span>{primary.phone ?? "No phone"}</span>
                                <span className="mx-1">{"\u2022"}</span>
                                <span>{primary.email ?? "No email"}</span>
                                <span className="mx-1">{"\u2022"}</span>
                                <span>
                                  Disposition:{" "}
                                  {formatDisposition(item.lastDisposition)}
                                </span>
                              </div>
                              <div className="mt-1 flex flex-wrap gap-1 text-[11px] font-semibold">
                                {outreachBlocked ? (
                                  <span className="rounded-full border border-rose-300 bg-rose-50 px-2 py-1 text-rose-900">
                                    DNC — outreach blocked
                                  </span>
                                ) : (
                                  <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-1 text-emerald-900">
                                    Contactable
                                  </span>
                                )}
                                {!outreachBlocked &&
                                item.dncContactCount > 0 ? (
                                  <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-1 text-amber-950">
                                    {item.dncContactCount} linked DNC
                                  </span>
                                ) : null}
                              </div>
                              <div className="mt-1 truncate text-[11px] text-[color:var(--team-text-soft)]">
                                {item.contactCount} contact
                                {item.contactCount === 1 ? "" : "s"} /{" "}
                                {item.openTaskCount} open task
                                {item.openTaskCount === 1 ? "" : "s"} / Account{" "}
                                {item.account.status?.replace(/_/g, " ") ??
                                  "linked"}
                              </div>
                            </a>
                          </td>
                          <td className="relative hidden w-[176px] border-l border-[color:var(--team-border)] bg-[color:var(--team-surface)] px-4 py-3 md:table-cell">
                            {outreachBlocked ? (
                              <div className="rounded-xl border border-rose-200 bg-rose-50 p-2 text-right text-[11px] font-semibold text-rose-900">
                                Do Not Contact
                                <span className="mt-1 block font-normal">
                                  Outreach disabled
                                </span>
                              </div>
                            ) : (
                              <div className="flex flex-col items-end gap-2">
                                {canPlaceCalls ? (
                                  <form action={startContactCallAction}>
                                    <input
                                      type="hidden"
                                      name="contactId"
                                      value={primary.id}
                                    />
                                    <input
                                      type="hidden"
                                      name="idempotencyKey"
                                      value={`team-call:${randomUUID()}`}
                                    />
                                    <input
                                      type="hidden"
                                      name="explicitNewAttempt"
                                      value="START NEW CALL"
                                    />
                                    <input
                                      type="hidden"
                                      name="taskId"
                                      value={item.primaryTaskId}
                                    />
                                    <SubmitButton
                                      className={teamButtonClass(
                                        "primary",
                                        "sm",
                                      )}
                                      pendingLabel="Calling..."
                                    >
                                      Call
                                    </SubmitButton>
                                  </form>
                                ) : null}
                                <form action={openContactThreadAction}>
                                  <input
                                    type="hidden"
                                    name="contactId"
                                    value={primary.id}
                                  />
                                  <input
                                    type="hidden"
                                    name="channel"
                                    value={primary.email ? "email" : "sms"}
                                  />
                                  <SubmitButton
                                    className={teamButtonClass(
                                      "secondary",
                                      "sm",
                                    )}
                                    pendingLabel="Opening..."
                                  >
                                    Msg
                                  </SubmitButton>
                                </form>
                                <form action={draftOutboundFirstTouchAction}>
                                  <input
                                    type="hidden"
                                    name="contactId"
                                    value={primary.id}
                                  />
                                  <input
                                    type="hidden"
                                    name="taskId"
                                    value={item.primaryTaskId}
                                  />
                                  <input
                                    type="hidden"
                                    name="channel"
                                    value={primary.email ? "email" : "sms"}
                                  />
                                  <SubmitButton
                                    className={teamButtonClass(
                                      "secondary",
                                      "sm",
                                    )}
                                    pendingLabel="Suggesting..."
                                  >
                                    Suggest
                                  </SubmitButton>
                                </form>
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <aside className="rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] p-4">
                {selected ? (
                  <div className="space-y-4">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--team-text-soft)]">
                        Selected account
                      </p>
                      <p className="mt-1 text-base font-semibold text-[color:var(--team-text)]">
                        {selected.account.name}
                      </p>
                      <p className="mt-1 text-xs text-[color:var(--team-text-muted)]">
                        {selected.contactCount} contact
                        {selected.contactCount === 1 ? "" : "s"} /{" "}
                        {selected.openTaskCount} open task
                        {selected.openTaskCount === 1 ? "" : "s"}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-1 text-[11px] font-semibold">
                        <span className="rounded-full border border-[color:var(--team-border)] bg-[color:var(--team-surface-muted)] px-2 py-1 text-[color:var(--team-text)]">
                          Owner:{" "}
                          {assigneeLabel(selected.assignedToMemberId, members)}
                        </span>
                        <span className="rounded-full border border-[color:var(--team-border)] bg-[color:var(--team-surface-muted)] px-2 py-1 text-[color:var(--team-text)]">
                          Disposition:{" "}
                          {formatDisposition(selected.lastDisposition)}
                        </span>
                        {selectedOutreachBlocked ? (
                          <span className="rounded-full border border-rose-300 bg-rose-50 px-2 py-1 text-rose-950">
                            Do Not Contact — outreach blocked
                          </span>
                        ) : selected.dncContactCount > 0 ? (
                          <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-1 text-amber-950">
                            {selected.dncContactCount} linked DNC contact
                            {selected.dncContactCount === 1 ? "" : "s"}
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-1 text-[11px] text-[color:var(--team-text-soft)]">
                        Account{" "}
                        {selected.account.status?.replace(/_/g, " ") ??
                          "linked"}
                        {selected.account.segment
                          ? ` / ${selected.account.segment}`
                          : ""}
                      </p>
                      <p className="mt-1 text-[11px] text-[color:var(--team-text-soft)]">
                        Attempt {selected.attempt} /{" "}
                        {selected.campaign ?? "outbound"} / Due{" "}
                        {formatDue(selected)}
                      </p>
                      <p className="mt-1 text-[11px] text-[color:var(--team-text-soft)]">
                        {selected.dueAt
                          ? "Cadence started"
                          : "Cadence not started"}
                        {formatTimestamp(selected.startedAt)
                          ? ` (${formatTimestamp(selected.startedAt)})`
                          : ""}
                      </p>
                      {formatTimestamp(selected.reminderAt) ? (
                        <p className="mt-1 text-[11px] text-[color:var(--team-text-soft)]">
                          Reminder scheduled{" "}
                          {formatTimestamp(selected.reminderAt)}
                        </p>
                      ) : null}
                      {selected.account.lastTouchAt ? (
                        <p className="mt-1 text-[11px] text-[color:var(--team-text-soft)]">
                          Account last touch{" "}
                          {formatTimestamp(selected.account.lastTouchAt)}
                        </p>
                      ) : null}
                      {selected.account.nextTouchAt ? (
                        <p className="mt-1 text-[11px] text-[color:var(--team-text-soft)]">
                          Account next touch{" "}
                          {formatTimestamp(selected.account.nextTouchAt)}
                        </p>
                      ) : null}
                      {selected.noteSnippet ? (
                        <p className="mt-3 rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface-muted)] px-3 py-2 text-xs text-[color:var(--team-text-muted)]">
                          {selected.noteSnippet}
                        </p>
                      ) : null}
                    </div>

                    {selected.account.brief ? (
                      <div className="rounded-xl border border-primary-200 bg-primary-50/70 p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-primary-700">
                              AI account brief
                            </p>
                            <p className="mt-1 text-xs text-primary-900">
                              Prep for the next real outreach touch.
                            </p>
                          </div>
                          <div className="text-right text-[11px] text-primary-700">
                            <div>
                              {selected.account.brief.provider === "openai"
                                ? "AI brief"
                                : "Fallback brief"}
                            </div>
                            <div>
                              {formatTimestamp(
                                selected.account.brief.updatedAt,
                              ) ?? selected.account.brief.updatedAt}
                            </div>
                          </div>
                        </div>
                        <div className="mt-3 space-y-3 text-xs text-slate-700">
                          <div>
                            <p className="font-semibold text-slate-900">
                              Who they are
                            </p>
                            <p className="mt-1">
                              {selected.account.brief.summary}
                            </p>
                          </div>
                          <div>
                            <p className="font-semibold text-slate-900">
                              Why they matter
                            </p>
                            <p className="mt-1">
                              {selected.account.brief.whyFit}
                            </p>
                          </div>
                          <div>
                            <p className="font-semibold text-slate-900">
                              Service angle
                            </p>
                            <p className="mt-1">
                              {selected.account.brief.serviceAngle}
                            </p>
                          </div>
                          <div>
                            <p className="font-semibold text-slate-900">
                              Best opener
                            </p>
                            <p className="mt-1 rounded-lg border border-primary-200 bg-white px-3 py-2 text-slate-900">
                              {selected.account.brief.bestOpener}
                            </p>
                          </div>
                          {selected.account.brief.likelyObjections.length ? (
                            <div>
                              <p className="font-semibold text-slate-900">
                                Likely objections
                              </p>
                              <div className="mt-2 flex flex-wrap gap-2">
                                {selected.account.brief.likelyObjections.map(
                                  (item) => (
                                    <span
                                      key={item}
                                      className="rounded-full border border-primary-200 bg-white px-2.5 py-1 text-[11px] text-slate-700"
                                    >
                                      {item}
                                    </span>
                                  ),
                                )}
                              </div>
                            </div>
                          ) : null}
                          <div>
                            <p className="font-semibold text-slate-900">
                              Best next move
                            </p>
                            <p className="mt-1">
                              {selected.account.brief.recommendedNextMove}
                            </p>
                          </div>
                          <div className="rounded-lg border border-primary-200 bg-white px-3 py-3">
                            <div className="flex items-center justify-between gap-3">
                              <div>
                                <p className="font-semibold text-slate-900">
                                  Suggested partner path
                                </p>
                                <p className="mt-1 text-slate-700">
                                  {selected.account.brief.fitReason}
                                </p>
                              </div>
                              <div className="text-right">
                                <div className="rounded-full border border-primary-200 bg-primary-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-primary-700">
                                  {formatPartnerFit(
                                    selected.account.brief.partnerFit,
                                  )}
                                </div>
                                <div className="mt-2 text-[11px] text-slate-500">
                                  Fit score {selected.account.brief.fitScore}
                                  /100
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    ) : null}

                    <div className="rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--team-text-soft)]">
                            Account history
                          </p>
                          <p className="mt-1 text-xs text-[color:var(--team-text-muted)]">
                            Recent import, suggestion, disposition, recap, and
                            conversion activity for this relationship.
                          </p>
                        </div>
                      </div>
                      {selected.account.history &&
                      selected.account.history.length > 0 ? (
                        <div className="mt-3 space-y-2">
                          {selected.account.history.map((entry) => {
                            const kind = formatHistoryKind(entry.kind);
                            return (
                              <div
                                key={entry.id}
                                className="rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface-muted)] px-3 py-3"
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <span
                                        className={`rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${kind.tone}`}
                                      >
                                        {kind.label}
                                      </span>
                                      <span className="text-sm font-semibold text-[color:var(--team-text)]">
                                        {entry.title}
                                      </span>
                                    </div>
                                    <p className="mt-1 text-xs text-[color:var(--team-text-muted)]">
                                      {entry.summary}
                                    </p>
                                    {entry.contactName ? (
                                      <p className="mt-1 text-[11px] text-[color:var(--team-text-soft)]">
                                        {entry.contactName}
                                      </p>
                                    ) : null}
                                  </div>
                                  <div className="shrink-0 text-[11px] text-[color:var(--team-text-soft)]">
                                    {formatTimestamp(entry.at) ?? entry.at}
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="mt-3 rounded-xl border border-dashed border-[color:var(--team-border)] bg-[color:var(--team-surface-muted)] px-3 py-3 text-xs text-[color:var(--team-text-soft)]">
                          No account activity yet beyond the current queue
                          state.
                        </div>
                      )}
                    </div>

                    <div className="rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface-muted)] p-3">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--team-text-soft)]">
                        Linked contacts
                      </p>
                      <div className="mt-2 space-y-3">
                        {selected.contacts.map((contact) => (
                          <div
                            key={contact.id}
                            className="rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] p-3"
                          >
                            <div className="text-sm font-semibold text-[color:var(--team-text)]">
                              {contact.name}
                            </div>
                            <div className="mt-1 text-xs text-[color:var(--team-text-muted)]">
                              {contact.phone ?? "No phone"} /{" "}
                              {contact.email ?? "No email"}
                            </div>
                            {contact.doNotContact ? (
                              <div
                                role="status"
                                className="mt-2 rounded-lg border border-rose-200 bg-rose-50 p-2 text-xs text-rose-950"
                              >
                                <span className="font-semibold">
                                  Do Not Contact — outreach disabled
                                </span>
                                {contact.doNotContactReason ? (
                                  <span className="mt-1 block">
                                    {contact.doNotContactReason}
                                  </span>
                                ) : null}
                              </div>
                            ) : (
                              <div className="mt-2 flex flex-wrap gap-2">
                                {canPlaceCalls ? (
                                  <form action={startContactCallAction}>
                                    <input
                                      type="hidden"
                                      name="contactId"
                                      value={contact.id}
                                    />
                                    <input
                                      type="hidden"
                                      name="idempotencyKey"
                                      value={`team-call:${randomUUID()}`}
                                    />
                                    <input
                                      type="hidden"
                                      name="explicitNewAttempt"
                                      value="START NEW CALL"
                                    />
                                    <input
                                      type="hidden"
                                      name="taskId"
                                      value={selected.primaryTaskId}
                                    />
                                    <SubmitButton
                                      className={teamButtonClass(
                                        "primary",
                                        "sm",
                                      )}
                                      pendingLabel="Calling..."
                                    >
                                      Call
                                    </SubmitButton>
                                  </form>
                                ) : null}
                                <form action={openContactThreadAction}>
                                  <input
                                    type="hidden"
                                    name="contactId"
                                    value={contact.id}
                                  />
                                  <input
                                    type="hidden"
                                    name="channel"
                                    value={contact.email ? "email" : "sms"}
                                  />
                                  <SubmitButton
                                    className={teamButtonClass(
                                      "secondary",
                                      "sm",
                                    )}
                                    pendingLabel="Opening..."
                                  >
                                    Message
                                  </SubmitButton>
                                </form>
                                <form action={draftOutboundFirstTouchAction}>
                                  <input
                                    type="hidden"
                                    name="contactId"
                                    value={contact.id}
                                  />
                                  <input
                                    type="hidden"
                                    name="taskId"
                                    value={selected.primaryTaskId}
                                  />
                                  <input
                                    type="hidden"
                                    name="channel"
                                    value={contact.email ? "email" : "sms"}
                                  />
                                  <SubmitButton
                                    className={teamButtonClass(
                                      "secondary",
                                      "sm",
                                    )}
                                    pendingLabel="Suggesting..."
                                  >
                                    Suggest
                                  </SubmitButton>
                                </form>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>

                    {selectedOutreachBlocked && selectedPrimary ? (
                      <div
                        role="status"
                        className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-950"
                      >
                        <p className="font-semibold">Outreach is blocked</p>
                        <p className="mt-1 text-xs">
                          {selectedPrimary.name} is marked Do Not Contact. Call,
                          message, disposition, suggestion, callback, and
                          cadence controls are unavailable.
                        </p>
                        {selectedPrimary.doNotContactReason ? (
                          <p className="mt-1 text-xs">
                            Recorded reason:{" "}
                            {selectedPrimary.doNotContactReason}
                          </p>
                        ) : null}
                      </div>
                    ) : (
                      <>
                        {!selected.dueAt ? (
                          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                              Kickoff
                            </p>
                            <p className="mt-1 text-xs text-slate-600">
                              Make your first outreach (call/email), then click
                              a disposition below (Connected / No answer / Left
                              VM / Emailed). That first disposition starts the
                              cadence and schedules the follow-ups.
                            </p>
                          </div>
                        ) : null}

                        <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-700">
                            Call script
                          </p>
                          <p className="mt-1">
                            Hi, this is Stonegate Junk Removal in Georgia. We
                            help property managers with unit cleanouts and bulk
                            pickup. Do you handle any properties that need
                            haul-off this month?
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
                            { key: "dnc", label: "DNC" },
                          ].map((d) => (
                            <form
                              key={d.key}
                              action={setOutboundDispositionAction}
                            >
                              <input
                                type="hidden"
                                name="taskId"
                                value={selected.primaryTaskId}
                              />
                              <input
                                type="hidden"
                                name="disposition"
                                value={d.key}
                              />
                              <input
                                type="hidden"
                                name="expectedVersion"
                                value={selected.primaryTaskVersion}
                              />
                              <input
                                type="hidden"
                                name="idempotencyKey"
                                value={`outbound-disposition:${randomUUID()}`}
                              />
                              <SubmitButton
                                className={teamButtonClass("secondary", "sm")}
                                pendingLabel="Saving..."
                              >
                                {d.label}
                              </SubmitButton>
                            </form>
                          ))}
                        </div>

                        <div className="rounded-xl border border-slate-200 bg-white p-3">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                            Detailed update
                          </p>
                          <p className="mt-1 text-xs text-slate-600">
                            Save a quick recap from the call or reply so the
                            next move is easier to pick up later.
                          </p>
                          <form
                            action={setOutboundDispositionAction}
                            className="mt-3 flex flex-col gap-2"
                          >
                            <input
                              type="hidden"
                              name="taskId"
                              value={selected.primaryTaskId}
                            />
                            <input
                              type="hidden"
                              name="expectedVersion"
                              value={selected.primaryTaskVersion}
                            />
                            <input
                              type="hidden"
                              name="idempotencyKey"
                              value={`outbound-disposition:${randomUUID()}`}
                            />
                            <select
                              name="disposition"
                              defaultValue={selected.lastDisposition ?? ""}
                              className={TEAM_INPUT_COMPACT}
                            >
                              <option value="">Choose disposition</option>
                              <option value="connected">Connected</option>
                              <option value="partner">Partner</option>
                              <option value="no_answer">No answer</option>
                              <option value="left_voicemail">
                                Left voicemail
                              </option>
                              <option value="email_sent">Email sent</option>
                              <option value="callback_requested">
                                Callback requested
                              </option>
                              <option value="not_interested">
                                Not interested
                              </option>
                              <option value="dnc">DNC</option>
                            </select>
                            <textarea
                              name="recap"
                              className={`${TEAM_INPUT_COMPACT} min-h-[96px]`}
                              placeholder="Quick recap: who you spoke with, what they said, what they want next, anything useful for the next touch..."
                            />
                            <label className="grid gap-1 text-xs text-slate-600">
                              <span className="font-semibold">
                                Callback date and time — {OUTBOUND_TIME_ZONE}
                              </span>
                              <span>
                                Only use this with Callback requested. DST gaps
                                and repeated Eastern times fail closed.
                              </span>
                              <input
                                name="callbackAt"
                                type="datetime-local"
                                className={TEAM_INPUT_COMPACT}
                              />
                            </label>
                            <SubmitButton
                              className={teamButtonClass("primary", "sm")}
                              pendingLabel="Saving..."
                            >
                              Save detailed update
                            </SubmitButton>
                          </form>
                        </div>

                        <div className="rounded-xl border border-slate-200 bg-white p-3">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                            Suggest follow-up
                          </p>
                          <p className="mt-1 text-xs text-slate-600">
                            Use the latest outcome, recap, and contact history
                            to suggest the next SMS or email for Inbox.
                          </p>
                          <form
                            action={draftOutboundFollowupAction}
                            className="mt-3 flex flex-col gap-2"
                          >
                            <input
                              type="hidden"
                              name="taskId"
                              value={selected.primaryTaskId}
                            />
                            <label className="flex flex-col gap-1 text-xs text-slate-600">
                              <span className="font-semibold uppercase tracking-[0.18em] text-slate-500">
                                Contact
                              </span>
                              <select
                                name="contactId"
                                defaultValue={selected.primaryContactId}
                                className={TEAM_INPUT_COMPACT}
                              >
                                {selected.contacts.map((contact) => (
                                  <option
                                    key={contact.id}
                                    value={contact.id}
                                    disabled={contact.doNotContact}
                                  >
                                    {contact.name}
                                    {contact.doNotContact
                                      ? " — DNC (unavailable)"
                                      : ""}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label className="flex flex-col gap-1 text-xs text-slate-600">
                              <span className="font-semibold uppercase tracking-[0.18em] text-slate-500">
                                Channel
                              </span>
                              <select
                                name="channel"
                                defaultValue={
                                  (
                                    selected.contacts.find(
                                      (contact) =>
                                        contact.id ===
                                        selected.primaryContactId,
                                    ) ?? selected.contacts[0]
                                  )?.email
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
                              <span className="font-semibold uppercase tracking-[0.18em] text-slate-500">
                                Latest outcome
                              </span>
                              <select
                                name="disposition"
                                defaultValue={selected.lastDisposition ?? ""}
                                className={TEAM_INPUT_COMPACT}
                              >
                                <option value="">Use task context</option>
                                <option value="connected">Connected</option>
                                <option value="partner">Partner</option>
                                <option value="no_answer">No answer</option>
                                <option value="left_voicemail">
                                  Left voicemail
                                </option>
                                <option value="email_sent">Email sent</option>
                                <option value="callback_requested">
                                  Callback requested
                                </option>
                                <option value="not_interested">
                                  Not interested
                                </option>
                              </select>
                            </label>
                            <textarea
                              name="recap"
                              className={`${TEAM_INPUT_COMPACT} min-h-[88px]`}
                              placeholder="Optional recap to steer the follow-up suggestion..."
                            />
                            <SubmitButton
                              className={teamButtonClass("secondary", "sm")}
                              pendingLabel="Suggesting..."
                            >
                              Suggest
                            </SubmitButton>
                          </form>
                        </div>

                        <div className="rounded-xl border border-slate-200 bg-white p-3">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                            Schedule callback — {OUTBOUND_TIME_ZONE}
                          </p>
                          <p className="mt-1 text-xs text-slate-600">
                            Enter Eastern local time. DST gaps and repeated
                            times fail closed instead of guessing.
                          </p>
                          <form
                            action={setOutboundDispositionAction}
                            className="mt-2 flex flex-col gap-2"
                          >
                            <input
                              type="hidden"
                              name="taskId"
                              value={selected.primaryTaskId}
                            />
                            <input
                              type="hidden"
                              name="disposition"
                              value="callback_requested"
                            />
                            <input
                              type="hidden"
                              name="expectedVersion"
                              value={selected.primaryTaskVersion}
                            />
                            <input
                              type="hidden"
                              name="idempotencyKey"
                              value={`outbound-disposition:${randomUUID()}`}
                            />
                            <input
                              name="callbackAt"
                              type="datetime-local"
                              required
                              className={TEAM_INPUT_COMPACT}
                            />
                            <SubmitButton
                              className={teamButtonClass("primary", "sm")}
                              pendingLabel="Scheduling..."
                            >
                              Set callback
                            </SubmitButton>
                          </form>
                        </div>
                      </>
                    )}

                    <div className="rounded-xl border border-slate-200 bg-white p-3">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                        Open tasks
                      </p>
                      <div className="mt-2 space-y-2">
                        {selected.tasks.map((task) => (
                          <div
                            key={task.id}
                            className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-700"
                          >
                            <div className="font-semibold text-slate-900">
                              {task.title ?? "Outbound task"} /{" "}
                              {task.contactName}
                            </div>
                            <div className="mt-1 text-[11px] text-slate-500">
                              Attempt {task.attempt}
                              {task.lastDisposition
                                ? ` / ${task.lastDisposition.replace(/_/g, " ")}`
                                : ""}
                              {task.dueAt
                                ? ` / Due ${formatTimestamp(task.dueAt)}`
                                : " / Not started"}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="text-sm text-slate-600">
                    <p className="font-semibold text-slate-900">
                      Select an account
                    </p>
                    <p className="mt-1 text-xs text-slate-600">
                      Click a row to work one company with linked contacts, open
                      tasks, and quick outreach actions.
                    </p>
                  </div>
                )}
              </aside>
            </div>
          </>
        )}

        <div className="mt-4 flex items-center justify-between text-xs text-slate-600">
          <div className="flex items-center gap-2">
            {hasPrev ? (
              <a
                className={teamButtonClass("secondary", "sm")}
                href={buildOutboundHref({
                  memberId: resolvedMemberId,
                  filters: resolvedFilters,
                  patch: {
                    cursor: pagination.previousCursor ?? "",
                    direction: "previous",
                  },
                })}
              >
                Prev
              </a>
            ) : (
              <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-2 font-semibold text-slate-400">
                Prev
              </span>
            )}
            {hasNext ? (
              <a
                className={teamButtonClass("secondary", "sm")}
                href={buildOutboundHref({
                  memberId: resolvedMemberId,
                  filters: resolvedFilters,
                  patch: {
                    cursor: pagination.nextCursor ?? "",
                    direction: "next",
                  },
                })}
              >
                Next
              </a>
            ) : (
              <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-2 font-semibold text-slate-400">
                Next
              </span>
            )}
          </div>
          <span className="text-[11px] text-slate-500">
            Tip: outbound dispositions schedule the next touch automatically.
          </span>
        </div>
      </div>

      {canImport ? (
        <div id="outbound-import" className={TEAM_CARD_PADDED}>
          <h3 className="text-base font-semibold text-slate-900">
            Import prospects
          </h3>
          <p className="mt-2 text-sm text-slate-600">
            Preview normalization, duplicates, identity conflicts, assignment,
            and exclusions before changing CRM records.
          </p>
          <a
            href={resolvedImportHref}
            className={`${teamButtonClass("primary")} mt-4 min-h-[44px]`}
          >
            Open CSV import
          </a>
        </div>
      ) : null}
    </section>
  );
}
