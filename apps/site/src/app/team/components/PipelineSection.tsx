import React, { type ReactElement } from "react";
import { callAdminApi } from "../lib/api";
import PipelineBoardClient from "./PipelineBoardClient";
import type { PipelineResponse } from "./pipeline.types";
import { PipelineAudit } from "./PipelineAudit";

export async function PipelineSection(): Promise<ReactElement> {
  const response = await callAdminApi("/api/admin/crm/pipeline");
  if (!response.ok) {
    throw new Error("Failed to load pipeline");
  }

  const payload = (await response.json()) as PipelineResponse;
  const totalContacts = payload.lanes.reduce((sum, lane) => sum + lane.contacts.length, 0);

  return (
    <section className="space-y-5">
      <header className="rounded-3xl border border-slate-200 bg-white/90 p-5 shadow-xl shadow-slate-200/50 backdrop-blur">
        <h2 className="text-lg font-semibold text-slate-900">Pipeline</h2>
        <p className="mt-1 text-sm text-slate-600">
          Drag contacts between stages or use the inline controls to keep their stage in sync. Boards update instantly and link back to each record for fast
          follow-up.
        </p>
      </header>

      {totalContacts === 0 ? (
        <p className="rounded-2xl border border-dashed border-slate-200 bg-white/80 p-5 text-sm text-slate-500 shadow-sm">
          No contacts in the pipeline yet. Create contacts to get started.
        </p>
      ) : (
        <PipelineBoardClient stages={payload.stages} lanes={payload.lanes} />
      )}

      <PipelineAudit />
    </section>
  );
}
