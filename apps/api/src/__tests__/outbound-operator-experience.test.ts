import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildOutboundHref,
  buildOutboundPartnersHref,
  outboundSubviewHrefFromReturn,
  parseOutboundReturnHref,
} from "../../../site/src/app/team/outbound-navigation";
import {
  formatOutboundEasternTime,
  parseOutboundQueueResponse,
} from "../../../site/src/app/team/outbound-queue";

const REPOSITORY_ROOT = join(process.cwd(), "../..");

function source(relativePath: string): string {
  return readFileSync(join(REPOSITORY_ROOT, relativePath), "utf8");
}

const MEMBER_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "22222222-2222-4222-8222-222222222222";
const CONTACT_ID = "33333333-3333-4333-8333-333333333333";
const ACCOUNT_ID = "44444444-4444-4444-8444-444444444444";
const CURSOR = "opaque_queue_cursor";

function validQueuePayload(): Record<string, unknown> {
  return {
    ok: true,
    memberId: MEMBER_ID,
    timezone: "America/New_York",
    q: "Acme",
    snapshotAt: "2026-08-09T13:00:00.000Z",
    scope: {
      facets: "assignee_snapshot",
      summary: "filtered_account_snapshot",
      scoreboard: "assignee_campaign_snapshot",
    },
    total: 1,
    truncated: false,
    scanLimit: 1,
    offset: 0,
    limit: 50,
    nextOffset: null,
    nextCursor: null,
    previousCursor: null,
    summary: {
      dueNow: 1,
      overdue: 0,
      callbacksToday: 1,
      notStarted: 0,
      scoreboard: {
        accountsTouched: 1,
        conversationsStarted: 1,
        qualifiedPartners: 0,
        activePartners: 0,
        avgFitScore: 82,
        partnerPathMix: {
          portalFirst: 1,
          managedDirect: 0,
          hybrid: 0,
          notAFit: 0,
        },
      },
    },
    facets: {
      campaigns: ["property_management"],
      dispositions: ["callback_requested"],
      attempts: ["2"],
    },
    items: [
      {
        id: ACCOUNT_ID,
        title: "Outbound callback",
        dueAt: "2026-08-10T13:00:00.000Z",
        overdue: false,
        minutesUntilDue: 60,
        attempt: 2,
        campaign: "property_management",
        lastDisposition: "callback_requested",
        company: "Acme",
        noteSnippet: null,
        startedAt: "2026-08-09T13:00:00.000Z",
        reminderAt: "2026-08-10T12:45:00.000Z",
        assignedToMemberId: MEMBER_ID,
        primaryTaskId: TASK_ID,
        primaryTaskVersion: "2026-08-09T13:00:00.000Z",
        primaryContactId: CONTACT_ID,
        taskIds: [TASK_ID],
        contactCount: 1,
        dncContactCount: 1,
        openTaskCount: 1,
        contacts: [
          {
            id: CONTACT_ID,
            name: "Casey Contact",
            email: "casey@example.com",
            phone: "+14045550100",
            source: "outbound",
            doNotContact: true,
            doNotContactAt: "2026-08-09T14:00:00.000Z",
            doNotContactReason: "Customer request",
          },
        ],
        tasks: [
          {
            id: TASK_ID,
            version: "2026-08-09T13:00:00.000Z",
            title: "Outbound callback",
            dueAt: "2026-08-10T13:00:00.000Z",
            attempt: 2,
            lastDisposition: "callback_requested",
            contactId: CONTACT_ID,
            contactName: "Casey Contact",
            doNotContact: true,
          },
        ],
        account: {
          id: ACCOUNT_ID,
          name: "Acme",
          status: "conversation_active",
          segment: "property_manager",
          portalFit: "portal_first",
          fitScore: 82,
          lastTouchAt: "2026-08-09T13:00:00.000Z",
          nextTouchAt: "2026-08-10T13:00:00.000Z",
          brief: null,
          history: [],
        },
      },
    ],
  };
}

