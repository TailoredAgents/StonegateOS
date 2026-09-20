import { randomUUID } from "node:crypto";
import {
  parsePartnerInboxQuery,
  partnerInboxItem,
} from "@/lib/partner-request-inbox";
import { parsePartnerRequestInbox } from "@myst-os/sdk";
import {
  partnerStaffArrivalWindow,
  partnerStaffArrivalPreview,
} from "@/lib/partner-staff-schedule";
import { DEFAULT_BUSINESS_HOURS_POLICY } from "@/lib/policy";
import type { PermissionContext } from "@/lib/permissions";
const owner: PermissionContext = {
  authenticated: true,
  source: "team_session",
  role: "owner",
  permissions: ["*"],
  principalId: randomUUID(),
  principalLabel: "Owner",
  sessionId: randomUUID(),
  authenticatedAt: new Date(),
};
function response() {
  const item = partnerInboxItem(
    {
      id: randomUUID(),
      kind: "service",
      account_id: randomUUID(),
      account_name: "Test company",
      job_id: null,
      service: "Junk removal",
      description: "Two cabinets",
      scope: {},
      preferred_windows: [],
      requester_name: "Requester",
      created_at: new Date(),
      state: "under_review",
      stage: "needs_attention",
      can_acknowledge: true,
    },
    owner,
  );
  return {
    ok: true,
    requests: [item],
    counts: {
      needsAttention: 1,
      waitingOnClient: 0,
      handled: 0,
      byKind: {
        service: 1,
        reschedule: 0,
        cancellation: 0,
        change: 0,
        billing: 0,
        address: 0,
      },
      byCompany: { [item.accountId]: 1 },
    },
    page: { nextCursor: null },
    group: null,
    generatedAt: new Date().toISOString(),
  };
}
describe("partner request inbox boundary", () => {
  it.each([
    "status=wrong",
    "kind=wrong",
    "accountId=wrong",
    "q=a&q=b",
    "unknown=value",
    "limit=999",
    "cursor=broken",
  ])("rejects ambiguous or invalid query %s", (query) => {
    expect(() => parsePartnerInboxQuery(new URLSearchParams(query))).toThrow();
  });
  it("distinguishes a valid empty list from malformed data", () => {
    const valid = response();
    expect(parsePartnerRequestInbox(valid)).not.toBeNull();
    expect(parsePartnerRequestInbox({ ...valid, requests: [] })).not.toBeNull();
    for (const invalid of [
      { ...valid, requests: null },
      { ...valid, counts: { ...valid.counts, needsAttention: -1 } },
      {
        ...valid,
        requests: [{ ...valid.requests[0], canAcknowledge: undefined }],
      },
      {
        ...valid,
        requests: [
          { ...valid.requests[0], detailHref: "https://example.test" },
        ],
      },
      { ...valid, page: {} },
      { ...valid, group: { id: randomUUID() } },
    ])
      expect(parsePartnerRequestInbox(invalid)).toBeNull();
  });
  it("only exposes an opening action to the configured, authenticated human owner", () => {
    const raw = {
      id: randomUUID(),
      kind: "service" as const,
      account_id: randomUUID(),
      account_name: "Test",
      job_id: null,
      service: "Test",
      description: "",
      scope: {},
      preferred_windows: [],
      requester_name: "",
      created_at: new Date(),
      state: "under_review",
      stage: "needs_attention" as const,
      can_acknowledge: true,
    };
    expect(partnerInboxItem(raw, owner).canAcknowledge).toBe(true);
    expect(
      partnerInboxItem(raw, { ...owner, source: "service" }).canAcknowledge,
    ).toBe(false);
    expect(
      partnerInboxItem(raw, { ...owner, role: "dispatcher" }).canAcknowledge,
    ).toBe(false);
    expect(
      partnerInboxItem({ ...raw, can_acknowledge: false }, owner)
        .canAcknowledge,
    ).toBe(false);
  });
});
describe("CRM arrival-window preview shares the confirmation policy", () => {
  const policy = {
    ...DEFAULT_BUSINESS_HOURS_POLICY,
    timezone: "America/New_York",
    weekly: {
      ...DEFAULT_BUSINESS_HOURS_POLICY.weekly,
      monday: [{ start: "08:00", end: "18:00" }],
    },
  };
  it("shows the two-hour bucket, not a misleading two hours after the exact crew start", () => {
    const window = partnerStaffArrivalWindow(
      new Date("2035-06-04T14:30:00Z"),
      policy,
    );
    expect(window.startAt.toISOString()).toBe("2035-06-04T14:00:00.000Z");
    expect(window.endAt.toISOString()).toBe("2035-06-04T16:00:00.000Z");
  });
  it("anchors an agreed visit outside business hours and rejects off-grid starts", () => {
    const window = partnerStaffArrivalWindow(
      new Date("2035-06-04T10:00:00Z"),
      policy,
    );
    expect(window.startAt.toISOString()).toBe("2035-06-04T10:00:00.000Z");
    expect(() =>
      partnerStaffArrivalWindow(new Date("2035-06-04T14:15:00Z"), policy),
    ).toThrow(/30-minute/u);
  });
});

describe("CRM arrival-preview input parity", () => {
  it("interprets the Eastern input independently of the display policy zone", () => {
    const preview = partnerStaffArrivalPreview("2026-09-22", "10:30", {
      ...DEFAULT_BUSINESS_HOURS_POLICY,
      timezone: "America/Los_Angeles",
    });
    expect(preview.startAt).toBe("2026-09-22T14:30:00.000Z");
    expect(preview.timezone).toBe("America/Los_Angeles");
  });
  it.each([
    ["2026-11-01", "01:30"],
    ["2026-03-08", "02:30"],
  ])("rejects ambiguous or nonexistent Eastern time %s %s", (day, time) => {
    expect(() =>
      partnerStaffArrivalPreview(day, time, DEFAULT_BUSINESS_HOURS_POLICY),
    ).toThrow(/daylight saving/u);
  });
});
