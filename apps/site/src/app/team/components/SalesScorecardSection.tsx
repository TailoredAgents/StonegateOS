import React from "react";
import { SubmitButton } from "@/components/SubmitButton";
import { cookies } from "next/headers";
import { ADMIN_SESSION_COOKIE, getAdminKey } from "@/lib/admin-session";
import { callAdminApi } from "../lib/api";
import { resetSalesHqAction } from "../actions";
import { TEAM_TIME_ZONE } from "../lib/timezone";

type ScorecardPayload = {
  ok: true;
  memberId: string;
  rangeDays: number;
  config?: {
    trackingStartAt?: string | null;
    weights?: {
      speedToLead?: number;
      followupCompliance?: number;
      conversion?: number;
      responseTime?: number;
    };
  };
  score: {
    total: number;
    speedToLead: number;
    followupCompliance: number;
    conversion: number;
    responseTime: number;
  };
  metrics: {
    speedToLead: { totalLeads: number; met: number; missed: number };
    followups: { totalDue: number; completedOnTime: number; completedLate: number; stillOpen: number };
    conversion: { totalLeads: number; booked: number; won: number };
    responseTime: { medianMinutes: number | null; label: string };
  };
};

type QueuePayload = {
  ok: true;
  memberId: string;
  now: string;
  items: Array<{
    id: string;
    leadId: string | null;
    contact: {
      id: string;
      name: string;
      phone: string | null;
      postalCode: string | null;
      serviceAreaStatus: "unknown" | "ok" | "potentially_out_of_area";
    };
    title: string;
    dueAt: string | null;
    overdue: boolean;
    minutesUntilDue: number | null;
    kind: "speed_to_lead" | "follow_up";
  }>;
};

type TeamMemberPayload = {
  members?: Array<{ id: string; name: string; active: boolean }>;
};

function Pill({
  tone,
  children
}: {
  tone: "good" | "warn" | "bad" | "neutral";
  children: React.ReactNode;
}) {
  const classes =
    tone === "good"
      ? "bg-emerald-100 text-emerald-700 border-emerald-200"
      : tone === "warn"
        ? "bg-amber-100 text-amber-800 border-amber-200"
        : tone === "bad"
          ? "bg-rose-100 text-rose-700 border-rose-200"
          : "bg-slate-100 text-slate-600 border-slate-200";
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold ${classes}`}>
      {children}
    </span>
  );
}

function ScoreRing({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, value));
  const stroke = 10;
  const r = 36;
  const c = 2 * Math.PI * r;
  const offset = c - (pct / 100) * c;
  const tone = pct >= 85 ? "#10b981" : pct >= 65 ? "#f59e0b" : "#ef4444";
  return (
    <div className="relative h-24 w-24">
      <svg viewBox="0 0 100 100" className="h-24 w-24">
        <circle cx="50" cy="50" r={r} fill="none" stroke="#e2e8f0" strokeWidth={stroke} />
        <circle
          cx="50"
          cy="50"
          r={r}
          fill="none"
          stroke={tone}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${c} ${c}`}
          strokeDashoffset={offset}
          transform="rotate(-90 50 50)"
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="text-center">
          <div className="text-2xl font-semibold text-slate-900">{pct}</div>
          <div className="text-[11px] font-medium text-slate-500">score</div>
        </div>
      </div>
    </div>
  );
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function normalizeScore(score: number, weight: number): number {
  if (!weight || !Number.isFinite(weight) || weight <= 0) return 0;
  return clampPercent((score / weight) * 100);
}

