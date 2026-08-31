"use client";

import * as React from "react";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import {
  CalendarRange,
  Download,
  FileSpreadsheet,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import { cn } from "@myst-os/ui";
import { createPortalOperationKey, partnerPortalFetch } from "../lib/portal-v2";
import {
  PartnerNotice,
  PartnerPanel,
  partnerFieldClass,
  partnerPrimaryButtonClass,
  partnerSecondaryButtonClass,
} from "./PartnerPortalUi";

type ServiceTemplate = {
  id: string;
  name: string;
  serviceKey: string;
  locationId: string | null;
  updatedAt: string;
};

type RecurringOccurrence = {
  id: string;
  localDate: string;
  state: string;
  draftId: string | null;
  jobId: string | null;
  reason: string | null;
};

type RecurringSeries = {
  id: string;
  name: string;
  state: string;
  occurrences: RecurringOccurrence[];
};

type BulkResult = {
  id: string;
  state: string;
  dryRun: boolean;
  rowCount: number;
  validCount: number;
  errorCount: number;
  correctionCsv: string;
  capacityReserved: false;
  rows: Array<{
    rowNumber: number;
    state: string;
    draftId: string | null;
    errors: Array<{ field?: string; message?: string }>;
  }>;
};

function humanize(value: string): string {
  return value
    .replace(/_/gu, " ")
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function downloadText(filename: string, value: string): void {
  const url = URL.createObjectURL(
    new Blob([value], { type: "text/csv;charset=utf-8" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function PartnerRepeatWorkManager() {
  const router = useRouter();
  const [templates, setTemplates] = React.useState<ServiceTemplate[]>([]);
  const [series, setSeries] = React.useState<RecurringSeries[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<{
    tone: "success" | "error" | "warning" | "info";
    text: string;
  } | null>(null);
  const [csvFile, setCsvFile] = React.useState<File | null>(null);
  const [csvText, setCsvText] = React.useState<string | null>(null);
  const [bulkResult, setBulkResult] = React.useState<BulkResult | null>(null);

  const load = React.useCallback(async (): Promise<void> => {
    setLoading(true);
    const [templateResult, seriesResult] = await Promise.all([
      partnerPortalFetch<{ ok: true; templates: ServiceTemplate[] }>(
        "service-templates",
      ).catch(() => null),
      partnerPortalFetch<{ ok: true; series: RecurringSeries[] }>(
        "recurring-series",
      ).catch(() => null),
    ]);
    setLoading(false);
    if (templateResult?.ok) setTemplates(templateResult.data.templates);
    if (seriesResult?.ok) setSeries(seriesResult.data.series);
    if (!templateResult?.ok || !seriesResult?.ok) {
      setMessage({
        tone: "warning",
        text: "Some repeat-work tools could not be loaded. Your bookings are unchanged.",
      });
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const useTemplate = async (templateId: string): Promise<void> => {
    setBusy(`template:${templateId}`);
    setMessage(null);
    const result = await partnerPortalFetch<{
      ok: true;
      draft: { id: string };
    }>(`service-templates/${encodeURIComponent(templateId)}/apply`, {
      method: "POST",
      headers: {
        "Idempotency-Key": createPortalOperationKey("template-apply"),
      },
      body: JSON.stringify({}),
    }).catch(() => null);
    setBusy(null);
    if (!result?.ok) {
      setMessage({
        tone: "error",
        text: result?.error.message ?? "The template could not be opened.",
      });
      return;
    }
    router.push(
      `/partners/book?draftId=${encodeURIComponent(result.data.draft.id)}` as Route,
    );
  };

  const createSeries = async (
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const payload = {
      templateId: String(form.get("templateId") ?? ""),
      name: String(form.get("name") ?? ""),
      frequency: String(form.get("frequency") ?? "weekly"),
      startsOn: String(form.get("startsOn") ?? ""),
      occurrenceCount: Number(form.get("occurrenceCount") ?? 2),
      preferredWindowStart:
        String(form.get("preferredWindowStart") ?? "") || null,
    };
    setBusy("recurring");
    setMessage(null);
    const result = await partnerPortalFetch<{
      ok: true;
      series: RecurringSeries;
    }>("recurring-series", {
      method: "POST",
      headers: {
        "Idempotency-Key": createPortalOperationKey("recurring-series"),
      },
      body: JSON.stringify(payload),
    }).catch(() => null);
    setBusy(null);
    if (!result?.ok) {
      setMessage({
        tone: "error",
        text:
          result?.error.message ?? "The recurring schedule was not created.",
      });
      return;
    }
    setMessage({
      tone: "success",
      text: "Recurring schedule created. Work inside the 30-day horizon was checked through live scheduling; later occurrences remain tentative.",
    });
    await load();
  };

  const readCsv = async (file: File | null): Promise<void> => {
    setCsvFile(file);
    setCsvText(null);
    setBulkResult(null);
    if (!file) return;
    if (file.size > 256 * 1024) {
      setMessage({ tone: "error", text: "Use a CSV no larger than 256 KB." });
      return;
    }
    setCsvText(await file.text());
  };

  const sendBulk = async (dryRun: boolean): Promise<void> => {
    if (!csvFile || csvText === null) return;
    setBusy(dryRun ? "bulk-dry-run" : "bulk-commit");
    setMessage(null);
    const result = await partnerPortalFetch<{ ok: true; import: BulkResult }>(
      "bulk-imports",
      {
        method: "POST",
        headers: {
          "Idempotency-Key": createPortalOperationKey(
            dryRun ? "bulk-dry-run" : "bulk-create",
          ),
        },
        body: JSON.stringify({ filename: csvFile.name, csv: csvText, dryRun }),
      },
    ).catch(() => null);
    setBusy(null);
    if (!result?.ok) {
      setMessage({
        tone: "error",
        text: result?.error.message ?? "The CSV could not be processed.",
      });
      return;
    }
    setBulkResult(result.data.import);
    setMessage({
      tone: result.data.import.errorCount ? "warning" : "success",
      text: dryRun
        ? "Dry run complete. Review every row before creating drafts. No job or capacity reservation was created."
        : "Valid rows were converted to drafts. Open each draft to choose a live arrival window and confirm; bulk intake never silently reserves capacity.",
    });
  };

  const exampleCsv = [
    "location_id,service_key,description,contact_name,contact_phone,contact_email,preferred_date,preferred_window_start,crew_instructions,item_count,volume_cubic_yards,po_number,cost_center,project_reference",
    "paste-location-uuid,junk_removal,Remove boxed office items,Jordan Smith,555-555-0123,,2026-09-15,08:00,Call on arrival,12,4,PO-100,Facilities,Suite refresh",
  ].join("\r\n");

  return (
    <section aria-labelledby="partner-repeat-work-title">
      <PartnerPanel as="div">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2
              id="partner-repeat-work-title"
              className="text-lg font-semibold text-slate-950"
            >
              Repeat and bulk work
            </h2>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600">
              Reuse safe job details, set a recurring cadence, or validate up to
              100 CSV rows before anything is submitted.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className={partnerSecondaryButtonClass}
          >
            <RefreshCw
              className={cn(
                "h-4 w-4",
                loading && "animate-spin motion-reduce:animate-none",
              )}
              aria-hidden="true"
            />
            Refresh
          </button>
        </div>

        {message ? (
          <PartnerNotice tone={message.tone} className="mt-4">
            {message.text}
          </PartnerNotice>
        ) : null}

        <div className="mt-5 grid gap-4 xl:grid-cols-3">
          <section
            aria-labelledby="saved-templates-title"
            className="rounded-xl border border-slate-200 p-4"
          >
            <h3
              id="saved-templates-title"
              className="font-semibold text-slate-950"
            >
              Saved templates
            </h3>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              Templates exclude access secrets, media, pricing, approvals,
              holds, and payment details.
            </p>
            {loading ? (
              <p className="mt-4 inline-flex items-center gap-2 text-sm text-slate-600">
                <LoaderCircle
                  className="h-4 w-4 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
                Loading templates…
              </p>
            ) : templates.length ? (
              <ul className="mt-4 space-y-2">
                {templates.map((template) => (
                  <li
                    key={template.id}
                    className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 p-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-slate-900">
                        {template.name}
                      </p>
                      <p className="text-xs text-slate-600">
                        {humanize(template.serviceKey)}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void useTemplate(template.id)}
                      disabled={busy === `template:${template.id}`}
                      className={partnerSecondaryButtonClass}
                    >
                      {busy === `template:${template.id}` ? "Opening…" : "Use"}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-4 text-sm text-slate-600">
                Open a completed or upcoming job and choose “Save as reusable
                template.”
              </p>
            )}
          </section>

          <section
            aria-labelledby="recurring-series-title"
            className="rounded-xl border border-slate-200 p-4"
          >
            <h3
              id="recurring-series-title"
              className="flex items-center gap-2 font-semibold text-slate-950"
            >
              <CalendarRange
                className="h-5 w-5 text-primary-700"
                aria-hidden="true"
              />
              Recurring schedule
            </h3>
            <form
              onSubmit={(event) => void createSeries(event)}
              className="mt-3 space-y-3"
            >
              <label className="block text-sm font-semibold text-slate-700">
                Template
                <select
                  name="templateId"
                  required
                  className={partnerFieldClass}
                  defaultValue=""
                >
                  <option value="" disabled>
                    Choose a template
                  </option>
                  {templates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm font-semibold text-slate-700">
                Series name
                <input
                  name="name"
                  required
                  minLength={2}
                  maxLength={120}
                  className={partnerFieldClass}
                  placeholder="Weekly turnover pickup"
                />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block text-sm font-semibold text-slate-700">
                  Cadence
                  <select
                    name="frequency"
                    className={partnerFieldClass}
                    defaultValue="weekly"
                  >
                    <option value="weekly">Weekly</option>
                    <option value="biweekly">Every 2 weeks</option>
                    <option value="monthly">Monthly</option>
                  </select>
                </label>
                <label className="block text-sm font-semibold text-slate-700">
                  Occurrences
                  <input
                    name="occurrenceCount"
                    type="number"
                    min={2}
                    max={24}
                    defaultValue={4}
                    required
                    className={partnerFieldClass}
                  />
                </label>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label className="block text-sm font-semibold text-slate-700">
                  First date
                  <input
                    name="startsOn"
                    type="date"
                    required
                    className={partnerFieldClass}
                  />
                </label>
                <label className="block text-sm font-semibold text-slate-700">
                  Desired window
                  <input
                    name="preferredWindowStart"
                    type="time"
                    step={1800}
                    className={partnerFieldClass}
                  />
                </label>
              </div>
              <button
                type="submit"
                disabled={!templates.length || busy === "recurring"}
                className={partnerPrimaryButtonClass}
              >
                {busy === "recurring" ? (
                  <LoaderCircle
                    className="h-4 w-4 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                ) : (
                  <CalendarRange className="h-4 w-4" aria-hidden="true" />
                )}
                {busy === "recurring"
                  ? "Checking schedule…"
                  : "Create recurring schedule"}
              </button>
            </form>
            {series.length ? (
              <ul className="mt-4 space-y-2" aria-label="Recurring schedules">
                {series.slice(0, 5).map((item) => (
                  <li
                    key={item.id}
                    className="rounded-lg bg-slate-50 p-3 text-sm"
                  >
                    <p className="font-semibold text-slate-900">{item.name}</p>
                    <p className="mt-1 text-slate-600">
                      {
                        item.occurrences.filter(
                          (entry) => entry.state === "confirmed",
                        ).length
                      }{" "}
                      confirmed ·{" "}
                      {
                        item.occurrences.filter(
                          (entry) => entry.state === "tentative",
                        ).length
                      }{" "}
                      tentative ·{" "}
                      {
                        item.occurrences.filter(
                          (entry) => entry.state === "review",
                        ).length
                      }{" "}
                      need attention
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {item.occurrences
                        .filter((entry) => entry.draftId && !entry.jobId)
                        .slice(0, 3)
                        .map((entry) => (
                          <a
                            key={entry.id}
                            href={`/partners/book?draftId=${encodeURIComponent(entry.draftId!)}`}
                            className="font-semibold text-primary-800 underline-offset-4 hover:underline"
                          >
                            Review {entry.localDate}
                          </a>
                        ))}
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          <section
            aria-labelledby="bulk-import-title"
            className="rounded-xl border border-slate-200 p-4"
          >
            <h3
              id="bulk-import-title"
              className="flex items-center gap-2 font-semibold text-slate-950"
            >
              <FileSpreadsheet
                className="h-5 w-5 text-primary-700"
                aria-hidden="true"
              />
              Bulk CSV intake
            </h3>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              Dry-run validation is required in the interface before creating
              drafts. Rows never bypass live slot selection.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() =>
                  downloadText("partner-job-import-template.csv", exampleCsv)
                }
                className={partnerSecondaryButtonClass}
              >
                <Download className="h-4 w-4" aria-hidden="true" />
                CSV template
              </button>
            </div>
            <label className="mt-3 block text-sm font-semibold text-slate-700">
              CSV file
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={(event) =>
                  void readCsv(event.currentTarget.files?.[0] ?? null)
                }
                className={cn(
                  partnerFieldClass,
                  "file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:font-semibold",
                )}
              />
            </label>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void sendBulk(true)}
                disabled={!csvText || Boolean(busy)}
                className={partnerPrimaryButtonClass}
              >
                {busy === "bulk-dry-run" ? "Validating…" : "Run dry check"}
              </button>
              <button
                type="button"
                onClick={() => void sendBulk(false)}
                disabled={!csvText || !bulkResult?.dryRun || Boolean(busy)}
                className={partnerSecondaryButtonClass}
              >
                {busy === "bulk-commit"
                  ? "Creating drafts…"
                  : "Create valid drafts"}
              </button>
            </div>
            {bulkResult ? (
              <div
                className="mt-4 rounded-lg bg-slate-50 p-3 text-sm text-slate-700"
                aria-live="polite"
              >
                <p>
                  <strong>{bulkResult.validCount}</strong> valid ·{" "}
                  <strong>{bulkResult.errorCount}</strong> with errors ·{" "}
                  <strong>0</strong> capacity reservations
                </p>
                <button
                  type="button"
                  onClick={() =>
                    downloadText(
                      "partner-job-import-corrections.csv",
                      bulkResult.correctionCsv,
                    )
                  }
                  className={cn(partnerSecondaryButtonClass, "mt-2")}
                >
                  <Download className="h-4 w-4" aria-hidden="true" />
                  Download row results
                </button>
                {bulkResult.rows.some((row) => row.draftId) ? (
                  <ul className="mt-3 space-y-1">
                    {bulkResult.rows
                      .filter((row) => row.draftId)
                      .slice(0, 10)
                      .map((row) => (
                        <li key={row.rowNumber}>
                          <a
                            className="font-semibold text-primary-800 underline-offset-4 hover:underline"
                            href={`/partners/book?draftId=${encodeURIComponent(row.draftId!)}`}
                          >
                            Open row {row.rowNumber} draft
                          </a>
                        </li>
                      ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </section>
        </div>
      </PartnerPanel>
    </section>
  );
}
