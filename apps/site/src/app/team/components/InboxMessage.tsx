import { randomUUID } from "node:crypto";
import { SubmitButton } from "@/components/SubmitButton";
import { retryFailedMessageAction } from "../actions";
import type { MessageDetail } from "../inbox-loader";
import { TEAM_TIME_ZONE } from "../lib/timezone";
import { InboxMediaGallery } from "./InboxMediaGallery";
import { teamButtonClass } from "./team-ui";

export function InboxMessage({
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
          <time>{messageTimestamp(message.createdAt)}</time>
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

function messageTimestamp(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TEAM_TIME_ZONE,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}
