"use client";

import React, {
  startTransition,
  useActionState,
  useEffect,
  useRef,
  useState,
} from "react";

type Snapshot = Record<string, string[]>;
type AutomationActionState = {
  ok: boolean | null;
  message: string;
};

const INITIAL_ACTION_STATE: AutomationActionState = {
  ok: null,
  message: "",
};

const FIELD_LABELS: Record<string, string> = {
  mode: "Global mode",
  emergencyStop: "Global emergency stop",
  channelMode_sms: "SMS mode",
  channelMode_dm: "Messenger mode",
  channelMode_email: "Email mode",
  plannerAutoSendEnabled: "Planner auto-send",
  liveReplyAutonomyEnabled: "Live reply autonomy",
  facebookCloserEmergencyStop: "Facebook emergency stop",
};

function snapshotForm(form: HTMLFormElement): Snapshot {
  const snapshot: Snapshot = {};
  new FormData(form).forEach((value, key) => {
    if (
      key === "automationReviewConfirmed" ||
      key === "expectedVersion" ||
      key === "idempotencyKey"
    ) {
      return;
    }
    const normalized = typeof value === "string" ? value : value.name;
    snapshot[key] = [...(snapshot[key] ?? []), normalized].sort();
  });
  return snapshot;
}

function friendlyLabel(value: string): string {
  return (
    FIELD_LABELS[value] ??
    value
      .replace(/^facebookCloser/u, "Facebook closer ")
      .replace(/^facebookCoaching/u, "Facebook coaching ")
      .replace(/^planner/u, "Planner ")
      .replace(/^liveReply/u, "Live reply ")
      .replace(/_/gu, " ")
      .replace(/([a-z])([A-Z])/gu, "$1 $2")
      .toLowerCase()
      .replace(/^./u, (character) => character.toUpperCase())
  );
}

function displayValue(values: string[] | undefined): string {
  if (!values || values.length === 0) return "Off / none";
  const value = values.join(", ");
  const publicValue = value
    .replace(/\bautomatic\b/gu, "Automatic")
    .replace(/\bassist\b/gu, "Assist")
    .replace(/\boff\b/gu, "Off")
    .replace(/^on$/u, "On");
  return publicValue.length > 90 ? `${publicValue.slice(0, 87)}…` : publicValue;
}

function changedFields(baseline: Snapshot, current: Snapshot): string[] {
  return [...new Set([...Object.keys(baseline), ...Object.keys(current)])]
    .filter(
      (key) =>
        JSON.stringify(baseline[key] ?? []) !==
        JSON.stringify(current[key] ?? []),
    )
    .sort();
}

export function AutomationReviewForm({
  action,
  children,
  canWrite,
  expectedVersion,
  idempotencyKey,
}: {
  action: (formData: FormData) => Promise<AutomationActionState>;
  children: React.ReactNode;
  canWrite: boolean;
  expectedVersion: string;
  idempotencyKey: string;
}): React.ReactElement {
  const formRef = useRef<HTMLFormElement>(null);
  const [baseline, setBaseline] = useState<Snapshot>({});
  const [current, setCurrent] = useState<Snapshot>({});
  const [confirmed, setConfirmed] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [actionState, formAction, isPending] = useActionState(
    async (_state: AutomationActionState, formData: FormData) =>
      action(formData),
    INITIAL_ACTION_STATE,
  );

  useEffect(() => {
    if (!formRef.current) return;
    const initial = snapshotForm(formRef.current);
    setBaseline(initial);
    setCurrent(initial);
    setConfirmed(false);
    setSubmitError(null);
  }, [expectedVersion, idempotencyKey]);

  const changes = changedFields(baseline, current);
  const showActionFeedback =
    Boolean(actionState.message) &&
    (actionState.ok !== true || changes.length === 0);
  const updateSnapshot = (event: React.FormEvent<HTMLFormElement>): void => {
    const target = event.target as HTMLInputElement | null;
    if (target?.name === "automationReviewConfirmed") return;
    if (!formRef.current) return;
    setCurrent(snapshotForm(formRef.current));
    setConfirmed(false);
    setSubmitError(null);
  };

  return (
    <form
      ref={formRef}
      action={formAction}
      className="mt-4 space-y-4 text-xs text-slate-600"
      onInput={updateSnapshot}
      onChange={updateSnapshot}
      onSubmit={(event) => {
        event.preventDefault();
        if (!canWrite || changes.length === 0 || !confirmed) {
          setSubmitError(
            !canWrite
              ? "You have read-only access to automation settings."
              : changes.length === 0
                ? "Make a change before saving."
                : "Review the change list and confirm it before saving.",
          );
          return;
        }
        const submission = new FormData(event.currentTarget);
        setSubmitError(null);
        startTransition(() => formAction(submission));
      }}
    >
      <input type="hidden" name="expectedVersion" value={expectedVersion} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <fieldset
        disabled={!canWrite}
        className="space-y-4 disabled:cursor-not-allowed disabled:opacity-70 [&_button]:min-h-11 [&_input]:min-h-11 [&_select]:min-h-11"
      >
        {children}
      </fieldset>

      <section
        aria-labelledby="automation-change-review-heading"
        className="rounded-2xl border border-blue-200 bg-blue-50 p-4 text-blue-950"
      >
        <h4
          id="automation-change-review-heading"
          className="text-sm font-semibold"
        >
          Review pending changes
        </h4>
        {changes.length === 0 ? (
          <p className="mt-2 text-xs">No unsaved changes.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {changes.map((key) => (
              <li key={key} className="rounded-xl bg-white/80 px-3 py-2">
                <span className="font-semibold">{friendlyLabel(key)}:</span>{" "}
                <span>{displayValue(baseline[key])}</span>
                <span aria-hidden="true"> → </span>
                <span className="sr-only"> changes to </span>
                <span>{displayValue(current[key])}</span>
              </li>
            ))}
          </ul>
        )}
        <label className="mt-3 flex min-h-11 items-center gap-3 rounded-xl border border-blue-200 bg-white px-3 py-2 font-medium">
          <input
            type="checkbox"
            name="automationReviewConfirmed"
            checked={confirmed}
            onChange={(event) => {
              setConfirmed(event.target.checked);
              setSubmitError(null);
            }}
            disabled={!canWrite || changes.length === 0}
            className="h-5 w-5 rounded border-blue-300"
          />
          I reviewed these settings and their sending impact.
        </label>
      </section>

      <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-950">
        This form protects against stale saves and duplicate clicks. A newer
        teammate save is never overwritten; refresh and review it before
        retrying.
      </p>
      {showActionFeedback ? (
        <p
          role={actionState.ok ? "status" : "alert"}
          aria-live="polite"
          className={
            actionState.ok
              ? "text-sm font-medium text-emerald-700"
              : "text-sm font-medium text-rose-700"
          }
        >
          {actionState.message}
        </p>
      ) : null}
      {submitError ? (
        <p role="alert" className="text-sm font-medium text-rose-700">
          {submitError}
        </p>
      ) : null}
      {!canWrite ? (
        <p role="status" className="text-sm font-medium text-amber-800">
          Read-only access: an Automation administrator must save changes.
        </p>
      ) : null}
      <button
        type="submit"
        className="inline-flex min-h-11 items-center rounded-full bg-primary-600 px-5 py-2 text-xs font-semibold text-white shadow-lg shadow-primary-200/50 transition hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
        disabled={!canWrite || changes.length === 0 || !confirmed || isPending}
      >
        {isPending ? "Saving..." : "Save reviewed settings"}
      </button>
    </form>
  );
}
