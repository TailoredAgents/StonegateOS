import { expect, test, type Page } from "@playwright/test";
import { PARTNER_SESSION_COOKIE } from "../../../apps/site/src/lib/partner-session";
import {
  cleanupPartnerJobActionFixture,
  closePartnerBookingFixtures,
  createPartnerJobActionFixture,
  getPartnerJobActionFixtureSnapshot,
  type PartnerJobActionFixture,
} from "./partner-booking-fixtures";

test.use({ storageState: "tests/e2e/storage/visitor.json" });

test.beforeEach(({ page: _page }, testInfo) => {
  test.skip(
    testInfo.project.name !== "chromium-1440-light",
    "The stateful BOOK-015 contract journey runs once in desktop Chromium.",
  );
  testInfo.setTimeout(120_000);
});

test.afterAll(async () => {
  await closePartnerBookingFixtures();
});

type ActionDescriptor = {
  action: string;
  allowed: boolean;
  reason: { code: string; label: string };
};

type JobActionPayload = {
  ok: true;
  job: {
    id: string;
    status: string;
    cancellation: {
      action: "cancel" | "request_cancellation_review" | null;
      reason: { code: string; label: string };
    };
    actionAvailability: ActionDescriptor[];
    allowedActions: string[];
  };
};

function descriptor(
  payload: JobActionPayload,
  action: string,
): ActionDescriptor {
  const result = payload.job.actionAvailability.find(
    (candidate) => candidate.action === action,
  );
  if (!result) throw new Error(`Missing ${action} action descriptor.`);
  return result;
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

async function loadActionContract(
  page: Page,
  fixture: PartnerJobActionFixture,
  jobId: string,
): Promise<JobActionPayload> {
  const response = await page.request.get(
    `/api/partners/portal/jobs/${encodeURIComponent(jobId)}`,
  );
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toContain("no-store");
  const payload = (await response.json()) as JobActionPayload;
  expect(payload).toMatchObject({ ok: true, job: { id: jobId } });
  expect(payload.job.actionAvailability).toHaveLength(9);
  expect(
    new Set(payload.job.actionAvailability.map((entry) => entry.action)).size,
  ).toBe(9);

  const serialized = JSON.stringify(payload);
  const privateIds = [
    fixture.requester.contactId,
    fixture.requester.propertyId,
    fixture.requester.partnerAccountId,
    fixture.requester.partnerUserId,
    fixture.requester.membershipId,
    fixture.requester.sessionId,
    fixture.viewerUserId,
    fixture.viewerMembershipId,
    fixture.viewerSessionId,
    ...Object.values(fixture.jobs).map((job) => job.appointmentId),
  ];
  for (const privateId of privateIds) {
    expect(serialized).not.toContain(privateId);
  }
  for (const internalField of [
    "appointmentId",
    "appointmentStatus",
    "partnerAccountId",
    "partnerUserId",
    "membershipId",
    "cancelOperationKeyHash",
    "cancelRequestHash",
  ]) {
    expect(payload.job).not.toHaveProperty(internalField);
  }
  return payload;
}

async function openJob(page: Page, jobId: string): Promise<void> {
  await page.goto(`/partners/bookings/${encodeURIComponent(jobId)}`);
  await expect(
    page.getByRole("heading", { name: "Job actions", level: 2 }),
  ).toBeVisible();
}

async function expectNoClosedJobMutationControls(page: Page): Promise<void> {
  await expect(page.getByRole("link", { name: "Change schedule" })).toHaveCount(
    0,
  );
  await expect(page.getByText("Cancel this job", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByText("Request cancellation review", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.locator('form[data-partner-analytics="job_cancel"]'),
  ).toHaveCount(0);
}

test("BOOK-015 exposes only safe job actions for lifecycle, policy, pending-review, and Viewer states", async ({
  page,
  baseURL,
}) => {
  if (!baseURL) throw new Error("The audit Site base URL is required.");
  const fixture = await createPartnerJobActionFixture();

  try {
    const db = await getPartnerJobActionFixtureSnapshot(fixture);
    expect(db).toMatchObject({
      operationsRoleKey: "operations",
      viewerRoleKey: "viewer",
      viewerActiveSessionCount: 1,
    });
    const dbById = new Map(db.jobs.map((job) => [job.bookingId, job]));
    const eligibleDb = dbById.get(fixture.jobs.eligible.bookingId);
    const imminentDb = dbById.get(fixture.jobs.imminent.bookingId);
    const pendingDb = dbById.get(
      fixture.jobs.cancellationReviewPending.bookingId,
    );
    const completedDb = dbById.get(fixture.jobs.completed.bookingId);
    expect(eligibleDb).toMatchObject({
      publicStatus: "confirmed",
      appointmentStatus: "confirmed",
      cancellationReviewPending: false,
    });
    expect(imminentDb).toMatchObject({
      publicStatus: "confirmed",
      appointmentStatus: "confirmed",
      cancellationReviewPending: false,
    });
    expect(pendingDb).toMatchObject({
      publicStatus: "confirmed",
      appointmentStatus: "confirmed",
      cancellationReviewPending: true,
    });
    expect(completedDb).toMatchObject({
      publicStatus: "completed",
      appointmentStatus: "completed",
      cancellationReviewPending: false,
    });
    expect(completedDb?.completedAt).not.toBeNull();
    expect(
      new Date(eligibleDb?.arrivalWindowStartAt ?? 0).getTime() - Date.now(),
    ).toBeGreaterThan(24 * 60 * 60 * 1_000);
    const imminentLeadTime =
      new Date(imminentDb?.arrivalWindowStartAt ?? 0).getTime() - Date.now();
    expect(imminentLeadTime).toBeGreaterThan(0);
    expect(imminentLeadTime).toBeLessThan(24 * 60 * 60 * 1_000);

    await usePartnerSession(page, baseURL, fixture.requester.sessionToken);

    const eligible = await loadActionContract(
      page,
      fixture,
      fixture.jobs.eligible.bookingId,
    );
    expect(eligible.job.cancellation).toMatchObject({
      action: "cancel",
      reason: { code: "before_cutoff" },
    });
    expect(descriptor(eligible, "reschedule")).toMatchObject({
      allowed: true,
      reason: { code: "available" },
    });
    expect(descriptor(eligible, "cancel")).toMatchObject({
      allowed: true,
      reason: { code: "available" },
    });
    expect(descriptor(eligible, "request_cancellation_review")).toMatchObject({
      allowed: false,
      reason: { code: "status_unavailable" },
    });
    expect(eligible.job.allowedActions).toEqual(
      expect.arrayContaining(["reschedule", "cancel"]),
    );
    await openJob(page, fixture.jobs.eligible.bookingId);
    await expect(
      page.getByRole("link", { name: "Change schedule" }),
    ).toBeVisible();
    await expect(
      page.getByText("Cancel this job", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("This account uses a 24-hour cutoff"),
    ).toBeVisible();

    const imminent = await loadActionContract(
      page,
      fixture,
      fixture.jobs.imminent.bookingId,
    );
    expect(imminent.job.cancellation).toMatchObject({
      action: "request_cancellation_review",
      reason: { code: "cutoff_elapsed" },
    });
    expect(descriptor(imminent, "reschedule")).toMatchObject({
      allowed: true,
      reason: { code: "available_review_required" },
    });
    expect(descriptor(imminent, "cancel")).toMatchObject({
      allowed: false,
      reason: { code: "cancellation_policy_review" },
    });
    expect(descriptor(imminent, "request_cancellation_review")).toMatchObject({
      allowed: true,
      reason: { code: "available" },
    });
    expect(imminent.job.allowedActions).toContain("reschedule");
    expect(imminent.job.allowedActions).toContain(
      "request_cancellation_review",
    );
    expect(imminent.job.allowedActions).not.toContain("cancel");
    await openJob(page, fixture.jobs.imminent.bookingId);
    await expect(
      page.getByRole("link", { name: "Change schedule" }),
    ).toBeVisible();
    await expect(
      page.getByText("Request cancellation review", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(
        /existing appointment stays in place until Stonegate reviews it/u,
      ),
    ).toBeVisible();
    await expect(
      page.getByText(
        /cancellation cutoff has passed, so staff review is required/u,
      ),
    ).toBeVisible();

    const pending = await loadActionContract(
      page,
      fixture,
      fixture.jobs.cancellationReviewPending.bookingId,
    );
    expect(pending.job.cancellation).toMatchObject({
      action: null,
      reason: { code: "review_pending" },
    });
    for (const action of [
      "reschedule",
      "cancel",
      "request_cancellation_review",
    ]) {
      expect(descriptor(pending, action)).toMatchObject({
        allowed: false,
        reason: { code: "cancellation_review_pending" },
      });
      expect(pending.job.allowedActions).not.toContain(action);
    }
    await openJob(page, fixture.jobs.cancellationReviewPending.bookingId);
    await expectNoClosedJobMutationControls(page);
    const pendingReasons = page
      .locator("details")
      .filter({ hasText: "Why some actions are unavailable" });
    await pendingReasons
      .getByText("Why some actions are unavailable", { exact: true })
      .click();
    await expect(
      pendingReasons.getByText(
        "A cancellation request is under review, so the schedule cannot be changed.",
      ),
    ).toBeVisible();
    await expect(
      pendingReasons.getByText(
        "A cancellation request is already under staff review.",
      ),
    ).toBeVisible();

    const completed = await loadActionContract(
      page,
      fixture,
      fixture.jobs.completed.bookingId,
    );
    expect(completed.job.cancellation).toMatchObject({
      action: null,
      reason: { code: "job_terminal" },
    });
    for (const action of [
      "reschedule",
      "cancel",
      "request_cancellation_review",
    ]) {
      expect(descriptor(completed, action)).toMatchObject({
        allowed: false,
        reason: { code: "job_terminal" },
      });
    }
    await openJob(page, fixture.jobs.completed.bookingId);
    await expectNoClosedJobMutationControls(page);
    const completedReasons = page
      .locator("details")
      .filter({ hasText: "Why some actions are unavailable" });
    await completedReasons
      .getByText("Why some actions are unavailable", { exact: true })
      .click();
    for (const actionLabel of ["Scope change:", "Schedule change:"]) {
      await expect(
        completedReasons.locator("li").filter({
          hasText: `${actionLabel} This action is unavailable because the job is closed.`,
        }),
      ).toBeVisible();
    }

    await usePartnerSession(page, baseURL, fixture.viewerSessionToken);
    const viewer = await loadActionContract(
      page,
      fixture,
      fixture.jobs.eligible.bookingId,
    );
    expect(viewer.job.allowedActions).toEqual([]);
    for (const action of ["reschedule", "cancel", "duplicate", "message"]) {
      expect(descriptor(viewer, action)).toMatchObject({
        allowed: false,
        reason: { code: "permission_required" },
      });
    }
    await openJob(page, fixture.jobs.eligible.bookingId);
    await expectNoClosedJobMutationControls(page);
    await expect(page.getByRole("button", { name: "Book again" })).toHaveCount(
      0,
    );
    await expect(
      page.locator('form[data-partner-analytics="template_save"]'),
    ).toHaveCount(0);
    const viewerReasons = page
      .locator("details")
      .filter({ hasText: "Why some actions are unavailable" });
    await viewerReasons
      .getByText("Why some actions are unavailable", { exact: true })
      .click();
    await expect(
      viewerReasons.getByText(
        "Your account role does not allow changes to this job.",
      ),
    ).toBeVisible();
    await expect(
      viewerReasons.getByText("Your account role cannot cancel this job."),
    ).toBeVisible();

    const pageText = await page.locator("body").innerText();
    for (const internalId of [
      fixture.requester.contactId,
      fixture.requester.propertyId,
      fixture.requester.partnerAccountId,
      fixture.requester.partnerUserId,
      fixture.requester.membershipId,
      fixture.jobs.eligible.appointmentId,
    ]) {
      expect(pageText).not.toContain(internalId);
    }
  } finally {
    await cleanupPartnerJobActionFixture(fixture);
  }
});
