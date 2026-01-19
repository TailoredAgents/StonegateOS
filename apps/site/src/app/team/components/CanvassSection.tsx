import React from "react";
import { SubmitButton } from "@/components/SubmitButton";
import { callAdminApi } from "../lib/api";
import {
  createCanvassLeadAction,
  createCanvassFollowupAction,
  startContactCallAction,
  openContactThreadAction,
  updateTaskAction
} from "../actions";
import {
  TEAM_CARD_PADDED,
  TEAM_EMPTY_STATE,
  TEAM_INPUT,
  TEAM_INPUT_COMPACT,
  TEAM_SECTION_SUBTITLE,
  TEAM_SECTION_TITLE,
  teamButtonClass
} from "./team-ui";
import { QuoteBuilderSection } from "./QuoteBuilderSection";

type TeamMember = { id: string; name: string; active?: boolean };

type CanvassQueueItem = {
  id: string;
  title: string | null;
  dueAt: string | null;
  overdue: boolean;
  minutesUntilDue: number | null;
  contact: {
    id: string;
    name: string;
    phone: string | null;
    email: string | null;
  };
};

type CanvassQueueResponse = {
  ok: true;
  memberId: string | null;
  items: CanvassQueueItem[];
};

function formatDue(item: CanvassQueueItem): string {
  if (!item.dueAt) return "Not started";
  const due = new Date(item.dueAt);
  if (Number.isNaN(due.getTime())) return item.dueAt;
  return due.toLocaleString();
}

function dueBadge(item: CanvassQueueItem): { label: string; tone: string } {
  if (!item.dueAt) return { label: "Not started", tone: "bg-slate-100 text-slate-600" };
  if (item.overdue) return { label: "Overdue", tone: "bg-rose-100 text-rose-700" };
  if (typeof item.minutesUntilDue === "number") {
    if (item.minutesUntilDue <= 0) return { label: "Due now", tone: "bg-amber-100 text-amber-700" };
    if (item.minutesUntilDue < 60) return { label: `Due in ${item.minutesUntilDue}m`, tone: "bg-amber-50 text-amber-700" };
  }
  return { label: "Scheduled", tone: "bg-slate-100 text-slate-600" };
}

