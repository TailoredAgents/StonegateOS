'use client';

import { useEffect, useMemo, useState, useTransition } from "react";
import { SubmitButton } from "@/components/SubmitButton";
import { updatePipelineStageAction } from "../actions";
import type { PipelineContact, PipelineLane } from "./pipeline.types";

const STAGE_LABELS: Record<string, string> = {
  new: "New",
  contacted: "Contacted",
  qualified: "Scheduled Quote",
  quoted: "Quoted",
  won: "Won",
  lost: "Lost"
};

type StageTheme = {
  dot: string;
  badge: string;
  cardBorder: string;
  cardBackground: string;
};

const STAGE_THEMES: Record<string, StageTheme> = {
  new: {
    dot: "bg-blue-400",
    badge: "bg-blue-100 text-blue-700",
    cardBorder: "border-blue-100 hover:border-blue-200",
    cardBackground: "bg-gradient-to-br from-white to-blue-50/60"
  },
  contacted: {
    dot: "bg-sky-400",
    badge: "bg-sky-100 text-sky-700",
    cardBorder: "border-sky-100 hover:border-sky-200",
    cardBackground: "bg-gradient-to-br from-white to-sky-50/60"
  },
  qualified: {
    dot: "bg-amber-400",
    badge: "bg-amber-100 text-amber-700",
    cardBorder: "border-amber-100 hover:border-amber-200",
    cardBackground: "bg-gradient-to-br from-white to-amber-50/60"
  },
  quoted: {
    dot: "bg-indigo-400",
    badge: "bg-indigo-100 text-indigo-700",
    cardBorder: "border-indigo-100 hover:border-indigo-200",
    cardBackground: "bg-gradient-to-br from-white to-indigo-50/60"
  },
  won: {
    dot: "bg-emerald-400",
    badge: "bg-emerald-100 text-emerald-700",
    cardBorder: "border-emerald-100 hover:border-emerald-200",
    cardBackground: "bg-gradient-to-br from-white to-emerald-50/60"
  },
  lost: {
    dot: "bg-rose-400",
    badge: "bg-rose-100 text-rose-700",
    cardBorder: "border-rose-100 hover:border-rose-200",
    cardBackground: "bg-gradient-to-br from-white to-rose-50/60"
  },
  default: {
    dot: "bg-slate-400",
    badge: "bg-slate-100 text-slate-600",
    cardBorder: "border-slate-200 hover:border-slate-300",
    cardBackground: "bg-white"
  }
};

const DEFAULT_STAGE_THEME: StageTheme = {
  dot: "bg-slate-400",
  badge: "bg-slate-100 text-slate-600",
  cardBorder: "border-slate-200 hover:border-slate-300",
  cardBackground: "bg-white"
};

function labelForStage(stage: string): string {
  return STAGE_LABELS[stage] ?? stage;
}

function themeForStage(stage: string): StageTheme {
  const theme = STAGE_THEMES[stage];
  if (theme) {
    return theme;
  }
  return DEFAULT_STAGE_THEME;
}

function sortContacts(contacts: PipelineContact[]): PipelineContact[] {
  return [...contacts].sort((a, b) => {
    const aTime = a.lastActivityAt ? Date.parse(a.lastActivityAt) : 0;
    const bTime = b.lastActivityAt ? Date.parse(b.lastActivityAt) : 0;
    return bTime - aTime;
  });
}

function normalizeBoard(lanes: PipelineLane[]): PipelineLane[] {
  return lanes.map((lane) => ({
    stage: lane.stage,
    contacts: sortContacts(lane.contacts)
  }));
}

function formatShortDate(iso: string | null): string {
  if (!iso) return "No recent activity";
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "No recent activity";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric"
  }).format(new Date(time));
}

type PipelineBoardClientProps = {
  stages: string[];
  lanes: PipelineLane[];
};

