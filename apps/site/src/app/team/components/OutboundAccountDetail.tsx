import { randomUUID } from "node:crypto";
import {
  outboundOutcomeLabel,
  type OutboundDetailPermissions,
} from "../outbound-detail";
import {
  formatOutboundEasternTime,
  type OutboundQueueItem,
  type TeamMember,
} from "../outbound-queue";
import { OutboundContactActions } from "./OutboundContactActions";
import { TEAM_FOCUS_RING, teamButtonClass } from "./team-ui";

const SUMMARY = `min-h-11 cursor-pointer py-3 font-semibold ${TEAM_FOCUS_RING}`;
const MUTED = "text-sm text-[color:var(--team-text-muted)]";

export function OutboundAccountDetail({
  item,
  members,
  permissions,
  closeHref,
  initialTaskId,
}: {
  item: OutboundQueueItem;
  members: TeamMember[];
  permissions: OutboundDetailPermissions;
  closeHref: string;
  initialTaskId?: string;
}) {
  const owner =
    members.find((member) => member.id === item.assignedToMemberId)?.name ??
    "Assigned teammate";
  const brief = item.account.brief;
  const history = [...(item.account.history ?? [])].sort(
    (left, right) => Date.parse(right.at) - Date.parse(left.at),
  );
  const callKeys = Object.fromEntries(
    [...item.contacts, ...item.tasks].map((record) => [
      record.id,
      `team-call:${randomUUID()}`,
    ]),
  );
  const outcomeKeys = Object.fromEntries(
    item.tasks.map((task) => [task.id, `outbound-disposition:${randomUUID()}`]),
  );

  return (
    <section
      id="outbound-account"
      tabIndex={-1}
      aria-labelledby="outbound-account-title"
      className="min-w-0 scroll-mt-24 rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] p-4 text-[color:var(--team-text)] sm:p-5"
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className={MUTED}>Selected company</p>
          <h2
            id="outbound-account-title"
            className="mt-1 break-words text-xl font-semibold"
          >
            {item.account.name}
          </h2>
          <p className={`mt-2 ${MUTED}`}>
            {owner} · {item.contactCount} contact
            {item.contactCount === 1 ? "" : "s"}
          </p>
        </div>
        <a
          href={closeHref}
          className={`${teamButtonClass("secondary")} shrink-0`}
          aria-label="Close company details"
        >
          Close
        </a>
      </header>

      <div className="mt-5 border-t border-[color:var(--team-border)] pt-4">
        <OutboundContactActions
          key={item.id}
          item={item}
          permissions={permissions}
          callKeys={callKeys}
          outcomeKeys={outcomeKeys}
          initialTaskId={initialTaskId}
        />
      </div>

      {brief ? (
        <details className="mt-5 border-t border-[color:var(--team-border)]">
          <summary className={SUMMARY}>Conversation ideas</summary>
          <p className={MUTED}>
            {brief.provider === "openai" ? "AI-generated" : "Suggested"}{" "}
            preparation — check details before using. Updated{" "}
            {formatOutboundEasternTime(brief.updatedAt) ?? "recently"}.
          </p>
          <dl className="mt-4 space-y-4 text-sm leading-relaxed">
            {[
              ["About the company", brief.summary],
              ["Why we may be a fit", brief.whyFit],
              ["How we can help", brief.serviceAngle],
              ["Suggested opener", brief.bestOpener],
              ["Suggested next step", brief.recommendedNextMove],
              ["Relationship notes", brief.fitReason],
            ].map(([label, value]) =>
              value ? (
                <div key={label}>
                  <dt className="font-semibold">{label}</dt>
                  <dd className={`mt-1 whitespace-pre-wrap ${MUTED}`}>
                    {value}
                  </dd>
                </div>
              ) : null,
            )}
            {brief.likelyObjections.length ? (
              <div>
                <dt className="font-semibold">Questions to prepare for</dt>
                <dd>
                  <ul className="mt-1 list-disc space-y-1 pl-5">
                    {brief.likelyObjections.map((value, index) => (
                      <li key={`${index}-${value}`} className={MUTED}>
                        {value}
                      </li>
                    ))}
                  </ul>
                </dd>
              </div>
            ) : null}
          </dl>
        </details>
      ) : (
        <details className="mt-5 border-t border-[color:var(--team-border)]">
          <summary className={SUMMARY}>A simple call opener</summary>
          <p className={`${MUTED} pb-3`}>
            “Hi, this is Stonegate Junk Removal. Is there any cleanup or
            haul-off we can help your team with?”
          </p>
        </details>
      )}

      <details className="border-t border-[color:var(--team-border)]">
        <summary className={SUMMARY}>History &amp; account details</summary>
        <dl
          className={`mb-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 ${MUTED}`}
        >
          <dt>Last contact</dt>
          <dd>
            {formatOutboundEasternTime(item.account.lastTouchAt) ??
              "None recorded"}
          </dd>
          <dt>Follow-ups</dt>
          <dd>
            {item.dueAt ? "Started" : "Not started"}
            {item.startedAt
              ? ` · ${formatOutboundEasternTime(item.startedAt)}`
              : ""}
          </dd>
          <dt>Attempt</dt>
          <dd>{item.attempt}</dd>
          {item.campaign ? (
            <>
              <dt>Campaign</dt>
              <dd className="break-words">
                {item.campaign.replace(/_/g, " ")}
              </dd>
            </>
          ) : null}
          {item.account.segment ? (
            <>
              <dt>Company type</dt>
              <dd className="break-words">
                {item.account.segment.replace(/_/g, " ")}
              </dd>
            </>
          ) : null}
          {item.account.status ? (
            <>
              <dt>Status</dt>
              <dd>{item.account.status.replace(/_/g, " ")}</dd>
            </>
          ) : null}
          {item.reminderAt ? (
            <>
              <dt>Reminder</dt>
              <dd>{formatOutboundEasternTime(item.reminderAt)}</dd>
            </>
          ) : null}
          {item.account.portalFit ? (
            <>
              <dt>Suggested fit</dt>
              <dd>
                {item.account.portalFit.replace(/_/g, " ")}
                {typeof item.account.fitScore === "number"
                  ? ` · ${item.account.fitScore}/100`
                  : ""}
              </dd>
            </>
          ) : null}
        </dl>
        {item.noteSnippet ? (
          <p className={`mb-4 whitespace-pre-wrap ${MUTED}`}>
            {item.noteSnippet}
          </p>
        ) : null}
        {history.length ? (
          <ol className="space-y-4 border-l border-[color:var(--team-border)] pl-4 pb-4">
            {history.map((entry) => (
              <li key={entry.id}>
                <h3 className="text-sm font-semibold">{entry.title}</h3>
                <p className={`mt-1 whitespace-pre-wrap ${MUTED}`}>
                  {entry.summary}
                </p>
                <p className={`mt-1 ${MUTED}`}>
                  {entry.contactName ? `${entry.contactName} · ` : ""}
                  <time dateTime={entry.at}>
                    {formatOutboundEasternTime(entry.at) ?? "Time unavailable"}
                  </time>
                </p>
              </li>
            ))}
          </ol>
        ) : (
          <p className={`${MUTED} pb-3`}>No activity recorded yet.</p>
        )}
      </details>

      <details className="border-t border-[color:var(--team-border)]">
        <summary className={SUMMARY}>Open tasks ({item.openTaskCount})</summary>
        {item.tasks.length ? (
          <ul className="divide-y divide-[color:var(--team-border)]">
            {item.tasks.map((task) => (
              <li key={task.id} className="py-3">
                <h3 className="text-sm font-semibold">
                  {task.title || "Outreach task"}
                </h3>
                <p className={`mt-1 ${MUTED}`}>
                  {task.contactName} ·{" "}
                  {formatOutboundEasternTime(task.dueAt) ?? "Not started"}
                </p>
                <p className={`mt-1 ${MUTED}`}>
                  Attempt {task.attempt} ·{" "}
                  {task.doNotContact
                    ? "Do not contact"
                    : outboundOutcomeLabel(task.lastDisposition)}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className={`${MUTED} pb-3`}>No open tasks.</p>
        )}
      </details>
    </section>
  );
}
