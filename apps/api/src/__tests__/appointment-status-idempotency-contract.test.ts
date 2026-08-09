import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workspaceRoot = resolve(__dirname, "../../../..");
const source = readFileSync(
  resolve(workspaceRoot, "apps/api/app/api/appointments/[id]/status/route.ts"),
  "utf8",
);
const outboxSource = readFileSync(
  resolve(workspaceRoot, "apps/api/src/lib/outbox-processor.ts"),
  "utf8",
);
const mobileActionsSource = readFileSync(
  resolve(workspaceRoot, "apps/site/src/app/mobile/actions.ts"),
  "utf8",
);
const mobilePageSource = readFileSync(
  resolve(workspaceRoot, "apps/site/src/app/mobile/page.tsx"),
  "utf8",
);
const myDaySource = readFileSync(
  resolve(workspaceRoot, "apps/site/src/app/team/components/MyDaySection.tsx"),
  "utf8",
);

describe("appointment status idempotency source contract", () => {
  it("authorizes a verified human before params, body, and database access", () => {
    const boundary = source.indexOf("await beginTeamMutation(request, {");
    const params = source.indexOf("await context.params", boundary);
    const body = source.indexOf("await readBoundedJsonRequest(request", params);
    const database = source.indexOf("const database = getDb()", body);

    expect(boundary).toBeGreaterThan(0);
    expect(params).toBeGreaterThan(boundary);
    expect(body).toBeGreaterThan(params);
    expect(database).toBeGreaterThan(body);
    expect(source).toContain('principalTypes: ["human"]');
    expect(source).toContain('requiredPermissions: ["appointments.update"]');
    expect(source).toContain(
      'requiredPermissions: ["appointments.update", "payments.collect"]',
    );
    expect(source).toContain(
      'requiredPermissions: ["appointments.update", "payments.manage"]',
    );
    expect(source).toContain("PAYMENT_AND_COMPLETION_OVERRIDE_STATUS_POLICY");
    expect(database).toBeGreaterThan(body);
    expect(source.indexOf("const executionPolicy", body)).toBeGreaterThan(
      database,
    );
    expect(source).not.toContain("isAdminRequest");
    expect(source).not.toContain("getAuditActorFromRequest");
    expect(source).not.toContain("x-actor-role");
    expect(source).not.toContain('actorRole !== "owner"');
    expect(source).not.toContain("actorRole,");
    expect(source).toContain("isFinalTotalCorrectionIntent(parsed.data)");
    expect(source).toContain("input.quotedTotalCents !== undefined");
    expect(source).toContain("input.bookingDetails !== undefined");
    expect(source).toContain(
      'hasBookingDetails && input.status !== "completed"',
    );
    expect(source).toContain("mutation.policy.requiredPermissions.includes(");
    expect(source).toContain('"payments.manage"');
  });

  it("requires a strict bounded payload, UUID appointment, and exact If-Match", () => {
    expect(source).toContain("STATUS_REQUEST_MAXIMUM_BYTES = 32_768");
    expect(source).toContain("readBoundedJsonRequest(request");
    expect(source).toContain(".strict()");
    expect(source).toContain("APPOINTMENT_ID_PATTERN.test(appointmentId)");
    expect(source).toContain("requireAppointmentVersion(");
    expect(source).toContain("new Date(value).toISOString() !== value");
    expect(source).toContain("input.expectedVersion !== expectedVersion");
  });

  it("claims a payload-and-version-bound key before any business read", () => {
    const database = source.indexOf("const database = getDb()");
    const claim = source.indexOf(
      "await claimTeamMutationIdempotency(database, mutation",
      database,
    );
    const transaction = source.indexOf(
      "await database.transaction(async (tx)",
      claim,
    );
    const appointmentRead = source.indexOf(".from(appointments)", transaction);

    expect(source).toContain(
      'route: "POST /api/appointments/:appointmentId/status"',
    );
    expect(source).toContain('entityType: "appointment"');
    expect(source).toContain("entityId: appointmentId");
    expect(source).toContain("payload: claimPayload");
    expect(claim).toBeGreaterThan(database);
    expect(transaction).toBeGreaterThan(claim);
    expect(appointmentRead).toBeGreaterThan(transaction);
    expect(source).toContain("teamMutationIdempotencyReplayResponse(");
  });

  it("stores exact stale and success results with their business transaction", () => {
    const transaction = source.indexOf("await database.transaction(async (tx)");
    const rowLock = source.indexOf('.for("update")', transaction);
    const stale = source.indexOf('"appointment_changed"', rowLock);
    const staleCompletion = source.indexOf(
      "return storeTerminalFailure(",
      rowLock,
    );
    const appointmentWrite = source.indexOf(
      "const [updated] = await tx",
      stale,
    );
    const auditWrite = source.indexOf(
      "await mutation.audit.insertSuccess(tx",
      appointmentWrite,
    );
    const outboxWrite = source.indexOf(
      "await tx.insert(outboxEvents).values({",
      auditWrite,
    );
    const successReceipt = source.indexOf(
      "teamMutationSuccessResult(mutation",
      auditWrite,
    );
    const successCompletion = source.indexOf(
      "await completeTeamMutationIdempotency(",
      successReceipt,
    );

    expect(rowLock).toBeGreaterThan(transaction);
    expect(staleCompletion).toBeGreaterThan(rowLock);
    expect(stale).toBeGreaterThan(staleCompletion);
    expect(appointmentWrite).toBeGreaterThan(stale);
    expect(auditWrite).toBeGreaterThan(appointmentWrite);
    expect(outboxWrite).toBeGreaterThan(auditWrite);
    expect(successReceipt).toBeGreaterThan(outboxWrite);
    expect(successCompletion).toBeGreaterThan(successReceipt);
    expect(source).toContain("settleTeamMutationIdempotencyFailure(");
  });

  it("co-commits commissions and queues only provider effects", () => {
    expect(source).toContain('type: "estimate.status_changed"');
    expect(source).not.toContain("refreshCommissions:");
    expect(source).toContain(
      "recalculateAppointmentCommissionsAndRefreshDraftPayoutsInTransaction(",
    );
    expect(source).toContain(
      "lockCompletedAppointmentPayoutPeriodInTransaction(",
    );
    expect(source).toContain('type: "appointment.calendar_sync_requested"');
    expect(source).toContain("statusChanged,");
    expect(source).toContain(
      'if (statusChanged && updated.leadId && status === "confirmed")',
    );
    expect(source).not.toContain("deleteCalendarEvent(");
    expect(outboxSource).not.toContain("refreshCommissions");
    expect(outboxSource).not.toContain(
      "recalculateAppointmentCommissionsAndRefreshDraftPayouts(",
    );
  });

  it("does not replay customer or sales effects for a same-status correction", () => {
    const handler = outboxSource.indexOf('case "estimate.status_changed":');
    const transitionGate = outboxSource.indexOf(
      "if (!shouldApplyInternalStatusEffects)",
      handler,
    );
    const salesTasks = outboxSource.indexOf(
      "await completeSalesTasksForContact(",
      transitionGate,
    );
    const pipeline = outboxSource.indexOf(
      "await updatePipelineStageForContact(",
      transitionGate,
    );
    const notificationIntent = outboxSource.indexOf(
      'payload?.["customerNotificationRequested"] === true',
      pipeline,
    );
    const notification = outboxSource.indexOf(
      "await buildNotificationPayload(appointment.id",
      notificationIntent,
    );

    expect(outboxSource).toContain('payload?.["statusChanged"] !== false');
    expect(transitionGate).toBeGreaterThan(handler);
    expect(salesTasks).toBeGreaterThan(transitionGate);
    expect(pipeline).toBeGreaterThan(transitionGate);
    expect(notificationIntent).toBeGreaterThan(pipeline);
    expect(notification).toBeGreaterThan(notificationIntent);
  });

  it("fails closed when financial safety is unavailable and keeps free-form reasons out of audit", () => {
    expect(source).toContain("hasFinancialChanges && !paymentLedgerAvailable");
    expect(source).toContain(
      "Payment safety checks are temporarily unavailable",
    );
    const auditStart = source.indexOf("await mutation.audit.insertSuccess(tx");
    const successStart = source.indexOf("const data = {", auditStart);
    const auditBlock = source.slice(auditStart, successStart);
    expect(auditBlock).toContain("finalTotalChangeReasonProvided:");
    expect(auditBlock).not.toContain("finalTotalChangeReason:\n");
  });

  it("co-commits booking details rather than relying on a separate PATCH", () => {
    const siteStatus = readFileSync(
      resolve(
        workspaceRoot,
        "apps/site/src/app/api/team/appointments/status/route.ts",
      ),
      "utf8",
    );
    expect(source).toContain("parseAppointmentBookingDetails(");
    expect(source).toContain("validateQuotedTotalForBookingDetails(");
    expect(source).toContain("values.bookingDetails = bookingDetailsUpdate");
    expect(source).toContain("bookingDetailsUpdated:");
    expect(siteStatus).toContain(
      'payload["bookingDetails"] = bookingDetailsResult.bookingDetails',
    );
    expect(siteStatus).toContain(
      'payload["quotedTotalCents"] = bookingDetailsResult.quotedTotalCents',
    );
    expect(siteStatus).not.toContain('method: "PATCH"');
  });

  it("keeps the shared mobile calendar compatible with versioned mutation receipts", () => {
    const statusAction = mobileActionsSource.slice(
      mobileActionsSource.indexOf(
        "export async function updateMobileAppointmentStatusAction",
      ),
      mobileActionsSource.indexOf(
        "export async function convertMobileQuoteToJobAction",
      ),
    );
    const noteAction = mobileActionsSource.slice(
      mobileActionsSource.indexOf(
        "export async function addMobileAppointmentNoteAction",
      ),
      mobileActionsSource.indexOf(
        "export async function rescheduleMobileAppointmentAction",
      ),
    );

    for (const action of [statusAction, noteAction]) {
      expect(action).toContain('"Idempotency-Key": idempotencyKey');
      expect(action).toContain('"If-Match": `"${expectedVersion}"`');
      expect(action).toContain("await readTeamMutationSuccess<");
      expect(action).toContain("no success is being claimed");
    }
    expect(statusAction).toContain("status,");
    expect(statusAction).toContain("expectedVersion,");
    expect(statusAction).toContain("sendCustomerNotification,");
    expect(statusAction).toContain("sendReviewRequest,");
    expect(statusAction).toContain(
      'envelope.receipt.entityType !== "appointment"',
    );
    expect(noteAction).toContain(
      'envelope.receipt.entityType !== "appointment_note"',
    );
    expect(mobilePageSource).toContain("version?: string | null;");
    expect(
      mobilePageSource.match(/name="expectedVersion"/gu)?.length,
    ).toBeGreaterThanOrEqual(4);
    expect(mobilePageSource).toContain("mobile-appointment-status:");
    expect(mobilePageSource).toContain("mobile-appointment-note:");
  });

  it("does not offer team financial completion controls without payment authority", () => {
    expect(myDaySource).toMatch(
      /hasTeamPermission\(\s*principal,\s*"appointments\.update",?\s*\)/u,
    );
    expect(myDaySource).toMatch(
      /hasTeamPermission\(\s*principal,\s*"payments\.collect",?\s*\)/u,
    );
    expect(myDaySource).toContain(
      "canUpdateAppointments && (item.isQuoteOnly || canCollectPayments)",
    );
    expect(myDaySource).toContain("!isCompleted && canUpdateAppointments ? (");
    expect(myDaySource).toContain(") : canCollectPayments ? (");
  });
});
