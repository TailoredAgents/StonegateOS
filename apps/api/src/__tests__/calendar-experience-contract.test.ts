import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workspaceRoot = resolve(__dirname, "../../../..");
const read = (path: string): string =>
  readFileSync(resolve(workspaceRoot, path), "utf8");

describe("Team Calendar experience contracts", () => {
  it("keeps recoverable mutation input client-side and refuses unconfirmed success", () => {
    const actions = read(
      "apps/site/src/app/team/components/CalendarAppointmentActions.tsx",
    );

    expect(actions).toContain("readTeamMutationError");
    expect(actions).toContain("payload.ok === true");
    expect(actions).toContain("isTeamMutationSuccessEnvelope(payload)");
    expect(actions).toContain('"complete"');
    expect(actions).toContain('"no_show"');
    expect(actions).toContain('"canceled"');
    expect(actions).toContain("Keep your input");
    expect(actions).toContain("value={noteDraft}");
    expect(actions).toContain('formData.set("expectedVersion"');
    expect(actions).toContain("mutationAttemptsRef");
    expect(actions).toContain("previousAttempt?.fingerprint === fingerprint");
    expect(actions).toContain('name="expectedFinalTotalCents"');
    expect(actions).toContain('name="crewConfirmed"');
    expect(actions).toContain('value="no_show"');
    expect(actions).toContain("Override and reschedule");
    expect(actions).toContain('name="conflictAcknowledgement"');
    expect(actions).toContain("canOverrideScheduleConflicts");
  });

  it("preserves all operational filters in canonical Calendar URLs", () => {
    const viewer = read("apps/site/src/app/team/components/CalendarViewer.tsx");
    const section = read(
      "apps/site/src/app/team/components/CalendarSection.tsx",
    );

    for (const parameter of [
      "calStatus",
      "calCrew",
      "calSource",
      "calConflict",
    ]) {
      expect(viewer).toContain(parameter);
      expect(section).toContain(parameter);
    }
    expect(viewer).toContain("No calendar items match these filters");
    expect(viewer).toContain("Google Calendar is unavailable");
    expect(viewer).toContain("Reset filters");
    expect(read("apps/api/app/api/admin/team/directory/route.ts")).toContain(
      'requirePermission(request, "appointments.read")',
    );
  });

  it("explains conflicts and external read-only behavior in text", () => {
    const detail = read(
      "apps/site/src/app/team/components/CalendarEventDetail.tsx",
    );
    const viewer = read("apps/site/src/app/team/components/CalendarViewer.tsx");

    expect(detail).toContain("Scheduling conflict");
    expect(detail).toContain("Read-only Google event");
    expect(detail).toContain("Review crew capacity");
    expect(detail).toContain('aria-label="Close appointment details"');
    expect(viewer.match(/<CalendarEventDetail/gu)).toHaveLength(1);
    expect(viewer).toContain(
      'aria-label="Selected calendar day and event details"',
    );
    expect(viewer).not.toContain("mobileDetailRef");
    expect(viewer).not.toContain("sticky top-4 z-10");
  });

  it("keeps completion controls in one non-overlapping detail-panel column", () => {
    const actions = read(
      "apps/site/src/app/team/components/CalendarAppointmentActions.tsx",
    );
    const crewSelector = read(
      "apps/site/src/app/team/components/CrewPayoutSelector.tsx",
    );

    expect(crewSelector).toContain('<div className="min-w-0 space-y-3">');
    expect(crewSelector).not.toContain("space-y-3 sm:col-span-2");
    expect(actions).toContain('className="grid min-w-0 grid-cols-1 gap-3"');
    expect(actions).toContain(
      "showSplitPercentages={false}\n                stacked",
    );
    expect(actions).not.toContain('className="grid gap-2 sm:grid-cols-2"');
    expect(actions).toContain("htmlFor={crewConfirmationFieldId}");
    expect(actions).toContain("htmlFor={reviewRequestFieldId}");
    expect(actions).toContain("shrink-0 scroll-mt-24");
  });

  it("carries expected versions through every Calendar mutation boundary", () => {
    const siteStatus = read(
      "apps/site/src/app/api/team/appointments/status/route.ts",
    );
    const siteNotes = read(
      "apps/site/src/app/api/team/appointments/notes/route.ts",
    );
    const siteReschedule = read(
      "apps/site/src/app/api/team/appointments/reschedule/route.ts",
    );
    const apiStatus = read(
      "apps/api/app/api/appointments/[id]/status/route.ts",
    );
    const apiNotes = read("apps/api/app/api/appointments/[id]/notes/route.ts");
    const apiReschedule = read(
      "apps/api/app/api/web/appointments/[id]/reschedule/route.ts",
    );

    for (const source of [siteStatus, siteNotes, siteReschedule]) {
      expect(source).toContain("If-Match");
      expect(source).toContain("expectedVersion");
    }
    for (const source of [apiStatus, apiReschedule]) {
      expect(source).toContain("appointment_changed");
      expect(source).toContain("currentVersion");
    }
    expect(apiNotes).toContain("mutation.expectedVersion");
    expect(apiNotes).toContain("conflictResult(");
    expect(apiNotes).toContain("currentVersion");
  });

  it("requires a stable retry key and strict receipt for appointment notes", () => {
    const siteNotes = read(
      "apps/site/src/app/api/team/appointments/notes/route.ts",
    );
    const apiNotes = read("apps/api/app/api/appointments/[id]/notes/route.ts");
    const myDay = read("apps/site/src/app/team/components/MyDaySection.tsx");

    expect(siteNotes).toContain("IDEMPOTENCY_KEY_PATTERN");
    expect(siteNotes).toContain('"Idempotency-Key": idempotencyKey');
    expect(siteNotes).toContain("isTeamMutationSuccessEnvelope(result)");
    expect(myDay).toContain('name="expectedVersion"');
    expect(myDay).toContain('name="idempotencyKey"');
    expect(apiNotes).toContain("beginTeamMutation(request");
    expect(apiNotes).toContain("requiresIdempotency: true");
    expect(apiNotes).toContain("claimTeamMutationIdempotency(");
    expect(apiNotes).toContain("teamMutationIdempotencyReplayResponse(");
    expect(apiNotes).toContain('.for("update")');
  });

  it("requires current versions, retry keys, and commit receipts for status changes", () => {
    const siteStatus = read(
      "apps/site/src/app/api/team/appointments/status/route.ts",
    );
    const apiStatus = read(
      "apps/api/app/api/appointments/[id]/status/route.ts",
    );
    const myDay = read("apps/site/src/app/team/components/MyDaySection.tsx");
    const outbox = read("apps/api/src/lib/outbox-processor.ts");

    expect(siteStatus).toContain("IDEMPOTENCY_KEY_PATTERN");
    expect(siteStatus).toContain('"If-Match":');
    expect(siteStatus).toContain('"Idempotency-Key": idempotencyKey');
    expect(siteStatus).toContain("isExactAppointmentStatusReceipt(result");
    expect(apiStatus).toContain("beginTeamMutation(request");
    expect(apiStatus).toContain("requireAppointmentVersion(");
    expect(apiStatus).toContain("mutation.expectedVersion");
    expect(apiStatus).toContain("claimTeamMutationIdempotency(");
    expect(apiStatus).toContain("teamMutationIdempotencyReplayResponse(");
    expect(apiStatus).toContain("mutation.audit.insertSuccess(tx");
    expect(apiStatus).toContain("completeTeamMutationIdempotency(");
    expect(apiStatus).toContain("auditEventId: audit.auditEventId");
    expect(apiStatus).toContain("committedAt: audit.committedAt");
    expect(apiStatus).not.toContain("refreshCommissions:");
    expect(apiStatus).toContain(
      "recalculateAppointmentCommissionsAndRefreshDraftPayoutsInTransaction(",
    );
    expect(apiStatus).toContain('type: "appointment.calendar_sync_requested"');
    expect(apiStatus).not.toContain("await deleteCalendarEvent(");
    expect(outbox).not.toContain("refreshCommissions");
    expect(outbox).toContain("await deleteCalendarEvent(");
    expect(outbox).toContain(
      "verifyAppointmentCancellationCalendarAuthorization({",
    );
    expect(outbox).toContain("appointment_notification.superseded");
    expect(outbox).toContain("recordCalendarSyncOutcomeOnce");
    expect(outbox).toContain("calendar_state_changed_after_provider_delete");
    expect(myDay).toContain("appointment-status:${randomUUID()}");
    expect(myDay).toContain('name="expectedFinalTotalCents"');
  });
});
