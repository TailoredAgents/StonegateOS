"use client";

import * as React from "react";
import {
  parseTeamMfaSecurityStatus,
  type TeamMfaSecurityStatus,
} from "../team-mfa-security";

type Enrollment = {
  challengeId: string;
  secret: string;
  otpauthUri: string;
  expiresAt: string;
};

type ApiError = { message?: unknown; code?: unknown };

const fieldClass =
  "mt-1 min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-base text-slate-950 focus:border-primary-600 focus:outline-none focus:ring-2 focus:ring-primary-200";
const primaryButtonClass =
  "inline-flex min-h-[44px] items-center justify-center rounded-xl bg-primary-700 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-800 focus:outline-none focus:ring-2 focus:ring-primary-300 disabled:cursor-not-allowed disabled:opacity-60";
const secondaryButtonClass =
  "inline-flex min-h-[44px] items-center justify-center rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-primary-300 disabled:cursor-not-allowed disabled:opacity-60";

async function securityFetch(
  path: string,
  init?: RequestInit,
): Promise<{ response: Response; payload: unknown }> {
  const response = await fetch(`/api/team/security/mfa${path}`, {
    ...init,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
    cache: "no-store",
  });
  return { response, payload: await response.json().catch(() => null) };
}

function errorMessage(payload: unknown, fallback: string): string {
  const error = payload as ApiError | null;
  return typeof error?.message === "string" && error.message.trim()
    ? error.message
    : fallback;
}

