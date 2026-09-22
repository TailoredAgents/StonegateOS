import { createHash } from "node:crypto";
import { jest } from "@jest/globals";
import { contacts, leads, outboxEvents } from "@/db";
import {
  buildOpenAiAdsUser,
  captureOpenAiAdsAttribution,
  enqueueOpenAiAdsBooking,
  enqueueOpenAiAdsPhoneInquiry,
  findOpenAiAdsBookingLead,
  isOpenAiAdsPhoneInquiry,
  openAiAdsOutboxId,
} from "@/lib/openai-ads-capture";
import { parseOpenAiAdsEvent } from "@/lib/openai-ads";

const NOW = new Date("2026-09-15T16:00:00.000Z");
const granted = {
  consent: true,
  consentId: "a11ef688-8f1c-4810-9a48-0cfd6fb4dc67",
  oppref: "opaque-click_123-ABC",
  obref: "123e4567-e89b-42d3-a456-426614174000",
  sourceUrl:
    "https://stonegatejunkremoval.com/book?email=private@example.com#contact",
  capturedAt: NOW.toISOString(),
};
const booking = {
  appointmentId: "appointment-123",
  contactId: "contact-123",
  status: "confirmed",
  startAt: new Date("2026-09-17T16:00:00.000Z"),
  attribution: granted,
  now: NOW,
};
const call = {
  callSid: "CAchild",
  parentCallSid: "CAparent",
  contactId: "contact-123",
  phone: "+1 (415) 555-2671",
  direction: "inbound",
  status: "completed",
  duration: 45,
  answeredBy: "human",
  now: NOW,
};

function databaseFixture(attribution: unknown = granted) {
  const stored = new Map<
    string,
    {
      id: string;
      type: string;
      payload: Record<string, unknown>;
      createdAt: Date;
    }
  >();
  let failInsertion = false;
  const select = jest.fn(() => {
    let table: unknown;
    const query = {
      from: (value: unknown) => {
        table = value;
        return query;
      },
      where: () => query,
      orderBy: () => query,
      limit: () =>
        Promise.resolve(
          table === contacts
            ? [{ phone: "+14155552671", email: " CUSTOMER@Example.COM " }]
            : table === leads
              ? [{ formPayload: { openaiAds: attribution } }]
              : [],
        ),
    };
    return query;
  });
  const database = {
    select,
    insert: jest.fn((table: unknown) => {
      expect(table).toBe(outboxEvents);
      return {
        values: (value: {
          id: string;
          type: string;
          payload: Record<string, unknown>;
          createdAt: Date;
        }) => ({
          onConflictDoNothing: ({ target }: { target: unknown }) => {
            expect(target).toBe(outboxEvents.id);
            if (failInsertion)
              return Promise.reject(new Error("database_write_failed"));
            if (!stored.has(value.id)) stored.set(value.id, value);
            return Promise.resolve();
          },
        }),
      };
    }),
  } as unknown as Parameters<typeof enqueueOpenAiAdsBooking>[0];
  return {
    database,
    stored,
    select,
    rejectInsertion: () => {
      failInsertion = true;
    },
  };
}

describe("OpenAI ads attribution capture", () => {
  it("preserves the opaque click identifier while removing query PII and private quote tokens", () => {
    expect(captureOpenAiAdsAttribution(granted, NOW)).toEqual({
      ...granted,
      sourceUrl: "https://stonegatejunkremoval.com/book",
    });
    expect(
      captureOpenAiAdsAttribution(
        {
          ...granted,
          sourceUrl:
            "https://stonegatejunkremoval.com/quote/private-token?x=secret",
        },
        NOW,
      )?.sourceUrl,
    ).toBe("https://stonegatejunkremoval.com/");
  });

  it("retains denial without retaining identifiers or customer URL", () => {
    expect(
      captureOpenAiAdsAttribution({ ...granted, consent: false }, NOW),
    ).toEqual({ consent: false, capturedAt: NOW.toISOString() });
  });

  it.each([
    { ...granted, capturedAt: "2026-08-15T16:00:00.000Z" },
    { ...granted, capturedAt: "2026-09-16T16:00:00.000Z" },
  ])("rejects stale or future attribution", (value) => {
    expect(captureOpenAiAdsAttribution(value, NOW)).toBeUndefined();
  });

  it("accepts opaque non-UUID browser references and fails closed on malformed tracking", () => {
    expect(
      captureOpenAiAdsAttribution(
        { ...granted, obref: "opaque_browser_ref" },
        NOW,
      )?.obref,
    ).toBe("opaque_browser_ref");
    expect(
      captureOpenAiAdsAttribution(
        { ...granted, oppref: "bad\nidentifier" },
        NOW,
      )?.consent,
    ).toBe(false);
    expect(
      captureOpenAiAdsAttribution(
        { ...granted, consent: false, unknown: "extra" },
        NOW,
      )?.consent,
    ).toBe(false);
  });

  it("normalizes and hashes contact identifiers using the documented matching format", () => {
    const sha = (value: string) =>
      createHash("sha256").update(value).digest("hex");
    expect(
      buildOpenAiAdsUser({
        phone: "+1 (415) 555-2671",
        email: " CUSTOMER@Example.COM ",
      }),
    ).toEqual({
      phone_numbers_sha256: [sha("14155552671")],
      emails_sha256: [sha("customer@example.com")],
    });
    expect(buildOpenAiAdsUser({ phone: "anonymous" })).toEqual({});
  });
});

