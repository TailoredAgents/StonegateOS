"use client";

import React from "react";
import type { Route } from "next";
import { useRouter, useSearchParams } from "next/navigation";
import { insertInboxComposerDraft } from "../inbox-composer-drafts";
import {
  loadInboxContactTasksAction,
  loadInboxDiagnosticsAction,
} from "../inbox-tools-actions";
import { TeamWorkflowDrawer } from "./TeamWorkflowDrawer";
import { InboxContactNotesClient } from "./InboxContactNotesClient";
import { InboxContactRemindersClient } from "./InboxContactRemindersClient";
import { ContactSalesAgentNextActionClient } from "./ContactSalesAgentNextActionClient";
import { ContactSalesAgentMemoryClient } from "./ContactSalesAgentMemoryClient";
import { ContactMediaAnalysisClient } from "./ContactMediaAnalysisClient";
import { teamButtonClass } from "./team-ui";

function LazySection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  const [opened, setOpened] = React.useState(false);
  return (
    <details
      className="rounded-xl border border-[color:var(--team-border)] p-3"
      onToggle={(e) => {
        if (e.currentTarget.open) setOpened(true);
      }}
    >
      <summary className="cursor-pointer text-sm font-semibold">
        {label}
      </summary>
      {opened ? <div className="mt-3">{children}</div> : null}
    </details>
  );
}

export function InboxContactToolsClient({
  contactId,
  readOnly,
}: {
  contactId: string;
  readOnly: boolean;
}) {
  return (
    <div className="space-y-3">
      <LazySection label="Notes">
        <ContactTasks contactId={contactId} kind="notes" readOnly={readOnly} />
      </LazySection>
      <LazySection label="Reminders">
        <ContactTasks
          contactId={contactId}
          kind="reminders"
          readOnly={readOnly}
        />
      </LazySection>
      <LazySection label="Automation details">
        <ContactSalesAgentNextActionClient
          contactId={contactId}
          readOnly={readOnly}
        />
        <LazySection label="Agent memory">
          <ContactSalesAgentMemoryClient contactId={contactId} />
        </LazySection>
      </LazySection>
      <LazySection label="Photo analysis">
        <ContactMediaAnalysisClient contactId={contactId} />
      </LazySection>
    </div>
  );
}

function ContactTasks({
  contactId,
  kind,
  readOnly,
}: {
  contactId: string;
  kind: "notes" | "reminders";
  readOnly: boolean;
}) {
  const [result, setResult] = React.useState<Awaited<
    ReturnType<typeof loadInboxContactTasksAction>
  > | null>(null);
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    let active = true;
    setResult(null);
    void loadInboxContactTasksAction(contactId, kind)
      .then((result) => {
        if (active) setResult(result);
      })
      .catch(() => {
        if (active)
          setResult({
            ok: false,
            error: "Could not load customer details. Please retry.",
          });
      });
    return () => {
      active = false;
    };
  }, [contactId, kind, attempt]);
  if (!result)
    return (
      <p role="status" className="text-sm">
        Loading {kind}…
      </p>
    );
  if (!result.ok)
    return (
      <div role="alert">
        <p className="mb-2 text-sm">{result.error}</p>
        <button
          className={teamButtonClass("secondary", "sm")}
          onClick={() => setAttempt((v) => v + 1)}
        >
          Retry {kind}
        </button>
      </div>
    );
  return kind === "notes" ? (
    <InboxContactNotesClient
      contactId={contactId}
      initialNotes={result.notes}
      readOnly={readOnly}
    />
  ) : (
    <InboxContactRemindersClient
      contactId={contactId}
      initialReminders={result.reminders}
      readOnly={readOnly}
    />
  );
}

