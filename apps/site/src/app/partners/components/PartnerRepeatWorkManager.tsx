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
  Sparkles,
  X,
} from "lucide-react";
import { cn } from "@myst-os/ui";
import { createPortalOperationKey, partnerPortalFetch } from "../lib/portal-v2";
import { getPartnerPersonaPresentation } from "../lib/persona-presentation";
import { confirmPartnerNavigation } from "../lib/use-partner-unsaved-changes";
import { usePartnerLiveRefresh } from "../lib/use-partner-live-refresh";
import {
  recurringOccurrenceNeedsAttention,
  recurringOccurrenceStatus,
} from "../lib/recurring-occurrence-status";
import { PartnerTemplateDraftReplacement } from "./PartnerTemplateDraftReplacement";
import {
  PartnerNotice,
  PartnerPanel,
  partnerFieldClass,
  partnerPrimaryButtonClass,
  partnerSecondaryButtonClass,
} from "./PartnerPortalUi";

type ServiceTemplate = {
  active: boolean;
  reusable?: { description?: string; crewInstructions?: string | null };
  id: string;
  name: string;
  serviceKey: string;
  locationId: string | null;
  updatedAt: string;
  etag: string;
};

type RecurringOccurrence = {
  id: string;
  localDate: string;
  state: string;
  draftId: string | null;
  jobId: string | null;
  currentJobStatus: string | null;
  reason: string | null;
};

type RecurringSeries = {
  id: string;
  name: string;
  state: string;
  revision: number;
  etag: string;
  endsOn: string | null;
  lifecycle: {
    action: "pause" | "resume" | "cancel";
    reason: string;
    changedAt: string;
  } | null;
  occurrences: RecurringOccurrence[];
};

type BulkResult = {
  id: string;
  state: string;
  etag: string;
  dryRun: boolean;
  rowCount: number;
  validCount: number;
  errorCount: number;
  correctionCsv: string;
  capacityReserved: boolean;
  pendingCount: number;
  confirmedCount: number;
  reviewCount: number;
  rows: Array<{
    rowNumber: number;
    state: string;
    draftId: string | null;
    jobId: string | null;
    errors: Array<{ field?: string; message?: string }>;
  }>;
};

