import { readFile } from "node:fs/promises";
import { expect, test, type Page, type Request } from "@playwright/test";
import { PARTNER_SESSION_COOKIE } from "../../../apps/site/src/lib/partner-session";
import {
  cleanupPartnerApprovalFixture,
  cleanupPartnerBookingFixture,
  closePartnerBookingFixtures,
  configurePartnerApprovalFixture,
  createPartnerBookingFixture,
  findPartnerBookingForFixture,
  getPartnerApprovalLifecycleSnapshot,
  getPartnerPortalV2IntegritySnapshot,
  getPartnerReviewRequestSnapshot,
} from "./partner-booking-fixtures";

test.use({ storageState: "tests/e2e/storage/visitor.json" });

const BOOKING_SCOPE_LABEL =
  /What (?:needs to be done|should be completed at the facility)\?/u;

test.beforeEach(({ page: _page }, testInfo) => {
  test.skip(
    testInfo.project.name !== "chromium-1440-light",
    "The state-changing partner handoff runs once against its disposable fixture.",
  );
  testInfo.setTimeout(180_000);
});

test.afterAll(async () => {
  await closePartnerBookingFixtures();
});

async function replayMutation(
  page: Page,
  request: Request,
  origin: string,
  bodyOverride?: Record<string, unknown>,
) {
  const idempotencyKey = await request.headerValue("idempotency-key");
  const ifMatch = await request.headerValue("if-match");
  if (!idempotencyKey || !ifMatch) {
    throw new Error("Captured portal mutation omitted its safety headers.");
  }
  const originalBody = request.postDataJSON() as Record<string, unknown>;
  return page.request.post(request.url(), {
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
      "If-Match": ifMatch,
    },
    data: bodyOverride ?? originalBody,
  });
}

async function usePartnerSession(
  page: Page,
  baseURL: string,
  token: string,
): Promise<void> {
  const siteUrl = new URL(baseURL);
  await page.context().addCookies([
    {
      name: PARTNER_SESSION_COOKIE,
      value: token,
      domain: siteUrl.hostname,
      path: "/",
      httpOnly: true,
      secure: siteUrl.protocol === "https:",
      sameSite: "Lax",
    },
  ]);
}

