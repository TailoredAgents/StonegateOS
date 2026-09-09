"use client";

import * as React from "react";
import {
  parseOutboundImportMutationSuccess,
  parseOutboundImportPreviewEnvelope,
  type OutboundImportPreview,
  type OutboundImportPlannedChange,
  type OutboundImportRowStatus,
  type OutboundImportSuccess,
} from "../lib/outbound-import-result";
import { TEAM_INPUT, teamButtonClass } from "./team-ui";

type TeamMember = { id: string; name: string };
const REVIEW_PAGE_SIZE = 50;
const MAX_CSV_BYTES = 2 * 1024 * 1024;
const CSV_TEMPLATE =
  "company,contact_name,title,email,phone,website,city,state,zip,notes\r\n";
type ReviewFilter = "all" | "accepted" | "excluded" | "unchanged";

function newImportKey(): string {
  return `outbound-import.${crypto.randomUUID()}`;
}

async function submitImportRequest(
  body: FormData,
  idempotencyKey?: string,
): Promise<{ response: Response; payload: unknown }> {
  const controller = new AbortController();
  // The proxy allows one minute for preview and five minutes for execution.
  // Bound the browser wait too; timing out an execution never means it failed.
  const timeout = window.setTimeout(
    () => controller.abort(),
    idempotencyKey ? 315_000 : 75_000,
  );
  try {
    const response = await fetch("/api/team/outbound/import", {
      method: "POST",
      ...(idempotencyKey
        ? { headers: { "Idempotency-Key": idempotencyKey } }
        : {}),
      body,
      signal: controller.signal,
    });
    const payload = (await response.json().catch(() => null)) as unknown;
    return { response, payload };
  } finally {
    window.clearTimeout(timeout);
  }
}

function statusClasses(status: OutboundImportRowStatus): string {
  if (status === "create") return "bg-emerald-100 text-emerald-800";
  if (status === "update") return "bg-primary-100 text-primary-800";
  if (status === "unchanged") return "bg-slate-100 text-slate-700";
  if (status === "duplicate") return "bg-amber-100 text-amber-800";
  return "bg-rose-100 text-rose-800";
}

function errorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object") {
    const message = (payload as Record<string, unknown>)["message"];
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return fallback;
}

const PLANNED_CHANGE_LABELS: Readonly<
  Record<OutboundImportPlannedChange, string>
> = {
  "contact.create": "Create contact",
  "contact.email": "Add email",
  "contact.phone": "Add phone",
  "contact.company": "Add company",
  "contact.first_name": "Complete first name",
  "contact.last_name": "Complete last name",
  "contact.source": "Set source",
  "contact.assignee": "Assign owner",
  "contact.partner_status": "Set partner prospect",
  "contact.partner_owner": "Assign partner owner",
  "contact_note.create": "Create contact note",
  "partner.resolve_and_link": "Resolve and link partner",
  "pipeline.create": "Add pipeline row",
  "task.create": "Create outbound task",
};

