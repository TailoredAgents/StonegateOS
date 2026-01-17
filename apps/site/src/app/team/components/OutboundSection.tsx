import { SubmitButton } from "@/components/SubmitButton";
import { callAdminApi } from "../lib/api";
import {
  importOutboundProspectsAction,
  openContactThreadAction,
  setOutboundDispositionAction,
  startContactCallAction
} from "../actions";
import { TEAM_CARD_PADDED, TEAM_EMPTY_STATE, TEAM_INPUT, TEAM_INPUT_COMPACT, TEAM_SECTION_SUBTITLE, TEAM_SECTION_TITLE } from "./team-ui";

type TeamMember = { id: string; name: string; active?: boolean };

type OutboundQueueItem = {
  id: string;
  title: string | null;
  dueAt: string | null;
  overdue: boolean;
  minutesUntilDue: number | null;
  attempt: number;
  campaign: string | null;
  lastDisposition: string | null;
  contact: {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    source: string | null;
  };
};

function formatDue(item: OutboundQueueItem): string {
  if (!item.dueAt) return "No due time";
  const due = new Date(item.dueAt);
  if (Number.isNaN(due.getTime())) return item.dueAt;
  return due.toLocaleString();
}

function formatDueBadge(item: OutboundQueueItem): { label: string; tone: string } {
  if (!item.dueAt) {
    return { label: "No due", tone: "bg-slate-100 text-slate-600" };
  }
  if (item.overdue) {
    return { label: "Overdue", tone: "bg-rose-100 text-rose-700" };
  }
  if (typeof item.minutesUntilDue === "number") {
    if (item.minutesUntilDue <= 0) return { label: "Due now", tone: "bg-amber-100 text-amber-700" };
    if (item.minutesUntilDue < 60) return { label: `Due in ${item.minutesUntilDue}m`, tone: "bg-amber-50 text-amber-700" };
  }
  return { label: "Scheduled", tone: "bg-slate-100 text-slate-600" };
}

