"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { saveMobileAppointmentNoteAction } from "./actions";
import {
  clearMobileJobDraft,
  readMobileJobDraft,
  writeMobileJobDraft,
} from "./lib/mobile-job-drafts";

type NoteDraft = {
  body: string;
  request?: { body: string; expectedVersion: string; idempotencyKey: string };
};

export function MobileAppointmentNoteForm({
  employeeId,
  appointmentId,
  appointmentVersion,
}: {
  employeeId: string;
  appointmentId: string;
  appointmentVersion: string;
}) {
  const router = useRouter();
  const scope = React.useMemo(
    () => ({ employeeId, appointmentId, appointmentVersion, kind: "note" }),
    [employeeId, appointmentId, appointmentVersion],
  );
  const [body, setBody] = React.useState("");
  const [message, setMessage] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const [uncertain, setUncertain] = React.useState(false);
  const requestRef = React.useRef<NoteDraft["request"]>(undefined);
  const pendingRef = React.useRef(false);
  const hydratedRef = React.useRef(false);

  React.useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    const saved = readMobileJobDraft<NoteDraft>(scope)?.values;
    if (!saved || typeof saved.body !== "string") return;
    setBody(saved.body);
    if (
      saved.request &&
      typeof saved.request.body === "string" &&
      typeof saved.request.expectedVersion === "string" &&
      typeof saved.request.idempotencyKey === "string"
    ) {
      requestRef.current = saved.request;
      setUncertain(true);
    }
  }, [scope]);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pendingRef.current) return;
    const request = requestRef.current ?? {
      body: body.trim(),
      expectedVersion: appointmentVersion,
      idempotencyKey: `mobile-appointment-note:${crypto.randomUUID()}`,
    };
    if (!request.body) {
      setError("Enter a note to save.");
      return;
    }
    requestRef.current = request;
    writeMobileJobDraft(scope, { body, request } satisfies NoteDraft);
    const data = new FormData();
    data.set("appointmentId", appointmentId);
    data.set("body", request.body);
    data.set("expectedVersion", request.expectedVersion);
    data.set("idempotencyKey", request.idempotencyKey);
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await saveMobileAppointmentNoteAction(data);
      if (result.ok) {
        window.dispatchEvent(
          new CustomEvent("stonegate:mobile-appointment-note-saved", {
            detail: {
              appointmentId,
              previousVersion: request.expectedVersion,
              version: result.version,
            },
          }),
        );
        requestRef.current = undefined;
        setUncertain(false);
        if (body.trim() !== request.body) {
          writeMobileJobDraft(
            { ...scope, appointmentVersion: result.version },
            { body } satisfies NoteDraft,
          );
          setMessage(
            "Previous note saved. Your newer text is kept as a draft.",
          );
        } else {
          clearMobileJobDraft(scope);
          setBody("");
          setMessage("Note saved");
        }
        router.refresh();
      } else {
        setError(result.error);
        setUncertain(result.uncertain === true);
        if (!result.uncertain) {
          requestRef.current = undefined;
          writeMobileJobDraft(scope, { body } satisfies NoteDraft);
        }
      }
    } catch {
      setError("The note could not be confirmed. Retry checks the same save.");
      setUncertain(true);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  return (
    <details
      className="rounded-lg border border-white/10 bg-slate-950 px-3"
      data-mobile-note
    >
      <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold text-cyan-100">
        Add note
      </summary>
      <form onSubmit={(event) => void submit(event)} className="space-y-3 pb-3">
        <label className="block">
          <span className="sr-only">Job note</span>
          <textarea
            name="body"
            value={body}
            disabled={pending}
            onChange={(event) => {
              const next = event.target.value;
              setBody(next);
              const saved = writeMobileJobDraft(scope, {
                body: next,
                ...(requestRef.current ? { request: requestRef.current } : {}),
              } satisfies NoteDraft);
              setMessage(
                saved.persisted
                  ? "Draft saved on this phone"
                  : "Draft kept while this page stays open",
              );
            }}
            rows={3}
            className="w-full rounded-lg border border-white/15 bg-slate-900 px-3 py-3 text-base text-white"
            placeholder="Gate code, access instructions, job notes…"
          />
        </label>
        {message ? (
          <p role="status" className="text-xs text-slate-400">
            {message}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-amber-100">
            {error}
          </p>
        ) : null}
        {uncertain ? (
          <p className="text-sm text-amber-100">
            Retry checks the previous note before saving another.
          </p>
        ) : null}
        <button
          type="submit"
          disabled={pending}
          className="min-h-11 w-full rounded-lg bg-cyan-300 px-3 py-2 font-semibold text-slate-950 disabled:opacity-60"
        >
          {pending
            ? "Saving…"
            : uncertain
              ? "Retry previous note"
              : "Save note"}
        </button>
      </form>
    </details>
  );
}
