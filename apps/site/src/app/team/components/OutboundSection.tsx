import { randomUUID } from "node:crypto";
import {
  hasTeamPermission,
  requireCurrentTeamPrincipal,
} from "@/lib/team-principal";
import { callAdminApiAs } from "../lib/api";
import {
  loadInboxConversation,
  loadInboxList,
  type InboxInput,
} from "../inbox-loader";
import { outboundOutcomeLabel } from "../outbound-detail";
import {
  buildOutboundCommunicationHref,
  buildOutboundHref,
  buildOutboundFilterHref,
  buildOutboundPartnersHref,
  buildOutboundPartnerSetupHref,
  type OutboundFilters,
  type OutboundCommunicationChannel,
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
import { OutboundOutreachProgress } from "./OutboundOutreachProgress";
import { InboxView } from "./InboxView";

const PANEL =
  "min-w-0 rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-card)] shadow-[0_8px_22px_var(--team-card-shadow)]";
const FIELD = `${TEAM_INPUT_COMPACT} !text-base w-full min-w-0`;
const MUTED = "text-[color:var(--team-text-muted)]";

function dueLabel(item: OutboundQueueItem) {
  if (!item.dueAt) return "Not started";
  if (item.overdue) return "Overdue";
  if (item.minutesUntilDue !== null && item.minutesUntilDue <= 0)
    return "Due now";
  return "Scheduled";
}

function dueBadgeClass(item: OutboundQueueItem) {
  if (item.overdue)
    return "bg-[color:var(--team-danger-surface)] text-[color:var(--team-danger-text)]";
  if (item.minutesUntilDue !== null && item.minutesUntilDue <= 0)
    return "bg-[color:var(--team-warning-surface)] text-[color:var(--team-warning-text)]";
  if (item.dueAt)
    return "bg-[color:var(--team-info-surface)] text-[color:var(--team-info-text)]";
  return "bg-[color:var(--team-surface-muted)] text-[color:var(--team-text-muted)]";
}

function outcomeBadgeClass(value: string | null) {
  if (value === "partner" || value === "connected")
    return "border-[color:var(--team-success-border)] bg-[color:var(--team-success-surface)] text-[color:var(--team-success-text)]";
  if (value === "callback_requested")
    return "border-[color:var(--team-warning-border)] bg-[color:var(--team-warning-surface)] text-[color:var(--team-warning-text)]";
  if (value === "email_sent")
    return "border-[color:var(--team-info-border)] bg-[color:var(--team-info-surface)] text-[color:var(--team-info-text)]";
  if (value === "not_interested" || value === "dnc")
    return "border-[color:var(--team-danger-border)] bg-[color:var(--team-danger-surface)] text-[color:var(--team-danger-text)]";
  return "border-[color:var(--team-border)] bg-[color:var(--team-surface-muted)] text-[color:var(--team-text-muted)]";
}

function OutboundHeader({
  memberId,
  filters,
  view,
  canInbox,
  canImport,
  canPartners,
  canCreatePartner,
}: {
  memberId?: string;
  filters: OutboundFilters;
  view: "queue" | "inbox" | "import";
  canInbox: boolean;
  canImport: boolean;
  canPartners: boolean;
  canCreatePartner: boolean;
}) {
  return (
    <header
      className={`${PANEL} space-y-3 border-t-4 border-t-[color:var(--team-brand-green)] p-4`}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">
            Partner Outreach
          </h2>
          <p className={`mt-1 text-sm ${MUTED}`}>
            Work interested business prospects from first contact through a
            confirmed partner relationship.
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
        aria-label="Partner Outreach views"
        className="flex flex-wrap gap-1 border-b border-[color:var(--team-border)] pb-2"
      >
        {[
          {
            label: "Work Queue",
            href: buildOutboundHref({ memberId, filters }),
            active: view === "queue",
            show: true,
          },
          {
            label: "Prospect Inbox",
            href: buildOutboundHref({ memberId, filters, view: "inbox" }),
            active: view === "inbox",
            show: canInbox,
          },
          {
            label: "Import",
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
              className={`inline-flex min-h-11 items-center rounded-xl px-4 py-2 text-sm font-semibold lg:min-h-10 ${TEAM_FOCUS_RING} ${link.active ? "bg-[color:var(--team-selection)] text-[color:var(--team-brand-green-strong)]" : `${MUTED} hover:bg-[color:var(--team-surface-muted)]`}`}
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
  inbox = {},
}: {
  memberId?: string;
  filters?: OutboundFilters;
  view?: string;
  inbox?: InboxInput;
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
  const canReadMessages = hasTeamPermission(principal, "messages.read");
  const canSendMessages =
    canReadMessages && hasTeamPermission(principal, "messages.send");
  const canImport = hasTeamPermission(principal, "outbound.import");
  const canInbox = canReadMessages;
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
  const currentView = view === "import" || view === "inbox" ? view : "queue";
  const header = (selectedMember = memberId) => (
    <OutboundHeader
      memberId={selectedMember}
      filters={filters}
      view={currentView}
      canImport={canImport}
      canInbox={canInbox}
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
            prospect work queue.
          </p>
          <a
            href={buildOutboundHref({ memberId, filters })}
            className={`${teamButtonClass("secondary")} mt-3`}
          >
            Back to Work Queue
          </a>
        </div>
      </section>
    );

  if (currentView === "inbox" && !canInbox)
    return (
      <section className="space-y-5">
        {header()}
        <div role="status" className={teamStatePanelClass("warning")}>
          <h3 className="font-semibold">Inbox access is required</h3>
          <p className="mt-1">
            Ask your administrator for conversation access. You can still work
            prospects from the Work Queue.
          </p>
          <a
            href={buildOutboundHref({ memberId, filters })}
            className={`${teamButtonClass("secondary")} mt-3`}
          >
            Back to Work Queue
          </a>
        </div>
      </section>
    );

  if (currentView === "inbox") {
    const scopedInbox: InboxInput = {
      ...inbox,
      scope: "outbound",
      outboundCampaign: filters.campaign,
      outboundSegment: filters.segment,
      outboundMemberId: memberId,
    };
    const read = (path: string) => callAdminApiAs(principal, path);
    const [list, conversation] = await Promise.all([
      loadInboxList(scopedInbox, read),
      loadInboxConversation(scopedInbox, read),
    ]);
    return (
      <section className="min-w-0 space-y-4 text-[color:var(--team-text)]">
        {header()}
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <p className={MUTED}>
            Active prospect conversations
            {filters.campaign ? ` · ${filters.campaign}` : " · all campaigns"}
          </p>
          <a
            href={buildOutboundHref({ memberId, filters })}
            className={teamButtonClass("secondary", "sm")}
          >
            Open Work Queue
          </a>
        </div>
        <div className="flex h-[calc(100dvh-17rem)] min-h-[34rem] min-w-0 flex-col">
          <InboxView
            mode="outbound"
            input={scopedInbox}
            access={{
              employeeId: principal.memberId,
              canSend: hasTeamPermission(principal, "messages.send"),
              canDraft: hasTeamPermission(principal, "messages.write"),
              canEditContact: hasTeamPermission(principal, "contacts.write"),
              canPlaceCalls: hasTeamPermission(principal, "calls.place"),
              canReadContacts: hasTeamPermission(principal, "contacts.read"),
            }}
            list={list}
            conversation={conversation}
            outboundNavigation={{ memberId, filters }}
          />
        </div>
      </section>
    );
  }

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
    "segment",
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
          <h3 className="font-semibold">Work Queue could not be loaded</h3>
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
              Choose whose prospects to open
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
              Open Work Queue
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
    filters.segment,
    filters.attempt,
    filters.due,
    filters.has,
    filters.disposition,
  ].some(Boolean);
  const advancedCount = [
    filters.campaign,
    filters.segment,
    filters.attempt,
    filters.has,
    filters.disposition,
  ].filter(Boolean).length;
  const quickFilters = [
    { label: "All prospects", due: "", disposition: "" },
    { label: "Overdue", due: "overdue", disposition: "" },
    { label: "Due now", due: "due_now", disposition: "" },
    {
      label: "Callbacks today",
      due: "today",
      disposition: "callback_requested",
    },
    { label: "Not started", due: "not_started", disposition: "" },
  ];
  const selectedIndex = selected
    ? queue.items.findIndex((item) => item.id === selected.id)
    : -1;
  const previousProspect =
    selectedIndex > 0 ? queue.items[selectedIndex - 1] : undefined;
  const nextProspect =
    selectedIndex >= 0 ? queue.items[selectedIndex + 1] : undefined;
  const isWorkableProspect = (item: OutboundQueueItem) =>
    item.tasks.some(
      (task) => task.id === item.primaryTaskId && !task.doNotContact,
    );
  const firstWorkableProspect = queue.items.find(isWorkableProspect);
  const nextWorkableProspect =
    selectedIndex >= 0
      ? queue.items.slice(selectedIndex + 1).find(isWorkableProspect)
      : undefined;
  const prospectHref = (item: OutboundQueueItem) =>
    buildOutboundHref({
      memberId: resolvedMemberId,
      filters,
      patch: { accountId: item.id, taskId: item.primaryTaskId },
    });
  const afterOutcomeHref = nextWorkableProspect
    ? prospectHref(nextWorkableProspect)
    : clearSelectionHref;
  const requestedTask = filters.taskId
    ? selected?.tasks.find((task) => task.id === filters.taskId)
    : undefined;
  const communicationContact = selected
    ? (selected.contacts.find((contact) => contact.id === inbox.contactId) ??
      selected.contacts.find(
        (contact) => contact.id === requestedTask?.contactId,
      ) ??
      selected.contacts.find(
        (contact) => contact.id === selected.primaryContactId,
      ) ??
      selected.contacts[0])
    : undefined;
  const communicationTask =
    selected && communicationContact
      ? (selected.tasks.find(
          (task) =>
            task.id === filters.taskId &&
            task.contactId === communicationContact.id,
        ) ??
        selected.tasks.find(
          (task) =>
            task.id === selected.primaryTaskId &&
            task.contactId === communicationContact.id,
        ) ??
        selected.tasks.find(
          (task) => task.contactId === communicationContact.id,
        ))
      : undefined;
  const communicationChannels: OutboundCommunicationChannel[] = [];
  if (communicationContact?.email?.trim()) communicationChannels.push("email");
  if (communicationContact?.phone?.trim()) communicationChannels.push("sms");
  const requestedCommunicationChannel =
    inbox.channel === "email" || inbox.channel === "sms"
      ? inbox.channel
      : undefined;
  const communicationChannel =
    requestedCommunicationChannel &&
    communicationChannels.includes(requestedCommunicationChannel)
      ? requestedCommunicationChannel
      : (communicationChannels[0] ?? null);
  const communicationConversations = Object.fromEntries(
    selected && communicationContact && canReadMessages
      ? await Promise.all(
          communicationChannels.map(async (channel) => [
            channel,
            await loadInboxConversation(
              {
                contactId: communicationContact.id,
                channel,
                threadId:
                  inbox.contactId === communicationContact.id &&
                  inbox.channel === channel
                    ? inbox.threadId
                    : undefined,
                messageLimit: "50",
                scope: "outbound",
                outboundCampaign: filters.campaign,
                outboundSegment: filters.segment,
                outboundMemberId: resolvedMemberId,
              },
              (path) => callAdminApiAs(principal, path),
            ),
          ]),
        )
      : [],
  ) as Partial<
    Record<
      OutboundCommunicationChannel,
      Awaited<ReturnType<typeof loadInboxConversation>>
    >
  >;
  const communicationHref = (args: {
    contactId: string;
    channel: OutboundCommunicationChannel;
    taskId?: string;
    view?: "queue" | "inbox";
    threadId?: string | null;
  }) =>
    buildOutboundCommunicationHref({
      memberId: resolvedMemberId,
      view: args.view,
      filters,
      patch: {
        accountId: selected?.id,
        taskId: args.taskId ?? "",
      },
      contactId: args.contactId,
      channel: args.channel,
      threadId: args.threadId,
    });
  const defaultChannelFor = (
    contact: OutboundQueueItem["contacts"][number],
  ): OutboundCommunicationChannel => {
    if (communicationChannel === "email" && contact.email?.trim())
      return "email";
    if (communicationChannel === "sms" && contact.phone?.trim()) return "sms";
    return contact.email?.trim() ? "email" : "sms";
  };
  const contactHrefs = Object.fromEntries(
    (selected?.contacts ?? []).map((contact) => {
      const task = selected?.tasks.find(
        (candidate) => candidate.contactId === contact.id,
      );
      return [
        contact.id,
        String(
          communicationHref({
            contactId: contact.id,
            channel: defaultChannelFor(contact),
            taskId: task?.id,
          }),
        ),
      ];
    }),
  );
  const taskHrefs = Object.fromEntries(
    (selected?.tasks ?? [])
      .filter((task) => task.contactId === communicationContact?.id)
      .map((task) => [
        task.id,
        String(
          communicationHref({
            contactId: communicationContact!.id,
            channel:
              communicationChannel ?? defaultChannelFor(communicationContact!),
            taskId: task.id,
          }),
        ),
      ]),
  );
  const channelHrefs = communicationContact
    ? {
        ...(communicationContact.phone?.trim()
          ? {
              sms: String(
                communicationHref({
                  contactId: communicationContact.id,
                  channel: "sms",
                  taskId: communicationTask?.id,
                }),
              ),
            }
          : {}),
        ...(communicationContact.email?.trim()
          ? {
              email: String(
                communicationHref({
                  contactId: communicationContact.id,
                  channel: "email",
                  taskId: communicationTask?.id,
                }),
              ),
            }
          : {}),
      }
    : {};
  const historyReturnHrefs = Object.fromEntries(
    communicationContact
      ? communicationChannels.map((channel) => [
          channel,
          String(
            communicationHref({
              contactId: communicationContact.id,
              channel,
              taskId: communicationTask?.id,
            }),
          ),
        ])
      : [],
  ) as Partial<Record<OutboundCommunicationChannel, string>>;
  const fullInboxHrefs = Object.fromEntries(
    communicationContact
      ? communicationChannels.map((channel) => [
          channel,
          String(
            communicationHref({
              contactId: communicationContact.id,
              channel,
              taskId: communicationTask?.id,
              view: "inbox",
              threadId: communicationConversations[channel]?.detail
                ? communicationConversations[channel]?.selectedThreadId
                : null,
            }),
          ),
        ])
      : [],
  ) as Partial<Record<OutboundCommunicationChannel, string>>;

  return (
    <section className="min-w-0 space-y-5 text-[color:var(--team-text)]">
      {header(resolvedMemberId)}
      {directoryUnavailable ? (
        <p role="status" className={teamStatePanelClass("warning")}>
          Team names couldn’t be loaded. Your current assignment is preserved;
          reassigning accounts is temporarily unavailable.
        </p>
      ) : null}
      <div className={`${PANEL} overflow-hidden`}>
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
          <p>
            {owner ? (
              <>
                <span className="font-semibold">{owner}’s</span> prospects
              </>
            ) : (
              "Assigned prospects"
            )}{" "}
            <span className={MUTED}>
              · {queue.total} matching{" "}
              {queue.total === 1 ? "account" : "accounts"}
            </span>
          </p>
          <div className="flex flex-wrap gap-2">
            {!selected && firstWorkableProspect ? (
              <a
                href={`${prospectHref(firstWorkableProspect)}#outbound-account`}
                className={teamButtonClass("primary", "sm")}
              >
                Work next prospect
              </a>
            ) : null}
            <a
              href={buildOutboundHref({
                memberId: resolvedMemberId,
                filters,
                patch: { cursor: "", direction: "" },
              })}
              className={`inline-flex min-h-11 items-center rounded-lg px-3 font-semibold lg:min-h-9 ${TEAM_FOCUS_RING}`}
            >
              Refresh queue
            </a>
          </div>
        </div>
        <div className="border-t border-[color:var(--team-border)] p-3 sm:p-4">
          <nav
            aria-label="Follow-up shortcuts"
            className="mb-3 flex flex-wrap gap-1 rounded-xl bg-[color:var(--team-surface-muted)] p-1"
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
                  className={`inline-flex min-h-11 items-center rounded-lg border px-3 py-1.5 text-sm font-medium lg:min-h-9 ${TEAM_FOCUS_RING} ${active ? "border-[color:var(--team-control-hover-border)] bg-[color:var(--team-surface)] text-[color:var(--team-brand-green-strong)] shadow-sm" : "border-transparent text-[color:var(--team-text-muted)] hover:border-[color:var(--team-border)] hover:bg-[color:var(--team-surface)]"}`}
                >
                  {shortcut.label}
                </a>
              );
            })}
          </nav>
          <form
            method="get"
            action="/team/sales/outbound"
            className="space-y-3"
          >
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
              <div className="grid gap-3 pb-2 sm:grid-cols-2 xl:grid-cols-5">
                <FilterSelect
                  label="Campaign"
                  name="out_campaign"
                  value={filters.campaign}
                  values={queue.facets.campaigns}
                />
                <FilterSelect
                  label="Company type"
                  name="out_segment"
                  value={filters.segment}
                  values={queue.facets.segments}
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
        className={`grid min-w-0 items-start gap-4 ${queue.items.length ? "xl:h-[calc(100dvh-8rem)] xl:min-h-[34rem] xl:max-h-[56rem] xl:items-stretch" : ""} ${selected ? "xl:grid-cols-[minmax(22rem,0.92fr)_minmax(27rem,1.08fr)]" : ""}`}
      >
        {selected ? (
          <div className="order-first min-w-0 xl:order-last xl:h-full xl:min-h-0 xl:self-stretch xl:overflow-y-auto xl:overscroll-contain xl:pr-1">
            <nav
              aria-label="Prospect navigation"
              className="mb-2 flex min-h-11 items-center justify-between gap-2 xl:sticky xl:top-0 xl:z-10 xl:bg-[color:var(--team-app-bg)] xl:py-1"
            >
              {previousProspect ? (
                <a
                  href={`${prospectHref(previousProspect)}#outbound-account`}
                  className={teamButtonClass("secondary", "sm")}
                >
                  Previous prospect
                </a>
              ) : (
                <span />
              )}
              {nextProspect ? (
                <a
                  href={`${prospectHref(nextProspect)}#outbound-account`}
                  className={teamButtonClass("secondary", "sm")}
                >
                  Next prospect
                </a>
              ) : null}
            </nav>
            <OutboundAccountDetail
              item={selected}
              initialTaskId={communicationTask?.id}
              members={members}
              permissions={permissions}
              closeHref={`${clearSelectionHref}#outbound-list`}
              afterOutcomeHref={afterOutcomeHref}
              communication={
                communicationContact
                  ? {
                      employeeId: principal.memberId,
                      contactId: communicationContact.id,
                      taskId: communicationTask?.id,
                      channel: communicationChannel,
                      conversations: communicationConversations,
                      contactHrefs,
                      taskHrefs,
                      channelHrefs,
                      historyReturnHrefs,
                      fullInboxHrefs,
                      canCall: permissions.canCall,
                      canReadMessages,
                      canSendMessages,
                    }
                  : undefined
              }
            />
          </div>
        ) : null}
        <div
          id="outbound-list"
          className={`${PANEL} scroll-mt-24 xl:flex xl:h-full xl:min-h-0 xl:flex-col xl:overflow-hidden`}
        >
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[color:var(--team-border)] px-4 py-3">
            <h3 className="font-semibold">Prospect work queue</h3>
            <span className={`text-sm ${MUTED}`}>
              {queue.items.length
                ? `${queue.offset + 1}–${Math.min(queue.offset + queue.items.length, queue.total)} of ${queue.total}`
                : "No matching accounts"}
            </span>
          </div>
          {queue.items.length ? (
            <ul className="divide-y divide-[color:var(--team-border)] xl:min-h-0 xl:flex-1 xl:overflow-y-auto xl:overscroll-contain">
              {queue.items.map((item) => {
                const contact = item.contacts.find(
                  (candidate) => candidate.id === item.primaryContactId,
                )!;
                const active = selected?.id === item.id;
                return (
                  <li key={item.id}>
                    <a
                      href={`${prospectHref(item)}#outbound-account`}
                      aria-current={active ? "true" : undefined}
                      className={`block min-w-0 border-l-4 px-3 py-3 transition ${TEAM_FOCUS_RING} ${active ? "border-l-[color:var(--team-brand-green)] bg-[color:var(--team-selection)] shadow-[inset_0_0_0_1px_var(--team-selection-strong)]" : "border-l-transparent hover:bg-[color:var(--team-surface-muted)]"}`}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <span className="min-w-0 break-words text-sm font-semibold sm:text-base">
                          {item.account.name}
                        </span>
                        <span
                          className={`rounded-full px-2.5 py-1 text-xs font-semibold ${dueBadgeClass(item)}`}
                        >
                          {dueLabel(item)}
                        </span>
                      </div>
                      <p className={`mt-1 truncate text-sm ${MUTED}`}>
                        {contact.name} ·{" "}
                        {contact.email ?? contact.phone ?? "No contact details"}
                      </p>
                      {item.account.segment ||
                      item.account.priority ||
                      item.account.importedStatus ? (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {item.account.segment ? (
                            <span className="rounded-full border border-[color:var(--team-border)] bg-[color:var(--team-surface-muted)] px-2 py-0.5 text-[11px] font-medium text-[color:var(--team-text-muted)]">
                              {item.account.segment.replace(/_/g, " ")}
                            </span>
                          ) : null}
                          {item.account.priority ? (
                            <span className="rounded-full border border-[color:var(--team-warning-border)] bg-[color:var(--team-warning-surface)] px-2 py-0.5 text-[11px] font-medium text-[color:var(--team-warning-text)]">
                              {item.account.priority} priority
                            </span>
                          ) : null}
                          {item.account.importedStatus ? (
                            <span className="rounded-full border border-[color:var(--team-info-border)] bg-[color:var(--team-info-surface)] px-2 py-0.5 text-[11px] font-medium text-[color:var(--team-info-text)]">
                              {item.account.importedStatus}
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                      <div className="mt-2">
                        <OutboundOutreachProgress
                          outreach={item.outreach}
                          compact
                        />
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                        <span
                          className={`rounded-full border px-2 py-0.5 font-medium ${outcomeBadgeClass(item.lastDisposition)}`}
                        >
                          {outboundOutcomeLabel(item.lastDisposition)}
                        </span>
                        {item.dueAt ? (
                          <span className={MUTED}>
                            Due {formatOutboundEasternTime(item.dueAt)}
                          </span>
                        ) : null}
                        {item.contactCount > 1 ? (
                          <span className={MUTED}>
                            {item.contactCount} contacts
                          </span>
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
                  : "There are no open prospect accounts assigned to this teammate."}
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
              aria-label="Prospect pages"
              className="flex shrink-0 justify-between gap-3 border-t border-[color:var(--team-border)] p-3"
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