function formText(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function TeamMfaSecurityCard({
  initialStatus,
  initialError,
}: {
  initialStatus: TeamMfaSecurityStatus | null;
  initialError: string | null;
}) {
  const [status, setStatus] = React.useState(initialStatus);
  const [enrollment, setEnrollment] = React.useState<Enrollment | null>(null);
  const [recoveryCodes, setRecoveryCodes] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<{
    tone: "success" | "error" | "info";
    message: string;
  } | null>(initialError ? { tone: "error", message: initialError } : null);

  const refresh = React.useCallback(async () => {
    const { response, payload } = await securityFetch("");
    const parsed = response.ok ? parseTeamMfaSecurityStatus(payload) : null;
    if (!parsed)
      throw new Error(
        errorMessage(payload, "Security status could not be refreshed."),
      );
    setStatus(parsed);
  }, []);

  async function beginEnrollment(): Promise<void> {
    setBusy(true);
    setNotice(null);
    setRecoveryCodes([]);
    try {
      const { response, payload } = await securityFetch("/enrollment", {
        method: "POST",
        body: "{}",
      });
      const candidate = payload as { enrollment?: Enrollment } | null;
      if (!response.ok || !candidate?.enrollment) {
        throw new Error(
          errorMessage(payload, "Authenticator setup could not be started."),
        );
      }
      setEnrollment(candidate.enrollment);
      setNotice({
        tone: "info",
        message:
          "Add the secret to your authenticator, then verify its current code.",
      });
    } catch (error) {
      setNotice({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "Authenticator setup could not be started.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function confirmEnrollment(
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    if (!enrollment) return;
    const form = new FormData(event.currentTarget);
    const code = formText(form, "code").trim();
    const label = formText(form, "label").trim();
    setBusy(true);
    setNotice(null);
    try {
      const { response, payload } = await securityFetch(
        `/enrollment/${encodeURIComponent(enrollment.challengeId)}/confirm`,
        {
          method: "POST",
          body: JSON.stringify({ code, ...(label ? { label } : {}) }),
        },
      );
      const candidate = payload as { recoveryCodes?: unknown } | null;
      if (
        !response.ok ||
        !isStringArray(candidate?.recoveryCodes)
      ) {
        throw new Error(
          errorMessage(payload, "That authenticator code was not accepted."),
        );
      }
      setRecoveryCodes(candidate.recoveryCodes);
      setEnrollment(null);
      await refresh();
      setNotice({
        tone: "success",
        message:
          "Authenticator enabled. Save the recovery codes before leaving this page.",
      });
    } catch (error) {
      setNotice({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "Authenticator setup could not be completed.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function stepUp(
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const method = formText(form, "method") || "totp";
    const verification = formText(form, "verification").trim();
    setBusy(true);
    setNotice(null);
    try {
      const { response, payload } = await securityFetch("/step-up", {
        method: "POST",
        body: JSON.stringify(
          method === "recovery"
            ? { recoveryCode: verification }
            : { code: verification },
        ),
      });
      if (!response.ok) {
        throw new Error(
          errorMessage(payload, "That verification value was not accepted."),
        );
      }
      formElement.reset();
      await refresh();
      setNotice({
        tone: "success",
        message: "Sensitive Team actions are unlocked for 15 minutes.",
      });
    } catch (error) {
      setNotice({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "This session could not be verified.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function revoke(
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const confirm = formText(form, "confirm").trim().toUpperCase();
    setBusy(true);
    setNotice(null);
    try {
      const { response, payload } = await securityFetch("/revoke", {
        method: "POST",
        body: JSON.stringify({ confirm }),
      });
      if (!response.ok) {
        throw new Error(
          errorMessage(payload, "The authenticator could not be disabled."),
        );
      }
      formElement.reset();
      setRecoveryCodes([]);
      await refresh();
      setNotice({
        tone: "success",
        message: "Authenticator disabled and other Team sessions revoked.",
      });
    } catch (error) {
      setNotice({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "The authenticator could not be disabled.",
      });
    } finally {
      setBusy(false);
    }
  }

  const method = status?.methods[0] ?? null;
  return (
    <section
      id="multi-factor-security"
      aria-labelledby="team-mfa-title"
      className="scroll-mt-24 rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2
            id="team-mfa-title"
            className="text-base font-semibold text-[color:var(--team-text)]"
          >
            Multi-factor security
          </h2>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-[color:var(--team-text-muted)]">
            An authenticator code is required for Owners and for sensitive
            partner, commercial, delivery, security, or destructive changes.
            Verification lasts 15 minutes.
          </p>
        </div>
        {status ? (
          <span
            className={`rounded-full border px-3 py-1 text-xs font-semibold ${status.recentlyVerified ? "border-emerald-300 bg-emerald-50 text-emerald-900" : status.enrolled ? "border-amber-300 bg-amber-50 text-amber-900" : "border-slate-300 bg-slate-50 text-slate-700"}`}
          >
            {status.recentlyVerified
              ? "Verified now"
              : status.enrolled
                ? "Verification needed"
                : "Not configured"}
          </span>
        ) : null}
      </div>

      <div aria-live="polite" aria-atomic="true">
        {notice ? (
          <p
            className={`mt-4 rounded-xl border px-3 py-2 text-sm ${notice.tone === "error" ? "border-rose-300 bg-rose-50 text-rose-900" : notice.tone === "success" ? "border-emerald-300 bg-emerald-50 text-emerald-900" : "border-sky-300 bg-sky-50 text-sky-900"}`}
            role={notice.tone === "error" ? "alert" : "status"}
          >
            {notice.message}
          </p>
        ) : null}
      </div>

      {status?.required && !status.enrolled ? (
        <p
          className="mt-4 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950"
          role="alert"
        >
          Your access requires an authenticator. Sensitive actions remain locked
          until setup is complete.
        </p>
      ) : null}
      {status && !status.configurationAllowed ? (
        <p className="mt-4 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
          Emergency recovery access cannot configure or verify MFA. Finish
          recovery, then use a standard Team sign-in.
        </p>
      ) : null}

      {recoveryCodes.length > 0 ? (
        <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-4">
          <h3 className="font-semibold text-amber-950">
            Save these recovery codes now
          </h3>
          <p className="mt-1 text-sm text-amber-900">
            Each code works once and this set will not be shown again.
          </p>
          <ul
            className="mt-3 grid gap-2 font-mono text-sm text-slate-950 sm:grid-cols-2"
            aria-label="Team MFA recovery codes"
          >
            {recoveryCodes.map((code) => (
              <li
                key={code}
                className="rounded-lg border border-amber-200 bg-white px-3 py-2"
              >
                {code}
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => setRecoveryCodes([])}
            className={`${secondaryButtonClass} mt-3`}
          >
            I saved these codes
          </button>
        </div>
      ) : null}

      {enrollment ? (
        <div className="mt-4 rounded-xl border border-sky-300 bg-sky-50 p-4">
          <h3 className="font-semibold text-slate-950">
            Connect an authenticator app
          </h3>
          <ol className="mt-2 list-decimal space-y-2 pl-5 text-sm leading-6 text-slate-800">
            <li>
              Add an account using this secret:
              <code className="mt-2 block break-all rounded-lg border border-sky-200 bg-white px-3 py-2 font-mono text-sm">
                {enrollment.secret}
              </code>
              <a
                href={enrollment.otpauthUri}
                className="mt-2 inline-flex min-h-[44px] items-center font-semibold text-primary-800 underline underline-offset-4"
              >
                Open in authenticator app
              </a>
            </li>
            <li>Enter its current six-digit code.</li>
          </ol>
          <form
            onSubmit={(event) => void confirmEnrollment(event)}
            className="mt-3 grid gap-3 sm:grid-cols-2"
          >
            <label className="text-sm font-semibold text-slate-800">
              Device label
              <input
                name="label"
                maxLength={80}
                autoComplete="off"
                placeholder="Work phone"
                className={fieldClass}
              />
            </label>
            <label className="text-sm font-semibold text-slate-800">
              Six-digit code
              <input
                name="code"
                required
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                autoComplete="one-time-code"
                className={fieldClass}
              />
            </label>
            <div className="flex flex-wrap gap-2 sm:col-span-2">
              <button
                type="submit"
                disabled={busy}
                className={primaryButtonClass}
              >
                {busy ? "Verifying…" : "Verify and enable"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setEnrollment(null)}
                className={secondaryButtonClass}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {!enrollment &&
      status?.configurationAllowed &&
      status.enrolled &&
      !status.recentlyVerified ? (
        <form
          onSubmit={(event) => void stepUp(event)}
          className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4"
        >
          <h3 className="font-semibold text-slate-950">Verify this session</h3>
          <p className="mt-1 text-sm text-slate-600">
            Use a current authenticator code or one unused recovery code.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="text-sm font-semibold text-slate-800">
              Method
              <select name="method" className={fieldClass}>
                <option value="totp">Authenticator code</option>
                <option value="recovery">Recovery code</option>
              </select>
            </label>
            <label className="text-sm font-semibold text-slate-800">
              Verification value
              <input
                name="verification"
                required
                autoComplete="one-time-code"
                className={fieldClass}
              />
            </label>
          </div>
          <button
            type="submit"
            disabled={busy}
            className={`${primaryButtonClass} mt-3`}
          >
            {busy ? "Verifying…" : "Verify for sensitive actions"}
          </button>
        </form>
      ) : null}

      {!enrollment &&
      status?.configurationAllowed &&
      (!status.enrolled || status.recentlyVerified) ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-4">
          <p className="text-sm text-slate-700">
            {method ? (
              <>
                <span className="font-semibold text-slate-950">
                  {method.label || "Authenticator app"}
                </span>
                <span className="block text-xs text-slate-600">
                  {method.recoveryCodesRemaining} recovery codes remain.
                </span>
              </>
            ) : (
              "Use any app that supports time-based one-time passwords."
            )}
          </p>
          <button
            type="button"
            onClick={() => void beginEnrollment()}
            disabled={busy}
            className={secondaryButtonClass}
          >
            {busy
              ? "Starting…"
              : status.enrolled
                ? "Replace authenticator"
                : "Set up authenticator"}
          </button>
        </div>
      ) : null}

      {status?.configurationAllowed &&
      status.enrolled &&
      status.recentlyVerified &&
      !enrollment ? (
        <details className="mt-4 border-t border-slate-200 pt-4">
          <summary className="min-h-[44px] cursor-pointer text-sm font-semibold text-rose-800">
            Disable authenticator
          </summary>
          <form
            onSubmit={(event) => void revoke(event)}
            className="mt-2 rounded-xl border border-rose-200 bg-rose-50 p-3"
          >
            <label className="text-sm font-semibold text-rose-950">
              Type REMOVE to confirm
              <input
                name="confirm"
                required
                pattern="REMOVE"
                autoComplete="off"
                className={fieldClass}
              />
            </label>
            <p className="mt-2 text-xs text-rose-900">
              Other Team sessions will be revoked. Required users remain locked
              from sensitive actions until they enroll again.
            </p>
            <button
              type="submit"
              disabled={busy}
              className={`${secondaryButtonClass} mt-3 border-rose-300 text-rose-900`}
            >
              {busy ? "Disabling…" : "Disable authenticator"}
            </button>
          </form>
        </details>
      ) : null}
    </section>
  );
}
