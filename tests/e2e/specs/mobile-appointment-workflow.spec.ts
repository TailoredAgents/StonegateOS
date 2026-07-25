import { test, expect } from "../test";
import type { Page } from "@playwright/test";
import { getAppointmentStartAt, getLatestE2ESeedSummary } from "../support/db";

type PaymentSummary = {
  status:
    | "unknown"
    | "unpaid"
    | "partial"
    | "paid"
    | "refunded"
    | "needs_review";
  jobTotalCents: number | null;
  paidTowardJobCents: number;
  tipCents: number;
  refundedCents: number;
  balanceCents: number | null;
  activeAttemptId: string | null;
  latestReceiptUrl: string | null;
};

const unpaidPaymentSummary: PaymentSummary = {
  status: "unpaid",
  jobTotalCents: 32500,
  paidTowardJobCents: 0,
  tipCents: 0,
  refundedCents: 0,
  balanceCents: 32500,
  activeAttemptId: null,
  latestReceiptUrl: null,
};

function easternDayKey(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value;
  const year = part("year");
  const month = part("month");
  const day = part("day");
  if (!year || !month || !day) {
    throw new Error("Unable to format the seeded appointment day.");
  }
  return `${year}-${month}-${day}`;
}

async function seededAppointment(): Promise<{
  appointmentId: string;
  startAt: Date;
}> {
  const seed = await getLatestE2ESeedSummary();
  if (!seed?.appointmentId) {
    throw new Error("The E2E seed did not create an appointment.");
  }
  const startAt = await getAppointmentStartAt(seed.appointmentId);
  if (!startAt) {
    throw new Error("The seeded appointment has no start time.");
  }
  return { appointmentId: seed.appointmentId, startAt };
}

async function mockPayments(
  page: Page,
  appointmentId: string,
  getSummary: () => PaymentSummary,
): Promise<void> {
  await page.route(
    `**/api/mobile/appointments/${appointmentId}/payments`,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          paymentSummary: getSummary(),
          payments: [],
          attempts: [],
        }),
      });
    },
  );
}

async function openSeededPayment(
  page: Page,
  appointmentId: string,
  startAt: Date,
): Promise<void> {
  await page.goto(`/mobile?screen=calendar&date=${easternDayKey(startAt)}`);
  await page.getByText("E2E Contact", { exact: true }).click();
  await page.getByText("Payment", { exact: true }).click();
}

