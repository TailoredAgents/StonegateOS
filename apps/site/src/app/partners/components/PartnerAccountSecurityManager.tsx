"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  BellRing,
  Building2,
  Check,
  KeyRound,
  Laptop,
  LoaderCircle,
  LogOut,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
} from "lucide-react";
import { cn } from "@myst-os/ui";
import { createPortalOperationKey, partnerPortalFetch } from "../lib/portal-v2";
import {
  PartnerNotice,
  PartnerPanel,
  partnerFieldClass,
  partnerPrimaryButtonClass,
  partnerSecondaryButtonClass,
} from "./PartnerPortalUi";

export type PartnerSettingsAccount = {
  id: string;
  name: string;
  status: string;
  membershipId: string;
  roleKey: string;
  accessLevel: string;
  current: boolean;
};

export type PartnerSettingsMfa = {
  security: {
    required: boolean;
    enrolled: boolean;
    satisfied: boolean;
    assuranceLevel: string;
    verifiedAt: string | null;
  };
  methods: Array<{
    id: string;
    type: "totp" | "webauthn";
    label: string | null;
    enrolledAt: string;
    lastUsedAt: string | null;
    recoveryCodesRemaining: number;
  }>;
};

export type PartnerSettingsSession = {
  handle: string;
  current: boolean;
  status: "active" | "expired" | "revoked";
  authMethod: string;
  assuranceLevel: string;
  mfaVerifiedAt: string | null;
  deviceName: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt: string | null;
};

export type PartnerSettingsPreference = {
  eventKey: string;
  inAppEnabled: boolean;
  emailEnabled: boolean;
  smsEnabled: boolean;
  smsOptInVerified: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  timezone: string;
  etag: string;
};

type Enrollment = {
  challengeId: string;
  secret: string;
  otpauthUri: string;
  expiresAt: string;
};

const EVENT_LABELS: Record<string, { title: string; description: string }> = {
  booking_created: {
    title: "Job confirmations",
    description: "Newly requested or confirmed work.",
  },
  booking_changed: {
    title: "Schedule changes",
    description: "Reschedules, cancellations, and arrival-window changes.",
  },
  crew_en_route: {
    title: "Crew en route",
    description: "Same-day arrival updates.",
  },
  job_completed: {
    title: "Job completed",
    description: "Completion updates and closeout status.",
  },
  invoice_issued: {
    title: "Invoices",
    description: "New invoices and billing documents.",
  },
  payment_received: {
    title: "Payments",
    description: "Payment receipts and reconciliation updates.",
  },
  message_received: {
    title: "Messages",
    description: "Replies from the Stonegate team.",
  },
  proof_ready: {
    title: "Photos and proof",
    description: "Before/after proof and completion packages.",
  },
  approval_requested: {
    title: "Approvals",
    description: "Requests that need an account decision.",
  },
  account_access: {
    title: "Account access",
    description: "Company join-request and workspace-access decisions.",
  },
};

function dateLabel(value: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/New_York",
  }).format(date);
}

function formString(form: FormData, name: string, fallback = ""): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : fallback;
}

function sessionLabel(session: PartnerSettingsSession): string {
  if (session.deviceName?.trim()) return session.deviceName.trim();
  const agent = session.userAgent?.toLowerCase() ?? "";
  const browser = agent.includes("firefox")
    ? "Firefox"
    : agent.includes("edg/")
      ? "Edge"
      : agent.includes("chrome")
        ? "Chrome"
        : agent.includes("safari")
          ? "Safari"
          : "Browser";
  const device = /iphone|android|mobile/u.test(agent) ? "mobile" : "computer";
  return `${browser} on this ${device}`;
}

