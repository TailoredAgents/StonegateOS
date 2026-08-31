"use client";

import * as React from "react";
import { CheckCircle2, CircleHelp, LoaderCircle, UserCheck, XCircle } from "lucide-react";
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

export type PartnerAdminJoinRequest = {
  id: string;
  requester: { name: string; email: string };
  requestedRoleKey: string;
  message: string | null;
  status: "submitted" | "under_review" | "needs_information" | "approved" | "declined" | "withdrawn";
  version: number;
  requestedAt: string;
  updatedAt: string;
  allowedActions: Array<"approve" | "needs_information" | "decline">;
  etag: string;
};

function RequestCard({
  request,
  roles,
  onUpdated,
}: {
  request: PartnerAdminJoinRequest;
  roles: PartnerTeamRole[];
  onUpdated: (request: PartnerAdminJoinRequest) => void;
}) {
  const requestedRoleAvailable = roles.some((role) => role.key === request.requestedRoleKey);
  const [roleKey, setRoleKey] = React.useState(requestedRoleAvailable ? request.requestedRoleKey : roles[0]?.key ?? "");
  const [persona, setPersona] = React.useState("other");
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState<"approve" | "needs_information" | "decline" | null>(null);
  const [notice, setNotice] = React.useState<{ tone: "error" | "warning" | "success"; text: string } | null>(null);

  async function decide(action: "approve" | "needs_information" | "decline"): Promise<void> {
    setBusy(action);
    setNotice(null);
    const body = action === "approve"
      ? { action, roleKey, persona, note: note.trim() || null }
      : action === "needs_information"
        ? { action, note: note.trim() || "More information is required before access can be approved." }
        : { action, note: note.trim() || "Declined by account administrator." };
    const result = await partnerPortalFetch<{ ok: true; joinRequest: PartnerAdminJoinRequest }>(`join-requests/${encodeURIComponent(request.id)}`, {
      method: "POST",
      headers: {
        "If-Match": request.etag,
        "Idempotency-Key": createPortalOperationKey(`partner-join-${action}`),
      },
      body: JSON.stringify(body),
    }).catch(() => null);
    setBusy(null);
    if (!result?.ok) {
      setNotice({
        tone: result?.error.error === "revision_mismatch" || result?.error.error === "conflict" ? "warning" : "error",
        text: result?.error.error === "conflict"
          ? "This request cannot be approved in its current state. The domain, membership, or reviewer may have changed."
          : result?.error.message ?? "We couldn’t record this decision. Access is unchanged.",
      });
      return;
    }
    onUpdated(result.data.joinRequest);
    setNotice({
      tone: "success",
      text: action === "approve"
        ? "Join request approved and account access activated."
        : action === "needs_information"
          ? "The requester was notified that more information is needed. No account access was granted."
          : "Join request declined; no account access was granted.",
    });
  }

  return (
    <article className="rounded-xl border border-slate-200 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-slate-950">{request.requester.name}</h3>
          <p className="break-all text-sm text-slate-600">{request.requester.email}</p>
          <p className="mt-1 text-xs text-slate-500">Requested role: {request.requestedRoleKey.replaceAll("_", " ")}</p>
        </div>
        <span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-900 ring-1 ring-inset ring-amber-200">{request.status.replaceAll("_", " ")}</span>
      </div>
      {request.message ? <p className="mt-3 rounded-lg bg-slate-50 p-3 text-sm leading-6 text-slate-700">{request.message}</p> : null}
      {notice ? <PartnerNotice tone={notice.tone} className="mt-3">{notice.text}</PartnerNotice> : null}
      {request.allowedActions.length ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label>
            <span className="text-sm font-semibold text-slate-700">Approved role</span>
            <select value={roleKey} onChange={(event) => setRoleKey(event.target.value)} className={partnerFieldClass}>
              {roles.map((role) => <option key={role.key} value={role.key}>{role.name}</option>)}
            </select>
          </label>
          <label>
            <span className="text-sm font-semibold text-slate-700">Partner type</span>
            <select value={persona} onChange={(event) => setPersona(event.target.value)} className={partnerFieldClass}>
              <option value="contractor">Contractor</option>
              <option value="real_estate_agent">Real-estate agent</option>
              <option value="property_manager">Property manager</option>
              <option value="commercial_client">Commercial client</option>
              <option value="other">Other</option>
            </select>
          </label>
          <label className="sm:col-span-2">
            <span className="text-sm font-semibold text-slate-700">Internal decision note <span className="font-normal text-slate-500">(optional for approval; not emailed)</span></span>
            <textarea maxLength={500} rows={2} value={note} onChange={(event) => setNote(event.target.value)} className={partnerFieldClass} />
          </label>
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <button type="button" disabled={Boolean(busy) || !roleKey} onClick={() => void decide("approve")} className={partnerPrimaryButtonClass}>
              {busy === "approve" ? <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <CheckCircle2 className="h-4 w-4" aria-hidden="true" />}
              {busy === "approve" ? "Approving…" : "Approve request"}
            </button>
            {request.allowedActions.includes("needs_information") ? (
              <button type="button" disabled={Boolean(busy)} onClick={() => void decide("needs_information")} className={partnerSecondaryButtonClass}>
                {busy === "needs_information" ? <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <CircleHelp className="h-4 w-4" aria-hidden="true" />}
                {busy === "needs_information" ? "Notifying…" : "Need information"}
              </button>
            ) : null}
            <button type="button" disabled={Boolean(busy)} onClick={() => void decide("decline")} className={partnerSecondaryButtonClass}>
              {busy === "decline" ? <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <XCircle className="h-4 w-4" aria-hidden="true" />}
              {busy === "decline" ? "Declining…" : "Decline"}
            </button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

export function PartnerJoinRequestManager({
  initialRequests,
  roles,
}: {
  initialRequests: PartnerAdminJoinRequest[];
  roles: PartnerTeamRole[];
}) {
  const [requests, setRequests] = React.useState(initialRequests);
  const pending = requests.filter((request) => request.allowedActions.length > 0);
  if (!pending.length) return null;
  return (
    <PartnerPanel>
      <div className="flex items-start gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-800 ring-1 ring-amber-200">
          <UserCheck className="h-5 w-5" aria-hidden="true" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-slate-950">Company join requests</h2>
          <p className="mt-1 text-sm leading-6 text-slate-600">Approve only people whose verified work-email domain still matches this account. You cannot approve your own request.</p>
        </div>
      </div>
      <div className="mt-5 space-y-3">
        {pending.map((request) => (
          <RequestCard key={request.id} request={request} roles={roles} onUpdated={(updated) => setRequests((current) => current.map((row) => row.id === updated.id ? updated : row))} />
        ))}
      </div>
    </PartnerPanel>
  );
}
