"use client";

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
  revokedAt: string | null;
  createdAt: string;
  allowedActions: Array<"resend" | "revoke">;
  etag: string;
};

type InvitationListPayload = { ok: true; invitations: PartnerInvitation[] };

function dateTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date)
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
}: {
  initialInvitations: PartnerInvitation[];
  roles: PartnerTeamRole[];
}) {
  const [invitations, setInvitations] = React.useState(initialInvitations);
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

  async function refresh(): Promise<void> {
    const result = await partnerPortalFetch<InvitationListPayload>(
      "invitations?limit=100",
    ).catch(() => null);
    if (result?.ok) setInvitations(result.data.invitations);
  }

  async function create(
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    setBusy("create");
    setNotice(null);
    const result = await partnerPortalFetch<{
      ok: true;
      status: string;
      invitation?: PartnerInvitation;
    }>("invitations", {
      method: "POST",
      headers: {
        "Idempotency-Key": createPortalOperationKey(
          "partner-invitation-create",
        ),
      },
      body: JSON.stringify({ name, email, roleKey, persona }),
    }).catch(() => null);
    setBusy(null);
    if (!result?.ok) {
      setNotice({
        tone:
          result?.error.error === "mfa_step_up_required" ? "warning" : "error",
        text:
          result?.error.error === "mfa_step_up_required"
            ? "Verify this session with MFA in Account & security before inviting teammates."
            : (result?.error.message ??
              "We couldn’t queue this invitation. No access was granted."),
      });
      return;
    }
    setName("");
    setEmail("");
    setNotice({
      tone: "success",
      text: "If the address is eligible, a one-time invitation has been queued. It expires after 30 minutes.",
    });
    await refresh();
  }

  async function mutate(
    invitation: PartnerInvitation,
    action: "resend" | "revoke",
  ): Promise<void> {
    setBusy(`${invitation.id}:${action}`);
    setNotice(null);
    const result = await partnerPortalFetch<{
      ok: true;
      invitation: PartnerInvitation;
    }>(`invitations/${encodeURIComponent(invitation.id)}`, {
      method: "POST",
      headers: {
        "If-Match": invitation.etag,
        "Idempotency-Key": createPortalOperationKey(
          `partner-invitation-${action}`,
        ),
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
          ? "A fresh one-time invitation was queued; the previous link no longer works."
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
            Invite a teammate
          </h2>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            Choose only roles within your authority. The email link is
            company-bound, one-use, and valid for 30 minutes.
          </p>
        </div>
      </div>
      {notice ? (
        <PartnerNotice tone={notice.tone} className="mt-4">
          {notice.text}
        </PartnerNotice>
      ) : null}
      <form
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
            onChange={(event) => setRoleKey(event.target.value)}
            className={partnerFieldClass}
          >
            {roles.map((role) => (
              <option value={role.key} key={role.key}>
                {role.name}
                {role.mfaRequired ? " · MFA required" : ""}
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
        <div className="sm:col-span-2">
          <button
            type="submit"
            disabled={busy !== null || !roles.length}
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
            {busy === "create" ? "Queueing…" : "Send invitation"}
          </button>
        </div>
      </form>

      <div className="mt-7 border-t border-slate-200 pt-5">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-semibold text-slate-950">Invitation history</h3>
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
                        ? "Queueing…"
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
              No invitations have been sent from this account.
            </p>
          ) : null}
        </div>
      </div>
    </PartnerPanel>
  );
}
