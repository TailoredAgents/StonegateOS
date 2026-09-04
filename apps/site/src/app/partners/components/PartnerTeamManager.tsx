"use client";

import * as React from "react";
import {
  Ban,
  CheckCircle2,
  LoaderCircle,
  RefreshCw,
  Search,
  UserRoundCog,
  UsersRound,
} from "lucide-react";
import { cn } from "@myst-os/ui";
import {
  createPortalOperationKey,
  partnerPortalFetch,
} from "@/app/partners/lib/portal-v2";
import {
  PartnerNotice,
  PartnerPanel,
  partnerFieldClass,
  partnerPrimaryButtonClass,
  partnerSecondaryButtonClass,
} from "./PartnerPortalUi";

export type PartnerTeamMember = {
  id: string;
  user: { name: string; email: string; active: boolean };
  role: { key: string; name: string; description: string | null };
  status: "invited" | "active" | "suspended" | "removed";
  persona: string;
  accessLevel: "account" | "scoped";
  currentUser: boolean;
  defaultAccount: boolean;
  dates: {
    invitedAt: string;
    acceptedAt: string | null;
    suspendedAt: string | null;
    updatedAt: string;
  };
  allowedActions: Array<"role_update" | "suspend" | "reactivate">;
  etag: string;
};

export type PartnerTeamRole = {
  key: string;
  name: string;
  description: string;
  system: boolean;
};

type TeamPayload = {
  ok: true;
  members: PartnerTeamMember[];
  roles: PartnerTeamRole[];
  invitation: { available: boolean; reason: string | null };
  page: { limit: number; nextCursor: string | null; hasMore: boolean };
};

