import type { OutboundQueueItem } from "../outbound-queue";

type OutreachProgress = OutboundQueueItem["outreach"];

const CHANNELS: Array<{
  key: keyof OutreachProgress;
  singular: string;
  plural: string;
}> = [
  { key: "callAttempts", singular: "Call", plural: "Calls" },
  { key: "smsSent", singular: "SMS", plural: "SMS" },
  { key: "emailsSent", singular: "Email", plural: "Emails" },
  { key: "repliesReceived", singular: "Reply", plural: "Replies" },
];

export function OutboundOutreachProgress({
  outreach,
  compact = false,
}: {
  outreach: OutreachProgress;
  compact?: boolean;
}) {
  return (
    <div
      className="flex flex-wrap gap-1.5"
      aria-label="Recorded outreach activity"
    >
      {CHANNELS.map(({ key, singular, plural }) => {
        const count = outreach[key];
        const complete = count > 0;
        const label = count === 1 ? singular : plural;

        return (
          <span
            key={key}
            className={`inline-flex items-center rounded-full px-2 py-1 text-xs font-semibold ${
              complete
                ? "bg-emerald-100 text-emerald-900"
                : "bg-[color:var(--team-surface-muted)] text-[color:var(--team-text-muted)]"
            }`}
            title={`${count} ${label.toLowerCase()} recorded`}
          >
            {complete ? "✓ " : ""}
            {compact && count === 0 ? label : `${count} ${label}`}
          </span>
        );
      })}
    </div>
  );
}
