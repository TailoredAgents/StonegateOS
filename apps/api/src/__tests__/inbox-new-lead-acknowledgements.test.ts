import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DatabaseClient } from "@/db";
import {
  inboxNewLeadAcknowledgementExpiry,
  inboxNewLeadVersion,
  isInboxNewLeadAcknowledgementActive,
  isNonOutboundInboxLeadSource,
  INBOX_NEW_LEAD_ACKNOWLEDGEMENT_TTL_SECONDS,
  loadInboxNewLeadFeed,
  toInboxNewLeadFeed,
  type InboxNewLeadFeedRow,
} from "@/lib/inbox-new-lead-acknowledgements";

const REPOSITORY_ROOT = resolve(process.cwd(), "../..");
const MEMBER_A = "11111111-1111-4111-8111-111111111111";
const CONTACT_A = "22222222-2222-4222-8222-222222222222";

function read(relativePath: string): string {
  return readFileSync(resolve(REPOSITORY_ROOT, relativePath), "utf8");
}

function feedRow(
  overrides: Partial<InboxNewLeadFeedRow> = {},
): InboxNewLeadFeedRow {
  return {
    contactId: CONTACT_A,
    firstName: "Ada",
    lastName: "Lovelace",
    phone: "404-555-0101",
    phoneE164: "+14045550101",
    contactUpdatedAt: new Date("2026-08-09T12:00:00.000Z"),
    pipelineUpdatedAt: new Date("2026-08-09T12:01:00.000Z"),
    total: "27",
    ...overrides,
  };
}