function AccountSwitcher({ accounts }: { accounts: PartnerSettingsAccount[] }) {
  const router = useRouter();
  const current = accounts.find((account) => account.current) ?? accounts[0];
  const [selected, setSelected] = React.useState(current?.id ?? "");
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);

  async function switchAccount(): Promise<void> {
    if (!selected || selected === current?.id) return;
    setBusy(true);
    setMessage(null);
    const result = await partnerPortalFetch<{
      ok: true;
      currentAccountId: string;
      currentMembershipId: string;
    }>("session/account", {
      method: "POST",
      body: JSON.stringify({ accountId: selected }),
    }).catch(() => null);
    if (!result?.ok) {
      setBusy(false);
      setMessage(
        result?.error.message ??
          "We couldn’t switch accounts. Your current account is unchanged.",
      );
      return;
    }
    router.push("/partners");
    router.refresh();
  }

  return (
    <PartnerPanel>
      <div className="flex items-start gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary-50 text-primary-700 ring-1 ring-primary-100">
          <Building2 className="h-5 w-5" aria-hidden="true" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-slate-950">
            Working account
          </h2>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            Jobs, locations, billing, and preferences are scoped to the selected
            account.
          </p>
        </div>
      </div>
      {message ? (
        <PartnerNotice tone="error" className="mt-4">
          {message}
        </PartnerNotice>
      ) : null}
      {accounts.length ? (
        <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="min-w-0 flex-1" htmlFor="partner-active-account">
            <span className="text-sm font-semibold text-slate-700">
              Account
            </span>
            <select
              id="partner-active-account"
              value={selected}
              onChange={(event) => setSelected(event.target.value)}
              disabled={busy}
              className={partnerFieldClass}
            >
              {accounts.map((account) => (
                <option value={account.id} key={account.membershipId}>
                  {account.name} · {account.roleKey.replaceAll("_", " ")}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => void switchAccount()}
            disabled={busy || !selected || selected === current?.id}
            className={partnerPrimaryButtonClass}
          >
            {busy ? (
              <LoaderCircle
                className="h-4 w-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : (
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
            )}
            {busy ? "Switching…" : "Switch account"}
          </button>
        </div>
      ) : (
        <PartnerNotice tone="warning" className="mt-5">
          No approved account memberships are available for this sign-in.
        </PartnerNotice>
      )}
    </PartnerPanel>
  );
}

function MfaManager({ initial }: { initial: PartnerSettingsMfa | null }) {
  const [mfa, setMfa] = React.useState(initial);
  const [enrollment, setEnrollment] = React.useState<Enrollment | null>(null);
  const [recoveryCodes, setRecoveryCodes] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<{
    tone: "success" | "error" | "info";
    text: string;
  } | null>(null);

  const refreshMfa = React.useCallback(async (): Promise<void> => {
    const result = await partnerPortalFetch<PartnerSettingsMfa & { ok: true }>(
      "mfa",
    ).catch(() => null);
    if (result?.ok) setMfa(result.data);
  }, []);

  async function beginEnrollment(): Promise<void> {
    setBusy(true);
    setMessage(null);
    setRecoveryCodes([]);
    const result = await partnerPortalFetch<{
      ok: true;
      enrollment: Enrollment;
    }>("mfa/totp/enrollment", {
      method: "POST",
      body: JSON.stringify({}),
    }).catch(() => null);
    setBusy(false);
    if (!result?.ok) {
      setMessage({
        tone: "error",
        text:
          result?.error.error === "mfa_step_up_required"
            ? "Verify your existing authenticator before replacing it."
            : (result?.error.message ??
              "We couldn’t start authenticator setup."),
      });
      return;
    }
    setEnrollment(result.data.enrollment);
    setMessage({
      tone: "info",
      text: "Add the secret to your authenticator, then enter its current six-digit code.",
    });
  }

  async function confirmEnrollment(
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    if (!enrollment) return;
    const form = new FormData(event.currentTarget);
    const code = formString(form, "code");
    const label = formString(form, "label");
    setBusy(true);
    setMessage(null);
    const result = await partnerPortalFetch<{
      ok: true;
      enrollment: {
        methodId: string;
        verifiedAt: string;
        recoveryCodes: string[];
        displayOnce: true;
      };
    }>(
      `mfa/totp/enrollment/${encodeURIComponent(enrollment.challengeId)}/confirm`,
      {
        method: "POST",
        body: JSON.stringify({ code, ...(label ? { label } : {}) }),
      },
    ).catch(() => null);
    setBusy(false);
    if (!result?.ok) {
      setMessage({
        tone: "error",
        text:
          result?.error.error === "invalid_fields"
            ? "That code was not accepted. Enter the current code from your authenticator."
            : (result?.error.message ??
              "We couldn’t verify the authenticator."),
      });
      return;
    }
    setRecoveryCodes(result.data.enrollment.recoveryCodes);
    setEnrollment(null);
    setMessage({
      tone: "success",
      text: "Authenticator verification is active. Save the recovery codes below now.",
    });
    await refreshMfa();
    window.dispatchEvent(new Event("partner-session-security-changed"));
  }

  async function stepUp(
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const method = formString(form, "verificationMethod", "totp");
    const raw = formString(form, "verification");
    setBusy(true);
    setMessage(null);
    const result = await partnerPortalFetch<{
      ok: true;
      session: {
        assuranceLevel: "aal2";
        verifiedAt: string;
        recoveryCodeUsed: boolean;
      };
    }>("mfa/step-up", {
      method: "POST",
      body: JSON.stringify(
        method === "recovery" ? { recoveryCode: raw } : { code: raw },
      ),
    }).catch(() => null);
    setBusy(false);
    if (!result?.ok) {
      setMessage({
        tone: "error",
        text:
          result?.error.error === "invalid_fields"
            ? "That verification value was not accepted. Check it and try again."
            : (result?.error.message ?? "We couldn’t verify this session."),
      });
      return;
    }
    formElement.reset();
    setMessage({
      tone: "success",
      text: result.data.session.recoveryCodeUsed
        ? "Session verified. That recovery code has been permanently used."
        : "Session verified. Protected account actions are now available.",
    });
    await refreshMfa();
    window.dispatchEvent(new Event("partner-session-security-changed"));
  }

  const security = mfa?.security;
  return (
    <PartnerPanel id="two-step-verification" className="scroll-mt-24">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div
            className={cn(
              "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ring-1",
              security?.enrolled
                ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
                : "bg-amber-50 text-amber-800 ring-amber-200",
            )}
          >
            {security?.enrolled ? (
              <ShieldCheck className="h-5 w-5" aria-hidden="true" />
            ) : (
              <ShieldAlert className="h-5 w-5" aria-hidden="true" />
            )}
          </div>
          <div>
            <h2 className="text-lg font-semibold text-slate-950">
              Two-step verification
            </h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
              An authenticator protects account administration, approvals, and
              billing actions.
            </p>
          </div>
        </div>
        {security ? (
          <span
            className={cn(
              "rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset",
              security.satisfied
                ? "bg-emerald-50 text-emerald-800 ring-emerald-200"
                : security.enrolled
                  ? "bg-amber-50 text-amber-900 ring-amber-200"
                  : "bg-slate-100 text-slate-700 ring-slate-200",
            )}
          >
            {security.satisfied
              ? "Verified this session"
              : security.enrolled
                ? "Verification needed"
                : security.required
                  ? "Setup required"
                  : "Not enabled"}
          </span>
        ) : null}
      </div>

      {message ? (
        <PartnerNotice tone={message.tone} className="mt-5">
          {message.text}
        </PartnerNotice>
      ) : null}

      {!mfa ? (
        <PartnerNotice tone="warning" className="mt-5">
          Two-step verification status is temporarily unavailable. Your security
          settings are unchanged.
        </PartnerNotice>
      ) : null}

      {security?.required && !security.enrolled ? (
        <PartnerNotice tone="warning" className="mt-5">
          Your role requires two-step verification. Set it up before using
          protected scheduling, approval, billing, or member-management actions.
        </PartnerNotice>
      ) : null}

      {recoveryCodes.length ? (
        <div className="mt-5 rounded-xl border border-amber-300 bg-amber-50 p-4">
          <h3 className="font-semibold text-amber-950">
            Save these recovery codes now
          </h3>
          <p className="mt-1 text-sm leading-6 text-amber-900">
            Each code works once. Stonegate will not show this set again.
          </p>
          <ul
            className="mt-4 grid gap-2 font-mono text-sm text-slate-950 sm:grid-cols-2"
            aria-label="Recovery codes"
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
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setRecoveryCodes([])}
              className={partnerPrimaryButtonClass}
            >
              <Check className="h-4 w-4" aria-hidden="true" />I saved them
            </button>
          </div>
        </div>
      ) : null}

      {enrollment ? (
        <div className="mt-5 rounded-xl border border-primary-200 bg-primary-50/60 p-4 sm:p-5">
          <h3 className="font-semibold text-slate-950">
            Connect an authenticator app
          </h3>
          <ol className="mt-3 list-decimal space-y-3 pl-5 text-sm leading-6 text-slate-700">
            <li>
              Add an account manually using this secret:
              <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
                <code className="min-w-0 break-all rounded-lg border border-primary-200 bg-white px-3 py-2 font-mono text-sm text-slate-950">
                  {enrollment.secret}
                </code>
              </div>
              <a
                href={enrollment.otpauthUri}
                className="mt-2 inline-flex min-h-11 items-center font-semibold text-primary-800 underline decoration-primary-300 underline-offset-4"
              >
                Open in an authenticator app
              </a>
            </li>
            <li>Enter the current six-digit code to finish setup.</li>
          </ol>
          <form
            onSubmit={(event) => void confirmEnrollment(event)}
            className="mt-4 grid gap-4 sm:grid-cols-2"
          >
            <label>
              <span className="text-sm font-semibold text-slate-700">
                Authenticator label
              </span>
              <input
                name="label"
                maxLength={80}
                placeholder="My phone"
                autoComplete="off"
                className={partnerFieldClass}
              />
            </label>
            <label>
              <span className="text-sm font-semibold text-slate-700">
                Six-digit code
              </span>
              <input
                name="code"
                required
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                autoComplete="one-time-code"
                className={partnerFieldClass}
              />
            </label>
            <div className="flex flex-wrap gap-2 sm:col-span-2">
              <button
                type="submit"
                disabled={busy}
                className={partnerPrimaryButtonClass}
              >
                {busy ? (
                  <LoaderCircle
                    className="h-4 w-4 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                ) : (
                  <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                )}
                {busy ? "Verifying…" : "Verify and enable"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setEnrollment(null);
                  setMessage(null);
                }}
                disabled={busy}
                className={partnerSecondaryButtonClass}
              >
                Cancel setup
              </button>
            </div>
          </form>
          <p className="mt-3 text-xs text-slate-600">
            Setup expires {dateLabel(enrollment.expiresAt)}. The secret is kept
            only on this screen while setup is open.
          </p>
        </div>
      ) : null}

      {!enrollment && security?.enrolled && !security.satisfied ? (
        <form
          onSubmit={(event) => void stepUp(event)}
          className="mt-5 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:p-5"
        >
          <h3 className="font-semibold text-slate-950">Verify this session</h3>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            Use a current authenticator code or one unused recovery code.
          </p>
          <div className="mt-4 grid gap-4 sm:grid-cols-[0.7fr_1.3fr]">
            <label>
              <span className="text-sm font-semibold text-slate-700">
                Method
              </span>
              <select name="verificationMethod" className={partnerFieldClass}>
                <option value="totp">Authenticator code</option>
                <option value="recovery">Recovery code</option>
              </select>
            </label>
            <label>
              <span className="text-sm font-semibold text-slate-700">
                Verification value
              </span>
              <input
                name="verification"
                required
                autoComplete="one-time-code"
                className={partnerFieldClass}
              />
            </label>
          </div>
          <button
            type="submit"
            disabled={busy}
            className={cn(partnerPrimaryButtonClass, "mt-4")}
          >
            {busy ? (
              <LoaderCircle
                className="h-4 w-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : (
              <KeyRound className="h-4 w-4" aria-hidden="true" />
            )}
            {busy ? "Verifying…" : "Verify session"}
          </button>
        </form>
      ) : null}

      {!enrollment && security && (!security.enrolled || security.satisfied) ? (
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-5">
          <div className="text-sm text-slate-600">
            {mfa.methods[0] ? (
              <>
                <span className="font-semibold text-slate-900">
                  {mfa.methods[0].label || "Authenticator app"}
                </span>
                <span className="block mt-0.5">
                  {mfa.methods[0].recoveryCodesRemaining} recovery codes remain.
                </span>
              </>
            ) : (
              "Use any app that supports time-based one-time passwords."
            )}
          </div>
          <button
            type="button"
            onClick={() => void beginEnrollment()}
            disabled={busy}
            className={partnerSecondaryButtonClass}
          >
            {busy ? (
              <LoaderCircle
                className="h-4 w-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : (
              <Smartphone className="h-4 w-4" aria-hidden="true" />
            )}
            {security.enrolled
              ? "Replace authenticator"
              : "Set up authenticator"}
          </button>
        </div>
      ) : null}
    </PartnerPanel>
  );
}

