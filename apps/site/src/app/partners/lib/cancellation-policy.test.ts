import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const bookingWizard = readFileSync(
  new URL("../components/PartnerBookingWizard.tsx", import.meta.url),
  "utf8",
);
const reschedulePage = readFileSync(
  new URL("../(portal)/bookings/[jobId]/reschedule/page.tsx", import.meta.url),
  "utf8",
);
const rescheduleFlow = readFileSync(
  new URL("../components/PartnerRescheduleFlow.tsx", import.meta.url),
  "utf8",
);
const staffAdministration = readFileSync(
  new URL(
    "../../team/components/PartnerAdministrationSection.tsx",
    import.meta.url,
  ),
  "utf8",
);
const staffAction = readFileSync(
  new URL("../../team/actions/partner-administration.ts", import.meta.url),
  "utf8",
);

void test("booking review discloses the effective cancellation and schedule-change consequence", () => {
  assert.match(bookingWizard, /id="partner-book-cancellation-terms"/u);
  assert.match(
    bookingWizard,
    /aria-describedby="partner-book-cancellation-terms"/u,
  );
  assert.match(bookingWizard, /staff review/u);
  assert.match(bookingWizard, /No cancellation fee is applied automatically/u);
  assert.match(bookingWizard, /current\s+account policy is rechecked/u);
});

void test("late reschedule disclosure is server-derived and preserves the current schedule", () => {
  assert.match(reschedulePage, /job\.status === "confirmed"/u);
  assert.match(
    reschedulePage,
    /job\.cancellation\.policySource === "unconfigured"/u,
  );
  assert.match(
    reschedulePage,
    /scheduleChangeRequiresReview=\{scheduleChangeRequiresReview\}/u,
  );
  assert.match(rescheduleFlow, /id="partner-reschedule-policy"/u);
  assert.match(rescheduleFlow, /scheduleChangeRequiresReview/u);
  assert.match(
    rescheduleFlow,
    /current arrival window will stay scheduled while Stonegate reviews/u,
  );
  assert.match(rescheduleFlow, /aria-describedby="partner-reschedule-policy"/u);
});

void test("staff cancellation-policy controls are bounded, revision-safe, and explicit", () => {
  assert.match(staffAdministration, /Configure Partner cancellation policy/u);
  assert.match(staffAdministration, /name="minimumNoticeMinutes"/u);
  assert.match(staffAdministration, /min=\{1_440\}/u);
  assert.match(staffAdministration, /max=\{525_600\}/u);
  assert.match(staffAdministration, /name="expectedVersion"/u);
  assert.match(staffAdministration, /name="idempotencyKey"/u);
  assert.match(staffAdministration, /name="reason"/u);
  assert.match(staffAdministration, /Type UPDATE CANCELLATION POLICY/u);
  assert.match(staffAction, /method: "PATCH"/u);
  assert.match(staffAction, /expectedVersion/u);
  assert.match(staffAction, /idempotencyKey/u);
  assert.match(staffAction, /lateCancellationDisposition === "staff_review"/u);
  assert.match(staffAction, /automaticFeeMinor === null/u);
});

void test("staff cancellation reviews require a durable typed immutable decision", () => {
  assert.match(staffAdministration, /id: "cancellation-requests"/u);
  assert.match(
    staffAdministration,
    /permission: "partners\.cancellation_requests\.read"/u,
  );
  assert.match(
    staffAdministration,
    /"partners\.cancellation_requests\.decide"/u,
  );
  assert.match(staffAdministration, /Approve cancellation/u);
  assert.match(staffAdministration, /Decline cancellation/u);
  assert.match(staffAdministration, /name="expectedVersion"/u);
  assert.match(staffAdministration, /name="idempotencyKey"/u);
  assert.match(staffAdministration, /Type \{decision\.confirmation\}/u);
  assert.match(staffAdministration, /winning decision is immutable/u);
  assert.match(staffAction, /partnerCancellationRequestDecisionAction/u);
  assert.match(staffAction, /APPROVE CANCELLATION/u);
  assert.match(staffAction, /DECLINE CANCELLATION/u);
  assert.match(staffAction, /partners\.cancellation_requests\.decide/u);
  assert.match(staffAction, /method: "POST"/u);
});
