"use client";

import { formatPartnerDateTime } from "../lib/partner-date-time";
import * as React from "react";
import {
  LoaderCircle,
  MailPlus,
  RefreshCw,
  RotateCw,
  XCircle,
} from "lucide-react";
import { cn } from "@myst-os/ui";
import {
  createPortalOperationKey,
  partnerPortalFetch,
} from "@/app/partners/lib/portal-v2";
import type { PartnerTeamRole } from "./PartnerTeamManager";
import {
  PartnerNotice,
  PartnerPanel,
  partnerFieldClass,
  partnerPrimaryButtonClass,
  partnerSecondaryButtonClass,
} from "./PartnerPortalUi";

export type PartnerInvitation = {
  id: string;
  email: string;
  name: string;
  role: { key: string };
  persona: string;
  status: "pending" | "accepted" | "revoked" | "expired";
  delivery: {
    status:
      | "queued"
      | "dispatching"
      | "accepted"
      | "failed"
      | "reconciliation_required";
    sentAt: string | null;
  };
  expiresAt: string;
  acceptedAt: string | null;
  activatedAt?: string | null;
  revokedAt: string | null;
  createdAt: string;
  allowedActions: Array<"resend" | "revoke">;
  etag: string;
};

export type PartnerInvitationScopeOptions = {
  locations: { id: string; label: string }[];
  costCenters: { id: string; label: string }[];
  moreResults: boolean;
};
type InvitationListPayload = {
  ok: true;
  invitations: PartnerInvitation[];
  scopeOptions: PartnerInvitationScopeOptions;
  page?: { nextCursor: string | null };
};

function dateTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? formatPartnerDateTime(date)
    : "Unavailable";
}

