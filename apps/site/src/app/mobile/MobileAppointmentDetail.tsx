"use client";

import * as React from "react";
import {
  MobilePaymentPanel,
  type AppointmentPaymentSummary,
} from "./MobilePaymentPanel";
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
  appointmentVersion,
  employeeId,
  notes,
  quotedScopeText,
  mediaSummary,
  paymentSummary,
  paymentLedgerAvailable,
  canCaptureMedia,
  canManageMedia,
  canReadPayments,
  canCollectPayments,
  canManagePayments,
}: {
  appointmentId: string;
  appointmentVersion: string | null;
  employeeId: string;
  notes: MobileAppointmentNote[] | undefined;
  quotedScopeText: string | null;
  mediaSummary: AppointmentMediaSummary;
  paymentSummary: AppointmentPaymentSummary | null;
  paymentLedgerAvailable: boolean;
  canCaptureMedia: boolean;
  canManageMedia: boolean;
  canReadPayments: boolean;
  canCollectPayments: boolean;
  canManagePayments: boolean;
}) {
  const [needsScope, setNeedsScope] = React.useState(mediaSummary.needsScope);

  React.useEffect(() => {
    setNeedsScope(mediaSummary.needsScope);
  }, [appointmentId, mediaSummary.needsScope]);

  return (
    <>
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
          initialVersion={appointmentVersion}
          initialSummary={paymentSummary}
          initialLedgerAvailable={paymentLedgerAvailable}
          canCollect={canCollectPayments}
          canManagePayments={canManagePayments}
          needsScope={needsScope}
        />
      ) : null}
      {notes?.length ? (
        <details className="rounded-md border border-white/10 bg-slate-950 px-3">
          <summary className="flex min-h-11 cursor-pointer list-none items-center text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">
            Notes ({notes.length})
          </summary>
          <div className="space-y-2 pb-3">
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
      ) : null}
    </>
  );
}
