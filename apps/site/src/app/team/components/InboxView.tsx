import { randomUUID } from "node:crypto";
import React from "react";
import Link from "next/link";
import { serviceRates, zones } from "@myst-os/pricing/src/config/defaults";
import { SubmitButton } from "@/components/SubmitButton";
import { TEAM_TIME_ZONE } from "../lib/timezone";
import { teamSurfaceHref } from "../surface-registry";
import {
  buildInboxConversationQuery,
  type InboxConversationHrefInput,
} from "../inbox-thread-page";
import {
  groupInboxThreads,
  inboxContactName,
  inboxFilters,
  type loadInboxConversation,
  type loadInboxList,
  type InboxInput,
  type MessageDetail,
} from "../inbox-loader";
import { retryFailedMessageAction, startContactCallAction } from "../actions";
import { InboxAutoScroll } from "./InboxAutoScroll";
import { InboxAutoDraftClient } from "./InboxAutoDraftClient";
import { InboxMediaGallery } from "./InboxMediaGallery";
import { InboxLiveUpdatesClient } from "./InboxLiveUpdatesClient";
import { InboxComposerClient } from "./InboxComposerClient";
import { InboxAutomationNoticeClient } from "./InboxAutomationNoticeClient";
import { InboxCustomerWorkspaceClient } from "./InboxCustomerWorkspaceClient";
import {
  InboxListScroll,
  InboxRetryClient,
  InboxSearchFiltersClient,
} from "./InboxNavigationClient";
import {
  InboxAiReplyClient,
  InboxContactToolsClient,
  InboxDiagnosticsClient,
} from "./InboxOptionalToolsClient";
import { teamButtonClass } from "./team-ui";

const QUOTE_SERVICES = new Set([
  "single-item",
  "furniture",
  "appliances",
  "yard-waste",
  "construction-debris",
  "hot-tub",
  "other",
]);
const services = serviceRates
  .filter((service) => QUOTE_SERVICES.has(service.service))
  .map((service) => ({
    id: service.service,
    label: service.label,
    description: service.description ?? null,
    allowCustomPrice: true,
  }));
const quoteZones = zones.map((zone) => ({ id: zone.id, name: zone.name }));
const channelLabel = (channel: string) =>
  channel === "dm"
    ? "Messenger"
    : channel === "email"
      ? "Email"
      : channel === "web"
        ? "Partner"
        : "SMS";