export function OutboundImportClient(props: {
  members: TeamMember[];
  defaultMemberId: string;
  directoryUnavailable: boolean;
}): React.ReactElement {
  const [campaign, setCampaign] = React.useState("property_management");
  const [assigneeId, setAssigneeId] = React.useState(props.defaultMemberId);
  const [csv, setCsv] = React.useState("");
  const [file, setFile] = React.useState<File | null>(null);
  const [fileInputKey, setFileInputKey] = React.useState(0);
  const [preview, setPreview] = React.useState<OutboundImportPreview | null>(
    null,
  );
  const [success, setSuccess] = React.useState<OutboundImportSuccess | null>(
    null,
  );
  const [confirmation, setConfirmation] = React.useState("");
  const [reviewPage, setReviewPage] = React.useState(0);
  const [idempotencyKey, setIdempotencyKey] = React.useState("");
  const [busy, setBusy] = React.useState<"preview" | "execute" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>(
    {},
  );
  const [reviewFilter, setReviewFilter] = React.useState<ReviewFilter>("all");
  const [resultUncertain, setResultUncertain] = React.useState(false);
  const inFlightRef = React.useRef(false);
  const errorRef = React.useRef<HTMLDivElement>(null);
  const reviewHeadingRef = React.useRef<HTMLHeadingElement>(null);
  const inputLocked = Boolean(busy) || resultUncertain || Boolean(success);

  React.useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  React.useEffect(() => {
    if (!preview) return;
    reviewHeadingRef.current?.focus();
  }, [preview]);

  React.useEffect(() => {
    if (success || (!csv.trim() && !file && !resultUncertain)) return;
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, [csv, file, resultUncertain, success]);

  const showRequestError = (payload: unknown, fallback: string): void => {
    setError(errorMessage(payload, fallback));
    const candidate =
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>)["fieldErrors"]
        : null;
    setFieldErrors(
      candidate && typeof candidate === "object" && !Array.isArray(candidate)
        ? Object.fromEntries(
            Object.entries(candidate).filter(
              (entry): entry is [string, string] =>
                typeof entry[1] === "string",
            ),
          )
        : {},
    );
  };

  const invalidatePreview = React.useCallback(() => {
    setPreview(null);
    setSuccess(null);
    setConfirmation("");
    setReviewPage(0);
    setIdempotencyKey("");
    setError(null);
    setFieldErrors({});
    setReviewFilter("all");
  }, []);

  const buildForm = React.useCallback(
    (mode: "preview" | "execute"): FormData => {
      const form = new FormData();
      form.set("mode", mode);
      form.set("campaign", campaign);
      form.set("assignedToMemberId", assigneeId);
      if (csv.trim()) form.set("csv", csv);
      else if (file) form.set("file", file, file.name);
      if (mode === "execute" && preview) {
        form.set("previewHash", preview.previewHash);
        form.set("confirmation", confirmation);
      }
      return form;
    },
    [assigneeId, campaign, confirmation, csv, file, preview],
  );

  const requestPreview = async (
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    if (inputLocked || inFlightRef.current) return;
    const byteLength = csv.trim()
      ? new TextEncoder().encode(csv.trim()).byteLength
      : (file?.size ?? 0);
    if (!byteLength || byteLength > MAX_CSV_BYTES) {
      const message = !byteLength
        ? "Choose a CSV file or paste your contacts first."
        : "This CSV is too large. Split it into files smaller than 2 MiB and preview each one.";
      setFieldErrors({ csv: message });
      setError(message);
      return;
    }
    inFlightRef.current = true;
    setBusy("preview");
    invalidatePreview();
    setError(null);
    setSuccess(null);
    try {
      const { response, payload } = await submitImportRequest(
        buildForm("preview"),
      );
      if (!response.ok) {
        showRequestError(payload, "The import could not be previewed.");
        return;
      }
      const parsed = parseOutboundImportPreviewEnvelope(payload);
      if (!parsed) {
        setError(
          "The service returned an incomplete preview. No import was requested.",
        );
        return;
      }
      setPreview(parsed);
      setConfirmation("");
      setReviewPage(0);
      setIdempotencyKey(newImportKey());
    } catch {
      setError(
        "The preview service could not be reached. Your CSV is still here; retry when ready.",
      );
    } finally {
      inFlightRef.current = false;
      setBusy(null);
    }
  };

  const executeImport = async (): Promise<void> => {
    if (
      busy ||
      inFlightRef.current ||
      !preview ||
      confirmation !== preview.confirmationPhrase ||
      !idempotencyKey
    ) {
      return;
    }
    inFlightRef.current = true;
    setBusy("execute");
    setError(null);
    setFieldErrors({});
    try {
      const { response, payload } = await submitImportRequest(
        buildForm("execute"),
        idempotencyKey,
      );
      if (!response.ok) {
        showRequestError(
          payload,
          response.status === 409
            ? "CRM data changed after review. Your CSV is preserved; preview it again before importing."
            : "The import was not confirmed. Your preview and request key are preserved for a safe retry.",
        );
        setResultUncertain((wasUncertain) =>
          response.status === 409
            ? false
            : wasUncertain || response.status >= 500 || response.status === 408,
        );
        if (response.status === 409) {
          setPreview(null);
          setConfirmation("");
          setReviewPage(0);
          setIdempotencyKey("");
        }
        return;
      }
      const parsed = parseOutboundImportMutationSuccess(
        payload,
        preview.previewHash,
      );
      if (!parsed) {
        setResultUncertain(true);
        setError(
          "The service returned an unreadable receipt. No success is being claimed; check Outbound and Audit before retrying.",
        );
        return;
      }
      setSuccess(parsed);
      setResultUncertain(false);
    } catch {
      setResultUncertain(true);
      setError(
        "The import result could not be confirmed. Keep this page open and check Outbound before retrying with the preserved request key.",
      );
    } finally {
      inFlightRef.current = false;
      setBusy(null);
    }
  };

  const downloadReport = (report: { filename: string; csv: string }): void => {
    const url = URL.createObjectURL(
      new Blob([report.csv], { type: "text/csv;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = report.filename;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const filteredRows = (preview?.rows ?? []).filter((row) => {
    if (reviewFilter === "accepted")
      return row.status === "create" || row.status === "update";
    if (reviewFilter === "excluded")
      return ["invalid", "duplicate", "conflict"].includes(row.status);
    if (reviewFilter === "unchanged") return row.status === "unchanged";
    return true;
  });
  const reviewPageCount = Math.max(
    1,
    Math.ceil(filteredRows.length / REVIEW_PAGE_SIZE),
  );
  const safeReviewPage = Math.min(reviewPage, reviewPageCount - 1);
  const reviewStart = safeReviewPage * REVIEW_PAGE_SIZE;
  const visibleRows = filteredRows.slice(
    reviewStart,
    reviewStart + REVIEW_PAGE_SIZE,
  );
  const report = success?.data.exclusionReport ?? preview?.exclusionReport;

  return (
    <div className="space-y-5">
      <ol
        className="flex flex-wrap gap-x-6 gap-y-2 border-b border-[color:var(--team-border)] pb-4"
        aria-label="Import progress"
      >
        {[
          ["1", "Add contacts"],
          ["2", "Review changes"],
          ["3", "Import"],
        ].map(([number, label]) => (
          <li
            key={String(number)}
            aria-current={
              number === (success ? "3" : preview ? "2" : "1")
                ? "step"
                : undefined
            }
            className={`flex min-h-[44px] items-center gap-2 text-sm ${
              number === (success ? "3" : preview ? "2" : "1")
                ? "font-semibold text-[color:var(--team-text)]"
                : "text-[color:var(--team-text-muted)]"
            }`}
          >
            <span className="flex size-7 items-center justify-center rounded-full bg-[color:var(--team-surface-muted)] font-semibold">
              {number}
            </span>
            <span>{label}</span>
          </li>
        ))}
      </ol>

      <form
        method="post"
        onSubmit={(event) => void requestPreview(event)}
        className="grid gap-4"
        aria-busy={busy === "preview"}
      >
        <noscript>
          <p className="text-sm">
            Enable JavaScript to preview and review contacts before importing.
            Nothing is imported automatically.
          </p>
        </noscript>
        <div className="grid gap-3 rounded-2xl border border-dashed border-[color:var(--team-border)] bg-[color:var(--team-surface-muted)] p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <label
              htmlFor="outbound-import-file"
              className="font-semibold text-[color:var(--team-text)]"
            >
              Choose a CSV file
            </label>
            <button
              type="button"
              onClick={() =>
                downloadReport({
                  filename: "outbound-contacts-template.csv",
                  csv: CSV_TEMPLATE,
                })
              }
              className={`${teamButtonClass("secondary", "sm")} min-h-[44px]`}
            >
              Download CSV template
            </button>
          </div>
          <input
            id="outbound-import-file"
            key={fileInputKey}
            type="file"
            disabled={inputLocked}
            accept=".csv,text/csv,text/plain"
            aria-invalid={Boolean(fieldErrors["csv"])}
            aria-describedby={`outbound-import-file-help${fieldErrors["csv"] ? " outbound-import-csv-error" : ""}`}
            onChange={(event) => {
              const selected = event.target.files?.[0] ?? null;
              setFile(selected);
              if (selected) setCsv("");
              invalidatePreview();
            }}
            className={`${TEAM_INPUT} w-full min-w-0 min-h-[44px] !text-base file:mr-3 file:min-h-[44px] file:rounded-lg file:border-0 file:px-3 file:font-medium`}
          />
          <p
            id="outbound-import-file-help"
            className="text-sm text-[color:var(--team-text-muted)]"
          >
            Up to 2,000 contacts and 2 MiB, saved as UTF-8 CSV. Each contact
            needs an email or phone number. Importing creates CRM work; it does
            not send outreach.
          </p>
        </div>
        <details className="border-b border-[color:var(--team-border)] pb-3">
          <summary className="min-h-[44px] cursor-pointer content-center text-sm font-medium text-[color:var(--team-text)]">
            Or paste CSV text
          </summary>
          <label className="mt-2 flex flex-col gap-2 text-sm text-[color:var(--team-text-muted)]">
            <span>Paste CSV with a header row</span>
            <textarea
              value={csv}
              disabled={inputLocked}
              aria-invalid={Boolean(fieldErrors["csv"])}
              aria-describedby={
                fieldErrors["csv"] ? "outbound-import-csv-error" : undefined
              }
              onChange={(event) => {
                setCsv(event.target.value);
                if (event.target.value.trim()) {
                  setFile(null);
                  setFileInputKey((value) => value + 1);
                }
                invalidatePreview();
              }}
              className={`${TEAM_INPUT} min-h-[140px] !text-base font-mono`}
              placeholder={
                "company,contact_name,email,phone\nExample Company,Alex Morgan,alex@example.com,"
              }
              spellCheck={false}
            />
          </label>
        </details>
        {fieldErrors["csv"] ? (
          <p id="outbound-import-csv-error" className="text-sm text-rose-700">
            {fieldErrors["csv"]}
          </p>
        ) : null}
        <div className="grid gap-4 md:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm text-[color:var(--team-text-muted)]">
            <span className="font-medium text-[color:var(--team-text)]">
              Campaign name
            </span>
            <input
              value={campaign}
              disabled={inputLocked}
              aria-invalid={Boolean(fieldErrors["campaign"])}
              aria-describedby={
                fieldErrors["campaign"]
                  ? "outbound-import-campaign-error"
                  : undefined
              }
              onChange={(event) => {
                setCampaign(event.target.value);
                invalidatePreview();
              }}
              className={`${TEAM_INPUT} min-h-[44px] !text-base`}
              autoComplete="off"
            />
            {fieldErrors["campaign"] ? (
              <span
                id="outbound-import-campaign-error"
                className="text-rose-700"
              >
                {fieldErrors["campaign"]}
              </span>
            ) : null}
          </label>
          <label className="flex flex-col gap-1 text-sm text-[color:var(--team-text-muted)]">
            <span className="font-medium text-[color:var(--team-text)]">
              Who will follow up?
            </span>
            <select
              value={assigneeId}
              disabled={inputLocked}
              aria-invalid={Boolean(fieldErrors["assignedToMemberId"])}
              aria-describedby={
                fieldErrors["assignedToMemberId"]
                  ? "outbound-import-assignee-error"
                  : undefined
              }
              onChange={(event) => {
                setAssigneeId(event.target.value);
                invalidatePreview();
              }}
              className={`${TEAM_INPUT} min-h-[44px] !text-base`}
            >
              <option value="">Configured default assignee</option>
              {props.members.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                </option>
              ))}
            </select>
            {fieldErrors["assignedToMemberId"] ? (
              <span
                id="outbound-import-assignee-error"
                className="text-rose-700"
              >
                {fieldErrors["assignedToMemberId"]}
              </span>
            ) : null}
            {props.directoryUnavailable ? (
              <span className="text-xs text-amber-700">
                The team list is temporarily unavailable. Preview will check
                that the default owner is available before continuing.
              </span>
            ) : null}
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={inputLocked || (!csv.trim() && !file)}
            className={`${teamButtonClass("primary")} min-h-[44px] disabled:cursor-not-allowed disabled:opacity-50`}
          >
            {busy === "preview" ? "Building preview…" : "Preview import"}
          </button>
          <span className="text-xs text-[color:var(--team-text-soft)]">
            Nothing changes until you review and confirm.
          </span>
        </div>
      </form>

      <div aria-live="polite" aria-atomic="true">
        {error ? (
          <div
            role="alert"
            ref={errorRef}
            tabIndex={-1}
            className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900"
          >
            <p className="font-semibold">
              {resultUncertain
                ? "Check the import result"
                : preview
                  ? "Import not confirmed"
                  : "Check your import"}
            </p>
            <p className="mt-1">{error}</p>
          </div>
        ) : null}
        {success ? (
          <div
            role="status"
            className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900"
          >
            <p className="font-semibold">Contacts imported</p>
            <p className="mt-1">
              {success.data.counts.contactsCreated} contacts created,{" "}
              {success.data.counts.contactsModified} existing contacts updated,
              and {success.data.counts.tasksCreated} follow-up tasks assigned to{" "}
              {success.data.assignee.name}. No outreach was sent by this import.
            </p>
            <details className="mt-2">
              <summary className="min-h-[44px] cursor-pointer content-center font-medium">
                Import receipt and details
              </summary>
              <p>
                {success.data.counts.partnerAccountsResolved} partner accounts
                matched, {success.data.counts.partnerLinksCreated} partner links
                created, {success.data.counts.contactNotesCreated} notes
                created, and {success.data.counts.pipelineRowsCreated} pipeline
                entries created. {success.data.counts.rowsUpdated} accepted
                update rows may include follow-up changes only.
              </p>
              <p className="mt-2 break-all text-xs">
                Audit receipt {success.receipt.auditEventId}
              </p>
            </details>
            <button
              type="button"
              onClick={() => {
                setCsv("");
                setFile(null);
                setFileInputKey((value) => value + 1);
                setResultUncertain(false);
                invalidatePreview();
                window.requestAnimationFrame(() =>
                  document.getElementById("outbound-import-file")?.focus(),
                );
              }}
              className={`${teamButtonClass("secondary")} mt-3`}
            >
              Start another import
            </button>
          </div>
        ) : null}
      </div>

      {preview ? (
        <section
          aria-labelledby="outbound-import-review-title"
          className="space-y-4 rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] p-4"
        >
          <div>
            <h3
              id="outbound-import-review-title"
              ref={reviewHeadingRef}
              tabIndex={-1}
              className="text-base font-semibold text-[color:var(--team-text)]"
            >
              {success ? "Imported contacts" : "Review before importing"}
            </h3>
            <p className="mt-1 text-sm text-[color:var(--team-text-muted)]">
              Follow-up owner: <strong>{preview.assignee.name}</strong>. Only
              Create and Update rows change the CRM. Rows with errors,
              duplicates, or conflicting details are skipped.
            </p>
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-y border-[color:var(--team-border)] py-4 sm:grid-cols-3 lg:grid-cols-6">
            {[
              ["Accepted", preview.counts.accepted],
              ["Create", preview.counts.create],
              ["Update", preview.counts.update],
              ["Unchanged", preview.counts.unchanged],
              ["Invalid", preview.counts.invalid],
              [
                "Duplicate / conflict",
                preview.counts.duplicate + preview.counts.conflict,
              ],
            ].map(([label, value]) => (
              <div key={String(label)} className="min-w-0">
                <dt className="text-xs text-[color:var(--team-text-soft)]">
                  {label}
                </dt>
                <dd className="mt-1 text-lg font-semibold text-[color:var(--team-text)]">
                  {value}
                </dd>
              </div>
            ))}
          </dl>

          {preview.ignoredHeaders.length > 0 ? (
            <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              Ignored unsupported headers: {preview.ignoredHeaders.join(", ")}
            </p>
          ) : null}

          <label className="flex flex-wrap items-center gap-3 text-sm font-medium text-[color:var(--team-text)]">
            Show contacts
            <select
              value={reviewFilter}
              onChange={(event) => {
                setReviewFilter(event.target.value as ReviewFilter);
                setReviewPage(0);
              }}
              className={`${TEAM_INPUT} !text-base`}
            >
              <option value="all">All ({preview.counts.total})</option>
              <option value="accepted">
                Ready to import ({preview.counts.accepted})
              </option>
              <option value="excluded">
                Needs attention (
                {preview.counts.invalid +
                  preview.counts.duplicate +
                  preview.counts.conflict}
                )
              </option>
              <option value="unchanged">
                No changes ({preview.counts.unchanged})
              </option>
            </select>
          </label>

          {filteredRows.length === 0 ? (
            <p
              role="status"
              className="py-4 text-sm text-[color:var(--team-text-muted)]"
            >
              No contacts in this group. Choose another view to continue
              reviewing.
            </p>
          ) : null}

          <div className="grid gap-2 md:hidden">
            {visibleRows.map((row) => (
              <article
                key={row.rowNumber}
                className="rounded-xl border border-[color:var(--team-border)] p-3 text-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="min-w-0 break-words font-semibold text-[color:var(--team-text)]">
                    Row {row.rowNumber}:{" "}
                    {row.contactName ?? row.company ?? "Contact"}
                  </h4>
                  <span
                    className={`rounded-full px-2 py-1 text-xs font-semibold ${statusClasses(row.status)}`}
                  >
                    {row.status}
                  </span>
                </div>
                <p className="mt-2 break-words text-xs text-[color:var(--team-text-muted)]">
                  {row.email ?? row.phone ?? "No usable identity"}
                </p>
                <p className="mt-2 text-xs text-[color:var(--team-text-muted)]">
                  {row.plannedChanges.length > 0
                    ? row.plannedChanges
                        .map((change) => PLANNED_CHANGE_LABELS[change])
                        .join(", ")
                    : (row.reason ?? "No changes")}
                </p>
              </article>
            ))}
          </div>

          <div className="hidden overflow-x-auto rounded-xl border border-[color:var(--team-border)] md:block">
            <table className="min-w-full text-left text-xs">
              <caption className="sr-only">Outbound import row review</caption>
              <thead className="bg-[color:var(--team-surface-muted)] text-[color:var(--team-text-muted)]">
                <tr>
                  <th scope="col" className="px-3 py-2">
                    Row
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Result
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Contact
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Identity
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Planned changes or reason
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => (
                  <tr
                    key={row.rowNumber}
                    className="border-t border-[color:var(--team-border)]"
                  >
                    <td className="px-3 py-2">{row.rowNumber}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`rounded-full px-2 py-1 font-semibold ${statusClasses(row.status)}`}
                      >
                        {row.status}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      {row.contactName ?? row.company ?? "—"}
                    </td>
                    <td className="px-3 py-2">
                      {row.email ?? row.phone ?? "—"}
                    </td>
                    <td className="max-w-sm px-3 py-2">
                      {row.plannedChanges.length > 0
                        ? row.plannedChanges
                            .map((change) => PLANNED_CHANGE_LABELS[change])
                            .join(", ")
                        : (row.reason ?? "—")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-[color:var(--team-text-soft)]">
            <p>
              Showing {filteredRows.length === 0 ? 0 : reviewStart + 1}–
              {Math.min(reviewStart + visibleRows.length, filteredRows.length)}{" "}
              of {filteredRows.length}{" "}
              {reviewFilter === "all" ? "reviewed" : "matching"} rows.
            </p>
            {reviewPageCount > 1 ? (
              <div
                className="flex items-center gap-2"
                aria-label="Review pages"
              >
                <button
                  type="button"
                  onClick={() => setReviewPage(Math.max(safeReviewPage - 1, 0))}
                  disabled={safeReviewPage === 0}
                  className={`${teamButtonClass("secondary", "sm")} min-h-[44px] disabled:cursor-not-allowed disabled:opacity-50`}
                >
                  Previous rows
                </button>
                <span aria-live="polite">
                  Page {safeReviewPage + 1} of {reviewPageCount}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setReviewPage(
                      Math.min(safeReviewPage + 1, reviewPageCount - 1),
                    )
                  }
                  disabled={safeReviewPage >= reviewPageCount - 1}
                  className={`${teamButtonClass("secondary", "sm")} min-h-[44px] disabled:cursor-not-allowed disabled:opacity-50`}
                >
                  Next rows
                </button>
              </div>
            ) : null}
          </div>

          {report && report.rowCount > 0 ? (
            <button
              type="button"
              onClick={() => downloadReport(report)}
              className={`${teamButtonClass("secondary")} min-h-[44px]`}
            >
              Download {report.rowCount} skipped rows with reasons
            </button>
          ) : null}

          {preview.counts.accepted === 0 ? (
            <p className="rounded-xl bg-[color:var(--team-surface-muted)] p-4 text-sm text-[color:var(--team-text)]">
              Nothing to import yet. Check the skipped rows or add a different
              CSV, then preview again.
            </p>
          ) : !success ? (
            <form
              method="post"
              onSubmit={(event) => {
                event.preventDefault();
                void executeImport();
              }}
              className="grid gap-3 rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface-muted)] p-4"
              aria-busy={busy === "execute"}
            >
              {resultUncertain ? (
                <p className="text-sm text-[color:var(--team-text)]">
                  Your import may already have completed. The original file and
                  request are locked so retrying checks the same import safely.
                  Do not start a second import to resolve this one.
                </p>
              ) : null}
              <label className="flex flex-col gap-1 text-sm text-[color:var(--team-text)]">
                <span>
                  Type <strong>{preview.confirmationPhrase}</strong> to import
                  the {preview.counts.accepted} ready rows.
                </span>
                <input
                  value={confirmation}
                  disabled={Boolean(busy) || Boolean(success)}
                  onChange={(event) => setConfirmation(event.target.value)}
                  className={`${TEAM_INPUT} min-h-[44px] !text-base`}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <div>
                <button
                  type="submit"
                  disabled={
                    Boolean(busy) ||
                    Boolean(success) ||
                    preview.counts.accepted === 0 ||
                    confirmation !== preview.confirmationPhrase
                  }
                  className={`${teamButtonClass("primary")} min-h-[44px] disabled:cursor-not-allowed disabled:opacity-50`}
                >
                  {busy === "execute"
                    ? "Importing accepted rows…"
                    : resultUncertain
                      ? "Retry this same import safely"
                      : `Import ${preview.counts.accepted} accepted rows`}
                </button>
              </div>
            </form>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
