import { randomUUID } from "node:crypto";
import React from "react";
import { SubmitButton } from "@/components/SubmitButton";
import { requireCurrentTeamPrincipal } from "@/lib/team-principal";
import { callAdminApiAs } from "../lib/api";
import { teamSurfaceHref } from "../surface-registry";
import {
  approveMergeSuggestionAction,
  declineMergeSuggestionAction,
  manualMergeContactsAction,
  scanMergeSuggestionsAction,
} from "../actions";

type ContactSummary = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
};

type MergeSuggestion = {
  id: string;
  status: string;
  reason: string;
  confidence: number;
  createdAt: string;
  updatedAt: string;
  recoveryLedgerId: string | null;
  sourceContact: ContactSummary | null;
  targetContact: ContactSummary | null;
};

type PreviewContact = ContactSummary & {
  partnerAccountId: string | null;
  partnerStatus: string;
  updatedAt: string;
  counts: Record<string, number>;
};

type MergePreview = {
  source: PreviewContact;
  target: PreviewContact;
  confirmationText: string;
  previewHash: string;
  ruleVersion: string;
  consolidationPlan: {
    identity: "target_nonempty_else_source";
    names: "target_wins";
    doNotContact: "deny_wins";
    uniqueDependencies: "target_wins_source_preserved_in_ledger";
    historicalEvidence: "retained_on_soft_deleted_source";
    legacyPropertyOwners: "move_linked_and_block_stale";
    targetUpdatedFields: string[];
    sourceIdentityCleared: true;
  };
  unresolvedDependencies: string[];
};

type MergeRecoveryAssessment = {
  ledger: {
    id: string;
    sourceContactId: string;
    targetContactId: string;
    suggestionId: string | null;
    previewHash: string;
    ruleVersion: string;
    mergedAt: string;
    actorLabel: string | null;
    entryCount: number;
  };
  assessment: {
    automaticRecoveryAllowed: false;
    status: "manual_review_possible" | "unsafe";
    blockers: string[];
    guidance: string;
  };
  changedDependencies: Array<{
    entityType: string;
    entityId: string;
    dependencyKey: string;
    reason: string;
    expectedOwnerContactId: string | null;
    actualOwnerContactId: string | null;
  }>;
};

type SuggestionPreview = {
  suggestionId: string;
  expectedUpdatedAt: string;
  preview: MergePreview;
};

type MergePagination = {
  limit: number;
  offset: number;
  total: number;
  nextOffset: number | null;
};

type ContactOption = {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  phoneE164: string | null;
};

type MergeStatus = "pending" | "approved" | "declined" | "all";

const MERGE_STATUSES: readonly MergeStatus[] = [
  "pending",
  "approved",
  "declined",
  "all",
];

function normalizeStatus(value: string | undefined): MergeStatus {
  return value && (MERGE_STATUSES as readonly string[]).includes(value)
    ? (value as MergeStatus)
    : "pending";
}

