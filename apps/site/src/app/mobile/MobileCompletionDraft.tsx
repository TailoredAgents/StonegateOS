"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  saveMobileAppointmentCompletionAction,
  updateMobileAppointmentStatusAction,
} from "./actions";
import {
  CompletionDraftContext,
  type MobileCompletionDraftValues,
} from "./mobile-completion-draft-context";
import {
  clearMobileJobDraft,
  readMobileJobDraft,
  writeMobileJobDraft,
  type MobileJobDraftScope,
} from "./lib/mobile-job-drafts";

type SavedCompletion = {
  values: MobileCompletionDraftValues;
  request?: Array<[string, string]>;
};

export function MobileCompletionForm({
  modern,
  ...props
}: React.ComponentProps<typeof MobileCompletionDraftForm> & {
  modern: boolean;
}) {
  return modern ? (
    <MobileCompletionDraftForm {...props} />
  ) : (
    <form
      action={updateMobileAppointmentStatusAction}
      className="mt-3 space-y-3"
    >
      {props.children}
    </form>
  );
}

function completionValues(form: FormData): MobileCompletionDraftValues {
  const text = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value : undefined;
  };
  const crewHours: Record<string, string> = {};
  const crewRates: Record<string, string> = {};
  form.forEach((value, key) => {
    if (typeof value !== "string") return;
    if (key.startsWith("crewHours:")) crewHours[key.slice(10)] = value;
    if (key.startsWith("crewHourlyRate:")) crewRates[key.slice(15)] = value;
  });
  return {
    finalTotal: text("finalTotal"),
    expectedFinalTotalCents: text("expectedFinalTotalCents"),
    finalTotalChangeReason: text("finalTotalChangeReason"),
    crewMemberIds: form
      .getAll("crewMemberId")
      .filter((id): id is string => typeof id === "string"),
    crewHours,
    crewRates,
    proofOverrideReason: text("proofOverrideReason"),
    sendReviewRequest: form.has("sendReviewRequest"),
  };
}

function validSavedCompletion(value: unknown): value is SavedCompletion {
  if (!value || typeof value !== "object" || !("values" in value)) return false;
  const candidate = value.values;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
    return false;
  const fields = candidate as Record<string, unknown>;
  for (const key of [
    "finalTotal",
    "expectedFinalTotalCents",
    "finalTotalChangeReason",
    "proofOverrideReason",
  ] as const) {
    if (
      key in fields &&
      fields[key] !== undefined &&
      typeof fields[key] !== "string"
    )
      return false;
  }
  if (
    "crewMemberIds" in fields &&
    (!Array.isArray(fields["crewMemberIds"]) ||
      !fields["crewMemberIds"].every((id) => typeof id === "string"))
  )
    return false;
  for (const key of ["crewHours", "crewRates"] as const) {
    if (
      key in fields &&
      (!fields[key] ||
        typeof fields[key] !== "object" ||
        Array.isArray(fields[key]) ||
        !Object.values(fields[key]).every((entry) => typeof entry === "string"))
    )
      return false;
  }
  if (
    fields["sendReviewRequest"] !== undefined &&
    typeof fields["sendReviewRequest"] !== "boolean"
  )
    return false;
  if (
    "request" in value &&
    value.request !== undefined &&
    (!Array.isArray(value.request) ||
      !value.request.every(
        (entry: unknown) =>
          Array.isArray(entry) &&
          entry.length === 2 &&
          entry.every((item) => typeof item === "string"),
      ))
  )
    return false;
  return true;
}

