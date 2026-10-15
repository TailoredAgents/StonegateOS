import type { loadInboxConversation } from "../inbox-loader";
import { resolveOutboundContactContext } from "../outbound-detail";
import type { OutboundCommunicationChannel } from "../outbound-navigation";
import type { OutboundQueueItem } from "../outbound-queue";
import { InboxComposerClient } from "./InboxComposerClient";
import { InboxMessage } from "./InboxMessage";
import { OutboundCommunicationClient } from "./OutboundCommunicationClient";
import { teamButtonClass, teamStatePanelClass } from "./team-ui";

type Conversation = Awaited<ReturnType<typeof loadInboxConversation>>;

export type OutboundCommunicationWorkspace = {
  employeeId: string;
  contactId: string;
  taskId?: string;
  channel: OutboundCommunicationChannel | null;
  conversations: Partial<
    Record<OutboundCommunicationChannel, Conversation | null>
  >;
  contactHrefs: Record<string, string>;
  taskHrefs: Record<string, string>;
  channelHrefs: Partial<Record<OutboundCommunicationChannel, string>>;
  historyReturnHrefs: Partial<Record<OutboundCommunicationChannel, string>>;
  fullInboxHrefs: Partial<Record<OutboundCommunicationChannel, string>>;
  canCall: boolean;
  canReadMessages: boolean;
  canSendMessages: boolean;
};

export function OutboundCommunicationPanel({
  item,
  workspace,
}: {
  item: Pick<
    OutboundQueueItem,
    "contacts" | "tasks" | "primaryContactId" | "primaryTaskId"
  >;
  workspace: OutboundCommunicationWorkspace;
}) {
  const context = resolveOutboundContactContext(
    item,
    workspace.contactId,
    workspace.taskId,
  );
  if (!context) {
    return (
      <div role="status" className={teamStatePanelClass("warning")}>
        This contact is no longer available in the current queue snapshot.
        Refresh before starting outreach.
      </div>
    );
  }

  const { contact, task, outreachBlocked } = context;
  const emailPanel = contact.email?.trim() ? (
    <OutboundChannelPanel
      employeeId={workspace.employeeId}
      contactId={contact.id}
      channel="email"
      destination={contact.email.trim()}
      conversation={workspace.conversations.email ?? null}
      historyReturnHref={workspace.historyReturnHrefs.email}
      fullInboxHref={workspace.fullInboxHrefs.email}
      canSendMessages={workspace.canSendMessages}
      outreachBlocked={outreachBlocked}
    />
  ) : undefined;
  const smsPanel = contact.phone?.trim() ? (
    <OutboundChannelPanel
      employeeId={workspace.employeeId}
      contactId={contact.id}
      channel="sms"
      destination={contact.phone.trim()}
      conversation={workspace.conversations.sms ?? null}
      historyReturnHref={workspace.historyReturnHrefs.sms}
      fullInboxHref={workspace.fullInboxHrefs.sms}
      canSendMessages={workspace.canSendMessages}
      outreachBlocked={outreachBlocked}
    />
  ) : undefined;

  return (
    <section
      id="outbound-communication"
      aria-labelledby="outbound-communication-title"
      className="scroll-mt-24 overflow-hidden rounded-xl border border-[color:var(--team-border-strong)] bg-[color:var(--team-elevated)]"
    >
      <header className="border-b border-[color:var(--team-border)] bg-[color:var(--team-panel-alt)] px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[color:var(--team-brand-green-strong)]">
              Contact workspace
            </p>
            <h3
              id="outbound-communication-title"
              className="mt-1 truncate text-base font-semibold"
            >
              {contact.name}
            </h3>
            <p className="mt-1 break-words text-xs text-[color:var(--team-text-muted)]">
              {[contact.phone, contact.email].filter(Boolean).join(" · ") ||
                "No phone number or email saved"}
            </p>
          </div>
        </div>

        {item.contacts.length > 1 ? (
          <nav
            aria-label="Company contacts"
            className="mt-3 flex flex-wrap gap-2"
          >
            {item.contacts.map((candidate) => {
              const active = candidate.id === contact.id;
              return (
                <a
                  key={candidate.id}
                  href={workspace.contactHrefs[candidate.id]}
                  aria-current={active ? "page" : undefined}
                  className={`inline-flex min-h-9 items-center rounded-xl border px-3 py-1.5 text-xs font-semibold transition ${
                    active
                      ? "border-[color:var(--team-control-hover-border)] bg-[color:var(--team-selection)] text-[color:var(--team-brand-green-strong)]"
                      : "border-[color:var(--team-border)] bg-[color:var(--team-surface)] text-[color:var(--team-text-muted)] hover:bg-[color:var(--team-surface-muted)]"
                  }`}
                >
                  {candidate.name}
                  {candidate.doNotContact ? " · DNC" : ""}
                </a>
              );
            })}
          </nav>
        ) : null}
      </header>

      <OutboundCommunicationClient
        contactId={contact.id}
        contactName={contact.name}
        phone={contact.phone}
        taskId={task?.id}
        initialChannel={workspace.channel}
        channelHrefs={workspace.channelHrefs}
        fullInboxHrefs={workspace.fullInboxHrefs}
        emailPanel={emailPanel}
        smsPanel={smsPanel}
        canCall={workspace.canCall}
        canReadMessages={workspace.canReadMessages}
        outreachBlocked={outreachBlocked}
      />

      {!outreachBlocked ? (
        <p className="border-t border-[color:var(--team-border)] bg-[color:var(--team-surface-muted)] px-4 py-2.5 text-xs text-[color:var(--team-text-muted)]">
          Delivered messages and confirmed calls update the outreach checks
          automatically. Record the outcome below to schedule the next step.
        </p>
      ) : null}
    </section>
  );
}

