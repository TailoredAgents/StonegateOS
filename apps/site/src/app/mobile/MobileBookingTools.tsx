import { randomUUID } from "node:crypto";
import { MessageSquare, Phone } from "lucide-react";
import {
  openMobileAppointmentThreadAction,
  rescheduleMobileAppointmentAction,
  startMobileContactCallAction,
  updateMobileAppointmentStatusAction,
} from "./actions";
import { mobileBookingHref } from "./lib/booking-presentation";

export function MobileBookingQuickActions({
  appointmentId,
  contactId,
  date,
  screen,
  canCall,
  canMessage,
}: {
  appointmentId: string;
  contactId?: string | null;
  date: string;
  screen: "myday" | "calendar";
  canCall: boolean;
  canMessage: boolean;
}) {
  const buttonClass =
    "inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-white/15 bg-slate-900 px-3 py-2 text-sm font-semibold text-slate-200";
  return (
    <>
      {canCall && contactId ? (
        <form action={startMobileContactCallAction} className="flex-1">
          <input type="hidden" name="contactId" value={contactId} />
          <input
            type="hidden"
            name="returnTo"
            value={mobileBookingHref(screen, date, appointmentId)}
          />
          <input
            type="hidden"
            name="idempotencyKey"
            value={`mobile-call:${randomUUID()}`}
          />
          <input
            type="hidden"
            name="explicitNewAttempt"
            value="START NEW CALL"
          />
          <button type="submit" className={buttonClass}>
            <Phone className="h-4 w-4" aria-hidden="true" />
            Call
          </button>
        </form>
      ) : null}
      {canMessage ? (
        <form action={openMobileAppointmentThreadAction} className="flex-1">
          <input type="hidden" name="appointmentId" value={appointmentId} />
          <input type="hidden" name="date" value={date} />
          <input type="hidden" name="screen" value={screen} />
          <button type="submit" className={buttonClass}>
            <MessageSquare className="h-4 w-4" aria-hidden="true" />
            Message
          </button>
        </form>
      ) : null}
    </>
  );
}

export function MobileBookingMoreActions({
  appointmentId,
  appointmentVersion,
  date,
  screen,
  canceled,
  startTime,
  canSendCustomerMessages,
}: {
  appointmentId: string;
  appointmentVersion: string;
  date: string;
  screen: "myday" | "calendar";
  canceled: boolean;
  startTime: string;
  canSendCustomerMessages: boolean;
}) {
  return (
    <details
      className="rounded-lg border border-white/10 bg-slate-950 px-3"
      data-mobile-more-actions
    >
      <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold text-slate-300">
        More job actions
      </summary>
      <div className="space-y-3 pb-3">
        <details className="rounded-lg border border-white/10 px-3">
          <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold text-cyan-100">
            Reschedule
          </summary>
          <form
            action={rescheduleMobileAppointmentAction}
            className="space-y-3 pb-3"
          >
            <input type="hidden" name="appointmentId" value={appointmentId} />
            <input type="hidden" name="currentDate" value={date} />
            <input type="hidden" name="screen" value={screen} />
            <label className="block text-sm text-slate-300">
              Date
              <input
                type="date"
                name="preferredDate"
                defaultValue={date}
                required
                className="mt-1 min-h-11 w-full rounded-lg border border-white/15 bg-slate-900 px-3 text-base text-white"
              />
            </label>
            <label className="block text-sm text-slate-300">
              Time (Eastern)
              <input
                type="time"
                name="startTime"
                defaultValue={startTime}
                step={60}
                required
                className="mt-1 min-h-11 w-full rounded-lg border border-white/15 bg-slate-900 px-3 text-base text-white"
              />
            </label>
            <button
              type="submit"
              className="min-h-11 w-full rounded-lg bg-cyan-300 px-3 py-2 font-semibold text-slate-950"
            >
              Save new time
            </button>
          </form>
        </details>
        {!canceled ? (
          <details className="rounded-lg border border-white/10 px-3">
            <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold text-rose-200">
              Cancel appointment
            </summary>
            <form
              action={updateMobileAppointmentStatusAction}
              className="space-y-3 pb-3"
            >
              <input type="hidden" name="appointmentId" value={appointmentId} />
              <input
                type="hidden"
                name="expectedVersion"
                value={appointmentVersion}
              />
              <input
                type="hidden"
                name="idempotencyKey"
                value={`mobile-appointment-status:${randomUUID()}`}
              />
              <input type="hidden" name="date" value={date} />
              <input type="hidden" name="screen" value={screen} />
              {canSendCustomerMessages ? (
                <label className="flex min-h-11 items-center gap-3 text-sm text-slate-300">
                  <input
                    name="sendCustomerNotification"
                    type="checkbox"
                    className="h-5 w-5"
                  />
                  Also request a customer cancellation notice
                </label>
              ) : (
                <p className="text-sm text-slate-400">
                  This action will not notify the customer.
                </p>
              )}
              <button
                type="submit"
                name="status"
                value="canceled"
                className="min-h-11 w-full rounded-lg border border-rose-300/30 bg-rose-300/10 px-3 py-2 font-semibold text-rose-100"
              >
                Cancel appointment
              </button>
            </form>
          </details>
        ) : null}
      </div>
    </details>
  );
}