describe("durable per-member Inbox new-lead acknowledgement", () => {
  it("uses one exact 24-hour window with an exclusive expiry boundary", () => {
    const acknowledgedAt = new Date("2026-08-09T12:00:00.000Z");
    const expiresAt = inboxNewLeadAcknowledgementExpiry(acknowledgedAt);

    expect(INBOX_NEW_LEAD_ACKNOWLEDGEMENT_TTL_SECONDS).toBe(86_400);
    expect(expiresAt.toISOString()).toBe("2026-08-10T12:00:00.000Z");
    expect(
      isInboxNewLeadAcknowledgementActive(
        expiresAt,
        new Date("2026-08-10T11:59:59.999Z"),
      ),
    ).toBe(true);
    expect(isInboxNewLeadAcknowledgementActive(expiresAt, expiresAt)).toBe(
      false,
    );
  });

  it("builds an opaque eligibility version from both contact and pipeline state", () => {
    const source = feedRow();
    const first = inboxNewLeadVersion(source);

    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(inboxNewLeadVersion({ ...source })).toBe(first);
    expect(
      inboxNewLeadVersion({
        ...source,
        contactUpdatedAt: new Date("2026-08-09T12:00:00.001Z"),
      }),
    ).not.toBe(first);
    expect(
      inboxNewLeadVersion({
        ...source,
        pipelineUpdatedAt: new Date("2026-08-09T12:01:00.001Z"),
      }),
    ).not.toBe(first);
  });

  it("maps one bounded row while preserving the exact full eligible total", () => {
    const generatedAt = new Date("2026-08-09T13:00:00.000Z");
    const feed = toInboxNewLeadFeed(feedRow(), generatedAt);

    expect(feed).toEqual({
      ok: true,
      generatedAt: generatedAt.toISOString(),
      acknowledgementTtlSeconds: 86_400,
      total: 27,
      next: {
        contactId: CONTACT_A,
        name: "Ada Lovelace",
        phone: "404-555-0101",
        phoneE164: "+14045550101",
        pipelineStage: "new",
        pipelineVersion: "2026-08-09T12:01:00.000Z",
        version: inboxNewLeadVersion(feedRow()),
      },
    });
    expect(toInboxNewLeadFeed(undefined, generatedAt)).toMatchObject({
      ok: true,
      total: 0,
      next: null,
    });
    expect(
      toInboxNewLeadFeed(feedRow({ phoneE164: "404-555-0101" }), generatedAt)
        .next?.phoneE164,
    ).toBeNull();
    expect(
      toInboxNewLeadFeed(feedRow({ phoneE164: "+01234567890" }), generatedAt)
        .next?.phoneE164,
    ).toBeNull();
  });

  it.each([
    feedRow({ total: 0 }),
    feedRow({ total: -1 }),
    feedRow({ total: "not-a-count" }),
    feedRow({ firstName: "x".repeat(101) }),
    feedRow({ phone: "1".repeat(33) }),
  ])("rejects malformed database output instead of presenting empty", (row) => {
    expect(() =>
      toInboxNewLeadFeed(row, new Date("2026-08-09T13:00:00.000Z")),
    ).toThrow();
  });

  it("uses the same case-insensitive outbound boundary as the database query", () => {
    expect(isNonOutboundInboxLeadSource(null)).toBe(true);
    expect(isNonOutboundInboxLeadSource("website")).toBe(true);
    expect(isNonOutboundInboxLeadSource("outbound:campaign-a")).toBe(false);
    expect(isNonOutboundInboxLeadSource("OUTBOUND:campaign-a")).toBe(false);
  });

  it("executes a fixed one-row read and propagates database failures", async () => {
    const row = feedRow({ total: 2 });
    const query: Record<string, jest.Mock> = {};
    query["from"] = jest.fn(() => query);
    query["innerJoin"] = jest.fn(() => query);
    query["leftJoin"] = jest.fn(() => query);
    query["where"] = jest.fn(() => query);
    query["orderBy"] = jest.fn(() => query);
    query["limit"] = jest.fn(() => Promise.resolve([row]));
    const db = {
      select: jest.fn(() => query),
    } as unknown as DatabaseClient;

    await expect(
      loadInboxNewLeadFeed(db, MEMBER_A, new Date("2026-08-09T13:00:00.000Z")),
    ).resolves.toMatchObject({ total: 2, next: { contactId: CONTACT_A } });
    expect(query["limit"]).toHaveBeenCalledWith(1);

    const failedQuery: Record<string, jest.Mock> = {};
    failedQuery["from"] = jest.fn(() => failedQuery);
    failedQuery["innerJoin"] = jest.fn(() => failedQuery);
    failedQuery["leftJoin"] = jest.fn(() => failedQuery);
    failedQuery["where"] = jest.fn(() => failedQuery);
    failedQuery["orderBy"] = jest.fn(() => failedQuery);
    failedQuery["limit"] = jest.fn(() =>
      Promise.reject(new Error("database unavailable")),
    );
    const failedDb = {
      select: jest.fn(() => failedQuery),
    } as unknown as DatabaseClient;
    await expect(
      loadInboxNewLeadFeed(
        failedDb,
        MEMBER_A,
        new Date("2026-08-09T13:00:00.000Z"),
      ),
    ).rejects.toThrow("database unavailable");
  });

  it("stores acknowledgements by the exact member-contact pair", () => {
    const migration = read(
      "apps/api/src/db/migrations/0087_team_inbox_new_lead_acknowledgements.sql",
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "team_inbox_new_lead_ack_member_contact_key"',
    );
    expect(migration).toContain('("team_member_id", "contact_id")');
    expect(migration).toContain(
      'REFERENCES "team_members" ("id") ON DELETE CASCADE',
    );
    expect(migration).toContain(
      'REFERENCES "contacts" ("id") ON DELETE CASCADE',
    );
    expect(migration).toContain(
      'CHECK ("expires_at" = "acknowledged_at" + interval \'24 hours\')',
    );
    expect(migration).toContain("WHERE \"stage\" = 'new'");

    const schema = read("apps/api/src/db/schema.ts");
    expect(schema).toContain(
      "export const teamInboxNewLeadAcknowledgements = pgTable(",
    );
    expect(schema).toContain('"team_inbox_new_lead_ack_member_contact_key"');
  });

  it("reads the full eligible set once and excludes only this member's exact active pair", () => {
    const service = read("apps/api/src/lib/inbox-new-lead-acknowledgements.ts");
    expect(service).toContain("count(*) over()");
    expect(service).toContain(".limit(1)");
    expect(service).toContain(
      "eq(teamInboxNewLeadAcknowledgements.teamMemberId, teamMemberId)",
    );
    expect(service).toContain(
      "eq(teamInboxNewLeadAcknowledgements.contactId, contacts.id)",
    );
    expect(service).toContain(
      "gt(teamInboxNewLeadAcknowledgements.expiresAt, now)",
    );
    expect(service).toContain("isNull(contacts.deletedAt)");
    expect(service).toContain('eq(crmPipeline.stage, "new")');
    expect(service).toContain("not ilike 'outbound:%'");
    expect(service).not.toContain("limit(12)");
  });

  it("keeps GET human-only, strict, bounded, no-store, and failure-truthful", () => {
    const route = read("apps/api/app/api/admin/inbox/new-leads/next/route.ts");
    expect(route).toContain('requirePermission(request, "messages.read")');
    expect(route).toContain("getVerifiedRequestActor(request)");
    expect(route).toContain('actor?.type !== "human"');
    expect(route).toContain("request.nextUrl.search.length > 0");
    expect(route).toContain('"Cache-Control": "no-store"');
    expect(route).toContain("await loadInboxNewLeadFeed(");
    expect(route).toContain('code: "internal"');
    expect(route).toContain("retryable: true");
    expect(route).not.toContain("/api/admin/contacts?limit=12");
    expect(route.indexOf("requirePermission(")).toBeLessThan(
      route.indexOf("request.nextUrl"),
    );
    expect(route.indexOf("requirePermission(")).toBeLessThan(
      route.indexOf("getDb()"),
    );
  });

  it("uses the shared mutation boundary and atomically records acknowledgement, audit, and replay", () => {
    const route = read(
      "apps/api/app/api/admin/inbox/new-leads/[contactId]/acknowledge/route.ts",
    );
    expect(route).toContain('principalTypes: ["human"]');
    expect(route).toContain('requiredPermissions: ["messages.read"]');
    expect(route).toContain('risk: "normal"');
    expect(route).toContain("requiresIdempotency: true");
    expect(route).toContain('auditAction: "inbox.new_lead.acknowledged"');
    expect(route).toContain("mutation.actor.id");
    expect(route).toContain("mutation.expectedVersion === null");
    expect(route).toContain("claimTeamMutationIdempotency(");
    expect(route).toContain("assertTeamMutationExpectedVersion(");
    expect(route).toContain("pg_advisory_xact_lock");
    expect(route.match(/\.for\("update"\)/gu)).toHaveLength(3);
    expect(route).toContain("contact.deletedAt !== null");
    expect(route).toContain('pipeline.stage !== "new"');
    expect(route).toContain("isNonOutboundInboxLeadSource(contact.source)");
    expect(route).toContain(
      "eq(teamInboxNewLeadAcknowledgements.teamMemberId, teamMemberId)",
    );
    expect(route).toContain(
      "eq(teamInboxNewLeadAcknowledgements.contactId, contactId)",
    );
    expect(route).toContain("mutation.audit.insertSuccess(tx");
    expect(route).toContain("completeTeamMutationIdempotency(");
    expect(route.indexOf("beginTeamMutation(")).toBeLessThan(
      route.indexOf("context.params"),
    );
    expect(route.indexOf("beginTeamMutation(")).toBeLessThan(
      route.indexOf("getDb()"),
    );
    expect(route).not.toContain("request.json(");
  });
});
