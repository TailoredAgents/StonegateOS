import fs from "node:fs";
import path from "node:path";

function source(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("Partner Portal V2 job hub route boundaries", () => {
  test("job detail publishes only sent ETA, generic team, and own delivery evidence", () => {
    const detail = source("app/api/portal/v2/jobs/[jobId]/route.ts");
    const projection = source("src/lib/partner-portal-v2-job-hub.ts");

    expect(detail).toContain('eq(etaMessageDrafts.status, "sent")');
    expect(detail).toContain("isNotNull(etaMessageDrafts.sentAt)");
    expect(detail).not.toContain("etaMessageDrafts.body");
    expect(detail).not.toContain("crewLocationPings");
    expect(detail).not.toContain("resourceAssignmentSnapshot");
    expect(detail).toContain("appointmentCrewMembers.appointmentId");
    expect(detail).toContain("partnerNotificationDeliveries.partnerAccountId");
    expect(detail).toContain("partnerNotificationDeliveries.membershipId");
    expect(detail).toContain("partnerNotificationDeliveries.partnerBookingId");
    for (const privateField of [
      "providerMessageId",
      "providerRequestKey",
      "dedupeKeyHash",
      "outboxEventId",
      "endpointId",
      "detail: partnerNotificationDeliveries.detail",
    ]) {
      expect(detail).not.toContain(privateField);
    }
    expect(projection).toContain('displayLabel: "Stonegate service crew"');
    expect(projection).toContain('state: "operational_estimate"');
  });

  test("issue reports reuse the scoped job thread and atomic message transaction", () => {
    const messages = source("app/api/portal/v2/jobs/[jobId]/messages/route.ts");
    const postStart = messages.indexOf("export async function POST");
    const accessCheck = messages.indexOf(
      "await hasPartnerJobAccess(principal, jobId)",
      postStart,
    );
    const idempotency = messages.indexOf(
      "readPortalV2IdempotencyKey",
      accessCheck,
    );
    const bodyRead = messages.indexOf("readBoundedJsonRequest", idempotency);
    const transaction = messages.indexOf("db.transaction", bodyRead);

    expect(messages).toContain('request,\n    "messages.send"');
    expect(messages).toContain("isAllowedPartnerPortalMutationOrigin");
    expect(accessCheck).toBeGreaterThan(postStart);
    expect(idempotency).toBeGreaterThan(accessCheck);
    expect(bodyRead).toBeGreaterThan(idempotency);
    expect(transaction).toBeGreaterThan(bodyRead);
    expect(messages).toContain("IssueMessageBodySchema");
    expect(messages).toContain("PARTNER_JOB_ISSUE_CATEGORIES");
    expect(messages).toContain("PARTNER_JOB_ISSUE_PRIORITIES");
    expect(messages).toContain(
      "eq(conversationThreads.partnerAccountId, principal.accountId!)",
    );
    expect(messages).toContain(
      "eq(conversationThreads.partnerBookingId, job.id)",
    );
    expect(messages).toContain('eventType: "issue_reported"');
    expect(messages).toContain(
      'action: issue\n          ? "partner.job_issue.reported"',
    );
  });

  test("issue timeline metadata is fixed and excludes the free-form report", () => {
    const messages = source("app/api/portal/v2/jobs/[jobId]/messages/route.ts");
    const eventStart = messages.indexOf("await tx.insert(partnerJobEvents)");
    const eventEnd = messages.indexOf("const auditId", eventStart);
    const eventInsert = messages.slice(eventStart, eventEnd);
    const metadata = eventInsert.slice(eventInsert.indexOf("metadata:"));

    expect(metadata).toContain("category: issue.category");
    expect(metadata).toContain("priority: issue.priority");
    expect(metadata).not.toContain("parsed.data.body");
    expect(metadata).not.toContain("principal.membershipId");
    expect(metadata).not.toContain("thread.id");
    expect(metadata).not.toContain("message.id");
  });
});