export function InboxAiReplyClient({
  employeeId,
  contactId,
  threadId,
  channel,
  initialDraft,
}: {
  employeeId: string;
  contactId: string;
  threadId: string;
  channel: "sms" | "email" | "dm";
  initialDraft: { body: string; subject?: string } | null;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState(
    initialDraft ? { ...initialDraft, threadId, channel } : null,
  );
  const abort = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => abort.current?.abort(), []);
  React.useEffect(() => {
    if (initialDraft) setDraft({ ...initialDraft, threadId, channel });
  }, [initialDraft, threadId, channel]);
  async function prepare() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setOpen(true);
    const controller = new AbortController();
    abort.current = controller;
    try {
      const res = await fetch(
        `/api/team/inbox/threads/${encodeURIComponent(threadId)}/suggest`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channel }),
          signal: controller.signal,
        },
      );
      const data = (await res.json()) as {
        ok?: boolean;
        threadId?: string;
        channel?: unknown;
        draft?: { body?: unknown; subject?: unknown };
      } | null;
      if (!res.ok || data?.ok !== true)
        throw new Error(
          "A draft could not be prepared. You can still write your reply below.",
        );
      if (
        !data.draft ||
        typeof data.draft.body !== "string" ||
        typeof data.threadId !== "string" ||
        (data.channel !== "sms" &&
          data.channel !== "email" &&
          data.channel !== "dm")
      )
        throw new Error(
          "No new draft is available. You can write your reply below.",
        );
      if (data.threadId === threadId && data.channel !== channel) {
        throw new Error(
          "The draft channel could not be confirmed. Please try again.",
        );
      }
      if (data.threadId !== threadId) {
        // The planner can suggest another channel. Confirm the target customer
        // before placing any generated text in that channel's saved draft.
        const target = await fetch(
          `/api/team/inbox/threads/${encodeURIComponent(data.threadId)}?limit=1`,
          { cache: "no-store", signal: controller.signal },
        );
        const targetData = (await target.json().catch(() => null)) as {
          thread?: {
            id?: string;
            channel?: string;
            contact?: { id?: string } | null;
            partnerJob?: unknown;
          };
        } | null;
        if (
          !target.ok ||
          targetData?.thread?.id !== data.threadId ||
          targetData.thread.channel !== data.channel ||
          targetData.thread.contact?.id !== contactId ||
          targetData.thread.partnerJob
        ) {
          throw new Error(
            "The customer for this draft could not be confirmed. Your existing reply is unchanged.",
          );
        }
      }
      setDraft({
        body: data.draft.body,
        subject:
          typeof data.draft.subject === "string"
            ? data.draft.subject
            : undefined,
        threadId: data.threadId,
        channel: data.channel,
      });
    } catch (e) {
      if (!controller.signal.aborted)
        setError(
          e instanceof Error ? e.message : "A draft could not be prepared.",
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  function useDraft() {
    if (!draft) return;
    insertInboxComposerDraft({
      employeeId,
      contactId,
      threadId: draft.threadId,
      channel: draft.channel,
      body: draft.body,
      subject: draft.subject,
    });
    setOpen(false);
    setNotice("Draft added to your reply.");
    if (draft.channel !== channel || draft.threadId !== threadId) {
      const url = new URL(window.location.href);
      url.searchParams.set("threadId", draft.threadId);
      url.searchParams.set("contactId", contactId);
      url.searchParams.set("channel", draft.channel);
      url.searchParams.delete("inbox_message_cursor");
      url.searchParams.delete("inbox_message_limit");
      router.push(`${url.pathname}${url.search}` as Route, { scroll: false });
    }
  }
  return (
    <div className="mb-1 flex flex-wrap items-center gap-2">
      <button
        className="min-h-9 rounded-lg px-2 text-xs font-semibold text-primary-700 hover:bg-[color:var(--team-panel-alt)]"
        onClick={() => (draft ? setOpen(true) : void prepare())}
        disabled={busy}
      >
        {busy ? "Preparing draft…" : draft ? "View draft" : "Draft a reply"}
      </button>
      {notice ? (
        <span
          role="status"
          className="text-xs text-[color:var(--team-text-muted)]"
        >
          {notice}
        </span>
      ) : null}
      {open ? (
        <TeamWorkflowDrawer title="Reply draft" onClose={() => setOpen(false)}>
          {busy ? (
            <p role="status">
              Preparing a reply. You can close this panel and keep working.
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="mb-3 text-sm text-amber-800">
              {error}
            </p>
          ) : null}
          {draft ? (
            <>
              <p className="mb-3 text-sm text-[color:var(--team-text-muted)]">
                Review and edit this{" "}
                {draft.channel === "dm"
                  ? "Messenger"
                  : draft.channel.toUpperCase()}{" "}
                reply before sending.
              </p>
              {draft.subject ? (
                <p className="mb-2 font-semibold">{draft.subject}</p>
              ) : null}
              <p className="whitespace-pre-wrap break-words rounded-xl bg-[color:var(--team-panel-alt)] p-4 text-sm">
                {draft.body}
              </p>
              <button
                className={teamButtonClass("primary", "sm") + " mt-4"}
                onClick={useDraft}
              >
                Add to reply
              </button>
            </>
          ) : !busy ? (
            <button
              className={teamButtonClass("secondary", "sm")}
              onClick={() => void prepare()}
            >
              Try again
            </button>
          ) : null}
        </TeamWorkflowDrawer>
      ) : null}
    </div>
  );
}

export function InboxDiagnosticsClient() {
  const search = useSearchParams();
  const router = useRouter();
  const open = search.get("tools") === "diagnostics";
  const [attempt, setAttempt] = React.useState(0);
  const [result, setResult] = React.useState<Awaited<
    ReturnType<typeof loadInboxDiagnosticsAction>
  > | null>(null);
  React.useEffect(() => {
    if (!open) return;
    let active = true;
    setResult(null);
    void loadInboxDiagnosticsAction()
      .then((value) => {
        if (active) setResult(value);
      })
      .catch(() => {
        if (active)
          setResult({ ok: false, error: "Diagnostics could not be loaded." });
      });
    return () => {
      active = false;
    };
  }, [open, attempt]);
  if (!open) return null;
  return (
    <TeamWorkflowDrawer
      title="Inbox diagnostics"
      onClose={() => {
        const url = new URL(window.location.href);
        url.searchParams.delete("tools");
        router.replace(`${url.pathname}${url.search}` as Route, {
          scroll: false,
        });
      }}
    >
      {!result ? (
        <p role="status">Loading diagnostics…</p>
      ) : !result.ok ? (
        <div role="alert">
          <p>{result.error}</p>
          <button
            className={teamButtonClass("secondary", "sm")}
            onClick={() => setAttempt((v) => v + 1)}
          >
            Retry diagnostics
          </button>
        </div>
      ) : (
        <ul className="space-y-3">
          {result.providers.map((provider) => (
            <li
              key={provider.provider}
              className="rounded-xl border border-[color:var(--team-border)] p-3"
            >
              <p className="font-semibold">
                {provider.provider.replace(/_/g, " ")}:{" "}
                {provider.status === "healthy"
                  ? "Working"
                  : provider.status === "degraded"
                    ? "Needs attention"
                    : "No recent activity"}
              </p>
              {provider.status === "degraded" && provider.lastFailureDetail ? (
                <p className="mt-1 break-words text-sm">
                  {provider.lastFailureDetail.replace(/_/g, " ")}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </TeamWorkflowDrawer>
  );
}
