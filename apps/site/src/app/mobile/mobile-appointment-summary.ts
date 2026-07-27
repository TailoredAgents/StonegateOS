import type { AppointmentPaymentSummary } from "./MobilePaymentPanel";
import type { AppointmentMediaSummary } from "./MobileQuotedWorkPanel";

export const MOBILE_APPOINTMENT_SUMMARY_EVENT =
  "stonegate:mobile-appointment-summary";

export type MobileAppointmentSummaryEventDetail = {
  appointmentId: string;
  quotedScopeText?: string | null;
  mediaSummary?: AppointmentMediaSummary;
  paymentSummary?: AppointmentPaymentSummary;
};

export function publishMobileAppointmentSummary(
  detail: MobileAppointmentSummaryEventDetail,
): void {
  window.dispatchEvent(
    new CustomEvent<MobileAppointmentSummaryEventDetail>(
      MOBILE_APPOINTMENT_SUMMARY_EVENT,
      { detail },
    ),
  );
}
