import { parsePartnerOperationPayload } from "@/lib/partner-operations";

const CONTACT_ID = "11111111-1111-4111-8111-111111111111";
const MEMBER_ID = "22222222-2222-4222-8222-222222222222";

describe("partner operation input", () => {
  it("accepts a minimal referral and rejects hidden fields", () => {
    expect(
      parsePartnerOperationPayload("referral", { contactId: CONTACT_ID }),
    ).toMatchObject({
      contactId: CONTACT_ID,
      assignedToMemberId: null,
      explicitAt: null,
      daysFromNow: null,
    });
    expect(() =>
      parsePartnerOperationPayload("referral", {
        contactId: CONTACT_ID,
        count: 50,
      }),
    ).toThrow("unsupported partner fields");
  });

  it("normalizes valid check-in and touch scheduling inputs", () => {
    expect(
      parsePartnerOperationPayload("checkin", {
        contactId: CONTACT_ID.toUpperCase(),
        assignedToMemberId: MEMBER_ID.toUpperCase(),
        daysFromNow: 7,
      }),
    ).toMatchObject({
      contactId: CONTACT_ID,
      assignedToMemberId: MEMBER_ID,
      daysFromNow: 7,
      explicitAt: null,
    });
    expect(
      parsePartnerOperationPayload("touch", {
        contactId: CONTACT_ID,
        nextTouchAt: "2026-09-01T13:00:00.000Z",
      }).explicitAt?.toISOString(),
    ).toBe("2026-09-01T13:00:00.000Z");
  });

  it("rejects ambiguous, malformed, and out-of-range schedules", () => {
    for (const payload of [
      { contactId: "not-a-contact", daysFromNow: 7 },
      { contactId: CONTACT_ID, daysFromNow: 0 },
      { contactId: CONTACT_ID, daysFromNow: 366 },
      { contactId: CONTACT_ID, daysFromNow: 1.5 },
      { contactId: CONTACT_ID, assignedToMemberId: "someone" },
      {
        contactId: CONTACT_ID,
        daysFromNow: 7,
        dueAt: "2026-09-01T13:00:00.000Z",
      },
      { contactId: CONTACT_ID, dueAt: "2026-09-01" },
    ]) {
      expect(() => parsePartnerOperationPayload("checkin", payload)).toThrow();
    }
  });

  it("does not coerce string numbers, arrays, or arbitrary objects", () => {
    expect(() =>
      parsePartnerOperationPayload("touch", {
        contactId: CONTACT_ID,
        nextTouchDays: "30",
      }),
    ).toThrow();
    expect(() => parsePartnerOperationPayload("touch", [])).toThrow();
    expect(() => parsePartnerOperationPayload("touch", null)).toThrow();
  });
});