test.describe("Mobile appointment quoted work and payments", () => {
  test.use({ storageState: "tests/e2e/storage/mobile-owner.json" });

  test("shares the gallery and payment controls on mobile", async ({
    page,
    isMobile,
  }) => {
    test.skip(
      !isMobile,
      "This workflow is covered by the mobile browser projects.",
    );

    const { appointmentId, startAt } = await seededAppointment();

    await page.route(
      `**/api/mobile/appointments/${appointmentId}/media`,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            quotedScopeText:
              "Remove the sectional and boxed garage items shown in the photos.",
            mediaSummary: {
              readyCount: 1,
              pendingCount: 0,
              coverMediaId: "11111111-1111-4111-8111-111111111111",
              needsScope: false,
            },
            items: [
              {
                id: "11111111-1111-4111-8111-111111111111",
                status: "ready",
                caption: "Sectional in garage",
                sortOrder: 0,
                isCover: true,
                source: "twilio_mms",
                filename: "sectional.jpg",
                contentType: "image/jpeg",
                thumbnailUrl:
                  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                displayUrl:
                  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                originalUrl: null,
              },
            ],
            legacyAttachments: [],
          }),
        });
      },
    );

    await page.route(
      `**/api/mobile/appointments/${appointmentId}/payments`,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            paymentSummary: {
              status: "unpaid",
              jobTotalCents: 32500,
              paidTowardJobCents: 0,
              tipCents: 0,
              refundedCents: 0,
              balanceCents: 32500,
              activeAttemptId: null,
              latestReceiptUrl: null,
            },
            payments: [],
            attempts: [],
          }),
        });
      },
    );

    await page.goto(`/mobile?screen=calendar&date=${easternDayKey(startAt)}`);

    await expect(page.getByRole("heading", { name: "Calendar" })).toBeVisible();
    await page.getByText("E2E Contact", { exact: true }).click();

    await page.getByText("Quoted Work", { exact: true }).click();
    await expect(
      page.locator('textarea[placeholder^="Example: Remove"]'),
    ).toHaveValue(
      "Remove the sectional and boxed garage items shown in the photos.",
    );
    await expect(
      page.getByRole("img", { name: "Sectional in garage" }),
    ).toBeVisible();
    await expect(page.getByText("Customer MMS", { exact: true })).toBeVisible();
    await expect(page.getByText("Take photos", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Choose photos", { exact: true }),
    ).toBeVisible();

    await page.getByText("Payment", { exact: true }).click();
    await expect(page.getByText("$325.00 remaining")).toBeVisible();
    const acceptPayment = page.getByRole("button", {
      name: "Accept payment · $325.00",
    });
    await expect(acceptPayment).toBeEnabled();
    await page.getByText("Record cash or check", { exact: true }).click();
    const recordCash = page.getByRole("button", {
      name: "Record full cash balance",
    });
    await expect(recordCash).toBeEnabled();
    await expect(
      page.getByText(
        "Payment and job completion are separate. Mark the job complete only when the removal work is actually finished.",
      ),
    ).toBeVisible();

    await page.context().setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    await expect(
      page.getByText("Payments are disabled offline.", { exact: true }),
    ).toBeVisible();
    await expect(acceptPayment).toBeDisabled();
    await expect(recordCash).toBeDisabled();
    await page.context().setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
  });

  test("creates one mocked Square handoff without calling the provider", async ({
    page,
    browserName,
    isMobile,
  }) => {
    test.skip(
      !isMobile,
      "This workflow is covered by the mobile browser projects.",
    );

    const { appointmentId, startAt } = await seededAppointment();
    await mockPayments(page, appointmentId, () => unpaidPaymentSummary);

    const providerRequests: string[] = [];
    page.on("request", (request) => {
      const url = request.url();
      if (
        url.startsWith("square-commerce-v1:") ||
        /(^|\.)squareup\.com$/u.test(new URL(url).hostname)
      ) {
        providerRequests.push(url);
      }
    });

    let attemptPayload: Record<string, unknown> | null = null;
    let attemptRequests = 0;
    await page.route(
      `**/api/mobile/appointments/${appointmentId}/payment-attempts`,
      async (route) => {
        attemptRequests += 1;
        attemptPayload = route.request().postDataJSON() as Record<
          string,
          unknown
        >;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            attemptId: "22222222-2222-4222-8222-222222222222",
            launchUrl:
              "/mobile/square-setup?reason=app_missing&source=e2e-handoff",
          }),
        });
      },
    );

    await openSeededPayment(page, appointmentId, startAt);
    const acceptPayment = page.getByRole("button", {
      name: "Accept payment · $325.00",
    });
    await expect(acceptPayment).toBeEnabled();
    await acceptPayment.click();

    await expect(page).toHaveURL(/\/mobile\/square-setup\?reason=app_missing/u);
    await expect(
      page.getByRole("heading", { name: "Get Tap to Pay ready" }),
    ).toBeVisible();
    expect(attemptRequests).toBe(1);
    expect(attemptPayload).toMatchObject({
      platform: browserName === "webkit" ? "ios" : "android",
    });
    const clientRequestId = attemptPayload?.["clientRequestId"];
    expect(clientRequestId).toEqual(expect.any(String));
    if (typeof clientRequestId !== "string") {
      throw new Error("The mocked Square attempt did not receive a UUID.");
    }
    expect(clientRequestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    );
    expect(attemptPayload).not.toHaveProperty("amount");
    expect(attemptPayload).not.toHaveProperty("amountCents");
    expect(providerRequests).toEqual([]);
  });

  test("locks an active attempt and suppresses a second tap while launching", async ({
    page,
    isMobile,
  }) => {
    test.skip(
      !isMobile,
      "This workflow is covered by the mobile browser projects.",
    );

    const { appointmentId, startAt } = await seededAppointment();
    const activeSummary: PaymentSummary = {
      ...unpaidPaymentSummary,
      activeAttemptId: "33333333-3333-4333-8333-333333333333",
    };
    await mockPayments(page, appointmentId, () => activeSummary);

    let releaseAttempt!: () => void;
    const attemptGate = new Promise<void>((resolve) => {
      releaseAttempt = resolve;
    });
    let attemptRequests = 0;
    await page.route(
      `**/api/mobile/appointments/${appointmentId}/payment-attempts`,
      async (route) => {
        attemptRequests += 1;
        await attemptGate;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            attemptId: activeSummary.activeAttemptId,
            launchUrl:
              "/mobile/square-setup?reason=app_missing&source=e2e-resume",
          }),
        });
      },
    );

    await openSeededPayment(page, appointmentId, startAt);
    const finalTotal = page.locator('input[placeholder="350.00"]');
    await expect(finalTotal).toBeDisabled();
    await expect(
      page.getByText(
        "The final total is locked while this Square attempt is active.",
        { exact: true },
      ),
    ).toBeVisible();

    const resumePayment = page.getByRole("button", {
      name: "Resume payment in Square",
    });
    await resumePayment.click();
    await expect.poll(() => attemptRequests).toBe(1);
    const openingSquare = page.getByRole("button", {
      name: "Opening Square…",
    });
    await expect(openingSquare).toBeDisabled();
    await openingSquare.evaluate((button: HTMLButtonElement) => button.click());
    await page.waitForTimeout(100);
    expect(attemptRequests).toBe(1);

    releaseAttempt();
    await expect(page).toHaveURL(/\/mobile\/square-setup\?reason=app_missing/u);
  });

  for (const tender of ["cash", "check"] as const) {
    test(`records the full ${tender} balance without a client-entered partial amount`, async ({
      page,
      isMobile,
    }) => {
      test.skip(
        !isMobile,
        "This workflow is covered by the mobile browser projects.",
      );

      const { appointmentId, startAt } = await seededAppointment();
      let currentSummary = { ...unpaidPaymentSummary };
      await mockPayments(page, appointmentId, () => currentSummary);

      let manualPayload: Record<string, unknown> | null = null;
      let manualRequests = 0;
      await page.route(
        `**/api/mobile/appointments/${appointmentId}/manual-payments`,
        async (route) => {
          manualRequests += 1;
          manualPayload = route.request().postDataJSON() as Record<
            string,
            unknown
          >;
          currentSummary = {
            ...unpaidPaymentSummary,
            status: "paid",
            paidTowardJobCents: 32500,
            tipCents: 1250,
            balanceCents: 0,
          };
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ paymentSummary: currentSummary }),
          });
        },
      );

      await openSeededPayment(page, appointmentId, startAt);
      await page.getByText("Record cash or check", { exact: true }).click();
      await page
        .getByRole("button", {
          name: tender === "cash" ? "Cash" : "Check",
          exact: true,
        })
        .click();
      await page.locator('input[placeholder="0.00"]').fill("12.50");
      await page
        .locator('input[placeholder="Check number"]')
        .fill(`${tender} received by E2E`);

      const recordButton = page.getByRole("button", {
        name: `Record full ${tender} balance`,
      });
      await expect(recordButton).toBeEnabled();
      await recordButton.click();

      await expect(
        page.getByText(
          `${tender === "cash" ? "Cash" : "Check"} payment recorded. Job completion is still separate.`,
          { exact: true },
        ),
      ).toBeVisible();
      await expect(
        page.getByText("$0.00 remaining", { exact: true }),
      ).toBeVisible();
      expect(manualRequests).toBe(1);
      expect(manualPayload).toMatchObject({
        tenderType: tender,
        tipCents: 1250,
        note: `${tender} received by E2E`,
      });
      expect(manualPayload?.["clientRequestId"]).toEqual(expect.any(String));
      expect(manualPayload).not.toHaveProperty("jobAmountCents");
      expect(manualPayload).not.toHaveProperty("amount");
      expect(manualPayload).not.toHaveProperty("amountCents");
    });
  }

  test("keeps an invalid Square return provisional and explains setup failures", async ({
    page,
    isMobile,
  }) => {
    test.skip(
      !isMobile,
      "This workflow is covered by the mobile browser projects.",
    );

    await page.goto("/mobile/payment-return?e2e=missing-signed-state");
    await expect(page).toHaveURL(
      /\/mobile\?screen=myday&payment=pending_verification/u,
    );
    await expect(
      page.getByText(
        "Square returned. StonegateOS is verifying the payment; do not charge again yet.",
        { exact: true },
      ),
    ).toBeVisible();

    await page.goto("/mobile/square-setup?reason=illegal_location_id");
    await expect(
      page.getByRole("heading", { name: "Get Tap to Pay ready" }),
    ).toBeVisible();
    await expect(
      page.getByText(/signed in to a different Stonegate location/u),
    ).toBeVisible();
    await expect(
      page.getByText(/No appointment has been marked paid/u),
    ).toBeVisible();
  });

  test("renders verified, canceled, and review return states without completing the job", async ({
    page,
    isMobile,
  }) => {
    test.skip(
      !isMobile,
      "This workflow is covered by the mobile browser projects.",
    );

    const states = [
      {
        status: "verified",
        message:
          "Payment verified. The job remains open until the work is marked complete.",
      },
      {
        status: "canceled",
        message: "Square payment canceled. No payment was marked paid.",
      },
      {
        status: "needs_review",
        message:
          "Payment needs owner review before another charge is attempted.",
      },
    ] as const;

    for (const state of states) {
      await page.goto(`/mobile?screen=myday&payment=${state.status}`);
      await expect(
        page.getByText(state.message, { exact: true }),
      ).toBeVisible();
    }
  });

  test("uploads and finalizes a quoted-work photo through LocalStack", async ({
    page,
    isMobile,
  }) => {
    test.skip(
      !isMobile,
      "This workflow is covered by the mobile browser projects.",
    );

    const { startAt } = await seededAppointment();

    await page.goto(`/mobile?screen=calendar&date=${easternDayKey(startAt)}`);
    await page.getByText("E2E Contact", { exact: true }).click();
    await page.getByText("Quoted Work", { exact: true }).click();

    const scope = page.locator('textarea[placeholder^="Example: Remove"]');
    await scope.fill("Remove the blue chair shown in the crew photo.");
    await page.getByRole("button", { name: "Save scope" }).click();
    await expect(page.getByText("Quoted scope saved.")).toBeVisible();

    await page
      .getByPlaceholder("Items behind the shed")
      .fill("Blue chair by the garage");
    await page
      .locator('input[type="file"][multiple][accept*="image/jpeg"]')
      .setInputFiles({
        name: "blue-chair.png",
        mimeType: "image/png",
        buffer: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          "base64",
        ),
      });

    await expect(
      page.getByRole("img", { name: "Blue chair by the garage" }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Staff photo", { exact: true })).toBeVisible();
    await expect(page.getByText("blue-chair.jpg", { exact: true })).toHaveCount(
      0,
    );
  });

  test("keeps an unsynced photo recoverable after its job snapshot expires", async ({
    page,
    isMobile,
  }) => {
    test.skip(
      !isMobile,
      "This workflow is covered by the mobile browser projects.",
    );

    const { appointmentId } = await seededAppointment();

    await page.goto("/mobile/offline");
    const employeeId = await page.evaluate(async () => {
      const response = await fetch("/api/mobile/me");
      const payload = (await response.json()) as {
        teamMember?: { id?: string };
      };
      if (!payload.teamMember?.id) throw new Error("mobile employee missing");
      return payload.teamMember.id;
    });
    await page.evaluate((resolvedEmployeeId) => {
      localStorage.setItem(
        "stonegate:last-mobile-employee",
        resolvedEmployeeId,
      );
    }, employeeId);
    await page.reload();
    await expect(
      page.getByText(/No current jobs have been cached/u),
    ).toBeVisible();
    const clientId = crypto.randomUUID();

    await page.evaluate(
      async ({ appointmentId, clientId, employeeId }) => {
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open("stonegate-mobile", 2);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const transaction = database.transaction(
          ["appointment-snapshots", "media-upload-queue"],
          "readwrite",
        );
        const now = Date.now();
        transaction.objectStore("appointment-snapshots").put({
          key: `${employeeId}:${appointmentId}`,
          employeeId,
          appointmentId,
          dayKey: new Date().toISOString().slice(0, 10),
          contactName: "Expired offline job",
          address: null,
          start: new Date(now).toISOString(),
          end: new Date(now + 60 * 60 * 1000).toISOString(),
          status: "confirmed",
          canCaptureMedia: true,
          quotedScopeText: "Remove the photographed item.",
          mediaSummary: {
            readyCount: 0,
            pendingCount: 0,
            coverMediaId: null,
            needsScope: false,
          },
          paymentSummary: null,
          savedAt: now - 49 * 60 * 60 * 1000,
          expiresAt: now - 1,
        });
        transaction.objectStore("media-upload-queue").put({
          clientId,
          employeeId,
          appointmentId,
          filename: "recover-me.jpg",
          contentType: "image/jpeg",
          byteCount: 3,
          checksumSha256: "0".repeat(64),
          caption: null,
          quotedScopeText: null,
          blob: new Blob([new Uint8Array([1, 2, 3])], {
            type: "image/jpeg",
          }),
          capturedOffline: true,
          status: "finalizing",
          error: null,
          attempts: 1,
          createdAt: now - 25 * 60 * 60 * 1000,
          updatedAt: now - 11 * 60 * 1000,
        });
        await new Promise<void>((resolve, reject) => {
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error);
        });
        database.close();
      },
      { appointmentId, clientId, employeeId },
    );

    await page.context().setOffline(true);
    await page.evaluate(() => {
      window.dispatchEvent(new Event("offline"));
      window.dispatchEvent(new Event("stonegate:media-queue-change"));
    });

    await expect(
      page.getByText("Unsynced photos from older jobs", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("recover-me.jpg", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Upload interrupted", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Discard" })).toBeVisible();
    await expect(
      page.getByText(/been waiting more than 24 hours/u),
    ).toBeVisible();
    const expiredSnapshotExists = await page.evaluate(
      async ({ appointmentId, employeeId }) => {
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open("stonegate-mobile", 2);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const transaction = database.transaction(
          "appointment-snapshots",
          "readonly",
        );
        const request = transaction
          .objectStore("appointment-snapshots")
          .get(`${employeeId}:${appointmentId}`);
        const exists = await new Promise<boolean>((resolve, reject) => {
          request.onsuccess = () => resolve(Boolean(request.result));
          request.onerror = () => reject(request.error);
        });
        database.close();
        return exists;
      },
      { appointmentId, employeeId },
    );
    expect(expiredSnapshotExists).toBe(false);

    await page.evaluate(async (queuedClientId) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("stonegate-mobile", 2);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const transaction = database.transaction(
        "media-upload-queue",
        "readwrite",
      );
      transaction.objectStore("media-upload-queue").delete(queuedClientId);
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      database.close();
    }, clientId);
    await page.context().setOffline(false);
  });
});

