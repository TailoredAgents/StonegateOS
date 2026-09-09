import { randomUUID } from "node:crypto";
import {
  hasTeamPermission,
  requireCurrentTeamPrincipal,
} from "@/lib/team-principal";
import { callAdminApiAs } from "../lib/api";
import {
  buildOutboundHref,
  buildOutboundFilterHref,
  buildOutboundPartnersHref,
  buildOutboundPartnerSetupHref,
  type OutboundFilters,
} from "../outbound-navigation";
import {
  formatOutboundEasternTime,
  parseOutboundQueueResponse,
  type OutboundQueueItem,
  type OutboundQueueResponse,
  type TeamMember,
} from "../outbound-queue";
import { TEAM_SURFACES } from "../surface-registry";
import {
  TEAM_FOCUS_RING,
  TEAM_INPUT_COMPACT,
  teamButtonClass,
  teamStatePanelClass,
} from "./team-ui";
import { OutboundAccountDetail } from "./OutboundAccountDetail";
import { OutboundBulkActions } from "./OutboundBulkActions";
import { OutboundImportClient } from "./OutboundImportClient";

const PANEL =
  "min-w-0 rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)]";
const FIELD = `${TEAM_INPUT_COMPACT} !text-base w-full min-w-0`;
const MUTED = "text-[color:var(--team-text-muted)]";

function dueLabel(item: OutboundQueueItem) {
  if (!item.dueAt) return "Not started";
  if (item.overdue) return "Overdue";
  if (item.minutesUntilDue !== null && item.minutesUntilDue <= 0)
    return "Due now";
  return "Scheduled";
}

function OutboundHeader({
  memberId,
  filters,
  view,
  canImport,
  canPartners,
  canCreatePartner,
}: {
  memberId?: string;
  filters: OutboundFilters;
  view: "queue" | "import";
  canImport: boolean;
  canPartners: boolean;
  canCreatePartner: boolean;
}) {
  return (
    <header className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Outbound</h2>
          <p className={`mt-1 text-sm ${MUTED}`}>
            Follow up with businesses and look after partner relationships.
          </p>
        </div>
        {canCreatePartner ? (
          <a
            href={buildOutboundPartnerSetupHref({ memberId, filters })}
            className={teamButtonClass("primary")}
          >
            Add partner
          </a>
        ) : null}
      </div>
      <nav
        aria-label="Outbound views"
        className="flex flex-wrap gap-1 border-b border-[color:var(--team-border)] pb-2"
      >
        {[
          {
            label: "Follow-ups",
            href: buildOutboundHref({ memberId, filters }),
            active: view === "queue",
            show: true,
          },
          {
            label: "Import contacts",
            href: buildOutboundHref({ memberId, filters, view: "import" }),
            active: view === "import",
            show: canImport,
          },
          {
            label: "Partners",
            href: buildOutboundPartnersHref({ memberId, filters, view }),
            active: false,
            show: canPartners,
          },
        ]
          .filter((link) => link.show)
          .map((link) => (
            <a
              key={link.label}
              href={link.href}
              aria-current={link.active ? "page" : undefined}
              className={`inline-flex min-h-11 items-center rounded-xl px-4 py-2 text-sm font-semibold ${TEAM_FOCUS_RING} ${link.active ? "bg-[color:var(--team-surface-muted)] text-[color:var(--team-text)]" : `${MUTED} hover:bg-[color:var(--team-surface-muted)]`}`}
            >
              {link.label}
            </a>
          ))}
      </nav>
    </header>
  );
}

