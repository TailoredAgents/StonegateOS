"use client";

import { useState } from "react";
import { SubmitButton } from "@/components/SubmitButton";
import { bulkOutboundAction } from "../actions";
import type { OutboundQueueItem, TeamMember } from "../outbound-queue";
import {
  TEAM_FOCUS_RING,
  TEAM_INPUT_COMPACT,
  teamButtonClass,
} from "./team-ui";

export function OutboundBulkActions({
  items,
  members,
  memberId,
  idempotencyKey,
  directoryUnavailable,
}: {
  items: OutboundQueueItem[];
  members: TeamMember[];
  memberId: string;
  idempotencyKey: string;
  directoryUnavailable: boolean;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [action, setAction] = useState("");
  const eligible = items.filter((item) => item.dncContactCount === 0);
  const assigning = action === "assign" || action === "assign_start";
  const field = `${TEAM_INPUT_COMPACT} !text-base w-full min-w-0`;
  const taskCount = items
    .filter((item) => selected.includes(item.id))
    .reduce((sum, item) => sum + item.tasks.length, 0);
  return (
    <details className="rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)]">
      <summary
        className={`min-h-11 cursor-pointer px-4 py-3 text-sm font-semibold ${TEAM_FOCUS_RING}`}
      >
        Update several accounts
      </summary>
      <form
        action={async (data) => {
          await bulkOutboundAction(data);
          setSelected([]);
          setAction("");
        }}
        onReset={() => {
          setSelected([]);
          setAction("");
        }}
        className="space-y-4 border-t border-[color:var(--team-border)] p-4"
      >
        <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
        <p className="text-sm text-[color:var(--team-text-muted)]">
          Select accounts on this page, then choose an action. Accounts with a
          Do Not Contact restriction cannot be included.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <span role="status" className="mr-auto text-sm">
            {selected.length} of {eligible.length} eligible accounts selected
          </span>
          <button
            type="button"
            className={teamButtonClass("secondary", "sm")}
            disabled={!eligible.length}
            onClick={() => setSelected(eligible.map((item) => item.id))}
          >
            Select page
          </button>
          <button
            type="button"
            className={teamButtonClass("secondary", "sm")}
            disabled={!selected.length}
            onClick={() => setSelected([])}
          >
            Clear selection
          </button>
        </div>
        <div className="grid max-h-72 gap-2 overflow-y-auto rounded-xl border border-[color:var(--team-border)] p-2 sm:grid-cols-2">
          {items.map((item) => (
            <label
              key={item.id}
              className="flex min-h-11 min-w-0 items-center gap-3 rounded-lg p-2 text-sm"
            >
              <input
                type="checkbox"
                name="taskRefs"
                className="h-5 w-5 shrink-0"
                disabled={item.dncContactCount > 0}
                value={JSON.stringify(
                  item.tasks.map((task) => ({
                    id: task.id,
                    version: task.version,
                  })),
                )}
                checked={selected.includes(item.id)}
                onChange={(event) =>
                  setSelected((current) =>
                    event.target.checked
                      ? [...current, item.id]
                      : current.filter((id) => id !== item.id),
                  )
                }
              />
              <span className="min-w-0 break-words">
                {item.account.name}
                {item.dncContactCount > 0 ? (
                  <span className="block text-xs text-[color:var(--team-text-muted)]">
                    Do Not Contact — excluded
                  </span>
                ) : null}
              </span>
            </label>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-sm font-medium">
            Action
            <select
              name="action"
              value={action}
              onChange={(event) => setAction(event.target.value)}
              required
              className={field}
            >
              <option value="">Choose an action</option>
              <option
                value="assign"
                disabled={directoryUnavailable || !members.length}
              >
                Assign to a teammate
              </option>
              <option
                value="assign_start"
                disabled={directoryUnavailable || !members.length}
              >
                Assign and start follow-ups
              </option>
              <option value="start">Start follow-ups</option>
              <option value="snooze">Snooze follow-ups</option>
            </select>
          </label>
          {assigning ? (
            <label className="grid gap-1 text-sm font-medium">
              Assign to
              <select
                name="assignedToMemberId"
                defaultValue={
                  members.some((member) => member.id === memberId)
                    ? memberId
                    : ""
                }
                required
                className={field}
              >
                <option value="">Choose a teammate</option>
                {members.map((member) => (
                  <option value={member.id} key={member.id}>
                    {member.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {action === "snooze" ? (
            <label className="grid gap-1 text-sm font-medium">
              Resume at (Eastern time)
              <select
                name="snoozePreset"
                defaultValue="tomorrow_9am"
                required
                className={field}
              >
                <option value="today_5pm">Today at 5 PM</option>
                <option value="tomorrow_9am">Tomorrow at 9 AM</option>
                <option value="plus_3d_9am">In 3 days at 9 AM</option>
                <option value="next_monday_9am">Next Monday at 9 AM</option>
                <option value="plus_7d_9am">In 7 days at 9 AM</option>
              </select>
              <span className="text-xs font-normal">
                Accounts whose follow-ups have not started are skipped.
              </span>
            </label>
          ) : null}
        </div>
        {taskCount > 500 ? (
          <p role="alert">
            Select fewer accounts. One update can include up to 500 tasks.
          </p>
        ) : null}
        <SubmitButton
          className={teamButtonClass("primary")}
          disabled={
            !selected.length ||
            !action ||
            taskCount > 500 ||
            (assigning && directoryUnavailable)
          }
          pendingLabel="Updating accounts…"
        >
          Apply to {selected.length} selected accounts
        </SubmitButton>
      </form>
    </details>
  );
}
