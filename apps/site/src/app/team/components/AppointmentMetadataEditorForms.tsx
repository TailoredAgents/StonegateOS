"use client";

import React from "react";
import { SubmitButton } from "@/components/SubmitButton";
import {
  updateAppointmentBookingDetailsAction,
  updateAppointmentSoldByAction,
  type AppointmentMetadataActionResult,
} from "../actions";
import type { AppointmentBookingDetails } from "../lib/booking-details";
import { AppointmentBookingDetailsFields } from "./AppointmentBookingDetailsFields";
import { teamButtonClass } from "./team-ui";

type TeamMember = { id: string; name: string };

type RequestIdentity = {
  version: string;
  idempotencyKey: string;
};

function nextRequestKey(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

function InlineMutationFeedback({
  feedback,
}: {
  feedback: AppointmentMetadataActionResult | null;
}): React.ReactElement | null {
  if (!feedback) return null;
  return (
    <p
      role={feedback.ok ? "status" : "alert"}
      aria-live={feedback.ok ? "polite" : "assertive"}
      className={`sm:col-span-2 rounded-xl border px-3 py-2 text-sm ${
        feedback.ok
          ? "border-emerald-200 bg-emerald-50 text-emerald-800"
          : "border-rose-200 bg-rose-50 text-rose-800"
      }`}
    >
      {feedback.message}
    </p>
  );
}

export function AppointmentBookingDetailsEditorForm({
  appointmentId,
  version,
  idempotencyKey,
  teamMembers,
  bookingDetails,
  quotedTotalCents,
}: {
  appointmentId: string;
  version: string;
  idempotencyKey: string;
  teamMembers: TeamMember[];
  bookingDetails: AppointmentBookingDetails | null;
  quotedTotalCents: number | null;
}): React.ReactElement {
  const [feedback, setFeedback] =
    React.useState<AppointmentMetadataActionResult | null>(null);
  const [requestIdentity, setRequestIdentity] = React.useState<RequestIdentity>(
    { version, idempotencyKey },
  );

  React.useEffect(() => {
    setRequestIdentity({ version, idempotencyKey });
  }, [idempotencyKey, version]);

  async function submit(formData: FormData): Promise<void> {
    setFeedback(null);
    try {
      const result = await updateAppointmentBookingDetailsAction(formData);
      setFeedback(result);
      if (result.ok) {
        setRequestIdentity({
          version: result.version,
          idempotencyKey: nextRequestKey("appointment-booking-details"),
        });
      }
    } catch {
      setFeedback({
        ok: false,
        message:
          "The booking-details result could not be confirmed. Your entries are still here; refresh before retrying if the connection remains uncertain.",
      });
    }
  }

  return (
    <form
      action={submit}
      className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2"
    >
      <input type="hidden" name="appointmentId" value={appointmentId} />
      <input
        type="hidden"
        name="expectedVersion"
        value={requestIdentity.version}
      />
      <input
        type="hidden"
        name="idempotencyKey"
        value={requestIdentity.idempotencyKey}
      />
      <AppointmentBookingDetailsFields
        teamMembers={teamMembers}
        bookingDetails={bookingDetails}
        quotedTotalCents={quotedTotalCents}
        allowServiceTypeSelection
        labelClassName="flex flex-col gap-1"
        fieldClassName="rounded-xl border border-slate-200 px-3 py-2 text-sm"
      />
      <InlineMutationFeedback feedback={feedback} />
      <div className="sm:col-span-2 flex items-center justify-end">
        <SubmitButton
          className={teamButtonClass("primary", "sm")}
          pendingLabel="Saving..."
        >
          Save booking details
        </SubmitButton>
      </div>
    </form>
  );
}

export function AppointmentSellerEditorForm({
  appointmentId,
  version,
  idempotencyKey,
  teamMembers,
  soldByMemberId,
  assignedAssociateMemberId,
  status,
}: {
  appointmentId: string;
  version: string;
  idempotencyKey: string;
  teamMembers: TeamMember[];
  soldByMemberId: string | null;
  assignedAssociateMemberId: string | null;
  status: "requested" | "confirmed" | "completed" | "no_show" | "canceled";
}): React.ReactElement {
  const [feedback, setFeedback] =
    React.useState<AppointmentMetadataActionResult | null>(null);
  const [requestIdentity, setRequestIdentity] = React.useState<RequestIdentity>(
    { version, idempotencyKey },
  );

  React.useEffect(() => {
    setRequestIdentity({ version, idempotencyKey });
  }, [idempotencyKey, version]);

  async function submit(formData: FormData): Promise<void> {
    setFeedback(null);
    try {
      const result = await updateAppointmentSoldByAction(formData);
      setFeedback(result);
      if (result.ok) {
        setRequestIdentity({
          version: result.version,
          idempotencyKey: nextRequestKey("appointment-sold-by"),
        });
      }
    } catch {
      setFeedback({
        ok: false,
        message:
          "The seller-attribution result could not be confirmed. Your selection is still here; refresh before retrying if the connection remains uncertain.",
      });
    }
  }

  return (
    <form
      action={submit}
      className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2"
    >
      <input type="hidden" name="appointmentId" value={appointmentId} />
      <input type="hidden" name="expectedStatus" value={status} />
      <input
        type="hidden"
        name="expectedVersion"
        value={requestIdentity.version}
      />
      <input
        type="hidden"
        name="idempotencyKey"
        value={requestIdentity.idempotencyKey}
      />
      <label className="flex flex-col gap-1 sm:col-span-2">
        <span>Who sold the job?</span>
        <select
          name="soldByMemberId"
          defaultValue={soldByMemberId ?? assignedAssociateMemberId ?? ""}
          required
          className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
        >
          <option value="">(Select seller)</option>
          {teamMembers.map((member) => (
            <option key={member.id} value={member.id}>
              {member.name}
            </option>
          ))}
        </select>
      </label>
      <div className="sm:col-span-2 rounded-2xl border border-slate-200 bg-white px-3 py-2 text-[11px] text-slate-600">
        Seller changes require commission-management permission. Completed jobs
        refresh only their draft payout period; locked or paid periods remain
        immutable and must be corrected through a later adjustment.
      </div>
      <InlineMutationFeedback feedback={feedback} />
      <div className="sm:col-span-2 flex items-center justify-end">
        <SubmitButton
          className={teamButtonClass("primary", "sm")}
          pendingLabel="Saving..."
        >
          Save seller
        </SubmitButton>
      </div>
    </form>
  );
}