function timestamp(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TEAM_TIME_ZONE,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

/** Presentation only. The server loader and durable composer remain independent of layout changes. */
export function InboxView({
  input,
  access,
  list,
  conversation,
}: {
  input: InboxInput;
  access: {
    employeeId: string;
    canSend: boolean;
    canDraft: boolean;
    canEditContact: boolean;
    canPlaceCalls: boolean;
    canReadContacts: boolean;
  };
  list: Awaited<ReturnType<typeof loadInboxList>>;
  conversation: Awaited<ReturnType<typeof loadInboxConversation>>;
}): React.ReactElement {
  const { employeeId, canSend, canDraft, canEditContact } = access;
  const filters = inboxFilters(input);
  const {
    detail,
    selectedThreadId,
    error: messageError,
    isPartnerConversation,
    hasSelection,
  } = conversation;
  // A failed page keeps its exact selection. List metadata can label it, never substitute its messages.
  const selectedSummary = list.threads.find(
    (thread) => thread.id === selectedThreadId,
  );
  const contact =
    conversation.contact ??
    (input.threadId && !isPartnerConversation
      ? (selectedSummary?.contact ?? null)
      : null);
  const contactId =
    conversation.contactId ??
    contact?.id ??
    (input.threadId ? null : (input.contactId ?? null));
  const channel = detail
    ? conversation.channel
    : selectedSummary?.channel === "web"
      ? "web"
      : conversation.channel;
  const messages = detail?.messages ?? [];
  const page = detail?.messagePage ?? null;
  const filterQuery = { ...filters, offset: list.pagination.offset };
  const context = { threadId: selectedThreadId, contactId, channel };
  const href = (override: InboxConversationHrefInput = {}) =>
    teamSurfaceHref("inbox", {
      query: buildInboxConversationQuery({
        ...filterQuery,
        ...context,
        ...override,
      }),
    });
  const refreshHref = href({
    messageCursor: input.messageCursor,
    messageLimit: input.messageLimit,
  });
  const listHref = href({ threadId: null, contactId: null, channel: null });
  const newestHref = href({
    messageCursor: null,
    messageLimit: page?.limit ?? 50,
  });
  const latestInbound = [...messages]
    .reverse()
    .find((message) => message.direction === "inbound");
  const latestOutbound = [...messages]
    .reverse()
    .find(
      (message) =>
        message.direction === "outbound" &&
        message.metadata?.["draft"] !== true,
    );
  const aiDraft = [...messages]
    .reverse()
    .find(
      (message) =>
        message.metadata?.["draft"] === true &&
        message.metadata?.["aiSuggested"] === true,
    );
  const readableMessages = messages.filter(
    (message) => message.metadata?.["draft"] !== true,
  );
  const name = inboxContactName(
    contact,
    detail?.thread.subject ??
      selectedSummary?.subject ??
      (channel === "web" ? "Partner conversation" : "Conversation"),
  );
  const activeChannels = new Set<string>([channel]);
  if (!isPartnerConversation && channel !== "web" && contactId) {
    if (contact?.phone) activeChannels.add("sms");
    if (contact?.email) activeChannels.add("email");
    for (const thread of [
      ...list.threads.filter((thread) => thread.contact?.id === contactId),
      ...(conversation.timeline?.threads ?? []),
    ]) {
      if (thread.channel === "dm") activeChannels.add("dm");
    }
  }
  const callAction =
    contactId && contact?.phone && access.canPlaceCalls ? (
      <form action={startContactCallAction}>
        <input type="hidden" name="contactId" value={contactId} />
        <input
          type="hidden"
          name="idempotencyKey"
          value={`manual-call:${randomUUID()}`}
        />
        <input type="hidden" name="explicitNewAttempt" value="START NEW CALL" />
        <SubmitButton
          className={teamButtonClass("secondary", "sm")}
          pendingLabel="Calling…"
        >
          Call
        </SubmitButton>
      </form>
    ) : null;
  const composerDisabled =
    !canSend ||
    (!detail && Boolean(messageError) && !contact) ||
    (channel === "sms" && !contact?.phone) ||
    (channel === "email" && !contact?.email) ||
    (channel === "dm" && !selectedThreadId) ||
    (channel === "web" && !isPartnerConversation);
  const storageKey = `stonegate:inbox-list:${employeeId}:${JSON.stringify(filterQuery)}`;

  return (
    <section
      aria-label="Customer conversations"
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-hidden text-[color:var(--team-text)]"
    >
      <React.Suspense fallback={null}>
        <InboxDiagnosticsClient />
      </React.Suspense>
      <InboxLiveUpdatesClient
        threadId={selectedThreadId}
        contactId={contactId}
        channel={channel}
        initialTimelineSignature={
          conversation.timeline?.snapshot?.signature ?? null
        }
        initialThreadsSignature={list.signature}
        queue={filters.queue}
        status={null}
        view={filters.view}
        q={filters.q || null}
        firstMessageFrom={filters.firstMessageFrom || null}
        firstMessageTo={filters.firstMessageTo || null}
        lastMessageFrom={filters.lastMessageFrom || null}
        lastMessageTo={filters.lastMessageTo || null}
        offset={list.pagination.offset ? String(list.pagination.offset) : null}
        isViewingNewest={input.messageCursor === undefined}
      />
      <div className="grid min-h-0 min-w-0 flex-1 grid-cols-1 gap-3 overflow-hidden lg:grid-cols-[300px_minmax(0,1fr)]">
        <aside
          aria-label="Conversations"
          className={`${hasSelection ? "hidden lg:flex" : "flex"} min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-card)]`}
        >
          <InboxSearchFiltersClient
            input={filters}
            href={refreshHref}
            canSend={canSend}
          />
          <InboxListScroll storageKey={storageKey}>
            {list.error ? (
              <div role="alert" className="space-y-3 p-3 text-sm">
                <p>{list.error.message}</p>
                <InboxRetryClient label="Retry conversations" />
              </div>
            ) : list.threads.length === 0 ? (
              <div className="p-4 text-sm text-[color:var(--team-text-muted)]">
                {list.pagination.offset > 0 ? (
                  <>
                    <p>This page has no conversations.</p>
                    <Link
                      scroll={false}
                      href={href({ offset: null })}
                      className="underline"
                    >
                      First page
                    </Link>
                  </>
                ) : (
                  "No conversations match your search."
                )}
              </div>
            ) : (
              <ul className="space-y-1">
                {groupInboxThreads(list.threads).map((group) => {
                  const latest = group.threads[0]!;
                  const landing =
                    group.threads.find(
                      (thread) => thread.channel === channel,
                    ) ?? latest;
                  const active =
                    group.threads.some(
                      (thread) => thread.id === selectedThreadId,
                    ) ||
                    (!selectedThreadId &&
                      latest.channel !== "web" &&
                      latest.contact?.id === contactId);
                  const url = href({
                    threadId: landing.id,
                    contactId:
                      landing.channel === "web"
                        ? null
                        : (landing.contact?.id ?? null),
                    channel: landing.channel,
                    messageCursor: null,
                    messageLimit: null,
                  });
                  const failed = group.threads.some(
                    (thread) => (thread.failedMessageCount ?? 0) > 0,
                  );
                  return (
                    <li
                      key={group.key}
                      className={`rounded-xl border ${active ? "border-[color:var(--team-border-strong)] bg-[color:var(--team-list-item-active)]" : "border-transparent hover:bg-[color:var(--team-list-item-hover)]"}`}
                    >
                      <Link
                        href={url}
                        scroll={false}
                        aria-current={active ? "page" : undefined}
                        className="block min-w-0 rounded-xl px-3 py-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-600"
                      >
                        <div className="truncate text-sm font-semibold">
                          {inboxContactName(
                            latest.contact,
                            latest.subject ??
                              (latest.channel === "web"
                                ? "Partner conversation"
                                : "Customer"),
                          )}
                        </div>
                        <p className="mt-1 line-clamp-2 break-words text-xs text-[color:var(--team-text-muted)]">
                          {latest.lastMessagePreview || "No messages yet"}
                        </p>
                        <div className="mt-2 flex flex-wrap justify-between gap-1 text-[11px] text-[color:var(--team-text-muted)]">
                          <time>{timestamp(latest.lastMessageAt)}</time>
                          {failed ? (
                            <span className="font-semibold text-rose-700">
                              Delivery problem
                            </span>
                          ) : null}
                        </div>
                      </Link>
                      {group.threads.length > 1 ? (
                        <div className="flex flex-wrap gap-1 px-3 pb-2">
                          {group.threads.map((thread) => (
                            <Link
                              key={thread.id}
                              scroll={false}
                              href={href({
                                threadId: thread.id,
                                contactId: thread.contact?.id ?? null,
                                channel: thread.channel,
                                messageCursor: null,
                                messageLimit: null,
                              })}
                              aria-label={`Open ${channelLabel(thread.channel)} conversation`}
                              className="min-h-8 rounded-lg px-2 py-1 text-xs underline"
                            >
                              {channelLabel(thread.channel)}
                            </Link>
                          ))}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </InboxListScroll>
          {!list.error &&
          (list.pagination.offset > 0 ||
            list.pagination.nextOffset !== null) ? (
            <nav
              aria-label="Conversation list pages"
              className="flex shrink-0 items-center justify-between gap-2 border-t border-[color:var(--team-border)] px-3 py-2 text-xs"
            >
              {list.pagination.offset > 0 ? (
                <Link
                  href={href({
                    offset: Math.max(
                      0,
                      list.pagination.offset - list.pagination.limit,
                    ),
                  })}
                  scroll={false}
                  className={teamButtonClass("secondary", "sm")}
                >
                  Previous
                </Link>
              ) : (
                <span />
              )}
              <span>
                {list.pagination.offset + 1}–
                {list.pagination.offset + list.threads.length} of{" "}
                {list.pagination.total}
              </span>
              {list.pagination.nextOffset !== null ? (
                <Link
                  href={href({ offset: list.pagination.nextOffset })}
                  scroll={false}
                  className={teamButtonClass("secondary", "sm")}
                >
                  Next
                </Link>
              ) : (
                <span />
              )}
            </nav>
          ) : null}
        </aside>
        <div
          className={`${hasSelection ? "flex" : "hidden lg:flex"} min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-card)]`}
        >
          {hasSelection ? (
            <>
              <header className="shrink-0 space-y-2 border-b border-[color:var(--team-border)] px-4 py-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Link
                        href={listHref}
                        scroll={false}
                        className="inline-flex min-h-9 shrink-0 items-center text-sm font-semibold lg:hidden"
                      >
                        ← Back
                      </Link>
                      <h2
                        className="truncate text-base font-semibold"
                        title={name}
                      >
                        {name}
                      </h2>
                    </div>
                    {detail?.thread.property?.outOfArea ? (
                      <p className="mt-1 text-xs text-amber-800">
                        Outside the service area. Check the address before
                        booking.
                      </p>
                    ) : null}
                  </div>
                  <nav
                    aria-label="Conversation channel"
                    className="flex flex-wrap gap-1"
                  >
                    {[...activeChannels].map((nextChannel) =>
                      nextChannel === channel ? (
                        <span
                          key={nextChannel}
                          className="rounded-lg bg-[color:var(--team-panel-alt)] px-3 py-2 text-xs font-semibold"
                          aria-current="page"
                        >
                          {channelLabel(channel)}
                        </span>
                      ) : (
                        <Link
                          key={nextChannel}
                          scroll={false}
                          className="rounded-lg px-3 py-2 text-xs underline"
                          href={href({
                            threadId: null,
                            channel: nextChannel,
                            messageCursor: null,
                            messageLimit: null,
                          })}
                        >
                          {channelLabel(nextChannel)}
                        </Link>
                      ),
                    )}
                  </nav>
                </div>
                {contactId && channel !== "web" ? (
                  <InboxCustomerWorkspaceClient
                    key={`${employeeId}:${contactId}`}
                    employeeId={employeeId}
                    threadId={selectedThreadId}
                    contactId={contactId}
                    activeChannel={channel}
                    services={services}
                    zones={quoteZones}
                    teamMembers={[]}
                    latestInboundBody={latestInbound?.body ?? null}
                    primaryActions={callAction}
                    details={
                      <InboxContactToolsClient
                        contactId={contactId}
                        readOnly={!canEditContact}
                      />
                    }
                  />
                ) : null}
                {contactId && channel !== "web" && access.canReadContacts ? (
                  <InboxAutomationNoticeClient
                    key={`automation:${employeeId}:${contactId}:${channel}`}
                    contactId={contactId}
                    channel={channel}
                  />
                ) : null}
              </header>
              <div
                id="inbox-thread-scroll"
                tabIndex={0}
                aria-label="Messages"
                className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-600"
              >
                {page &&
                (page.hasOlder ||
                  page.hasNewer ||
                  page.position === "history") ? (
                  <nav
                    aria-label="Message pages"
                    className="flex flex-wrap justify-center gap-2 text-xs"
                  >
                    {page.olderCursor ? (
                      <Link
                        href={href({
                          messageCursor: page.olderCursor,
                          messageLimit: page.limit,
                        })}
                        scroll={false}
                        className={teamButtonClass("secondary", "sm")}
                      >
                        Older messages
                      </Link>
                    ) : null}
                    {page.newerCursor ? (
                      <Link
                        href={href({
                          messageCursor: page.newerCursor,
                          messageLimit: page.limit,
                        })}
                        scroll={false}
                        className={teamButtonClass("secondary", "sm")}
                      >
                        Newer messages
                      </Link>
                    ) : null}
                    {page.position === "history" ? (
                      <Link
                        href={newestHref}
                        scroll={false}
                        className={teamButtonClass("secondary", "sm")}
                      >
                        Latest messages
                      </Link>
                    ) : null}
                  </nav>
                ) : null}
                {messageError ? (
                  <div
                    role="alert"
                    className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
                  >
                    <p className="font-semibold">
                      Messages could not be loaded
                    </p>
                    <p className="mt-1">{messageError.message}</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <InboxRetryClient />
                      {input.messageCursor !== undefined ||
                      messageError.status === 409 ||
                      messageError.status === 422 ? (
                        <Link
                          href={newestHref}
                          scroll={false}
                          className={teamButtonClass("secondary", "sm")}
                        >
                          Latest messages
                        </Link>
                      ) : null}
                    </div>
                  </div>
                ) : readableMessages.length === 0 ? (
                  <p className="py-8 text-center text-sm text-[color:var(--team-text-muted)]">
                    {aiDraft
                      ? "A draft is ready to review below."
                      : "No messages yet."}
                  </p>
                ) : (
                  readableMessages.map((message) => (
                    <InboxMessage
                      key={message.id}
                      message={message}
                      canSend={canSend}
                      threadId={selectedThreadId!}
                      contactId={contactId}
                      channel={channel}
                    />
                  ))
                )}
                <div id="inbox-thread-bottom" />
                <InboxAutoScroll
                  scopeKey={`${employeeId}:${selectedThreadId ?? contactId}:${channel}`}
                  pageKey={
                    typeof input.messageCursor === "string"
                      ? input.messageCursor
                      : (input.messageCursor?.join(",") ?? "newest")
                  }
                  isViewingNewest={input.messageCursor === undefined}
                  containerId="inbox-thread-scroll"
                  bottomId="inbox-thread-bottom"
                  depsKey={`${employeeId}:${selectedThreadId ?? contactId}:${channel}:${JSON.stringify(input.messageCursor ?? "latest")}:${messages.at(-1)?.id ?? "empty"}`}
                />
              </div>
              <div className="shrink-0 border-t border-[color:var(--team-border)] px-3 py-2 pb-[max(.5rem,env(safe-area-inset-bottom))]">
                {canSend &&
                !messageError &&
                ((channel === "sms" && !contact?.phone) ||
                  (channel === "email" && !contact?.email)) ? (
                  <p className="mb-2 text-xs text-amber-800">
                    Add a {channel === "sms" ? "phone number" : "email address"}{" "}
                    in Contacts to reply on this channel.
                  </p>
                ) : null}
                {canDraft &&
                contactId &&
                selectedThreadId &&
                channel !== "web" ? (
                  <InboxAiReplyClient
                    key={`ai:${employeeId}:${selectedThreadId}:${channel}`}
                    employeeId={employeeId}
                    contactId={contactId}
                    threadId={selectedThreadId}
                    channel={channel}
                    initialDraft={
                      aiDraft
                        ? {
                            body: aiDraft.body,
                            subject: aiDraft.subject ?? undefined,
                          }
                        : null
                    }
                  />
                ) : null}
                {canDraft &&
                !messageError &&
                selectedThreadId &&
                channel !== "web" &&
                page?.position !== "history" ? (
                  <InboxAutoDraftClient
                    threadId={selectedThreadId}
                    channel={channel}
                    latestInboundAt={latestInbound?.createdAt ?? null}
                    latestOutboundAt={latestOutbound?.createdAt ?? null}
                    latestAiDraftAt={aiDraft?.createdAt ?? null}
                  />
                ) : null}
                <InboxComposerClient
                  key={`composer:${employeeId}:${selectedThreadId ?? contactId}:${channel}`}
                  employeeId={employeeId}
                  threadId={selectedThreadId}
                  contactId={contactId}
                  channel={channel}
                  isPartnerConversation={isPartnerConversation}
                  initialSubject={detail?.thread.subject ?? ""}
                  disabled={composerDisabled}
                  historyReturnHref={
                    page?.position === "history" ? newestHref : undefined
                  }
                />
              </div>
            </>
          ) : (
            <div className="m-auto p-8 text-center text-sm text-[color:var(--team-text-muted)]">
              Choose a customer to read and reply.
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function InboxMessage({
  message,
  canSend,
  threadId,
  contactId,
  channel,
}: {
  message: MessageDetail;
  canSend: boolean;
  threadId: string;
  contactId: string | null;
  channel: string;
}) {
  const outbound = message.direction !== "inbound";
  const failed = outbound && message.deliveryStatus === "failed";
  const media = message.mediaUrls ?? [];
  return (
    <article className={`flex ${outbound ? "justify-end" : "justify-start"}`}>
      <div
        className={`min-w-0 max-w-[92%] rounded-2xl px-4 py-3 text-sm lg:max-w-[85%] ${outbound ? "bg-[color:var(--team-bubble-outbound)]" : "bg-[color:var(--team-bubble-inbound)]"}`}
      >
        {message.direction === "internal" ? (
          <p className="mb-2 text-xs font-semibold text-amber-800">
            Internal note · Stonegate only
          </p>
        ) : null}
        {message.participantName ? (
          <p className="mb-1 text-xs font-semibold">
            {message.participantName}
          </p>
        ) : null}
        {message.subject && message.channel === "email" ? (
          <p className="mb-2 font-semibold">{message.subject}</p>
        ) : null}
        {message.body &&
        !(media.length > 0 && message.body === "Media message") ? (
          <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
            {message.body}
          </p>
        ) : null}
        {media.length > 0 ? (
          <InboxMediaGallery messageId={message.id} count={media.length} />
        ) : null}
        <div className="mt-2 flex flex-wrap items-center justify-end gap-2 text-[11px] text-[color:var(--team-text-muted)]">
          <time>{timestamp(message.createdAt)}</time>
          {outbound && message.direction !== "internal" ? (
            <span
              className={
                failed
                  ? "text-[11px] font-semibold text-rose-700"
                  : "text-[11px]"
              }
            >
              {failed
                ? "Delivery failed"
                : message.deliveryStatus === "queued"
                  ? "Queued"
                  : message.deliveryStatus === "delivered"
                    ? "Delivered"
                    : message.deliveryStatus === "sent"
                      ? "Sent"
                      : message.deliveryStatus === "read"
                        ? "Read"
                        : message.deliveryStatus === "received"
                          ? null
                          : "Sending"}
            </span>
          ) : null}
        </div>
        {failed && canSend ? (
          <form action={retryFailedMessageAction} className="mt-2">
            <input type="hidden" name="messageId" value={message.id} />
            <input
              type="hidden"
              name="idempotencyKey"
              value={`message-retry:${randomUUID()}`}
            />
            <input type="hidden" name="threadId" value={threadId} />
            <input type="hidden" name="contactId" value={contactId ?? ""} />
            <input type="hidden" name="channel" value={channel} />
            <SubmitButton
              className={teamButtonClass("secondary", "sm")}
              pendingLabel="Retrying…"
            >
              Retry delivery
            </SubmitButton>
          </form>
        ) : null}
      </div>
    </article>
  );
}
