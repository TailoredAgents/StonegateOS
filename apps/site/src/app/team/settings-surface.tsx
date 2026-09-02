import type { ReactElement } from "react";
import { randomUUID } from "node:crypto";
import { teamLogoutAction, teamSetPasswordAction } from "./login/actions";
import {
  TEAM_CARD_PADDED,
  TEAM_SECTION_SUBTITLE,
  TEAM_SECTION_TITLE,
} from "./components/team-ui";
import { SettingsPreferencesClient } from "./components/SettingsPreferencesClient";
import { ConversationExportClient } from "./components/ConversationExportClient";
import type { PersonalSessionInventory } from "./settings-sessions";
import type { TeamMfaSecurityStatus } from "./team-mfa-security";
import { TeamMfaSecurityCard } from "./components/TeamMfaSecurityCard";

type CalendarBadgeTone = "ok" | "warn" | "alert" | "idle";

type SettingsSurfaceProps = {
  teamMember: {
    name: string;
    email: string | null;
    roleSlug: string | null;
    passwordSet: boolean;
  } | null;
  hasOwner: boolean;
  canExportMessages: boolean;
  authMethod: "team_session" | "break_glass";
  setup: boolean;
  saved: boolean;
  error: string | null;
  calendarBadge: {
    tone: CalendarBadgeTone;
    headline: string;
    detail?: string;
  } | null;
  personalSessions: PersonalSessionInventory | null;
  personalSessionsError: string | null;
  mfaSecurity: TeamMfaSecurityStatus | null;
  mfaSecurityError: string | null;
};

const calendarBadgeToneClasses: Record<CalendarBadgeTone, string> = {
  ok: "border-emerald-200 bg-emerald-50 text-emerald-700",
  warn: "border-amber-200 bg-amber-50 text-amber-700",
  alert: "border-rose-200 bg-rose-50 text-rose-700",
  idle: "border-slate-200 bg-white text-slate-500",
};