export async function CanvassSection({
  initialContactId,
  memberId
}: {
  initialContactId?: string;
  memberId?: string;
}): Promise<React.ReactElement> {
  let members: TeamMember[] = [];
  try {
    const membersRes = await callAdminApi("/api/admin/team/directory");
    if (membersRes.ok) {
      const payload = (await membersRes.json()) as { members?: TeamMember[] };
      members = (payload.members ?? []).filter((m) => m.active !== false);
    }
  } catch {
    members = [];
  }

  let queue: CanvassQueueResponse | null = null;
  try {
    const qs = new URLSearchParams();
    if (memberId) qs.set("memberId", memberId);
    const res = await callAdminApi(`/api/admin/canvass/queue?${qs.toString()}`);
    if (res.ok) {
      queue = (await res.json()) as CanvassQueueResponse;
    }
  } catch {
    queue = null;
  }

  const items = queue?.items ?? [];
  const selected = initialContactId ? items.find((i) => i.contact.id === initialContactId) ?? null : null;

  return (
    <section className="space-y-6">
      <header className={TEAM_CARD_PADDED}>
        <div>
          <h2 className={TEAM_SECTION_TITLE}>Canvass Quote</h2>
          <p className={TEAM_SECTION_SUBTITLE}>
            Door-to-door pricing flow. Create a lead with a full address, build a quote, and optionally schedule manual follow-ups (in-app + SMS reminders).
          </p>
        </div>
      </header>

      <div className={TEAM_CARD_PADDED}>
        <h3 className="text-base font-semibold text-slate-900">Quick intake</h3>
        <p className="mt-1 text-sm text-slate-600">
          Required: name, full address, and either phone or email.
        </p>

        <form action={createCanvassLeadAction} className="mt-4 grid gap-4">
          <div className="grid gap-4 md:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm text-slate-600">
              <span>First name</span>
              <input name="firstName" className={TEAM_INPUT} required />
            </label>
            <label className="flex flex-col gap-1 text-sm text-slate-600">
              <span>Last name</span>
              <input name="lastName" className={TEAM_INPUT} required />
            </label>
            <label className="flex flex-col gap-1 text-sm text-slate-600">
              <span>Phone</span>
              <input name="phone" className={TEAM_INPUT} placeholder="e.g. 770-555-1234" />
            </label>
            <label className="flex flex-col gap-1 text-sm text-slate-600">
              <span>Email</span>
              <input name="email" className={TEAM_INPUT} placeholder="name@example.com" />
            </label>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm text-slate-600 md:col-span-2">
              <span>Address</span>
              <input name="addressLine1" className={TEAM_INPUT} placeholder="Street address" required />
            </label>
            <label className="flex flex-col gap-1 text-sm text-slate-600">
              <span>City</span>
              <input name="city" className={TEAM_INPUT} required />
            </label>
            <label className="flex flex-col gap-1 text-sm text-slate-600">
              <span>State</span>
              <input name="state" className={TEAM_INPUT} defaultValue="GA" required />
            </label>
            <label className="flex flex-col gap-1 text-sm text-slate-600">
              <span>ZIP</span>
              <input name="postalCode" className={TEAM_INPUT} required />
            </label>
            <label className="flex flex-col gap-1 text-sm text-slate-600">
              <span>Assign to</span>
              <select name="salespersonMemberId" className={TEAM_INPUT} defaultValue={memberId ?? ""}>
                <option value="">Default assignee</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <SubmitButton className={teamButtonClass("primary", "md")} pendingLabel="Saving...">
              Create canvass lead
            </SubmitButton>
            <span className="text-xs text-slate-500">Tip: after creating, build the quote below and it will draft an SMS for you.</span>
          </div>
        </form>
      </div>

      {initialContactId ? (
        <div className="space-y-4">
          <div className={TEAM_CARD_PADDED}>
            <h3 className="text-base font-semibold text-slate-900">Quote builder</h3>
            <p className="mt-1 text-sm text-slate-600">Create a quote for this canvass lead. The system prepares an SMS draft after you create the quote.</p>
          </div>
          <QuoteBuilderSection initialContactId={initialContactId} workflow="canvass" />
        </div>
      ) : (
        <div className={TEAM_CARD_PADDED}>
          <div className={TEAM_EMPTY_STATE}>Create a canvass lead above to start quoting.</div>
        </div>
      )}

      <div className={TEAM_CARD_PADDED}>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h3 className="text-base font-semibold text-slate-900">Canvass follow-up queue</h3>
            <p className="mt-1 text-sm text-slate-600">Manual follow-ups only. Scheduling a follow-up creates an in-app task and an SMS reminder for the assigned rep.</p>
          </div>
        </div>

        {items.length === 0 ? (
          <div className={`${TEAM_EMPTY_STATE} mt-4`}>No active canvass follow-ups yet.</div>
        ) : (
          <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
            <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
              <table className="min-w-full text-left text-xs">
                <thead className="sticky top-0 z-10 bg-slate-50 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Due</th>
                    <th className="px-4 py-3">Lead</th>
                    <th className="px-4 py-3">Phone</th>
                    <th className="px-4 py-3">Email</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {items.map((item) => {
                    const badge = dueBadge(item);
                    const isActive = initialContactId && item.contact.id === initialContactId;
                    return (
                      <tr key={item.id} className={isActive ? "bg-primary-50/40" : "hover:bg-slate-50"}>
                        <td className="px-4 py-3">
                          <span className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${badge.tone}`}>
                            {badge.label}
                          </span>
                          <div className="mt-1 text-[11px] text-slate-500">Due {formatDue(item)}</div>
                        </td>
                        <td className="px-4 py-3">
                          <a
                            href={`/team?tab=quotes&quoteMode=canvass&contactId=${encodeURIComponent(item.contact.id)}`}
                            className="block max-w-[320px]"
                          >
                            <div className="truncate text-sm font-semibold text-slate-900">{item.contact.name}</div>
                            <div className="mt-0.5 truncate text-[11px] text-slate-500">{item.title ?? "Canvass task"}</div>
                          </a>
                        </td>
                        <td className="px-4 py-3 text-slate-600">{item.contact.phone ?? "-"}</td>
                        <td className="px-4 py-3 text-slate-600">{item.contact.email ?? "-"}</td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap justify-end gap-2">
                            <form action={startContactCallAction}>
                              <input type="hidden" name="contactId" value={item.contact.id} />
                              <SubmitButton className={teamButtonClass("primary", "sm")} pendingLabel="Calling...">
                                Call
                              </SubmitButton>
                            </form>
                            <form action={openContactThreadAction}>
                              <input type="hidden" name="contactId" value={item.contact.id} />
                              <input type="hidden" name="channel" value={item.contact.email ? "email" : "sms"} />
                              <SubmitButton className={teamButtonClass("secondary", "sm")} pendingLabel="Opening...">
                                Msg
                              </SubmitButton>
                            </form>
                            <form action={updateTaskAction}>
                              <input type="hidden" name="taskId" value={item.id} />
                              <input type="hidden" name="status" value="completed" />
                              <SubmitButton className={teamButtonClass("secondary", "sm")} pendingLabel="Saving...">
                                Done
                              </SubmitButton>
                            </form>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <aside className="rounded-2xl border border-slate-200 bg-white p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Schedule a follow-up</p>
              <p className="mt-1 text-xs text-slate-600">
                This creates a task + SMS reminder for the assigned rep. No automatic cadence runs for canvass leads.
              </p>
              <form action={createCanvassFollowupAction} className="mt-3 flex flex-col gap-2">
                <label className="flex flex-col gap-1 text-xs text-slate-600">
                  <span className="font-semibold uppercase tracking-[0.18em] text-slate-500">Contact</span>
                  <input name="contactId" className={TEAM_INPUT_COMPACT} defaultValue={initialContactId ?? ""} required />
                </label>
                <label className="flex flex-col gap-1 text-xs text-slate-600">
                  <span className="font-semibold uppercase tracking-[0.18em] text-slate-500">Due at</span>
                  <input name="dueAt" type="datetime-local" className={TEAM_INPUT_COMPACT} required />
                </label>
                <label className="flex flex-col gap-1 text-xs text-slate-600">
                  <span className="font-semibold uppercase tracking-[0.18em] text-slate-500">Assigned to</span>
                  <select name="assignedTo" className={TEAM_INPUT_COMPACT} defaultValue={memberId ?? ""}>
                    <option value="">Default assignee</option>
                    {members.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs text-slate-600">
                  <span className="font-semibold uppercase tracking-[0.18em] text-slate-500">Notes (optional)</span>
                  <textarea name="notes" rows={3} className={TEAM_INPUT_COMPACT} />
                </label>
                <SubmitButton className={teamButtonClass("primary", "sm")} pendingLabel="Scheduling...">
                  Schedule follow-up
                </SubmitButton>
              </form>
            </aside>
          </div>
        )}
      </div>
    </section>
  );
}
