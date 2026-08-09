import {
  buildPartnerPageMetadata,
  decodePartnerCursor,
  encodePartnerCursor,
  parsePartnerListQuery,
  partnerFilterHash,
} from "@/lib/partner-query";
import {
  parsePartnerPortalUsersResponse,
  parsePartnerRatesResponse,
  parsePartnersResponse,
} from "../../../site/src/app/team/partner-page";

const FIRST_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_ID = "22222222-2222-4222-8222-222222222222";
const SNAPSHOT_AT = "2026-08-08T12:00:00.000Z";

function firstQuery(): Extract<
  ReturnType<typeof parsePartnerListQuery>,
  { ok: true }
> {
  const parsed = parsePartnerListQuery(
    new URLSearchParams({
      status: "PARTNER",
      ownerId: FIRST_ID.toUpperCase(),
      type: " Property_Manager ",
      q: "  Stonegate   North  ",
      limit: "50",
    }),
    new Date(SNAPSHOT_AT),
  );
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed;
}

describe("partner list query", () => {
  it("normalizes and strictly validates every filter", () => {
    const parsed = firstQuery().query;
    expect(parsed).toMatchObject({
      status: "partner",
      ownerId: FIRST_ID,
      type: "property_manager",
      q: "stonegate north",
      limit: 50,
      cursor: null,
    });
    expect(parsed.filterHash).toMatch(/^[0-9a-f]{64}$/u);

    for (const params of [
      new URLSearchParams("unknown=1"),
      new URLSearchParams("status=partner&status=inactive"),
      new URLSearchParams("status=customer"),
      new URLSearchParams("ownerId=not-a-uuid"),
      new URLSearchParams("limit=0"),
      new URLSearchParams("limit=101"),
      new URLSearchParams(`q=${"x".repeat(161)}`),
    ]) {
      expect(parsePartnerListQuery(params).ok).toBe(false);
    }
  });

  it("round-trips canonical opaque cursors and binds filters and page size", () => {
    const query = firstQuery().query;
    const encoded = encodePartnerCursor({
      version: 1,
      direction: "next",
      limit: query.limit,
      filterHash: query.filterHash,
      snapshotAt: SNAPSHOT_AT,
      totalAtSnapshot: 75,
      nextSort: "1786204800.123456",
      lastSort: "-1786118400.654321",
      id: FIRST_ID,
    });
    expect(decodePartnerCursor(encoded)).toMatchObject({
      direction: "next",
      totalAtSnapshot: 75,
      id: FIRST_ID,
    });

    const same = parsePartnerListQuery(
      new URLSearchParams({
        status: "partner",
        ownerId: FIRST_ID,
        type: "property_manager",
        q: "stonegate north",
        limit: "50",
        cursor: encoded,
      }),
      new Date(SNAPSHOT_AT),
    );
    expect(same.ok).toBe(true);
    expect(
      parsePartnerListQuery(
        new URLSearchParams({ status: "inactive", cursor: encoded }),
      ).ok,
    ).toBe(false);
    expect(
      parsePartnerListQuery(
        new URLSearchParams({
          status: "partner",
          ownerId: FIRST_ID,
          type: "property_manager",
          q: "stonegate north",
          limit: "25",
          cursor: encoded,
        }),
      ).ok,
    ).toBe(false);
    expect(decodePartnerCursor(`${encoded}=`)).toBeNull();
  });

  it("rejects future snapshots and creates internally consistent page links", () => {
    const filterHash = partnerFilterHash({
      status: "partner",
      ownerId: null,
      type: null,
      q: null,
    });
    const page = buildPartnerPageMetadata({
      limit: 50,
      filterHash,
      snapshotAt: SNAPSHOT_AT,
      totalAtSnapshot: 52,
      position: "history",
      visible: [
        { nextSort: "1786204800", lastSort: "-20", id: FIRST_ID },
        { nextSort: "1786204800", lastSort: "-10", id: SECOND_ID },
      ],
      hasPrevious: true,
      hasNext: true,
    });
    expect(page.returned).toBe(2);
    expect(decodePartnerCursor(page.previousCursor!)).toMatchObject({
      direction: "previous",
      id: FIRST_ID,
    });
    expect(decodePartnerCursor(page.nextCursor!)).toMatchObject({
      direction: "next",
      id: SECOND_ID,
    });

    const future = encodePartnerCursor({
      version: 1,
      direction: "next",
      limit: 50,
      filterHash,
      snapshotAt: "2026-08-08T12:06:00.000Z",
      totalAtSnapshot: 2,
      nextSort: "1786204800",
      lastSort: "-10",
      id: SECOND_ID,
    });
    expect(
      parsePartnerListQuery(
        new URLSearchParams({ cursor: future }),
        new Date(SNAPSHOT_AT),
      ).ok,
    ).toBe(false);
  });
});

