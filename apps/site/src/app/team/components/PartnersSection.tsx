import { SubmitButton } from "@/components/SubmitButton";
import { callAdminApi } from "../lib/api";
import { partnerLogReferralAction, partnerLogTouchAction, partnerScheduleCheckinAction, openContactThreadAction, startContactCallAction } from "../actions";
import { TEAM_CARD_PADDED, TEAM_EMPTY_STATE, TEAM_INPUT_COMPACT, TEAM_SECTION_SUBTITLE, TEAM_SECTION_TITLE, teamButtonClass } from "./team-ui";

type TeamMember = { id: string; name: string; active?: boolean };

type PartnerRow = {
  id: string;
  company: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  partnerStatus: string;
  partnerType: string | null;
  partnerOwnerMemberId: string | null;
  partnerOwnerName: string | null;
  partnerSince: string | null;
  partnerLastTouchAt: string | null;
  partnerNextTouchAt: string | null;
  partnerReferralCount: number;
  partnerLastReferralAt: string | null;
};

type PartnersResponse = {
  ok: true;
  total: number;
  offset: number;
  limit: number;
  partners: PartnerRow[];
};

type PartnerFilters = {
  status?: string;
  ownerId?: string;
  type?: string;
  q?: string;
  offset?: string;
};

function normalizeFilter(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function formatDateTime(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}

function formatDueBadge(nextTouchAt: string | null): { label: string; tone: string } {
  if (!nextTouchAt) return { label: "Not scheduled", tone: "bg-slate-100 text-slate-600" };
  const due = new Date(nextTouchAt);
  if (Number.isNaN(due.getTime())) return { label: "Scheduled", tone: "bg-slate-100 text-slate-600" };
  const minutes = Math.round((due.getTime() - Date.now()) / 60_000);
  if (minutes < -10) return { label: "Overdue", tone: "bg-rose-100 text-rose-700" };
  if (minutes <= 0) return { label: "Due now", tone: "bg-amber-100 text-amber-700" };
  if (minutes < 60) return { label: `Due in ${minutes}m`, tone: "bg-amber-50 text-amber-700" };
  return { label: "Scheduled", tone: "bg-slate-100 text-slate-600" };
}

function buildPartnersHref(args: { filters: PartnerFilters; patch?: Partial<PartnerFilters> }): string {
  const merged: PartnerFilters = { ...args.filters, ...(args.patch ?? {}) };
  const qs = new URLSearchParams();
  qs.set("tab", "partners");

  const setIf = (key: string, value: string | undefined) => {
    if (!value) return;
    const trimmed = value.trim();
    if (!trimmed) return;
    qs.set(key, trimmed);
  };

  setIf("p_status", merged.status);
  setIf("p_owner", merged.ownerId);
  setIf("p_type", merged.type);
  setIf("p_q", merged.q);
  setIf("p_offset", merged.offset);
  return `/team?${qs.toString()}`;
}

export async function PartnersSection({ filters }: { filters?: PartnerFilters }): Promise<React.ReactElement> {
  const resolvedFilters: PartnerFilters = filters ?? {};

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

  const status = normalizeFilter(resolvedFilters.status) || "partner";
  const ownerId = normalizeFilter(resolvedFilters.ownerId);
  const type = normalizeFilter(resolvedFilters.type);
  const q = normalizeFilter(resolvedFilters.q);
  const offset = normalizeFilter(resolvedFilters.offset);

  const apiQs = new URLSearchParams({ limit: "50", status });
  if (ownerId) apiQs.set("ownerId", ownerId);
  if (type) apiQs.set("type", type);
  if (q) apiQs.set("q", q);
  if (offset) apiQs.set("offset", offset);

  let payload: PartnersResponse | null = null;
  try {
    const res = await callAdminApi(`/api/admin/partners?${apiQs.toString()}`);
    if (res.ok) {
      payload = (await res.json()) as PartnersResponse;
    }
  } catch {
    payload = null;
  }

  const partners = payload?.partners ?? [];
  const total = payload?.total ?? 0;
  const currentOffset = payload?.offset ?? 0;
  const limit = payload?.limit ?? 50;
  const prevOffset = Math.max(0, currentOffset - limit);
  const nextOffset = currentOffset + partners.length < total ? currentOffset + limit : null;

  return (
    <section className="space-y-6">
      <header className={TEAM_CARD_PADDED}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className={TEAM_SECTION_TITLE}>Partners</h2>
            <p className={TEAM_SECTION_SUBTITLE}>
              Manage recurring referral relationships. Partners have a lightweight check-in cadence so they don&apos;t get lost in the day-to-day inbound lead flow.
            </p>
          </div>
          <div className="text-right text-xs text-slate-500">
            {total > 0 ? (
              <span>
                Showing {Math.min(currentOffset + 1, total)}-{Math.min(currentOffset + partners.length, total)} of {total}
              </span>
            ) : (
              <span>No partners found</span>
            )}
          </div>
        </div>
      </header>

      <div className={TEAM_CARD_PADDED}>
        <form method="get" action="/team" className="grid gap-3 rounded-2xl border border-slate-200 bg-white p-4">
          <input type="hidden" name="tab" value="partners" />

          <div className="grid gap-3 md:grid-cols-4">
            <label className="flex flex-col gap-1 text-xs text-slate-600">
              <span className="font-semibold uppercase tracking-[0.18em] text-slate-500">Status</span>
              <select name="p_status" defaultValue={status} className={TEAM_INPUT_COMPACT}>
                <option value="partner">Partner</option>
                <option value="prospect">Prospect</option>
                <option value="contacted">Contacted</option>
                <option value="inactive">Inactive</option>
                <option value="none">None</option>
              </select>
            </label>

            <label className="flex flex-col gap-1 text-xs text-slate-600">
              <span className="font-semibold uppercase tracking-[0.18em] text-slate-500">Owner</span>
              <select name="p_owner" defaultValue={ownerId} className={TEAM_INPUT_COMPACT}>
                <option value="">Any owner</option>
                {members.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-xs text-slate-600">
              <span className="font-semibold uppercase tracking-[0.18em] text-slate-500">Type</span>
              <input name="p_type" defaultValue={type} className={TEAM_INPUT_COMPACT} placeholder="property_manager" />
            </label>

            <label className="flex flex-col gap-1 text-xs text-slate-600">
              <span className="font-semibold uppercase tracking-[0.18em] text-slate-500">Search</span>
              <input name="p_q" defaultValue={q} className={TEAM_INPUT_COMPACT} placeholder="Company, name, phone..." />
            </label>
          </div>

          <div className="flex flex-wrap gap-2">
            <SubmitButton className={teamButtonClass("primary", "sm")} pendingLabel="Loading...">
              Apply filters
            </SubmitButton>
            <a className={teamButtonClass("secondary", "sm")} href="/team?tab=partners">
              Reset
            </a>
          </div>
        </form>

        {partners.length === 0 ? (
          <div className={TEAM_EMPTY_STATE}>No partners match these filters yet.</div>
        ) : (
          <div className="mt-4 overflow-x-auto rounded-2xl border border-slate-200 bg-white">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                <tr>
                  <th className="px-4 py-3 text-left">Next</th>
                  <th className="px-4 py-3 text-left">Partner</th>
                  <th className="px-4 py-3 text-left">Owner</th>
                  <th className="px-4 py-3 text-left">Referrals</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {partners.map((partner) => {
                  const dueBadge = formatDueBadge(partner.partnerNextTouchAt);
                  const ownerLabel = partner.partnerOwnerName ?? "Unassigned";
                  const companyLine = partner.company ? `${partner.company} • ` : "";
                  const contactLine = `${companyLine}${partner.name}`;
                  const detailBits = [partner.phone, partner.email].filter(Boolean).join(" • ");
                  return (
                    <tr key={partner.id} className="hover:bg-slate-50">
                      <td className="px-4 py-4 align-top">
                        <span className={`inline-flex items-center rounded-full px-3 py-1 text-[11px] font-semibold ${dueBadge.tone}`}>{dueBadge.label}</span>
                        {partner.partnerNextTouchAt ? (
                          <div className="mt-2 text-xs text-slate-500">{formatDateTime(partner.partnerNextTouchAt)}</div>
                        ) : null}
                      </td>
                      <td className="px-4 py-4 align-top">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-semibold text-slate-900">{contactLine}</span>
                          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600">
                            {partner.partnerStatus}
                          </span>
                          {partner.partnerType ? (
                            <span className="rounded-full bg-primary-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary-700">
                              {partner.partnerType}
                            </span>
                          ) : null}
                        </div>
                        {detailBits ? <div className="mt-2 text-xs text-slate-600">{detailBits}</div> : null}
                        {partner.partnerLastTouchAt ? (
                          <div className="mt-1 text-[11px] text-slate-500">Last touch: {formatDateTime(partner.partnerLastTouchAt)}</div>
                        ) : null}
                      </td>
                      <td className="px-4 py-4 align-top text-xs text-slate-700">
                        <div className="font-semibold text-slate-900">{ownerLabel}</div>
                        {partner.partnerSince ? (
                          <div className="mt-1 text-[11px] text-slate-500">Partner since {formatDateTime(partner.partnerSince)}</div>
                        ) : null}
                      </td>
                      <td className="px-4 py-4 align-top text-xs text-slate-700">
                        <div className="text-sm font-semibold text-slate-900">{partner.partnerReferralCount ?? 0}</div>
                        {partner.partnerLastReferralAt ? (
                          <div className="mt-1 text-[11px] text-slate-500">Last referral {formatDateTime(partner.partnerLastReferralAt)}</div>
                        ) : null}
                      </td>
                      <td className="px-4 py-4 align-top text-right">
                        <div className="flex flex-wrap justify-end gap-2">
                          <form action={startContactCallAction}>
                            <input type="hidden" name="contactId" value={partner.id} />
                            <SubmitButton className={teamButtonClass("primary", "sm")} pendingLabel="Calling...">
                              Call
                            </SubmitButton>
                          </form>
                          <form action={openContactThreadAction}>
                            <input type="hidden" name="contactId" value={partner.id} />
                            <input type="hidden" name="channel" value={partner.email ? "email" : "sms"} />
                            <SubmitButton className={teamButtonClass("secondary", "sm")} pendingLabel="Opening...">
                              Message
                            </SubmitButton>
                          </form>
                          <form action={partnerLogReferralAction}>
                            <input type="hidden" name="contactId" value={partner.id} />
                            <SubmitButton className={teamButtonClass("secondary", "sm")} pendingLabel="Saving...">
                              + Referral
                            </SubmitButton>
                          </form>
                          <form action={partnerLogTouchAction}>
                            <input type="hidden" name="contactId" value={partner.id} />
                            <input type="hidden" name="nextTouchDays" value="30" />
                            <SubmitButton className={teamButtonClass("secondary", "sm")} pendingLabel="Saving...">
                              Log touch
                            </SubmitButton>
                          </form>
                          <form action={partnerScheduleCheckinAction}>
                            <input type="hidden" name="contactId" value={partner.id} />
                            <input type="hidden" name="daysFromNow" value="7" />
                            <SubmitButton className={teamButtonClass("secondary", "sm")} pendingLabel="Scheduling...">
                              Check-in 7d
                            </SubmitButton>
                          </form>
                          <a className={teamButtonClass("secondary", "sm")} href={`/team?tab=contacts&contactId=${encodeURIComponent(partner.id)}`}>
                            Open
                          </a>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-4 flex items-center justify-between text-xs text-slate-600">
          <div className="flex items-center gap-2">
            {currentOffset > 0 ? (
              <a className={teamButtonClass("secondary", "sm")} href={buildPartnersHref({ filters: resolvedFilters, patch: { offset: String(prevOffset) } })}>
                Prev
              </a>
            ) : (
              <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-2 font-semibold text-slate-400">Prev</span>
            )}
            {nextOffset !== null ? (
              <a className={teamButtonClass("secondary", "sm")} href={buildPartnersHref({ filters: resolvedFilters, patch: { offset: String(nextOffset) } })}>
                Next
              </a>
            ) : (
              <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-2 font-semibold text-slate-400">Next</span>
            )}
          </div>
          <span className="text-[11px] text-slate-500">Tip: use “Log touch” after a call/email so the check-in cadence stays accurate.</span>
        </div>
      </div>
    </section>
  );
}