function formatEasternDateTime(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function SettingsSurface({
  teamMember,
  hasOwner,
  canExportMessages,
  authMethod,
  setup,
  saved,
  error,
  calendarBadge,
  personalSessions,
  personalSessionsError,
  mfaSecurity,
  mfaSecurityError,
}: SettingsSurfaceProps): ReactElement {
  const revokeOtherSessionsKey =
    personalSessions && personalSessions.activeOtherCount > 0
      ? randomUUID()
      : null;
  return (
    <section className={`space-y-4 ${TEAM_CARD_PADDED}`}>
      <div className="space-y-4">
        <h2 className={TEAM_SECTION_TITLE}>Account</h2>
        <p className={TEAM_SECTION_SUBTITLE}>
          Signed-in team members control attribution for calls, messages, and
          audit logs. Owner sessions still have full access.
        </p>
        {setup ? (
          <div className="rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-800 shadow-sm shadow-sky-100">
            Set a password to enable password sign-in. Magic links will still
            work.
          </div>
        ) : null}
        {saved ? (
          <div
            className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 shadow-sm shadow-emerald-100"
            role="status"
            aria-live="polite"
          >
            Saved.
          </div>
        ) : null}
        {error ? (
          <div
            className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 shadow-sm shadow-rose-100"
            role="alert"
          >
            {error}
          </div>
        ) : null}

        {teamMember ? (
          <div className="rounded-2xl border border-slate-200 bg-white/70 p-4 text-sm text-slate-700 shadow-sm shadow-slate-200/40">
            <div className="font-semibold text-slate-900">
              {teamMember.name}
            </div>
            <div className="mt-1 text-xs text-slate-500">
              Email:{" "}
              <span className="font-medium text-slate-700">
                {teamMember.email ?? "No email on file"}
              </span>
            </div>
            <div className="mt-1 text-xs text-slate-500">
              Role:{" "}
              <span className="font-medium text-slate-700">
                {teamMember.roleSlug ?? "Custom access"}
              </span>
            </div>
            <div className="mt-1 text-xs text-slate-500">
              Session:{" "}
              <span className="font-medium text-slate-700">
                {authMethod === "break_glass"
                  ? "Emergency recovery"
                  : "Standard team sign-in"}
              </span>
            </div>
            {authMethod === "break_glass" ? (
              <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
                This is a short-lived, audited recovery session. Set or verify
                your normal sign-in method, then log out of recovery access.
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="flex flex-wrap gap-3">
          <form action={teamLogoutAction}>
            <button className="min-h-[44px] rounded-full border border-slate-200 px-4 py-2 text-xs font-medium text-slate-600 hover:border-slate-300 hover:text-slate-800">
              Log out
            </button>
          </form>
        </div>

        {teamMember && !teamMember.passwordSet ? (
          <div
            className="rounded-2xl border border-slate-200 bg-white/70 p-4 shadow-sm shadow-slate-200/40"
            aria-labelledby="team-password-setup-title"
          >
            <h3 className="text-sm font-semibold text-slate-900">
              <span id="team-password-setup-title">Set password</span>
            </h3>
            <p
              id="team-password-setup-help"
              className="mt-1 text-xs text-slate-500"
              role={setup ? "status" : undefined}
              aria-live={setup ? "polite" : undefined}
            >
              {setup
                ? "Your sign-in link worked. Set an optional password here, or continue using secure sign-in links."
                : "Optional. Use at least 10 characters."}
            </p>
            <form
              action={teamSetPasswordAction}
              className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center"
            >
              <label className="flex flex-1 flex-col gap-1 text-xs font-medium text-slate-700">
                <span>New password</span>
                <input
                  name="password"
                  type="password"
                  minLength={10}
                  autoComplete="new-password"
                  autoFocus={setup}
                  aria-describedby="team-password-setup-help"
                  required
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                />
              </label>
              <button
                type="submit"
                className="min-h-[44px] rounded-xl bg-primary-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-primary-700"
              >
                Save
              </button>
            </form>
          </div>
        ) : null}

        <TeamMfaSecurityCard
          initialStatus={mfaSecurity}
          initialError={mfaSecurityError}
        />

        <section
          id="sessions"
          aria-labelledby="team-personal-sessions-title"
          className="scroll-mt-24 rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] p-4"
        >
          <h2
            id="team-personal-sessions-title"
            className="text-base font-semibold text-[color:var(--team-text)]"
          >
            Your sessions
          </h2>
          <p className="mt-1 text-xs leading-5 text-[color:var(--team-text-muted)]">
            Review where your account is signed in. Ending other sessions never
            ends this current session; use Log out above to end this one.
          </p>

          {personalSessionsError ? (
            <div
              className="mt-3 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
              role="alert"
            >
              {personalSessionsError} This is not an empty session list.
            </div>
          ) : personalSessions ? (
            <>
              <p
                className="mt-3 text-xs text-[color:var(--team-text-muted)]"
                role="status"
              >
                Showing {personalSessions.sessions.length} of{" "}
                {personalSessions.total} session
                {personalSessions.total === 1 ? "" : "s"}.{" "}
                {personalSessions.activeOtherCount} other active.
              </p>
              <ul className="mt-3 grid gap-2 sm:grid-cols-2" role="list">
                {personalSessions.sessions.map((session, index) => (
                  <li
                    key={`${session.createdAt}-${session.authMethod}-${index}`}
                    className="rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-card)] p-3 text-xs text-[color:var(--team-text-muted)]"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold text-[color:var(--team-text)]">
                        {session.current ? "Current session" : "Other session"}
                      </span>
                      <span className="rounded-full border border-[color:var(--team-border)] px-2 py-1 font-semibold text-[color:var(--team-text)]">
                        {session.status === "active"
                          ? "Active"
                          : session.status === "expired"
                            ? "Expired"
                            : "Revoked"}
                      </span>
                    </div>
                    <dl className="mt-2 grid gap-1">
                      <div>
                        <dt className="inline font-medium text-[color:var(--team-text)]">
                          Sign-in type:{" "}
                        </dt>
                        <dd className="inline">
                          {session.authMethod === "break_glass"
                            ? "Emergency recovery"
                            : "Standard team sign-in"}
                        </dd>
                      </div>
                      <div>
                        <dt className="inline font-medium text-[color:var(--team-text)]">
                          Security assurance:{" "}
                        </dt>
                        <dd className="inline">
                          {session.assuranceLevel === "aal2"
                            ? "Authenticator verified"
                            : "Standard"}
                          {session.mfaVerifiedAt ? (
                            <>
                              {" "}
                              at{" "}
                              <time dateTime={session.mfaVerifiedAt}>
                                {formatEasternDateTime(session.mfaVerifiedAt)}{" "}
                                Eastern
                              </time>
                            </>
                          ) : null}
                        </dd>
                      </div>
                      <div>
                        <dt className="inline font-medium text-[color:var(--team-text)]">
                          Last used:{" "}
                        </dt>
                        <dd className="inline">
                          <time dateTime={session.lastSeenAt}>
                            {formatEasternDateTime(session.lastSeenAt)} Eastern
                          </time>
                        </dd>
                      </div>
                      <div>
                        <dt className="inline font-medium text-[color:var(--team-text)]">
                          Expires:{" "}
                        </dt>
                        <dd className="inline">
                          <time dateTime={session.expiresAt}>
                            {formatEasternDateTime(session.expiresAt)} Eastern
                          </time>
                        </dd>
                      </div>
                    </dl>
                  </li>
                ))}
              </ul>
              {personalSessions.truncated ? (
                <p className="mt-3 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  Only the {personalSessions.limit} newest sessions are shown.
                  “Revoke other sessions” still covers every other session,
                  including older entries.
                </p>
              ) : null}
              {revokeOtherSessionsKey ? (
                <form
                  action="/api/team/settings/sessions/revoke"
                  method="post"
                  className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-3"
                >
                  <input
                    type="hidden"
                    name="idempotencyKey"
                    value={revokeOtherSessionsKey}
                  />
                  <input
                    type="hidden"
                    name="expectedVersion"
                    value={personalSessions.version}
                  />
                  <label className="block text-xs font-medium text-rose-900">
                    Type REVOKE to end every other session
                    <input
                      name="confirm"
                      required
                      autoComplete="off"
                      pattern="REVOKE"
                      className="mt-2 min-h-[44px] w-full rounded-xl border border-rose-300 bg-white px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-rose-300"
                    />
                  </label>
                  <button
                    type="submit"
                    className="mt-3 inline-flex min-h-[44px] items-center justify-center rounded-xl border border-rose-300 bg-white px-4 py-2 text-sm font-semibold text-rose-800 hover:bg-rose-100 focus:outline-none focus:ring-2 focus:ring-rose-300"
                  >
                    Revoke other sessions
                  </button>
                </form>
              ) : (
                <p className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
                  No other active sessions need attention.
                </p>
              )}
            </>
          ) : (
            <p
              className="mt-3 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
              role="alert"
            >
              Session inventory is unavailable. This is not an empty session
              list.
            </p>
          )}
        </section>

        <SettingsPreferencesClient />

        <h2 className={TEAM_SECTION_TITLE}>Calling</h2>
        <p className={TEAM_SECTION_SUBTITLE}>
          Outbound calls always ring the{" "}
          <span className="font-semibold">Assigned to</span> salesperson on the
          contact (lead routing). Set each salesperson&apos;s phone in{" "}
          <span className="font-semibold">Access</span> so the system knows who
          to ring.
        </p>
      </div>

      {hasOwner || canExportMessages ? (
        <details className="rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] p-4">
          <summary className="min-h-[44px] cursor-pointer text-sm font-semibold text-[color:var(--team-text)]">
            Advanced diagnostics and data tools
          </summary>
          <div className="mt-4 space-y-4 border-t border-[color:var(--team-border)] pt-4">
            {canExportMessages ? (
              <section aria-labelledby="team-settings-export-title">
                <h2
                  id="team-settings-export-title"
                  className="text-base font-semibold text-[color:var(--team-text)]"
                >
                  Sensitive conversation export
                </h2>
                <p className="mt-1 text-xs leading-5 text-[color:var(--team-text-muted)]">
                  Export a trailing 7, 30, or 90-day window as JSONL, optionally
                  limited to one channel. The file is capped at 1,000
                  conversations, 5,000 eligible messages, and 8 MiB. Each line
                  contains only user/assistant roles and message bodies. Drafts,
                  internal notes, queued or failed sends, media fields,
                  structured contact fields, provider metadata, and thread IDs
                  are excluded. Free-form message bodies can still contain
                  names, phone numbers, addresses, or other personal details
                  written by a customer or team member.
                </p>
                <p className="mt-2 text-xs font-medium leading-5 text-amber-700">
                  Message bodies are sensitive personal data. Store the file
                  securely and delete it when finished. If any limit is exceeded
                  or the audit receipt is incomplete, no partial file is
                  downloaded and an error is shown.
                </p>
                <ConversationExportClient />
              </section>
            ) : null}

            {hasOwner && calendarBadge ? (
              <section
                className={`rounded-xl border px-4 py-3 text-xs ${calendarBadgeToneClasses[calendarBadge.tone]}`}
                title={calendarBadge.detail ?? undefined}
                aria-labelledby="team-calendar-sync-title"
              >
                <h2
                  id="team-calendar-sync-title"
                  className="text-[10px] font-semibold uppercase tracking-[0.18em] text-current/70"
                >
                  Calendar Sync
                </h2>
                <span className="mt-1 block text-sm font-medium text-current">
                  {calendarBadge.headline}
                </span>
                {calendarBadge.detail ? (
                  <span className="block text-[11px] text-current/80">
                    {calendarBadge.detail}
                  </span>
                ) : null}
              </section>
            ) : hasOwner ? (
              <p className="text-xs text-[color:var(--team-text-muted)]">
                Calendar Sync status is unavailable. This does not mean the
                integration is healthy or empty.
              </p>
            ) : null}
          </div>
        </details>
      ) : null}
    </section>
  );
}
