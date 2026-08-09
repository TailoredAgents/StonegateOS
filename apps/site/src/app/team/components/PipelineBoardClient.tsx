"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import {
  ArrowRight,
  BookmarkPlus,
  FileText,
  LayoutGrid,
  List,
  Search,
  Trash2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { TEAM_TIME_ZONE } from "../lib/timezone";
import { quoteWorkspaceHref } from "../quotes-workspace";
import { teamSurfaceHref } from "../surface-registry";
import {
  parsePipelinePresetCreateResult,
  parsePipelinePresetDeleteResult,
  readBoundedPipelinePresetMutationPayload,
  type PipelineFilterPreset,
  type PipelinePresetInventoryState,
} from "../pipeline-presets";
import {
  findPipelineContact,
  movePipelineContact,
  normalizePipelineBoard,
  sortPipelineContacts,
} from "./pipeline-board-state";
import {
  buildPipelineHref,
  type PipelineHrefState,
} from "./pipeline-navigation";
import {
  pipelineExpectedVersion,
  PipelineStageRequestError,
  requestPipelineStageMutation,
  type PipelineStageState,
} from "../lib/pipeline-stage-mutation";
import type {
  PipelineContact,
  PipelineLane,
  PipelineResponse,
  PipelineView,
} from "./pipeline.types";
import {
  PIPELINE_STAGES,
  type PipelineStage,
  labelForPipelineStage,
  themeForPipelineStage,
} from "./pipeline.stages";
import { TEAM_INPUT, TEAM_SELECT, teamButtonClass } from "./team-ui";

function formatShortDate(iso: string | null): string {
  if (!iso) return "No recent activity";
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "No recent activity";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TEAM_TIME_ZONE,
    month: "short",
    day: "numeric",
  }).format(new Date(time));
}

type PipelineBoardClientProps = {
  stages: string[];
  lanes: PipelineLane[];
  stageCounts: Record<string, number>;
  pagination: PipelineResponse["pagination"];
  filters: PipelineResponse["filters"];
  view: PipelineView;
  selectedContactId?: string | null;
  actorId: string;
  presetState: PipelinePresetInventoryState;
};

function normalizedPresetName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

function presetMutationMessage(result: {
  message: string;
  fieldErrors?: Record<string, string>;
}): string {
  const fieldMessage = result.fieldErrors
    ? Object.values(result.fieldErrors)[0]
    : null;
  return fieldMessage ? `${result.message} ${fieldMessage}` : result.message;
}

function presetStage(value: string | null): PipelineStage | null {
  return value && PIPELINE_STAGES.includes(value as PipelineStage)
    ? (value as PipelineStage)
    : null;
}

async function persistPipelineStage(
  actorId: string,
  contactId: string,
  stage: string,
  previousStage: string,
  expectedUpdatedAt: string | null,
  idempotencyKey: string,
): Promise<PipelineStageState & { updatedAt: string }> {
  const expectedVersion = pipelineExpectedVersion(expectedUpdatedAt);
  const success = await requestPipelineStageMutation(
    () =>
      fetch("/api/team/contacts/pipeline", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
          "If-Match": `"${expectedVersion}"`,
        },
        body: JSON.stringify({ contactId, stage, previousStage }),
      }),
    {
      actorId,
      contactId,
      stage,
      previousStage,
      submittedVersion: expectedVersion,
    },
  );
  return success.data.pipeline;
}

