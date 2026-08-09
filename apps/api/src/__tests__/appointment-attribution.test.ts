import { validateActiveAppointmentAttribution } from "@/lib/appointment-attribution";

const SELLER = "00000000-0000-4000-8000-000000000001";
const CREW = "00000000-0000-4000-8000-000000000002";
const MARKETING = "00000000-0000-4000-8000-000000000003";

describe("appointment attribution eligibility", () => {
  it("accepts only when every attributed member is active", () => {
    expect(
      validateActiveAppointmentAttribution({
        activeMemberIds: new Set([SELLER, CREW, MARKETING]),
        soldByMemberId: SELLER,
        crewMemberIds: [CREW],
        marketingMemberId: MARKETING,
      }),
    ).toEqual({ ok: true });
  });

  it.each([
    {
      label: "seller",
      activeMemberIds: new Set([CREW, MARKETING]),
      expectedField: "soldByMemberId",
      expectedMemberId: SELLER,
    },
    {
      label: "crew",
      activeMemberIds: new Set([SELLER, MARKETING]),
      expectedField: "crewMembers",
      expectedMemberId: CREW,
    },
    {
      label: "marketing",
      activeMemberIds: new Set([SELLER, CREW]),
      expectedField: "marketingMemberId",
      expectedMemberId: MARKETING,
    },
  ])(
    "rejects an inactive or missing $label member",
    ({ activeMemberIds, expectedField, expectedMemberId }) => {
      expect(
        validateActiveAppointmentAttribution({
          activeMemberIds,
          soldByMemberId: SELLER,
          crewMemberIds: [CREW],
          marketingMemberId: MARKETING,
        }),
      ).toEqual({
        ok: false,
        field: expectedField,
        memberId: expectedMemberId,
      });
    },
  );
});