function titleCase(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function dateLabel(value: string | null): string {
  if (!value) return "Not available";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Not available";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(date);
}

function statusClass(status: PartnerTeamMember["status"]): string {
  if (status === "active") {
    return "bg-emerald-50 text-emerald-800 ring-emerald-200";
  }
  if (status === "suspended" || status === "removed") {
    return "bg-rose-50 text-rose-800 ring-rose-200";
  }
  return "bg-amber-50 text-amber-900 ring-amber-200";
}

function MemberCard({
  member,
  roles,
  onUpdated,
}: {
  member: PartnerTeamMember;
  roles: PartnerTeamRole[];
  onUpdated: (member: PartnerTeamMember) => void;
}) {
  const [selectedRole, setSelectedRole] = React.useState(member.role.key);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [confirmingSuspend, setConfirmingSuspend] = React.useState(false);
  const [message, setMessage] = React.useState<{
    tone: "success" | "error" | "warning";
    text: string;
  } | null>(null);
  const canChangeRole = member.allowedActions.includes("role_update");
  const canSuspend = member.allowedActions.includes("suspend");
  const canReactivate = member.allowedActions.includes("reactivate");
  const selectedRoleDetails = roles.find((role) => role.key === selectedRole);

  React.useEffect(() => setSelectedRole(member.role.key), [member.role.key]);

  async function mutate(
    body:
      | { action: "role_update"; roleKey: string }
      | { action: "suspend" }
      | { action: "reactivate" },
  ): Promise<void> {
    setBusy(body.action);
    setConfirmingSuspend(false);
    setMessage(null);
    const result = await partnerPortalFetch<{
      ok: true;
      member: PartnerTeamMember;
    }>(`members/${encodeURIComponent(member.id)}`, {
      method: "PATCH",
      headers: {
        "If-Match": member.etag,
        "Idempotency-Key": createPortalOperationKey(`member-${body.action}`),
      },
      body: JSON.stringify(body),
    }).catch(() => null);
    setBusy(null);
    if (!result?.ok) {
      if (result?.error.error === "revision_mismatch") {
        setMessage({
          tone: "warning",
          text: "This teammate changed in another session. Refresh the team list before trying again.",
        });
        return;
      }
      if (result?.error.error === "conflict") {
        setMessage({
          tone: "warning",
          text: "That change would leave the account without an administrator, targets your own active access, or is no longer valid.",
        });
        return;
      }
      setMessage({
        tone: "error",
        text:
          result?.error.message ??
          "We couldn’t change this member. Their access is unchanged.",
      });
      return;
    }
    onUpdated(result.data.member);
    if (member.currentUser && body.action === "role_update") {
      // The shell and every other member action are capability-derived. A
      // self-role change must refresh all of that state before another action.
      window.location.reload();
      return;
    }
    setMessage({
      tone: "success",
      text:
        body.action === "role_update"
          ? "Role updated."
          : body.action === "suspend"
            ? "Portal access suspended for this account."
            : "Portal access restored for this account.",
    });
  }

  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary-50 text-primary-700 ring-1 ring-primary-100">
            <UserRoundCog className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h2 className="truncate font-semibold text-slate-950">
              {member.user.name}
              {member.currentUser ? (
                <span className="ml-2 text-xs font-medium text-slate-500">
                  You
                </span>
              ) : null}
            </h2>
            <p className="mt-0.5 break-all text-sm text-slate-600">
              {member.user.email}
            </p>
          </div>
        </div>
        <span
          className={cn(
            "inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset",
            statusClass(member.status),
          )}
        >
          {titleCase(member.status)}
        </span>
      </div>

      {message ? (
        <PartnerNotice tone={message.tone} className="mt-4">
          {message.text}
        </PartnerNotice>
      ) : null}

      <dl className="mt-4 grid gap-3 border-t border-slate-200 pt-4 text-sm sm:grid-cols-3">
        <div>
          <dt className="font-medium text-slate-500">Current role</dt>
          <dd className="mt-1 font-semibold text-slate-900">
            {member.role.name}
          </dd>
        </div>
        <div>
          <dt className="font-medium text-slate-500">Access scope</dt>
          <dd className="mt-1 font-semibold text-slate-900">
            {member.accessLevel === "account" ? "Full account" : "Limited"}
          </dd>
        </div>
        <div>
          <dt className="font-medium text-slate-500">Joined</dt>
          <dd className="mt-1 font-semibold text-slate-900">
            {dateLabel(member.dates.acceptedAt)}
          </dd>
        </div>
      </dl>

      <div className="mt-4 flex flex-wrap gap-2 text-xs">
        {member.defaultAccount ? (
          <span className="rounded-full bg-slate-100 px-2.5 py-1 font-semibold text-slate-700 ring-1 ring-inset ring-slate-200">
            Default account
          </span>
        ) : null}
      </div>

      {canChangeRole || canSuspend || canReactivate ? (
        <div className="mt-5 border-t border-slate-200 pt-4">
          {canChangeRole ? (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <label className="min-w-0 flex-1" htmlFor={`role-${member.id}`}>
                <span className="text-sm font-semibold text-slate-700">
                  Role
                </span>
                <select
                  id={`role-${member.id}`}
                  aria-describedby={`role-help-${member.id}`}
                  value={selectedRole}
                  onChange={(event) => setSelectedRole(event.target.value)}
                  disabled={Boolean(busy)}
                  className={partnerFieldClass}
                >
                  {!roles.some((role) => role.key === member.role.key) ? (
                    <option value={member.role.key}>{member.role.name}</option>
                  ) : null}
                  {roles.map((role) => (
                    <option value={role.key} key={role.key}>
                      {role.name}
                    </option>
                  ))}
                </select>
                <span
                  id={`role-help-${member.id}`}
                  className="mt-2 block text-xs leading-5 text-slate-600"
                >
                  {selectedRoleDetails?.description ??
                    member.role.description ??
                    "This account role uses permissions configured by Stonegate."}
                </span>
              </label>
              <button
                type="button"
                disabled={Boolean(busy) || selectedRole === member.role.key}
                onClick={() =>
                  void mutate({ action: "role_update", roleKey: selectedRole })
                }
                className={partnerPrimaryButtonClass}
              >
                {busy === "role_update" ? (
                  <LoaderCircle
                    className="h-4 w-4 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                ) : (
                  <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                )}
                {busy === "role_update" ? "Saving…" : "Save role"}
              </button>
            </div>
          ) : null}
          {canSuspend || canReactivate ? (
            <div
              className={cn("flex flex-wrap gap-2", canChangeRole && "mt-3")}
            >
              {canSuspend ? (
                confirmingSuspend ? (
                  <PartnerNotice tone="warning" className="w-full">
                    <div>
                      <strong>Suspend {member.user.name}?</strong> They will
                      immediately lose access to this account, but any other
                      company access will remain available.
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={Boolean(busy)}
                          onClick={() => void mutate({ action: "suspend" })}
                          className={partnerPrimaryButtonClass}
                        >
                          {busy === "suspend" ? (
                            <LoaderCircle
                              className="h-4 w-4 animate-spin motion-reduce:animate-none"
                              aria-hidden="true"
                            />
                          ) : (
                            <Ban className="h-4 w-4" aria-hidden="true" />
                          )}
                          {busy === "suspend"
                            ? "Suspending…"
                            : "Confirm suspension"}
                        </button>
                        <button
                          type="button"
                          disabled={Boolean(busy)}
                          onClick={() => setConfirmingSuspend(false)}
                          className={partnerSecondaryButtonClass}
                        >
                          Keep access
                        </button>
                      </div>
                    </div>
                  </PartnerNotice>
                ) : (
                  <button
                    type="button"
                    disabled={Boolean(busy)}
                    onClick={() => setConfirmingSuspend(true)}
                    className={partnerSecondaryButtonClass}
                  >
                    <Ban className="h-4 w-4" aria-hidden="true" />
                    Suspend access
                  </button>
                )
              ) : null}
              {canReactivate ? (
                <button
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => void mutate({ action: "reactivate" })}
                  className={partnerPrimaryButtonClass}
                >
                  {busy === "reactivate" ? (
                    <LoaderCircle
                      className="h-4 w-4 animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                  ) : (
                    <RefreshCw className="h-4 w-4" aria-hidden="true" />
                  )}
                  {busy === "reactivate" ? "Restoring…" : "Restore access"}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

export function PartnerTeamManager({ initial }: { initial: TeamPayload }) {
  const [members, setMembers] = React.useState(initial.members);
  const [nextCursor, setNextCursor] = React.useState(initial.page.nextCursor);
  const [query, setQuery] = React.useState("");
  const [status, setStatus] = React.useState("all");
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);

  const filtered = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    return members.filter(
      (member) =>
        (status === "all" || member.status === status) &&
        (!needle ||
          member.user.name.toLowerCase().includes(needle) ||
          member.user.email.toLowerCase().includes(needle) ||
          member.role.name.toLowerCase().includes(needle)),
    );
  }, [members, query, status]);

  async function loadMore(): Promise<void> {
    if (!nextCursor) return;
    setLoadingMore(true);
    setMessage(null);
    const result = await partnerPortalFetch<TeamPayload>(
      `members?status=all&limit=100&cursor=${encodeURIComponent(nextCursor)}`,
    ).catch(() => null);
    setLoadingMore(false);
    if (!result?.ok) {
      setMessage(
        result?.error.message ??
          "We couldn’t load more members. Try again in a moment.",
      );
      return;
    }
    setMembers((current) => {
      const byId = new Map(current.map((member) => [member.id, member]));
      for (const member of result.data.members) byId.set(member.id, member);
      return [...byId.values()];
    });
    setNextCursor(result.data.page.nextCursor);
  }

  function updateMember(updated: PartnerTeamMember): void {
    setMembers((current) =>
      current.map((member) => (member.id === updated.id ? updated : member)),
    );
  }

  return (
    <div className="space-y-5">
      <PartnerPanel>
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary-50 text-primary-700 ring-1 ring-primary-100">
            <UsersRound className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-slate-950">
              Keep the right teammates connected
            </h2>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              Find people by name, email, or role and keep their access current
              so the right team can request and manage service.
            </p>
          </div>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-[1fr_0.45fr]">
          <label>
            <span className="text-sm font-semibold text-slate-700">Search</span>
            <span className="relative block">
              <Search
                className="pointer-events-none absolute left-3.5 top-5 h-4 w-4 text-slate-400"
                aria-hidden="true"
              />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Name, email, or role"
                className={cn(partnerFieldClass, "pl-10")}
              />
            </span>
          </label>
          <label>
            <span className="text-sm font-semibold text-slate-700">Status</span>
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              className={partnerFieldClass}
            >
              <option value="all">All statuses</option>
              <option value="active">Active</option>
              <option value="suspended">Suspended</option>
              <option value="invited">Invited</option>
              <option value="removed">Removed</option>
            </select>
          </label>
        </div>
      </PartnerPanel>

      {!initial.invitation.available ? (
        <PartnerNotice tone="info">
          <strong>Need to add someone?</strong> {initial.invitation.reason}{" "}
          Contact an account administrator to add a new teammate; no invitation
          has been sent from this page.
        </PartnerNotice>
      ) : null}

      {message ? <PartnerNotice tone="error">{message}</PartnerNotice> : null}

      <p className="sr-only" role="status" aria-live="polite">
        {filtered.length} team {filtered.length === 1 ? "member" : "members"}
        shown.
      </p>
      <div className="grid gap-4 xl:grid-cols-2">
        {filtered.map((member) => (
          <MemberCard
            key={member.id}
            member={member}
            roles={initial.roles}
            onUpdated={updateMember}
          />
        ))}
      </div>

      {!filtered.length ? (
        <PartnerPanel>
          <div className="py-8 text-center">
            <UsersRound
              className="mx-auto h-8 w-8 text-slate-400"
              aria-hidden="true"
            />
            <h2 className="mt-3 font-semibold text-slate-950">
              No teammates match these filters
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Clear the search or choose another status to see more teammates.
            </p>
          </div>
        </PartnerPanel>
      ) : null}

      {nextCursor ? (
        <div className="flex justify-center">
          <button
            type="button"
            disabled={loadingMore}
            onClick={() => void loadMore()}
            className={partnerSecondaryButtonClass}
          >
            {loadingMore ? (
              <LoaderCircle
                className="h-4 w-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : (
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
            )}
            {loadingMore ? "Loading…" : "Load more teammates"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