export default function PipelineBoardClient({
  stages,
  lanes,
  stageCounts,
  pagination,
  filters,
  view,
  selectedContactId,
  actorId,
  presetState,
}: PipelineBoardClientProps) {
  const router = useRouter();
  const [isNavigating, startNavigation] = useTransition();
  const [board, setBoard] = useState<PipelineLane[]>(() =>
    normalizePipelineBoard(lanes),
  );
  const [dragging, setDragging] = useState<{
    id: string;
    stage: string;
  } | null>(null);
  const [hoverStage, setHoverStage] = useState<string | null>(null);
  const [pendingContactIds, setPendingContactIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [isMobileViewport, setIsMobileViewport] = useState(false);
  const [mobileStage, setMobileStage] = useState<string>(
    () => filters.stage ?? stages[0] ?? "",
  );
  const [draftQuery, setDraftQuery] = useState(filters.q);
  const [presetName, setPresetName] = useState("");
  const [pendingPresetOperation, setPendingPresetOperation] = useState<
    string | null
  >(null);
  const [presetError, setPresetError] = useState<string | null>(null);
  const [presetNotice, setPresetNotice] = useState<string | null>(null);
  const createPresetRetryRef = useRef<{
    fingerprint: string;
    idempotencyKey: string;
  } | null>(null);
  const deletePresetRetryRef = useRef<{
    fingerprint: string;
    idempotencyKey: string;
  } | null>(null);

  useEffect(() => {
    setBoard(normalizePipelineBoard(lanes));
  }, [lanes]);

  useEffect(() => {
    setDraftQuery(filters.q);
  }, [filters.q]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const media = window.matchMedia("(max-width: 1023px)");
    const syncViewport = (event?: MediaQueryList | MediaQueryListEvent) => {
      setIsMobileViewport(event?.matches ?? media.matches);
    };
    syncViewport(media);
    const listener = (event: MediaQueryListEvent) => syncViewport(event);
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, []);

  useEffect(() => {
    setMobileStage((current) => {
      if (filters.stage && stages.includes(filters.stage)) {
        return filters.stage;
      }
      if (current && stages.includes(current)) return current;
      return stages[0] ?? "";
    });
  }, [filters.stage, stages]);

  useEffect(() => {
    if (!selectedContactId) return;
    const selectedStage = board.find((lane) =>
      lane.contacts.some((contact) => contact.id === selectedContactId),
    )?.stage;
    if (selectedStage) {
      setMobileStage(selectedStage);
    }
  }, [board, selectedContactId]);

  function setContactPending(contactId: string, pending: boolean) {
    setPendingContactIds((current) => {
      const next = new Set(current);
      if (pending) next.add(contactId);
      else next.delete(contactId);
      return next;
    });
  }

  function navigate(next: Partial<PipelineHrefState>) {
    const href = buildPipelineHref({
      q: filters.q,
      stage: filters.stage,
      offset: pagination.offset,
      view,
      excludeOutbound: filters.excludeOutbound,
      contactId: selectedContactId,
      ...next,
    });
    startNavigation(() => router.push(href));
  }

  function applyPreset(preset: PipelineFilterPreset) {
    setDraftQuery(preset.q);
    setPresetError(null);
    setPresetNotice(`Applied ${preset.name}.`);
    navigate({
      q: preset.q,
      stage: preset.stage,
      excludeOutbound: preset.excludeOutbound,
      view: preset.view,
      offset: 0,
      contactId: null,
    });
  }

  async function createPreset(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pendingPresetOperation || presetState.status !== "ready") return;
    if (presetState.presets.length >= presetState.limit) {
      setPresetError(
        `You can save up to ${presetState.limit} filters. Delete one first.`,
      );
      return;
    }
    const name = normalizedPresetName(presetName);
    const input = {
      name,
      q: filters.q,
      stage: presetStage(filters.stage),
      excludeOutbound: filters.excludeOutbound,
      view,
    };
    const fingerprint = JSON.stringify(input);
    if (createPresetRetryRef.current?.fingerprint !== fingerprint) {
      createPresetRetryRef.current = {
        fingerprint,
        idempotencyKey: `pipeline-preset-create:${globalThis.crypto.randomUUID()}`,
      };
    }
    const idempotencyKey = createPresetRetryRef.current.idempotencyKey;
    setPendingPresetOperation("create");
    setPresetError(null);
    setPresetNotice(null);
    try {
      const response = await fetch("/api/team/pipeline/presets", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(input),
      });
      const payload = await readBoundedPipelinePresetMutationPayload(response);
      const result = parsePipelinePresetCreateResult(
        payload,
        response.headers,
        {
          actorId,
          ...input,
        },
      );
      if (
        !result ||
        (result.ok && response.status !== 201) ||
        (!result.ok && response.ok)
      ) {
        throw new Error(
          "The saved-filter response was incomplete. Refresh before retrying.",
        );
      }
      if (!result.ok) {
        if (!result.retryable) createPresetRetryRef.current = null;
        throw new Error(presetMutationMessage(result));
      }
      createPresetRetryRef.current = null;
      setPresetName("");
      setPresetNotice(`Saved ${result.data.preset.name}.`);
      router.refresh();
    } catch (error) {
      setPresetError(
        error instanceof Error
          ? error.message
          : "The pipeline filter could not be saved.",
      );
    } finally {
      setPendingPresetOperation(null);
    }
  }

  async function deletePreset(preset: PipelineFilterPreset) {
    if (pendingPresetOperation) return;
    if (
      !window.confirm(
        `Delete the saved pipeline filter “${preset.name}”? This only removes your preset.`,
      )
    ) {
      return;
    }
    setPendingPresetOperation(preset.id);
    setPresetError(null);
    setPresetNotice(null);
    const fingerprint = `${preset.id}:${preset.version}`;
    if (deletePresetRetryRef.current?.fingerprint !== fingerprint) {
      deletePresetRetryRef.current = {
        fingerprint,
        idempotencyKey: `pipeline-preset-delete:${globalThis.crypto.randomUUID()}`,
      };
    }
    const idempotencyKey = deletePresetRetryRef.current.idempotencyKey;
    try {
      const response = await fetch(
        `/api/team/pipeline/presets/${encodeURIComponent(preset.id)}`,
        {
          method: "DELETE",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
            "If-Match": String(preset.version),
          },
          body: JSON.stringify({ expectedVersion: preset.version }),
        },
      );
      const payload = await readBoundedPipelinePresetMutationPayload(response);
      const result = parsePipelinePresetDeleteResult(
        payload,
        response.headers,
        {
          actorId,
          presetId: preset.id,
          version: preset.version,
        },
      );
      if (
        !result ||
        (result.ok && response.status !== 200) ||
        (!result.ok && response.ok)
      ) {
        throw new Error(
          "The delete response was incomplete. Refresh before retrying.",
        );
      }
      if (!result.ok) {
        if (!result.retryable) deletePresetRetryRef.current = null;
        throw new Error(presetMutationMessage(result));
      }
      deletePresetRetryRef.current = null;
      setPresetNotice(`Deleted ${preset.name}.`);
      router.refresh();
    } catch (error) {
      setPresetError(
        error instanceof Error
          ? error.message
          : "The saved pipeline filter could not be deleted.",
      );
    } finally {
      setPendingPresetOperation(null);
    }
  }

  async function updateStage(contactId: string, targetStage: string) {
    if (pendingContactIds.has(contactId)) return;
    const contact = findPipelineContact(board, contactId);
    if (!contact || contact.pipeline.stage === targetStage) return;

    const previousStage = contact.pipeline.stage;
    const previousUpdatedAt = contact.pipeline.updatedAt;
    const submittedVersion = pipelineExpectedVersion(previousUpdatedAt);
    const idempotencyKey = `pipeline-stage:${contactId}:${submittedVersion}:${targetStage}`;
    setBoard((current) =>
      movePipelineContact(current, contactId, targetStage, previousUpdatedAt),
    );
    setSaveError(null);
    setSaveNotice(null);
    setContactPending(contactId, true);

    try {
      const saved = await persistPipelineStage(
        actorId,
        contactId,
        targetStage,
        previousStage,
        previousUpdatedAt,
        idempotencyKey,
      );
      setBoard((current) =>
        movePipelineContact(current, contactId, saved.stage, saved.updatedAt),
      );
      setSaveNotice(
        `${contact.firstName} ${contact.lastName} moved to ${labelForPipelineStage(saved.stage)}.`,
      );
      router.refresh();
    } catch (error) {
      if (
        error instanceof PipelineStageRequestError &&
        error.status === 409 &&
        error.current &&
        stages.includes(error.current.stage)
      ) {
        setBoard((current) =>
          movePipelineContact(
            current,
            contactId,
            error.current?.stage ?? previousStage,
            error.current?.updatedAt ?? null,
          ),
        );
        setSaveError(error.message);
        router.refresh();
      } else {
        setBoard((current) =>
          movePipelineContact(
            current,
            contactId,
            previousStage,
            previousUpdatedAt,
          ),
        );
        setSaveError(
          error instanceof Error ? error.message : "Unable to update stage.",
        );
      }
    } finally {
      setContactPending(contactId, false);
    }
  }

  async function handleDrop(
    event: React.DragEvent<HTMLDivElement>,
    stage: string,
  ) {
    event.preventDefault();
    setHoverStage(null);

    let contactId: string | null = null;
    try {
      const raw = event.dataTransfer.getData("application/json");
      if (raw) {
        const parsed = JSON.parse(raw) as { contactId?: string };
        contactId = parsed.contactId ?? null;
      }
    } catch {
      // ignore
    }

    if (!contactId && dragging) contactId = dragging.id;

    if (!contactId || dragging?.stage === stage) return;

    setDragging(null);
    await updateStage(contactId, stage);
  }

  function handleDragOver(
    event: React.DragEvent<HTMLDivElement>,
    stage: string,
  ) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setHoverStage(stage);
  }

  function handleDragStart(
    contact: PipelineContact,
    stage: string,
    event: React.DragEvent<HTMLDivElement>,
  ) {
    if (pendingContactIds.has(contact.id)) {
      event.preventDefault();
      return;
    }
    setDragging({ id: contact.id, stage });
    try {
      event.dataTransfer.setData(
        "application/json",
        JSON.stringify({ contactId: contact.id }),
      );
      event.dataTransfer.effectAllowed = "move";
    } catch {
      // ignore
    }
  }

  function handleDragEnd() {
    setDragging(null);
    setHoverStage(null);
  }

  function selectContact(contactId: string) {
    navigate({ contactId });
  }

  const boardStages = filters.stage
    ? stages.filter((stage) => stage === filters.stage)
    : stages;
  const renderedStages = isMobileViewport
    ? boardStages.filter((stage) => stage === mobileStage)
    : boardStages;
  const visibleContacts = sortPipelineContacts(
    board
      .flatMap((lane) => lane.contacts)
      .filter(
        (contact) => !filters.stage || contact.pipeline.stage === filters.stage,
      ),
  );
  const firstVisible =
    pagination.total === 0
      ? 0
      : Math.min(pagination.offset + 1, pagination.total);
  const lastVisible = Math.min(
    pagination.offset + visibleContacts.length,
    pagination.total,
  );

  return (
    <div
      className="min-w-0 space-y-4 pb-6"
      aria-busy={isNavigating || pendingContactIds.size > 0}
    >
      <div className="rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-card)] p-4 shadow-sm">
        <div className="grid gap-3 xl:grid-cols-[minmax(240px,1fr)_200px_180px_auto] xl:items-end">
          <form
            className="flex min-w-0 gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              navigate({ q: draftQuery.trim(), offset: 0 });
            }}
          >
            <label className="min-w-0 flex-1 text-xs font-semibold text-[color:var(--team-text-muted)]">
              <span className="mb-1 block">Search pipeline</span>
              <span className="relative block">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--team-text-soft)]"
                  aria-hidden="true"
                />
                <input
                  className={`${TEAM_INPUT} min-h-11 w-full pl-10`}
                  type="search"
                  value={draftQuery}
                  onChange={(event) => setDraftQuery(event.target.value)}
                  placeholder="Name, phone, or email"
                  maxLength={120}
                />
              </span>
            </label>
            <button
              type="submit"
              className={`${teamButtonClass("primary", "sm")} self-end min-h-11`}
              disabled={isNavigating}
            >
              Search
            </button>
          </form>

          <label className="text-xs font-semibold text-[color:var(--team-text-muted)]">
            <span className="mb-1 block">Stage</span>
            <select
              className={`${TEAM_SELECT} min-h-11 w-full`}
              value={filters.stage ?? ""}
              disabled={isNavigating}
              onChange={(event) =>
                navigate({ stage: event.target.value || null, offset: 0 })
              }
            >
              <option value="">All stages</option>
              {stages.map((stage) => (
                <option key={stage} value={stage}>
                  {labelForPipelineStage(stage)} ({stageCounts[stage] ?? 0})
                </option>
              ))}
            </select>
          </label>

          <label className="flex min-h-11 items-center gap-3 rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] px-3 text-xs font-semibold text-[color:var(--team-text-muted)]">
            <input
              type="checkbox"
              className="h-5 w-5 rounded border-[color:var(--team-border-strong)]"
              checked={!filters.excludeOutbound}
              disabled={isNavigating}
              onChange={(event) =>
                navigate({
                  excludeOutbound: !event.target.checked,
                  offset: 0,
                })
              }
            />
            Include outbound contacts
          </label>

          <div
            className="flex min-h-11 rounded-full border border-[color:var(--team-border)] bg-[color:var(--team-surface)] p-1"
            role="group"
            aria-label="Pipeline view"
          >
            <button
              type="button"
              className={`flex min-h-11 items-center gap-2 rounded-full px-3 text-xs font-semibold ${
                view === "board"
                  ? "bg-primary-600 text-white"
                  : "text-[color:var(--team-text-muted)]"
              }`}
              aria-pressed={view === "board"}
              onClick={() => navigate({ view: "board", offset: 0 })}
            >
              <LayoutGrid className="h-4 w-4" aria-hidden="true" />
              Board
            </button>
            <button
              type="button"
              className={`flex min-h-11 items-center gap-2 rounded-full px-3 text-xs font-semibold ${
                view === "list"
                  ? "bg-primary-600 text-white"
                  : "text-[color:var(--team-text-muted)]"
              }`}
              aria-pressed={view === "list"}
              onClick={() => navigate({ view: "list", offset: 0 })}
            >
              <List className="h-4 w-4" aria-hidden="true" />
              List
            </button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-[color:var(--team-text-muted)]">
          <p aria-live="polite">
            Showing {firstVisible}–{lastVisible} of {pagination.total}
            {filters.stage
              ? ` in ${labelForPipelineStage(filters.stage)}`
              : " contacts"}
            {filters.q ? ` matching “${filters.q}”` : ""}.
          </p>
          {filters.q || filters.stage || !filters.excludeOutbound ? (
            <button
              type="button"
              className={`${teamButtonClass("secondary", "sm")} min-h-11`}
              onClick={() => {
                setDraftQuery("");
                navigate({
                  q: "",
                  stage: null,
                  excludeOutbound: true,
                  offset: 0,
                });
              }}
            >
              Clear filters
            </button>
          ) : null}
        </div>
      </div>

      <section
        className="rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-card)] p-4 shadow-sm"
        aria-labelledby="pipeline-saved-filter-heading"
        aria-busy={pendingPresetOperation !== null}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3
              id="pipeline-saved-filter-heading"
              className="text-sm font-semibold text-[color:var(--team-text)]"
            >
              My saved filters
            </h3>
            <p className="mt-1 text-xs text-[color:var(--team-text-muted)]">
              Save this search, stage, outbound setting, and view for one-click
              reuse.
            </p>
          </div>
          {presetState.status === "ready" ? (
            <span className="rounded-full bg-[color:var(--team-surface-muted)] px-3 py-1 text-xs font-semibold text-[color:var(--team-text-muted)]">
              {presetState.presets.length}/{presetState.limit}
            </span>
          ) : null}
        </div>

        {presetState.status === "error" ? (
          <div
            className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[color:var(--team-danger-border)] bg-[color:var(--team-danger-surface)] p-3 text-xs font-semibold text-[color:var(--team-danger-text)]"
            role="alert"
          >
            <span>{presetState.message}</span>
            <button
              type="button"
              className={`${teamButtonClass("secondary", "sm")} min-h-11`}
              onClick={() => router.refresh()}
            >
              Retry
            </button>
          </div>
        ) : (
          <>
            <form
              className="mt-3 grid gap-2 sm:grid-cols-[minmax(180px,320px)_auto] sm:items-end"
              onSubmit={(event) => void createPreset(event)}
            >
              <label className="text-xs font-semibold text-[color:var(--team-text-muted)]">
                <span className="mb-1 block">Preset name</span>
                <input
                  className={`${TEAM_INPUT} min-h-11 w-full`}
                  value={presetName}
                  onChange={(event) => setPresetName(event.target.value)}
                  required
                  minLength={1}
                  maxLength={60}
                  pattern="[A-Za-z0-9][A-Za-z0-9 &'(),./_-]{0,59}"
                  placeholder="Example: Hot inbound leads"
                  autoComplete="off"
                />
              </label>
              <button
                type="submit"
                className={`${teamButtonClass("primary", "sm")} min-h-11 gap-2`}
                disabled={
                  pendingPresetOperation !== null ||
                  presetState.presets.length >= presetState.limit
                }
              >
                <BookmarkPlus className="h-4 w-4" aria-hidden="true" />
                {pendingPresetOperation === "create"
                  ? "Saving…"
                  : "Save current filter"}
              </button>
            </form>

            {presetState.presets.length === 0 ? (
              <p className="mt-3 rounded-xl border border-dashed border-[color:var(--team-border)] p-3 text-xs text-[color:var(--team-text-muted)]">
                No saved filters yet. Name the current pipeline setup to save
                your first preset.
              </p>
            ) : (
              <ul className="mt-3 grid gap-2 md:grid-cols-2">
                {presetState.presets.map((preset) => {
                  const isCurrent =
                    preset.q === filters.q &&
                    preset.stage === presetStage(filters.stage) &&
                    preset.excludeOutbound === filters.excludeOutbound &&
                    preset.view === view;
                  return (
                    <li
                      key={preset.id}
                      className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface-muted)] p-2"
                    >
                      <div className="min-w-0 px-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-xs font-semibold text-[color:var(--team-text)]">
                            {preset.name}
                          </span>
                          {isCurrent ? (
                            <span className="rounded-full bg-primary-100 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-primary-700">
                              Active
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-0.5 truncate text-[10px] text-[color:var(--team-text-soft)]">
                          {preset.stage
                            ? labelForPipelineStage(preset.stage)
                            : "All stages"}
                          {preset.q ? ` · “${preset.q}”` : ""} ·{` `}
                          {preset.excludeOutbound
                            ? "Inbound only"
                            : "Includes outbound"}{" "}
                          · {preset.view}
                        </p>
                      </div>
                      <div className="flex min-w-0 flex-1 gap-2 sm:flex-none">
                        <button
                          type="button"
                          className={`${teamButtonClass("secondary", "sm")} min-h-11 flex-1 sm:flex-none`}
                          disabled={
                            pendingPresetOperation !== null || isCurrent
                          }
                          onClick={() => applyPreset(preset)}
                        >
                          {isCurrent ? "Applied" : "Apply"}
                        </button>
                        <button
                          type="button"
                          className={`${teamButtonClass("danger", "sm")} min-h-11 gap-2`}
                          aria-label={
                            pendingPresetOperation === preset.id
                              ? `Deleting saved filter ${preset.name}`
                              : `Delete saved filter ${preset.name}`
                          }
                          disabled={pendingPresetOperation !== null}
                          onClick={() => void deletePreset(preset)}
                        >
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                          <span className="sr-only sm:not-sr-only">
                            {pendingPresetOperation === preset.id
                              ? "Deleting…"
                              : "Delete"}
                          </span>
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}

        <div className="mt-3 min-h-5" aria-live="polite" aria-atomic="true">
          {presetError ? (
            <p className="text-xs font-semibold text-[color:var(--team-danger-text)]">
              {presetError}
            </p>
          ) : presetNotice ? (
            <p className="text-xs font-semibold text-[color:var(--team-success-text)]">
              {presetNotice}
            </p>
          ) : null}
        </div>
      </section>

      {view === "board" && isMobileViewport && !filters.stage ? (
        <div className="mb-4 flex gap-2 overflow-x-auto pb-1">
          {stages.map((stage) => (
            <button
              key={stage}
              type="button"
              aria-pressed={mobileStage === stage}
              onClick={() => setMobileStage(stage)}
              className={`min-h-11 shrink-0 rounded-full px-3 py-2 text-xs font-semibold transition ${
                mobileStage === stage
                  ? "bg-primary-600 text-white"
                  : "border border-slate-200 bg-white text-slate-700"
              }`}
            >
              {labelForPipelineStage(stage)} ({stageCounts[stage] ?? 0})
            </button>
          ))}
        </div>
      ) : null}
      {view === "board" ? (
        <div
          className={
            renderedStages.length === 1
              ? "grid min-w-0 grid-cols-1 gap-4 pb-2"
              : "grid auto-cols-[minmax(84vw,84vw)] grid-flow-col gap-4 overflow-x-auto pb-2 sm:auto-cols-[minmax(280px,320px)] sm:gap-5"
          }
          role="region"
          tabIndex={renderedStages.length > 1 ? 0 : undefined}
          aria-label="Pipeline board. Use the stage picker on each contact for keyboard movement."
        >
          {renderedStages.map((stage) => {
            const lane = board.find((item) => item.stage === stage) ?? {
              stage,
              contacts: [],
            };
            const isHover = hoverStage === stage;
            const laneTheme = themeForPipelineStage(stage);
            return (
              <section
                key={stage}
                onDragOver={(event: React.DragEvent<HTMLDivElement>) =>
                  handleDragOver(event, stage)
                }
                onDrop={(event: React.DragEvent<HTMLDivElement>) => {
                  void handleDrop(event, stage);
                }}
                onDragLeave={(event: React.DragEvent<HTMLDivElement>) => {
                  if (
                    !event.currentTarget.contains(event.relatedTarget as Node)
                  ) {
                    setHoverStage(null);
                  }
                }}
                className={`group flex h-[min(68dvh,560px)] min-h-[340px] flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white/80 shadow-xl shadow-slate-200/60 transition sm:h-[min(720px,calc(100vh-18rem))] ${
                  isHover ? "border-primary-400 ring-2 ring-primary-200/60" : ""
                }`}
              >
                <header className="flex items-center justify-between gap-3 rounded-t-3xl border-b border-slate-200/60 bg-white/90 px-5 py-4">
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                    <span
                      className={`h-2.5 w-2.5 rounded-full ${laneTheme.dot}`}
                    />
                    {labelForPipelineStage(stage)}
                  </div>
                  <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-500">
                    {lane.contacts.length} of {stageCounts[stage] ?? 0}
                  </span>
                </header>
                <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-5 py-4">
                  {lane.contacts.length === 0 ? (
                    <p className="rounded-2xl border border-dashed border-slate-200 bg-white/85 px-4 py-8 text-center text-xs text-slate-400">
                      Drop a contact here or use the stage picker.
                    </p>
                  ) : (
                    lane.contacts.map((contact) => {
                      const theme = themeForPipelineStage(
                        contact.pipeline.stage,
                      );
                      const isSelected = selectedContactId === contact.id;
                      return (
                        <article
                          key={contact.id}
                          draggable={!pendingContactIds.has(contact.id)}
                          aria-busy={pendingContactIds.has(contact.id)}
                          onDragStart={(
                            event: React.DragEvent<HTMLDivElement>,
                          ) => handleDragStart(contact, stage, event)}
                          onDragEnd={handleDragEnd}
                          className={`rounded-2xl border px-4 py-4 text-xs shadow-sm transition hover:shadow-md ${
                            pendingContactIds.has(contact.id)
                              ? "cursor-wait"
                              : "cursor-grab"
                          } ${
                            dragging?.id === contact.id ? "opacity-60" : ""
                          } ${theme.cardBorder} ${theme.cardBackground} ${isSelected ? "ring-2 ring-primary-300" : ""}`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="space-y-1">
                              <button
                                type="button"
                                className="min-h-11 text-left text-sm font-semibold leading-tight text-slate-900 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
                                aria-current={isSelected ? "true" : undefined}
                                onClick={() => selectContact(contact.id)}
                              >
                                {contact.firstName} {contact.lastName}
                              </button>
                              <p className="text-[11px] text-slate-500">
                                Updated{" "}
                                {formatShortDate(contact.lastActivityAt)} -{" "}
                                {contact.notesCount} notes
                              </p>
                            </div>
                            <span
                              className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${theme.badge}`}
                            >
                              {labelForPipelineStage(contact.pipeline.stage)}
                            </span>
                          </div>
                          {contact.property?.outOfArea ? (
                            <span className="mt-2 inline-flex rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-rose-700">
                              Out of area
                            </span>
                          ) : null}
                          {contact.property ? (
                            <p className="mt-3 text-[11px] text-slate-600">
                              {contact.property.addressLine1},{" "}
                              {contact.property.city}
                            </p>
                          ) : null}
                          <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
                            <a
                              className={`${teamButtonClass("secondary", "sm")} min-h-11 gap-2`}
                              href={teamSurfaceHref("contacts", {
                                query: { contactId: contact.id },
                              })}
                              onClick={(event) => event.stopPropagation()}
                            >
                              <ArrowRight
                                className="h-4 w-4"
                                aria-hidden="true"
                              />
                              View contact
                            </a>
                            <a
                              className={`${teamButtonClass("secondary", "sm")} min-h-11 gap-2`}
                              href={quoteWorkspaceHref("create", {
                                query: {
                                  contactId: contact.id,
                                },
                              })}
                              onClick={(event) => event.stopPropagation()}
                            >
                              <FileText
                                className="h-4 w-4"
                                aria-hidden="true"
                              />
                              Create quote
                            </a>
                          </div>
                          <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
                            <label className="flex items-center gap-2">
                              <span className="sr-only">
                                Move {contact.firstName} {contact.lastName} to
                                pipeline stage
                              </span>
                              <select
                                value={contact.pipeline.stage}
                                className={`${TEAM_SELECT} min-h-11`}
                                aria-label={`Move ${contact.firstName} ${contact.lastName} to pipeline stage`}
                                disabled={pendingContactIds.has(contact.id)}
                                onClick={(event) => event.stopPropagation()}
                                onChange={(event) => {
                                  event.stopPropagation();
                                  const nextStage = event.target.value;
                                  void updateStage(contact.id, nextStage);
                                }}
                              >
                                {stages.map((option) => (
                                  <option key={option} value={option}>
                                    {labelForPipelineStage(option)}
                                  </option>
                                ))}
                              </select>
                            </label>
                            {pendingContactIds.has(contact.id) ? (
                              <span className="text-xs text-slate-500">
                                Saving…
                              </span>
                            ) : null}
                          </div>
                        </article>
                      );
                    })
                  )}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <ul className="grid min-w-0 gap-3" aria-label="Pipeline contacts">
          {visibleContacts.map((contact) => {
            const theme = themeForPipelineStage(contact.pipeline.stage);
            const isPending = pendingContactIds.has(contact.id);
            return (
              <li
                key={contact.id}
                className={`grid min-w-0 gap-4 rounded-2xl border p-4 shadow-sm md:grid-cols-[minmax(180px,1.3fr)_minmax(160px,1fr)_auto] md:items-center ${theme.cardBorder} ${theme.cardBackground} ${
                  selectedContactId === contact.id
                    ? "ring-2 ring-primary-300"
                    : ""
                }`}
                aria-busy={isPending}
              >
                <div className="min-w-0">
                  <button
                    type="button"
                    className="block min-h-11 max-w-full truncate text-left text-sm font-semibold text-slate-900 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
                    aria-current={
                      selectedContactId === contact.id ? "true" : undefined
                    }
                    onClick={() => selectContact(contact.id)}
                  >
                    {contact.firstName} {contact.lastName}
                  </button>
                  <p className="mt-1 text-xs text-slate-500">
                    Updated {formatShortDate(contact.lastActivityAt)} ·{" "}
                    {contact.notesCount} notes · {contact.stats.quotes} quotes
                  </p>
                  {contact.property ? (
                    <p className="mt-1 truncate text-xs text-slate-600">
                      {contact.property.addressLine1}, {contact.property.city}
                    </p>
                  ) : null}
                </div>

                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span
                    className={`rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wide ${theme.badge}`}
                  >
                    {labelForPipelineStage(contact.pipeline.stage)}
                  </span>
                  {contact.property?.outOfArea ? (
                    <span className="rounded-full bg-rose-100 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-rose-700">
                      Out of area
                    </span>
                  ) : null}
                  <label className="w-full text-xs font-semibold text-slate-600 sm:w-auto">
                    <span className="sr-only">
                      Move {contact.firstName} {contact.lastName} to pipeline
                      stage
                    </span>
                    <select
                      value={contact.pipeline.stage}
                      className={`${TEAM_SELECT} min-h-11 w-full sm:w-auto`}
                      disabled={isPending}
                      onChange={(event) =>
                        void updateStage(contact.id, event.target.value)
                      }
                    >
                      {stages.map((stage) => (
                        <option key={stage} value={stage}>
                          {labelForPipelineStage(stage)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {isPending ? (
                    <span className="text-xs text-slate-500">Saving…</span>
                  ) : null}
                </div>

                <div className="flex flex-wrap gap-2 md:justify-end">
                  <a
                    className={`${teamButtonClass("secondary", "sm")} min-h-11 gap-2`}
                    href={teamSurfaceHref("contacts", {
                      query: { contactId: contact.id },
                    })}
                  >
                    <ArrowRight className="h-4 w-4" aria-hidden="true" />
                    Contact
                  </a>
                  <a
                    className={`${teamButtonClass("secondary", "sm")} min-h-11 gap-2`}
                    href={quoteWorkspaceHref("create", {
                      query: {
                        contactId: contact.id,
                      },
                    })}
                  >
                    <FileText className="h-4 w-4" aria-hidden="true" />
                    Quote
                  </a>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {visibleContacts.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-[color:var(--team-border)] bg-[color:var(--team-card)] p-8 text-center text-sm text-[color:var(--team-text-muted)]">
          No pipeline contacts match this page and filter.
        </div>
      ) : null}

      {pagination.hasPrevious || pagination.hasNext ? (
        <nav
          className="flex items-center justify-between gap-3"
          aria-label="Pipeline pages"
        >
          <button
            type="button"
            className={`${teamButtonClass("secondary", "sm")} min-h-11`}
            disabled={!pagination.hasPrevious || isNavigating}
            onClick={() =>
              navigate({
                offset: Math.max(0, pagination.offset - pagination.limit),
              })
            }
          >
            Previous
          </button>
          <span className="text-xs text-[color:var(--team-text-muted)]">
            {firstVisible}–{lastVisible} of {pagination.total}
          </span>
          <button
            type="button"
            className={`${teamButtonClass("secondary", "sm")} min-h-11`}
            disabled={!pagination.hasNext || isNavigating}
            onClick={() =>
              navigate({ offset: pagination.offset + pagination.limit })
            }
          >
            Next
          </button>
        </nav>
      ) : null}

      <div className="min-h-5" aria-live="polite" aria-atomic="true">
        {pendingContactIds.size > 0 ? (
          <p className="text-center text-xs text-[color:var(--team-text-muted)]">
            Saving {pendingContactIds.size} pipeline update
            {pendingContactIds.size === 1 ? "" : "s"}…
          </p>
        ) : saveNotice ? (
          <p className="text-center text-xs font-semibold text-emerald-700">
            {saveNotice}
          </p>
        ) : null}
      </div>
      {saveError ? (
        <div
          className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-center text-xs font-semibold text-rose-700"
          role="alert"
        >
          {saveError}
        </div>
      ) : null}
    </div>
  );
}
