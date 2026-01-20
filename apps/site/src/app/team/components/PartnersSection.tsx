import { SubmitButton } from "@/components/SubmitButton";
import { callAdminApi } from "../lib/api";
import {
  openContactThreadAction,
  partnerLogReferralAction,
  partnerLogTouchAction,
  partnerPortalInviteUserAction,
  partnerPortalSaveRatesAction,
  partnerScheduleCheckinAction,
  startContactCallAction
} from "../actions";
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
  selectedId?: string;
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
  setIf("p_selected", merged.selectedId);
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
  const selectedId = normalizeFilter(resolvedFilters.selectedId);

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

  type PortalUserRow = {
    id: string;
    email: string;
    phone: string | null;
    phoneE164: string | null;
    name: string;
    active: boolean;
    passwordSetAt: string | null;
  };

  type RateItemRow = {
    id: string;
    serviceKey: string;
    tierKey: string;
    label: string | null;
    amountCents: number;
    sortOrder: number;
  };

  let portalUsers: PortalUserRow[] = [];
  let rateItems: RateItemRow[] = [];
  let rateCurrency = "USD";

  if (selectedId) {
    try {
      const [usersRes, ratesRes] = await Promise.all([
        callAdminApi(`/api/admin/partners/users?orgContactId=${encodeURIComponent(selectedId)}`),
        callAdminApi(`/api/admin/partners/rates?orgContactId=${encodeURIComponent(selectedId)}`)
      ]);

      if (usersRes.ok) {
        const usersPayload = (await usersRes.json().catch(() => ({}))) as { users?: PortalUserRow[] };
        portalUsers = usersPayload.users ?? [];
      }

      if (ratesRes.ok) {
        const ratesPayload = (await ratesRes.json().catch(() => ({}))) as { currency?: string; items?: RateItemRow[] };
        rateCurrency =
          typeof ratesPayload.currency === "string" && ratesPayload.currency.trim().length
            ? ratesPayload.currency.trim()
            : "USD";
        rateItems = ratesPayload.items ?? [];
      }
    } catch {
      // ignore
    }
  }

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

      {selectedId ? (
        <div className={`${TEAM_CARD_PADDED} space-y-6`}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-slate-900">Partner Portal Access</h3>
              <p className="mt-1 text-xs text-slate-500">
                Invite portal users and configure negotiated rates for this partner.
              </p>
            </div>
            <a
              className={teamButtonClass("secondary", "sm")}
              href={buildPartnersHref({ filters: resolvedFilters, patch: { selectedId: "" } })}
            >
              Close
            </a>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <h4 className="text-sm font-semibold text-slate-900">Invite user</h4>
              <p className="mt-1 text-xs text-slate-500">
                Sends a magic link. They can set a password after logging in.
              </p>
              <form action={partnerPortalInviteUserAction} className="mt-3 space-y-3">
                <input type="hidden" name="orgContactId" value={selectedId} />
                <label className="block">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Name</div>
                  <input name="name" className={TEAM_INPUT_COMPACT} placeholder="Jane Doe" />
                </label>
                <label className="block">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Email</div>
                  <input name="email" type="email" className={TEAM_INPUT_COMPACT} placeholder="jane@example.com" />
                </label>
                <label className="block">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Phone (optional)</div>
                  <input name="phone" className={TEAM_INPUT_COMPACT} placeholder="+1 404-555-1234" />
                </label>
                <SubmitButton className={teamButtonClass("primary", "sm")} pendingLabel="Sending...">
                  Send invite
                </SubmitButton>
              </form>

              <div className="mt-4 border-t border-slate-100 pt-4">
                <h5 className="text-xs font-semibold text-slate-700">Existing users</h5>
                {portalUsers.length === 0 ? (
                  <div className="mt-2 text-xs text-slate-500">No portal users yet.</div>
                ) : (
                  <ul className="mt-2 space-y-2 text-xs text-slate-600">
                    {portalUsers.map((user) => (
                      <li key={user.id} className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2">
                        <div className="flex items-center justify-between gap-2">
                          <div className="font-semibold text-slate-900">{user.name}</div>
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                              user.active ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"
                            }`}
                          >
                            {user.active ? "active" : "inactive"}
                          </span>
                        </div>
                        <div className="mt-1 text-[11px] text-slate-500">{user.email}</div>
                        {user.phoneE164 || user.phone ? (
                          <div className="mt-1 text-[11px] text-slate-500">{user.phoneE164 ?? user.phone}</div>
                        ) : null}
                        <div className="mt-1 text-[11px] text-slate-500">
                          Password: {user.passwordSetAt ? `set (${formatDateTime(user.passwordSetAt)})` : "not set"}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <h4 className="text-sm font-semibold text-slate-900">Partner rates</h4>
              <p className="mt-1 text-xs text-slate-500">
                Explicit dollar tiers per service (currency: {rateCurrency}). Format:{" "}
                <span className="font-mono">serviceKey,tierKey,label,amount</span>
              </p>

              {rateItems.length ? (
                <div className="mt-3 rounded-xl border border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-700">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Current</div>
                  <ul className="mt-2 space-y-1">
                    {rateItems.map((item) => (
                      <li key={item.id}>
                        <span className="font-semibold">{item.serviceKey}</span> / {item.tierKey}
                        {" — "}
                        {item.label ? `${item.label} — ` : ""}${(item.amountCents / 100).toFixed(2)}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <div className="mt-3 text-xs text-slate-500">No negotiated rates set yet.</div>
              )}

              <form action={partnerPortalSaveRatesAction} className="mt-3 space-y-3">
                <input type="hidden" name="orgContactId" value={selectedId} />
                <textarea
                  name="ratesCsv"
                  className="min-h-[160px] w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                  placeholder={
                    "junk-removal,quarter,Quarter load,150\\n" +
                    "junk-removal,half,Half load,300\\n" +
                    "junk-removal,full,Full load,600\\n" +
                    "junk-removal,mattress_fee,Mattress fee,40"
                  }
                />
                <SubmitButton className={teamButtonClass("primary", "sm")} pendingLabel="Saving...">
                  Save rates
                </SubmitButton>
              </form>
            </div>
          </div>
        </div>
      ) : null}

      <div className={TEAM_CARD_PADDED}>
        <form method="get" action="/team" className="grid gap-3 rounded-2xl border border-slate-200 bg-white p-4">
          <input type="hidden" name="tab" value="partners" />
          {selectedId ? <input type="hidden" name="p_selected" value={selectedId} /> : null}

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
                          <a
                            className={teamButtonClass("secondary", "sm")}
                            href={buildPartnersHref({ filters: resolvedFilters, patch: { selectedId: partner.id } })}
                          >
                            Portal
                          </a>
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
