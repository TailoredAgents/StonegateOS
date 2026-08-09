import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workspaceRoot = resolve(__dirname, "../../../..");
const read = (path: string): string =>
  readFileSync(resolve(workspaceRoot, path), "utf8");

const statusRoute = read("apps/api/app/api/appointments/[id]/status/route.ts");
const outbox = read("apps/api/src/lib/outbox-processor.ts");
const notifications = read("apps/api/src/lib/notifications.ts");
const systemOutbound = read("apps/api/src/lib/system-outbound.ts");
const siteProxy = read(
  "apps/site/src/app/api/team/appointments/status/route.ts",
);
const teamCalendar = read(
  "apps/site/src/app/team/components/CalendarAppointmentActions.tsx",
);
const myDay = read("apps/site/src/app/team/components/MyDaySection.tsx");
const mobileActions = read("apps/site/src/app/mobile/actions.ts");
const mobilePage = read("apps/site/src/app/mobile/page.tsx");
const agentAvailability = read(
  "apps/site/src/app/team/lib/agent-action-availability.ts",
);

function sliceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("appointment status external-effect contracts", () => {
  it("defaults both customer effects off and accepts only supported explicit intent", () => {
    expect(statusRoute).toContain(
      "sendCustomerNotification: z.boolean().optional().default(false)",
    );
    expect(statusRoute).toContain(
      "sendReviewRequest: z.boolean().optional().default(false)",
    );
    expect(statusRoute).toMatch(
      /input\.sendCustomerNotification\s*&&\s*input\.status !== "canceled"/u,
    );
    expect(statusRoute).toContain(
      'input.sendReviewRequest && input.status !== "completed"',
    );
    expect(statusRoute).toContain('requiredPermissions.push("messages.send")');
    expect(statusRoute).toContain(
      "customerNotificationRequested: parsed.data.sendCustomerNotification",
    );
    expect(statusRoute).toContain(
      "reviewRequestRequested: parsed.data.sendReviewRequest",
    );
    expect(statusRoute).toContain('? ("requested" as const)');
    expect(statusRoute).not.toContain('customerNotification: "sent"');
    expect(statusRoute).not.toContain('reviewRequest: "delivered"');
  });

  it("keeps internal lifecycle reconciliation independent from messaging intent", () => {
    const handler = sliceBetween(
      outbox,
      'case "estimate.status_changed":',
      'case "review.request":',
    );
    const transitionGate = handler.indexOf(
      "if (!shouldApplyInternalStatusEffects)",
    );
    const taskReconciliation = handler.indexOf(
      "await completeSalesTasksForContact(",
      transitionGate,
    );
    const pipelineReconciliation = handler.indexOf(
      "await updatePipelineStageForContact(",
      transitionGate,
    );
    const explicitMessageIntent = handler.indexOf(
      'payload?.["customerNotificationRequested"] === true',
      pipelineReconciliation,
    );
    const cancellationSend = handler.indexOf(
      "await sendEstimateCancellation(",
      explicitMessageIntent,
    );

    expect(handler).toContain('payload?.["statusChanged"] !== false');
    expect(handler).toContain('payload?.["lifecycleStatusChanged"] === true');
    expect(taskReconciliation).toBeGreaterThan(transitionGate);
    expect(pipelineReconciliation).toBeGreaterThan(taskReconciliation);
    expect(explicitMessageIntent).toBeGreaterThan(pipelineReconciliation);
    expect(
      handler.indexOf(
        "appointment.updatedAt.toISOString() !== eventVersion",
        explicitMessageIntent,
      ),
    ).toBeGreaterThan(explicitMessageIntent);
    expect(cancellationSend).toBeGreaterThan(explicitMessageIntent);
    expect(handler).toContain('authorization?.state === "not_requested"');
    expect(handler).toContain('status !== "canceled"');
  });

  it("treats an appointmentless web lead as a completed domain event", () => {
    const handler = sliceBetween(
      outbox,
      'case "estimate.status_changed":',
      'case "review.request":',
    );
    const appointmentGuard = handler.indexOf("if (!appointment?.id)");
    const leadCompletion = handler.indexOf(
      'if (event.type === "lead.created")',
      appointmentGuard,
    );
    const missingAppointmentLog = handler.indexOf(
      "appointment_notification.no_appointment",
      appointmentGuard,
    );

    expect(appointmentGuard).toBeGreaterThanOrEqual(0);
    expect(leadCompletion).toBeGreaterThan(appointmentGuard);
    expect(missingAppointmentLog).toBeGreaterThan(leadCompletion);
    expect(handler.slice(leadCompletion, missingAppointmentLog)).toContain(
      'return { status: "processed" }',
    );
  });

  it("rejects forged message markers by matching the immutable status audit", () => {
    expect(outbox).toContain("verifyAppointmentMessageAuthorization({");
    expect(outbox).toContain(".from(auditLogs)");
    expect(outbox).toContain('audit.action === "appointment.status.updated"');
    expect(outbox).toContain('audit.outcome === "succeeded"');
    expect(outbox).toContain(
      'audit.requiredPermissions.includes("messages.send")',
    );
    expect(outbox).toContain("meta?.[expectedIntentMetadata] === true");
    expect(outbox).toContain('after?.["version"] === payloadVersion');
    expect(outbox).toContain(
      'error: "status_notification_not_explicitly_authorized"',
    );
    expect(outbox).toContain(
      'error: "review_request_not_explicitly_authorized"',
    );
  });

  it("durably deduplicates review requests and preserves source attribution across an audit retry", () => {
    const reviewHandler = sliceBetween(
      outbox,
      'case "review.request":',
      'case "lead.alert":',
    );
    const queue = reviewHandler.indexOf("await queueSystemOutboundMessage({");
    const queueAudit = reviewHandler.indexOf(
      'action: "review.request.queued"',
      queue,
    );

    expect(reviewHandler).toContain('payload?.["requested"] === true');
    expect(reviewHandler).toContain('status !== "completed"');
    expect(reviewHandler).toContain('error: "review_request_state_changed"');
    expect(reviewHandler).toContain(
      "appointment.review-request:${appointmentId}:${authorization.evidence.operationId}",
    );
    expect(reviewHandler).toContain("reviewRequestOutboxEventId: event.id");
    expect(reviewHandler).toContain(
      "sourceStatusAuditEventId: authorization.evidence.auditEventId",
    );
    expect(reviewHandler).toContain(
      "sourceCorrelationId: authorization.evidence.correlationId",
    );
    expect(reviewHandler).toContain(
      "sourceActorId: authorization.evidence.actorId",
    );
    expect(queue).toBeGreaterThan(0);
    expect(queueAudit).toBeGreaterThan(queue);
    expect(reviewHandler).not.toContain("await queueOutboundMessage({");
    expect(systemOutbound).toContain(
      "return db.transaction((tx) =>\n      queueSystemOutboundMessage({ ...input, db: tx })",
    );
    expect(systemOutbound).toContain("if (existing?.id) return existing.id");
    expect(systemOutbound).toContain('type: "message.send"');
  });

  it("binds cancellation calendar deletion to audit evidence and checks the switch twice", () => {
    expect(statusRoute).toContain(
      'getTeamOperationKillSwitchForRisk("external") !== null',
    );
    expect(statusRoute).toContain("sourceAuditEventId: audit.auditEventId");
    expect(statusRoute).toContain("sessionId: mutation.actor.sessionId");
    expect(statusRoute).toContain('requiredPermission: "appointments.update"');
    expect(outbox).toContain(
      'getTeamOperationKillSwitchForRisk("external") === "external_sends"',
    );
    expect(outbox).toContain(
      "verifyAppointmentCancellationCalendarAuthorization({",
    );
    expect(outbox).toContain("audit.sessionId === sessionId");
    expect(outbox).toContain(
      'before?.["calendarEventId"] === input.requestedCalendarEventId',
    );
    expect(outbox).toContain(
      'error: "calendar_cancel_not_explicitly_authorized"',
    );
    expect(outbox).toContain("await deleteCalendarEvent(");
  });

  it("uses strict Site and mobile inputs plus exact 2xx receipt validation", () => {
    for (const caller of [siteProxy, mobileActions]) {
      expect(caller).toContain("values.length === 0");
      expect(caller).toContain('"messages.send"');
      expect(caller).toContain("sendCustomerNotification");
      expect(caller).toContain("sendReviewRequest");
      expect(caller).toContain('"requested"');
      expect(caller).toContain('"not_requested"');
    }
    expect(siteProxy).toContain('values[0] !== "on"');
    expect(mobileActions).toContain('values[0] === "on" ? true : null');
    expect(siteProxy).toContain("isExactAppointmentStatusReceipt(result");
    expect(mobileActions).toContain(
      'envelope.receipt.entityType !== "appointment"',
    );
    expect(mobileActions).toContain(
      'envelope.data.calendarSync !== "requested"',
    );
    expect(mobileActions).toContain(
      "The appointment service returned an unreadable save receipt",
    );
  });

  it("shows unchecked permission-gated controls and truthful copy on every staff surface", () => {
    for (const surface of [teamCalendar, myDay, mobilePage]) {
      expect(surface).toContain('name="sendCustomerNotification"');
      expect(surface).toContain('name="sendReviewRequest"');
      expect(surface).toContain("canSendCustomerMessages");
      expect(surface).toMatch(
        /Safe default\s+is off|off unless you\s+check it/iu,
      );
      expect(surface).toMatch(/notified|review request/iu);
    }
    expect(teamCalendar).toContain("delivery is not yet confirmed");
    expect(myDay).toMatch(/does not confirm\s+delivery/iu);
    expect(mobilePage).toContain("delivery is not yet confirmed");
    expect(mobilePage).toContain("The customer was not notified.");
    expect(mobilePage).toContain("Google Calendar cleanup is queued.");
  });

  it("keeps Agent cancellation blocked behind the explicit Calendar workflow", () => {
    expect(agentAvailability).toContain("cancel_appointment:");
    expect(agentAvailability).toContain(
      "optional customer notice are shown as separate, permission-checked effects",
    );
  });

  it("never delegates commission reconciliation to the post-commit outbox", () => {
    expect(statusRoute).toContain(
      "recalculateAppointmentCommissionsAndRefreshDraftPayoutsInTransaction(",
    );
    expect(statusRoute).toContain("commissionPayoutRunIds");
    expect(statusRoute).toContain("commissionsReconciled:");
    expect(statusRoute).not.toContain("refreshCommissions:");
    expect(outbox).not.toContain("refreshCommissions");
  });

  it("carries the status audit into each durable cancellation message", () => {
    expect(notifications).toContain(
      "AppointmentNotificationAuthorizationEvidence",
    );
    expect(notifications).toContain("sourceStatusOutboxEventId");
    expect(notifications).toContain("sourceStatusAuditEventId");
    expect(notifications).toContain("sourceCorrelationId");
    expect(notifications).toContain("sourceRequiredPermission");
    expect(outbox).toMatch(
      /sendEstimateCancellation\(\s*notification,\s*authorization\.evidence\.operationId,/u,
    );
    expect(
      notifications.match(/\.\.\.\(authorization \?\? \{\}\)/gu),
    ).toHaveLength(2);
  });
});