function label(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

export function PartnerInvitationManager({
  initialInvitations,
  roles,
  initialScopeOptions = { locations: [], costCenters: [], moreResults: false },
  initialNextCursor = null,
}: {
  initialInvitations: PartnerInvitation[];
  roles: PartnerTeamRole[];
  initialScopeOptions?: PartnerInvitationScopeOptions;
  initialNextCursor?: string | null;
}) {
  const [invitations, setInvitations] = React.useState(initialInvitations);
  const [nextCursor, setNextCursor] = React.useState(initialNextCursor);
  React.useEffect(() => setNextCursor(initialNextCursor), [initialNextCursor]);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<{
    tone: "success" | "error" | "warning";
    text: string;
  } | null>(null);
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  // Role selection is an explicit access-control decision; never infer it
  // from API or array ordering.
  const [roleKey, setRoleKey] = React.useState("");
  const [persona, setPersona] = React.useState("other");
  const [scopeOptions, setScopeOptions] = React.useState(initialScopeOptions);
  const [scopeQuery, setScopeQuery] = React.useState("");
  const [scoped, setScoped] = React.useState(false);
  const [locationIds, setLocationIds] = React.useState<string[]>([]);
  const [costCenterIds, setCostCenterIds] = React.useState<string[]>([]);
  const scopeLabels = React.useRef(
    new Map(
      [
        ...initialScopeOptions.locations,
        ...initialScopeOptions.costCenters,
      ].map((choice) => [choice.id, choice.label]),
    ),
  );
  const operation = React.useRef<{ body: string; key: string } | null>(null);
  const mutationOperation = React.useRef<{ body: string; key: string } | null>(
    null,
  );
  const noticeRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (notice) noticeRef.current?.focus();
  }, [notice]);
  React.useEffect(() => {
    setInvitations(initialInvitations);
  }, [initialInvitations]);

  async function searchScopes() {
    if (busy) return;
    setBusy("scope");
    const result = await partnerPortalFetch<InvitationListPayload>(
      "invitations?limit=100&scopeQ=" + encodeURIComponent(scopeQuery),
    ).catch(() => null);
    setBusy(null);
    if (!result?.ok || !result.data.scopeOptions) {
      setNotice({
        tone: "error",
        text: "Locations and cost centers could not be loaded. Your selections were kept.",
      });
      return;
    }
    for (const choice of [
      ...result.data.scopeOptions.locations,
      ...result.data.scopeOptions.costCenters,
    ])
      scopeLabels.current.set(choice.id, choice.label);
    setScopeOptions(result.data.scopeOptions);
  }

  async function refresh(): Promise<void> {
    const result = await partnerPortalFetch<InvitationListPayload>(
      "invitations?limit=100",
    ).catch(() => null);
    if (result?.ok && Array.isArray(result.data.invitations)) {
      setInvitations(result.data.invitations);
      setNextCursor(result.data.page?.nextCursor ?? null);
    } else {
      setNotice({
        tone: "error",
        text: "We couldn’t refresh invitation status. The list below may be out of date; nothing was changed.",
      });
    }
  }

  async function loadOlder() {
    if (busy || !nextCursor) return;
    setBusy("older");
    const result = await partnerPortalFetch<InvitationListPayload>("invitations?limit=100&cursor=" + encodeURIComponent(nextCursor)).catch(() => null);
    setBusy(null);
    if (!result?.ok || !Array.isArray(result.data.invitations)) { setNotice({ tone: "error", text: "Older invitations could not be loaded. The current list was kept." }); return; }
    setInvitations((current) => [...current, ...result.data.invitations.filter((row) => !current.some((existing) => existing.id === row.id))]);
    setNextCursor(result.data.page?.nextCursor ?? null);
  }

  async function create(
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    if (
      busy ||
      !event.currentTarget.reportValidity() ||
      !roleKey ||
      (scoped && locationIds.length + costCenterIds.length === 0)
    )
      return;
    setBusy("create");
    setNotice(null);
    const body = JSON.stringify({
      name,
      email,
      roleKey,
      persona,
      accessLevel: scoped ? "scoped" : "account",
      locationIds,
      costCenterIds,
    });
    if (operation.current?.body !== body)
      operation.current = {
        body,
        key: createPortalOperationKey("partner-invitation-create"),
      };
    const result = await partnerPortalFetch<{
      ok: true;
      status: string;
      invitation?: PartnerInvitation;
    }>("invitations", {
      method: "POST",
      headers: {
        "Idempotency-Key": operation.current.key,
      },
      body,
    }).catch(() => null);
    setBusy(null);
    if (!result?.ok) {
      setNotice({
        tone: "error",
        text:
          result?.error.message ??
          "We couldn’t create this invitation. No access was granted.",
      });
      return;
    }
    setName("");
    setEmail("");
    operation.current = null;
    setRoleKey("");
    setScoped(false);
    setLocationIds([]);
    setCostCenterIds([]);
    setNotice({
      tone: "success",
      text: "Invitation request accepted. If the address can be invited, one setup email is queued. Its one-use link expires after seven days.",
    });
    await refresh();
  }

  async function mutate(
    invitation: PartnerInvitation,
    action: "resend" | "revoke",
  ): Promise<void> {
    if (busy) return;
    setBusy(`${invitation.id}:${action}`);
    setNotice(null);
    const signature = invitation.id + ":" + invitation.etag + ":" + action;
    if (mutationOperation.current?.body !== signature)
      mutationOperation.current = {
        body: signature,
        key: createPortalOperationKey("partner-invitation-" + action),
      };
    const result = await partnerPortalFetch<{
      ok: true;
      invitation: PartnerInvitation;
    }>(`invitations/${encodeURIComponent(invitation.id)}`, {
      method: "POST",
      headers: {
        "If-Match": invitation.etag,
        "Idempotency-Key": mutationOperation.current.key,
      },
      body: JSON.stringify({ action }),
    }).catch(() => null);
    setBusy(null);
    if (!result?.ok) {
      setNotice({
        tone:
          result?.error.error === "revision_mismatch" ||
          result?.error.error === "conflict"
            ? "warning"
            : "error",
        text:
          result?.error.error === "revision_mismatch"
            ? "This invitation changed in another session. Refresh before trying again."
            : (result?.error.message ?? "We couldn’t change this invitation."),
      });
      return;
    }
    setInvitations((current) =>
      current.map((row) =>
        row.id === invitation.id ? result.data.invitation : row,
      ),
    );
    setNotice({
      tone: "success",
      text:
        action === "resend"
          ? "A new one-time invitation was requested; the previous link no longer works."
          : "Invitation revoked. Its link can no longer be used.",
    });
  }

  return (
    <PartnerPanel>
      <div className="flex items-start gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary-50 text-primary-700 ring-1 ring-primary-100">
          <MailPlus className="h-5 w-5" aria-hidden="true" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-slate-950">
            Add a teammate
          </h2>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            Add the people who help request or manage service. Choose the right
            role carefully; each invitation works only for this company, can be
            used once, and expires after seven days.
          </p>
        </div>
      </div>
      {notice ? (
        <div ref={noticeRef} tabIndex={-1}>
          <PartnerNotice tone={notice.tone} className="mt-4">
            {notice.text}
          </PartnerNotice>
        </div>
      ) : null}
      <form
        method="post"
        onSubmit={(event) => void create(event)}
        className="mt-5 grid gap-4 sm:grid-cols-2"
      >
        <label>
          <span className="text-sm font-semibold text-slate-700">
            Full name
          </span>
          <input
            required
            minLength={2}
            maxLength={120}
            autoComplete="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className={partnerFieldClass}
          />
        </label>
        <label>
          <span className="text-sm font-semibold text-slate-700">
            Work email
          </span>
          <input
            required
            type="email"
            maxLength={254}
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className={partnerFieldClass}
          />
        </label>
        <label>
          <span className="text-sm font-semibold text-slate-700">Role</span>
          <select
            required
            value={roleKey}
            onChange={(event) => {
              setRoleKey(event.target.value);
              if (event.target.value === "administrator") {
                setScoped(false);
                setLocationIds([]);
                setCostCenterIds([]);
              }
            }}
            className={partnerFieldClass}
          >
            <option value="" disabled>
              Choose a role
            </option>
            {roles.map((role) => (
              <option value={role.key} key={role.key}>
                {role.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="text-sm font-semibold text-slate-700">
            Partner type
          </span>
          <select
            value={persona}
            onChange={(event) => setPersona(event.target.value)}
            className={partnerFieldClass}
          >
            <option value="contractor">Contractor</option>
            <option value="real_estate_agent">Real-estate agent</option>
            <option value="property_manager">Property manager</option>
            <option value="commercial_client">Commercial client</option>
            <option value="other">Other</option>
          </select>
        </label>
        {roleKey ? (
          <p className="text-sm leading-6 text-slate-600 sm:col-span-2">
            {roles.find((role) => role.key === roleKey)?.description}
          </p>
        ) : null}
        {roleKey && roleKey !== "administrator" ? (
          <label className="flex min-h-11 items-center gap-3 text-sm sm:col-span-2">
            <input
              type="checkbox"
              checked={scoped}
              onChange={(event) => {
                setScoped(event.target.checked);
                if (!event.target.checked) {
                  setLocationIds([]);
                  setCostCenterIds([]);
                }
              }}
              className="h-5 w-5"
            />
            Limit this person to selected locations or cost centers
          </label>
        ) : null}
        {scoped ? (
          <fieldset className="space-y-3 rounded-xl border border-slate-200 p-4 sm:col-span-2">
            <legend className="px-1 text-sm font-semibold">
              Permitted locations and cost centers
            </legend>
            <div className="flex flex-wrap items-end gap-2">
              <label className="min-w-0 flex-1 text-sm">
                Find a location or cost center
                <input
                  type="search"
                  value={scopeQuery}
                  maxLength={160}
                  onChange={(event) => setScopeQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void searchScopes();
                    }
                  }}
                  className={partnerFieldClass}
                />
              </label>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void searchScopes()}
                className={partnerSecondaryButtonClass}
              >
                Search
              </button>
            </div>
            {scopeOptions.moreResults ? (
              <p className="text-sm text-slate-600">
                More choices are available. Search by name to narrow the list.
              </p>
            ) : null}
            {!scopeOptions.locations.length &&
            !scopeOptions.costCenters.length ? (
              <p className="text-sm text-slate-600">
                No matching choices. Add a location first or try another search.
              </p>
            ) : null}
            {scopeOptions.locations.map((choice) => (
              <label
                key={choice.id}
                className="flex min-h-11 items-center gap-3 text-sm"
              >
                <input
                  type="checkbox"
                  checked={locationIds.includes(choice.id)}
                  disabled={
                    !locationIds.includes(choice.id) &&
                    locationIds.length >= 100
                  }
                  onChange={() =>
                    setLocationIds((current) =>
                      current.includes(choice.id)
                        ? current.filter((id) => id !== choice.id)
                        : [...current, choice.id],
                    )
                  }
                  className="h-5 w-5"
                />
                Location: {choice.label}
              </label>
            ))}
            {scopeOptions.costCenters.map((choice) => (
              <label
                key={choice.id}
                className="flex min-h-11 items-center gap-3 text-sm"
              >
                <input
                  type="checkbox"
                  checked={costCenterIds.includes(choice.id)}
                  disabled={
                    !costCenterIds.includes(choice.id) &&
                    costCenterIds.length >= 100
                  }
                  onChange={() =>
                    setCostCenterIds((current) =>
                      current.includes(choice.id)
                        ? current.filter((id) => id !== choice.id)
                        : [...current, choice.id],
                    )
                  }
                  className="h-5 w-5"
                />
                Cost center: {choice.label}
              </label>
            ))}
            <p className="text-sm font-semibold">
              {locationIds.length + costCenterIds.length} selected. Choose at
              least one.
            </p>
            {[...locationIds, ...costCenterIds].map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => {
                  setLocationIds((current) =>
                    current.filter((value) => value !== id),
                  );
                  setCostCenterIds((current) =>
                    current.filter((value) => value !== id),
                  );
                }}
                className="mr-2 min-h-11 text-sm text-primary-900 underline"
              >
                Remove {scopeLabels.current.get(id) ?? "selection"}
              </button>
            ))}
          </fieldset>
        ) : null}
        <div className="sm:col-span-2">
          <button
            type="submit"
            disabled={
              busy !== null ||
              !roles.length ||
              !roleKey ||
              (scoped && !locationIds.length && !costCenterIds.length)
            }
            className={partnerPrimaryButtonClass}
          >
            {busy === "create" ? (
              <LoaderCircle
                className="h-4 w-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : (
              <MailPlus className="h-4 w-4" aria-hidden="true" />
            )}
            {busy === "create" ? "Sending…" : "Send invitation"}
          </button>
        </div>
      </form>

      <div className="mt-7 border-t border-slate-200 pt-5">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-semibold text-slate-950">Recent invitations</h3>
          <button
            type="button"
            onClick={() => void refresh()}
            className={partnerSecondaryButtonClass}
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" /> Refresh
          </button>
        </div>
        <p className="sr-only" role="status" aria-live="polite">
          {invitations.length} invitation
          {invitations.length === 1 ? "" : "s"} shown.
        </p>
        <div className="mt-4 space-y-3">
          {invitations.map((invitation) => (
            <article
              key={invitation.id}
              className="rounded-xl border border-slate-200 p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h4 className="font-semibold text-slate-950">
                    {invitation.name}
                  </h4>
                  <p className="break-all text-sm text-slate-600">
                    {invitation.email}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {label(invitation.role.key)} · {label(invitation.persona)} ·
                    expires {dateTime(invitation.expiresAt)}
                  </p>
                </div>
                <span
                  className={cn(
                    "rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset",
                    invitation.status === "accepted"
                      ? "bg-emerald-50 text-emerald-800 ring-emerald-200"
                      : invitation.status === "pending"
                        ? "bg-amber-50 text-amber-900 ring-amber-200"
                        : "bg-slate-100 text-slate-700 ring-slate-200",
                  )}
                >
                  {label(invitation.status)}
                </span>
              </div>
              <p className="mt-2 text-xs text-slate-600">
                Delivery: {label(invitation.delivery.status)}
              </p>
              {invitation.allowedActions.length ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {invitation.allowedActions.includes("resend") ? (
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void mutate(invitation, "resend")}
                      className={partnerSecondaryButtonClass}
                    >
                      <RotateCw className="h-4 w-4" aria-hidden="true" />{" "}
                      {busy === `${invitation.id}:resend`
                        ? "Sending…"
                        : "Resend"}
                    </button>
                  ) : null}
                  {invitation.allowedActions.includes("revoke") ? (
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void mutate(invitation, "revoke")}
                      className={partnerSecondaryButtonClass}
                    >
                      <XCircle className="h-4 w-4" aria-hidden="true" />{" "}
                      {busy === `${invitation.id}:revoke`
                        ? "Revoking…"
                        : "Revoke"}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </article>
          ))}
          {!invitations.length ? (
            <p className="py-4 text-sm text-slate-600">
              No invitations have been sent from this account yet.
            </p>
          ) : null}
        </div>
      </div>
      {nextCursor ? <button type="button" disabled={busy !== null} onClick={() => void loadOlder()} className={cn(partnerSecondaryButtonClass, "mt-4")}>Load older invitations</button> : null}
    </PartnerPanel>
  );
}