test("Partner Portal V2 books, replays safely, reschedules atomically, and cancels with audit evidence", async ({
  page,
  baseURL,
}) => {
  if (!baseURL) throw new Error("The audit Site base URL is required.");
  const fixture = await createPartnerBookingFixture();
  const origin = new URL(baseURL).origin;
  try {
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
      `/partners/book?locationId=${fixture.locationId}&serviceKey=junk-removal`,
    );
    await expect(
      page.getByRole("heading", {
        name: "Request facility service",
        level: 1,
      }),
    ).toBeVisible();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Continue" }).click();
    await expect(
      page.getByRole("heading", { name: "Add service details" }),
    ).toBeVisible();
    await page
      .getByRole("textbox", { name: BOOKING_SCOPE_LABEL })
      .fill(
        `Remove staged office furniture and boxed material. E2E ${fixture.marker}`,
      );
    await page.getByLabel("PO / work order (optional)").fill("PO-E2E-1042");
    await page.getByLabel("Cost center (optional)").fill("TURN-OPS");
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(
      page.getByRole("heading", { name: "Confirm contact & access" }),
    ).toBeVisible();
    await page.getByLabel("On-site contact name").fill("E2E Site Lead");
    await page.getByLabel("Mobile phone").fill(fixture.partnerPhoneE164);
    await page
      .getByLabel("Access, parking, gate, or loading details (optional)")
      .fill("Use the marked loading area; call the site lead on arrival.");
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(
      page.getByRole("heading", { name: "Add photos & proof" }),
    ).toBeVisible();
    await page.getByLabel("Formal proof package").check();
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(
      page.getByRole("heading", { name: "Choose an arrival window" }),
    ).toBeVisible();
    const arrivalWindowButtons = page.locator("fieldset button[aria-pressed]");
    await expect(arrivalWindowButtons.first()).toBeVisible();
    // Use a later date so the 24-hour cancellation cutoff is unambiguous.
    await arrivalWindowButtons.last().click();
    await expect(page.getByText(/Arrival window held:/u)).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(
      page.getByRole("heading", { name: "Check & send" }),
    ).toBeVisible();
    await expect(page.getByText("PO-E2E-1042")).toBeVisible();
    const submitRequestPromise = page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        /\/api\/partners\/portal\/booking-drafts\/[0-9a-f-]+\/submit$/iu.test(
          new URL(request.url()).pathname,
        ),
    );
    await page.getByRole("button", { name: "Send service request" }).click();
    const submitRequest = await submitRequestPromise;
    await expect(page).toHaveURL(
      /\/partners\/bookings\/[0-9a-f-]+\?created=1$/iu,
    );

    const jobId = new URL(page.url()).pathname.split("/").at(-1);
    if (!jobId) throw new Error("Partner job identifier missing after submit.");
    await expect(
      page.getByText("Confirmed", { exact: true }).first(),
    ).toBeVisible();
    await expect(page.getByText("PO-E2E-1042")).toBeVisible();
    const calendarDownloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Add to calendar" }).click();
    const calendarDownload = await calendarDownloadPromise;
    expect(calendarDownload.suggestedFilename()).toBe(
      `stonegate-job-${jobId.slice(0, 8)}.ics`,
    );
    const calendarPath = await calendarDownload.path();
    if (!calendarPath) throw new Error("Calendar receipt download is missing.");
    const calendarContent = await readFile(calendarPath, "utf8");
    expect(calendarContent).toContain("STATUS:CONFIRMED");
    expect(calendarContent).toContain("Confirmed two-hour arrival window");
    expect(calendarContent).not.toContain("?created=1");

    const initialBooking = await expect
      .poll(() => findPartnerBookingForFixture(fixture), { timeout: 20_000 })
      .not.toBeNull()
      .then(() => findPartnerBookingForFixture(fixture));
    if (!initialBooking) throw new Error("Partner booking was not persisted.");
    expect(initialBooking).toMatchObject({
      bookingId: jobId,
      status: "confirmed",
      version: 1,
    });
    await expect(page.locator("body")).not.toContainText(
      initialBooking.appointmentId,
    );

    const submitReplay = await replayMutation(page, submitRequest, origin);
    expect(submitReplay.status()).toBe(200);
    const submitReplayBody = await submitReplay.json();
    expect(submitReplayBody).toMatchObject({
      ok: true,
      replayed: true,
      booking: { id: jobId, publicStatus: "confirmed" },
    });
    expect(JSON.stringify(submitReplayBody)).not.toContain(
      initialBooking.appointmentId,
    );
    expect(submitReplayBody.booking).not.toHaveProperty("appointmentId");
    expect(submitReplayBody.booking).not.toHaveProperty("startAt");
    const submitBody = submitRequest.postDataJSON() as Record<string, unknown>;
    const submitConflict = await replayMutation(page, submitRequest, origin, {
      ...submitBody,
      holdId: "00000000-0000-4000-8000-000000000099",
    });
    expect(submitConflict.status()).toBe(409);

    await page.getByRole("link", { name: "Change schedule" }).click();
    await expect(
      page.getByRole("heading", { name: "Change arrival window", level: 1 }),
    ).toBeVisible();
    const arrivalWindows = page.locator("button[aria-pressed]");
    await expect(arrivalWindows.first()).toBeVisible();
    await arrivalWindows.last().click();
    await expect(page.getByText("Selected arrival window")).toBeVisible();
    const rescheduleRequestPromise = page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        new URL(request.url()).pathname.endsWith(`/jobs/${jobId}/reschedule`),
    );
    await page.getByRole("button", { name: "Confirm schedule change" }).click();
    const rescheduleRequest = await rescheduleRequestPromise;
    await expect(
      page.getByRole("heading", { name: "New schedule confirmed" }),
    ).toBeVisible();

    const rescheduled = await expect
      .poll(() => findPartnerBookingForFixture(fixture), { timeout: 20_000 })
      .toMatchObject({ bookingId: jobId, status: "confirmed", version: 2 })
      .then(() => findPartnerBookingForFixture(fixture));
    if (!rescheduled) throw new Error("Rescheduled booking was not persisted.");
    expect(rescheduled.appointmentId).toBe(initialBooking.appointmentId);

    const rescheduleReplay = await replayMutation(
      page,
      rescheduleRequest,
      origin,
    );
    expect(rescheduleReplay.status()).toBe(200);
    const rescheduleReplayBody = await rescheduleReplay.json();
    expect(rescheduleReplayBody).toMatchObject({
      ok: true,
      reschedule: { mode: "instant", jobId },
    });
    expect(JSON.stringify(rescheduleReplayBody)).not.toContain(
      rescheduled.appointmentId,
    );
    expect(rescheduleReplayBody.reschedule).not.toHaveProperty("appointmentId");
    expect(rescheduleReplayBody.reschedule).not.toHaveProperty("startAt");

    await page.getByRole("link", { name: "View updated job" }).click();
    await page.getByText("Cancel this job", { exact: true }).click();
    await page
      .getByLabel("Reason for cancellation")
      .fill("Project schedule changed after the site walkthrough.");
    const cancelRequestPromise = page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        new URL(request.url()).pathname.endsWith(`/jobs/${jobId}/cancel`),
    );
    await page.getByRole("button", { name: "Confirm cancellation" }).click();
    const cancelRequest = await cancelRequestPromise;
    await expect(page.getByText("The job was canceled.")).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Add to calendar" }),
    ).toHaveCount(0);

    await expect
      .poll(() => findPartnerBookingForFixture(fixture), { timeout: 20_000 })
      .toMatchObject({
        bookingId: jobId,
        appointmentId: initialBooking.appointmentId,
        status: "canceled",
        version: 3,
      });
    const cancelReplay = await replayMutation(page, cancelRequest, origin);
    expect(cancelReplay.status()).toBe(200);
    await expect(cancelReplay.json()).resolves.toMatchObject({
      ok: true,
      cancellation: { outcome: "canceled" },
      job: { id: jobId, status: "canceled", revision: 3 },
    });
    expect(cancelReplay.headers()["idempotency-replayed"]).toBe("true");

    await expect
      .poll(() => getPartnerPortalV2IntegritySnapshot(fixture, jobId), {
        timeout: 20_000,
      })
      .toMatchObject({
        submittedAudits: 1,
        rescheduledAudits: 1,
        canceledAudits: 1,
        submittedEvents: 1,
        rescheduledEvents: 1,
        canceledEvents: 1,
      });
    const integrity = await getPartnerPortalV2IntegritySnapshot(fixture, jobId);
    expect(integrity.scheduleOutboxEvents).toBeGreaterThanOrEqual(2);

    await page.goto(
      `/partners/book?locationId=${fixture.locationId}&serviceKey=junk_removal_primary`,
    );
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(
      page.getByRole("heading", { name: "Add service details" }),
    ).toBeVisible();
    await page
      .getByRole("textbox", { name: BOOKING_SCOPE_LABEL })
      .fill(`Reviewed demo haul-off request. E2E ${fixture.marker}`);
    await page
      .getByRole("checkbox", {
        name: /Potentially restricted or special-handling material/iu,
      })
      .check();
    await page
      .locator("#partner-book-billing-name")
      .fill("E2E Accounts Payable");
    await page
      .locator("#partner-book-billing-email")
      .fill(`billing+${fixture.marker}@mystos.test`);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByLabel("On-site contact name").fill("E2E Review Lead");
    await page.getByLabel("Mobile phone").fill(fixture.partnerPhoneE164);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(
      page.getByRole("heading", { name: "Add photos & proof" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(
      page.getByRole("heading", { name: "Choose an arrival window" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Request a reviewed schedule" }),
    ).toBeVisible();
    const preferredDate = new Date(Date.now() + 5 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    await page.getByLabel("First choice").fill(preferredDate);
    await page.getByLabel("General time preference").selectOption("morning");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(
      page.getByRole("heading", { name: "Check & send" }),
    ).toBeVisible();
    await expect(
      page.getByText(/review request only.*without reserving capacity/iu),
    ).toBeVisible();
    await expect(page.getByText("E2E Accounts Payable")).toBeVisible();
    const reviewSubmitRequestPromise = page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        /\/api\/partners\/portal\/booking-drafts\/[0-9a-f-]+\/submit$/iu.test(
          new URL(request.url()).pathname,
        ),
    );
    await page.getByRole("button", { name: "Send service request" }).click();
    const reviewSubmitRequest = await reviewSubmitRequestPromise;
    await expect(page).toHaveURL(
      /\/partners\/bookings\/[0-9a-f-]+\?created=1$/iu,
    );
    const reviewJobId = new URL(page.url()).pathname.split("/").at(-1);
    if (!reviewJobId) throw new Error("Review job identifier is missing.");
    await expect(
      page.getByText("Under Review", { exact: true }).first(),
    ).toBeVisible();
    await expect(page.getByText(/Morning.*Not reserved/iu)).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Add to calendar" }),
    ).toHaveCount(0);

    const reviewSnapshot = await expect
      .poll(() => getPartnerReviewRequestSnapshot(fixture, reviewJobId), {
        timeout: 20_000,
      })
      .toMatchObject({
        publicStatus: "under_review",
        confirmationMode: "review",
        appointmentStartAt: null,
        promisedArrivalStartAt: null,
        promisedArrivalEndAt: null,
        bookingArrivalStartAt: null,
        bookingArrivalEndAt: null,
        reviewAuditCount: 1,
        calendarOutboxCount: 0,
      })
      .then(() => getPartnerReviewRequestSnapshot(fixture, reviewJobId));
    expect(reviewSnapshot.preferredWindows).toEqual([
      {
        localDate: preferredDate,
        timeOfDay: "morning",
        timezone: "America/New_York",
      },
    ]);
    const reviewReplay = await replayMutation(
      page,
      reviewSubmitRequest,
      origin,
    );
    expect(reviewReplay.status()).toBe(200);
    await expect(reviewReplay.json()).resolves.toMatchObject({
      ok: true,
      replayed: true,
      booking: {
        id: reviewJobId,
        publicStatus: "under_review",
        arrivalWindowStartAt: null,
        arrivalWindowEndAt: null,
      },
    });
  } finally {
    await cleanupPartnerBookingFixture(fixture);
  }
});

test("account rules override client approval hints and a valid approval hold confirms atomically", async ({
  page,
  baseURL,
}) => {
  if (!baseURL) throw new Error("The audit Site base URL is required.");
  const requester = await createPartnerBookingFixture();
  const fixture = await configurePartnerApprovalFixture(requester);
  try {
    await usePartnerSession(page, baseURL, requester.sessionToken);
    await page.goto(
      `/partners/book?locationId=${requester.locationId}&serviceKey=junk-removal`,
    );
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();
    await page
      .getByRole("textbox", { name: BOOKING_SCOPE_LABEL })
      .fill(`Approval-controlled removal. E2E ${requester.marker}`);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByLabel("On-site contact name").fill("Approval Site Lead");
    await page.getByLabel("Mobile phone").fill(requester.partnerPhoneE164);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(
      page.getByRole("heading", { name: "Add photos & proof" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(
      page.getByRole("heading", { name: "Choose an arrival window" }),
    ).toBeVisible();
    const arrivalWindows = page.locator("fieldset button[aria-pressed]");
    await expect(arrivalWindows.first()).toBeVisible();
    await arrivalWindows.last().click();
    await expect(page.getByText(/Arrival window held:/u)).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Send service request" }).click();
    await expect(page).toHaveURL(
      /\/partners\/bookings\/[0-9a-f-]+\?created=1$/iu,
    );
    const jobId = new URL(page.url()).pathname.split("/").at(-1);
    if (!jobId) throw new Error("Approval-controlled job ID is missing.");
    await expect(
      page.getByText("Approval Needed", { exact: true }),
    ).toBeVisible();

    const pending = await expect
      .poll(() => getPartnerApprovalLifecycleSnapshot(fixture, jobId), {
        timeout: 20_000,
      })
      .toMatchObject({
        requestState: "pending",
        holdStatus: "active",
        bookingStatus: "approval_needed",
        confirmationMode: "approval",
        appointmentStatus: "requested",
        appointmentStartAt: null,
        promisedArrivalStartAt: null,
        promisedArrivalEndAt: null,
        decisionCount: 0,
      })
      .then(() => getPartnerApprovalLifecycleSnapshot(fixture, jobId));
    expect(new Date(pending.holdExpiresAt ?? 0).getTime()).toBeGreaterThan(
      Date.now() + 20 * 60_000,
    );

    await usePartnerSession(page, baseURL, fixture.approverSessionToken);
    await page.goto("/partners/approvals");
    await expect(
      page.getByRole("heading", { name: "Approvals", level: 1 }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Review request" }).click();
    await expect(
      page.getByRole("heading", { name: "Approve or decline this request" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Record approval" }).click();
    await expect(page.getByText("The request was approved.")).toBeVisible();

    await expect
      .poll(() => getPartnerApprovalLifecycleSnapshot(fixture, jobId), {
        timeout: 20_000,
      })
      .toMatchObject({
        requestState: "approved",
        requestRevision: 2,
        holdStatus: "consumed",
        bookingStatus: "confirmed",
        appointmentStatus: "confirmed",
        decisionCount: 1,
        decisionAuditCount: 1,
        approvalCalendarOutboxCount: 1,
      });
    const approved = await getPartnerApprovalLifecycleSnapshot(fixture, jobId);
    expect(approved.appointmentStartAt).not.toBeNull();
    expect(approved.promisedArrivalStartAt).not.toBeNull();
    expect(approved.promisedArrivalEndAt).not.toBeNull();

    await usePartnerSession(page, baseURL, requester.sessionToken);
    await page.goto(`/partners/bookings/${jobId}`);
    await expect(page.getByText("Confirmed", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Add to calendar" }),
    ).toBeVisible();
  } finally {
    await cleanupPartnerApprovalFixture(fixture);
  }
});
