import React from "react";
import { SubmitButton } from "@/components/SubmitButton";
import { callAdminApi } from "../lib/api";
import { TEAM_TIME_ZONE } from "../lib/timezone";
import { runSeoAutopublishAction } from "../actions";
import { TEAM_CARD_PADDED, TEAM_SECTION_SUBTITLE, TEAM_SECTION_TITLE } from "./team-ui";

type SeoStatusPayload = {
  ok: true;
  status: {
    now: string;
    lastAttemptAt: string | null;
    lastResult: unknown;
    invokedBy: string | null;
    codeVersion: string | null;
    disabled: boolean | null;
    openaiConfigured: boolean | null;
    brainModel: string | null;
    brainModelUsed: string | null;
    voiceModel: string | null;
    lastPublishedAt: string | null;
    publishedLast7Days: number;
    nextEligibleAt: string | null;
  };
  posts: Array<{
    id: string;
    slug: string;
    title: string;
    publishedAt: string | null;
    updatedAt: string | null;
  }>;
};

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TEAM_TIME_ZONE,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(d);
}

function fmtRelativeMinutes(nowIso: string, iso: string | null): string | null {
  if (!iso) return null;
  const now = new Date(nowIso);
  const d = new Date(iso);
  if (Number.isNaN(now.getTime()) || Number.isNaN(d.getTime())) return null;
  const minutes = Math.round((now.getTime() - d.getTime()) / (60 * 1000));
  if (!Number.isFinite(minutes)) return null;
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function describeResult(result: unknown): { tone: "good" | "warn" | "bad" | "neutral"; text: string } {
  if (!result || typeof result !== "object") return { tone: "neutral", text: "No runs recorded yet." };
  const r = result as any;
  if (r.ok === true && r.skipped === false && typeof r.slug === "string") {
    return { tone: "good", text: `Published: /blog/${r.slug}` };
  }
  if (r.ok === true && r.skipped === true && typeof r.reason === "string") {
    return { tone: "warn", text: `Skipped: ${r.reason}` };
  }
  if (r.ok === false && typeof r.error === "string") {
    return { tone: "bad", text: `Error: ${r.error}` };
  }
  return { tone: "neutral", text: "Run recorded." };
}

function Pill({ tone, children }: { tone: "good" | "warn" | "bad" | "neutral"; children: React.ReactNode }) {
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

export async function SeoAgentSection(): Promise<React.ReactElement> {
  let payload: SeoStatusPayload | null = null;
  let error: string | null = null;

  try {
    const res = await callAdminApi("/api/admin/seo/status");
    if (!res.ok) {
      error = `SEO status unavailable (HTTP ${res.status})`;
    } else {
      payload = (await res.json()) as SeoStatusPayload;
    }
  } catch {
    error = "SEO status unavailable.";
  }

  const status = payload?.status ?? null;
  const nowIso = status?.now ?? new Date().toISOString();
  const resultMeta = describeResult(status?.lastResult ?? null);
  const rel = fmtRelativeMinutes(nowIso, status?.lastAttemptAt ?? null);

  return (
    <section className="space-y-4">
      <header className={TEAM_CARD_PADDED}>
        <h2 className={TEAM_SECTION_TITLE}>SEO Agent</h2>
        <p className={TEAM_SECTION_SUBTITLE}>
          Shows whether the outbox worker is attempting SEO autopublish runs and what it last did. Use “Run now” to
          force a publish attempt.
        </p>
      </header>

      <div className={TEAM_CARD_PADDED}>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          <div className="rounded-2xl border border-slate-200 bg-white/70 p-4 shadow-sm shadow-slate-200/40">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-slate-900">Last run</div>
                <div className="mt-1 text-sm text-slate-600">
                  {fmtDate(status?.lastAttemptAt ?? null)} {rel ? <span className="text-slate-500">({rel})</span> : null}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Pill tone={resultMeta.tone}>{resultMeta.text}</Pill>
                  {status?.invokedBy ? <Pill tone="neutral">by {status.invokedBy}</Pill> : null}
                  {status?.codeVersion ? <Pill tone="neutral">v {status.codeVersion}</Pill> : null}
                </div>
              </div>
              <form action={runSeoAutopublishAction}>
                <SubmitButton className="rounded-xl bg-primary-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-primary-700">
                  Run now
                </SubmitButton>
              </form>
            </div>
            {status?.disabled ? (
              <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">
                Autopublish is disabled (`SEO_AUTOPUBLISH_DISABLED=1`).
              </div>
            ) : null}
            {status?.openaiConfigured === false ? (
              <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-900">
                OpenAI is not configured (missing `OPENAI_API_KEY`).
              </div>
            ) : null}
            {error ? (
              <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-900">
                {error}
              </div>
            ) : null}
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white/70 p-4 shadow-sm shadow-slate-200/40">
            <div className="text-sm font-semibold text-slate-900">Publishing limits</div>
            <div className="mt-2 text-sm text-slate-700">
              <div>
                Published last 7 days: <span className="font-semibold">{status?.publishedLast7Days ?? 0}</span>
              </div>
              <div className="mt-1">
                Last published: <span className="font-semibold">{fmtDate(status?.lastPublishedAt ?? null)}</span>
              </div>
              <div className="mt-1">
                Next eligible: <span className="font-semibold">{fmtDate(status?.nextEligibleAt ?? null)}</span>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white/70 p-4 shadow-sm shadow-slate-200/40">
            <div className="text-sm font-semibold text-slate-900">Models</div>
            <div className="mt-2 text-sm text-slate-700">
              <div>
                Brain: <span className="font-semibold">{status?.brainModel ?? "—"}</span>
              </div>
              {status?.brainModelUsed && status?.brainModelUsed !== status?.brainModel ? (
                <div className="mt-1">
                  Brain used: <span className="font-semibold">{status.brainModelUsed}</span>
                </div>
              ) : null}
              <div className="mt-1">
                Writer: <span className="font-semibold">{status?.voiceModel ?? "—"}</span>
              </div>
            </div>
            <div className="mt-3 text-xs text-slate-500">
              If this tab shows no recent runs, the worker may be stopped or missing env vars.
            </div>
          </div>
        </div>

        <div className="mt-4 rounded-2xl border border-slate-200 bg-white/70 p-4 shadow-sm shadow-slate-200/40">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-slate-900">Recent posts</div>
              <div className="mt-1 text-xs text-slate-500">Published posts that are eligible to be indexed.</div>
            </div>
            <a
              href="/blog"
              target="_blank"
              rel="noreferrer"
              className="text-sm font-semibold text-primary-700 hover:text-primary-800"
            >
              View blog →
            </a>
          </div>

          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead>
                <tr className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <th className="py-2 pr-4">Title</th>
                  <th className="py-2 pr-4">Slug</th>
                  <th className="py-2 pr-4">Published</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {(payload?.posts ?? []).length ? (
                  payload!.posts.map((post) => (
                    <tr key={post.id} className="text-slate-800">
                      <td className="py-2 pr-4 font-medium">
                        <a
                          href={`/blog/${encodeURIComponent(post.slug)}`}
                          target="_blank"
                          rel="noreferrer"
                          className="hover:text-primary-700"
                        >
                          {post.title}
                        </a>
                      </td>
                      <td className="py-2 pr-4 font-mono text-xs text-slate-600">{post.slug}</td>
                      <td className="py-2 pr-4 text-slate-600">{fmtDate(post.publishedAt)}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td className="py-3 text-slate-600" colSpan={3}>
                      No published blog posts yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  );
}
