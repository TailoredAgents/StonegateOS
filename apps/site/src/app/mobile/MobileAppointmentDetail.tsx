"use client";

import * as React from "react";
import { MobilePaymentPanel, type AppointmentPaymentSummary } from "./MobilePaymentPanel";
import {
  MobileQuotedWorkPanel,
  type AppointmentMediaSummary,
} from "./MobileQuotedWorkPanel";

export type MobileAppointmentNote = {
  id: string;
  body: string;
  createdAt: string;
};

export function MobileAppointmentDetail({
  appointmentId,
  employeeId,
  address,
  mapsHref,
  notes,
  pricingLabel,
  quotedScopeText,
  mediaSummary,
  paymentSummary,
  canCaptureMedia,
  canManageMedia,
  canReadPayments,
  canCollectPayments,
  isOwner,
}: {
  appointmentId: string;
  employeeId: string;
  address: string | null | undefined;
  mapsHref: string | null;
  notes: MobileAppointmentNote[] | undefined;
  pricingLabel: string | null;
  quotedScopeText: string | null;
  mediaSummary: AppointmentMediaSummary;
  paymentSummary: AppointmentPaymentSummary | null;
  canCaptureMedia: boolean;
  canManageMedia: boolean;
  canReadPayments: boolean;
  canCollectPayments: boolean;
  isOwner: boolean;
}) {
  const [needsScope, setNeedsScope] = React.useState(mediaSummary.needsScope);

  React.useEffect(() => {
    setNeedsScope(mediaSummary.needsScope);
  }, [appointmentId, mediaSummary.needsScope]);

  return (
    <>
      {mapsHref && address ? (
        <a
          href={mapsHref}
          target="_blank"
          rel="noreferrer"
          className="block rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-sm font-semibold leading-5 text-cyan-100 underline-offset-4 hover:underline"
        >
          {address}
        </a>
      ) : address ? (
        <p className="rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-sm leading-5 text-slate-300">
          {address}
        </p>
      ) : null}

      {notes?.length ? (
        <details
          className="rounded-md border border-white/10 bg-slate-950 p-3"
          open={notes.length <= 2}
        >
          <summary className="cursor-pointer list-none text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">
            Notes ({notes.length})
          </summary>
          <div className="mt-2 space-y-2">
            {notes.slice(0, 5).map((note) => (
              <div
                key={note.id}
                className="rounded-md border border-white/10 bg-slate-900 px-3 py-2"
              >
                <p className="whitespace-pre-wrap text-sm leading-5 text-slate-200">
                  {note.body}
                </p>
                <p className="mt-1 text-[11px] text-slate-500">
                  {new Date(note.createdAt).toLocaleString("en-US", {
                    timeZone: "America/New_York",
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </p>
              </div>
            ))}
          </div>
        </details>
      ) : (
        <div className="rounded-md border border-dashed border-white/10 bg-slate-950 px-3 py-2 text-sm text-slate-500">
          No notes.
        </div>
      )}

      {pricingLabel ? (
        <div className="rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-sm font-semibold text-cyan-100">
          {pricingLabel}
        </div>
      ) : null}

      <MobileQuotedWorkPanel
        appointmentId={appointmentId}
        employeeId={employeeId}
        initialScope={quotedScopeText}
        initialSummary={{ ...mediaSummary, needsScope }}
        canCapture={canCaptureMedia}
        canManage={canManageMedia}
        onScopeRequirementChange={setNeedsScope}
      />
      {canReadPayments && paymentSummary ? (
        <MobilePaymentPanel
          appointmentId={appointmentId}
          initialSummary={paymentSummary}
          canCollect={canCollectPayments}
          isOwner={isOwner}
          needsScope={needsScope}
        />
      ) : null}
    </>
  );
}
