import React, { type ReactElement } from "react";
import { callAdminApi } from "../lib/api";
import PipelineBoardClient from "./PipelineBoardClient";
import type { PipelineResponse } from "./pipeline.types";
import { PipelineAudit } from "./PipelineAudit";
import { TEAM_CARD_PADDED, TEAM_EMPTY_STATE } from "./team-ui";

export async function PipelineSection(): Promise<ReactElement> {
  const response = await callAdminApi("/api/admin/crm/pipeline");
  if (!response.ok) {
    throw new Error("Failed to load pipeline");
  }

  const payload = (await response.json()) as PipelineResponse;
  const filteredPayload: PipelineResponse = {
    stages: payload.stages,
    lanes: payload.lanes.map((lane) => ({
      ...lane,
      contacts: lane.contacts.filter((contact) => !(contact.source && contact.source.startsWith("outbound:")))
    }))
  };
  const totalContacts = filteredPayload.lanes.reduce((sum, lane) => sum + lane.contacts.length, 0);

  return (
    <section className="space-y-5">
      <header className={TEAM_CARD_PADDED}>
        <h2 className="text-lg font-semibold text-slate-900">Pipeline</h2>
        <p className="mt-1 text-sm text-slate-600">
          Drag contacts between stages or use the inline controls to keep their stage in sync. Boards update instantly and link back to each record for fast
          follow-up.
        </p>
      </header>

      {totalContacts === 0 ? (
        <p className={TEAM_EMPTY_STATE}>
          No contacts in the pipeline yet. Create contacts to get started.
        </p>
      ) : (
        <PipelineBoardClient stages={filteredPayload.stages} lanes={filteredPayload.lanes} />
      )}

      <PipelineAudit />
    </section>
  );
}
