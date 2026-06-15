import { __etaAgentTest, parseCrewEtaText } from "@/lib/eta-agent";

describe("eta-agent", () => {
  it("parses common crew status texts", () => {
    expect(parseCrewEtaText("on site")).toEqual({
      status: "on_site",
      ambiguous: false,
    });
    expect(parseCrewEtaText("need to dump before next")).toEqual({
      status: "need_dump",
      ambiguous: false,
    });
    expect(parseCrewEtaText("done")).toEqual({
      status: "finished",
      ambiguous: false,
    });
  });

  it("marks unclear crew text as ambiguous", () => {
    expect(parseCrewEtaText("ok cool")).toEqual({
      status: null,
      ambiguous: true,
    });
  });

  it("calculates location freshness from the configured threshold", () => {
    process.env["TRACCAR_LOCATION_FRESHNESS_MINUTES"] = "10";
    const now = new Date("2026-06-13T16:00:00.000Z");
    expect(__etaAgentTest.getFreshness(new Date("2026-06-13T15:55:00.000Z"), now)).toBe("fresh");
    expect(__etaAgentTest.getFreshness(new Date("2026-06-13T15:40:00.000Z"), now)).toBe("stale");
    expect(__etaAgentTest.getFreshness(null, now)).toBe("missing");
  });

  it("uses schedule-based wording when GPS is missing", async () => {
    const draft = await __etaAgentTest.computeDraft(
      {
        appointmentId: "appt",
        contactId: "contact",
        contactName: "Jane Customer",
        contactPhone: "+15555550123",
        propertyLat: null,
        propertyLng: null,
        address: "1 Main St",
        startAt: new Date("2026-06-13T18:00:00.000Z"),
        durationMinutes: 60,
        travelBufferMinutes: 30,
        crewLabel: "Crew A",
        teamMemberId: null,
      },
      "running_behind",
      {
        pingId: null,
        lat: null,
        lng: null,
        fixAt: null,
        freshness: "missing",
      },
    );

    expect(draft?.confidence).toBe("low");
    expect(draft?.locationFreshness).toBe("missing");
    expect(draft?.body).toContain("based on the schedule");
  });
});
