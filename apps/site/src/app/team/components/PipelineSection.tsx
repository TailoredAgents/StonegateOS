import React, { type ReactElement } from "react";
import { requireCurrentTeamPrincipal } from "@/lib/team-principal";
import { callAdminApiAs } from "../lib/api";
import PipelineBoardClient from "./PipelineBoardClient";
import type { ContactSummary } from "./contacts.types";
import { ContactsDetailsPaneClient } from "./ContactsDetailsPaneClient";
import type { PipelineResponse, PipelineView } from "./pipeline.types";
import { PipelineAudit } from "./PipelineAudit";
import { PipelineMovementEvidence } from "./PipelineMovementEvidence";
import {
  parsePipelineFilterPresetInventory,
  parsePipelineMovements,
  type PipelineMovementState,
  type PipelinePresetInventoryState,
} from "../pipeline-presets";
import { TEAM_CARD_PADDED, TEAM_EMPTY_STATE } from "./team-ui";

type PipelineSectionProps = {
  contactId?: string;
  q?: string;
  stage?: string;
  offset?: string;
  view?: string;
  outbound?: string;
};

const PIPELINE_PAGE_SIZE = 50;

export async function PipelineSection({
  contactId,
  q,
  stage,
  offset,
  view,
  outbound,
}: PipelineSectionProps): Promise<ReactElement> {
  const principal = await requireCurrentTeamPrincipal();
  const excludeOutbound = outbound !== "include";
  const pipelineParams = new URLSearchParams({
    limit: String(PIPELINE_PAGE_SIZE),
    excludeOutbound: excludeOutbound ? "1" : "0",
  });
  if (typeof q === "string" && q.trim()) {
    pipelineParams.set("q", q.trim());
  }
  if (typeof stage === "string" && stage.trim()) {
    pipelineParams.set("stage", stage.trim());
  }
  if (typeof offset === "string" && offset.trim()) {
    pipelineParams.set("offset", offset.trim());
  }
  const [response, presetResponse] = await Promise.all([
    callAdminApiAs(
      principal,
      `/api/admin/crm/pipeline?${pipelineParams.toString()}`,
    ),
    callAdminApiAs(principal, "/api/admin/crm/pipeline/presets").catch(
      () => null,
    ),
  ]);
  if (!response.ok) {
    throw new Error("Failed to load pipeline");
  }

  const payload = (await response.json()) as PipelineResponse;
  const visibleContacts = payload.lanes.reduce(
    (sum, lane) => sum + lane.contacts.length,
    0,
  );
  const pipelineContacts = Object.values(payload.stageCounts).reduce(
    (sum, count) => sum + count,
    0,
  );
  const activeView: PipelineView = view === "list" ? "list" : "board";
  const hasFilters = Boolean(
    payload.filters.q ||
      payload.filters.stage ||
      !payload.filters.excludeOutbound,
  );

  let presetState: PipelinePresetInventoryState = {
    status: "error",
    message: "Saved pipeline filters could not be loaded. Retry this section.",
  };
  if (presetResponse?.ok) {
    try {
      const parsed = parsePipelineFilterPresetInventory(
        (await presetResponse.json()) as unknown,
      );
      if (parsed) {
        presetState = { status: "ready", ...parsed };
      }
    } catch {
      // The explicit error state remains visible below.
    }
  }

  let teamMembers: Array<{ id: string; name: string }> = [];
  try {
    const membersRes = await callAdminApiAs(
      principal,
      "/api/admin/team/directory",
    );
    if (membersRes.ok) {
      const memberPayload = (await membersRes.json()) as {
        members?: Array<{ id: string; name: string; active?: boolean }>;
      };
      teamMembers = (memberPayload.members ?? [])
        .filter((m) => m.active !== false)
        .map((m) => ({ id: m.id, name: m.name }));
    }
  } catch {
    teamMembers = [];
  }

  const selectedContactId =
    typeof contactId === "string" && contactId.trim().length > 0
      ? contactId.trim()
      : null;
  let selectedContact: ContactSummary | null = null;
  let movementState: PipelineMovementState = {
    status: "ready",
    movements: [],
  };
  if (selectedContactId) {
    const selectedParams = new URLSearchParams();
    selectedParams.set("contactId", selectedContactId);
    selectedParams.set("limit", "1");
    const [selectedResult, movementsResult] = await Promise.allSettled([
      callAdminApiAs(
        principal,
        `/api/admin/contacts?${selectedParams.toString()}`,
      ),
      callAdminApiAs(
        principal,
        `/api/admin/crm/pipeline/${encodeURIComponent(selectedContactId)}/movements`,
      ),
    ]);
    try {
      const selectedRes =
        selectedResult.status === "fulfilled" ? selectedResult.value : null;
      if (selectedRes?.ok) {
        const selectedPayload = (await selectedRes.json()) as {
          contacts?: ContactSummary[];
        };
        selectedContact = (selectedPayload.contacts ?? [])[0] ?? null;
      }
    } catch {
      selectedContact = null;
    }
    try {
      const movementsRes =
        movementsResult.status === "fulfilled" ? movementsResult.value : null;
      if (!movementsRes?.ok) {
        throw new Error("movement_request_failed");
      }
      const parsed = parsePipelineMovements(
        (await movementsRes.json()) as unknown,
      );
      if (!parsed) throw new Error("movement_contract_invalid");
      movementState = { status: "ready", movements: parsed.movements };
    } catch {
      movementState = {
        status: "error",
        message:
          "Recent pipeline movements could not be loaded. Refresh to retry.",
      };
    }
  }

  return (
    <section className="space-y-5">
      <header className={TEAM_CARD_PADDED}>
        <h2 className="text-lg font-semibold text-slate-900">Pipeline</h2>
        <p className="mt-1 text-sm text-slate-600">
          Drag contacts between stages or use the inline controls to keep their
          stage in sync. Boards update instantly and link back to each record
          for fast follow-up.
        </p>
      </header>

      {pipelineContacts === 0 && !hasFilters ? (
        <p className={TEAM_EMPTY_STATE}>
          No contacts in the pipeline yet. Create contacts to get started.
        </p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(720px,1fr)_420px]">
          <PipelineBoardClient
            stages={payload.stages}
            lanes={payload.lanes}
            stageCounts={payload.stageCounts}
            pagination={payload.pagination}
            filters={payload.filters}
            view={activeView}
            selectedContactId={selectedContactId}
            actorId={principal.memberId}
            presetState={presetState}
          />
          <div
            className={`${selectedContact ? "order-first" : "order-last"} lg:order-none lg:sticky lg:top-24 lg:self-start`}
          >
            {selectedContact ? (
              <div className="rounded-3xl border border-slate-200 bg-white/85 p-4 shadow-xl shadow-slate-200/50">
                <ContactsDetailsPaneClient
                  key={selectedContact.id}
                  contact={selectedContact}
                  actorId={principal.memberId}
                  teamMembers={teamMembers}
                />
                <PipelineMovementEvidence state={movementState} />
              </div>
            ) : (
              <div className="rounded-3xl border border-dashed border-slate-200 bg-white/70 p-6 text-sm text-slate-600 shadow-sm">
                <div className="text-base font-semibold text-slate-900">
                  Select a contact
                </div>
                <p className="mt-1 text-sm text-slate-600">
                  Click a card to see notes, reminders, assignment, and quick
                  actions.
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {hasFilters && visibleContacts === 0 ? (
        <p className="sr-only" aria-live="polite">
          No pipeline contacts match the current filters.
        </p>
      ) : null}

      <details className="rounded-2xl border border-slate-200 bg-white/80 p-4 shadow-md shadow-slate-200/50">
        <summary className="cursor-pointer text-sm font-semibold text-slate-900">
          Recent pipeline automation
        </summary>
        <div className="mt-4">
          <PipelineAudit />
        </div>
      </details>
    </section>
  );
}
