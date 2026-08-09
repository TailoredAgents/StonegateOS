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

function newImportKey(): string {
  return `outbound-import.${crypto.randomUUID()}`;
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
  const inFlightRef = React.useRef(false);

  const invalidatePreview = React.useCallback(() => {
    setPreview(null);
    setSuccess(null);
    setConfirmation("");
    setReviewPage(0);
    setIdempotencyKey("");
    setError(null);
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
    if (busy || inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy("preview");
    setError(null);
    setSuccess(null);
    try {
      const response = await fetch("/api/team/outbound/import", {
        method: "POST",
        body: buildForm("preview"),
      });
      const payload = (await response.json().catch(() => null)) as unknown;
      if (!response.ok) {
        setError(errorMessage(payload, "The import could not be previewed."));
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
    try {
      const response = await fetch("/api/team/outbound/import", {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: buildForm("execute"),
      });
      const payload = (await response.json().catch(() => null)) as unknown;
      if (!response.ok) {
        setError(
          errorMessage(
            payload,
            response.status === 409
              ? "CRM data changed after review. Your CSV is preserved; preview it again before importing."
              : "The import was not confirmed. Your preview and request key are preserved for a safe retry.",
          ),
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
        setError(
          "The service returned an unreadable receipt. No success is being claimed; check Outbound and Audit before retrying.",
        );
        return;
      }
      setSuccess(parsed);
    } catch {
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

  const reviewPageCount = preview
    ? Math.max(1, Math.ceil(preview.rows.length / REVIEW_PAGE_SIZE))
    : 1;
  const safeReviewPage = Math.min(reviewPage, reviewPageCount - 1);
  const reviewStart = safeReviewPage * REVIEW_PAGE_SIZE;
  const visibleRows =
    preview?.rows.slice(reviewStart, reviewStart + REVIEW_PAGE_SIZE) ?? [];
  const report = success?.data.exclusionReport ?? preview?.exclusionReport;

  return (
    <div className="space-y-5">
      <ol className="grid gap-2 sm:grid-cols-3" aria-label="Import progress">
        {[
          ["1", "Preview", Boolean(preview)],
          ["2", "Review", Boolean(preview)],
          ["3", "Import", Boolean(success)],
        ].map(([number, label, complete]) => (
          <li
            key={String(number)}
            className={`flex min-h-[44px] items-center gap-3 rounded-xl border px-3 py-2 text-sm ${
              complete
                ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                : "border-[color:var(--team-border)] bg-[color:var(--team-surface)] text-[color:var(--team-text-muted)]"
            }`}
          >
            <span className="font-semibold">{number}</span>
            <span>{label}</span>
          </li>
        ))}
      </ol>

      <form
        onSubmit={(event) => void requestPreview(event)}
        className="grid gap-4"
      >
        <div className="grid gap-4 md:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm text-[color:var(--team-text-muted)]">
            <span className="font-medium text-[color:var(--team-text)]">
              Campaign
            </span>
            <input
              value={campaign}
              disabled={Boolean(busy)}
              onChange={(event) => {
                setCampaign(event.target.value);
                invalidatePreview();
              }}
              className={`${TEAM_INPUT} min-h-[44px]`}
              autoComplete="off"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-[color:var(--team-text-muted)]">
            <span className="font-medium text-[color:var(--team-text)]">
              Assign accepted rows to
            </span>
            <select
              value={assigneeId}
              disabled={Boolean(busy)}
              onChange={(event) => {
                setAssigneeId(event.target.value);
                invalidatePreview();
              }}
              className={`${TEAM_INPUT} min-h-[44px]`}
            >
              <option value="">Configured default assignee</option>
              {props.members.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                </option>
              ))}
            </select>
            {props.directoryUnavailable ? (
              <span className="text-xs text-amber-700">
                The directory is unavailable. The API will still verify the
                configured default or selected ID before previewing.
              </span>
            ) : null}
          </label>
        </div>

        <label className="flex flex-col gap-1 text-sm text-[color:var(--team-text-muted)]">
          <span className="font-medium text-[color:var(--team-text)]">
            Paste CSV
          </span>
          <textarea
            value={csv}
            disabled={Boolean(busy)}
            onChange={(event) => {
              setCsv(event.target.value);
              if (event.target.value.trim()) {
                setFile(null);
                setFileInputKey((value) => value + 1);
              }
              invalidatePreview();
            }}
            className={`${TEAM_INPUT} min-h-[180px] font-mono text-xs`}
            placeholder={
              "company,contact_name,title,email,phone,website,city,state,zip,notes\nAcme Property Mgmt,Jane Doe,Regional PM,jane@acme.com,555-555-5555,acmepm.com,Atlanta,GA,30303,prefers email"
            }
            spellCheck={false}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-[color:var(--team-text-muted)]">
          <span className="font-medium text-[color:var(--team-text)]">
            Or upload a UTF-8 CSV
          </span>
          <input
            key={fileInputKey}
            type="file"
            disabled={Boolean(busy)}
            accept=".csv,text/csv,text/plain"
            onChange={(event) => {
              const selected = event.target.files?.[0] ?? null;
              setFile(selected);
              if (selected) setCsv("");
              invalidatePreview();
            }}
            className="min-h-[44px] rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] px-3 py-2 text-sm"
          />
          <span className="text-xs">
            Maximum 2,000 data rows and 2 MiB. Email or phone is required per
            accepted row.
          </span>
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={Boolean(busy) || (!csv.trim() && !file)}
            className={`${teamButtonClass("primary")} min-h-[44px] disabled:cursor-not-allowed disabled:opacity-50`}
          >
            {busy === "preview" ? "Building preview…" : "Preview import"}
          </button>
          <span className="text-xs text-[color:var(--team-text-soft)]">
            Preview performs no writes.
          </span>
        </div>
      </form>

      <div aria-live="polite" aria-atomic="true">
        {error ? (
          <div
            role="alert"
            className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900"
          >
            <p className="font-semibold">Import not confirmed</p>
            <p className="mt-1">{error}</p>
          </div>
        ) : null}
        {success ? (
          <div
            role="status"
            className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900"
          >
            <p className="font-semibold">Import committed</p>
            <p className="mt-1">
              {success.data.counts.contactsCreated} contacts created,{" "}
              {success.data.counts.contactsModified} existing contacts modified,{" "}
              {success.data.counts.partnerAccountsResolved} partner accounts
              resolved, {success.data.counts.partnerLinksCreated} partner links
              created, {success.data.counts.contactNotesCreated} contact notes
              created, {success.data.counts.pipelineRowsCreated} pipeline rows
              created, and {success.data.counts.tasksCreated} outbound tasks
              created for {success.data.assignee.name}. The{" "}
              {success.data.counts.rowsUpdated} accepted update rows may include
              workflow-only changes.
            </p>
            <p className="mt-1 text-xs">
              Audit receipt {success.receipt.auditEventId}
            </p>
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
              className="text-base font-semibold text-[color:var(--team-text)]"
            >
              Review exact import
            </h3>
            <p className="mt-1 text-sm text-[color:var(--team-text-muted)]">
              Assignment: <strong>{preview.assignee.name}</strong>. Only Create
              and Update rows will change CRM data. Invalid, duplicate, and
              conflict rows are excluded.
            </p>
          </div>
          <dl className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
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
              <div
                key={String(label)}
                className="rounded-xl border border-[color:var(--team-border)] p-3"
              >
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

          <div className="grid gap-2 md:hidden">
            {visibleRows.map((row) => (
              <article
                key={row.rowNumber}
                className="rounded-xl border border-[color:var(--team-border)] p-3 text-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="font-semibold text-[color:var(--team-text)]">
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
              Showing {preview.rows.length === 0 ? 0 : reviewStart + 1}–
              {Math.min(reviewStart + visibleRows.length, preview.rows.length)}{" "}
              of {preview.rows.length} reviewed rows. The exclusion download
              contains every excluded row and is not truncated.
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
              Download all {report.rowCount} excluded rows
            </button>
          ) : null}

          <div className="grid gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
            <label className="flex flex-col gap-1 text-sm text-amber-950">
              <span>
                Type <strong>{preview.confirmationPhrase}</strong> to import the
                accepted subset.
              </span>
              <input
                value={confirmation}
                disabled={Boolean(busy) || Boolean(success)}
                onChange={(event) => setConfirmation(event.target.value)}
                className={`${TEAM_INPUT} min-h-[44px] bg-white`}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <div>
              <button
                type="button"
                onClick={() => void executeImport()}
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
                  : success
                    ? "Import committed"
                    : `Import ${preview.counts.accepted} accepted rows`}
              </button>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}