export async function OutboundSection({ memberId }: { memberId?: string }): Promise<React.ReactElement> {
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

  const qs = new URLSearchParams({ limit: "100" });
  if (memberId) qs.set("memberId", memberId);
  const queueRes = await callAdminApi(`/api/admin/outbound/queue?${qs.toString()}`);
  if (!queueRes.ok) {
    throw new Error("Failed to load outbound queue");
  }
  const queuePayload = (await queueRes.json()) as { memberId?: string | null; items?: OutboundQueueItem[] };
  const items = queuePayload.items ?? [];
  const resolvedMemberId = (typeof queuePayload.memberId === "string" ? queuePayload.memberId : null) ?? memberId ?? "";
  const memberLabel = resolvedMemberId ? members.find((m) => m.id === resolvedMemberId)?.name ?? null : null;

  return (
    <section className="space-y-6">
      <header className={TEAM_CARD_PADDED}>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className={TEAM_SECTION_TITLE}>Outbound Prospects</h2>
            <p className={TEAM_SECTION_SUBTITLE}>
              Cold commercial outreach list. This queue is intentionally separate from inbound leads and Sales HQ.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-600">
              <span className="rounded-full bg-slate-100 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
                Outbound • Commercial • Property Managers
              </span>
              {memberLabel ? (
                <span className="rounded-full bg-primary-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-primary-700">
                  Assigned to {memberLabel}
                </span>
              ) : null}
            </div>
          </div>
          <form method="get" action="/team" className="flex flex-col gap-2 text-sm text-slate-600 sm:items-end">
            <input type="hidden" name="tab" value="outbound" />
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">View queue for</span>
              <select name="memberId" defaultValue={resolvedMemberId} className={TEAM_INPUT_COMPACT}>
                <option value="">Default assignee</option>
                {members.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 shadow-sm transition hover:border-primary-300 hover:text-primary-700">
              Update
            </button>
          </form>
        </div>
      </header>

      <div className={TEAM_CARD_PADDED}>
        <h3 className="text-base font-semibold text-slate-900">Import prospects</h3>
        <p className="mt-1 text-sm text-slate-600">
          Paste a CSV (or upload one) and we&apos;ll create contacts + an outbound task. These will be labeled clearly as outbound.
        </p>
        <form action={importOutboundProspectsAction} className="mt-4 grid gap-4">
          <div className="grid gap-4 md:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm text-slate-600">
              <span>Campaign</span>
              <input name="campaign" className={TEAM_INPUT} defaultValue="property_management" />
            </label>
            <label className="flex flex-col gap-1 text-sm text-slate-600">
              <span>Assign to</span>
              <select name="assignedToMemberId" defaultValue={resolvedMemberId} className={TEAM_INPUT}>
                <option value="">Default assignee</option>
                {members.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="flex flex-col gap-1 text-sm text-slate-600">
            <span>CSV</span>
            <textarea
              name="csv"
              className={`${TEAM_INPUT} min-h-[160px] font-mono text-xs`}
              placeholder={"company,contactName,phone,email,city,state,zip,notes\nAcme Property Mgmt,Jane Doe,555-555-5555,jane@acme.com,Atlanta,GA,30303,\"prefers email\""}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-slate-600">
            <span>Or upload CSV</span>
            <input name="file" type="file" accept=".csv,text/csv,text/plain" className="text-sm text-slate-600" />
          </label>

          <div className="flex flex-wrap gap-3">
            <SubmitButton className="rounded-full bg-primary-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-primary-200/50 transition hover:bg-primary-700" pendingLabel="Importing...">
              Import outbound list
            </SubmitButton>
            <p className="text-xs text-slate-500">
              Required per row: email or phone. Name/company optional. Max 2000 rows per import.
            </p>
          </div>
        </form>
      </div>

      <div className={TEAM_CARD_PADDED}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-base font-semibold text-slate-900">Queue</h3>
            <p className="mt-1 text-sm text-slate-600">
              Work the list like a dialer: call, log a disposition, and we&apos;ll schedule the next touch.
            </p>
          </div>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
            {items.length} open
          </span>
        </div>

        {items.length === 0 ? (
          <div className={`${TEAM_EMPTY_STATE} mt-4`}>
            No outbound tasks right now. Import a list to get started.
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            {items.map((item) => {
              const dueBadge = formatDueBadge(item);
              return (
                <div key={item.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
                          Outbound
                        </span>
                        {item.campaign ? (
                          <span className="rounded-full bg-primary-50 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-primary-700">
                            {item.campaign}
                          </span>
                        ) : null}
                        <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${dueBadge.tone}`}>
                          {dueBadge.label}
                        </span>
                        <span className="text-xs text-slate-500">Attempt {item.attempt}</span>
                      </div>
                      <p className="mt-2 truncate text-sm font-semibold text-slate-900">{item.contact.name}</p>
                      <p className="mt-1 text-xs text-slate-600">
                        {item.contact.phone ?? "No phone"} • {item.contact.email ?? "No email"}
                      </p>
                      <p className="mt-1 text-[11px] text-slate-500">
                        {item.lastDisposition ? `Last: ${item.lastDisposition} • ` : ""}
                        Due: {formatDue(item)}
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <form action={startContactCallAction}>
                        <input type="hidden" name="contactId" value={item.contact.id} />
                        <SubmitButton className="rounded-full bg-primary-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-primary-200/40 transition hover:bg-primary-700" pendingLabel="Calling...">
                          Call (Stonegate #)
                        </SubmitButton>
                      </form>
                      <form action={openContactThreadAction}>
                        <input type="hidden" name="contactId" value={item.contact.id} />
                        <input type="hidden" name="channel" value="sms" />
                        <SubmitButton className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 shadow-sm transition hover:border-primary-300 hover:text-primary-700" pendingLabel="Opening...">
                          Message (SMS)
                        </SubmitButton>
                      </form>
                      <a
                        className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 shadow-sm transition hover:border-primary-300 hover:text-primary-700"
                        href={`/team?tab=contacts&contactId=${encodeURIComponent(item.contact.id)}`}
                      >
                        Open contact
                      </a>
                    </div>
                  </div>

                  <form action={setOutboundDispositionAction} className="mt-4 grid gap-3 sm:grid-cols-3">
                    <input type="hidden" name="taskId" value={item.id} />
                    <label className="flex flex-col gap-1 text-xs text-slate-600">
                      <span>Disposition</span>
                      <select name="disposition" className={TEAM_INPUT_COMPACT} defaultValue="no_answer">
                        <option value="connected">Connected</option>
                        <option value="no_answer">No answer</option>
                        <option value="left_voicemail">Left voicemail</option>
                        <option value="callback_requested">Callback requested</option>
                        <option value="email_sent">Emailed</option>
                        <option value="not_interested">Not interested (stop)</option>
                        <option value="wrong_number">Wrong number (stop)</option>
                        <option value="dnc">Do not contact (stop)</option>
                        <option value="spam">Spam (stop)</option>
                      </select>
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-slate-600">
                      <span>Callback time (optional)</span>
                      <input name="callbackAt" type="datetime-local" className={TEAM_INPUT_COMPACT} />
                    </label>
                    <div className="flex items-end">
                      <SubmitButton className="w-full rounded-full bg-slate-900 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-slate-200/40 transition hover:bg-slate-800" pendingLabel="Saving...">
                        Save disposition
                      </SubmitButton>
                    </div>
                  </form>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

