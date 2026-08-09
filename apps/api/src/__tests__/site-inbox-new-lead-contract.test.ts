import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  INBOX_NEW_LEAD_ACKNOWLEDGEMENT_TTL_SECONDS,
  parseInboxNewLeadAcknowledgementSuccess,
  parseInboxNewLeadFeed,
} from "../../../site/src/app/team/inbox-new-leads";

const CONTACT_ID = "11111111-1111-4111-8111-111111111111";
const MEMBER_ID = "22222222-2222-4222-8222-222222222222";
const ACKNOWLEDGEMENT_ID = "33333333-3333-4333-8333-333333333333";
const OPERATION_ID = "44444444-4444-4444-8444-444444444444";
const CORRELATION_ID = "55555555-5555-4555-8555-555555555555";
const AUDIT_ID = "66666666-6666-4666-8666-666666666666";
const LEAD_VERSION = "a".repeat(64);
const SITE_TEAM_ROOT = join(process.cwd(), "../site/src/app/team");

function feed(overrides: Record<string, unknown> = {}): unknown {
  return {
    ok: true,
    generatedAt: "2026-08-08T14:00:00.000Z",
    acknowledgementTtlSeconds: INBOX_NEW_LEAD_ACKNOWLEDGEMENT_TTL_SECONDS,
    total: 2,
    next: {
      contactId: CONTACT_ID,
      name: "Ada Lead",
      phone: "(555) 555-0100",
      phoneE164: "+15555550100",
      pipelineStage: "new",
      pipelineVersion: "2026-08-08T13:59:00.000Z",
      version: LEAD_VERSION,
    },
    ...overrides,
  };
}

function success(overrides: Record<string, unknown> = {}): unknown {
  return {
    ok: true,
    data: {
      contactId: CONTACT_ID,
      acknowledgedAt: "2026-08-08T14:00:00.000Z",
      expiresAt: "2026-08-09T14:00:00.000Z",
      acknowledgementVersion: 1,
      leadVersion: LEAD_VERSION,
    },
    receipt: {
      operationId: OPERATION_ID,
      correlationId: CORRELATION_ID,
      actorId: MEMBER_ID,
      committedAt: "2026-08-08T14:00:00.000Z",
      auditEventId: AUDIT_ID,
      entityType: "inbox_new_lead_acknowledgement",
      entityId: ACKNOWLEDGEMENT_ID,
      version: "1",
    },
    ...overrides,
  };
}

describe("Site Inbox new-lead contracts", () => {
  it("accepts an exact available feed and a truthful exact empty feed", () => {
    expect(parseInboxNewLeadFeed(feed())).toMatchObject({
      total: 2,
      next: { contactId: CONTACT_ID },
    });
    expect(parseInboxNewLeadFeed(feed({ total: 0, next: null }))).toMatchObject(
      { total: 0, next: null },
    );
  });

  it("rejects contradictory, broadened, or malformed feed responses", () => {
    expect(parseInboxNewLeadFeed(feed({ total: 0 }))).toBeNull();
    expect(parseInboxNewLeadFeed(feed({ total: 1, next: null }))).toBeNull();
    expect(parseInboxNewLeadFeed(feed({ extra: true }))).toBeNull();
    expect(
      parseInboxNewLeadFeed(feed({ acknowledgementTtlSeconds: 60 * 60 })),
    ).toBeNull();
    expect(
      parseInboxNewLeadFeed(
        feed({
          next: {
            contactId: CONTACT_ID,
            name: "Ada Lead",
            phone: null,
            phoneE164: "javascript:alert(1)",
            pipelineStage: "new",
            version: LEAD_VERSION,
          },
        }),
      ),
    ).toBeNull();
  });

  it("accepts only a request-bound acknowledgement receipt", () => {
    const expected = {
      contactId: CONTACT_ID,
      leadVersion: LEAD_VERSION,
      actorId: MEMBER_ID,
    };
    expect(
      parseInboxNewLeadAcknowledgementSuccess(success(), expected),
    ).toMatchObject({
      data: {
        contactId: CONTACT_ID,
        acknowledgementVersion: 1,
      },
      receipt: { entityId: ACKNOWLEDGEMENT_ID, version: "1" },
    });
    expect(
      parseInboxNewLeadAcknowledgementSuccess(
        success({
          receipt: {
            ...(success() as { receipt: Record<string, unknown> }).receipt,
            actorId: "77777777-7777-4777-8777-777777777777",
          },
        }),
        expected,
      ),
    ).toBeNull();
    expect(
      parseInboxNewLeadAcknowledgementSuccess(
        success({
          data: {
            ...(success() as { data: Record<string, unknown> }).data,
            expiresAt: "2026-08-09T13:59:59.000Z",
          },
        }),
        expected,
      ),
    ).toBeNull();
    expect(
      parseInboxNewLeadAcknowledgementSuccess(
        success({ unexpected: true }),
        expected,
      ),
    ).toBeNull();
  });

  it("loads the persisted queue and never uses the retired cookie as queue state", () => {
    const pageSource = readFileSync(join(SITE_TEAM_ROOT, "page.tsx"), "utf8");
    const componentSource = readFileSync(
      join(SITE_TEAM_ROOT, "components/InboxNewLeadNotice.tsx"),
      "utf8",
    );

    expect(pageSource).toContain('"/api/admin/inbox/new-leads/next"');
    expect(pageSource).toContain("parseInboxNewLeadFeed");
    expect(pageSource).toContain("No empty queue is being assumed");
    expect(pageSource).not.toContain('jar.get("myst-new-lead-dismissed")');
    expect(pageSource).not.toContain('jar.get("myst-new-lead-hidden-until")');
    expect(componentSource).toContain("acknowledgeNewLeadAction");
    expect(componentSource).toContain('name="leadVersion"');
    expect(componentSource).toContain('name="idempotencyKey"');
    expect(componentSource).toContain("hides it only for you for 24 hours");
  });

  it("keeps one exact request identity across one transport-only retry", () => {
    const actionSource = readFileSync(
      join(SITE_TEAM_ROOT, "actions.ts"),
      "utf8",
    );
    const actionStart = actionSource.indexOf(
      "export async function acknowledgeNewLeadAction",
    );
    const actionEnd = actionSource.indexOf(
      "export async function updateDefaultSalesAssigneeAction",
      actionStart,
    );
    const source = actionSource.slice(actionStart, actionEnd);

    expect(actionStart).toBeGreaterThanOrEqual(0);
    expect(actionEnd).toBeGreaterThan(actionStart);
    expect(source).toContain('"Idempotency-Key": idempotencyKey');
    expect(source).toContain('"If-Match": `"${leadVersion}"`');
    expect(source).toContain("callAdminMutationWithSafeReplay(");
    expect(source).not.toContain("for (let attempt");
    expect(source).not.toContain("callAdminApiAs(");
    expect(source).toContain("parseInboxNewLeadAcknowledgementSuccess");
    expect(
      source.match(/parseInboxNewLeadAcknowledgementSuccess\(/gu),
    ).toHaveLength(1);
    expect(source).toContain("The exact request was retried once");
    expect(source).toContain("unverified acknowledgement receipt");
    expect(source).toContain("[408, 429, 500, 502, 503, 504]");
    expect(
      source.indexOf("parseInboxNewLeadAcknowledgementSuccess"),
    ).toBeLessThan(source.indexOf("Lead acknowledged for you"));
    expect(actionSource).not.toContain(
      "export async function dismissNewLeadAction",
    );
  });
});