test.describe("Mobile payment permission boundary", () => {
  test.use({
    storageState: "tests/e2e/storage/mobile-payment-denied.json",
  });

  test("hides payment controls and rejects read and collect requests", async ({
    page,
    request,
    isMobile,
  }) => {
    test.skip(
      !isMobile,
      "This workflow is covered by the mobile browser projects.",
    );

    const { appointmentId, startAt } = await seededAppointment();
    await page.goto(`/mobile?screen=calendar&date=${easternDayKey(startAt)}`);
    await page.getByText("E2E Contact", { exact: true }).click();
    await expect(page.getByText("Payment", { exact: true })).toHaveCount(0);

    const readResponse = await request.get(
      `/api/mobile/appointments/${appointmentId}/payments`,
    );
    expect(readResponse.status()).toBe(403);

    const squareResponse = await request.post(
      `/api/mobile/appointments/${appointmentId}/payment-attempts`,
      {
        data: {
          clientRequestId: crypto.randomUUID(),
          platform: "android",
        },
      },
    );
    expect(squareResponse.status()).toBe(403);

    const manualResponse = await request.post(
      `/api/mobile/appointments/${appointmentId}/manual-payments`,
      {
        data: {
          clientRequestId: crypto.randomUUID(),
          tenderType: "cash",
          tipCents: 0,
        },
      },
    );
    expect(manualResponse.status()).toBe(403);
  });
});
