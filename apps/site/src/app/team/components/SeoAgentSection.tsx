import { randomUUID } from "node:crypto";
import React from "react";
import { SubmitButton } from "@/components/SubmitButton";
import {
  hasTeamPermission,
  requireCurrentTeamPrincipal,
} from "@/lib/team-principal";
import { callAdminApiAs } from "../lib/api";
import { TEAM_TIME_ZONE } from "../lib/timezone";
import {
  publishSeoPostAction,
  runSeoDraftAction,
  submitSeoPostForReviewAction,
} from "../actions";
import {
  TEAM_CARD_PADDED,
  TEAM_SECTION_SUBTITLE,
  TEAM_SECTION_TITLE,
  teamButtonClass,
} from "./team-ui";

type EditorialStatus = "draft" | "review" | "published" | "failed";

type SeoPost = {
  id: string;
  slug: string;
  title: string;
  excerpt: string | null;
  contentMarkdown: string;
  metaTitle: string | null;
  metaDescription: string | null;
  editorialStatus: EditorialStatus;
  version: number;
  generatedAt: string;
  reviewRequestedAt: string | null;
  reviewedAt: string | null;
  publishedAt: string | null;
  lastError: string | null;
  updatedAt: string | null;
};

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
    lastGeneratedAt: string | null;
    generatedLast7Days: number;
    nextGenerationEligibleAt: string | null;
    lastPublishedAt: string | null;
    publishedLast7Days: number;
    nextEligibleAt: string | null;
  };
  posts: SeoPost[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TEAM_TIME_ZONE,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function fmtRelativeMinutes(nowIso: string, iso: string | null): string | null {
  if (!iso) return null;
  const now = new Date(nowIso);
  const date = new Date(iso);
  if (Number.isNaN(now.getTime()) || Number.isNaN(date.getTime())) return null;
  const minutes = Math.round((now.getTime() - date.getTime()) / 60_000);
  if (!Number.isFinite(minutes)) return null;
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function describeResult(result: unknown): {
  tone: "good" | "warn" | "bad" | "neutral";
  text: string;
} {
  if (!isRecord(result)) {
    return { tone: "neutral", text: "No generation runs recorded yet." };
  }
  if (
    result["ok"] === true &&
    result["skipped"] === false &&
    typeof result["title"] === "string"
  ) {
    return { tone: "good", text: `Private draft: ${result["title"]}` };
  }
  if (
    result["ok"] === true &&
    result["skipped"] === true &&
    typeof result["reason"] === "string"
  ) {
    return { tone: "warn", text: `Skipped: ${result["reason"]}` };
  }
  if (result["ok"] === false && typeof result["error"] === "string") {
    return { tone: "bad", text: `Error: ${result["error"]}` };
  }
  return { tone: "neutral", text: "Generation run recorded." };
}

function Pill({
  tone,
  children,
}: {
  tone: "good" | "warn" | "bad" | "neutral";
  children: React.ReactNode;
}) {
  const classes =
    tone === "good"
      ? "border-emerald-200 bg-emerald-100 text-emerald-800"
      : tone === "warn"
        ? "border-amber-200 bg-amber-100 text-amber-900"
        : tone === "bad"
          ? "border-rose-200 bg-rose-100 text-rose-800"
          : "border-slate-200 bg-slate-100 text-slate-700";
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold ${classes}`}
    >
      {children}
    </span>
  );
}

function statusTone(status: EditorialStatus): "good" | "warn" | "bad" | "neutral" {
  if (status === "published") return "good";
  if (status === "review") return "warn";
  if (status === "failed") return "bad";
  return "neutral";
}

function statusLabel(status: EditorialStatus): string {
  if (status === "review") return "Review required";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function SeoPostCard({
  post,
  canPublish,
}: {
  post: SeoPost;
  canPublish: boolean;
}) {
  const title =
    post.editorialStatus === "published" ? (
      <a
        href={`/blog/${encodeURIComponent(post.slug)}`}
        target="_blank"
        rel="noreferrer"
        className="font-semibold text-[color:var(--team-text)] hover:text-primary-700"
      >
        {post.title}
      </a>
    ) : (
      <h3 className="font-semibold text-[color:var(--team-text)]">
        {post.title}
      </h3>
    );

  return (
    <article className="rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] p-4 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          {title}
          <div className="mt-1 break-all font-mono text-xs text-[color:var(--team-text-muted)]">
            {post.slug}
          </div>
        </div>
        <Pill tone={statusTone(post.editorialStatus)}>
          {statusLabel(post.editorialStatus)}
        </Pill>
      </div>

      <dl className="mt-3 grid gap-1 text-xs text-[color:var(--team-text-muted)] sm:grid-cols-2">
        <div>
          <dt className="inline font-semibold">Generated: </dt>
          <dd className="inline">{fmtDate(post.generatedAt)}</dd>
        </div>
        <div>
          <dt className="inline font-semibold">Updated: </dt>
          <dd className="inline">{fmtDate(post.updatedAt)}</dd>
        </div>
        <div>
          <dt className="inline font-semibold">Review requested: </dt>
          <dd className="inline">{fmtDate(post.reviewRequestedAt)}</dd>
        </div>
        <div>
          <dt className="inline font-semibold">Published: </dt>
          <dd className="inline">{fmtDate(post.publishedAt)}</dd>
        </div>
      </dl>

      {post.excerpt ? (
        <p className="mt-3 text-sm text-[color:var(--team-text-muted)]">
          {post.excerpt}
        </p>
      ) : null}
      {post.lastError ? (
        <p className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900" role="alert">
          {post.lastError}
        </p>
      ) : null}

      <details className="mt-3 rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-card)] px-3 py-2">
        <summary className="min-h-11 cursor-pointer py-2 text-sm font-semibold text-[color:var(--team-text)]">
          Preview full draft and search metadata
        </summary>
        <dl className="mt-2 grid gap-2 text-xs text-[color:var(--team-text-muted)]">
          <div>
            <dt className="font-semibold">Meta title</dt>
            <dd>{post.metaTitle ?? "Not set"}</dd>
          </div>
          <div>
            <dt className="font-semibold">Meta description</dt>
            <dd>{post.metaDescription ?? "Not set"}</dd>
          </div>
        </dl>
        <pre className="mt-3 max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-xl bg-slate-950 p-4 text-xs leading-6 text-slate-100">
          {post.contentMarkdown}
        </pre>
      </details>

      {!canPublish && post.editorialStatus !== "published" ? (
        <p className="mt-3 text-xs text-[color:var(--team-text-muted)]">
          Marketing publishing permission is required to change this post.
        </p>
      ) : null}

      {canPublish && post.editorialStatus === "draft" ? (
        <form action={submitSeoPostForReviewAction} className="mt-3">
          <input type="hidden" name="postId" value={post.id} />
          <input type="hidden" name="expectedVersion" value={post.version} />
          <input
            type="hidden"
            name="idempotencyKey"
            value={`seo-review:${post.id}:${post.version}:${randomUUID()}`}
          />
          <SubmitButton
            className={teamButtonClass("secondary")}
            pendingLabel="Submitting..."
          >
            Submit for review
          </SubmitButton>
          <p className="mt-2 text-xs text-[color:var(--team-text-muted)]">
            This does not publish or expose the draft.
          </p>
        </form>
      ) : null}

      {canPublish && post.editorialStatus === "review" ? (
        <form action={publishSeoPostAction} className="mt-3 space-y-3">
          <input type="hidden" name="postId" value={post.id} />
          <input type="hidden" name="expectedVersion" value={post.version} />
          <input
            type="hidden"
            name="idempotencyKey"
            value={`seo-publish:${post.id}:${post.version}:${randomUUID()}`}
          />
          <label className="block text-sm font-medium text-[color:var(--team-text)]">
            Type <span className="font-mono">{post.slug}</span> to publish
            <input
              name="confirmation"
              required
              autoComplete="off"
              className="mt-2 min-h-11 w-full rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-card)] px-3 text-[color:var(--team-text)] focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-200"
            />
          </label>
          <SubmitButton
            className={teamButtonClass("danger")}
            pendingLabel="Publishing..."
          >
            Publish publicly
          </SubmitButton>
          <p className="text-xs text-[color:var(--team-text-muted)]">
            Publishing makes the post visible on the public blog and eligible
            for indexing. It is rate-limited and audited.
          </p>
        </form>
      ) : null}
    </article>
  );
}

export async function SeoAgentSection(): Promise<React.ReactElement> {
  const principal = await requireCurrentTeamPrincipal();
  const canPublish = hasTeamPermission(principal, "marketing.publish");
  let payload: SeoStatusPayload | null = null;
  let error: string | null = null;

  try {
    const response = await callAdminApiAs(principal, "/api/admin/seo/status");
    if (!response.ok) {
      error = `SEO status unavailable (HTTP ${response.status}).`;
    } else {
      payload = (await response.json()) as SeoStatusPayload;
    }
  } catch {
    error = "SEO status unavailable. Try again after checking the API.";
  }

  const status = payload?.status ?? null;
  const nowIso = status?.now ?? new Date().toISOString();
  const resultMeta = describeResult(status?.lastResult ?? null);
  const relativeRun = fmtRelativeMinutes(
    nowIso,
    status?.lastAttemptAt ?? null,
  );

  return (
    <section className="space-y-4" aria-labelledby="seo-workspace-title">
      <header className={TEAM_CARD_PADDED}>
        <h2 id="seo-workspace-title" className={TEAM_SECTION_TITLE}>
          Marketing SEO
        </h2>
        <p className={TEAM_SECTION_SUBTITLE}>
          Generate a private draft, inspect it, submit it for review, and only
          then publish it. Generation can never make a post public.
        </p>
      </header>

      {error ? (
        <div
          className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-900"
          role="alert"
        >
          {error} No missing data below is treated as zero.
        </div>
      ) : null}

      <div className={TEAM_CARD_PADDED}>
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
          <section className="rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] p-4 shadow-sm">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h3 className="text-sm font-semibold text-[color:var(--team-text)]">
                  Draft generator
                </h3>
                <p className="mt-1 text-sm text-[color:var(--team-text-muted)]">
                  Last attempt: {fmtDate(status?.lastAttemptAt)}{" "}
                  {relativeRun ? `(${relativeRun})` : ""}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Pill tone={resultMeta.tone}>{resultMeta.text}</Pill>
                  {status?.invokedBy ? (
                    <Pill tone="neutral">by {status.invokedBy}</Pill>
                  ) : null}
                </div>
              </div>
              {canPublish ? (
                <form action={runSeoDraftAction}>
                  <input
                    type="hidden"
                    name="idempotencyKey"
                    value={`seo-draft:${randomUUID()}`}
                  />
                  <SubmitButton
                    className={teamButtonClass("primary")}
                    pendingLabel="Generating..."
                    disabled={Boolean(status?.disabled) || status?.openaiConfigured === false}
                  >
                    Generate draft
                  </SubmitButton>
                </form>
              ) : null}
            </div>
            {status?.disabled ? (
              <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">
                Draft generation is disabled by the SEO safety switch.
              </p>
            ) : null}
            {status?.openaiConfigured === false ? (
              <p className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-900">
                Draft generation is unavailable because the AI provider is not configured.
              </p>
            ) : null}
          </section>

          <section className="rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] p-4 shadow-sm">
            <h3 className="text-sm font-semibold text-[color:var(--team-text)]">
              Schedule and limits
            </h3>
            <dl className="mt-3 grid gap-2 text-sm text-[color:var(--team-text-muted)]">
              <div>
                <dt className="inline font-semibold">Generated in 7 days: </dt>
                <dd className="inline">
                  {status ? status.generatedLast7Days : "Unavailable"}
                </dd>
              </div>
              <div>
                <dt className="inline font-semibold">Next generation: </dt>
                <dd className="inline">
                  {status ? fmtDate(status.nextGenerationEligibleAt) : "Unavailable"}
                </dd>
              </div>
              <div>
                <dt className="inline font-semibold">Published in 7 days: </dt>
                <dd className="inline">
                  {status ? status.publishedLast7Days : "Unavailable"}
                </dd>
              </div>
              <div>
                <dt className="inline font-semibold">Next publication: </dt>
                <dd className="inline">
                  {status ? fmtDate(status.nextEligibleAt) : "Unavailable"}
                </dd>
              </div>
            </dl>
          </section>

          <section className="rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] p-4 shadow-sm">
            <h3 className="text-sm font-semibold text-[color:var(--team-text)]">
              Provider and model
            </h3>
            <dl className="mt-3 grid gap-2 text-sm text-[color:var(--team-text-muted)]">
              <div>
                <dt className="inline font-semibold">Provider: </dt>
                <dd className="inline">
                  {status?.openaiConfigured === true
                    ? "Ready"
                    : status?.openaiConfigured === false
                      ? "Not configured"
                      : "Unknown"}
                </dd>
              </div>
              <div>
                <dt className="inline font-semibold">Planner: </dt>
                <dd className="inline">{status?.brainModel ?? "Unknown"}</dd>
              </div>
              <div>
                <dt className="inline font-semibold">Writer: </dt>
                <dd className="inline">{status?.voiceModel ?? "Unknown"}</dd>
              </div>
              <div>
                <dt className="inline font-semibold">Code: </dt>
                <dd className="inline">{status?.codeVersion ?? "Unknown"}</dd>
              </div>
            </dl>
          </section>
        </div>

        <section className="mt-4" aria-labelledby="seo-posts-title">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 id="seo-posts-title" className="text-lg font-semibold text-[color:var(--team-text)]">
                Editorial queue
              </h3>
              <p className="mt-1 text-sm text-[color:var(--team-text-muted)]">
                Draft → Review → Published. Only Published posts are public.
              </p>
            </div>
            <a
              href="/blog"
              target="_blank"
              rel="noreferrer"
              className={teamButtonClass("secondary", "sm")}
            >
              View public blog
            </a>
          </div>

          <div className="mt-4 grid gap-4 xl:grid-cols-2">
            {(payload?.posts ?? []).length > 0 ? (
              payload!.posts.map((post) => (
                <SeoPostCard
                  key={post.id}
                  post={post}
                  canPublish={canPublish}
                />
              ))
            ) : (
              <p
                className="rounded-2xl border border-dashed border-[color:var(--team-border)] bg-[color:var(--team-surface)] px-4 py-6 text-sm text-[color:var(--team-text-muted)] xl:col-span-2"
                role="status"
              >
                {payload
                  ? "No SEO drafts or published posts exist yet."
                  : "The editorial queue is unavailable."}
              </p>
            )}
          </div>
        </section>
      </div>
    </section>
  );
}
