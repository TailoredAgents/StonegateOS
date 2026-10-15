import { randomUUID } from "node:crypto";
import { SubmitButton } from "@/components/SubmitButton";
import { startContactCallAction } from "../actions";
import type { loadInboxConversation } from "../inbox-loader";
import { resolveOutboundContactContext } from "../outbound-detail";
import type { OutboundCommunicationChannel } from "../outbound-navigation";
import type { OutboundQueueItem } from "../outbound-queue";
import { InboxComposerClient } from "./InboxComposerClient";
import { InboxMessage } from "./InboxMessage";
import { teamButtonClass, teamStatePanelClass } from "./team-ui";

type Conversation = Awaited<ReturnType<typeof loadInboxConversation>>;

export type OutboundCommunicationWorkspace = {
  employeeId: string;
  contactId: string;
  taskId?: string;
  channel: OutboundCommunicationChannel | null;
  conversation: Conversation | null;
  contactHrefs: Record<string, string>;
  taskHrefs: Record<string, string>;
  channelHrefs: Partial<Record<OutboundCommunicationChannel, string>>;
  historyReturnHref: string;
  fullInboxHref: string;
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

  const { contact, task, channels, outreachBlocked } = context;
  const channel =
    workspace.channel && channels.includes(workspace.channel)
      ? workspace.channel
      : null;
  const conversation = workspace.conversation;
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
  const destination =
    channel === "email" ? contact.email?.trim() : contact.phone?.trim();
  const canCompose =
    Boolean(channel && destination) &&
    workspace.canReadMessages &&
    workspace.canSendMessages &&
    !outreachBlocked &&
    !conversation?.error;

  return (
    <section
      id="outbound-communication"
      aria-labelledby="outbound-communication-title"
      className="scroll-mt-24 overflow-hidden rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-elevated)]"
    >
      <header className="border-b border-[color:var(--team-border)] bg-[color:var(--team-panel-alt)] px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-[color:var(--team-brand-green-strong)]">
              Contact workspace
            </p>
            <h3
              id="outbound-communication-title"
              className="mt-1 text-base font-semibold"
            >
              {contact.name}
            </h3>
            <p className="mt-1 break-words text-xs text-[color:var(--team-text-muted)]">
              {[contact.phone, contact.email].filter(Boolean).join(" · ") ||
                "No phone number or email saved"}
            </p>
          </div>
          {workspace.canReadMessages ? (
            <a
              href={workspace.fullInboxHref}
              className={teamButtonClass("secondary", "sm")}
            >
              Open full Prospect Inbox
            </a>
          ) : null}
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
                  className={`inline-flex min-h-10 items-center rounded-xl border px-3 py-2 text-xs font-semibold transition ${
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

      <div className="p-4">
        <div
          role="group"
          aria-label="Outreach channel"
          className="grid grid-cols-3 gap-2"
        >
          {workspace.canCall && contact.phone?.trim() && !outreachBlocked ? (
            <form action={startContactCallAction}>
              <input type="hidden" name="contactId" value={contact.id} />
              {task ? (
                <input type="hidden" name="taskId" value={task.id} />
              ) : null}
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
              <SubmitButton
                className={`${teamButtonClass("primary", "sm")} w-full`}
                pendingLabel="Calling…"
              >
                Call
              </SubmitButton>
            </form>
          ) : (
            <span
              aria-disabled="true"
              className="inline-flex min-h-11 items-center justify-center rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface-muted)] px-3 py-2 text-xs font-semibold text-[color:var(--team-text-soft)] opacity-70"
            >
              Call
            </span>
          )}

          <ChannelLink
            label="Text"
            channel="sms"
            active={channel === "sms"}
            available={Boolean(contact.phone?.trim()) && !outreachBlocked}
            href={workspace.channelHrefs.sms}
            disabledReason={
              outreachBlocked
                ? "Outreach is blocked for this contact"
                : undefined
            }
          />
          <ChannelLink
            label="Email"
            channel="email"
            active={channel === "email"}
            available={Boolean(contact.email?.trim()) && !outreachBlocked}
            href={workspace.channelHrefs.email}
            disabledReason={
              outreachBlocked
                ? "Outreach is blocked for this contact"
                : undefined
            }
          />
        </div>

        {outreachBlocked ? (
          <div
            role="status"
            className={`mt-4 ${teamStatePanelClass("danger")}`}
          >
            <p className="font-semibold">
              Do Not Contact — outreach is blocked
            </p>
            <p className="mt-1">
              Calling and messaging are unavailable for {contact.name}.
            </p>
          </div>
        ) : !channel ? (
          <p className="mt-4 rounded-xl border border-dashed border-[color:var(--team-border)] bg-[color:var(--team-surface-muted)] px-3 py-5 text-center text-sm text-[color:var(--team-text-muted)]">
            Add a phone number or email address to start a conversation.
          </p>
        ) : !workspace.canReadMessages ? (
          <p className="mt-4 text-sm text-[color:var(--team-text-muted)]">
            Inbox access is required to read or send messages.
          </p>
        ) : (
          <>
            <div className="mt-4 overflow-hidden rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)]">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[color:var(--team-border)] px-3 py-2">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-[color:var(--team-text-muted)]">
                    {channel === "email" ? "Email" : "Text"} history
                  </p>
                  <p className="mt-0.5 text-xs text-[color:var(--team-text-soft)]">
                    {destination}
                  </p>
                </div>
                {hasOlderMessages ? (
                  <a
                    href={workspace.fullInboxHref}
                    className="text-xs font-semibold text-[color:var(--team-link)] underline"
                  >
                    View earlier messages
                  </a>
                ) : null}
              </div>
              <div
                aria-label={`Recent ${channel === "email" ? "email" : "text"} messages`}
                className="max-h-80 min-h-40 space-y-3 overflow-y-auto px-3 py-3"
              >
                {conversation?.error ? (
                  <div role="alert" className={teamStatePanelClass("warning")}>
                    <p className="font-semibold">
                      Messages could not be loaded
                    </p>
                    <p className="mt-1">{conversation.error.message}</p>
                    <a
                      href={workspace.historyReturnHref}
                      className={`${teamButtonClass("secondary", "sm")} mt-3`}
                    >
                      Retry
                    </a>
                  </div>
                ) : recentMessages.length && threadId ? (
                  recentMessages.map((message) => (
                    <InboxMessage
                      key={message.id}
                      message={message}
                      canSend={workspace.canSendMessages}
                      threadId={threadId}
                      contactId={contact.id}
                      channel={channel}
                    />
                  ))
                ) : (
                  <p className="py-12 text-center text-sm text-[color:var(--team-text-muted)]">
                    No {channel === "email" ? "emails" : "text messages"} yet.
                    Start the conversation below.
                  </p>
                )}
              </div>
              <div className="border-t border-[color:var(--team-border)] bg-[color:var(--team-card)] p-3">
                {canCompose ? (
                  <InboxComposerClient
                    employeeId={workspace.employeeId}
                    threadId={threadId}
                    contactId={contact.id}
                    channel={channel}
                    isPartnerConversation={false}
                    initialSubject={conversation?.detail?.thread.subject ?? ""}
                    historyReturnHref={workspace.historyReturnHref}
                  />
                ) : conversation?.error ? (
                  <p className="text-xs text-[color:var(--team-text-muted)]">
                    Messaging is paused until the conversation history loads
                    successfully.
                  </p>
                ) : !workspace.canSendMessages ? (
                  <p className="text-xs text-[color:var(--team-text-muted)]">
                    Send-message permission is required to contact this
                    prospect.
                  </p>
                ) : null}
              </div>
            </div>
            <p className="mt-2 text-xs text-[color:var(--team-text-soft)]">
              Delivered messages and confirmed calls update the outreach checks
              automatically. Record the outcome below to schedule the next step.
            </p>
          </>
        )}
      </div>
    </section>
  );
}

function ChannelLink({
  label,
  channel,
  active,
  available,
  href,
  disabledReason,
}: {
  label: string;
  channel: OutboundCommunicationChannel;
  active: boolean;
  available: boolean;
  href?: string;
  disabledReason?: string;
}) {
  if (!available || !href) {
    return (
      <span
        aria-disabled="true"
        title={
          disabledReason ??
          `No ${channel === "email" ? "email address" : "phone number"} saved`
        }
        className="inline-flex min-h-11 items-center justify-center rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface-muted)] px-3 py-2 text-xs font-semibold text-[color:var(--team-text-soft)] opacity-70"
      >
        {label}
      </span>
    );
  }
  return (
    <a
      href={href}
      aria-current={active ? "page" : undefined}
      className={`inline-flex min-h-11 items-center justify-center rounded-xl border px-3 py-2 text-xs font-semibold transition ${
        active
          ? "border-[color:var(--team-control-hover-border)] bg-[color:var(--team-selection)] text-[color:var(--team-brand-green-strong)]"
          : "border-[color:var(--team-border)] bg-[color:var(--team-surface)] text-[color:var(--team-text-muted)] hover:bg-[color:var(--team-surface-muted)]"
      }`}
    >
      {label}
    </a>
  );
}
