'use client';

import { useEffect, useMemo, useState, useTransition } from "react";
import { SubmitButton } from "@/components/SubmitButton";
import { ArrowRight, FileText, Save } from "lucide-react";
import { updatePipelineStageAction } from "../actions";
import { TEAM_TIME_ZONE } from "../lib/timezone";
import type { PipelineContact, PipelineLane } from "./pipeline.types";
import { labelForPipelineStage, themeForPipelineStage } from "./pipeline.stages";
import { TEAM_SELECT, teamButtonClass } from "./team-ui";

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
    timeZone: TEAM_TIME_ZONE,
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
          const laneTheme = themeForPipelineStage(stage);
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
              className={`group flex h-[min(620px,calc(100vh-14rem))] min-h-[360px] flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white/80 shadow-xl shadow-slate-200/60 transition sm:h-[min(720px,calc(100vh-18rem))] ${
                isHover ? "border-primary-400 ring-2 ring-primary-200/60" : ""
              }`}
            >
              <header className="flex items-center justify-between gap-3 rounded-t-3xl border-b border-slate-200/60 bg-white/90 px-5 py-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                  <span className={`h-2.5 w-2.5 rounded-full ${laneTheme.dot}`} />
                  {labelForPipelineStage(stage)}
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
                    const theme = themeForPipelineStage(contact.pipeline.stage);
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
                              Updated {formatShortDate(contact.lastActivityAt)} - {contact.notesCount} notes
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
                            {contact.property.addressLine1}, {contact.property.city}
                          </p>
                        ) : null}
                        <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
                          <a
                            className={`${teamButtonClass("secondary", "sm")} gap-2`}
                            href={`/team?tab=contacts&q=${encodeURIComponent(`${contact.firstName} ${contact.lastName}`.trim())}`}
                          >
                            <ArrowRight className="h-4 w-4" aria-hidden="true" />
                            View contact
                          </a>
                          <a
                            className={`${teamButtonClass("secondary", "sm")} gap-2`}
                            href={`/team?tab=quote-builder&contactId=${encodeURIComponent(contact.id)}`}
                          >
                            <FileText className="h-4 w-4" aria-hidden="true" />
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
                              className={TEAM_SELECT}
                              onClick={(event) => event.stopPropagation()}
                            >
                              {stages.map((option) => (
                                <option key={option} value={option}>
                                  {labelForPipelineStage(option)}
                                </option>
                              ))}
                            </select>
                          </label>
                          <SubmitButton
                            className={`${teamButtonClass("secondary", "sm")} gap-2`}
                            pendingLabel="Saving..."
                          >
                            <Save className="h-4 w-4" aria-hidden="true" />
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
