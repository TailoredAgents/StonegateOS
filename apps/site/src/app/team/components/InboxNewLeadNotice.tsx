import Link from "next/link";
import { SubmitButton } from "@/components/SubmitButton";
import {
  acknowledgeNewLeadAction,
  updatePipelineStageAction,
} from "../actions";
import type { InboxNewLeadFeed } from "../inbox-new-leads";
import { teamSurfaceHref } from "../surface-registry";
import { teamButtonClass, teamStatePanelClass } from "./team-ui";

export function InboxNewLeadNotice({
  feed,
  error,
  acknowledgementKey,
}: {
  feed: InboxNewLeadFeed | null;
  error: string | null;
  acknowledgementKey: string | null;
}): React.ReactElement | null {
  if (error) {
    return (
      <section
        className={teamStatePanelClass("warning")}
        aria-labelledby="inbox-new-lead-status-title"
      >
        <h2 id="inbox-new-lead-status-title" className="font-semibold">
          New-lead status is unavailable
        </h2>
        <p className="mt-1 leading-6">{error}</p>
        <Link
          className={`${teamButtonClass("secondary", "sm")} mt-3`}
          href="/team/inbox"
        >
          Retry new-lead status
        </Link>
      </section>
    );
  }

  if (!feed || !feed.next || !acknowledgementKey) return null;
  const lead = feed.next;
  const remainingAfterThis = Math.max(0, feed.total - 1);

  return (
    <section
      className={teamStatePanelClass("success")}
      aria-labelledby="inbox-new-lead-title"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em]">
            {feed.total === 1
              ? "1 new lead ready"
              : `${feed.total.toLocaleString("en-US")} new leads ready`}
          </p>
          <h2
            id="inbox-new-lead-title"
            className="mt-1 text-base font-semibold"
          >
            {lead.name}
          </h2>
          <p className="mt-1 text-sm opacity-90">
            {lead.phoneE164 ?? lead.phone ?? "Phone not on file yet"}
          </p>
          <p className="mt-2 text-xs leading-5 opacity-90">
            Acknowledging this lead hides it only for you for 24 hours.
            {remainingAfterThis > 0
              ? ` ${remainingAfterThis.toLocaleString("en-US")} more ${remainingAfterThis === 1 ? "lead remains" : "leads remain"} in your queue.`
              : " No other unacknowledged new leads remain in your queue."}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            className={teamButtonClass("secondary", "sm")}
            href={teamSurfaceHref("contacts", {
              query: { contactId: lead.contactId },
            })}
          >
            Open contact
          </Link>
          <form action={updatePipelineStageAction}>
            <input type="hidden" name="contactId" value={lead.contactId} />
            <input type="hidden" name="stage" value="contacted" />
            <input type="hidden" name="previousStage" value="new" />
            <input
              type="hidden"
              name="expectedVersion"
              value={lead.pipelineVersion}
            />
            <input
              type="hidden"
              name="idempotencyKey"
              value={`pipeline-stage:${lead.contactId}:${lead.pipelineVersion}`}
            />
            <SubmitButton
              className={teamButtonClass("primary", "sm")}
              pendingLabel="Marking contacted…"
            >
              Mark contacted
            </SubmitButton>
          </form>
          <form action={acknowledgeNewLeadAction}>
            <input type="hidden" name="contactId" value={lead.contactId} />
            <input type="hidden" name="leadVersion" value={lead.version} />
            <input
              type="hidden"
              name="idempotencyKey"
              value={acknowledgementKey}
            />
            <SubmitButton
              className={teamButtonClass("secondary", "sm")}
              pendingLabel="Acknowledging…"
            >
              Acknowledge for me
            </SubmitButton>
          </form>
        </div>
      </div>
    </section>
  );
}
