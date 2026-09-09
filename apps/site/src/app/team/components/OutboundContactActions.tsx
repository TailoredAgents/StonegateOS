"use client";

import { useEffect, useId, useRef, useState } from "react";
import { SubmitButton } from "@/components/SubmitButton";
import {
  draftOutboundFirstTouchAction,
  draftOutboundFollowupAction,
  openContactThreadAction,
  setOutboundDispositionAction,
  startContactCallAction,
} from "../actions";
import {
  resolveOutboundContactContext,
  outboundOutcomeLabel,
  type OutboundDetailPermissions,
} from "../outbound-detail";
import {
  formatOutboundEasternTime,
  type OutboundQueueItem,
} from "../outbound-queue";
import {
  TEAM_FOCUS_RING,
  TEAM_INPUT_COMPACT,
  teamButtonClass,
  teamStatePanelClass,
} from "./team-ui";

const INPUT = TEAM_INPUT_COMPACT.replace("text-sm", "text-base");
const SUMMARY = `min-h-11 cursor-pointer py-3 font-semibold ${TEAM_FOCUS_RING}`;
const OUTCOMES = [
  ["connected", "Connected"],
  ["partner", "Confirmed partner relationship"],
  ["no_answer", "No answer"],
  ["left_voicemail", "Left voicemail"],
  ["email_sent", "Email sent"],
  ["callback_requested", "Callback requested"],
  ["not_interested", "Not interested"],
  ["dnc", "Do not contact"],
] as const;

type SavedInput = {
  outcome: string;
  recap: string;
  callbackAt: string;
  draftRecap: string;
  draftOutcome: string;
  revision: string;
};
const EMPTY_INPUT: SavedInput = {
  outcome: "",
  recap: "",
  callbackAt: "",
  draftRecap: "",
  draftOutcome: "",
  revision: "",
};