export async function OutboundSection({
  memberId,
  filters = {},
  view,
}: {
  memberId?: string;
  filters?: OutboundFilters;
  view?: string;
}): Promise<React.ReactElement> {
  const principal = await requireCurrentTeamPrincipal();
  const permissions = {
    canCall: hasTeamPermission(principal, "calls.place"),
    canMessage:
      hasTeamPermission(principal, "messages.write") &&
      hasTeamPermission(principal, "messages.read"),
    canDraft:
      hasTeamPermission(principal, "outbound.write") &&
      hasTeamPermission(principal, "messages.read"),
    canManage: hasTeamPermission(principal, "outbound.write"),
  };
  const canImport = hasTeamPermission(principal, "outbound.import");
  const partnerSurface = TEAM_SURFACES.find(
    (surface) => surface.id === "partners",
  )!;
  const canPartners = partnerSurface.requiredPermissions.some((permission) =>
    hasTeamPermission(principal, permission),
  );
  const canCreatePartner =
    hasTeamPermission(principal, "partners.accounts.read") &&
    hasTeamPermission(principal, "partners.accounts.manage") &&
    hasTeamPermission(principal, "partners.invitations.send");
  const currentView = view === "import" ? "import" : "queue";
  const header = (selectedMember = memberId) => (
    <OutboundHeader
      memberId={selectedMember}
      filters={filters}
      view={currentView}
      canImport={canImport}
      canPartners={canPartners}
      canCreatePartner={canCreatePartner}
    />
  );

  if (currentView === "import" && !canImport)
    return (
      <section className="space-y-5">
        {header()}
        <div role="status" className={teamStatePanelClass("warning")}>
          <h3 className="font-semibold">Import access is required</h3>
          <p className="mt-1">
            Ask your administrator for import access. You can still use your
            follow-up list.
          </p>
          <a
            href={buildOutboundHref({ memberId, filters })}
            className={`${teamButtonClass("secondary")} mt-3`}
          >
            Back to follow-ups
          </a>
        </div>
      </section>
    );

  // Independent reads run together; neither is allowed to manufacture an empty success state.
  const directoryPromise = (async () => {
    try {
      const response = await callAdminApiAs(
        principal,
        "/api/admin/team/directory",
      );
      if (!response.ok) return null;
      const data = (await response.json()) as { members?: TeamMember[] };
      if (!Array.isArray(data.members)) return null;
      return data.members.filter(
        (member) =>
          typeof member.id === "string" &&
          typeof member.name === "string" &&
          member.active !== false,
      );
    } catch {
      return null;
    }
  })();
  const apiQuery = new URLSearchParams({ limit: "50" });
  if (memberId) apiQuery.set("memberId", memberId);
  for (const key of [
    "cursor",
    "direction",
    "q",
    "campaign",
    "attempt",
    "due",
    "has",
    "disposition",
    "accountId",
    "taskId",
  ] as const) {
    const value = filters[key]?.trim();
    if (value) apiQuery.set(key, value);
  }
  const queuePromise =
    currentView === "queue"
      ? (async () => {
          try {
            const response = await callAdminApiAs(
              principal,
              `/api/admin/outbound/queue?${apiQuery}`,
            );
            if (!response.ok) return null;
            return parseOutboundQueueResponse(await response.json());
          } catch {
            return null;
          }
        })()
      : Promise.resolve(null);
  const [directory, queue] = await Promise.all([
    directoryPromise,
    queuePromise,
  ]);
  const members = directory ?? [];
  const directoryUnavailable = directory === null;

  if (currentView === "import")
    return (
      <section className="min-w-0 space-y-5 text-[color:var(--team-text)]">
        {header()}
        <div className={`${PANEL} p-4 sm:p-6`}>
          <OutboundImportClient
            members={members}
            defaultMemberId={memberId ?? ""}
            directoryUnavailable={directoryUnavailable}
          />
        </div>
      </section>
    );

  if (!queue)
    return (
      <section className="space-y-5">
        {header()}
        <div role="alert" className={teamStatePanelClass("danger")}>
          <h3 className="font-semibold">Follow-ups could not be loaded</h3>
          <p className="mt-1">
            We couldn’t verify the current accounts and contact restrictions. No
            outreach controls or misleading zero totals are shown.
          </p>
          <a
            href={buildOutboundHref({ memberId, filters })}
            className={`${teamButtonClass("secondary")} mt-3`}
          >
            Retry outbound
          </a>
        </div>
        {members.length ? (
          <form
            method="get"
            action="/team/sales/outbound"
            className={`${PANEL} space-y-3 p-4`}
          >
            <label className="grid gap-1 text-sm font-medium">
              Choose whose follow-ups to open
              <select
                name="memberId"
                defaultValue={memberId ?? ""}
                required
                className={FIELD}
              >
                <option value="">Choose a teammate</option>
                {members.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
              </select>
            </label>
            <p className={`text-sm ${MUTED}`}>
              If a default teammate hasn’t been configured, choose one here to
              open their list.
            </p>
            <button type="submit" className={teamButtonClass("primary")}>
              Open follow-ups
            </button>
          </form>
        ) : null}
      </section>
    );

  const resolvedMemberId = queue.memberId;
  const owner = members.find((member) => member.id === resolvedMemberId)?.name;
  const selected = filters.accountId
    ? queue.items.find((item) => item.id === filters.accountId)
    : filters.taskId
      ? queue.items.find((item) => item.taskIds.includes(filters.taskId!))
      : undefined;
  const selectionRequested = Boolean(filters.accountId || filters.taskId);
  const clearSelectionHref = buildOutboundHref({
    memberId: resolvedMemberId,
    filters,
    patch: { accountId: "", taskId: "" },
  });
  const resetHref = buildOutboundHref({
    memberId: resolvedMemberId,
    filters: {},
  });
  const hasFilters = [
    filters.q,
    filters.campaign,
    filters.attempt,
    filters.due,
    filters.has,
    filters.disposition,
  ].some(Boolean);
  const advancedCount = [
    filters.campaign,
    filters.attempt,
    filters.has,
    filters.disposition,
  ].filter(Boolean).length;
  const quickFilters = [
    { label: "All follow-ups", due: "", disposition: "" },
    { label: "Overdue", due: "overdue", disposition: "" },
    { label: "Due now", due: "due_now", disposition: "" },
    {
      label: "Callbacks today",
      due: "today",
      disposition: "callback_requested",
    },
    { label: "Not started", due: "not_started", disposition: "" },
  ];

  return (
    <section className="min-w-0 space-y-5 text-[color:var(--team-text)]">
      {header(resolvedMemberId)}
      {directoryUnavailable ? (
        <p role="status" className={teamStatePanelClass("warning")}>
          Team names couldn’t be loaded. Your current assignment is preserved;
          reassigning accounts is temporarily unavailable.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <p>
          {owner ? (
            <>
              <span className="font-semibold">{owner}’s</span> follow-ups
            </>
          ) : (
            "Assigned follow-ups"
          )}{" "}
          <span className={MUTED}>
            · {queue.total} matching{" "}
            {queue.total === 1 ? "account" : "accounts"}
          </span>
        </p>
        <a
          href={buildOutboundHref({
            memberId: resolvedMemberId,
            filters,
            patch: { cursor: "", direction: "" },
          })}
          className={`inline-flex min-h-11 items-center rounded-lg px-3 font-semibold ${TEAM_FOCUS_RING}`}
        >
          Refresh list
        </a>
      </div>
      <div className={`${PANEL} p-4`}>
        <nav
          aria-label="Follow-up shortcuts"
          className="mb-4 flex flex-wrap gap-2"
        >
          {quickFilters.map((shortcut) => {
            const active =
              (filters.due ?? "") === shortcut.due &&
              (filters.disposition ?? "") === shortcut.disposition;
            return (
              <a
                key={shortcut.label}
                aria-current={active ? "page" : undefined}
                href={buildOutboundFilterHref({
                  memberId: resolvedMemberId,
                  filters,
                  patch: shortcut,
                })}
                className={`inline-flex min-h-11 items-center rounded-full border px-3 py-2 text-sm font-medium ${TEAM_FOCUS_RING} ${active ? "border-[color:var(--team-focus-ring)] bg-[color:var(--team-surface-muted)]" : "border-[color:var(--team-border)]"}`}
              >
                {shortcut.label}
              </a>
            );
          })}
        </nav>
        <form method="get" action="/team/sales/outbound" className="space-y-3">
          <input type="hidden" name="out_due" value={filters.due ?? ""} />
          <div className="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(140px,220px)_auto]">
            <label className="grid min-w-0 gap-1 text-sm font-medium">
              Find a business or contact
              <input
                type="search"
                name="out_q"
                defaultValue={filters.q ?? ""}
                placeholder="Company, name, phone or email"
                maxLength={200}
                className={FIELD}
              />
            </label>
            <label className="grid min-w-0 gap-1 text-sm font-medium">
              Assigned to
              <select
                name="memberId"
                defaultValue={resolvedMemberId}
                className={FIELD}
              >
                {!members.some((member) => member.id === resolvedMemberId) ? (
                  <option value={resolvedMemberId}>Current teammate</option>
                ) : null}
                {members.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className={teamButtonClass("primary")}>
              Search
            </button>
          </div>
          <details open={advancedCount > 0 || undefined}>
            <summary
              className={`min-h-11 cursor-pointer content-center py-2 text-sm font-medium ${TEAM_FOCUS_RING}`}
            >
              More filters{advancedCount ? ` (${advancedCount} active)` : ""}
            </summary>
            <div className="grid gap-3 pb-2 sm:grid-cols-2 xl:grid-cols-4">
              <FilterSelect
                label="Campaign"
                name="out_campaign"
                value={filters.campaign}
                values={queue.facets.campaigns}
              />
              <FilterSelect
                label="Attempt"
                name="out_attempt"
                value={filters.attempt}
                values={queue.facets.attempts}
              />
              <FilterSelect
                label="Contact details"
                name="out_has"
                value={filters.has}
                values={["phone", "email", "both"]}
              />
              <FilterSelect
                label="Last outcome"
                name="out_disposition"
                value={filters.disposition}
                values={queue.facets.dispositions}
              />
            </div>
            <button
              type="submit"
              className={teamButtonClass("secondary", "sm")}
            >
              Apply filters
            </button>
          </details>
          {hasFilters ? (
            <a
              href={resetHref}
              className={`inline-flex min-h-11 items-center rounded-lg px-2 text-sm underline ${TEAM_FOCUS_RING}`}
            >
              Clear all filters
            </a>
          ) : null}
        </form>
      </div>

      {permissions.canManage && queue.items.length ? (
        <OutboundBulkActions
          key={`${queue.snapshotAt}:${queue.items.map((item) => item.primaryTaskVersion).join(":")}`}
          items={queue.items}
          members={members}
          memberId={resolvedMemberId}
          directoryUnavailable={directoryUnavailable}
          idempotencyKey={`outbound-bulk:${randomUUID()}`}
        />
      ) : null}

      {selectionRequested && !selected ? (
        <div role="status" className={teamStatePanelClass("warning")}>
          <p>
            The selected account is no longer in this list. It may have changed
            or may be outside these filters. No other account has been opened in
            its place.
          </p>
          <a
            className={`${teamButtonClass("secondary", "sm")} mt-2`}
            href={resetHref}
          >
            Show all assigned accounts
          </a>
          <a
            className={`${teamButtonClass("secondary", "sm")} ml-2 mt-2`}
            href={clearSelectionHref}
          >
            Clear selection
          </a>
        </div>
      ) : null}

      <div
        className={`grid min-w-0 items-start gap-5 ${selected ? "xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.9fr)]" : ""}`}
      >
        {selected ? (
          <div className="order-first min-w-0 xl:order-last">
            <OutboundAccountDetail
              item={selected}
              initialTaskId={filters.taskId}
              members={members}
              permissions={permissions}
              closeHref={`${clearSelectionHref}#outbound-list`}
            />
          </div>
        ) : null}
        <div id="outbound-list" className={`${PANEL} scroll-mt-24`}>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[color:var(--team-border)] px-4 py-3">
            <h3 className="font-semibold">Your follow-up list</h3>
            <span className={`text-sm ${MUTED}`}>
              {queue.items.length
                ? `${queue.offset + 1}–${Math.min(queue.offset + queue.items.length, queue.total)} of ${queue.total}`
                : "No matching accounts"}
            </span>
          </div>
          {queue.items.length ? (
            <ul className="divide-y divide-[color:var(--team-border)]">
              {queue.items.map((item) => {
                const contact = item.contacts.find(
                  (candidate) => candidate.id === item.primaryContactId,
                )!;
                const active = selected?.id === item.id;
                return (
                  <li key={item.id}>
                    <a
                      href={`${buildOutboundHref({ memberId: resolvedMemberId, filters, patch: { accountId: item.id, taskId: item.primaryTaskId } })}#outbound-account`}
                      aria-current={active ? "true" : undefined}
                      className={`block min-w-0 p-4 ${TEAM_FOCUS_RING} ${active ? "bg-[color:var(--team-surface-muted)]" : "hover:bg-[color:var(--team-surface-muted)]"}`}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <span className="min-w-0 break-words text-base font-semibold">
                          {item.account.name}
                        </span>
                        <span
                          className={`rounded-full px-2.5 py-1 text-xs font-semibold ${item.overdue ? "bg-rose-100 text-rose-900" : "bg-[color:var(--team-surface-muted)]"}`}
                        >
                          {dueLabel(item)}
                        </span>
                      </div>
                      <p className={`mt-1 break-words text-sm ${MUTED}`}>
                        {contact.name} ·{" "}
                        {contact.email ?? contact.phone ?? "No contact details"}
                      </p>
                      <div
                        className={`mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs ${MUTED}`}
                      >
                        <span>
                          {item.lastDisposition
                            ? item.lastDisposition.replace(/_/g, " ")
                            : "No outcome recorded"}
                        </span>
                        {item.dueAt ? (
                          <span>
                            Due {formatOutboundEasternTime(item.dueAt)}
                          </span>
                        ) : null}
                        {item.contactCount > 1 ? (
                          <span>{item.contactCount} contacts</span>
                        ) : null}
                      </div>
                      {contact.doNotContact ? (
                        <p className="mt-2 text-sm font-semibold text-[color:var(--team-danger-text)]">
                          Do Not Contact — outreach blocked
                        </p>
                      ) : item.dncContactCount > 0 ? (
                        <p className="mt-2 text-sm text-[color:var(--team-warning-text)]">
                          {item.dncContactCount} linked contact restricted
                        </p>
                      ) : null}
                      <span className="mt-2 block text-xs font-semibold">
                        {active ? "Account open" : "Open account →"}
                      </span>
                    </a>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="space-y-3 p-6">
              <h4 className="font-semibold">
                {hasFilters
                  ? "Nothing matches these filters"
                  : "You’re caught up here"}
              </h4>
              <p className={`text-sm ${MUTED}`}>
                {hasFilters
                  ? "Try a different search or clear the filters."
                  : "There are no open follow-up accounts assigned to this teammate."}
              </p>
              {hasFilters ? (
                <a href={resetHref} className={teamButtonClass("secondary")}>
                  Clear filters
                </a>
              ) : canImport ? (
                <a
                  href={buildOutboundHref({
                    memberId: resolvedMemberId,
                    filters,
                    view: "import",
                  })}
                  className={teamButtonClass("secondary")}
                >
                  Import contacts
                </a>
              ) : null}
            </div>
          )}
          {queue.previousCursor || queue.nextCursor ? (
            <nav
              aria-label="Follow-up pages"
              className="flex justify-between gap-3 border-t border-[color:var(--team-border)] p-3"
            >
              {queue.previousCursor ? (
                <a
                  className={teamButtonClass("secondary", "sm")}
                  href={buildOutboundHref({
                    memberId: resolvedMemberId,
                    filters,
                    patch: {
                      cursor: queue.previousCursor,
                      direction: "previous",
                      accountId: "",
                      taskId: "",
                    },
                  })}
                >
                  Previous page
                </a>
              ) : (
                <span />
              )}
              {queue.nextCursor ? (
                <a
                  className={teamButtonClass("secondary", "sm")}
                  href={buildOutboundHref({
                    memberId: resolvedMemberId,
                    filters,
                    patch: {
                      cursor: queue.nextCursor,
                      direction: "next",
                      accountId: "",
                      taskId: "",
                    },
                  })}
                >
                  Next page
                </a>
              ) : null}
            </nav>
          ) : null}
        </div>
      </div>
      <ActivitySummary queue={queue} />
      <p className={`text-xs ${MUTED}`}>
        Updated {formatOutboundEasternTime(queue.snapshotAt)}. Refresh for the
        latest changes. Dates and callbacks use Eastern time.
      </p>
    </section>
  );
}

function FilterSelect({
  label,
  name,
  value,
  values,
}: {
  label: string;
  name: string;
  value?: string;
  values: string[];
}) {
  const options = Array.from(new Set([...(value ? [value] : []), ...values]));
  return (
    <label className="grid min-w-0 gap-1 text-sm font-medium">
      {label}
      <select name={name} defaultValue={value ?? ""} className={FIELD}>
        <option value="">All</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option.replace(/_/g, " ")}
          </option>
        ))}
      </select>
    </label>
  );
}

function ActivitySummary({ queue }: { queue: OutboundQueueResponse }) {
  const stats = queue.summary.scoreboard;
  if (!stats) return null;
  return (
    <details className={`${PANEL} p-4`}>
      <summary
        className={`min-h-11 cursor-pointer content-center text-sm font-semibold ${TEAM_FOCUS_RING}`}
      >
        Activity summary
      </summary>
      <p className={`my-3 text-sm ${MUTED}`}>
        For this teammate and campaign, including accounts outside the current
        search and due filters. Partner status here describes the CRM
        relationship, not portal access.
      </p>
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          ["Accounts contacted", stats.accountsTouched],
          ["Conversations", stats.conversationsStarted],
          ["Qualified relationships", stats.qualifiedPartners],
          ["Active relationships", stats.activePartners],
        ].map(([label, value]) => (
          <div key={label}>
            <dt className={`text-sm ${MUTED}`}>{label}</dt>
            <dd className="mt-1 text-xl font-semibold">{value}</dd>
          </div>
        ))}
      </dl>
      <p className={`mt-4 text-sm ${MUTED}`}>
        Suggested service approach: portal {stats.partnerPathMix.portalFirst},
        direct contact {stats.partnerPathMix.managedDirect}, either{" "}
        {stats.partnerPathMix.hybrid}, not a fit {stats.partnerPathMix.notAFit}.
        Average fit score:{" "}
        {stats.avgFitScore === null
          ? "Not assessed"
          : `${stats.avgFitScore}/100`}
        .
      </p>
    </details>
  );
}