function humanize(value: string): string {
  return value
    .replace(/_/gu, " ")
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function formString(form: FormData, key: string, fallback = ""): string {
  const value = form.get(key);
  return typeof value === "string" ? value : fallback;
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

export function PartnerRepeatWorkManager({
  canManageSeries,
  persona,
  enabledTools = { templates: false, recurring: false, bulk: false },
}: {
  canManageSeries: boolean;
  persona: string | null;
  enabledTools?: { templates: boolean; recurring: boolean; bulk: boolean };
}) {
  const router = useRouter();
  const personaPresentation = getPartnerPersonaPresentation(persona);
  const [templates, setTemplates] = React.useState<ServiceTemplate[]>([]);
  const [templateCursor, setTemplateCursor] = React.useState<string | null>(
    null,
  );
  const [templateQuery, setTemplateQuery] = React.useState("");
  const templateSearch = React.useRef("");
  const templateGeneration = React.useRef(0);
  const [series, setSeries] = React.useState<RecurringSeries[]>([]);
  const [seriesCursor, setSeriesCursor] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<{
    tone: "success" | "error" | "warning" | "info";
    text: string;
  } | null>(null);
  const [csvFile, setCsvFile] = React.useState<File | null>(null);
  const [csvText, setCsvText] = React.useState<string | null>(null);
  const [bulkResult, setBulkResult] = React.useState<BulkResult | null>(null);
  const [bulkHistory, setBulkHistory] = React.useState<
    Array<{ id: string; filename: string; state: string; createdAt: string }>
  >([]);
  const [bulkCursor, setBulkCursor] = React.useState<string | null>(null);
  const [bulkPage, setBulkPage] = React.useState(0);
  const [editingTemplate, setEditingTemplate] = React.useState<string | null>(
    null,
  );
  const [templateName, setTemplateName] = React.useState("");
  const bulkOperationKeys = React.useRef<{ validate: string; commit: string }>({
    validate: createPortalOperationKey("bulk-check"),
    commit: createPortalOperationKey("bulk-submit"),
  });
  const [sampleLocationId, setSampleLocationId] = React.useState("");
  const [lifecycleReasons, setLifecycleReasons] = React.useState<
    Record<string, string>
  >({});
  const [showStarterSuggestions, setShowStarterSuggestions] =
    React.useState(false);

  React.useEffect(() => {
    setShowStarterSuggestions(false);
  }, [personaPresentation.key]);

  const load = React.useCallback(async (): Promise<void> => {
    setLoading(true);
    const [templateResult, seriesResult] = await Promise.all([
      partnerPortalFetch<{
        ok: true;
        templates: ServiceTemplate[];
        nextCursor: string | null;
      }>("service-templates").catch(() => null),
      partnerPortalFetch<{
        ok: true;
        series: RecurringSeries[];
        nextCursor: string | null;
      }>("recurring-series").catch(() => null),
    ]);
    setLoading(false);
    if (templateResult?.ok) {
      setTemplates(templateResult.data.templates);
      setTemplateCursor(templateResult.data.nextCursor);
    }
    if (seriesResult?.ok) {
      setSeries(seriesResult.data.series);
      setSeriesCursor(seriesResult.data.nextCursor);
    }
    if (!templateResult?.ok || !seriesResult?.ok) {
      setMessage({
        tone: "warning",
        text: "Some repeat-work tools could not be loaded. Your bookings are unchanged.",
      });
    }
  }, [enabledTools.templates, enabledTools.recurring]);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function searchTemplates(cursor?: string) {
    const generation = ++templateGeneration.current;
    if (!cursor) templateSearch.current = templateQuery;
    const result = await partnerPortalFetch<{
      templates: ServiceTemplate[];
      nextCursor: string | null;
    }>(
      `service-templates?q=${encodeURIComponent(templateSearch.current)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      { signal: AbortSignal.timeout(8_000) },
    ).catch(() => null);
    if (generation !== templateGeneration.current) return;
    if (!result?.ok) {
      setMessage({
        tone: "warning",
        text: "Saved templates could not be loaded. Please try again.",
      });
      return;
    }
    setTemplates((current) =>
      cursor
        ? [
            ...new Map(
              [...current, ...result.data.templates].map((item) => [
                item.id,
                item,
              ]),
            ).values(),
          ]
        : result.data.templates,
    );
    setTemplateCursor(result.data.nextCursor);
  }

  const loadBulkHistory = React.useCallback(
    async (cursor?: string) => {
      const result = await partnerPortalFetch<{
        ok: true;
        imports: typeof bulkHistory;
        nextCursor: string | null;
      }>(
        `bulk-imports${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
      ).catch(() => null);
      if (result?.ok) {
        setBulkHistory((current) =>
          cursor ? [...current, ...result.data.imports] : result.data.imports,
        );
        setBulkCursor(result.data.nextCursor);
      }
    },
    [enabledTools.bulk],
  );
  React.useEffect(() => {
    void loadBulkHistory();
    if (enabledTools.bulk)
      void partnerPortalFetch<{ ok: true; locations: Array<{ id: string }> }>(
        "locations?limit=1&active=true",
      )
        .then((result) => {
          if (result.ok)
            setSampleLocationId(result.data.locations[0]?.id ?? "");
        })
        .catch(() => undefined);
  }, [enabledTools.bulk, loadBulkHistory]);

  const openBulk = React.useCallback(
    async (importId: string, resetPage = true, signal?: AbortSignal) => {
      const result = await partnerPortalFetch<{ ok: true; import: BulkResult }>(
        `bulk-imports/${encodeURIComponent(importId)}`,
        { signal },
      ).catch(() => null);
      if (result?.ok) {
        setBulkResult(result.data.import);
        if (resetPage) setBulkPage(0);
        return true;
      }
      if (!signal?.aborted)
        setMessage({
          tone: "warning",
          text: "Saved import progress could not be refreshed. Accepted jobs are unchanged.",
        });
      return false;
    },
    [],
  );
  usePartnerLiveRefresh(
    `bulk:${bulkResult?.id ?? "none"}`,
    async (signal) =>
      bulkResult ? openBulk(bulkResult.id, false, signal) : true,
    bulkResult?.state === "processing",
  );

  const updateTemplate = async (template: ServiceTemplate, active: boolean) => {
    if (
      !active &&
      !window.confirm(
        "Remove this saved shortcut? Existing jobs and recurring service are unchanged.",
      )
    )
      return;
    setBusy(`template-edit:${template.id}`);
    const result = await partnerPortalFetch(
      `service-templates/${template.id}`,
      {
        method: "PATCH",
        headers: {
          "If-Match": template.etag,
          "Idempotency-Key": createPortalOperationKey("template-edit"),
        },
        body: JSON.stringify(
          active
            ? template.active === false
              ? { active: true }
              : { name: templateName }
            : { active: false },
        ),
      },
    ).catch(() => null);
    setBusy(null);
    if (result?.ok) {
      setEditingTemplate(null);
      await load();
    } else {
      setMessage({
        tone: "error",
        text: result?.error.message ?? "The shortcut could not be updated.",
      });
      if (result && result.response.status === 412) await load();
    }
  };

  const applyTemplate = async (templateId: string): Promise<void> => {
    if (!confirmPartnerNavigation()) return;
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
      templateId: formString(form, "templateId"),
      name: formString(form, "name"),
      frequency: formString(form, "frequency", "weekly"),
      startsOn: formString(form, "startsOn"),
      endsOn: formString(form, "endsOn") || null,
      preferredWindowStart: formString(form, "preferredWindowStart") || null,
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

  const changeSeriesLifecycle = async (
    item: RecurringSeries,
    action: "pause" | "resume" | "cancel",
  ): Promise<void> => {
    const reason = (lifecycleReasons[item.id] ?? "").trim();
    if (reason.length < 2 || reason.length > 300) {
      setMessage({
        tone: "error",
        text: "Add a reason between 2 and 300 characters before changing this schedule.",
      });
      return;
    }
    const busyKey = `series:${item.id}:${action}`;
    setBusy(busyKey);
    setMessage(null);
    const result = await partnerPortalFetch<{
      ok: true;
      series: RecurringSeries;
      transition: {
        action: typeof action;
        changedOccurrences: number;
        preservedOccurrences: number;
      };
    }>(`recurring-series/${encodeURIComponent(item.id)}`, {
      method: "PATCH",
      headers: {
        "Idempotency-Key": createPortalOperationKey(
          `recurring-series-${action}`,
        ),
        "If-Match": item.etag,
      },
      body: JSON.stringify({ action, reason }),
    }).catch(() => null);
    setBusy(null);
    if (!result?.ok) {
      if (result?.response.status === 412) {
        setMessage({
          tone: "warning",
          text: "This recurring schedule changed while you were viewing it. The latest version has been loaded; review it before trying again.",
        });
        await load();
        return;
      }
      setMessage({
        tone: result?.error.retryable ? "warning" : "error",
        text:
          result?.error.message ??
          "The recurring schedule could not be changed. No existing job was altered.",
      });
      return;
    }
    const responseEtag = result.response.headers.get("etag");
    const updated = responseEtag
      ? { ...result.data.series, etag: responseEtag }
      : result.data.series;
    setSeries((current) =>
      current.map((entry) => (entry.id === updated.id ? updated : entry)),
    );
    setLifecycleReasons((current) => ({ ...current, [item.id]: "" }));
    const actionLabel =
      action === "pause"
        ? "paused"
        : action === "resume"
          ? "resumed"
          : "canceled";
    setMessage({
      tone: "success",
      text: `Recurring schedule ${actionLabel}. ${result.data.transition.changedOccurrences} future tentative occurrence${result.data.transition.changedOccurrences === 1 ? "" : "s"} updated; ${result.data.transition.preservedOccurrences} existing or ineligible occurrence${result.data.transition.preservedOccurrences === 1 ? " was" : "s were"} left unchanged.`,
    });
  };

  const readCsv = async (file: File | null): Promise<void> => {
    setCsvFile(file);
    setCsvText(null);
    setBulkResult(null);
    bulkOperationKeys.current = {
      validate: createPortalOperationKey("bulk-check"),
      commit: createPortalOperationKey("bulk-submit"),
    };
    if (!file) return;
    if (file.size > 256 * 1024) {
      setMessage({ tone: "error", text: "Use a CSV no larger than 256 KB." });
      return;
    }
    setCsvText(await file.text());
  };

  const sendBulk = async (dryRun: boolean): Promise<void> => {
    if (dryRun && (!csvFile || csvText === null)) return;
    if (!dryRun && !bulkResult?.dryRun) return;
    setBusy(dryRun ? "bulk-dry-run" : "bulk-commit");
    setMessage(null);
    const result = await partnerPortalFetch<{ ok: true; import: BulkResult }>(
      !dryRun && bulkResult
        ? `bulk-imports/${bulkResult.id}/commit`
        : "bulk-imports",
      {
        method: "POST",
        headers: {
          "Idempotency-Key": dryRun
            ? bulkOperationKeys.current.validate
            : bulkOperationKeys.current.commit,
          ...(!dryRun && bulkResult ? { "If-Match": bulkResult.etag } : {}),
        },
        body: dryRun
          ? JSON.stringify({ filename: csvFile!.name, csv: csvText, dryRun })
          : undefined,
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
    setBulkPage(0);
    void loadBulkHistory();
    setMessage({
      tone: result.data.import.errorCount ? "warning" : "success",
      text: dryRun
        ? "File check complete. Review every row before saving requests. No job or capacity reservation was created."
        : "Your requests are saved and processing. Eligible work confirms in the requested window; other work goes to Stonegate for review. You can leave and return to these results.",
    });
  };

  const exampleCsv = [
    "location_id,service_key,description,contact_name,contact_phone,contact_email,preferred_date,preferred_window_start,crew_instructions,item_count,volume_cubic_yards,po_number,cost_center,project_reference",
    `${sampleLocationId},service_request,Describe your service request,On-site contact,,replace-with-contact-email,${new Date(Date.now() + 86400000).toLocaleDateString("en-CA", { timeZone: "America/New_York" })},,Call on arrival,,,,,`,
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
              {personaPresentation.taskLabels.repeat_work}
            </h2>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600">
              Save time by starting from details you already trust. Use a
              template, create recurring work, or check up to 100 CSV rows
              before anything is submitted.
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

        {showStarterSuggestions ? (
          <aside
            aria-labelledby="partner-starter-templates-heading"
            className="mt-5 rounded-2xl border border-primary-100 bg-primary-50/70 p-4 sm:p-5"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="max-w-3xl">
                <p className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-primary-700">
                  <Sparkles className="h-4 w-4" aria-hidden="true" />
                  Faster starting points
                </p>
                <h3
                  id="partner-starter-templates-heading"
                  className="mt-2 font-semibold text-slate-950"
                >
                  {personaPresentation.repeatWork.title}
                </h3>
                <p className="mt-1 text-sm leading-6 text-slate-700">
                  These ideas do not create a template or select a service. Open
                  a job and save it as a template when its details are safe to
                  reuse.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowStarterSuggestions(false)}
                className={cn(partnerSecondaryButtonClass, "min-h-11 px-3")}
                aria-label="Dismiss starter template suggestions"
              >
                <X className="h-4 w-4" aria-hidden="true" />
                Dismiss
              </button>
            </div>
            <ul className="mt-4 grid gap-3 sm:grid-cols-2">
              {personaPresentation.repeatWork.starterTemplates.map(
                (suggestion) => (
                  <li
                    key={suggestion.name}
                    className="rounded-xl border border-white bg-white p-4 shadow-sm"
                  >
                    <p className="font-semibold text-slate-950">
                      {suggestion.name}
                    </p>
                    <p className="mt-1 text-sm leading-5 text-slate-600">
                      {suggestion.description}
                    </p>
                    <p className="mt-2 text-xs font-medium leading-5 text-slate-600">
                      Capture: {suggestion.checklist.join(" · ")}
                    </p>
                  </li>
                ),
              )}
            </ul>
          </aside>
        ) : null}

        <div className="mt-5 grid gap-4 xl:grid-cols-3">
          {enabledTools.templates || templates.length > 0 ? (
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
              <form
                className="mt-3 flex flex-wrap gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void searchTemplates();
                }}
              >
                <label className="min-w-0 flex-1 text-sm">
                  Search templates
                  <input
                    value={templateQuery}
                    onChange={(event) => setTemplateQuery(event.target.value)}
                    maxLength={120}
                    className={partnerFieldClass}
                  />
                </label>
                <button type="submit" className={partnerSecondaryButtonClass}>
                  Search
                </button>
              </form>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                Reuse the service, location, and routine instructions. Access
                secrets, photos, prices, approvals, and payments stay out.
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
                      className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-slate-50 p-3"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-slate-900">
                          {template.name}
                        </p>
                        <p className="text-xs text-slate-600">
                          {humanize(template.serviceKey)}
                        </p>
                      </div>
                      {enabledTools.templates && template.active !== false ? (
                        <button
                          type="button"
                          onClick={() => void applyTemplate(template.id)}
                          disabled={busy === `template:${template.id}`}
                          className={partnerSecondaryButtonClass}
                        >
                          {busy === `template:${template.id}`
                            ? "Opening…"
                            : "Use"}
                        </button>
                      ) : null}
                      {canManageSeries ? (
                        <div className="flex flex-wrap gap-2">
                          {enabledTools.templates &&
                          template.active !== false ? (
                            <button
                              type="button"
                              className={partnerSecondaryButtonClass}
                              onClick={() => {
                                setEditingTemplate(template.id);
                                setTemplateName(template.name);
                              }}
                            >
                              Rename
                            </button>
                          ) : null}
                          {template.active !== false ? (
                            <button
                              type="button"
                              className={partnerSecondaryButtonClass}
                              disabled={Boolean(busy)}
                              onClick={() =>
                                void updateTemplate(template, false)
                              }
                            >
                              Remove shortcut
                            </button>
                          ) : enabledTools.templates ? (
                            <button
                              type="button"
                              className={partnerSecondaryButtonClass}
                              disabled={Boolean(busy)}
                              onClick={() =>
                                void updateTemplate(template, true)
                              }
                            >
                              Restore shortcut
                            </button>
                          ) : (
                            <span className="text-sm text-slate-600">
                              Archived
                            </span>
                          )}
                        </div>
                      ) : null}
                      <details className="w-full">
                        <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold">
                          View saved details
                        </summary>
                        <p className="whitespace-pre-wrap text-sm leading-6">
                          {template.reusable?.description ||
                            "No saved description."}
                        </p>
                        {template.reusable?.crewInstructions ? (
                          <p className="mt-2 whitespace-pre-wrap text-sm leading-6">
                            {template.reusable.crewInstructions}
                          </p>
                        ) : null}
                      </details>
                      {canManageSeries &&
                      enabledTools.templates &&
                      template.active !== false ? (
                        <PartnerTemplateDraftReplacement
                          key={`${template.id}:${template.etag}`}
                          templateId={template.id}
                          etag={template.etag}
                          onSaved={load}
                        />
                      ) : null}
                      {editingTemplate === template.id ? (
                        <form
                          className="flex w-full flex-wrap gap-2"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void updateTemplate(template, true);
                          }}
                        >
                          <label className="min-w-0 flex-1 text-sm">
                            Shortcut name
                            <input
                              className={cn(partnerFieldClass, "mt-1")}
                              value={templateName}
                              onChange={(event) =>
                                setTemplateName(event.target.value)
                              }
                              minLength={2}
                              maxLength={120}
                              required
                            />
                          </label>
                          <button
                            className={partnerPrimaryButtonClass}
                            disabled={Boolean(busy)}
                          >
                            Save name
                          </button>
                          <button
                            type="button"
                            className={partnerSecondaryButtonClass}
                            onClick={() => setEditingTemplate(null)}
                          >
                            Cancel
                          </button>
                        </form>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-4 text-sm text-slate-600">
                  Open a completed or upcoming job and choose “Save as reusable
                  template.”
                </p>
              )}
              {templateCursor ? (
                <button
                  type="button"
                  onClick={() => void searchTemplates(templateCursor)}
                  className={partnerSecondaryButtonClass}
                >
                  More templates
                </button>
              ) : null}
            </section>
          ) : null}

          {enabledTools.recurring || series.length > 0 ? (
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
              {enabledTools.recurring ? (
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
                      {templates
                        .filter((template) => template.active !== false)
                        .map((template) => (
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
                      placeholder={
                        personaPresentation.repeatWork.starterTemplates[0]
                          ?.name ?? "Recurring service"
                      }
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
                      End date (optional)
                      <input
                        name="endsOn"
                        type="date"
                        className={partnerFieldClass}
                      />
                      <span className="mt-1 block text-xs font-normal text-slate-500">
                        Leave blank to continue until canceled.
                      </span>
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
              ) : (
                <p className="mt-3 text-sm text-slate-600">
                  New recurring service is disabled. You can still view, pause,
                  or cancel future tentative work.
                </p>
              )}
              {series.length ? (
                <ul className="mt-4 space-y-2" aria-label="Recurring schedules">
                  {series.map((item) => {
                    const reasonId = `recurring-series-reason-${item.id}`;
                    const helpId = `recurring-series-help-${item.id}`;
                    const itemBusy = busy?.startsWith(`series:${item.id}:`);
                    return (
                      <li
                        key={item.id}
                        className="rounded-lg bg-slate-50 p-3 text-sm"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="font-semibold text-slate-900">
                            {item.name}
                          </p>
                          <span className="rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 ring-1 ring-inset ring-slate-200">
                            {humanize(item.state)}
                          </span>
                        </div>
                        <p className="mt-1 text-slate-600">
                          {
                            item.occurrences.filter((entry) =>
                              ["confirmed", "en_route", "in_progress"].includes(
                                recurringOccurrenceStatus(entry),
                              ),
                            ).length
                          }{" "}
                          scheduled ·{" "}
                          {
                            item.occurrences.filter(
                              (entry) =>
                                recurringOccurrenceStatus(entry) ===
                                "completed",
                            ).length
                          }{" "}
                          completed ·{" "}
                          {
                            item.occurrences.filter(
                              (entry) =>
                                recurringOccurrenceStatus(entry) ===
                                "tentative",
                            ).length
                          }{" "}
                          tentative ·{" "}
                          {
                            item.occurrences.filter(
                              recurringOccurrenceNeedsAttention,
                            ).length
                          }{" "}
                          need attention ·{" "}
                          {
                            item.occurrences.filter(
                              (entry) =>
                                ["canceled", "declined"].includes(
                                  recurringOccurrenceStatus(entry),
                                ) ||
                                (entry.state === "skipped" &&
                                  entry.reason === "series_paused"),
                            ).length
                          }{" "}
                          paused or closed
                        </p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {item.occurrences
                            .filter((entry) => entry.draftId && !entry.jobId)
                            .slice(0, 3)
                            .map((entry) => (
                              <a
                                key={entry.id}
                                href={`/partners/book?draftId=${encodeURIComponent(entry.draftId!)}`}
                                className="inline-flex min-h-11 items-center font-semibold text-primary-800 underline-offset-4 hover:underline"
                              >
                                Review {entry.localDate}
                              </a>
                            ))}
                        </div>
                        <p className="mt-2 text-sm text-slate-600">
                          {item.endsOn
                            ? `Ends ${item.endsOn}.`
                            : "Continues until canceled."}{" "}
                          Dates outside the next 30 days are tentative, not
                          reserved.
                        </p>
                        <details className="mt-2">
                          <summary className="flex min-h-11 cursor-pointer items-center font-semibold">
                            Service dates and requests
                          </summary>
                          <ul className="divide-y divide-slate-200">
                            {item.occurrences.map((entry) => (
                              <li
                                key={entry.id}
                                className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                              >
                                <span>
                                  {entry.localDate} ·{" "}
                                  {humanize(recurringOccurrenceStatus(entry))}
                                </span>
                                {entry.jobId ? (
                                  <a
                                    className="inline-flex min-h-11 items-center font-semibold underline"
                                    href={`/partners/bookings/${entry.jobId}`}
                                  >
                                    View job
                                  </a>
                                ) : entry.draftId ? (
                                  <a
                                    className="inline-flex min-h-11 items-center font-semibold underline"
                                    href={`/partners/book?draftId=${entry.draftId}`}
                                  >
                                    Complete details
                                  </a>
                                ) : null}
                              </li>
                            ))}
                          </ul>
                        </details>
                        {item.lifecycle ? (
                          <p className="mt-2 text-xs leading-5 text-slate-600">
                            Last change: {humanize(item.lifecycle.action)} —{" "}
                            {item.lifecycle.reason}
                          </p>
                        ) : null}
                        {canManageSeries &&
                        (item.state === "active" || item.state === "paused") ? (
                          <div className="mt-3 border-t border-slate-200 pt-3">
                            <label
                              htmlFor={reasonId}
                              className="block text-sm font-semibold text-slate-700"
                            >
                              Reason for schedule change
                            </label>
                            <input
                              id={reasonId}
                              value={lifecycleReasons[item.id] ?? ""}
                              onChange={(event) =>
                                setLifecycleReasons((current) => ({
                                  ...current,
                                  [item.id]: event.currentTarget.value,
                                }))
                              }
                              minLength={2}
                              maxLength={300}
                              disabled={Boolean(itemBusy)}
                              aria-describedby={helpId}
                              className={partnerFieldClass}
                              placeholder="Example: Work is on hold until the next turnover"
                            />
                            <p
                              id={helpId}
                              className="mt-1 text-xs leading-5 text-slate-600"
                            >
                              Only future tentative occurrences change. Existing
                              jobs and review requests remain unchanged.
                              Resuming does not reserve capacity outside the
                              30-day horizon.
                            </p>
                            <div className="mt-2 flex flex-wrap gap-2">
                              {item.state === "active" ? (
                                <button
                                  type="button"
                                  onClick={() =>
                                    void changeSeriesLifecycle(item, "pause")
                                  }
                                  disabled={Boolean(itemBusy)}
                                  aria-describedby={helpId}
                                  className={partnerSecondaryButtonClass}
                                >
                                  {busy === `series:${item.id}:pause`
                                    ? "Pausing…"
                                    : "Pause future work"}
                                </button>
                              ) : enabledTools.recurring ? (
                                <button
                                  type="button"
                                  onClick={() =>
                                    void changeSeriesLifecycle(item, "resume")
                                  }
                                  disabled={Boolean(itemBusy)}
                                  aria-describedby={helpId}
                                  className={partnerPrimaryButtonClass}
                                >
                                  {busy === `series:${item.id}:resume`
                                    ? "Resuming…"
                                    : "Resume future work"}
                                </button>
                              ) : null}
                              <button
                                type="button"
                                onClick={() =>
                                  void changeSeriesLifecycle(item, "cancel")
                                }
                                disabled={Boolean(itemBusy)}
                                aria-describedby={helpId}
                                className={partnerSecondaryButtonClass}
                              >
                                {busy === `series:${item.id}:cancel`
                                  ? "Canceling…"
                                  : "Cancel future work"}
                              </button>
                            </div>
                            {itemBusy ? (
                              <p
                                className="mt-2 inline-flex items-center gap-2 text-xs text-slate-600"
                                role="status"
                                aria-live="polite"
                              >
                                <LoaderCircle
                                  className="h-4 w-4 animate-spin motion-reduce:animate-none"
                                  aria-hidden="true"
                                />
                                Updating the recurring schedule…
                              </p>
                            ) : null}
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </section>
          ) : null}

          {seriesCursor ? (
            <button
              type="button"
              className={partnerSecondaryButtonClass}
              onClick={() => void (async () => {
                const result = await partnerPortalFetch<{
                  ok: true;
                  series: RecurringSeries[];
                  nextCursor: string | null;
                }>(
                  `recurring-series?cursor=${encodeURIComponent(seriesCursor)}`,
                ).catch(() => null);
                if (result?.ok) {
                  setSeries((current) => [...current, ...result.data.series]);
                  setSeriesCursor(result.data.nextCursor);
                } else
                  setMessage({
                    tone: "warning",
                    text: "Older recurring service could not be loaded. Please try again.",
                  });
              })()}
            >
              More recurring service
            </button>
          ) : null}
          {enabledTools.bulk || bulkHistory.length > 0 ? (
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
                Request several jobs
              </h3>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                Upload a CSV to check several requests at once. You review
                errors before requests are saved, and each job still needs a
                service window.
              </p>
              {enabledTools.bulk ? (
                <>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        downloadText(
                          "partner-job-import-template.csv",
                          exampleCsv,
                        )
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
                      {busy === "bulk-dry-run" ? "Checking…" : "Check file"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void sendBulk(false)}
                      disabled={!bulkResult?.dryRun || Boolean(busy)}
                      className={partnerSecondaryButtonClass}
                    >
                      {busy === "bulk-commit"
                        ? "Saving requests…"
                        : "Save ready requests"}
                    </button>
                  </div>
                </>
              ) : (
                <p className="mt-3 text-sm text-slate-600">
                  New imports are disabled. Previously submitted requests and
                  results remain available.
                </p>
              )}
              {bulkResult ? (
                <div className="mt-4 rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
                  <p role="status" aria-live="polite">
                    <strong>{bulkResult.validCount}</strong> valid ·{" "}
                    <strong>{bulkResult.errorCount}</strong> with errors ·{" "}
                    {bulkResult.dryRun ? (
                      "No jobs created"
                    ) : (
                      <>
                        <strong>{bulkResult.confirmedCount}</strong> confirmed ·{" "}
                        <strong>{bulkResult.reviewCount}</strong> sent for
                        review · <strong>{bulkResult.pendingCount}</strong>{" "}
                        processing
                      </>
                    )}
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
                    Download rows to correct
                  </button>
                  {enabledTools.bulk &&
                  !bulkResult.dryRun &&
                  bulkResult.rows.some((row) => row.state === "failed") ? (
                    <button
                      type="button"
                      className={cn(partnerSecondaryButtonClass, "mt-2 ml-2")}
                      disabled={Boolean(busy)}
                      onClick={() => void (async () => {
                        setBusy("bulk-retry");
                        const result = await partnerPortalFetch<{
                          ok: true;
                          import: BulkResult;
                        }>(`bulk-imports/${bulkResult.id}/retry`, {
                          method: "POST",
                          headers: {
                            "Idempotency-Key":
                              createPortalOperationKey("bulk-retry"),
                          },
                        }).catch(() => null);
                        setBusy(null);
                        if (result?.ok) setBulkResult(result.data.import);
                        else
                          setMessage({
                            tone: "error",
                            text:
                              result?.error.message ??
                              "Retry could not be started.",
                          });
                      })()}
                    >
                      Retry interrupted rows
                    </button>
                  ) : null}
                  {bulkResult.rows.length ? (
                    <ul className="mt-3 space-y-1">
                      {bulkResult.rows
                        .slice(bulkPage * 20, bulkPage * 20 + 20)
                        .map((row) => (
                          <li
                            key={row.rowNumber}
                            className="border-t border-slate-200 py-2"
                          >
                            <span>
                              Row {row.rowNumber}: {humanize(row.state)}
                            </span>
                            {row.errors.map((error, index) => (
                              <p
                                key={index}
                                className="break-words text-sm text-slate-600"
                              >
                                {error.field}: {error.message}
                              </p>
                            ))}
                            {row.jobId ? (
                              <a
                                className="inline-flex min-h-11 items-center font-semibold underline"
                                href={`/partners/bookings/${row.jobId}`}
                              >
                                View service request
                              </a>
                            ) : row.draftId && row.state === "failed" ? (
                              <a
                                className="inline-flex min-h-11 items-center font-semibold text-primary-800 underline-offset-4 hover:underline"
                                href={`/partners/book?draftId=${encodeURIComponent(row.draftId)}`}
                              >
                                Open row {row.rowNumber} request
                              </a>
                            ) : null}
                          </li>
                        ))}
                    </ul>
                  ) : null}
                  {bulkResult.rows.length > 20 ? (
                    <nav
                      aria-label="Import result pages"
                      className="mt-3 flex flex-wrap items-center gap-2"
                    >
                      <button
                        type="button"
                        className={partnerSecondaryButtonClass}
                        disabled={bulkPage === 0}
                        onClick={() => setBulkPage((page) => page - 1)}
                      >
                        Previous rows
                      </button>
                      <span>
                        Page {bulkPage + 1} of{" "}
                        {Math.ceil(bulkResult.rows.length / 20)}
                      </span>
                      <button
                        type="button"
                        className={partnerSecondaryButtonClass}
                        disabled={(bulkPage + 1) * 20 >= bulkResult.rows.length}
                        onClick={() => setBulkPage((page) => page + 1)}
                      >
                        Next rows
                      </button>
                    </nav>
                  ) : null}
                </div>
              ) : null}
              {bulkHistory.length ? (
                <div className="mt-5 border-t border-slate-200 pt-4">
                  <h4 className="font-semibold">Saved imports</h4>
                  <ul className="mt-2 divide-y divide-slate-100">
                    {bulkHistory.map((item) => (
                      <li key={item.id}>
                        <button
                          type="button"
                          className="flex min-h-11 w-full flex-wrap items-center justify-between gap-2 py-2 text-left"
                          onClick={() => void openBulk(item.id)}
                        >
                          <span className="min-w-0 break-all underline">
                            {item.filename}
                          </span>
                          <span className="text-sm text-slate-600">
                            {humanize(item.state)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                  {bulkCursor ? (
                    <button
                      className={partnerSecondaryButtonClass}
                      type="button"
                      onClick={() => void loadBulkHistory(bulkCursor)}
                    >
                      Older imports
                    </button>
                  ) : null}
                </div>
              ) : null}
            </section>
          ) : null}
        </div>
      </PartnerPanel>
    </section>
  );
}