export function OutboundContactActions({
  item,
  permissions,
  callKeys,
  outcomeKeys,
  initialTaskId,
}: {
  item: Pick<
    OutboundQueueItem,
    "contacts" | "tasks" | "primaryContactId" | "primaryTaskId"
  >;
  permissions: OutboundDetailPermissions;
  callKeys: Record<string, string>;
  outcomeKeys: Record<string, string>;
  initialTaskId?: string;
}) {
  const prefix = useId();
  const initialTask = initialTaskId
    ? item.tasks.find((candidate) => candidate.id === initialTaskId)
    : null;
  const initialSignature = `${initialTaskId ?? ""}:${initialTask?.contactId ?? ""}:${initialTask?.id ?? ""}`;
  const previousInitialSignature = useRef(initialSignature);
  const [contactId, setContactId] = useState(
    initialTaskId
      ? (initialTask?.contactId ?? "")
      : (item.contacts.find((contact) => contact.id === item.primaryContactId)
          ?.id ??
          item.contacts[0]?.id ??
          ""),
  );
  const [taskSelections, setTaskSelections] = useState<Record<string, string>>(
    initialTask ? { [initialTask.contactId]: initialTask.id } : {},
  );
  const [channelSelections, setChannelSelections] = useState<
    Record<string, "email" | "sms">
  >({});
  const [savedInputs, setSavedInputs] = useState<Record<string, SavedInput>>(
    {},
  );
  const [draftKind, setDraftKind] = useState<"first" | "follow_up">("first");
  useEffect(() => {
    if (previousInitialSignature.current === initialSignature) return;
    previousInitialSignature.current = initialSignature;
    if (!initialTaskId) return;
    setContactId(initialTask?.contactId ?? "");
    if (initialTask)
      setTaskSelections((current) => ({
        ...current,
        [initialTask.contactId]: initialTask.id,
      }));
  }, [initialSignature, initialTask, initialTaskId]);
  const changingInitialTask =
    previousInitialSignature.current !== initialSignature &&
    Boolean(initialTaskId);
  const activeContactId = changingInitialTask
    ? (initialTask?.contactId ?? "")
    : contactId;
  const context =
    initialTaskId && !initialTask
      ? null
      : resolveOutboundContactContext(
          item,
          activeContactId,
          changingInitialTask
            ? initialTask?.id
            : taskSelections[activeContactId],
        );
  if (!context) {
    return (
      <p role="status" className={teamStatePanelClass("warning")}>
        {initialTaskId && !initialTask
          ? "This requested task is no longer available."
          : "This contact is no longer available."}{" "}
        Refresh the queue before taking action.
      </p>
    );
  }
  const { contact, tasks, task, channels, outreachBlocked } = context;
  const requestedChannel = channelSelections[contact.id];
  const channel =
    requestedChannel && channels.includes(requestedChannel)
      ? requestedChannel
      : channels[0];
  const inputKey = task?.id ?? contact.id;
  const input = savedInputs[inputKey] ?? EMPTY_INPUT;
  const revisionChanged = Boolean(
    task && input.revision && input.revision !== task.version,
  );
  const updateInput = (patch: Partial<SavedInput>) =>
    setSavedInputs((current) => ({
      ...current,
      [inputKey]: {
        ...(current[inputKey] ?? EMPTY_INPUT),
        ...patch,
        revision:
          patch.revision ?? current[inputKey]?.revision ?? task?.version ?? "",
      },
    }));
  const hasActions =
    permissions.canCall ||
    permissions.canMessage ||
    permissions.canDraft ||
    permissions.canManage;
  const nextTouch = formatOutboundEasternTime(task?.dueAt);

  return (
    <div className="space-y-4">
      {item.contacts.length > 1 ? (
        <label className="grid gap-2 text-base font-medium">
          Contact
          <select
            className={INPUT}
            value={contact.id}
            onChange={(event) => setContactId(event.target.value)}
          >
            {item.contacts.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
                {candidate.doNotContact ? " — Do not contact" : ""}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <h3 className="text-base font-semibold">{contact.name}</h3>
      )}

      <div className="space-y-1 break-words text-sm text-[color:var(--team-text-muted)]">
        <p>{contact.phone || "No phone saved"}</p>
        <p>{contact.email || "No email saved"}</p>
      </div>

      {task && !outreachBlocked ? (
        <div className="border-y border-[color:var(--team-border)] py-3">
          <h3 className="text-base font-semibold">Next step</h3>
          <p className="mt-1 text-sm leading-relaxed">
            {!hasActions
              ? "Review this contact’s follow-up and history."
              : task.lastDisposition === "callback_requested"
                ? `Call ${contact.name} back${nextTouch ? ` ${nextTouch}` : " at the agreed time"}, then record the outcome.`
                : nextTouch
                  ? `Follow up with ${contact.name} ${nextTouch}, then record the outcome.`
                  : `Contact ${contact.name} with a first introduction, then record what happened.`}
          </p>
          <p className="mt-2 text-sm text-[color:var(--team-text-muted)]">
            Last outcome: {outboundOutcomeLabel(task.lastDisposition)}
          </p>
        </div>
      ) : null}

      {outreachBlocked ? (
        <div role="status" className={teamStatePanelClass("danger")}>
          <p className="font-semibold">Do not contact — outreach is blocked</p>
          <p className="mt-1">
            Calls, messages, drafts, outcomes, and callbacks are unavailable for{" "}
            {contact.name}.
          </p>
          {contact.doNotContactReason ? (
            <p className="mt-2">{contact.doNotContactReason}</p>
          ) : null}
        </div>
      ) : !hasActions ? (
        <p className="text-sm text-[color:var(--team-text-muted)]">
          You have read-only access to this account.
        </p>
      ) : (
        <>
          {tasks.length > 1 &&
          (permissions.canManage ||
            permissions.canDraft ||
            permissions.canCall) ? (
            <label className="grid gap-2 text-base font-medium">
              Outreach task
              <select
                className={INPUT}
                value={task?.id ?? ""}
                onChange={(event) =>
                  setTaskSelections((current) => ({
                    ...current,
                    [contact.id]: event.target.value,
                  }))
                }
              >
                {!task ? (
                  <option value="">Choose this contact’s task</option>
                ) : null}
                {tasks.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.title || "Outreach task"} ·{" "}
                    {formatOutboundEasternTime(candidate.dueAt) ??
                      "Not started"}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {channels.length > 1 &&
          (permissions.canMessage || permissions.canDraft) ? (
            <label className="grid gap-2 text-base font-medium">
              Message channel
              <select
                className={INPUT}
                value={channel}
                onChange={(event) =>
                  setChannelSelections((current) => ({
                    ...current,
                    [contact.id]: event.target.value as "email" | "sms",
                  }))
                }
              >
                <option value="email">Email</option>
                <option value="sms">Text message</option>
              </select>
            </label>
          ) : null}

          <div className="flex flex-wrap gap-2">
            {permissions.canCall && contact.phone?.trim() ? (
              <form action={startContactCallAction}>
                <input type="hidden" name="contactId" value={contact.id} />
                {task ? (
                  <input type="hidden" name="taskId" value={task.id} />
                ) : null}
                <input
                  type="hidden"
                  name="idempotencyKey"
                  value={callKeys[task?.id ?? contact.id]}
                />
                <input
                  type="hidden"
                  name="explicitNewAttempt"
                  value="START NEW CALL"
                />
                <SubmitButton
                  className={teamButtonClass("primary")}
                  pendingLabel="Starting call…"
                >
                  Call
                </SubmitButton>
              </form>
            ) : null}
            {permissions.canMessage && channel ? (
              <form action={openContactThreadAction}>
                <input type="hidden" name="contactId" value={contact.id} />
                <input type="hidden" name="channel" value={channel} />
                <SubmitButton
                  className={teamButtonClass("secondary")}
                  pendingLabel="Opening Inbox…"
                >
                  Open {channel === "email" ? "email" : "text"} in Inbox
                </SubmitButton>
              </form>
            ) : null}
          </div>
          {!channels.length ? (
            <p className="text-sm text-[color:var(--team-text-muted)]">
              Save a phone number or email in the contact record before calling
              or messaging.
            </p>
          ) : null}

          {permissions.canManage && task ? (
            <form
              action={setOutboundDispositionAction}
              className="space-y-3 border-t border-[color:var(--team-border)] pt-4"
            >
              <h3 className="text-base font-semibold">What happened?</h3>
              {revisionChanged ? (
                <div role="status" className={teamStatePanelClass("warning")}>
                  <p>
                    This task changed since you started this update. Your notes
                    are kept below; check the latest task before saving them
                    again.
                  </p>
                  <button
                    type="button"
                    className={`${teamButtonClass("secondary")} mt-3`}
                    onClick={() => updateInput({ revision: task.version })}
                  >
                    I reviewed the update — keep my notes
                  </button>
                  <button
                    type="button"
                    className={`${teamButtonClass("secondary")} mt-2`}
                    onClick={() =>
                      updateInput({
                        outcome: "",
                        recap: "",
                        callbackAt: "",
                        revision: task.version,
                      })
                    }
                  >
                    Clear this outcome and recap
                  </button>
                </div>
              ) : null}
              <input type="hidden" name="taskId" value={task.id} />
              <input
                type="hidden"
                name="expectedVersion"
                value={task.version}
              />
              <input
                type="hidden"
                name="idempotencyKey"
                value={outcomeKeys[task.id]}
              />
              <label className="grid gap-2 text-base font-medium">
                Outcome
                <select
                  name="disposition"
                  required
                  value={input.outcome}
                  onChange={(event) =>
                    updateInput({ outcome: event.target.value })
                  }
                  className={INPUT}
                >
                  <option value="">Choose an outcome</option>
                  {OUTCOMES.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              {input.outcome === "callback_requested" ? (
                <label className="grid gap-2 text-base font-medium">
                  Callback date and time (Eastern)
                  <input
                    name="callbackAt"
                    type="datetime-local"
                    required
                    value={input.callbackAt}
                    onChange={(event) =>
                      updateInput({ callbackAt: event.target.value })
                    }
                    className={`${INPUT} min-w-0 max-w-full`}
                    aria-describedby={`${prefix}-callback-help`}
                  />
                  <span
                    id={`${prefix}-callback-help`}
                    className="text-sm font-normal text-[color:var(--team-text-muted)]"
                  >
                    Use America/New_York time. A time skipped or repeated when
                    the clocks change must be replaced with an unambiguous time.
                  </span>
                </label>
              ) : null}
              {input.outcome === "dnc" ? (
                <p role="status" className={teamStatePanelClass("warning")}>
                  Saving this stops outreach and marks this contact Do Not
                  Contact across the CRM.
                </p>
              ) : null}
              {input.outcome === "partner" ? (
                <p className="text-sm text-[color:var(--team-text-muted)]">
                  This records the relationship and stops this follow-up
                  sequence. Portal access is set up separately in Partners.
                </p>
              ) : null}
              <label className="grid gap-2 text-base font-medium">
                Quick recap{" "}
                <span className="text-sm font-normal text-[color:var(--team-text-muted)]">
                  Optional — useful details for the next person.
                </span>
                <textarea
                  name="recap"
                  maxLength={4000}
                  rows={3}
                  value={input.recap}
                  onChange={(event) =>
                    updateInput({ recap: event.target.value })
                  }
                  className={`${INPUT} resize-y`}
                />
              </label>
              <SubmitButton
                className={teamButtonClass(
                  input.outcome === "dnc" ? "danger" : "primary",
                )}
                pendingLabel="Saving outcome…"
                disabled={revisionChanged}
              >
                {input.outcome === "callback_requested"
                  ? "Save callback"
                  : input.outcome === "dnc"
                    ? "Save Do Not Contact"
                    : "Save outcome"}
              </SubmitButton>
              <p className="text-sm text-[color:var(--team-text-muted)]">
                Record only outreach that actually happened. Saving an outcome
                updates the follow-up schedule; it does not send a message.
              </p>
            </form>
          ) : permissions.canManage ? (
            <p role="status" className={teamStatePanelClass("warning")}>
              No matching open task is available for this contact. Refresh the
              queue before recording an outcome.
            </p>
          ) : null}

          {permissions.canDraft && channel ? (
            <details className="border-t border-[color:var(--team-border)]">
              <summary className={SUMMARY}>Help writing a message</summary>
              <p className="text-sm text-[color:var(--team-text-muted)]">
                Create a suggestion in Inbox. Nothing sends until you review and
                send it yourself.
              </p>
              <form
                action={
                  draftKind === "follow_up"
                    ? draftOutboundFollowupAction
                    : draftOutboundFirstTouchAction
                }
                className="mt-3 space-y-3 pb-2"
              >
                <input type="hidden" name="contactId" value={contact.id} />
                {task ? (
                  <input type="hidden" name="taskId" value={task.id} />
                ) : null}
                <input type="hidden" name="channel" value={channel} />
                <label className="grid gap-2 text-base font-medium">
                  Message type
                  <select
                    value={draftKind}
                    onChange={(event) =>
                      setDraftKind(event.target.value as "first" | "follow_up")
                    }
                    className={INPUT}
                  >
                    <option value="first">First introduction</option>
                    <option value="follow_up">Follow-up</option>
                  </select>
                </label>
                {draftKind === "follow_up" ? (
                  <>
                    <label className="grid gap-2 text-base font-medium">
                      Latest outcome
                      <select
                        name="disposition"
                        value={input.draftOutcome}
                        onChange={(event) =>
                          updateInput({ draftOutcome: event.target.value })
                        }
                        className={INPUT}
                      >
                        <option value="">Use saved history</option>
                        {OUTCOMES.filter(([value]) => value !== "dnc").map(
                          ([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ),
                        )}
                      </select>
                    </label>
                    <label className="grid gap-2 text-base font-medium">
                      Extra context (optional)
                      <textarea
                        name="recap"
                        maxLength={4000}
                        rows={3}
                        value={input.draftRecap}
                        onChange={(event) =>
                          updateInput({ draftRecap: event.target.value })
                        }
                        className={`${INPUT} resize-y`}
                      />
                    </label>
                  </>
                ) : null}
                <SubmitButton
                  className={teamButtonClass("secondary")}
                  pendingLabel="Preparing suggestion…"
                >
                  Create {channel === "email" ? "email" : "text"} suggestion
                </SubmitButton>
              </form>
            </details>
          ) : null}
        </>
      )}
    </div>
  );
}