export default function PipelineBoardClient({ stages, lanes }: PipelineBoardClientProps) {
  const [board, setBoard] = useState<PipelineLane[]>(() => normalizeBoard(lanes));
  const [dragging, setDragging] = useState<{ id: string; stage: string } | null>(null);
  const [hoverStage, setHoverStage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    setBoard(normalizeBoard(lanes));
  }, [lanes]);

  const contactLookup = useMemo(() => {
    const map = new Map<string, PipelineContact>();
    for (const lane of board) {
      for (const contact of lane.contacts) {
        map.set(contact.id, contact);
      }
    }
    return map;
  }, [board]);

  function moveContact(contactId: string, targetStage: string) {
    setBoard((current) => {
      const contact = contactLookup.get(contactId);
      if (!contact) return current;
      if (contact.pipeline.stage === targetStage) return current;

      const updatedContact: PipelineContact = {
        ...contact,
        pipeline: {
          ...contact.pipeline,
          stage: targetStage,
          updatedAt: new Date().toISOString()
        }
      };

      const stripped = current.map((lane) => ({
        ...lane,
        contacts: lane.contacts.filter((c) => c.id !== contactId)
      }));

      const targetIndex = stripped.findIndex((lane) => lane.stage === targetStage);
      if (targetIndex === -1) return current;

      const targetLane = stripped[targetIndex];
      if (!targetLane) return current;

      stripped[targetIndex] = {
        ...targetLane,
        contacts: sortContacts([...targetLane.contacts, updatedContact])
      };

      return stripped;
    });
  }

  function handleDrop(event: React.DragEvent<HTMLDivElement>, stage: string) {
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

    if (!contactId && dragging) {
      contactId = dragging.id;
    }

    if (!contactId || dragging?.stage === stage) return;

    moveContact(contactId, stage);
    setDragging(null);

    const formData = new FormData();
    formData.set("contactId", contactId);
    formData.set("stage", stage);
    startTransition(() => updatePipelineStageAction(formData));
  }

  function handleDragOver(event: React.DragEvent<HTMLDivElement>, stage: string) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setHoverStage(stage);
  }

  function handleDragStart(contact: PipelineContact, stage: string, event: React.DragEvent<HTMLDivElement>) {
    setDragging({ id: contact.id, stage });
    try {
      event.dataTransfer.setData("application/json", JSON.stringify({ contactId: contact.id }));
      event.dataTransfer.effectAllowed = "move";
    } catch {
      // ignore
    }
  }

  function handleDragEnd() {
    setDragging(null);
    setHoverStage(null);
  }

  return (
    <div className="overflow-x-auto pb-6">
      <div className="grid auto-cols-[minmax(280px,320px)] grid-flow-col gap-5">
        {stages.map((stage) => {
          const lane = board.find((item) => item.stage === stage) ?? { stage, contacts: [] };
          const isHover = hoverStage === stage;
          const laneTheme = themeForStage(stage);
          return (
            <section
              key={stage}
              onDragOver={(event: React.DragEvent<HTMLDivElement>) => handleDragOver(event, stage)}
              onDrop={(event: React.DragEvent<HTMLDivElement>) => handleDrop(event, stage)}
              onDragLeave={(event: React.DragEvent<HTMLDivElement>) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                  setHoverStage(null);
                }
              }}
              className={`group flex min-h-[360px] flex-col rounded-3xl border border-slate-200 bg-white/80 shadow-xl shadow-slate-200/60 transition ${
                isHover ? "border-primary-400 ring-2 ring-primary-200/60" : ""
              }`}
            >
              <header className="flex items-center justify-between gap-3 rounded-t-3xl border-b border-slate-200/60 bg-white/90 px-5 py-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                  <span className={`h-2.5 w-2.5 rounded-full ${laneTheme.dot}`} />
                  {labelForStage(stage)}
                </div>
                <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-500">
                  {lane.contacts.length}
                </span>
              </header>
              <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-5 py-4">
                {lane.contacts.length === 0 ? (
                  <p className="rounded-2xl border border-dashed border-slate-200 bg-white/85 px-4 py-8 text-center text-xs text-slate-400">
                    Drop a contact here or use the stage picker.
                  </p>
                ) : (
                  lane.contacts.map((contact) => {
                    const theme = themeForStage(contact.pipeline.stage);
                    return (
                      <article
                        key={contact.id}
                        role="button"
                        tabIndex={0}
                        draggable
                        onDragStart={(event: React.DragEvent<HTMLDivElement>) => handleDragStart(contact, stage, event)}
                        onDragEnd={handleDragEnd}
                        className={`cursor-grab rounded-2xl border px-4 py-4 text-xs shadow-sm transition hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300 ${
                          dragging?.id === contact.id ? "opacity-60" : ""
                        } ${theme.cardBorder} ${theme.cardBackground}`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="space-y-1">
                            <p className="text-sm font-semibold leading-tight text-slate-900">
                              {contact.firstName} {contact.lastName}
                            </p>
                            <p className="text-[11px] text-slate-500">
                              Updated {formatShortDate(contact.lastActivityAt)} - {contact.openTasks} open tasks
                            </p>
                          </div>
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${theme.badge}`}
                          >
                            {labelForStage(contact.pipeline.stage)}
                          </span>
                        </div>
                        {contact.property?.outOfArea ? (
                          <span className="mt-2 inline-flex rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-rose-700">
                            Out of area
                          </span>
                        ) : null}
                        {contact.property ? (
                          <p className="mt-3 text-[11px] text-slate-600">
                            {contact.property.addressLine1}, {contact.property.city}
                          </p>
                        ) : null}
                        <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
                          <a
                            className="rounded-full border border-slate-200 px-3 py-1.5 text-slate-600 transition hover:border-primary-300 hover:text-primary-700"
                            href={`/team?tab=contacts&q=${encodeURIComponent(`${contact.firstName} ${contact.lastName}`.trim())}`}
                          >
                            View contact
                          </a>
                          <a
                            className="rounded-full border border-slate-200 px-3 py-1.5 text-slate-600 transition hover:border-primary-300 hover:text-primary-700"
                            href={`/team?tab=quote-builder&contactId=${encodeURIComponent(contact.id)}`}
                          >
                            Create quote
                          </a>
                        </div>
                        <form
                          action={updatePipelineStageAction}
                          className="mt-3 flex flex-wrap items-center gap-2 text-[11px]"
                          onSubmit={() => setHoverStage(null)}
                        >
                          <input type="hidden" name="contactId" value={contact.id} />
                          <label className="flex items-center gap-2">
                            <span className="sr-only">Pipeline stage</span>
                            <select
                              name="stage"
                              defaultValue={contact.pipeline.stage}
                              className="rounded-full border border-slate-200 px-3 py-1.5 text-slate-600 focus:border-primary-400 focus:outline-none focus:ring-1 focus:ring-primary-200"
                              onClick={(event) => event.stopPropagation()}
                            >
                              {stages.map((option) => (
                                <option key={option} value={option}>
                                  {labelForStage(option)}
                                </option>
                              ))}
                            </select>
                          </label>
                          <SubmitButton
                            className="rounded-full border border-slate-200 px-3 py-1.5 text-slate-600 transition hover:border-primary-300 hover:text-primary-700"
                            pendingLabel="Saving..."
                          >
                            Update
                          </SubmitButton>
                        </form>
                      </article>
                    );
                  })
                )}
              </div>
            </section>
          );
        })}
      </div>
      {isPending ? <div className="mt-4 text-center text-xs text-slate-500">Saving updates...</div> : null}
    </div>
  );
}

