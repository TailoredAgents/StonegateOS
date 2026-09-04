"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  BellRing,
  Building2,
  Check,
  Laptop,
  LoaderCircle,
  LogOut,
  RefreshCw,
} from "lucide-react";
import { cn } from "@myst-os/ui";
import {
  createPortalOperationKey,
  partnerPortalFetch,
  portalSupportReferenceFromResponse,
  withPortalSupportReference,
} from "../lib/portal-v2";
import {
  hasVerifiedPartnerSmsEndpoint,
  type PartnerSmsEndpoint,
} from "../lib/notification-endpoints";
import {
  PartnerNotice,
  PartnerPanel,
  partnerFieldClass,
  partnerPrimaryButtonClass,
  partnerSecondaryButtonClass,
} from "./PartnerPortalUi";
import { PartnerSmsEndpointManager } from "./PartnerSmsEndpointManager";

export type PartnerSettingsAccount = {
  id: string;
  name: string;
  status: string;
  membershipId: string;
  roleKey: string;
  accessLevel: string;
  current: boolean;
  defaultAccount: boolean;
};

export type PartnerSettingsSession = {
  handle: string;
  current: boolean;
  status: "active" | "expired" | "revoked" | "retired";
  authMethod: string;
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
    description: "New teammate and company-access decisions.",
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
  const current = accounts.find((account) => account.current) ?? accounts[0];
  const [selected, setSelected] = React.useState(current?.id ?? "");
  const selectedAccount = accounts.find((account) => account.id === selected);
  const [makeDefault, setMakeDefault] = React.useState(
    current?.defaultAccount ?? false,
  );
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);

  React.useEffect(() => {
    setSelected(current?.id ?? "");
    setMakeDefault(current?.defaultAccount ?? false);
  }, [current?.defaultAccount, current?.id]);

  async function switchAccount(): Promise<void> {
    const shouldChangeAccount = selected !== current?.id;
    const shouldChangeDefault = makeDefault && !selectedAccount?.defaultAccount;
    if (!selected || (!shouldChangeAccount && !shouldChangeDefault) || busy)
      return;
    if (document.querySelector('[data-partner-unsaved="true"]')) {
      setMessage(
        "Save or discard your unsaved changes before switching accounts.",
      );
      return;
    }
    setBusy(true);
    setMessage(null);
    const result = await partnerPortalFetch<{
      ok: true;
      currentAccountId: string;
      currentMembershipId: string;
      defaultAccount: boolean;
    }>("session/account", {
      method: "POST",
      body: JSON.stringify({ accountId: selected, makeDefault }),
    }).catch(() => null);
    if (!result || !result.ok || result.data.currentAccountId !== selected) {
      const failureMessage =
        result && !result.ok
          ? result.error.message
          : withPortalSupportReference(
              "We couldn’t switch accounts. Your current account is unchanged.",
              result?.response
                ? portalSupportReferenceFromResponse(result.response)
                : null,
            );
      setBusy(false);
      setMessage(failureMessage);
      return;
    }
    // A full navigation prevents account-owned React/server caches from
    // surviving the tenant switch.
    globalThis.location.assign("/partners/overview");
  }

  return (
    <PartnerPanel>
      <div className="flex items-start gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary-50 text-primary-700 ring-1 ring-primary-100">
          <Building2 className="h-5 w-5" aria-hidden="true" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-slate-950">
            Choose your company
          </h2>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            Pick the company you want to work with now. Its jobs, locations,
            billing, and preferences stay separate from every other company.
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
              onChange={(event) => {
                const accountId = event.target.value;
                setSelected(accountId);
                setMakeDefault(
                  accounts.find((account) => account.id === accountId)
                    ?.defaultAccount ?? false,
                );
                setMessage(null);
              }}
              disabled={busy}
              className={partnerFieldClass}
            >
              {accounts.map((account) => (
                <option value={account.id} key={account.membershipId}>
                  {account.name} · {account.roleKey.replaceAll("_", " ")}
                  {account.defaultAccount ? " · default" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-h-11 items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm font-medium text-slate-700">
            <input
              type="checkbox"
              checked={makeDefault}
              onChange={(event) => {
                setMakeDefault(event.target.checked);
                setMessage(null);
              }}
              disabled={busy || Boolean(selectedAccount?.defaultAccount)}
              className="h-5 w-5 rounded border-slate-300 text-primary-700 focus-visible:ring-2 focus-visible:ring-accent-500"
            />
            Default after sign-in
          </label>
          <button
            type="button"
            onClick={() => void switchAccount()}
            disabled={
              busy ||
              !selected ||
              (selected === current?.id &&
                (!makeDefault || Boolean(selectedAccount?.defaultAccount)))
            }
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
          No approved company accounts are available for this sign-in.
        </PartnerNotice>
      )}
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
        : `Sign out ${sessionLabel(session)}?`,
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
        text: withPortalSupportReference(
          result?.response.status === 412
            ? "Your session list changed. It has been refreshed; review it and try again."
            : (result?.error.message ?? "We couldn’t revoke that session."),
          result?.error.correlationId,
        ),
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
    setMessage({ tone: "success", text: "The selected sign-in was ended." });
    await reload();
  }

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
            Quickly check where your account is signed in and remove any device
            you no longer recognize.
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
                  {session.current ? "Sign out here" : "Sign out device"}
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
  smsEndpointVerified,
  endpointRevision,
}: {
  initial: PartnerSettingsPreference[] | null;
  smsEndpointVerified: boolean;
  endpointRevision: number;
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

  const reload = React.useCallback(async (): Promise<void> => {
    const result = await partnerPortalFetch<{
      ok: true;
      preferences: PartnerSettingsPreference[];
    }>("notification-preferences").catch(() => null);
    if (result?.ok) {
      setPreferences(result.data.preferences);
      setBaseline(result.data.preferences);
    }
  }, []);

  React.useEffect(() => {
    if (endpointRevision === 0) return;
    void reload();
  }, [endpointRevision, reload]);

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
          text: withPortalSupportReference(
            result?.response.status === 412
              ? "These preferences changed in another session. We refreshed them so you can review the latest settings."
              : result?.error.error === "invalid_fields" &&
                  preference.smsEnabled
                ? "SMS can be enabled only after Stonegate verifies your text-message opt-in. Other saved choices remain unchanged."
                : (result?.error.message ??
                  "We couldn’t save every notification preference."),
            result?.error.correlationId,
          ),
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
    <div data-partner-unsaved={dirty ? "true" : undefined}>
      <PartnerPanel>
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary-50 text-primary-700 ring-1 ring-primary-100">
            <BellRing className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-slate-950">
              Choose how Stonegate keeps you updated
            </h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
              Get the updates that help service keep moving, in the places you
              prefer. Urgent same-day schedule changes may bypass quiet hours.
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

            <div
              className="mt-5 overflow-x-auto rounded-xl border border-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2"
              role="region"
              aria-label="Notification delivery channels"
              tabIndex={0}
            >
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
                          [
                            "inAppEnabled",
                            "emailEnabled",
                            "smsEnabled",
                          ] as const
                        ).map((channel) => {
                          const smsUnavailable =
                            channel === "smsEnabled" && !smsEndpointVerified;
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
            {!smsEndpointVerified ? (
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
    </div>
  );
}

export function PartnerAccountSecurityManager({
  accounts,
  sessions,
  sessionsEtag,
  preferences,
  smsEndpoints,
  canManageSmsEndpoints,
}: {
  accounts: PartnerSettingsAccount[];
  sessions: PartnerSettingsSession[] | null;
  sessionsEtag: string | null;
  preferences: PartnerSettingsPreference[] | null;
  smsEndpoints: PartnerSmsEndpoint[] | null;
  canManageSmsEndpoints: boolean;
}) {
  const [smsEndpointVerified, setSmsEndpointVerified] = React.useState(
    hasVerifiedPartnerSmsEndpoint(smsEndpoints),
  );
  const [endpointRevision, setEndpointRevision] = React.useState(0);
  const endpointChanged = React.useCallback(
    (
      _endpoints: PartnerSmsEndpoint[],
      verified: boolean,
      preferencesChanged: boolean,
    ): void => {
      setSmsEndpointVerified(verified);
      if (preferencesChanged) {
        setEndpointRevision((current) => current + 1);
      }
    },
    [],
  );

  return (
    <div className="space-y-5 sm:space-y-6">
      <AccountSwitcher accounts={accounts} />
      <SessionManager initialSessions={sessions} initialEtag={sessionsEtag} />
      <PartnerSmsEndpointManager
        initialEndpoints={smsEndpoints}
        canManage={canManageSmsEndpoints}
        onEndpointsChange={endpointChanged}
      />
      <NotificationPreferences
        initial={preferences}
        smsEndpointVerified={smsEndpointVerified}
        endpointRevision={endpointRevision}
      />
    </div>
  );
}