export function MobileCompletionDraftForm({
  employeeId,
  appointmentId,
  appointmentVersion,
  appointmentCompleted = false,
  serverValues,
  children,
}: {
  employeeId: string;
  appointmentId: string;
  appointmentVersion: string | null;
  appointmentCompleted?: boolean;
  serverValues?: MobileCompletionDraftValues;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const formRef = React.useRef<HTMLFormElement>(null);
  const scope = React.useMemo<MobileJobDraftScope>(
    () => ({
      employeeId,
      appointmentId,
      appointmentVersion,
      kind: "completion",
    }),
    [employeeId, appointmentId, appointmentVersion],
  );
  const [restoration, setRestoration] = React.useState({
    draft: null as MobileCompletionDraftValues | null,
    revision: 0,
  });
  const [olderDraft, setOlderDraft] =
    React.useState<MobileCompletionDraftValues | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const [uncertain, setUncertain] = React.useState(false);
  const [completed, setCompleted] = React.useState(false);
  const requestRef = React.useRef<Array<[string, string]> | undefined>(
    undefined,
  );
  const pendingRef = React.useRef(false);
  const dirtyRef = React.useRef(false);
  const hydratedRef = React.useRef(false);
  const editingVersionRef = React.useRef(appointmentVersion);
  const [versionChanged, setVersionChanged] = React.useState(false);
  const draftScope = () => ({
    ...scope,
    appointmentVersion: editingVersionRef.current,
  });

  React.useEffect(() => {
    if (!dirtyRef.current && !requestRef.current) {
      if (editingVersionRef.current !== appointmentVersion && serverValues)
        setRestoration((current) => ({
          draft: serverValues,
          revision: current.revision + 1,
        }));
      editingVersionRef.current = appointmentVersion;
    }
    setVersionChanged(editingVersionRef.current !== appointmentVersion);
  }, [appointmentVersion, serverValues]);

  React.useEffect(() => {
    const noteSaved = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          appointmentId: string;
          previousVersion: string;
          version: string;
        }>
      ).detail;
      if (
        !detail ||
        detail.appointmentId !== appointmentId ||
        detail.previousVersion !== editingVersionRef.current ||
        requestRef.current
      )
        return;
      // A locally verified note-only change cannot alter crew or money.
      editingVersionRef.current = detail.version;
      setVersionChanged(false);
      const form = formRef.current;
      if (dirtyRef.current && form)
        writeMobileJobDraft({ ...scope, appointmentVersion: detail.version }, {
          values: completionValues(new FormData(form)),
        } satisfies SavedCompletion);
    };
    window.addEventListener(
      "stonegate:mobile-appointment-note-saved",
      noteSaved,
    );
    return () =>
      window.removeEventListener(
        "stonegate:mobile-appointment-note-saved",
        noteSaved,
      );
  }, [appointmentId, scope]);

  React.useEffect(() => {
    if (hydratedRef.current || completed) return;
    hydratedRef.current = true;
    const saved = readMobileJobDraft<unknown>(scope);
    if (!saved || !validSavedCompletion(saved.values)) return;
    const savedCompletion = saved.values;
    if (savedCompletion.request) {
      requestRef.current = savedCompletion.request;
      setUncertain(true);
      setMessage(
        "A previous save needs confirmation. Retry checks that same save; it will not create a second completion.",
      );
    }
    if (saved.matchesVersion) {
      setRestoration((current) => ({
        draft: savedCompletion.values,
        revision: current.revision + 1,
      }));
      dirtyRef.current = true;
    } else {
      setOlderDraft(savedCompletion.values);
    }
  }, [scope, completed]);

  // These optional native fields are intentionally not financial inputs.
  React.useEffect(() => {
    const form = formRef.current;
    const draft = restoration.draft;
    if (!form || !draft) return;
    const reason = form.elements.namedItem("proofOverrideReason");
    if (reason instanceof HTMLTextAreaElement)
      reason.value = draft.proofOverrideReason ?? "";
    const review = form.elements.namedItem("sendReviewRequest");
    if (review instanceof HTMLInputElement)
      review.checked = draft.sendReviewRequest === true;
  }, [restoration]);

  const capture = () => {
    dirtyRef.current = true;
    queueMicrotask(() => {
      const form = formRef.current;
      if (!form || completed) return;
      const result = writeMobileJobDraft(draftScope(), {
        values: completionValues(new FormData(form)),
        ...(requestRef.current ? { request: requestRef.current } : {}),
      } satisfies SavedCompletion);
      if (!requestRef.current)
        setMessage(
          result.persisted
            ? "Draft saved on this phone"
            : "Draft kept while this page stays open. Phone storage is unavailable.",
        );
    });
  };

  const submitForm = async (form: HTMLFormElement) => {
    if (pendingRef.current || completed) return;
    const current = new FormData(form);
    let entries = requestRef.current;
    if (!entries) {
      if (editingVersionRef.current)
        current.set("expectedVersion", editingVersionRef.current);
      current.set(
        "idempotencyKey",
        `mobile-appointment-status:${crypto.randomUUID()}`,
      );
      entries = [];
      current.forEach((value, key) => {
        if (typeof value === "string") entries!.push([key, value]);
      });
      requestRef.current = entries;
    }
    writeMobileJobDraft(draftScope(), {
      values: completionValues(current),
      request: entries,
    } satisfies SavedCompletion);
    const data = new FormData();
    for (const [key, value] of entries) data.append(key, value);
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await saveMobileAppointmentCompletionAction(data);
      if (result.ok) {
        const laterEdits =
          JSON.stringify(completionValues(current)) !==
          JSON.stringify(completionValues(data));
        if (laterEdits) {
          writeMobileJobDraft(draftScope(), {
            values: completionValues(current),
          } satisfies SavedCompletion);
        } else {
          clearMobileJobDraft(scope);
        }
        requestRef.current = undefined;
        dirtyRef.current = false;
        setUncertain(false);
        setCompleted(true);
        setMessage(
          laterEdits
            ? `${result.message} Your later edits remain saved for review.`
            : result.message,
        );
        router.refresh();
      } else {
        setError(result.error);
        setUncertain(result.uncertain === true);
        if (!result.uncertain) {
          requestRef.current = undefined;
          writeMobileJobDraft(draftScope(), {
            values: completionValues(current),
          } satisfies SavedCompletion);
        }
      }
    } catch {
      setUncertain(true);
      setError(
        "The save could not be confirmed. Your entries are kept. Retry checks the same save.",
      );
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  return (
    <CompletionDraftContext.Provider value={{ ...restoration, error }}>
      <form
        ref={formRef}
        onSubmit={(event) => {
          if (event.defaultPrevented) return;
          event.preventDefault();
          void submitForm(event.currentTarget);
        }}
        onInput={capture}
        onChange={capture}
        className="mt-3 space-y-3"
        data-mobile-completion-form
      >
        {versionChanged && serverValues && !completed ? (
          <details className="rounded-lg border border-amber-300/30 p-3 text-sm text-amber-100">
            <summary className="min-h-11 cursor-pointer py-2">
              Booking updated elsewhere
            </summary>
            <p className="my-2">
              Your entries are kept. Latest saved total:{" "}
              {serverValues.finalTotal || "Not set"} · Crew:{" "}
              {serverValues.crewMemberIds?.length ?? 0}.
            </p>
            <button
              type="button"
              className="min-h-11 rounded-lg border border-white/20 px-3"
              onClick={() => {
                if (formRef.current)
                  setOlderDraft(
                    completionValues(new FormData(formRef.current)),
                  );
                editingVersionRef.current = appointmentVersion;
                dirtyRef.current = false;
                setVersionChanged(false);
                setRestoration((current) => ({
                  draft: serverValues,
                  revision: current.revision + 1,
                }));
              }}
            >
              Use latest saved details
            </button>
          </details>
        ) : null}
        {olderDraft ? (
          <details className="rounded-lg border border-white/10 p-3 text-sm text-slate-300">
            <summary className="min-h-11 cursor-pointer py-2">
              Saved entries from an earlier version
            </summary>
            <p className="my-2">
              The booking changed. Current saved details are shown. You can
              review your earlier entries here.
            </p>
            <p>
              Entered total: {olderDraft.finalTotal || "Not entered"} · Crew:{" "}
              {olderDraft.crewMemberIds?.length ?? 0}
            </p>
            <button
              type="button"
              className="mt-2 min-h-11 rounded-md border border-white/20 px-3"
              onClick={() => {
                editingVersionRef.current = appointmentVersion;
                setVersionChanged(false);
                setRestoration((current) => ({
                  draft: olderDraft,
                  revision: current.revision + 1,
                }));
                setOlderDraft(null);
                dirtyRef.current = true;
                setMessage(
                  "Saved entries restored for review. Changes to the saved total are still checked.",
                );
              }}
            >
              Review saved entries in form
            </button>
          </details>
        ) : null}
        {message ? (
          <p role="status" className="text-sm text-slate-300">
            {message}
          </p>
        ) : null}
        {error ? (
          <p
            role="alert"
            className="rounded-lg border border-amber-300/30 bg-amber-300/10 p-3 text-sm text-amber-100"
          >
            {error}
          </p>
        ) : null}
        {uncertain ? (
          <div className="space-y-2 text-sm text-amber-100">
            <p>
              Check the previous save using its original details. Your current
              entries stay in your draft.
            </p>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                if (formRef.current) void submitForm(formRef.current);
              }}
              className="min-h-11 rounded-lg border border-amber-300/40 px-3 font-semibold"
            >
              Check previous save
            </button>
          </div>
        ) : null}
        {completed && appointmentCompleted && serverValues ? (
          <button
            type="button"
            className="min-h-11 rounded-lg border border-white/20 px-3 text-sm font-semibold text-cyan-100"
            onClick={() => {
              const saved = readMobileJobDraft<unknown>(scope);
              if (saved && validSavedCompletion(saved.values))
                setOlderDraft(saved.values.values);
              editingVersionRef.current = appointmentVersion;
              dirtyRef.current = false;
              setVersionChanged(false);
              setRestoration((current) => ({
                draft: serverValues,
                revision: current.revision + 1,
              }));
              setCompleted(false);
              setMessage(null);
            }}
          >
            Edit completed job
          </button>
        ) : null}
        <fieldset disabled={pending || completed} className="min-w-0 space-y-3">
          {children}
        </fieldset>
        {pending ? (
          <p role="status" className="text-sm text-cyan-100">
            Saving job…
          </p>
        ) : null}
      </form>
    </CompletionDraftContext.Provider>
  );
}
