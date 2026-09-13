"use client";

import React, { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import { Paperclip, X } from "lucide-react";
import {
  prepareInboxMessageAction,
  sendPreparedInboxMessageAction,
} from "../actions";
import type {
  InboxComposerAudience,
  InboxComposerChannel,
  InboxPreparedMessage,
  InboxSendResult,
} from "../inbox-composer-types";
import {
  beginInboxComposerOperation,
  clearInboxComposerDraft,
  endInboxComposerOperation,
  inboxComposerOperationRunning,
  INBOX_DRAFT_CHANGED_EVENT,
  INBOX_DRAFT_INSERT_EVENT,
  inboxDraftKey,
  readInboxComposerDraft,
  readInboxComposerFiles,
  registerInboxComposerEmployee,
  writeInboxComposerDraft,
  writeInboxComposerFiles,
  type InboxComposerDraft,
  type InboxDraftInsertion,
  type InboxDraftScope,
  type InboxDraftValues,
} from "../inbox-composer-drafts";
import { InboxSpeechToTextButtonClient } from "./InboxSpeechToTextButtonClient";

export type InboxComposerClientProps = {
  employeeId: string;
  threadId: string | null;
  contactId: string | null;
  channel: InboxComposerChannel;
  isPartnerConversation: boolean;
  initialSubject?: string;
  disabled?: boolean;
  historyReturnHref?: string;
  className?: string;
};

export function InboxComposerClient(
  props: InboxComposerClientProps,
): React.ReactElement {
  return (
    <ComposerRecipient
      key={[
        props.employeeId,
        props.threadId ?? props.contactId,
        props.channel,
      ].join(":")}
      {...props}
    />
  );
}

function ComposerRecipient(
  props: InboxComposerClientProps,
): React.ReactElement {
  const [audience, setAudience] = useState<InboxComposerAudience>("");
  return (
    <div className={props.className}>
      {props.isPartnerConversation ? (
        <label className="mb-2 flex items-center gap-2 text-xs font-medium">
          <span>Who can see this message?</span>
          <select
            aria-label="Who can see this message?"
            value={audience}
            onChange={(event) =>
              setAudience(event.target.value as InboxComposerAudience)
            }
            className="min-h-10 rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] px-3"
          >
            <option value="">Choose reply or note</option>
            <option value="partner">Reply to partner</option>
            <option value="internal">Internal note — Stonegate only</option>
          </select>
        </label>
      ) : null}
      <ComposerEditor key={audience} {...props} audience={audience} />
    </div>
  );
}

function ComposerEditor(
  props: InboxComposerClientProps & { audience: InboxComposerAudience },
): React.ReactElement {
  const router = useRouter();
  const scope: InboxDraftScope = {
    employeeId: props.employeeId,
    threadId: props.threadId,
    contactId: props.contactId,
    channel: props.channel,
    audience: props.audience,
  };
  const scopeKey = inboxDraftKey(scope);
  const initial = (): InboxComposerDraft => ({
    body: "",
    subject: props.initialSubject ?? "",
    fileNames: [],
    updatedAt: Date.now(),
  });
  const [draft, setDraft] = useState<InboxComposerDraft>(initial);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [persisted, setPersisted] = useState(true);
  const draftRef = useRef(draft);
  const filesRef = useRef<File[]>([]);
  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function save(next: InboxComposerDraft): void {
    draftRef.current = next;
    const stored = writeInboxComposerDraft(scope, next);
    if (mountedRef.current) {
      setDraft(next);
      setPersisted(stored);
    }
  }
  function saveFiles(next: File[]): void {
    filesRef.current = next;
    writeInboxComposerFiles(scope, next);
    if (mountedRef.current) setAttachments(next);
  }

  useEffect(() => {
    mountedRef.current = true;
    registerInboxComposerEmployee(props.employeeId);
    const restored = readInboxComposerDraft(scope) ?? initial();
    draftRef.current = restored;
    setDraft(restored);
    const restoredFiles = readInboxComposerFiles(scope);
    filesRef.current = restoredFiles;
    setAttachments(restoredFiles);
    setLoaded(true);
    setBusy(inboxComposerOperationRunning(scope));
    const onDraftChange = () => {
      const current = readInboxComposerDraft(scope) ?? initial();
      draftRef.current = current;
      setDraft(current);
      const currentFiles = readInboxComposerFiles(scope);
      filesRef.current = currentFiles;
      setAttachments(currentFiles);
      setBusy(inboxComposerOperationRunning(scope));
    };
    window.addEventListener(INBOX_DRAFT_CHANGED_EVENT, onDraftChange);
    return () => {
      window.removeEventListener(INBOX_DRAFT_CHANGED_EVENT, onDraftChange);
      mountedRef.current = false;
    };
    // The editor remounts for every recipient, channel, and audience.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);

  useEffect(() => {
    const onInsert = (raw: Event) => {
      const event = raw as CustomEvent<InboxDraftInsertion>;
      const input = event.detail;
      if (
        input.employeeId !== scope.employeeId ||
        input.channel !== scope.channel ||
        (input.audience ?? "") !== scope.audience ||
        (input.threadId
          ? input.threadId !== scope.threadId
          : input.contactId !== scope.contactId)
      )
        return;
      event.preventDefault();
      const current = draftRef.current;
      save({
        ...current,
        body: [current.body, input.body.trim()].filter(Boolean).join("\n\n"),
        subject: current.subject || input.subject || "",
        updatedAt: Date.now(),
      });
      setNotice("Draft added to your reply. Review it before sending.");
    };
    window.addEventListener(INBOX_DRAFT_INSERT_EVENT, onInsert);
    return () => window.removeEventListener(INBOX_DRAFT_INSERT_EVENT, onInsert);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);

  useEffect(() => {
    const onConfirmed = (raw: Event) => {
      const { scope: sentScope, result } = (
        raw as CustomEvent<{
          scope: InboxDraftScope;
          result: Extract<InboxSendResult, { ok: true }>;
        }>
      ).detail;
      if (
        sentScope.employeeId !== scope.employeeId ||
        sentScope.channel !== scope.channel ||
        sentScope.audience !== scope.audience ||
        (scope.threadId
          ? result.threadId !== scope.threadId
          : sentScope.contactId !== scope.contactId)
      )
        return;
      setNotice(result.message);
      const href = props.historyReturnHref;
      if (href) {
        const nextUrl = new URL(href, window.location.origin);
        if (
          nextUrl.origin === window.location.origin &&
          (nextUrl.pathname === "/team" || nextUrl.pathname === "/team/inbox")
        ) {
          nextUrl.searchParams.set("threadId", result.threadId);
          if (
            nextUrl.pathname + nextUrl.search !==
            window.location.pathname + window.location.search
          )
            router.replace((nextUrl.pathname + nextUrl.search) as Route, {
              scroll: false,
            });
        }
      }
      router.refresh();
    };
    window.addEventListener("stonegate:inbox-send-confirmed", onConfirmed);
    return () =>
      window.removeEventListener("stonegate:inbox-send-confirmed", onConfirmed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, props.historyReturnHref, router]);

  const updateText = (field: "body" | "subject", value: string) =>
    save({ ...draftRef.current, [field]: value, updatedAt: Date.now() });
  const attachmentForIndex = (index: number): File | undefined => {
    const name = draft.fileNames[index];
    const occurrence = draft.fileNames
      .slice(0, index)
      .filter((item) => item === name).length;
    return attachments.filter((file) => file.name === name)[occurrence];
  };
  const missingFiles =
    draft.fileNames.length > attachments.length && !draft.pending;

  async function send(): Promise<void> {
    if (inFlightRef.current || !loaded || props.disabled) return;
    const before = draftRef.current;
    if (!before.pending && props.isPartnerConversation && !props.audience) {
      setError("Choose Reply to partner or Internal note.");
      return;
    }
    if (!before.pending && !before.body.trim() && !filesRef.current.length) {
      setError("Add a message or attach photos first.");
      return;
    }
    if (!before.pending && missingFiles) {
      setError(
        "Reattach the files listed above, or remove them before sending.",
      );
      return;
    }
    if (!beginInboxComposerOperation(scope)) return;
    inFlightRef.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    let prepared: InboxPreparedMessage | undefined = before.pending?.prepared;
    const submitted: InboxDraftValues = before.pending?.submitted ?? {
      body: before.body,
      subject: before.subject,
      fileNames: [...before.fileNames],
    };
    const submittedFiles = [...filesRef.current];
    try {
      if (!prepared) {
        const data = new FormData();
        data.set("threadId", scope.threadId ?? "");
        data.set("contactId", scope.contactId ?? "");
        data.set("channel", scope.channel);
        data.set("body", submitted.body);
        data.set("subject", submitted.subject);
        data.set("audience", scope.audience);
        data.set("idempotencyKey", `team-inbox:${crypto.randomUUID()}`);
        for (const file of submittedFiles)
          data.append("attachments", file, file.name);
        const result = await prepareInboxMessageAction(data);
        if (!result.ok) {
          if (mountedRef.current) setError(result.error);
          return;
        }
        prepared = result.prepared;
        // Save the exact dispatch request before the first message mutation.
        const current = readInboxComposerDraft(scope) ?? draftRef.current;
        save({
          ...current,
          pending: { prepared, submitted },
          updatedAt: Date.now(),
        });
      }
      const result = await sendPreparedInboxMessageAction(prepared);
      const current = readInboxComposerDraft(scope) ?? draftRef.current;
      if (!result.ok) {
        if (!result.uncertain) {
          const { pending: _pending, ...retained } = current;
          save(retained);
        }
        if (mountedRef.current) setError(result.error);
        return;
      }
      const remainingFiles = readInboxComposerFiles(scope).filter(
        (file) => !submittedFiles.includes(file),
      );
      saveFiles(remainingFiles);
      const remainingBody =
        current.body === submitted.body
          ? ""
          : submitted.body && current.body.startsWith(submitted.body + "\n\n")
            ? current.body.slice(submitted.body.length + 2)
            : current.body;
      const remainingSubject =
        current.subject === submitted.subject
          ? (props.initialSubject ?? "")
          : current.subject;
      const next: InboxComposerDraft = {
        body: remainingBody,
        subject: remainingSubject,
        fileNames: remainingFiles.map((file) => file.name),
        updatedAt: Date.now(),
      };
      save(next);
      if (
        !remainingBody.trim() &&
        !remainingFiles.length &&
        remainingSubject === (props.initialSubject ?? "")
      )
        clearInboxComposerDraft(scope);
      window.dispatchEvent(
        new CustomEvent("stonegate:inbox-send-confirmed", {
          detail: { scope, result },
        }),
      );
    } catch {
      if (mountedRef.current)
        setError(
          prepared
            ? "The send has not been confirmed. Check the previous send; your reply is saved."
            : "Unable to prepare your reply. Nothing was sent; your draft is saved.",
        );
    } finally {
      inFlightRef.current = false;
      endInboxComposerOperation(scope);
      if (mountedRef.current) setBusy(false);
    }
  }

  return (
    <form
      data-inbox-composer
      data-inbox-composer-dirty={Boolean(
        draft.body.trim() ||
          draft.subject !== (props.initialSubject ?? "") ||
          draft.fileNames.length ||
          draft.pending ||
          busy,
      )}
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      {props.channel === "email" ? (
        <label className="flex items-center gap-2 text-xs">
          <span>Subject</span>
          <input
            name="subject"
            value={draft.subject}
            onChange={(event) => updateText("subject", event.target.value)}
            className="min-h-10 flex-1 rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] px-3"
          />
        </label>
      ) : null}
      <label className="sr-only" htmlFor="inbox-thread-body">
        Message
      </label>
      <textarea
        ref={textareaRef}
        id="inbox-thread-body"
        name="body"
        rows={3}
        value={draft.body}
        onInput={(event) => updateText("body", event.currentTarget.value)}
        onChange={(event) => updateText("body", event.target.value)}
        maxLength={props.isPartnerConversation ? 5000 : undefined}
        placeholder={
          props.audience === "internal"
            ? "Write an internal note…"
            : "Write a reply…"
        }
        className="block max-h-48 min-h-20 w-full resize-y rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] px-3 py-2 text-sm text-[color:var(--team-text)]"
      />
      {draft.fileNames.length ? (
        <ul className="flex flex-wrap gap-2 text-xs" aria-label="Attachments">
          {draft.fileNames.map((name, index) => (
            <li
              key={`${name}:${index}`}
              className="flex max-w-full items-center gap-1 rounded-lg border border-[color:var(--team-border)] px-2 py-1"
            >
              <AttachmentPreview file={attachmentForIndex(index)} />
              <span className="truncate">{name}</span>
              <button
                type="button"
                aria-label={`Remove ${name}`}
                disabled={busy || Boolean(draft.pending)}
                onClick={() => {
                  const attached = attachmentForIndex(index);
                  const next = filesRef.current.filter(
                    (file) => file !== attached,
                  );
                  saveFiles(next);
                  save({
                    ...draftRef.current,
                    fileNames: draftRef.current.fileNames.filter(
                      (_, i) => i !== index,
                    ),
                  });
                }}
                className="p-1"
              >
                <X size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {missingFiles ? (
        <p className="text-xs text-amber-800">
          Your reply is saved. Reattach these files after reopening the page, or
          remove them.
        </p>
      ) : null}
      {draft.pending ? (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-amber-50 p-2 text-xs text-amber-900"
        >
          <span>
            A previous send needs confirmation. Your newer edits are kept.
          </span>
          <button
            type="button"
            disabled={busy || props.disabled}
            onClick={() => void send()}
            className="min-h-10 rounded-full border border-amber-300 px-3 font-semibold"
          >
            {busy ? "Checking…" : "Check previous send"}
          </button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-rose-700">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p
          role="status"
          className="text-xs text-[color:var(--team-text-muted)]"
        >
          {notice}
        </p>
      ) : null}
      {!persisted ? (
        <p role="status" className="text-xs text-amber-800">
          Draft saved for this open page. Browser storage is unavailable, so
          keep this page open.
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {props.channel === "sms" || props.channel === "dm" ? (
            <>
              <input
                ref={fileInputRef}
                type="file"
                name="attachments"
                multiple
                accept="image/*,video/*"
                className="sr-only"
                tabIndex={-1}
                onChange={(event) => {
                  const incoming = Array.from(event.target.files ?? []);
                  const missing = [...draftRef.current.fileNames];
                  for (const file of filesRef.current) {
                    const index = missing.indexOf(file.name);
                    if (index >= 0) missing.splice(index, 1);
                  }
                  const names = [...draftRef.current.fileNames];
                  for (const file of incoming) {
                    const index = missing.indexOf(file.name);
                    if (index >= 0) missing.splice(index, 1);
                    else names.push(file.name);
                  }
                  const next = [...filesRef.current, ...incoming];
                  saveFiles(next);
                  save({ ...draftRef.current, fileNames: names });
                  event.target.value = "";
                }}
              />
              <button
                type="button"
                disabled={busy || Boolean(draft.pending)}
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex min-h-10 items-center gap-1 rounded-full px-3 text-xs font-medium"
              >
                <Paperclip size={16} />
                Attach
              </button>
            </>
          ) : null}
          <InboxSpeechToTextButtonClient textareaId="inbox-thread-body" />
        </div>
        <button
          type="submit"
          disabled={props.disabled || busy || !loaded || Boolean(draft.pending)}
          className="min-h-10 rounded-full bg-primary-600 px-5 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy
            ? "Sending…"
            : props.audience === "internal"
              ? "Save note"
              : "Send"}
        </button>
      </div>
    </form>
  );
}

function AttachmentPreview({
  file,
}: {
  file: File | undefined;
}): React.ReactElement | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file?.type.startsWith("image/")) {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return url ? (
    <span
      role="img"
      aria-label={`Preview of ${file?.name}`}
      className="h-10 w-10 shrink-0 rounded bg-cover bg-center"
      style={{ backgroundImage: `url("${url}")` }}
    />
  ) : null;
}
