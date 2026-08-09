import { expect, test } from "@playwright/test";
import { PARTNER_SESSION_COOKIE } from "../../../apps/site/src/lib/partner-session";
import {
  getAuditActor,
  restoreSettings,
  setSalesDefaultAssignee,
  type SettingSnapshot,
} from "./journey-fixtures";
import {
  cleanupPartnerBookingFixture,
  closePartnerBookingFixtures,
  createPartnerBookingFixture,
  findPartnerBookingByAppointmentId,
  findPartnerBookingForFixture,
  getPartnerBookingIntegritySnapshot,
} from "./partner-booking-fixtures";
import {
  clearTwilioMessages,
  setTwilioFakeScenario,
  waitForTwilioMessage,
} from "../support/twilio";

test.use({ storageState: "tests/e2e/storage/visitor.json" });

test.beforeEach(({ page: _page }, testInfo) => {
  test.skip(
    testInfo.project.name !== "chromium-1440-light",
    "The state-changing partner handoff runs once against its disposable fixture.",
  );
  testInfo.setTimeout(120_000);
});

test.afterAll(async () => {
  await closePartnerBookingFixtures();
});

test("partner booking handoff is replay-safe, atomically rescheduled, audited, and cancelable", async ({
  page,
  request,
  baseURL,
}) => {
  if (!baseURL) throw new Error("The audit Site base URL is required.");
  const fixture = await createPartnerBookingFixture();
  const owner = await getAuditActor();
  let salesSetting: SettingSnapshot | null = null;
  try {
    salesSetting = await setSalesDefaultAssignee(owner.memberId);
    await clearTwilioMessages();
    await setTwilioFakeScenario("success");
    const siteUrl = new URL(baseURL);
    await page.context().addCookies([
      {
        name: PARTNER_SESSION_COOKIE,
        value: fixture.sessionToken,
        domain: siteUrl.hostname,
        path: "/",
        httpOnly: true,
        secure: siteUrl.protocol === "https:",
        sameSite: "Lax",
      },
    ]);

    await page.goto(
      `/partners/book?propertyId=${fixture.propertyId}&serviceKey=junk-removal`,
    );
    await expect(
      page.getByRole("heading", { name: "Book service" }),
    ).toBeVisible();
    const bookingForm = page
      .locator(
        'form:has(input[name="operationKey"]):has(input[name="preferredDate"])',
      )
      .last();
    const operationKey = await bookingForm
      .locator('input[name="operationKey"]')
      .inputValue();
    const dateInput = bookingForm.locator('input[name="preferredDate"]');
    const preferredDate = await dateInput.getAttribute("min");
    if (!preferredDate)
      throw new Error("Partner booking minimum date missing.");
    const timeWindowId = await bookingForm
      .locator('select[name="timeWindowId"]')
      .inputValue();
    await bookingForm.locator('select[name="tierKey"]').selectOption("quarter");
    await dateInput.fill(preferredDate);
    await bookingForm
      .getByLabel("Notes (optional)")
      .fill(`E2E handoff ${fixture.marker}`);
    await bookingForm.getByRole("button", { name: "Confirm booking" }).click();
    await expect(page).toHaveURL(/\/partners\/bookings\?created=1/u);
    await expect(page.getByText("Booking created.")).toBeVisible();

    const booking = await expect
      .poll(() => findPartnerBookingForFixture(fixture), { timeout: 15_000 })
      .not.toBeNull()
      .then(() => findPartnerBookingForFixture(fixture));
    if (!booking) throw new Error("Partner booking was not persisted.");
    expect(["confirmed", "requested"]).toContain(booking.status);
    expect(booking.version).toBe(1);

    const apiBase = process.env["API_BASE_URL"] ?? "http://localhost:3001";
    const createBody = {
      propertyId: fixture.propertyId,
      serviceKey: "junk-removal",
      tierKey: "quarter",
      preferredDate,
      timeWindowId,
      notes: `E2E handoff ${fixture.marker}`,
    };
    const replay = await request.post(`${apiBase}/api/portal/bookings`, {
      headers: {
        Authorization: `Bearer ${fixture.sessionToken}`,
        "Content-Type": "application/json",
        "Idempotency-Key": operationKey,
      },
      data: createBody,
    });
    expect(replay.status()).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      ok: true,
      appointmentId: booking.appointmentId,
      version: 1,
      receipt: { replay: true },
    });
    const conflict = await request.post(`${apiBase}/api/portal/bookings`, {
      headers: {
        Authorization: `Bearer ${fixture.sessionToken}`,
        "Content-Type": "application/json",
        "Idempotency-Key": operationKey,
      },
      data: { ...createBody, notes: "Conflicting replay" },
    });
    expect(conflict.status()).toBe(409);

    await expect
      .poll(
        async () =>
          (await findPartnerBookingForFixture(fixture))?.calendarEventId,
        {
          timeout: 20_000,
        },
      )
      .not.toBeNull();
    await expect
      .poll(
        async () =>
          (
            await getPartnerBookingIntegritySnapshot(
              fixture,
              booking.appointmentId,
            )
          ).createdAlertState,
        { timeout: 20_000 },
      )
      .toBe("succeeded");
    const staffCreateMessage = await waitForTwilioMessage(
      (message) =>
        message.to === "+14045551001" &&
        message.body.includes("New partner booking"),
    );
    expect(staffCreateMessage.body).toContain(fixture.marker);

    await page.reload();
    await page.getByRole("link", { name: "Reschedule" }).click();
    await expect(
      page.getByText(/moves your booking in one step/u),
    ).toBeVisible();
    const rescheduleForm = page
      .locator(
        'form:has(input[name="operationKey"]):has(input[name="rescheduleFromAppointmentId"])',
      )
      .last();
    const rescheduleOperationKey = await rescheduleForm
      .locator('input[name="operationKey"]')
      .inputValue();
    const rescheduleVersion = await rescheduleForm
      .locator('input[name="rescheduleFromVersion"]')
      .inputValue();
    await rescheduleForm
      .locator('select[name="tierKey"]')
      .selectOption("quarter");
    await rescheduleForm
      .locator('input[name="preferredDate"]')
      .fill(preferredDate);
    await rescheduleForm
      .getByLabel("Notes (optional)")
      .fill(`E2E atomic reschedule ${fixture.marker}`);
    await rescheduleForm
      .getByRole("button", { name: "Confirm reschedule" })
      .click();
    await expect(page).toHaveURL(/\/partners\/bookings\?rescheduled=1/u);
    await expect(page.getByText("Booking rescheduled.")).toBeVisible();

    await expect
      .poll(
        async () =>
          (await findPartnerBookingForFixture(fixture))?.appointmentId ?? null,
        { timeout: 15_000 },
      )
      .not.toBe(booking.appointmentId);
    const replacement = await findPartnerBookingForFixture(fixture);
    if (!replacement) throw new Error("Replacement booking was not persisted.");
    expect(replacement.version).toBe(1);
    await expect
      .poll(
        () => findPartnerBookingByAppointmentId(fixture, booking.appointmentId),
        { timeout: 15_000 },
      )
      .toMatchObject({ status: "canceled", version: 2 });

    const rescheduleBody = {
      ...createBody,
      notes: `E2E atomic reschedule ${fixture.marker}`,
      rescheduleFromAppointmentId: booking.appointmentId,
    };
    const rescheduleReplay = await request.post(
      `${apiBase}/api/portal/bookings`,
      {
        headers: {
          Authorization: `Bearer ${fixture.sessionToken}`,
          "Content-Type": "application/json",
          "Idempotency-Key": rescheduleOperationKey,
          "If-Match": rescheduleVersion,
        },
        data: rescheduleBody,
      },
    );
    expect(rescheduleReplay.status()).toBe(200);
    await expect(rescheduleReplay.json()).resolves.toMatchObject({
      ok: true,
      appointmentId: replacement.appointmentId,
      rescheduledFromAppointmentId: booking.appointmentId,
      rescheduledFromVersion: 1,
      receipt: { replay: true },
    });
    const rescheduleConflict = await request.post(
      `${apiBase}/api/portal/bookings`,
      {
        headers: {
          Authorization: `Bearer ${fixture.sessionToken}`,
          "Content-Type": "application/json",
          "Idempotency-Key": rescheduleOperationKey,
          "If-Match": rescheduleVersion,
        },
        data: { ...rescheduleBody, notes: "Conflicting reschedule replay" },
      },
    );
    expect(rescheduleConflict.status()).toBe(409);
    await waitForTwilioMessage(
      (message) =>
        message.to === "+14045551001" &&
        message.body.includes("Partner booking rescheduled"),
    );

    await page.reload();
    const cancelForm = page
      .locator(
        `form:has(input[name="appointmentId"][value="${replacement.appointmentId}"])`,
      )
      .first();
    const cancelOperationKey = await cancelForm
      .locator('input[name="operationKey"]')
      .inputValue();
    const cancelVersion = await cancelForm
      .locator('input[name="version"]')
      .inputValue();
    page.once("dialog", (dialog) => dialog.accept());
    await cancelForm.getByRole("button", { name: "Cancel booking" }).click();
    await expect(page).toHaveURL(/\/partners\/bookings\?canceled=1/u);
    await expect(page.getByText("Booking canceled.")).toBeVisible();

    const cancelReplay = await request.post(
      `${apiBase}/api/portal/bookings/${replacement.appointmentId}/cancel`,
      {
        headers: {
          Authorization: `Bearer ${fixture.sessionToken}`,
          "Content-Type": "application/json",
          "Idempotency-Key": cancelOperationKey,
          "If-Match": cancelVersion,
        },
        data: {},
      },
    );
    expect(cancelReplay.status()).toBe(200);
    await expect(cancelReplay.json()).resolves.toMatchObject({
      ok: true,
      status: "canceled",
      version: 2,
      receipt: { replay: true },
    });

    const lateRescheduleReplay = await request.post(
      `${apiBase}/api/portal/bookings`,
      {
        headers: {
          Authorization: `Bearer ${fixture.sessionToken}`,
          "Content-Type": "application/json",
          "Idempotency-Key": rescheduleOperationKey,
          "If-Match": rescheduleVersion,
        },
        data: rescheduleBody,
      },
    );
    expect(lateRescheduleReplay.status()).toBe(200);
    await expect(lateRescheduleReplay.json()).resolves.toMatchObject({
      ok: true,
      appointmentId: replacement.appointmentId,
      status: replacement.status,
      version: 1,
      receipt: { replay: true },
    });

    await expect
      .poll(
        async () =>
          (
            await getPartnerBookingIntegritySnapshot(
              fixture,
              replacement.appointmentId,
            )
          ).canceledAlertState,
        { timeout: 20_000 },
      )
      .toBe("succeeded");
    await waitForTwilioMessage(
      (message) =>
        message.to === "+14045551001" &&
        message.body.includes("Partner booking canceled"),
    );
    await expect
      .poll(() => findPartnerBookingForFixture(fixture), { timeout: 20_000 })
      .toMatchObject({
        appointmentId: replacement.appointmentId,
        status: "canceled",
        version: 2,
        calendarEventId: null,
      });
    const integrity = await getPartnerBookingIntegritySnapshot(
      fixture,
      replacement.appointmentId,
    );
    expect(integrity).toMatchObject({
      bookingCount: 2,
      createdAuditCount: 0,
      rescheduledAuditCount: 1,
      canceledAuditCount: 1,
      createdAlertState: "succeeded",
      canceledAlertState: "succeeded",
      createdAlertAttempts: 1,
      canceledAlertAttempts: 1,
      confirmationMessages: 2,
      rescheduleMessages: 2,
      cancellationMessages: 2,
    });
  } finally {
    if (salesSetting) await restoreSettings([salesSetting]);
    await cleanupPartnerBookingFixture(fixture);
  }
});