function normalizeOffset(value: string | undefined): number {
  const parsed = Number(value ?? "0");
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

function contactLabel(contact: ContactOption): string {
  return (
    [contact.firstName, contact.lastName].filter(Boolean).join(" ").trim() ||
    "Contact"
  );
}

function mergeHref(input: {
  q?: string;
  status?: MergeStatus;
  offset?: number;
  contactQ?: string;
  suggestionId?: string;
  sourceId?: string;
  targetId?: string;
  recoveryId?: string;
}): string {
  return teamSurfaceHref("merge", {
    query: {
      mergeQ: input.q,
      mergeStatus: input.status,
      mergeOffset: input.offset && input.offset > 0 ? input.offset : undefined,
      mergeContactQ: input.contactQ,
      mergeSuggestionId: input.suggestionId,
      mergeSourceId: input.sourceId,
      mergeTargetId: input.targetId,
      mergeRecoveryId: input.recoveryId,
    },
  });
}

const COUNT_LABELS: Array<[string, string]> = [
  ["properties", "Properties"],
  ["leads", "Leads"],
  ["threads", "Threads"],
  ["messages", "Messages"],
  ["participants", "Thread participants"],
  ["tasks", "Tasks"],
  ["appointments", "Appointments"],
  ["quotes", "Quotes"],
  ["payments", "Payments"],
  ["pipeline", "Pipeline rows"],
  ["partnerUsers", "Partner users"],
  ["partnerRateCards", "Partner rate cards"],
  ["partnerBookings", "Partner bookings"],
  ["agentMemories", "AI memories"],
  ["agentNextActions", "AI next actions"],
  ["mediaAnalyses", "Media analyses"],
  ["automationSessions", "Automation sessions"],
  ["automationActions", "Automation actions"],
  ["callRecords", "Call records"],
  ["mediaAssets", "Media assets"],
  ["appointmentHolds", "Appointment holds"],
  ["etaDrafts", "ETA drafts"],
  ["instantQuotes", "Instant quotes"],
  ["inboxAcknowledgements", "Inbox acknowledgements"],
  ["externalDispatches", "Message dispatch evidence"],
  ["manualCallEvidence", "Manual-call evidence"],
  ["salesCallEvidence", "Sales-call evidence"],
  ["staffNotificationEvidence", "Staff-notification delivery evidence"],
  ["pendingOutboxOperations", "Pending provider operations"],
  ["mergeSuggestions", "Related merge suggestions"],
];

function formatReason(value: string): string {
  return value.replace(/_/gu, " ");
}

function PreviewDetails({ preview }: { preview: MergePreview }) {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        {[
          ["Primary record (kept)", preview.target],
          ["Duplicate record (retained for recovery)", preview.source],
        ].map(([label, contact]) => {
          const item = contact as PreviewContact;
          return (
            <section
              key={item.id}
              className="rounded-2xl border border-slate-200 p-4"
            >
              <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                {label as string}
              </h4>
              <p className="mt-2 font-semibold text-slate-900">{item.name}</p>
              <p className="text-xs text-slate-600">
                {item.email ?? "No email"}
              </p>
              <p className="text-xs text-slate-600">
                {item.phone ?? "No phone"}
              </p>
              <p className="mt-1 break-all text-[11px] text-slate-500">
                {item.id}
              </p>
              <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
                {COUNT_LABELS.map(([key, countLabel]) => (
                  <div key={key} className="rounded-lg bg-slate-50 px-2 py-1">
                    <dt className="text-slate-500">{countLabel}</dt>
                    <dd className="font-semibold text-slate-900">
                      {item.counts[key] ?? 0}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          );
        })}
      </div>
      <section className="rounded-xl border border-sky-200 bg-sky-50 p-3 text-sm text-sky-950">
        <h4 className="font-semibold">Deterministic merge rules</h4>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
          <li>Primary names win.</li>
          <li>Blank primary identity fields are filled from the duplicate.</li>
          <li>
            Do-not-contact always wins and can never be cleared by a merge.
          </li>
          <li>
            Unique conflicts keep the primary value and preserve the duplicate
            value in the recovery ledger.
          </li>
          <li>
            The duplicate becomes an inactive, merge-marked recovery record;
            historical provider evidence remains attached to it.
          </li>
        </ul>
        <p className="mt-2 break-all text-[11px] text-sky-800">
          Rule {preview.ruleVersion} · preview {preview.previewHash}
        </p>
      </section>
      {preview.unresolvedDependencies.length > 0 ? (
        <div
          role="alert"
          className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
        >
          This merge is blocked because the duplicate still owns data that the
          current merge rules cannot safely consolidate:{" "}
          {preview.unresolvedDependencies.join(", ")}.
        </div>
      ) : null}
    </div>
  );
}

async function readError(response: Response): Promise<string> {
  const payload = (await response.json().catch(() => null)) as {
    error?: unknown;
  } | null;
  return typeof payload?.error === "string"
    ? payload.error.replace(/_/gu, " ")
    : `request failed (${response.status})`;
}

export async function MergeQueueSection({
  selectedSuggestionId,
  selectedRecoveryId,
  manualSourceId,
  manualTargetId,
  q,
  status,
  offset,
  contactQ,
}: {
  selectedSuggestionId?: string;
  selectedRecoveryId?: string;
  manualSourceId?: string;
  manualTargetId?: string;
  q?: string;
  status?: string;
  offset?: string;
  contactQ?: string;
}): Promise<React.ReactElement> {
  const principal = await requireCurrentTeamPrincipal();
  const activeStatus = normalizeStatus(status);
  const activeOffset = normalizeOffset(offset);
  const queueQuery = (q ?? "").replace(/\s+/gu, " ").trim().slice(0, 100);
  const contactSearch = (contactQ ?? "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 100);
  const queueParams = new URLSearchParams({
    status: activeStatus,
    limit: "25",
    offset: String(activeOffset),
  });
  if (queueQuery) queueParams.set("q", queueQuery);
  const response = await callAdminApiAs(
    principal,
    `/api/admin/merge-suggestions?${queueParams.toString()}`,
  );
  let queueError: string | null = null;
  let suggestions: MergeSuggestion[] = [];
  let pagination: MergePagination = {
    limit: 25,
    offset: activeOffset,
    total: 0,
    nextOffset: null,
  };
  if (response.ok) {
    const payload = (await response.json()) as {
      suggestions?: MergeSuggestion[];
      pagination?: MergePagination;
    };
    suggestions = payload.suggestions ?? [];
    pagination = payload.pagination ?? pagination;
  } else {
    queueError = await readError(response);
  }

  let contactResults: ContactOption[] = [];
  let contactSearchError: string | null = null;
  if (contactSearch.length >= 2) {
    const contactResponse = await callAdminApiAs(
      principal,
      `/api/admin/contacts?q=${encodeURIComponent(contactSearch)}&limit=20`,
    );
    if (contactResponse.ok) {
      const contactPayload = (await contactResponse.json()) as {
        contacts?: ContactOption[];
      };
      contactResults = contactPayload.contacts ?? [];
    } else {
      contactSearchError = await readError(contactResponse);
    }
  }

  async function loadContactOption(id: string | undefined) {
    if (!id) return null;
    const existing = contactResults.find((contact) => contact.id === id);
    if (existing) return existing;
    const contactResponse = await callAdminApiAs(
      principal,
      `/api/admin/contacts?contactId=${encodeURIComponent(id)}`,
    );
    if (!contactResponse.ok) return null;
    const contactPayload = (await contactResponse.json()) as {
      contacts?: ContactOption[];
    };
    return contactPayload.contacts?.[0] ?? null;
  }

  const [manualSource, manualTarget] = await Promise.all([
    loadContactOption(manualSourceId),
    loadContactOption(manualTargetId),
  ]);

  let suggestionPreview: SuggestionPreview | null = null;
  let suggestionPreviewError: string | null = null;
  if (selectedSuggestionId) {
    const previewResponse = await callAdminApiAs(
      principal,
      `/api/admin/merge-suggestions/${encodeURIComponent(selectedSuggestionId)}`,
    );
    if (previewResponse.ok) {
      suggestionPreview = (await previewResponse.json()) as SuggestionPreview;
    } else {
      suggestionPreviewError = await readError(previewResponse);
    }
  }

  let manualPreview: MergePreview | null = null;
  let manualPreviewError: string | null = null;
  if (manualSourceId && manualTargetId) {
    const query = new URLSearchParams({
      sourceContactId: manualSourceId,
      targetContactId: manualTargetId,
    });
    const previewResponse = await callAdminApiAs(
      principal,
      `/api/admin/merge?${query.toString()}`,
    );
    if (previewResponse.ok) {
      const result = (await previewResponse.json()) as {
        preview: MergePreview;
      };
      manualPreview = result.preview;
    } else {
      manualPreviewError = await readError(previewResponse);
    }
  }

  let recoveryAssessment: MergeRecoveryAssessment | null = null;
  let recoveryAssessmentError: string | null = null;
  if (selectedRecoveryId) {
    const recoveryResponse = await callAdminApiAs(
      principal,
      `/api/admin/merge-recovery/${encodeURIComponent(selectedRecoveryId)}/assessment`,
    );
    if (recoveryResponse.ok) {
      recoveryAssessment =
        (await recoveryResponse.json()) as MergeRecoveryAssessment;
    } else {
      recoveryAssessmentError = await readError(recoveryResponse);
    }
  }

  return (
    <section className="space-y-6">
      <header className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-xl font-semibold text-slate-900">Merge Queue</h2>
        <p className="mt-1 text-sm text-slate-600">
          Preview every affected record before consolidating duplicate contacts.
        </p>
        <div className="mt-4 flex items-center gap-3">
          <form action={scanMergeSuggestionsAction}>
            <input
              type="hidden"
              name="idempotencyKey"
              value={`merge-scan:${randomUUID()}`}
            />
            <SubmitButton
              className="min-h-11 rounded-full border border-slate-300 px-4 py-2 text-xs font-semibold"
              pendingLabel="Scanning..."
            >
              Scan for matches
            </SubmitButton>
          </form>
          <span className="text-xs text-slate-500">
            {queueError
              ? "Queue count unavailable"
              : `${pagination.total} ${activeStatus === "all" ? "total" : activeStatus} match${pagination.total === 1 ? "" : "es"}`}
          </span>
        </div>
      </header>

      {selectedRecoveryId ? (
        <section className="rounded-3xl border-2 border-violet-300 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="font-semibold text-slate-900">
                Merge recovery evidence
              </h3>
              <p className="mt-1 text-sm text-slate-600">
                This is a read-only safety assessment. It never reverses or
                changes records.
              </p>
            </div>
            <a
              href={mergeHref({
                q: queueQuery,
                status: activeStatus,
                offset: activeOffset,
              })}
              className="inline-flex min-h-11 items-center rounded-full border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-700"
            >
              Close evidence
            </a>
          </div>
          {recoveryAssessmentError ? (
            <p
              role="alert"
              className="mt-4 rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-800"
            >
              Recovery evidence is unavailable: {recoveryAssessmentError}. No
              recovery state is being inferred.
            </p>
          ) : recoveryAssessment ? (
            <div className="mt-4 space-y-4">
              <div
                role="status"
                className={`rounded-xl border p-3 text-sm ${
                  recoveryAssessment.assessment.status ===
                  "manual_review_possible"
                    ? "border-amber-300 bg-amber-50 text-amber-950"
                    : "border-red-300 bg-red-50 text-red-950"
                }`}
              >
                <p className="font-semibold">
                  Automatic reversal is disabled ·{" "}
                  {recoveryAssessment.assessment.status.replace(/_/gu, " ")}
                </p>
                <p className="mt-1">{recoveryAssessment.assessment.guidance}</p>
              </div>
              <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <dt className="text-xs text-slate-500">Merged</dt>
                  <dd className="font-semibold text-slate-900">
                    {new Date(
                      recoveryAssessment.ledger.mergedAt,
                    ).toLocaleString()}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500">Actor</dt>
                  <dd className="font-semibold text-slate-900">
                    {recoveryAssessment.ledger.actorLabel ??
                      "Verified team member"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500">Recorded changes</dt>
                  <dd className="font-semibold text-slate-900">
                    {recoveryAssessment.ledger.entryCount}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500">Rule version</dt>
                  <dd className="font-semibold text-slate-900">
                    {recoveryAssessment.ledger.ruleVersion}
                  </dd>
                </div>
              </dl>
              {recoveryAssessment.assessment.blockers.length > 0 ? (
                <div>
                  <h4 className="text-sm font-semibold text-slate-900">
                    Recovery blockers
                  </h4>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
                    {recoveryAssessment.assessment.blockers.map((blocker) => (
                      <li key={blocker}>{blocker}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {recoveryAssessment.changedDependencies.length > 0 ? (
                <div>
                  <h4 className="text-sm font-semibold text-slate-900">
                    Recovery evidence drift
                  </h4>
                  <ul className="mt-2 space-y-2 text-xs text-slate-700">
                    {recoveryAssessment.changedDependencies.map(
                      (dependency) => (
                        <li
                          key={`${dependency.entityType}:${dependency.entityId}`}
                          className="rounded-lg bg-slate-50 p-2"
                        >
                          <span className="font-semibold">
                            {dependency.entityType}
                          </span>{" "}
                          {dependency.entityId}: {dependency.reason} on{" "}
                          {dependency.dependencyKey}; expected owner{" "}
                          {dependency.expectedOwnerContactId ?? "none"}, now{" "}
                          {dependency.actualOwnerContactId ?? "missing"}
                        </li>
                      ),
                    )}
                  </ul>
                </div>
              ) : null}
              <p className="break-all text-[11px] text-slate-500">
                Ledger {recoveryAssessment.ledger.id} · preview{" "}
                {recoveryAssessment.ledger.previewHash}
              </p>
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="font-semibold text-slate-900">Find contacts to merge</h3>
        <p className="mt-1 text-xs text-slate-500">
          Search by name, email, phone, or address, then explicitly choose the
          primary record to keep and the duplicate to consolidate.
        </p>
        <form
          method="get"
          action={teamSurfaceHref("merge")}
          className="mt-4 flex flex-col gap-2 sm:flex-row"
        >
          <input type="hidden" name="mergeQ" value={queueQuery} />
          <input type="hidden" name="mergeStatus" value={activeStatus} />
          {manualSourceId ? (
            <input type="hidden" name="mergeSourceId" value={manualSourceId} />
          ) : null}
          {manualTargetId ? (
            <input type="hidden" name="mergeTargetId" value={manualTargetId} />
          ) : null}
          <label className="flex-1 text-xs text-slate-600">
            Contact search
            <input
              name="mergeContactQ"
              defaultValue={contactSearch}
              minLength={2}
              maxLength={100}
              placeholder="Jordan Smith, jordan@example.com, or 404…"
              className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          <button
            type="submit"
            className="min-h-11 self-end rounded-full border border-primary-300 px-4 py-2 text-xs font-semibold text-primary-800"
          >
            Search contacts
          </button>
        </form>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50/60 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-emerald-800">
              Primary record kept
            </p>
            <p className="mt-1 text-sm font-semibold text-slate-900">
              {manualTarget ? contactLabel(manualTarget) : "Not selected"}
            </p>
            {manualTarget ? (
              <p className="text-xs text-slate-600">
                {manualTarget.email ??
                  manualTarget.phoneE164 ??
                  manualTarget.phone ??
                  "No contact detail"}
              </p>
            ) : null}
          </div>
          <div className="rounded-2xl border border-rose-200 bg-rose-50/60 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-rose-800">
              Duplicate recovery record
            </p>
            <p className="mt-1 text-sm font-semibold text-slate-900">
              {manualSource ? contactLabel(manualSource) : "Not selected"}
            </p>
            {manualSource ? (
              <p className="text-xs text-slate-600">
                {manualSource.email ??
                  manualSource.phoneE164 ??
                  manualSource.phone ??
                  "No contact detail"}
              </p>
            ) : null}
          </div>
        </div>

        {manualSourceId || manualTargetId ? (
          <a
            href={mergeHref({
              q: queueQuery,
              status: activeStatus,
              contactQ: contactSearch,
            })}
            className="mt-3 inline-flex min-h-11 items-center rounded-full border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-700"
          >
            Clear contact selections
          </a>
        ) : null}

        {contactSearchError ? (
          <p
            role="alert"
            className="mt-4 rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-800"
          >
            Contact search failed: {contactSearchError}. Your selections were
            kept; retry the search.
          </p>
        ) : null}
        {contactSearch.length > 0 && contactSearch.length < 2 ? (
          <p className="mt-4 text-sm text-slate-600">
            Enter at least two characters to search contacts.
          </p>
        ) : null}
        {contactSearch.length >= 2 && !contactSearchError ? (
          contactResults.length === 0 ? (
            <p className="mt-4 rounded-xl border border-dashed border-slate-300 p-3 text-sm text-slate-600">
              No contacts match “{contactSearch}”.
            </p>
          ) : (
            <div className="mt-4 space-y-2" aria-label="Contact search results">
              {contactResults.map((contact) => {
                const isTarget = contact.id === manualTargetId;
                const isSource = contact.id === manualSourceId;
                return (
                  <article
                    key={contact.id}
                    className="rounded-2xl border border-slate-200 p-3"
                  >
                    <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
                      <div>
                        <p className="font-semibold text-slate-900">
                          {contactLabel(contact)}
                        </p>
                        <p className="text-xs text-slate-600">
                          {contact.email ?? "No email"} ·{" "}
                          {contact.phoneE164 ?? contact.phone ?? "No phone"}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {isSource ? (
                          <span className="inline-flex min-h-11 items-center rounded-full bg-rose-100 px-3 py-2 text-xs font-semibold text-rose-800">
                            Selected duplicate
                          </span>
                        ) : (
                          <a
                            href={mergeHref({
                              q: queueQuery,
                              status: activeStatus,
                              contactQ: contactSearch,
                              sourceId: contact.id,
                              targetId: manualTargetId,
                            })}
                            aria-disabled={isTarget}
                            className={`inline-flex min-h-11 items-center rounded-full border px-3 py-2 text-xs font-semibold ${
                              isTarget
                                ? "pointer-events-none border-slate-200 text-slate-400"
                                : "border-rose-300 text-rose-800"
                            }`}
                          >
                            Choose duplicate
                          </a>
                        )}
                        {isTarget ? (
                          <span className="inline-flex min-h-11 items-center rounded-full bg-emerald-100 px-3 py-2 text-xs font-semibold text-emerald-800">
                            Selected primary
                          </span>
                        ) : (
                          <a
                            href={mergeHref({
                              q: queueQuery,
                              status: activeStatus,
                              contactQ: contactSearch,
                              sourceId: manualSourceId,
                              targetId: contact.id,
                            })}
                            aria-disabled={isSource}
                            className={`inline-flex min-h-11 items-center rounded-full border px-3 py-2 text-xs font-semibold ${
                              isSource
                                ? "pointer-events-none border-slate-200 text-slate-400"
                                : "border-emerald-300 text-emerald-800"
                            }`}
                          >
                            Choose primary
                          </a>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )
        ) : null}

        {(manualSourceId && !manualSource) ||
        (manualTargetId && !manualTarget) ? (
          <p
            role="alert"
            className="mt-4 rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-800"
          >
            A selected contact is unavailable or you no longer have access.
            Clear the selection and search again.
          </p>
        ) : null}
        {manualPreviewError ? (
          <p
            role="alert"
            className="mt-4 rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-800"
          >
            Merge preview failed: {manualPreviewError}.
          </p>
        ) : null}
        {manualPreview ? (
          <div className="mt-5 space-y-4">
            <PreviewDetails preview={manualPreview} />
            {manualPreview.unresolvedDependencies.length === 0 ? (
              <form action={manualMergeContactsAction} className="space-y-3">
                <input
                  type="hidden"
                  name="idempotencyKey"
                  value={`merge-manual:${randomUUID()}`}
                />
                <input
                  type="hidden"
                  name="sourceContactId"
                  value={manualPreview.source.id}
                />
                <input
                  type="hidden"
                  name="targetContactId"
                  value={manualPreview.target.id}
                />
                <input
                  type="hidden"
                  name="expectedSourceUpdatedAt"
                  value={manualPreview.source.updatedAt}
                />
                <input
                  type="hidden"
                  name="expectedTargetUpdatedAt"
                  value={manualPreview.target.updatedAt}
                />
                <input
                  type="hidden"
                  name="expectedPreviewHash"
                  value={manualPreview.previewHash}
                />
                <label className="block text-xs text-slate-600">
                  Reason (optional)
                  <input
                    name="reason"
                    className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                  />
                </label>
                <label className="block text-xs text-slate-600">
                  Type{" "}
                  <code className="select-all font-semibold">
                    {manualPreview.confirmationText}
                  </code>{" "}
                  to confirm
                  <input
                    name="confirmation"
                    required
                    autoComplete="off"
                    className="mt-1 min-h-11 w-full rounded-xl border border-red-300 px-3 py-2 text-sm"
                  />
                </label>
                <SubmitButton
                  className="min-h-11 rounded-full bg-red-700 px-4 py-2 text-xs font-semibold text-white"
                  pendingLabel="Merging..."
                >
                  Merge and create recovery ledger
                </SubmitButton>
              </form>
            ) : null}
          </div>
        ) : null}
      </section>

      {suggestionPreviewError ? (
        <p
          role="alert"
          className="rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-800"
        >
          Suggested merge preview failed: {suggestionPreviewError}.
        </p>
      ) : null}
      {suggestionPreview ? (
        <section className="rounded-3xl border-2 border-primary-300 bg-white p-5 shadow-sm">
          <h3 className="font-semibold text-slate-900">
            Review suggested merge
          </h3>
          <div className="mt-4">
            <PreviewDetails preview={suggestionPreview.preview} />
          </div>
          {suggestionPreview.preview.unresolvedDependencies.length === 0 ? (
            <form
              action={approveMergeSuggestionAction}
              className="mt-4 space-y-3"
            >
              <input
                type="hidden"
                name="idempotencyKey"
                value={`merge-approve:${suggestionPreview.suggestionId}:${randomUUID()}`}
              />
              <input
                type="hidden"
                name="suggestionId"
                value={suggestionPreview.suggestionId}
              />
              <input
                type="hidden"
                name="expectedUpdatedAt"
                value={suggestionPreview.expectedUpdatedAt}
              />
              <input
                type="hidden"
                name="expectedSourceUpdatedAt"
                value={suggestionPreview.preview.source.updatedAt}
              />
              <input
                type="hidden"
                name="expectedTargetUpdatedAt"
                value={suggestionPreview.preview.target.updatedAt}
              />
              <input
                type="hidden"
                name="expectedPreviewHash"
                value={suggestionPreview.preview.previewHash}
              />
              <input
                type="hidden"
                name="sourceContactId"
                value={suggestionPreview.preview.source.id}
              />
              <input
                type="hidden"
                name="targetContactId"
                value={suggestionPreview.preview.target.id}
              />
              <label className="block text-xs text-slate-600">
                Type{" "}
                <code className="select-all font-semibold">
                  {suggestionPreview.preview.confirmationText}
                </code>{" "}
                to confirm
                <input
                  name="confirmation"
                  required
                  autoComplete="off"
                  className="mt-1 min-h-11 w-full rounded-xl border border-red-300 px-3 py-2 text-sm"
                />
              </label>
              <SubmitButton
                className="min-h-11 rounded-full bg-red-700 px-4 py-2 text-xs font-semibold text-white"
                pendingLabel="Merging..."
              >
                Approve merge and recovery ledger
              </SubmitButton>
            </form>
          ) : null}
        </section>
      ) : null}

      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="font-semibold text-slate-900">Review queue</h3>
        <form
          method="get"
          action={teamSurfaceHref("merge")}
          className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem_auto]"
        >
          <label className="text-xs text-slate-600">
            Search either contact
            <input
              name="mergeQ"
              defaultValue={queueQuery}
              maxLength={100}
              placeholder="Name, email, or phone"
              className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="text-xs text-slate-600">
            Decision status
            <select
              name="mergeStatus"
              defaultValue={activeStatus}
              className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="declined">Declined</option>
              <option value="all">All decisions</option>
            </select>
          </label>
          <button
            type="submit"
            className="min-h-11 self-end rounded-full bg-slate-900 px-4 py-2 text-xs font-semibold text-white"
          >
            Apply filters
          </button>
        </form>
        {queueQuery || activeStatus !== "pending" ? (
          <a
            href={teamSurfaceHref("merge")}
            className="mt-3 inline-flex min-h-11 items-center rounded-full border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-700"
          >
            Clear queue filters
          </a>
        ) : null}
      </section>

      {queueError ? (
        <div
          role="alert"
          className="rounded-2xl border border-red-300 bg-red-50 p-4 text-sm text-red-900"
        >
          <p className="font-semibold">The merge queue is unavailable.</p>
          <p className="mt-1">
            {queueError}. No empty result is being inferred.
          </p>
          <a
            href={mergeHref({ q: queueQuery, status: activeStatus })}
            className="mt-3 inline-flex min-h-11 items-center rounded-full border border-red-300 px-4 py-2 text-xs font-semibold"
          >
            Retry queue
          </a>
        </div>
      ) : null}

      {!queueError && suggestions.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-5 text-sm text-slate-500">
          No {activeStatus === "all" ? "" : `${activeStatus} `}merge suggestions
          match{queueQuery ? ` “${queueQuery}”` : ""}.
        </div>
      ) : !queueError ? (
        <div className="space-y-3">
          {suggestions.map((suggestion) => (
            <article
              key={suggestion.id}
              className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="font-semibold text-slate-900">
                    {suggestion.sourceContact?.name ?? "Unknown duplicate"} →{" "}
                    {suggestion.targetContact?.name ?? "Unknown primary"}
                  </h3>
                  <p className="text-xs text-slate-500">
                    {formatReason(suggestion.reason)} · {suggestion.confidence}%
                    confidence
                  </p>
                  <p className="mt-1 text-xs text-slate-600">
                    Duplicate:{" "}
                    {suggestion.sourceContact?.email ??
                      suggestion.sourceContact?.phone ??
                      "No contact detail"}
                    {" · "}Primary:{" "}
                    {suggestion.targetContact?.email ??
                      suggestion.targetContact?.phone ??
                      "No contact detail"}
                  </p>
                  <span className="mt-2 inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-700">
                    {suggestion.status}
                  </span>
                </div>
                {suggestion.status === "pending" ? (
                  <div className="flex flex-wrap gap-2">
                    <a
                      href={mergeHref({
                        q: queueQuery,
                        status: activeStatus,
                        offset: activeOffset,
                        suggestionId: suggestion.id,
                      })}
                      className="inline-flex min-h-11 items-center rounded-full bg-primary-600 px-4 py-2 text-xs font-semibold text-white"
                    >
                      Review preview
                    </a>
                    <form action={declineMergeSuggestionAction}>
                      <input
                        type="hidden"
                        name="idempotencyKey"
                        value={`merge-decline:${suggestion.id}:${randomUUID()}`}
                      />
                      <input
                        type="hidden"
                        name="suggestionId"
                        value={suggestion.id}
                      />
                      <input
                        type="hidden"
                        name="expectedUpdatedAt"
                        value={suggestion.updatedAt}
                      />
                      <SubmitButton
                        className="min-h-11 rounded-full border border-slate-300 px-4 py-2 text-xs font-semibold"
                        pendingLabel="Declining..."
                      >
                        Decline
                      </SubmitButton>
                    </form>
                  </div>
                ) : suggestion.status === "approved" &&
                  suggestion.recoveryLedgerId ? (
                  <a
                    href={mergeHref({
                      q: queueQuery,
                      status: activeStatus,
                      offset: activeOffset,
                      recoveryId: suggestion.recoveryLedgerId,
                    })}
                    className="inline-flex min-h-11 items-center rounded-full border border-violet-300 px-4 py-2 text-xs font-semibold text-violet-800"
                  >
                    Review recovery evidence
                  </a>
                ) : null}
              </div>
            </article>
          ))}

          {pagination.offset > 0 || pagination.nextOffset !== null ? (
            <nav
              aria-label="Merge queue pages"
              className="flex flex-wrap items-center justify-between gap-3 pt-2"
            >
              <span className="text-xs text-slate-500">
                Showing {pagination.offset + 1}–
                {Math.min(
                  pagination.offset + suggestions.length,
                  pagination.total,
                )}{" "}
                of {pagination.total}
              </span>
              <div className="flex gap-2">
                {pagination.offset > 0 ? (
                  <a
                    href={mergeHref({
                      q: queueQuery,
                      status: activeStatus,
                      offset: Math.max(0, pagination.offset - pagination.limit),
                    })}
                    className="inline-flex min-h-11 items-center rounded-full border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-700"
                  >
                    Previous
                  </a>
                ) : null}
                {pagination.nextOffset !== null ? (
                  <a
                    href={mergeHref({
                      q: queueQuery,
                      status: activeStatus,
                      offset: pagination.nextOffset,
                    })}
                    className="inline-flex min-h-11 items-center rounded-full border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-700"
                  >
                    Next
                  </a>
                ) : null}
              </div>
            </nav>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
