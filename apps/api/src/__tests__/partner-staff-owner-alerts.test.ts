import { ownerRequestSms } from "@/lib/partner-owner-alerts";

const groupId = "33333333-3333-4333-8333-333333333333";
const baseUrl = "https://staff.example.test";
function job(index = 1) {
  return {
    id: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
    accountName: "Sample Bakery",
    accountId: "22222222-2222-4222-8222-222222222222",
    serviceKey: "facility_cleanout",
    requesterName: "Morgan Requester",
    scopeSnapshot: {
      serviceLabel: "Facility cleanout",
      description: `Remove shelving from section ${index}.`,
      preferredWindows: [
        {
          localDate: "2026-10-03",
          timeOfDay: "afternoon",
          timezone: "America/New_York",
        },
      ],
      locationSnapshot: {
        name: "Bakery warehouse",
        timezone: "America/New_York",
        address: {
          line1: "100 Sample Road",
          line2: "Private suite detail",
          city: "Atlanta",
          state: "GA",
          postalCode: "30301",
        },
        accessSecretCiphertext: "PRIVATE-CIPHERTEXT-DO-NOT-SEND",
        accessSecret: "PRIVATE-LOCATION-PIN",
      },
      onSiteContact: {
        name: "PRIVATE-CONTACT-NAME",
        phone: "+14045550123",
        email: "private-contact@example.test",
      },
      commercial: { billingContact: { email: "private-billing@example.test" } },
      accessDetails: "PRIVATE-ARRIVAL-INSTRUCTIONS",
      crewInstructions: "PRIVATE-CREW-INSTRUCTIONS",
      media: {
        url: "https://storage.example.test/private?signature=PRIVATE-SIGNATURE",
      },
    },
  };
}
function link(body: string) {
  const finalLine = body.split("\n").at(-1)!;
  expect(finalLine.startsWith("Review: ")).toBe(true);
  return new URL(finalLine.slice("Review: ".length));
}

describe("partner owner request SMS summary", () => {
  it("includes useful plain request details and an authenticated CRM group link without copying private payloads", () => {
    const body = ownerRequestSms({
      jobs: [job()],
      groupId,
      reminder: false,
      baseUrl,
    });
    expect(body).toContain("Sample Bakery (1)");
    expect(body).toContain("Who: Morgan Requester");
    expect(body).toContain(
      "What: Facility cleanout: Remove shelving from section 1.",
    );
    expect(body).toContain("2026-10-03 afternoon America/New_York");
    expect(body).toContain("Awaiting Stonegate confirmation.");
    expect(body).toContain("100 Sample Road, Atlanta, GA");
    for (const privateValue of [
      "PRIVATE-",
      "+14045550123",
      "private-contact@example.test",
      "private-billing@example.test",
      "storage.example.test",
      "Private suite detail",
      "accessSecret",
      "scopeSnapshot",
    ])
      expect(body).not.toContain(privateValue);
    const target = link(body);
    expect(target.origin).toBe(baseUrl);
    expect(target.pathname).toBe("/team/partners");
    expect([...target.searchParams.entries()]).toEqual([
      ["p_admin", "requests"],
      ["p_alert", groupId],
      ["p_request", `service:${job().id}`],
      ["p_company", job().accountId],
    ]);
    expect(target.searchParams.has("token")).toBe(false);
  });

  it("summarizes a batch once with its total and a bounded preview of three requests", () => {
    const body = ownerRequestSms({
      jobs: Array.from({ length: 5 }, (_, index) => job(index + 1)),
      groupId,
      reminder: false,
      baseUrl,
    });
    expect(body).toContain("Sample Bakery (5)");
    expect(body).toContain("section 1");
    expect(body).toContain("section 3");
    expect(body).not.toContain("section 4");
    expect(body).toContain("Plus 2 more requests.");
    expect(body.match(/Review: /gu)).toHaveLength(1);
    expect(link(body).searchParams.has("p_request")).toBe(false);
    expect(link(body).searchParams.has("p_company")).toBe(false);
    expect(link(body).searchParams.get("p_alert")).toBe(groupId);
  });

  it("keeps a one-ready-job bulk alert linked to its complete group", () => {
    const target = link(
      ownerRequestSms({
        jobs: [job()],
        groupId,
        reminder: false,
        baseUrl,
        bulk: true,
      }),
    );
    expect([...target.searchParams.entries()]).toEqual([
      ["p_admin", "requests"],
      ["p_alert", groupId],
    ]);
  });

  it("keeps reminder wording distinct without implying a confirmed appointment", () => {
    const body = ownerRequestSms({
      jobs: [job()],
      groupId,
      reminder: true,
      baseUrl,
    });
    expect(body).toMatch(/^Reminder: /u);
    expect(body).toContain("Awaiting Stonegate confirmation.");
    expect(body).not.toMatch(/appointment (?:is )?confirmed/iu);
    expect(link(body).searchParams.get("p_alert")).toBe(groupId);
  });

  it("collapses injected control characters and whitespace inside public values", () => {
    const candidate = job();
    candidate.accountName = "Sample\r\n\tBakery\u0000";
    candidate.scopeSnapshot.description =
      "Remove\r\nshelving\t carefully.\u0007";
    const body = ownerRequestSms({
      jobs: [candidate],
      groupId,
      reminder: false,
      baseUrl,
    });
    expect(body).toContain("Sample Bakery (1)");
    expect(body).toContain("Remove shelving carefully.");
    for (const code of [0, 7, 9, 13])
      expect(body).not.toContain(String.fromCharCode(code));
    expect(body.split("\n")).toHaveLength(6);
  });

  it("bounds long previews while retaining the complete actionable link", () => {
    const jobs = Array.from({ length: 100 }, (_, index) => ({
      ...job(index + 1),
      accountName: "C".repeat(500),
      scopeSnapshot: {
        serviceLabel: "S".repeat(500),
        description: "D".repeat(8000),
        preferredWindows: [
          {
            localDate: "2026-10-03",
            timeOfDay: "afternoon",
            timezone: "America/New_York",
          },
        ],
        locationSnapshot: {
          address: {
            line1: "A".repeat(500),
            city: "T".repeat(500),
            state: "GA",
          },
        },
      },
    }));
    const body = ownerRequestSms({ jobs, groupId, reminder: false, baseUrl });
    const target = link(body);
    expect(target.searchParams.get("p_alert")).toBe(groupId);
    expect(body.length).toBeLessThanOrEqual(
      1200 + "\nReview: ".length + target.toString().length,
    );
    expect(body).not.toContain("D".repeat(121));
    expect(body).not.toContain("C".repeat(101));
  });

  it.each([
    null,
    [],
    "unexpected",
    { preferredWindows: [null, "invalid"], locationSnapshot: [] },
    { preferredWindows: { not: "an array" } },
  ])(
    "handles malformed optional legacy snapshot data without serializing objects: %j",
    (scopeSnapshot) => {
      const body = ownerRequestSms({
        jobs: [{ ...job(), scopeSnapshot }],
        groupId,
        reminder: false,
        baseUrl,
      });
      expect(body).not.toMatch(/undefined|null|\[object Object\]/u);
      expect(body).toContain("facility_cleanout");
      expect(link(body).pathname).toBe("/team/partners");
    },
  );
});