function OutboundChannelPanel({
  employeeId,
  contactId,
  channel,
  destination,
  conversation,
  historyReturnHref,
  fullInboxHref,
  canSendMessages,
  outreachBlocked,
}: {
  employeeId: string;
  contactId: string;
  channel: OutboundCommunicationChannel;
  destination: string;
  conversation: Conversation | null;
  historyReturnHref?: string;
  fullInboxHref?: string;
  canSendMessages: boolean;
  outreachBlocked: boolean;
}) {
  const threadId = conversation?.selectedThreadId ?? null;
  const messages = (
    conversation?.detail?.messages ??
    conversation?.timeline?.messages ??
    []
  ).filter(
    (message) =>
      message.channel === channel && message.metadata?.["draft"] !== true,
  );
  const recentMessages = messages.slice(-8);
  const hasOlderMessages =
    messages.length > recentMessages.length ||
    Boolean(conversation?.detail?.messagePage.hasOlder);
  const canCompose =
    canSendMessages && !outreachBlocked && !conversation?.error;

  return (
    <div className="overflow-hidden rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[color:var(--team-border)] px-3 py-2">
        <p className="min-w-0 truncate text-xs text-[color:var(--team-text-muted)]">
          {destination}
        </p>
        {hasOlderMessages && fullInboxHref ? (
          <a
            href={fullInboxHref}
            className="text-xs font-semibold text-[color:var(--team-link)] hover:underline"
          >
            Earlier messages
          </a>
        ) : null}
      </div>
      <div
        aria-label={`Recent ${channel === "email" ? "email" : "text"} messages`}
        className="max-h-72 space-y-3 overflow-y-auto bg-[color:var(--team-surface-muted)] px-3 py-3"
      >
        {conversation?.error ? (
          <div role="alert" className={teamStatePanelClass("warning")}>
            <p className="font-semibold">Messages could not be loaded</p>
            <p className="mt-1">{conversation.error.message}</p>
            {historyReturnHref ? (
              <a
                href={historyReturnHref}
                className={`${teamButtonClass("secondary", "sm")} mt-3`}
              >
                Retry
              </a>
            ) : null}
          </div>
        ) : recentMessages.length && threadId ? (
          recentMessages.map((message) => (
            <InboxMessage
              key={message.id}
              message={message}
              canSend={canSendMessages}
              threadId={threadId}
              contactId={contactId}
              channel={channel}
            />
          ))
        ) : (
          <div className="flex min-h-24 items-center justify-center py-4 text-center">
            <div>
              <p className="text-sm font-medium text-[color:var(--team-text)]">
                No {channel === "email" ? "emails" : "text messages"} yet
              </p>
              <p className="mt-1 text-xs text-[color:var(--team-text-muted)]">
                Start the conversation below.
              </p>
            </div>
          </div>
        )}
      </div>
      <div className="border-t border-[color:var(--team-border)] bg-[color:var(--team-card)] p-3">
        {canCompose ? (
          <InboxComposerClient
            employeeId={employeeId}
            threadId={threadId}
            contactId={contactId}
            channel={channel}
            isPartnerConversation={false}
            initialSubject={conversation?.detail?.thread.subject ?? ""}
            historyReturnHref={historyReturnHref}
          />
        ) : conversation?.error ? (
          <p className="text-xs text-[color:var(--team-text-muted)]">
            Messaging is paused until the conversation history loads
            successfully.
          </p>
        ) : !canSendMessages ? (
          <p className="text-xs text-[color:var(--team-text-muted)]">
            Send-message permission is required to contact this prospect.
          </p>
        ) : null}
      </div>
    </div>
  );
}