describe("partner list Site boundary", () => {
  const validPayload = () => {
    const filterHash = partnerFilterHash({
      status: "partner",
      ownerId: null,
      type: null,
      q: null,
    });
    const page = buildPartnerPageMetadata({
      limit: 50,
      filterHash,
      snapshotAt: SNAPSHOT_AT,
      totalAtSnapshot: 1,
      position: "start",
      visible: [{ nextSort: "1786204800", lastSort: "-20", id: FIRST_ID }],
      hasPrevious: false,
      hasNext: false,
    });
    return {
      ok: true,
      total: 1,
      limit: 50,
      page,
      partners: [
        {
          id: FIRST_ID,
          company: "Stonegate North",
          name: "Jane Partner",
          email: "jane@example.test",
          phone: "+14045550123",
          partnerStatus: "partner",
          partnerType: "property_manager",
          partnerOwnerMemberId: SECOND_ID,
          partnerOwnerName: "Owner",
          partnerSince: SNAPSHOT_AT,
          partnerLastTouchAt: null,
          partnerNextTouchAt: null,
          partnerReferralCount: 3,
          partnerLastReferralAt: null,
          version: SNAPSHOT_AT,
        },
      ],
    };
  };

  it("accepts complete request-matching receipts", () => {
    expect(
      parsePartnersResponse(validPayload(), {
        limit: 50,
        status: "partner",
        ownerId: null,
        type: "property_manager",
      }),
    ).not.toBeNull();
  });

  it("rejects malformed rows, counts, cursors, and versions", () => {
    const badCount = validPayload();
    badCount.total = 2;
    expect(parsePartnersResponse(badCount)).toBeNull();

    const badCursor = validPayload();
    badCursor.page.hasNext = true;
    expect(parsePartnersResponse(badCursor)).toBeNull();

    const badVersion = validPayload();
    badVersion.partners[0]!.version = "today";
    expect(parsePartnersResponse(badVersion)).toBeNull();

    const duplicate = validPayload();
    duplicate.page.returned = 2;
    duplicate.page.totalAtSnapshot = 2;
    duplicate.total = 2;
    duplicate.partners.push({ ...duplicate.partners[0]! });
    expect(parsePartnersResponse(duplicate)).toBeNull();

    expect(
      parsePartnersResponse(validPayload(), {
        limit: 25,
        status: "inactive",
        ownerId: SECOND_ID,
        type: "hybrid",
      }),
    ).toBeNull();
  });
});

describe("partner rates Site boundary", () => {
  const valid = () => ({
    ok: true,
    orgContactId: FIRST_ID,
    currency: "USD",
    active: true,
    version: SNAPSHOT_AT,
    precedence: {
      booking: "exact_partner_service_and_tier",
      missingRate: "no_quoted_amount",
    },
    items: [
      {
        id: SECOND_ID,
        serviceKey: "junk-removal",
        tierKey: "quarter",
        label: "Quarter load",
        amountCents: 15_000,
        sortOrder: 0,
        createdAt: SNAPSHOT_AT,
      },
    ],
  });

  it("accepts exact active and not-yet-created rate cards", () => {
    expect(parsePartnerRatesResponse(valid(), FIRST_ID)).not.toBeNull();
    expect(
      parsePartnerRatesResponse(
        {
          ...valid(),
          active: false,
          version: "none",
          items: [],
        },
        FIRST_ID,
      ),
    ).not.toBeNull();
  });

  it("rejects identity, precedence, version, tier, and duplicate mismatches", () => {
    const badId = valid();
    badId.orgContactId = SECOND_ID;
    expect(parsePartnerRatesResponse(badId, FIRST_ID)).toBeNull();

    const badPrecedence = valid();
    badPrecedence.precedence.missingRate = "fallback";
    expect(parsePartnerRatesResponse(badPrecedence, FIRST_ID)).toBeNull();

    const badVersion = valid();
    badVersion.version = "today";
    expect(parsePartnerRatesResponse(badVersion, FIRST_ID)).toBeNull();

    const badTier = valid();
    badTier.items[0]!.tierKey = "invented";
    expect(parsePartnerRatesResponse(badTier, FIRST_ID)).toBeNull();

    const duplicate = valid();
    duplicate.items.push({ ...duplicate.items[0]!, id: FIRST_ID });
    expect(parsePartnerRatesResponse(duplicate, FIRST_ID)).toBeNull();
  });
});

describe("partner portal-user Site boundary", () => {
  const valid = () => ({
    ok: true,
    organization: {
      id: FIRST_ID,
      partnerStatus: "inactive",
      version: SNAPSHOT_AT,
    },
    users: [
      {
        id: SECOND_ID,
        orgContactId: FIRST_ID,
        email: "portal@example.test",
        phone: null,
        phoneE164: null,
        name: "Portal User",
        active: false,
        passwordSetAt: null,
        createdAt: SNAPSHOT_AT,
        updatedAt: SNAPSHOT_AT,
      },
    ],
  });

  it("accepts an exact inactive-organization snapshot without hiding its state", () => {
    expect(parsePartnerPortalUsersResponse(valid(), FIRST_ID)).toMatchObject({
      organization: { partnerStatus: "inactive" },
      users: [{ active: false }],
    });
  });

  it("rejects wrong organizations, unknown fields, malformed dates, and duplicates", () => {
    const wrongOrganization = valid();
    wrongOrganization.organization.id = SECOND_ID;
    expect(
      parsePartnerPortalUsersResponse(wrongOrganization, FIRST_ID),
    ).toBeNull();

    const unknownField = valid() as ReturnType<typeof valid> & {
      count?: number;
    };
    unknownField.count = 1;
    expect(parsePartnerPortalUsersResponse(unknownField, FIRST_ID)).toBeNull();

    const malformedDate = valid();
    malformedDate.users[0]!.updatedAt = "today";
    expect(parsePartnerPortalUsersResponse(malformedDate, FIRST_ID)).toBeNull();

    const duplicate = valid();
    duplicate.users.push({ ...duplicate.users[0]!, id: FIRST_ID });
    expect(parsePartnerPortalUsersResponse(duplicate, FIRST_ID)).toBeNull();
  });
});