describe("confirmed booking conversion boundary", () => {
  it("links a manual booking only to the latest recent unconverted lead at that same customer/property", async () => {
    const candidate = {
      id: "eligible-lead",
      contactId: booking.contactId,
      propertyId: "property-123",
      createdAt: NOW,
      formPayload: { openaiAds: granted },
      hasServiceBooking: false,
    };
    const candidates = [
      { ...candidate, id: "converted-lead", hasServiceBooking: true },
      { ...candidate, id: "other-property", propertyId: "another-property" },
      { ...candidate, id: "other-customer", contactId: "another-customer" },
      {
        ...candidate,
        id: "stale-lead",
        createdAt: new Date("2026-08-01T00:00:00Z"),
      },
      candidate,
    ];
    const chain = {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      for: () => chain,
      limit: () => Promise.resolve(candidates),
    };
    const select = jest.fn(() => chain);
    const database = { select } as unknown as Parameters<
      typeof findOpenAiAdsBookingLead
    >[0];
    const context = {
      contactId: booking.contactId,
      propertyId: "property-123",
      now: NOW,
    };
    await expect(findOpenAiAdsBookingLead(database, context)).resolves.toBe(
      "eligible-lead",
    );
    select.mockClear();
    await expect(
      findOpenAiAdsBookingLead(database, {
        ...context,
        existingLeadId: "explicit-quote-lead",
      }),
    ).resolves.toBe("explicit-quote-lead");
    expect(select).not.toHaveBeenCalled();
    candidates.pop();
    await expect(
      findOpenAiAdsBookingLead(database, context),
    ).resolves.toBeNull();
  });
  it.each(["requested", "canceled", "no_show", "completed"])(
    "does not emit for %s appointments",
    async (status) => {
      const fixture = databaseFixture();
      await expect(
        enqueueOpenAiAdsBooking(fixture.database, { ...booking, status }),
      ).resolves.toBe(false);
      expect(fixture.select).not.toHaveBeenCalled();
      expect(fixture.stored.size).toBe(0);
    },
  );

  it("requires an actual reserved time and granted measurement", async () => {
    const fixture = databaseFixture();
    await expect(
      enqueueOpenAiAdsBooking(fixture.database, { ...booking, startAt: null }),
    ).resolves.toBe(false);
    await expect(
      enqueueOpenAiAdsBooking(fixture.database, {
        ...booking,
        attribution: { consent: false },
        leadId: "old-granted-lead",
      }),
    ).resolves.toBe(false);
    expect(fixture.stored.size).toBe(0);
  });

  it("queues one provider-valid event and preserves first event time across retries or reconfirmation", async () => {
    const fixture = databaseFixture();
    await expect(
      enqueueOpenAiAdsBooking(fixture.database, booking),
    ).resolves.toBe(true);
    await enqueueOpenAiAdsBooking(fixture.database, {
      ...booking,
      now: new Date(NOW.getTime() + 60_000),
    });
    expect(fixture.stored.size).toBe(1);
    const row = [...fixture.stored.values()][0]!;
    expect(row.id).toBe(openAiAdsOutboxId("booking:appointment-123"));
    expect(row.payload).toMatchObject({
      contactId: booking.contactId,
      appointmentId: booking.appointmentId,
      event: {
        id: "booking:appointment-123",
        type: "appointment_scheduled",
        timestamp_ms: NOW.getTime(),
        action_source: "web",
        oppref: granted.oppref,
        source_url: "https://stonegatejunkremoval.com/book",
        data: { type: "customer_action" },
      },
    });
    expect(parseOpenAiAdsEvent(row.payload["event"])).not.toBeNull();
    expect(JSON.stringify(row.payload)).not.toContain("customer@example.com");
    expect(JSON.stringify(row.payload)).not.toContain("14155552671");
  });

  it("uses saved attribution when staff confirms a lead and blocks a later denial", async () => {
    const fixture = databaseFixture();
    await expect(
      enqueueOpenAiAdsBooking(fixture.database, {
        ...booking,
        attribution: undefined,
        leadId: "lead-123",
      }),
    ).resolves.toBe(true);
    const denied = databaseFixture({
      consent: false,
      capturedAt: NOW.toISOString(),
    });
    await expect(
      enqueueOpenAiAdsBooking(denied.database, {
        ...booking,
        attribution: undefined,
        leadId: "lead-123",
      }),
    ).resolves.toBe(false);
    expect(denied.stored.size).toBe(0);
  });

  it("propagates queue persistence failure so its enclosing booking transaction can roll back", async () => {
    const fixture = databaseFixture();
    fixture.rejectInsertion();
    await expect(
      enqueueOpenAiAdsBooking(fixture.database, booking),
    ).rejects.toThrow("database_write_failed");
    expect(fixture.stored.size).toBe(0);
  });

  it("blocks an old explicit grant after newer denial, and requires a revocable consent identity", async () => {
    const fixture = databaseFixture({
      consent: false,
      capturedAt: NOW.toISOString(),
    });
    await expect(
      enqueueOpenAiAdsBooking(fixture.database, booking),
    ).resolves.toBe(false);
    await expect(
      enqueueOpenAiAdsBooking(fixture.database, {
        ...booking,
        attribution: {
          ...granted,
          capturedAt: new Date(NOW.getTime() + 1).toISOString(),
        },
      }),
    ).resolves.toBe(true);
    const missing = databaseFixture();
    await expect(
      enqueueOpenAiAdsBooking(missing.database, {
        ...booking,
        attribution: { ...granted, consentId: undefined },
      }),
    ).resolves.toBe(false);
    expect(missing.stored.size).toBe(0);
  });
});

