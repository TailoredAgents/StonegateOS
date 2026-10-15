import type { OutboundQueueItem } from "../outbound-queue";

type OutreachProgress = OutboundQueueItem["outreach"];

const CHANNELS: Array<{
  key: keyof OutreachProgress;
  singular: string;
  plural: string;
  completeClass: string;
}> = [
  {
    key: "callAttempts",
    singular: "Call",
    plural: "Calls",
    completeClass:
      "border-[color:var(--team-info-border)] bg-[color:var(--team-info-surface)] text-[color:var(--team-info-text)]",
  },
  {
    key: "smsSent",
    singular: "SMS",
    plural: "SMS",
    completeClass:
      "border-[color:var(--team-control-hover-border)] bg-[color:var(--team-selection)] text-[color:var(--team-brand-green-strong)]",
  },
  {
    key: "emailsSent",
    singular: "Email",
    plural: "Emails",
    completeClass:
      "border-[color:var(--team-warning-border)] bg-[color:var(--team-brand-gold-soft)] text-[color:var(--team-warning-text)]",
  },
  {
    key: "repliesReceived",
    singular: "Reply",
    plural: "Replies",
    completeClass:
      "border-[color:var(--team-success-border)] bg-[color:var(--team-success-surface)] text-[color:var(--team-success-text)]",
  },
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
      {CHANNELS.map(({ key, singular, plural, completeClass }) => {
        const count = outreach[key];
        const complete = count > 0;
        const label = count === 1 ? singular : plural;

        return (
          <span
            key={key}
            className={`inline-flex items-center rounded-full border px-2 py-1 text-xs font-semibold ${
              complete
                ? completeClass
                : "border-[color:var(--team-border)] bg-[color:var(--team-surface-muted)] text-[color:var(--team-text-muted)]"
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
