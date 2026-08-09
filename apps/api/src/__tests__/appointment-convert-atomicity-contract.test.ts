import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildGoogleCalendarEventId } from "@/lib/calendar";

const workspaceRoot = resolve(__dirname, "../../../..");
const read = (path: string): string =>
  readFileSync(resolve(workspaceRoot, path), "utf8");

const route = read("apps/api/app/api/appointments/[id]/convert/route.ts");
const outbox = read("apps/api/src/lib/outbox-processor.ts");
const calendar = read("apps/api/src/lib/calendar.ts");
const calendarFeed = read("apps/api/app/api/admin/calendar/feed/route.ts");
const mobileActions = read("apps/site/src/app/mobile/actions.ts");
const mobilePage = read("apps/site/src/app/mobile/page.tsx");
const teamMyDay = read("apps/site/src/app/team/components/MyDaySection.tsx");
const mobileFinalTotal = read(
  "apps/site/src/app/mobile/MobileCompletionFinalTotalFields.tsx",
);
const teamActions = read("apps/site/src/app/team/actions.ts");
const routeManifest = read("apps/api/src/lib/team-route-security-manifest.ts");
const actionManifest = read("apps/site/src/app/team/action-policy-manifest.ts");

function sliceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("appointment quote-to-job conversion atomicity contract", () => {
  it("authorizes a verified human before touching params, body, or data", () => {
    const boundary = route.indexOf(
      "const baseBoundary = await beginTeamMutation",
    );
    const params = route.indexOf("await context.params", boundary);
    const body = route.indexOf("await readBoundedJsonRequest(request", params);
    const database = route.indexOf("const database = getDb()", body);

    expect(boundary).toBeGreaterThan(0);
    expect(params).toBeGreaterThan(boundary);
    expect(body).toBeGreaterThan(params);
    expect(database).toBeGreaterThan(body);
    expect(route).toContain('principalTypes: ["human"]');
    expect(route).toContain(
      'requiredPermissions: ["appointments.update", "payments.collect"]',
    );
    expect(route).toContain('risk: "financial"');
    expect(route).not.toContain("isAdminRequest");
    expect(route).not.toContain("getAuditActorFromRequest");
    expect(route).not.toContain("actorRole");
    expect(route).not.toContain('=== "owner"');
  });

  it("rejects query state, oversized or malformed JSON, unknown fields, invalid UUIDs, and weak versions", () => {
    expect(route).toContain("CONVERT_REQUEST_MAXIMUM_BYTES = 32_768");
    expect(route).toContain("request.nextUrl.search.length > 0");
    expect(route).toContain("readBoundedJsonRequest(request");
    expect(route).toContain("deadlineMs: 8_000");
    expect(route).toContain("ConvertSchema.safeParse(body)");
    expect(route.match(/\.strict\(\)/gu)?.length).toBeGreaterThanOrEqual(3);
    expect(route).toContain("APPOINTMENT_ID_PATTERN.test(appointmentId)");
    expect(route).toContain("new Date(value).toISOString() !== value");
    expect(route).toContain("expectedStatus:");
    expect(route).toContain("expectedSoldByMemberId:");
    expect(route).toContain("expectedAssignedSalespersonMemberId:");
  });

  it("classifies every conversion as financial and derives stronger intent permissions", () => {
    const policy = sliceBetween(
      route,
      "function executionPolicy(input: ConvertInput)",
      "export async function POST",
    );
    expect(policy).toContain('"payments.collect",');
    expect(route).toContain(
      'requiredPermissions.push("appointments.override_conflicts")',
    );
    expect(route).toContain('requiredPermissions.push("commissions.manage")');
    expect(route).toContain('requiredPermissions.push("payments.manage")');
    expect(route).toContain("input.completion.completedAt !== undefined ||");
    expect(route).toContain("isFinalTotalCorrectionIntent(input)");
    expect(policy).toContain('risk: "financial"');
    expect(route).toContain(
      'mutation.policy.requiredPermissions.includes("payments.manage")',
    );

    const externalBoundary = route.indexOf(
      "const externalCalendarBoundary = await beginTeamMutation",
    );
    const database = route.indexOf(
      "const database = getDb()",
      externalBoundary,
    );
    expect(externalBoundary).toBeGreaterThan(0);
    expect(database).toBeGreaterThan(externalBoundary);
    expect(route).toContain('risk: "external"');
    expect(route).toContain(
      'auditAction: "appointment.calendar_sync_requested"',
    );
  });

  it("binds exact request/version replay before the locked business transaction", () => {
    const claim = route.indexOf("await claimTeamMutationIdempotency(");
    const transaction = route.indexOf(
      "await database.transaction(async (tx)",
      claim,
    );
    const scheduleLock = route.indexOf(
      "await acquireScheduleConflictLock(tx)",
      transaction,
    );
    const rowLock = route.indexOf('.for("update")', transaction);
    const stale = route.indexOf("currentVersion !== expectedVersion", rowLock);
    const cas = route.indexOf(
      "eq(appointments.updatedAt, existing.updatedAt)",
      stale,
    );

    expect(route).toContain(
      'route: "POST /api/appointments/:appointmentId/convert"',
    );
    expect(route).toContain("teamMutationIdempotencyReplayResponse(");
    expect(claim).toBeGreaterThan(0);
    expect(transaction).toBeGreaterThan(claim);
    expect(scheduleLock).toBeGreaterThan(transaction);
    expect(rowLock).toBeGreaterThan(scheduleLock);
    expect(stale).toBeGreaterThan(rowLock);
    expect(cas).toBeGreaterThan(stale);
    expect(route).toContain("storeTerminalFailure(");
  });

  it("co-commits conversion, optional completion, linked records, effects, audit, and receipt", () => {
    const transaction = route.indexOf("await database.transaction(async (tx)");
    const appointmentWrite = route.indexOf(
      ".update(appointments)",
      transaction,
    );
    const crewWrite = route.indexOf(
      ".delete(appointmentCrewMembers)",
      appointmentWrite,
    );
    const leadWrite = route.indexOf(".update(leads)", crewWrite);
    const pipelineLock = route.indexOf("pg_advisory_xact_lock", leadWrite);
    const pipelineWrite = route.indexOf(".insert(crmPipeline)", pipelineLock);
    const taskWrite = route.indexOf(".update(crmTasks)", pipelineWrite);
    const statusOutbox = route.indexOf(
      'type: "estimate.status_changed"',
      taskWrite,
    );
    const calendarOutbox = route.indexOf(
      'type: "appointment.calendar_sync_requested"',
      statusOutbox,
    );
    const audit = route.indexOf(
      "mutation.audit.insertSuccess(tx",
      calendarOutbox,
    );
    const success = route.indexOf("teamMutationSuccessResult(mutation", audit);
    const completion = route.indexOf(
      "await completeTeamMutationIdempotency(",
      success,
    );

    for (const index of [
      appointmentWrite,
      crewWrite,
      leadWrite,
      pipelineLock,
      pipelineWrite,
      taskWrite,
      statusOutbox,
      calendarOutbox,
      audit,
      success,
      completion,
    ]) {
      expect(index).toBeGreaterThan(transaction);
    }
    expect(crewWrite).toBeGreaterThan(appointmentWrite);
    expect(completion).toBeGreaterThan(success);
    expect(route).toContain('type: "job"');
    expect(route).toContain(
      'const targetStatus = parsed.data.completion ? "completed" : "confirmed"',
    );
    expect(route).toContain("completedAtomically: Boolean(completion)");
    expect(route).toContain("settleTeamMutationIdempotencyFailure(");
    expect(route).not.toContain('type: "review.request"');
  });

  it("fails closed around payment state and protects seller attribution", () => {
    expect(route).toContain("isPaymentLedgerSchemaAvailable(tx)");
    expect(route).toContain(
      "Payment safety checks are temporarily unavailable",
    );
    expect(route).toContain("expireStalePaymentAttemptsForAppointment(");
    expect(route).toContain("getBlockingSquareAttempt(");
    expect(route).toContain("getFinalTotalPaymentLock(");
    expect(route).toContain("validateFinalTotalChange(");
    expect(route).toContain("soldByChangeRequiresOverride({");
    expect(route).toContain('requiredPermissions.push("commissions.manage")');
    expect(route).toContain(
      "existing.soldByMemberId !== parsed.data.expectedSoldByMemberId",
    );
    expect(route).toContain("existing.assignedSalespersonMemberId !==");
    expect(route).not.toContain("isValidSoldByOverrideCode(");
    expect(route).not.toContain('process.env["SOLD_BY_OVERRIDE_CODE"]');
    const auditBlock = sliceBetween(
      route,
      "const audit = await mutation.audit.insertSuccess(tx",
      "const data = {",
    );
    expect(auditBlock).toContain("finalTotalChangeReasonProvided:");
    expect(auditBlock).not.toContain("finalTotalChangeReason:");
    expect(auditBlock).not.toContain("soldByOverrideCode");
  });

  it("rejects inactive attribution members and conflicting conversion-time reschedules", () => {
    const transaction = sliceBetween(
      route,
      "await database.transaction(async (tx)",
      "return teamMutationResultResponse(",
    );
    expect(transaction).toContain("activeAttributionMembers");
    expect(transaction).toContain("eq(teamMembers.active, true)");
    expect(transaction).toContain('.for("share")');
    expect(transaction).toContain("validateActiveAppointmentAttribution({");
    expect(transaction).toContain("crewMemberIds:");
    expect(transaction).toContain("marketingMemberId");
    expect(transaction).toContain("inspectScheduleConflicts(tx, {");
    expect(transaction).toContain("durationMinutes: existing.durationMinutes");
    expect(transaction).toContain("capacity: getAppointmentCapacity()");
    expect(transaction).toContain("excludeAppointmentId: appointmentId");
    expect(transaction).toContain("if (scheduleDecision.conflict)");
    expect(transaction).toContain(
      'conversionFailure("conflict", scheduleDecision.message',
    );
  });

  it("records conversion lifecycle evidence without an implicit customer send", () => {
    const statusEvent = sliceBetween(
      route,
      'type: "estimate.status_changed"',
      "const calendarSync",
    );
    expect(statusEvent).toContain("statusChanged: false");
    expect(statusEvent).toContain("lifecycleStatusChanged");
    expect(statusEvent).toContain("conversion: true");

    const genericStatusHandler = sliceBetween(
      outbox,
      'case "estimate.status_changed"',
      'case "review.request"',
    );
    expect(genericStatusHandler).toContain(
      'payload?.["statusChanged"] !== false',
    );
  });

  it("never performs an inline provider call and queues a reconcilable Calendar operation", () => {
    expect(route).not.toContain("createCalendarEventWithRetry(");
    expect(route).not.toContain("updateCalendarEventWithRetry(");
    expect(route).not.toContain("fetch(");
    expect(route).toContain(
      "calendarSyncRequested = isGoogleCalendarEnabled()",
    );
    expect(route).toContain('type: "appointment.calendar_sync_requested"');

    const calendarHandler = sliceBetween(
      outbox,
      "async function handleAppointmentCalendarSyncRequested",
      "async function handleOutboxEvent",
    );
    expect(outbox).toContain('case "appointment.calendar_sync_requested"');
    expect(outbox).toContain("handleAppointmentCalendarSyncRequested(event)");
    expect(calendarHandler).toContain("calendarStateBelongsToRequest");
    expect(calendarHandler).toContain(
      'getTeamOperationKillSwitchForRisk("external")',
    );
    expect(calendarHandler).toContain(
      "calendar_sync_external_changes_disabled",
    );
    expect(calendarHandler).toContain(".leftJoin(contacts");
    expect(calendarHandler).toContain(".leftJoin(properties");
    expect(calendarHandler).toContain(".leftJoin(leads");
    expect(calendarHandler).toContain(
      "rescheduleToken: appointments.rescheduleToken",
    );
    expect(calendarHandler).toContain(
      "const rescheduleToken = readStringValue(appointment.rescheduleToken)",
    );
    expect(calendarHandler).toContain(
      "...(rescheduleUrl ? { rescheduleUrl } : {})",
    );
    expect(calendarHandler).not.toContain("buildNotificationPayload(");
    expect(calendarHandler).not.toContain("reschedule_token_backfill");
    expect(calendarHandler).not.toContain("nanoid(");

    const existingEventBranch = sliceBetween(
      calendarHandler,
      "if (appointment.calendarEventId) {",
      "} else {",
    );
    expect(existingEventBranch).toContain("updateCalendarEventWithRetry(");
    expect(existingEventBranch).toContain(
      "calendar_sync_existing_update_unconfirmed",
    );
    expect(existingEventBranch).not.toContain("createCalendarEventWithRetry(");
    expect(calendarHandler).toContain("createCalendarEventWithRetry(");
    expect(calendarHandler).toContain(
      "appointment_changed_after_provider_success",
    );
    expect(calendarHandler).toContain("recordCalendarSyncOutcomeOnce({");
    expect(calendarHandler).toContain("providerEventId");
    expect(outbox).toContain(
      'event.type === "appointment.calendar_sync_requested"',
    );
  });

  it("uses a deterministic provider event ID so create retries converge", () => {
    const appointmentId = "00000000-0000-4000-8000-000000000099";
    expect(buildGoogleCalendarEventId(appointmentId)).toBe(
      "stonegate00000000000040008000000000000099",
    );
    expect(buildGoogleCalendarEventId("not-an-appointment")).toBeNull();
    expect(calendar).toContain("id: deterministicEventId");
    expect(calendar).toContain("status === 409");
    expect(calendar).toContain("updateCalendarEvent(");
  });

  it("makes mobile convert+complete one replay-safe request with a strict receipt", () => {
    const mobileConvert = sliceBetween(
      mobileActions,
      "export async function convertMobileQuoteToJobAction",
      "export async function addMobileAppointmentNoteAction",
    );
    expect(mobileConvert).toContain(
      'requireMobilePermission("payments.collect")',
    );
    expect(
      mobileConvert.indexOf('requireMobilePermission("payments.collect")'),
    ).toBeLessThan(mobileConvert.indexOf("const shouldComplete"));
    expect(mobileConvert).toContain(
      'requireMobilePermission("commissions.manage")',
    );
    expect(mobileConvert).toContain(
      'requireMobilePermission("payments.manage")',
    );
    expect(mobileConvert).toContain(
      'requireMobilePermission("appointments.override_conflicts")',
    );
    expect(mobileConvert).toContain("callAdminMutationWithSafeReplay(");
    expect(mobileConvert).toContain('"Idempotency-Key": idempotencyKey');
    expect(mobileConvert).toContain('"If-Match":');
    expect(mobileConvert).toContain("completion: completionPayload");
    expect(mobileConvert).toContain("readTeamMutationSuccess<");
    expect(mobileConvert).toContain(
      'envelope.receipt.entityType !== "appointment"',
    );
    expect(mobileConvert).not.toContain("/status`");
    expect(mobileConvert.match(/\/convert`/gu)).toHaveLength(1);
    expect(mobileConvert).toContain("expectedSoldByMemberId");
    expect(mobileConvert).toContain("expectedAssignedSalespersonMemberId");
    expect(mobileConvert).not.toContain("soldByOverrideCode");
    expect(mobileConvert).toContain("calendarSync=${encodeURIComponent");

    expect(mobilePage).toContain('name="expectedVersion"');
    expect(mobilePage).toContain('name="idempotencyKey"');
    expect(mobilePage).toContain('name="expectedStatus"');
    expect(mobilePage).toContain('name="expectedFinalTotalCents"');
    expect(mobilePage).toContain('name="expectedSoldByMemberId"');
    expect(mobilePage).toContain('name="expectedAssignedSalespersonMemberId"');
    expect(mobilePage).toContain("canCollectPayments ? (");
    expect(mobilePage).toContain("canManageCommissions");
    expect(mobilePage).toContain("activeSellerBaseline");
    expect(mobilePage).toContain("sellerCorrectionBlocked");
    expect(mobilePage).toContain("(Select active seller)");
    expect(mobilePage).toContain(
      "A commission manager must choose an active seller.",
    );
    expect(mobilePage).toContain("Google Calendar sync queued.");
    expect(mobilePage).not.toContain('name="soldByOverrideCode"');
    expect(calendarFeed).toContain(
      "soldByMemberId: appointments.soldByMemberId",
    );
    expect(calendarFeed).toContain(
      "assignedSalespersonMemberId: contacts.salespersonMemberId",
    );
    expect(mobilePage).toContain("canOverrideAppointmentConflicts");
    expect(mobileFinalTotal).toContain("canManagePayments");
    expect(mobileFinalTotal).not.toContain("const canEdit = isOwner");
  });

  it("requires stable version/key fields and a strict receipt at the team action", () => {
    const teamConvert = sliceBetween(
      teamActions,
      "export async function convertAppointmentToJobAction",
      "export async function updateAppointmentSoldByAction",
    );
    expect(teamConvert).toContain('formData.get("expectedVersion")');
    expect(teamConvert).toContain('formData.get("idempotencyKey")');
    expect(teamConvert).toContain(
      'hasTeamPermission(principal, "payments.collect")',
    );
    expect(teamConvert).toContain(
      'hasTeamPermission(principal, "commissions.manage")',
    );
    expect(teamConvert).toContain("expectedSoldByMemberId");
    expect(teamConvert).toContain("expectedAssignedSalespersonMemberId");
    expect(teamConvert).not.toContain("soldByOverrideCode");
    expect(teamConvert).toContain("Google Calendar sync queued.");
    expect(teamConvert).toContain("callAdminMutationWithSafeReplay(");
    expect(teamConvert).toContain('"Idempotency-Key": idempotencyKey');
    expect(teamConvert).toContain('"If-Match":');
    expect(teamConvert).toContain("readTeamMutationSuccess<");
    expect(teamConvert).toContain(
      'envelope.receipt.entityType !== "appointment"',
    );
    const teamConvertPanel = sliceBetween(
      teamMyDay,
      "function QuoteConversionPanel",
      "function AppointmentCard",
    );
    expect(teamConvertPanel).toContain(
      "action={convertAppointmentToJobAction}",
    );
    expect(teamMyDay).toContain("canConvertQuote");
    expect(teamMyDay).toContain("canCollectPayments &&");
    expect(teamMyDay).toContain("canOverrideAppointmentConflicts");
    expect(teamConvertPanel).toContain('name="expectedVersion"');
    expect(teamConvertPanel).toContain('name="idempotencyKey"');
    expect(teamConvertPanel).toContain('name="expectedStatus"');
    expect(teamConvertPanel).toContain('name="expectedSoldByMemberId"');
    expect(teamConvertPanel).toContain(
      'name="expectedAssignedSalespersonMemberId"',
    );
    expect(teamConvertPanel).toContain("canManageCommissions");
    expect(teamConvertPanel).toContain("activeBaselineSeller");
    expect(teamConvertPanel).toContain("sellerCorrectionBlocked");
    expect(teamConvertPanel).toContain("(Select seller)");
    expect(teamConvertPanel).toContain(
      "A commission manager must choose an active seller",
    );
    expect(teamConvertPanel).not.toContain("soldByOverrideCode");
  });

  it("classifies conversion at its maximum financial risk in both manifests", () => {
    expect(routeManifest).toContain(
      '"app/api/appointments/[id]/convert/route.ts#POST": "financial"',
    );
    const actionEntry = sliceBetween(
      actionManifest,
      "convertAppointmentToJobAction: humanAction(",
      "updateAppointmentSoldByAction: humanAction(",
    );
    for (const permission of [
      "appointments.update",
      "appointments.override_conflicts",
      "payments.collect",
      "payments.manage",
      "commissions.manage",
    ]) {
      expect(actionEntry).toContain(`"${permission}"`);
    }
    expect(actionEntry).toContain('"financial"');
  });
});
