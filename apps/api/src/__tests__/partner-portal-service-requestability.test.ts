import { partnerServiceRequestability } from "@/lib/partner-service-requestability";
import { partnerJobContact } from "@/lib/partner-job-contact";
import { parsePartnerJobDateBoundary } from "@/lib/partner-job-date-filter";

describe("partner service requests and job records", () => {
  it("always permits a general review request unless Stonegate explicitly disables it", () => {
    expect(partnerServiceRequestability({}, "service_request")).toEqual({
      disabled: false,
      reviewAllowed: true,
    });
    expect(
      partnerServiceRequestability(
        { disabledServiceKeys: ["service_request"] },
        "service_request",
      ),
    ).toEqual({ disabled: true, reviewAllowed: false });
  });
  it("explicit requestability never overrides a disable and does not enable other services", () => {
    expect(
      partnerServiceRequestability(
        { requestableServiceKeys: ["junk_removal"] },
        "junk_removal",
      ).reviewAllowed,
    ).toBe(true);
    expect(
      partnerServiceRequestability(
        {
          requestableServiceKeys: ["junk_removal"],
          disabledServiceKeys: ["junk_removal"],
        },
        "junk_removal",
      ).reviewAllowed,
    ).toBe(false);
    expect(partnerServiceRequestability({}, "junk_removal").reviewAllowed).toBe(
      false,
    );
  });
  it("keeps the selected job contact instead of silently changing it with the saved location", () => {
    expect(
      partnerJobContact(
        {
          onSiteContact: {
            name: "Job contact",
            email: "job@example.test",
            secret: "omit",
          },
        },
        { name: "New site contact" },
      ),
    ).toEqual({ name: "Job contact", email: "job@example.test" });
    expect(
      partnerJobContact({ onSiteContact: null }, { name: "New site contact" }),
    ).toBeNull();
    expect(partnerJobContact({}, { name: "Legacy fallback" })).toEqual({
      name: "Legacy fallback",
    });
  });
  it("filters a local service day through the next midnight including DST changes", () => {
    expect(
      parsePartnerJobDateBoundary("2026-09-08", false)?.toISOString(),
    ).toBe("2026-09-08T04:00:00.000Z");
    expect(parsePartnerJobDateBoundary("2026-09-08", true)?.toISOString()).toBe(
      "2026-09-09T04:00:00.000Z",
    );
    expect(
      parsePartnerJobDateBoundary("2026-03-08", false)?.toISOString(),
    ).toBe("2026-03-08T05:00:00.000Z");
    expect(parsePartnerJobDateBoundary("2026-03-08", true)?.toISOString()).toBe(
      "2026-03-09T04:00:00.000Z",
    );
    expect(parsePartnerJobDateBoundary("2026-11-01", true)?.toISOString()).toBe(
      "2026-11-02T05:00:00.000Z",
    );
    expect(() => parsePartnerJobDateBoundary("2026-02-30", false)).toThrow();
    expect(() =>
      parsePartnerJobDateBoundary("2026-09-08T12:00:00", false),
    ).toThrow();
  });
});
