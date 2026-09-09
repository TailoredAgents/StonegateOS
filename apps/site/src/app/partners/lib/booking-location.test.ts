import { strict as assert } from "node:assert";
import { test } from "node:test";
import { toBookingLocation, sortBookingLocations } from "./booking-location";
import { formatPartnerArrivalWindow } from "./partner-arrival-window";
import type { PartnerLocation } from "./portal-v2";

void test("booking location retains safe defaults, contact, timezone and priority", () => {
  const location = toBookingLocation({
    id: "site-id",
    siteName: "Office",
    address: {
      line1: "Sample street",
      line2: "Unit 2",
      city: "Atlanta",
      state: "GA",
      postalCode: "30301",
    },
    timezone: "America/Chicago",
    serviceArea: { status: "verified" },
    portfolio: { isDefault: true, isFavorite: false },
    onSiteContact: {
      name: "Site contact",
      phone: "4045550100",
      email: "site@example.test",
    },
    access: {
      details: "Use loading entrance",
      parking: "Loading bay",
      loading: "Dock",
      hasSecret: true,
    },
  } as unknown as PartnerLocation);
  assert.equal(location.timezone, "America/Chicago");
  assert.equal(location.contact?.name, "Site contact");
  assert.match(location.accessDetails ?? "", /Loading bay/);
  assert.equal(JSON.stringify(location).includes("hasSecret"), false);
  assert.equal(
    sortBookingLocations([
      { ...location, id: "other", isDefault: false, isFavorite: true },
      location,
    ])[0]?.id,
    "site-id",
  );
});

void test("arrival label includes both ends in the service timezone", () => {
  const label = formatPartnerArrivalWindow({
    startAt: "2026-09-08T14:00:00Z",
    endAt: "2026-09-08T16:00:00Z",
    timezone: "America/New_York",
  });
  assert.match(label, /10:00 AM/);
  assert.match(label, /12:00 PM/);
  assert.equal(formatPartnerArrivalWindow(null), "Time to be confirmed");
});