function SessionManager({
  initialSessions,
  initialEtag,
}: {
  initialSessions: PartnerSettingsSession[] | null;
  initialEtag: string | null;
}) {
  const router = useRouter();
  const [sessions, setSessions] = React.useState(initialSessions);
  const [etag, setEtag] = React.useState(initialEtag);
  const [busyHandle, setBusyHandle] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);

  const reload = React.useCallback(async (): Promise<void> => {
    const result = await partnerPortalFetch<{
      ok: true;
      sessions: PartnerSettingsSession[];
    }>("sessions").catch(() => null);
    if (!result?.ok) return;
    setSessions(result.data.sessions);
    setEtag(result.response.headers.get("etag"));
  }, []);

  async function revoke(session: PartnerSettingsSession): Promise<void> {
    if (!etag || session.status !== "active") return;
    const confirmed = window.confirm(
      session.current
        ? "Revoke this session and sign out now?"
        : `Revoke access for ${sessionLabel(session)}?`,
    );
    if (!confirmed) return;
    setBusyHandle(session.handle);
    setMessage(null);
    const result = await partnerPortalFetch<{
      ok: true;
      revoked: true;
      current: boolean;
    }>(`sessions/${encodeURIComponent(session.handle)}/revoke`, {
      method: "POST",
      headers: {
        "If-Match": etag,
        "Idempotency-Key": createPortalOperationKey("session-revoke"),
      },
      body: JSON.stringify({}),
    }).catch(() => null);
    setBusyHandle(null);
    if (!result?.ok) {
      setMessage({
        tone: "error",
        text:
          result?.response.status === 412
            ? "Your session list changed. It has been refreshed; review it and try again."
            : (result?.error.message ?? "We couldn’t revoke that session."),
      });
      await reload();
      return;
    }
    setEtag(result.response.headers.get("etag"));
    if (result.data.current) {
      router.replace("/partners/login");
      router.refresh();
      return;
    }
    setMessage({ tone: "success", text: "The selected session was revoked." });
    await reload();
  }

  React.useEffect(() => {
    const reloadAfterSecurityChange = (): void => {
      void reload();
    };
    window.addEventListener(
      "partner-session-security-changed",
      reloadAfterSecurityChange,
    );
    return () =>
      window.removeEventListener(
        "partner-session-security-changed",
        reloadAfterSecurityChange,
      );
  }, [reload]);

  return (
    <PartnerPanel>
      <div className="flex items-start gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-700 ring-1 ring-slate-200">
          <Laptop className="h-5 w-5" aria-hidden="true" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-slate-950">
            Signed-in devices
          </h2>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            Review recent portal sessions and revoke any device you no longer
            recognize.
          </p>
        </div>
      </div>
      {message ? (
        <PartnerNotice tone={message.tone} className="mt-5">
          {message.text}
        </PartnerNotice>
      ) : null}
      {!sessions ? (
        <PartnerNotice tone="warning" className="mt-5">
          Session history is temporarily unavailable.
        </PartnerNotice>
      ) : (
        <ul className="mt-5 divide-y divide-slate-200 border-y border-slate-200">
          {sessions.map((session) => (
            <li
              key={session.handle}
              className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-semibold text-slate-950">
                    {sessionLabel(session)}
                  </p>
                  {session.current ? (
                    <span className="rounded-full bg-primary-50 px-2 py-0.5 text-xs font-semibold text-primary-800 ring-1 ring-primary-200">
                      Current
                    </span>
                  ) : null}
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-xs font-semibold ring-1",
                      session.status === "active"
                        ? "bg-emerald-50 text-emerald-800 ring-emerald-200"
                        : "bg-slate-100 text-slate-600 ring-slate-200",
                    )}
                  >
                    {session.status}
                  </span>
                  {session.assuranceLevel === "aal2" ? (
                    <span className="rounded-full bg-sky-50 px-2 py-0.5 text-xs font-semibold text-sky-800 ring-1 ring-sky-200">
                      Two-step verified
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 text-sm text-slate-600">
                  Last active {dateLabel(session.lastSeenAt)} · expires{" "}
                  {dateLabel(session.expiresAt)}
                </p>
              </div>
              {session.status === "active" ? (
                <button
                  type="button"
                  onClick={() => void revoke(session)}
                  disabled={!etag || busyHandle !== null}
                  className={cn(
                    partnerSecondaryButtonClass,
                    "shrink-0 text-rose-700 hover:border-rose-200 hover:bg-rose-50",
                  )}
                >
                  {busyHandle === session.handle ? (
                    <LoaderCircle
                      className="h-4 w-4 animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                  ) : (
                    <LogOut className="h-4 w-4" aria-hidden="true" />
                  )}
                  {session.current ? "Sign out here" : "Revoke"}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </PartnerPanel>
  );
}

function NotificationPreferences({
  initial,
}: {
  initial: PartnerSettingsPreference[] | null;
}) {
  const [preferences, setPreferences] = React.useState(initial);
  const [baseline, setBaseline] = React.useState(initial);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);

  function updatePreference(
    eventKey: string,
    patch: Partial<PartnerSettingsPreference>,
  ): void {
    setPreferences(
      (current) =>
        current?.map((item) =>
          item.eventKey === eventKey ? { ...item, ...patch } : item,
        ) ?? null,
    );
  }

  function updateSchedule(
    patch: Pick<
      PartnerSettingsPreference,
      "quietHoursStart" | "quietHoursEnd" | "timezone"
    >,
  ): void {
    setPreferences(
      (current) => current?.map((item) => ({ ...item, ...patch })) ?? null,
    );
  }

  async function reload(): Promise<void> {
    const result = await partnerPortalFetch<{
      ok: true;
      preferences: PartnerSettingsPreference[];
    }>("notification-preferences").catch(() => null);
    if (result?.ok) {
      setPreferences(result.data.preferences);
      setBaseline(result.data.preferences);
    }
  }

  async function save(): Promise<void> {
    if (!preferences || !baseline) return;
    const changed = preferences.filter((preference) => {
      const original = baseline.find(
        (item) => item.eventKey === preference.eventKey,
      );
      return (
        !original || JSON.stringify(preference) !== JSON.stringify(original)
      );
    });
    if (!changed.length) {
      setMessage({
        tone: "success",
        text: "Notification preferences are already up to date.",
      });
      return;
    }
    setBusy(true);
    setMessage(null);
    for (const preference of changed) {
      const result = await partnerPortalFetch<{
        ok: true;
        preference: PartnerSettingsPreference;
      }>("notification-preferences", {
        method: "PUT",
        headers: {
          "If-Match": preference.etag,
          "Idempotency-Key": createPortalOperationKey(
            `notification-${preference.eventKey}`,
          ),
        },
        body: JSON.stringify({
          eventKey: preference.eventKey,
          inAppEnabled: preference.inAppEnabled,
          emailEnabled: preference.emailEnabled,
          smsEnabled: preference.smsEnabled,
          quietHoursStart: preference.quietHoursStart,
          quietHoursEnd: preference.quietHoursEnd,
          timezone: preference.timezone,
        }),
      }).catch(() => null);
      if (!result?.ok) {
        setBusy(false);
        setMessage({
          tone: "error",
          text:
            result?.response.status === 412
              ? "These preferences changed in another session. We refreshed them so you can review the latest settings."
              : result?.error.error === "invalid_fields" &&
                  preference.smsEnabled
                ? "SMS can be enabled only after Stonegate verifies your text-message opt-in. Other saved choices remain unchanged."
                : (result?.error.message ??
                  "We couldn’t save every notification preference."),
        });
        await reload();
        return;
      }
    }
    setBusy(false);
    setMessage({ tone: "success", text: "Notification preferences saved." });
    await reload();
  }

  const first = preferences?.[0];
  const quietHoursComplete = Boolean(
    !first ||
      (first.quietHoursStart === null && first.quietHoursEnd === null) ||
      (first.quietHoursStart !== null && first.quietHoursEnd !== null),
  );
  const dirty = Boolean(
    preferences &&
      baseline &&
      preferences.some((preference) => {
        const original = baseline.find(
          (item) => item.eventKey === preference.eventKey,
        );
        return (
          !original || JSON.stringify(preference) !== JSON.stringify(original)
        );
      }),
  );

  React.useEffect(() => {
    if (!dirty) return;
    const protectUnsavedChanges = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", protectUnsavedChanges);
    return () =>
      window.removeEventListener("beforeunload", protectUnsavedChanges);
  }, [dirty]);

  return (
    <PartnerPanel>
      <div className="flex items-start gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary-50 text-primary-700 ring-1 ring-primary-100">
          <BellRing className="h-5 w-5" aria-hidden="true" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-slate-950">
            Notification preferences
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
            Choose where account updates arrive. Urgent same-day schedule
            changes may bypass quiet hours.
          </p>
        </div>
      </div>
      {message ? (
        <PartnerNotice tone={message.tone} className="mt-5">
          {message.text}
        </PartnerNotice>
      ) : null}
      {!preferences || !first ? (
        <PartnerNotice tone="warning" className="mt-5">
          Notification preferences are temporarily unavailable.
        </PartnerNotice>
      ) : (
        <>
          <div className="mt-5 grid gap-4 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:grid-cols-3">
            <label>
              <span className="text-sm font-semibold text-slate-700">
                Quiet hours start
              </span>
              <input
                type="time"
                value={first.quietHoursStart ?? ""}
                onChange={(event) =>
                  updateSchedule({
                    quietHoursStart: event.target.value || null,
                    quietHoursEnd: first.quietHoursEnd,
                    timezone: first.timezone,
                  })
                }
                className={partnerFieldClass}
              />
            </label>
            <label>
              <span className="text-sm font-semibold text-slate-700">
                Quiet hours end
              </span>
              <input
                type="time"
                value={first.quietHoursEnd ?? ""}
                onChange={(event) =>
                  updateSchedule({
                    quietHoursStart: first.quietHoursStart,
                    quietHoursEnd: event.target.value || null,
                    timezone: first.timezone,
                  })
                }
                className={partnerFieldClass}
              />
            </label>
            <label>
              <span className="text-sm font-semibold text-slate-700">
                Timezone
              </span>
              <select
                value={first.timezone}
                onChange={(event) =>
                  updateSchedule({
                    quietHoursStart: first.quietHoursStart,
                    quietHoursEnd: first.quietHoursEnd,
                    timezone: event.target.value,
                  })
                }
                className={partnerFieldClass}
              >
                <option value="America/New_York">Eastern time</option>
                <option value="America/Chicago">Central time</option>
                <option value="America/Denver">Mountain time</option>
                <option value="America/Phoenix">Arizona time</option>
                <option value="America/Los_Angeles">Pacific time</option>
                <option value="America/Anchorage">Alaska time</option>
                <option value="Pacific/Honolulu">Hawaii time</option>
              </select>
            </label>
            <p className="text-xs leading-5 text-slate-500 sm:col-span-3">
              Leave both quiet-hour fields empty to receive ordinary
              notifications at any time.
            </p>
            {!quietHoursComplete ? (
              <p
                className="text-sm font-medium text-rose-700 sm:col-span-3"
                role="alert"
              >
                Add both a start and end time, or clear both fields.
              </p>
            ) : null}
          </div>

          <div className="mt-5 overflow-x-auto rounded-xl border border-slate-200">
            <table className="w-full min-w-[42rem] border-collapse text-left">
              <caption className="sr-only">
                Delivery channels for each partner notification
              </caption>
              <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-[0.1em] text-slate-500">
                <tr>
                  <th scope="col" className="px-4 py-3">
                    Update
                  </th>
                  <th scope="col" className="px-3 py-3 text-center">
                    In app
                  </th>
                  <th scope="col" className="px-3 py-3 text-center">
                    Email
                  </th>
                  <th scope="col" className="px-3 py-3 text-center">
                    SMS
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {preferences.map((preference) => {
                  const label = EVENT_LABELS[preference.eventKey] ?? {
                    title: preference.eventKey.replaceAll("_", " "),
                    description: "Account update.",
                  };
                  return (
                    <tr key={preference.eventKey}>
                      <th scope="row" className="px-4 py-4">
                        <span className="block text-sm font-semibold text-slate-950">
                          {label.title}
                        </span>
                        <span className="mt-0.5 block text-xs font-normal leading-5 text-slate-500">
                          {label.description}
                        </span>
                      </th>
                      {(
                        ["inAppEnabled", "emailEnabled", "smsEnabled"] as const
                      ).map((channel) => {
                        const smsUnavailable =
                          channel === "smsEnabled" &&
                          !preference.smsOptInVerified;
                        return (
                          <td key={channel} className="px-3 py-4 text-center">
                            <label className="inline-flex h-11 w-11 cursor-pointer items-center justify-center rounded-lg hover:bg-slate-100 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60">
                              <input
                                type="checkbox"
                                checked={preference[channel]}
                                disabled={busy || smsUnavailable}
                                onChange={(event) =>
                                  updatePreference(preference.eventKey, {
                                    [channel]: event.target.checked,
                                  })
                                }
                                aria-label={`${label.title}: ${channel === "inAppEnabled" ? "in app" : channel === "emailEnabled" ? "email" : "SMS"}`}
                                aria-describedby={
                                  smsUnavailable
                                    ? `sms-unavailable-${preference.eventKey}`
                                    : undefined
                                }
                                className="h-5 w-5 rounded border-slate-300 text-primary-700 focus:ring-2 focus:ring-accent-500"
                              />
                            </label>
                            {smsUnavailable ? (
                              <span
                                id={`sms-unavailable-${preference.eventKey}`}
                                className="sr-only"
                              >
                                Verified SMS opt-in required
                              </span>
                            ) : null}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!preferences.some((preference) => preference.smsOptInVerified) ? (
            <p className="mt-3 text-xs leading-5 text-slate-500">
              SMS controls stay unavailable until your mobile number and
              text-message opt-in are verified.
            </p>
          ) : null}
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy || !dirty || !quietHoursComplete}
              className={partnerPrimaryButtonClass}
            >
              {busy ? (
                <LoaderCircle
                  className="h-4 w-4 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : (
                <Check className="h-4 w-4" aria-hidden="true" />
              )}
              {busy ? "Saving…" : "Save preferences"}
            </button>
            {dirty ? (
              <span className="text-sm text-amber-800" role="status">
                Unsaved changes
              </span>
            ) : null}
          </div>
        </>
      )}
    </PartnerPanel>
  );
}

export function PartnerAccountSecurityManager({
  accounts,
  mfa,
  sessions,
  sessionsEtag,
  preferences,
}: {
  accounts: PartnerSettingsAccount[];
  mfa: PartnerSettingsMfa | null;
  sessions: PartnerSettingsSession[] | null;
  sessionsEtag: string | null;
  preferences: PartnerSettingsPreference[] | null;
}) {
  return (
    <div className="space-y-5 sm:space-y-6">
      <AccountSwitcher accounts={accounts} />
      <MfaManager initial={mfa} />
      <SessionManager initialSessions={sessions} initialEtag={sessionsEtag} />
      <NotificationPreferences initial={preferences} />
    </div>
  );
}
