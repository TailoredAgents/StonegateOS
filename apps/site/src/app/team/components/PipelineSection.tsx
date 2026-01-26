import React, { type ReactElement } from "react";
import { callAdminApi } from "../lib/api";
import PipelineBoardClient from "./PipelineBoardClient";
import type { ContactSummary } from "./contacts.types";
import { ContactsDetailsPaneClient } from "./ContactsDetailsPaneClient";
import type { PipelineResponse } from "./pipeline.types";
import { PipelineAudit } from "./PipelineAudit";
import { TEAM_CARD_PADDED, TEAM_EMPTY_STATE } from "./team-ui";

type PipelineSectionProps = {
  contactId?: string;
};

export async function PipelineSection({ contactId }: PipelineSectionProps): Promise<ReactElement> {
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

  let teamMembers: Array<{ id: string; name: string }> = [];
  try {
    const membersRes = await callAdminApi("/api/admin/team/directory");
    if (membersRes.ok) {
      const memberPayload = (await membersRes.json()) as { members?: Array<{ id: string; name: string; active?: boolean }> };
      teamMembers = (memberPayload.members ?? []).filter((m) => m.active !== false).map((m) => ({ id: m.id, name: m.name }));
    }
  } catch {
    teamMembers = [];
  }

  const selectedContactId = typeof contactId === "string" && contactId.trim().length > 0 ? contactId.trim() : null;
  let selectedContact: ContactSummary | null = null;
  if (selectedContactId) {
    try {
      const selectedParams = new URLSearchParams();
      selectedParams.set("contactId", selectedContactId);
      selectedParams.set("limit", "1");
      const selectedRes = await callAdminApi(`/api/admin/contacts?${selectedParams.toString()}`);
      if (selectedRes.ok) {
        const selectedPayload = (await selectedRes.json()) as { contacts?: ContactSummary[] };
        selectedContact = (selectedPayload.contacts ?? [])[0] ?? null;
      }
    } catch {
      selectedContact = null;
    }
  }

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
        <div className="grid gap-4 lg:grid-cols-[minmax(720px,1fr)_420px]">
          <PipelineBoardClient
            stages={filteredPayload.stages}
            lanes={filteredPayload.lanes}
            selectedContactId={selectedContactId}
          />
          <div className="lg:sticky lg:top-24 lg:self-start">
            {selectedContact ? (
              <div className="rounded-3xl border border-slate-200 bg-white/85 p-4 shadow-xl shadow-slate-200/50">
                <ContactsDetailsPaneClient key={selectedContact.id} contact={selectedContact} teamMembers={teamMembers} />
              </div>
            ) : (
              <div className="rounded-3xl border border-dashed border-slate-200 bg-white/70 p-6 text-sm text-slate-600 shadow-sm">
                <div className="text-base font-semibold text-slate-900">Select a contact</div>
                <p className="mt-1 text-sm text-slate-600">
                  Click a card to see notes, reminders, assignment, and quick actions.
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      <details className="rounded-2xl border border-slate-200 bg-white/80 p-4 shadow-md shadow-slate-200/50">
        <summary className="cursor-pointer text-sm font-semibold text-slate-900">Recent pipeline automation</summary>
        <div className="mt-4">
          <PipelineAudit />
        </div>
      </details>
    </section>
  );
}