export async function SalesScorecardSection(): Promise<React.ReactElement> {
  const rangeDays = 7;
  let scorecard: ScorecardPayload | null = null;
  let queue: QueuePayload | null = null;
  let members: TeamMemberPayload["members"] = [];
  let error: string | null = null;
  const adminKey = getAdminKey();
  const jar = await cookies();
  const isOwnerSession = Boolean(adminKey && jar.get(ADMIN_SESSION_COOKIE)?.value === adminKey);

  try {
    const [scoreRes, queueRes, membersRes] = await Promise.all([
      callAdminApi(`/api/admin/sales/scorecard?rangeDays=${rangeDays}`),
      callAdminApi(`/api/admin/sales/queue`),
      callAdminApi(`/api/admin/team/members`)
    ]);

    if (scoreRes.ok) scorecard = (await scoreRes.json()) as ScorecardPayload;
    if (queueRes.ok) queue = (await queueRes.json()) as QueuePayload;
    if (membersRes.ok) {
      const payload = (await membersRes.json()) as TeamMemberPayload;
      members = payload.members ?? [];
    }

    if (!scoreRes.ok) error = `Scorecard unavailable (HTTP ${scoreRes.status})`;
    if (!queueRes.ok) error = error ?? `Queue unavailable (HTTP ${queueRes.status})`;
  } catch {
    error = "Sales scorecard unavailable.";
  }

  const score = scorecard?.score.total ?? 0;
  const weights = {
    speedToLead: scorecard?.config?.weights?.speedToLead ?? 45,
    followupCompliance: scorecard?.config?.weights?.followupCompliance ?? 35,
    conversion: scorecard?.config?.weights?.conversion ?? 10,
    responseTime: scorecard?.config?.weights?.responseTime ?? 10
  };

  const subScores = {
    speedToLead: normalizeScore(scorecard?.score.speedToLead ?? 0, weights.speedToLead),
    followups: normalizeScore(scorecard?.score.followupCompliance ?? 0, weights.followupCompliance),
    conversion: normalizeScore(scorecard?.score.conversion ?? 0, weights.conversion),
    response: normalizeScore(scorecard?.score.responseTime ?? 0, weights.responseTime)
  };

  const speed = scorecard?.metrics.speedToLead;
  const followups = scorecard?.metrics.followups;

  const memberLabel =
    members?.find((member) => member.id === scorecard?.memberId)?.name ??
    members?.find((member) => member.id === queue?.memberId)?.name ??
    null;
  const trackingStartAt = typeof scorecard?.config?.trackingStartAt === "string" ? scorecard?.config?.trackingStartAt : null;

  const urgentItems = (queue?.items ?? []).filter((item) => item.kind === "speed_to_lead").slice(0, 10);
  const followupItems = (queue?.items ?? []).filter((item) => item.kind === "follow_up").slice(0, 20);

  return (
    <section className="rounded-3xl border border-white/70 bg-white/80 p-6 shadow-xl shadow-slate-200/60 backdrop-blur sm:p-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Sales HQ</h2>
          <p className="mt-1 text-sm text-slate-600">
            7-day snapshot: speed-to-lead + follow-ups (call-first when a phone exists).
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-600">
            {memberLabel ? <Pill tone="neutral">Viewing: {memberLabel}</Pill> : null}
            {trackingStartAt ? (
              <Pill tone="neutral">
                Tracking since: {new Date(trackingStartAt).toLocaleString(undefined, { timeZone: TEAM_TIME_ZONE })}
              </Pill>
            ) : null}
            {trackingStartAt ? (
              <span className="text-[11px] text-slate-500">Leads created before this won’t appear in Sales HQ.</span>
            ) : null}
          </div>
          {error ? <p className="mt-2 text-sm text-rose-700">{error}</p> : null}
        </div>
        <div className="flex items-center gap-4">
          <ScoreRing value={score} />
          <div className="space-y-2 text-sm">
            <div className="flex items-center justify-between gap-6">
              <span className="text-slate-600">Speed-to-lead</span>
              <span className="font-semibold text-slate-900">{subScores.speedToLead}</span>
            </div>
            <div className="flex items-center justify-between gap-6">
              <span className="text-slate-600">Follow-ups</span>
              <span className="font-semibold text-slate-900">{subScores.followups}</span>
            </div>
            <div className="flex items-center justify-between gap-6">
              <span className="text-slate-600">Conversion</span>
              <span className="font-semibold text-slate-900">{subScores.conversion}</span>
            </div>
            <div className="flex items-center justify-between gap-6">
              <span className="text-slate-600">Response</span>
              <span className="font-semibold text-slate-900">{subScores.response}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Speed-to-lead</p>
            {speed ? (
              <Pill tone={speed.missed === 0 ? "good" : speed.missed <= 2 ? "warn" : "bad"}>
                {speed.met}/{speed.totalLeads} met
              </Pill>
            ) : (
              <Pill tone="neutral">loading</Pill>
            )}
          </div>
          <p className="mt-2 text-sm text-slate-700">
            Requires a call attempt within 5 minutes when a phone exists.
          </p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Follow-ups</p>
            {followups ? (
              <Pill tone={followups.stillOpen === 0 ? "good" : followups.stillOpen <= 3 ? "warn" : "bad"}>
                {followups.completedOnTime}/{followups.totalDue} on time
              </Pill>
            ) : (
              <Pill tone="neutral">loading</Pill>
            )}
          </div>
          <p className="mt-2 text-sm text-slate-700">
            On-time = completed by due time + 10 minutes.
          </p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Quick Actions</p>
            <Pill tone="neutral">contacts</Pill>
          </div>
          <p className="mt-2 text-sm text-slate-700">
            Use the queue below to open the contact and call/text.
          </p>
          {isOwnerSession ? (
            <form action={resetSalesHqAction} className="mt-3">
              <SubmitButton
                className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:border-slate-300"
                pendingLabel="Clearing..."
              >
                Clear Sales HQ
              </SubmitButton>
            </form>
          ) : null}
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <div className="rounded-2xl border border-slate-200 bg-white">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <h3 className="text-sm font-semibold text-slate-900">Touch within 5 minutes</h3>
              <Pill tone={urgentItems.length === 0 ? "good" : "warn"}>{urgentItems.length} active</Pill>
            </div>
          <div className="divide-y divide-slate-100">
            {urgentItems.length ? (
              urgentItems.map((item) => (
                <div key={item.id} className="flex items-start justify-between gap-3 px-4 py-3">
                  <div>
                    <p className="text-sm font-semibold text-slate-900">{item.contact.name}</p>
                    <p className="mt-0.5 text-xs text-slate-500">{item.contact.phone ?? "Phone not on file yet"}</p>
                    <p className="mt-1 text-xs text-slate-600">{item.title}</p>
                    {item.contact.serviceAreaStatus === "potentially_out_of_area" ? (
                      <div className="mt-2">
                        <span className="inline-flex items-center rounded-full border border-rose-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-rose-700">
                          Verify ZIP{item.contact.postalCode ? ` (${item.contact.postalCode})` : ""}
                        </span>
                      </div>
                    ) : null}
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    {item.minutesUntilDue !== null ? (
                      <Pill tone={item.overdue ? "bad" : item.minutesUntilDue <= 2 ? "warn" : "neutral"}>
                        {item.overdue ? "overdue" : `in ${item.minutesUntilDue}m`}
                      </Pill>
                    ) : (
                      <Pill tone="neutral">unscheduled</Pill>
                    )}
                    <a
                      className="rounded-full border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-800 hover:border-slate-300"
                      href={`/team?tab=contacts&contactId=${encodeURIComponent(item.contact.id)}`}
                    >
                      Open contact
                    </a>
                  </div>
                </div>
              ))
            ) : (
              <p className="px-4 py-6 text-sm text-slate-600">No active speed-to-lead tasks.</p>
            )}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white">
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
            <h3 className="text-sm font-semibold text-slate-900">Follow-up queue</h3>
            <Pill tone="neutral">{followupItems.length} items</Pill>
          </div>
          <div className="divide-y divide-slate-100">
            {followupItems.length ? (
              followupItems.map((item) => (
                <div key={item.id} className="flex items-start justify-between gap-3 px-4 py-3">
                  <div>
                    <p className="text-sm font-semibold text-slate-900">{item.contact.name}</p>
                    <p className="mt-0.5 text-xs text-slate-500">{item.contact.phone ?? "Phone not on file yet"}</p>
                    <p className="mt-1 text-xs text-slate-600">{item.title}</p>
                    {item.contact.serviceAreaStatus === "potentially_out_of_area" ? (
                      <div className="mt-2">
                        <span className="inline-flex items-center rounded-full border border-rose-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-rose-700">
                          Verify ZIP{item.contact.postalCode ? ` (${item.contact.postalCode})` : ""}
                        </span>
                      </div>
                    ) : null}
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    {item.minutesUntilDue !== null ? (
                      <Pill tone={item.overdue ? "bad" : item.minutesUntilDue <= 10 ? "warn" : "neutral"}>
                        {item.overdue ? "overdue" : `in ${item.minutesUntilDue}m`}
                      </Pill>
                    ) : (
                      <Pill tone="neutral">unscheduled</Pill>
                    )}
                    <a
                      className="rounded-full border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-800 hover:border-slate-300"
                      href={`/team?tab=contacts&contactId=${encodeURIComponent(item.contact.id)}`}
                    >
                      Open contact
                    </a>
                  </div>
                </div>
              ))
            ) : (
              <p className="px-4 py-6 text-sm text-slate-600">No follow-ups scheduled yet.</p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