describe("inbound phone inquiry conversion boundary", () => {
  it("requires connected-leg or explicit human evidence and does not count parent IVR time", () => {
    expect(
      isOpenAiAdsPhoneInquiry({ ...call, answeredBy: null, duration: 300 }),
    ).toBe(false);
    expect(
      isOpenAiAdsPhoneInquiry({
        ...call,
        answeredBy: null,
        dialCallStatus: "completed",
        dialCallDuration: 45,
        dialBridged: true,
      }),
    ).toBe(true);
    expect(
      isOpenAiAdsPhoneInquiry({
        ...call,
        answeredBy: null,
        dialCallStatus: "completed",
        dialCallDuration: 5,
        duration: 300,
      }),
    ).toBe(false);
    expect(
      isOpenAiAdsPhoneInquiry({
        ...call,
        answeredBy: null,
        dialCallStatus: "completed",
        dialCallDuration: 45,
        dialBridged: false,
      }),
    ).toBe(false);
  });
  it.each([
    { direction: "outbound" },
    { direction: "outbound-api" },
    { status: "ringing" },
    { status: "busy" },
    { status: "no-answer" },
    { duration: 29 },
    { answeredBy: "machine_start" },
    { answeredBy: "machine_end_beep" },
    { answeredBy: "fax" },
    { answeredBy: "voicemail" },
  ])(
    "excludes outbound, unsuccessful, short, and known machine calls",
    (patch) => {
      expect(isOpenAiAdsPhoneInquiry({ ...call, ...patch })).toBe(false);
    },
  );

  it("uses the configurable duration threshold", () => {
    const previous = process.env["OPENAI_ADS_PHONE_MIN_DURATION_SECONDS"];
    process.env["OPENAI_ADS_PHONE_MIN_DURATION_SECONDS"] = "60";
    try {
      expect(isOpenAiAdsPhoneInquiry(call)).toBe(false);
    } finally {
      if (previous === undefined)
        delete process.env["OPENAI_ADS_PHONE_MIN_DURATION_SECONDS"];
      else process.env["OPENAI_ADS_PHONE_MIN_DURATION_SECONDS"] = previous;
    }
  });

  it("deduplicates parent/child callbacks using the canonical call identity", async () => {
    const fixture = databaseFixture();
    await expect(
      enqueueOpenAiAdsPhoneInquiry(fixture.database, call),
    ).resolves.toBe("queued");
    await enqueueOpenAiAdsPhoneInquiry(fixture.database, {
      ...call,
      parentCallSid: null,
      callSid: "CAparent",
      now: new Date(NOW.getTime() + 1000),
    });
    expect(fixture.stored.size).toBe(1);
    const row = [...fixture.stored.values()][0]!;
    expect(row.payload).toMatchObject({
      event: {
        id: "phone:CAparent",
        type: "lead_created",
        action_source: "phone_call",
        timestamp_ms: NOW.getTime(),
      },
    });
    expect(parseOpenAiAdsEvent(row.payload["event"])).not.toBeNull();
  });

  it.each([
    undefined,
    { consent: false },
    { ...granted, capturedAt: "2026-08-01T16:00:00.000Z" },
  ])(
    "does not invent attribution or bypass absent, denied, or expired measurement context",
    async (attribution) => {
      const fixture = databaseFixture(null);
      if (attribution !== undefined) {
        const other = databaseFixture(attribution);
        await expect(
          enqueueOpenAiAdsPhoneInquiry(other.database, call),
        ).resolves.toBe("no_measurement_context");
        expect(other.stored.size).toBe(0);
      } else {
        await expect(
          enqueueOpenAiAdsPhoneInquiry(fixture.database, call),
        ).resolves.toBe("no_measurement_context");
        expect(fixture.stored.size).toBe(0);
      }
    },
  );
});
