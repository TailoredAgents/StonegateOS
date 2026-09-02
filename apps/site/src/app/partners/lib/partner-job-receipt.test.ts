import assert from "node:assert/strict";
import test from "node:test";
import { createPartnerJobCalendarFile } from "./partner-job-receipt";

const BASE = {
  jobId: "55f64d58-0d21-4978-a0e1-4fd47c95b85b",
  serviceLabel: "Commercial pickup",
  locationLabel: "100 Main St, Marietta, GA 30060",
  startAt: "2026-09-02T13:00:00.000Z",
  endAt: "2026-09-02T15:00:00.000Z",
  portalUrl:
    "https://stonegate.example/partners/bookings/55f64d58-0d21-4978-a0e1-4fd47c95b85b?created=1#receipt",
  generatedAt: new Date("2026-09-01T12:00:00.000Z"),
} as const;

void test("creates a confirmed two-hour calendar receipt without query data", () => {
  const file = createPartnerJobCalendarFile({ ...BASE, status: "confirmed" });
  assert.equal(file.filename, "stonegate-job-55f64d58.ics");
  assert.match(file.content, /DTSTART:20260902T130000Z\r\n/u);
  assert.match(file.content, /DTEND:20260902T150000Z\r\n/u);
  assert.match(file.content, /STATUS:CONFIRMED\r\n/u);
  assert.match(file.content, /Confirmed two-hour arrival window/u);
  assert.doesNotMatch(file.content, /created=1|#receipt/u);
});

void test("labels review-only requested windows as tentative and escapes calendar text", () => {
  const file = createPartnerJobCalendarFile({
    ...BASE,
    serviceLabel: "Pickup, paint; tires",
    locationLabel: "Unit 2\nLoading dock",
    status: "tentative",
  });
  assert.match(file.content, /STATUS:TENTATIVE/u);
  assert.match(file.content, /Tentative Stonegate Pickup\\, paint\\; tires/u);
  assert.match(file.content, /LOCATION:Unit 2\\nLoading dock/u);
  assert.match(file.content, /Requested window only—/u);
});

void test("rejects invalid windows, references, and non-web portal URLs", () => {
  assert.throws(() =>
    createPartnerJobCalendarFile({
      ...BASE,
      endAt: BASE.startAt,
      status: "confirmed",
    }),
  );
  assert.throws(() =>
    createPartnerJobCalendarFile({
      ...BASE,
      jobId: "../../private",
      status: "confirmed",
    }),
  );
  assert.throws(() =>
    createPartnerJobCalendarFile({
      ...BASE,
      portalUrl: "javascript:alert(1)",
      status: "confirmed",
    }),
  );
});
