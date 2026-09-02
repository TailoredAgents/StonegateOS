import {
  PartnerManagementListInputError,
  buildPartnerManagementPage,
  parsePartnerManagementListQuery,
} from "@/lib/partner-management-list";
import {
  boundedPartnerQuarantineText,
  hasAcceptedPartnerInviteProviderEvidence,
  partnerQuarantineCaseId,
} from "@/lib/partner-management-quarantine";

const FIRST_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_ID = "22222222-2222-4222-8222-222222222222";

describe("partner management list contract", () => {
  it("normalizes bounded filters and emits a filter-bound keyset cursor", () => {
    const query = parsePartnerManagementListQuery(
      new URLSearchParams({
        q: "  Acme   East ",
        status: "active",
        limit: "1",
      }),
      "people",
    );
    expect(query.q).toBe("Acme East");
    expect(query.limit).toBe(1);

    const result = buildPartnerManagementPage(
      [
        { id: FIRST_ID, createdAt: new Date("2026-08-02T12:00:00.000Z") },
        { id: SECOND_ID, createdAt: new Date("2026-08-01T12:00:00.000Z") },
      ],
      query,
    );
    expect(result.items).toHaveLength(1);
    expect(result.page.hasMore).toBe(true);
    expect(result.page.nextCursor).toEqual(expect.any(String));

    const next = parsePartnerManagementListQuery(
      new URLSearchParams({
        q: "Acme East",
        status: "active",
        limit: "1",
        cursor: result.page.nextCursor!,
      }),
      "people",
    );
    expect(next.cursor?.id).toBe(FIRST_ID);
  });

  it("rejects a cursor when its resource or filters change", () => {
    const query = parsePartnerManagementListQuery(
      new URLSearchParams({ q: "Acme", limit: "1" }),
      "accounts",
    );
    const cursor = buildPartnerManagementPage(
      [
        { id: FIRST_ID, createdAt: new Date("2026-08-02T12:00:00.000Z") },
        { id: SECOND_ID, createdAt: new Date("2026-08-01T12:00:00.000Z") },
      ],
      query,
    ).page.nextCursor!;

    expect(() =>
      parsePartnerManagementListQuery(
        new URLSearchParams({ q: "Different", limit: "1", cursor }),
        "accounts",
      ),
    ).toThrow(PartnerManagementListInputError);
    expect(() =>
      parsePartnerManagementListQuery(
        new URLSearchParams({ q: "Acme", limit: "1", cursor }),
        "people",
      ),
    ).toThrow("different list or filter set");
  });

  it("rejects duplicate, unsupported, oversized, and invalid status inputs", () => {
    const duplicate = new URLSearchParams();
    duplicate.append("q", "one");
    duplicate.append("q", "two");
    expect(() =>
      parsePartnerManagementListQuery(duplicate, "accounts"),
    ).toThrow("may only be provided once");
    expect(() =>
      parsePartnerManagementListQuery(
        new URLSearchParams({ unexpected: "1" }),
        "accounts",
      ),
    ).toThrow("Unsupported");
    expect(() =>
      parsePartnerManagementListQuery(
        new URLSearchParams({ limit: "101" }),
        "accounts",
      ),
    ).toThrow("between 1 and 100");
    expect(() =>
      parsePartnerManagementListQuery(
        new URLSearchParams({ status: "active" }),
        "accounts",
      ),
    ).toThrow("supported accounts status");
    expect(() =>
      parsePartnerManagementListQuery(
        new URLSearchParams({ accountId: FIRST_ID }),
        "accounts",
      ),
    ).toThrow("not supported by the accounts directory");
  });

  it.each([
    "pending_activation",
    "active",
    "suspended",
    "disabled",
    "quarantined",
  ])("filters people by the explicit identity state %s", (status) => {
    expect(
      parsePartnerManagementListQuery(new URLSearchParams({ status }), "people")
        .status,
    ).toBe(status);
  });

  it("does not collapse explicit identity states into the legacy inactive filter", () => {
    expect(() =>
      parsePartnerManagementListQuery(
        new URLSearchParams({ status: "inactive" }),
        "people",
      ),
    ).toThrow("supported people status");
  });

  it.each(["active", "expired", "revoked"])(
    "accepts the explicit partner session state %s",
    (status) => {
      const query = parsePartnerManagementListQuery(
        new URLSearchParams({
          status,
          accountId: FIRST_ID,
          userId: SECOND_ID,
        }),
        "security",
      );
      expect(query.status).toBe(status);
      expect(query.accountId).toBe(FIRST_ID);
      expect(query.userId).toBe(SECOND_ID);
    },
  );

  it("rejects identity lifecycle states as session states", () => {
    expect(() =>
      parsePartnerManagementListQuery(
        new URLSearchParams({ status: "disabled" }),
        "security",
      ),
    ).toThrow("supported security status");
  });

  it.each(["contained", "reconciliation_required", "resolved"])(
    "accepts the explicit quarantine state %s with bounded filters",
    (status) => {
      const query = parsePartnerManagementListQuery(
        new URLSearchParams({
          status,
          accountId: FIRST_ID,
          userId: SECOND_ID,
        }),
        "quarantine",
      );
      expect(query.status).toBe(status);
      expect(query.accountId).toBe(FIRST_ID);
      expect(query.userId).toBe(SECOND_ID);
    },
  );

  it.each(["ready", "attention_required", "unconfigured"])(
    "accepts the explicit account commercial state %s",
    (status) => {
      const query = parsePartnerManagementListQuery(
        new URLSearchParams({ status, accountId: FIRST_ID }),
        "commercial",
      );
      expect(query.status).toBe(status);
      expect(query.accountId).toBe(FIRST_ID);
      expect(() =>
        parsePartnerManagementListQuery(
          new URLSearchParams({ userId: SECOND_ID }),
          "commercial",
        ),
      ).toThrow("not supported by the commercial directory");
    },
  );

  it("creates stable typed case IDs and bounds staff-visible reasons", () => {
    const identityId = partnerQuarantineCaseId("identity", FIRST_ID);
    expect(identityId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(partnerQuarantineCaseId("identity", FIRST_ID)).toBe(identityId);
    expect(partnerQuarantineCaseId("invite_delivery", FIRST_ID)).not.toBe(
      identityId,
    );
    expect(() => partnerQuarantineCaseId("identity", "not-a-uuid")).toThrow(
      "invalid_partner_quarantine_source_id",
    );
    expect(boundedPartnerQuarantineText("  one   two  ", "fallback")).toBe(
      "one two",
    );
    expect(boundedPartnerQuarantineText("x".repeat(600), "fallback")).toHaveLength(
      500,
    );
    expect(
      hasAcceptedPartnerInviteProviderEvidence([{ state: "succeeded" }]),
    ).toBe(true);
    expect(
      hasAcceptedPartnerInviteProviderEvidence([{ state: "failed" }]),
    ).toBe(false);
  });
});