describe("Outbound operator experience", () => {
  it("preserves filters, pagination, selection, and assignee in canonical subview URLs", () => {
    const filters = {
      q: "Acme & Sons",
      campaign: "property management",
      attempt: "2",
      due: "today",
      has: "both",
      disposition: "callback_requested",
      taskId: TASK_ID,
      accountId: ACCOUNT_ID,
      cursor: CURSOR,
      direction: "next",
    };
    const queue = buildOutboundHref({ memberId: MEMBER_ID, filters });
    expect(String(queue)).toBe(
      `/team/sales/outbound?memberId=${MEMBER_ID}&out_q=Acme+%26+Sons&out_campaign=property+management&out_attempt=2&out_due=today&out_has=both&out_disposition=callback_requested&out_taskId=${TASK_ID}&out_account=${ACCOUNT_ID}&out_cursor=${CURSOR}&out_direction=next`,
    );

    const importHref = outboundSubviewHrefFromReturn(queue, "import");
    expect(String(importHref)).toContain("/team/sales/outbound?");
    expect(String(importHref)).toContain("view=import");
    expect(String(importHref)).toContain(`out_taskId=${TASK_ID}`);
    expect(String(importHref)).toContain(`out_cursor=${CURSOR}`);
    expect(String(importHref)).toContain("out_direction=next");

    const partners = buildOutboundPartnersHref({
      memberId: MEMBER_ID,
      filters,
      view: "queue",
    });
    const partnerUrl = new URL(String(partners), "https://team.invalid");
    expect(partnerUrl.pathname).toBe("/team/sales/outbound/partners");
    expect(
      parseOutboundReturnHref(partnerUrl.searchParams.get("out_return")),
    ).toEqual({ memberId: MEMBER_ID, view: "queue", filters });
  });

  it("rejects external, duplicate, unknown, and noncanonical return URLs", () => {
    for (const value of [
      "https://evil.example/team/sales/outbound",
      "//evil.example/team/sales/outbound",
      "/team?tab=outbound",
      "/team/sales/outbound?unknown=1",
      "/team/sales/outbound?out_due=today&out_due=overdue",
      "/team/sales/outbound#queue",
    ]) {
      expect(parseOutboundReturnHref(value)).toBeNull();
    }
    expect(
      String(outboundSubviewHrefFromReturn("https://evil.example", "queue")),
    ).toBe("/team/sales/outbound");
  });

  it("fails the queue closed when DNC, assignee, task binding, or completeness facts are missing", () => {
    expect(parseOutboundQueueResponse(validQueuePayload())).not.toBeNull();

    const missingDnc = validQueuePayload();
    delete (
      (missingDnc["items"] as Array<Record<string, unknown>>)[0]![
        "contacts"
      ] as Array<Record<string, unknown>>
    )[0]!["doNotContact"];
    expect(parseOutboundQueueResponse(missingDnc)).toBeNull();

    const missingAssignee = validQueuePayload();
    delete (missingAssignee["items"] as Array<Record<string, unknown>>)[0]![
      "assignedToMemberId"
    ];
    expect(parseOutboundQueueResponse(missingAssignee)).toBeNull();

    const mismatchedDncCount = validQueuePayload();
    (mismatchedDncCount["items"] as Array<Record<string, unknown>>)[0]![
      "dncContactCount"
    ] = 0;
    expect(parseOutboundQueueResponse(mismatchedDncCount)).toBeNull();

    const falseCompleteness = validQueuePayload();
    falseCompleteness["truncated"] = true;
    expect(parseOutboundQueueResponse(falseCompleteness)).toBeNull();

    const missingSnapshot = validQueuePayload();
    delete missingSnapshot["snapshotAt"];
    expect(parseOutboundQueueResponse(missingSnapshot)).toBeNull();

    const hiddenTaskId = validQueuePayload();
    (hiddenTaskId["items"] as Array<Record<string, unknown>>)[0]!["taskIds"] = [
      TASK_ID,
      "55555555-5555-4555-8555-555555555555",
    ];
    expect(parseOutboundQueueResponse(hiddenTaskId)).toBeNull();

    const mismatchedPrimaryVersion = validQueuePayload();
    (mismatchedPrimaryVersion["items"] as Array<Record<string, unknown>>)[0]![
      "primaryTaskVersion"
    ] = "2026-08-09T13:00:01.000Z";
    expect(parseOutboundQueueResponse(mismatchedPrimaryVersion)).toBeNull();

    const mismatchedAccount = validQueuePayload();
    (
      (mismatchedAccount["items"] as Array<Record<string, unknown>>)[0]![
        "account"
      ] as Record<string, unknown>
    )["id"] = "66666666-6666-4666-8666-666666666666";
    expect(parseOutboundQueueResponse(mismatchedAccount)).toBeNull();

    const mismatchedTaskContact = validQueuePayload();
    (
      (mismatchedTaskContact["items"] as Array<Record<string, unknown>>)[0]![
        "tasks"
      ] as Array<Record<string, unknown>>
    )[0]!["contactId"] = "77777777-7777-4777-8777-777777777777";
    expect(parseOutboundQueueResponse(mismatchedTaskContact)).toBeNull();
  });

  it("shows one partner conversion when the attributed audit replaces the legacy note", () => {
    const enrichment = source("apps/api/src/lib/outbound-queue-enrichment.ts");
    expect(enrichment).toContain("auditedPartnerContactIds");
    expect(enrichment).toContain('row.action === "partner.converted"');
    expect(enrichment).toContain(
      '.startsWith("outbound converted to partner")',
    );
  });

  it("formats every queue and callback instant in Eastern time with DST identity", () => {
    expect(formatOutboundEasternTime("2026-07-01T14:00:00.000Z")).toContain(
      "10:00 AM EDT (America/New_York)",
    );
    expect(formatOutboundEasternTime("2026-01-01T14:00:00.000Z")).toContain(
      "9:00 AM EST (America/New_York)",
    );
  });

  it("locks contact scope before task rows and rejects direct DNC cadence bypasses", () => {
    const start = source("apps/api/app/api/admin/outbound/start/route.ts");
    const bulk = source("apps/api/app/api/admin/outbound/bulk/route.ts");
    for (const route of [start, bulk]) {
      expect(route).toContain("outbound-disposition:contact:");
      expect(route).toContain("contacts.doNotContact");
      expect(route).toContain("contacts.deletedAt");
    }
    const startContactLock = start.indexOf("const [contact] = await tx");
    const startTaskLock = start.indexOf("const [task] = await tx");
    expect(start.indexOf("pg_advisory_xact_lock")).toBeLessThan(
      startContactLock,
    );
    expect(startContactLock).toBeLessThan(startTaskLock);
    expect(start.slice(startContactLock, startTaskLock)).toContain(
      '.for("update")',
    );
    expect(start.slice(startTaskLock)).toContain('.for("update")');

    const bulkContactLocks = bulk.indexOf("const contactRows = await tx");
    const bulkTaskLocks = bulk.indexOf(
      "const rows = await tx",
      bulkContactLocks,
    );
    expect(bulk.indexOf("pg_advisory_xact_lock")).toBeLessThan(
      bulkContactLocks,
    );
    expect(bulkContactLocks).toBeLessThan(bulkTaskLocks);
    expect(bulk.slice(bulkContactLocks, bulkTaskLocks)).toContain(
      '.for("update")',
    );
    expect(bulk.slice(bulkTaskLocks)).toContain('.for("update")');
    expect(start).toContain("task.contactId !== candidate.contactId");
    expect(bulk).toContain(
      "candidateContactByTask.get(row.id) !== row.contactId",
    );
    expect(bulk).toContain('payload.action === "assign_start"');
    expect(bulk).toContain('payload.action === "snooze"');
    expect(bulk).toContain("Nothing was changed");
  });

  it("coordinates every active DNC writer through the contact row and keeps the provider recheck", () => {
    const inboxDnc = source(
      "apps/api/app/api/admin/inbox/threads/[threadId]/route.ts",
    );
    const salesDnc = source(
      "apps/api/app/api/admin/sales/disposition/route.ts",
    );
    const outboundDnc = source(
      "apps/api/app/api/admin/outbound/disposition/route.ts",
    );
    const dispatch = source("apps/api/src/lib/external-message-dispatch.ts");

    expect(inboxDnc).toContain("db.transaction(async (tx)");
    expect(inboxDnc).toContain(".update(contacts)");
    expect(inboxDnc).toContain("doNotContact: true");
    for (const writer of [salesDnc, outboundDnc]) {
      const contactRead = writer.indexOf(".from(contacts)");
      const dncWrite = writer.indexOf("doNotContact: true");
      expect(contactRead).toBeGreaterThanOrEqual(0);
      expect(dncWrite).toBeGreaterThan(contactRead);
      expect(writer.slice(contactRead, dncWrite)).toContain('.for("update")');
    }
    expect(outboundDnc).toContain(
      "hashtextextended(${candidate.contactId}, 0)",
    );
    expect(outboundDnc.indexOf("${candidate.contactId}, 0")).toBeLessThan(
      outboundDnc.indexOf("outbound-disposition:contact:"),
    );

    const finalClaim = dispatch.slice(
      dispatch.indexOf("export async function claimMessageDispatch"),
      dispatch.indexOf("export async function finalizeMessageDispatch"),
    );
    expect(finalClaim).toContain("contacts.doNotContact");
    expect(finalClaim).toContain("hashtextextended(${scope.contactId}, 0)");
    expect(finalClaim).toContain("contact_dnc_before_provider_dispatch");
    expect(finalClaim).toContain("planContactDispatchEligibility(");
  });

  it("shows unmistakable safe states at mobile and desktop widths", () => {
    const outbound = source(
      "apps/site/src/app/team/components/OutboundSection.tsx",
    );
    const selection = source(
      "apps/site/src/app/team/components/OutboundBulkSelectionControls.tsx",
    );
    const partners = source(
      "apps/site/src/app/team/components/PartnersSection.tsx",
    );
    const queue = source("apps/api/app/api/admin/outbound/queue/route.ts");

    expect(outbound).toContain("Do Not Contact — outreach blocked");
    expect(outbound).toContain("selectedOutreachBlocked");
    expect(outbound).toContain("disabled={hasDnc}");
    expect(outbound).toContain("Owner:");
    expect(outbound).toContain("Cadence:");
    expect(outbound).toContain("Disposition:");
    expect(outbound).toContain("Callback date and time —");
    expect(outbound).toContain("DST gaps and repeated");
    expect(outbound).toContain('action="/team/sales/outbound"');
    expect(outbound).not.toContain('action="/team"');
    expect(partners).toContain('action="/team/sales/outbound/partners"');
    expect(partners).not.toContain('action="/team"');
    expect(selection).toContain("getEligibleCheckboxes");
    expect(selection).toContain("min-h-11");
    expect(outbound).toContain('role="status"');
    expect(queue).toContain("truncated: false");
    expect(queue).toContain("nextCursor: queue.nextCursor");
    expect(queue).toContain("previousCursor: queue.previousCursor");
    expect(queue).not.toContain("MAX_SCAN");
    expect(outbound).not.toContain("This queue view is incomplete");
  });
});
