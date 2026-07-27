import { test, expect } from "../test";
import type { Locator, Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  createE2EMobileAppointment,
  getLatestE2ESeedSummary,
} from "../support/db";

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

const browserDecodablePng = readFileSync("apps/site/public/favicon-32.png");

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
  if (!seed) throw new Error("The E2E seed did not create a contact.");
  return createE2EMobileAppointment({
    contactId: seed.contactId,
    propertyId: seed.propertyId,
  });
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
  const card = page.locator(`[data-appointment-id="${appointmentId}"]`);
  const cardToggle = card.getByRole("button", { name: /E2E Contact/u });
  await expect(card).toBeVisible();
  await cardToggle.click();
  await expect(cardToggle).toHaveAttribute("aria-expanded", "true");
  await card.getByText("Payment", { exact: true }).click();
}

async function expectMinimumTapHeight(
  locator: Locator,
  minimumHeight = 44,
): Promise<void> {
  const box = await locator.boundingBox();
  expect(box, "expected a visible tap target").not.toBeNull();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(minimumHeight);
}

async function expectNoEtaControls(card: Locator): Promise<void> {
  await expect(card.getByText(/^ETA$/u)).toHaveCount(0);
  for (const oldEtaControl of [
    "Heading",
    "On site",
    "Need dump",
    "Dump done",
    "Finished",
  ]) {
    await expect(
      card.getByRole("button", {
        name: oldEtaControl,
        exact: true,
      }),
    ).toHaveCount(0);
  }
}

test.describe("Mobile appointment quoted work and payments", () => {
  test.use({
    storageState: "tests/e2e/storage/mobile-owner.json",
    // This describe exercises the foreground PWA runtime. WebKit can route a
    // request through a controlling worker even when its fetch handler falls
    // through, which bypasses Playwright's page-level endpoint mocks.
    serviceWorkers: "block",
  });

  test("keeps My Day and Calendar appointment cards compact and actionable", async ({
    page,
    isMobile,
  }) => {
    test.skip(
      !isMobile,
      "This workflow is covered by the mobile browser projects.",
    );

    const { appointmentId, startAt } = await seededAppointment();
    const appointmentDay = easternDayKey(startAt);

    for (const screen of ["myday", "calendar"] as const) {
      await page.goto(`/mobile?screen=${screen}&date=${appointmentDay}`);

      const card = page.locator(`[data-appointment-id="${appointmentId}"]`);
      await expect(card).toBeVisible({ timeout: 30_000 });

      const toggle = card.getByRole("button", {
        name: /E2E Contact/u,
      });
      const directions = card.getByRole("link", {
        name: /^Open directions to /u,
      });

      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(card.getByText("Quoted Work", { exact: true })).toHaveCount(
        0,
      );
      await expect(card.getByText("Payment", { exact: true })).toHaveCount(0);

      await expect(directions).toBeVisible();
      await expect(directions).toHaveAttribute(
        "href",
        /^https:\/\/www\.google\.com\/maps\/dir\//u,
      );
      await expectMinimumTapHeight(toggle);
      await expectMinimumTapHeight(directions);

      await expect(
        card.getByRole("button", { name: "Map", exact: true }),
      ).toHaveCount(0);
      await expect(
        card.getByRole("link", { name: "Map", exact: true }),
      ).toHaveCount(0);
      await expectNoEtaControls(card);

      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(
        card.getByText("Quoted Work", { exact: true }),
      ).toBeVisible();
      await expect(card.getByText("Payment", { exact: true })).toBeVisible();
      await expectNoEtaControls(card);
    }
  });

  test("drains photos queued during an active sync even when online status is wrong", async ({
    page,
    isMobile,
  }) => {
    test.skip(
      !isMobile,
      "This workflow is covered by the mobile browser projects.",
    );

    const { appointmentId, startAt } = await seededAppointment();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "onLine", {
        configurable: true,
        get: () => false,
      });
    });
    let reauthenticated = true;
    let pausedMeRequests = 0;
    await page.route("**/api/mobile/me", async (route) => {
      if (reauthenticated) {
        await route.continue();
        return;
      }
      pausedMeRequests += 1;
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "session_expired" }),
      });
    });

    await page.route(
      `**/api/mobile/appointments/${appointmentId}/media`,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            quotedScopeText: "Remove both photographed items.",
            mediaSummary: {
              readyCount: 0,
              pendingCount: 0,
              coverMediaId: null,
              needsScope: false,
            },
            items: [],
            legacyAttachments: [],
          }),
        });
      },
    );

    const intentClientIds: string[] = [];
    const intentUploadModes: string[] = [];
    const mediaIds = new Map<string, string>();
    let delayedIntent = false;
    let returnedProcessingState = false;
    let returnedAuthPausedState = false;
    let authPausedClientId: string | null = null;
    await page.route(
      `**/api/mobile/appointments/${appointmentId}/media/upload-intents`,
      async (route) => {
        const body = route.request().postDataJSON() as {
          uploadMode?: string;
          files?: Array<{ clientId?: string }>;
        };
        const clientId = body.files?.[0]?.clientId;
        if (!clientId) {
          await route.fulfill({ status: 400, body: "missing client id" });
          return;
        }
        intentClientIds.push(clientId);
        intentUploadModes.push(body.uploadMode ?? "");
        let mediaId = mediaIds.get(clientId);
        if (!mediaId) {
          mediaId = `11111111-1111-4111-8111-${String(
            mediaIds.size + 1,
          ).padStart(12, "0")}`;
          mediaIds.set(clientId, mediaId);
        }
        const origin = new URL(route.request().url()).origin;
        if (
          clientId === "22222222-2222-4222-8222-222222222222" &&
          !returnedProcessingState
        ) {
          returnedProcessingState = true;
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              intents: [{ mediaId, status: "processing" }],
            }),
          });
          return;
        }
        if (body.uploadMode === "direct_mobile" && !returnedAuthPausedState) {
          returnedAuthPausedState = true;
          authPausedClientId = clientId;
          reauthenticated = false;
          await route.fulfill({
            status: 401,
            contentType: "application/json",
            body: JSON.stringify({ error: "session_expired" }),
          });
          return;
        }
        if (!delayedIntent) {
          delayedIntent = true;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            intents: [
              {
                mediaId,
                uploadUrl: `${origin}/__e2e/media-object/${mediaId}`,
                headers: {},
                alreadyCompleted: false,
              },
            ],
          }),
        });
      },
    );
    const uploadedObjectByteCounts = new Map<string, number>();
    await page.route("**/__e2e/media-object/*", async (route) => {
      const mediaId = new URL(route.request().url()).pathname.split("/").at(-1);
      const body = route.request().postDataBuffer();
      if (mediaId) uploadedObjectByteCounts.set(mediaId, body?.byteLength ?? 0);
      await route.fulfill({ status: 200, body: "" });
    });
    let completedUploads = 0;
    await page.route(
      "**/api/mobile/appointment-media/*/complete",
      async (route) => {
        completedUploads += 1;
        const mediaId = new URL(route.request().url()).pathname
          .split("/")
          .at(-2);
        if (!mediaId) {
          await route.fulfill({ status: 400, body: "missing media id" });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            media: { id: mediaId, status: "ready" },
          }),
        });
      },
    );

    await page.goto(`/mobile?screen=calendar&date=${easternDayKey(startAt)}`);
    const card = page.locator(`[data-appointment-id="${appointmentId}"]`);
    await card.getByRole("button", { name: /E2E Contact/u }).click();
    await card.getByText("Quoted Work", { exact: true }).click();

    const input = page
      .locator("label", { hasText: "Choose photos" })
      .locator('input[type="file"]');
    const employeeId = await page.evaluate(async () => {
      const response = await fetch("/api/mobile/me", { cache: "no-store" });
      const payload = (await response.json()) as {
        teamMember?: { id?: string };
      };
      return payload.teamMember?.id ?? null;
    });
    if (!employeeId) throw new Error("Mobile employee was not available.");

    await page.evaluate(
      async ({
        appointmentId: queuedAppointmentId,
        employeeId: queuedEmployeeId,
        imageBytes,
      }) => {
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open("stonegate-mobile", 3);
          request.onerror = () =>
            reject(request.error ?? new Error("Unable to open the media DB."));
          request.onsuccess = () => resolve(request.result);
        });
        const transactionDone = (transaction: IDBTransaction) =>
          new Promise<void>((resolve, reject) => {
            transaction.oncomplete = () => resolve();
            transaction.onerror = () =>
              reject(
                transaction.error ??
                  new Error("The media DB transaction failed."),
              );
            transaction.onabort = () =>
              reject(
                transaction.error ??
                  new Error("The media DB transaction was aborted."),
              );
          });
        const imageArray = new Uint8Array(imageBytes);
        const digest = new Uint8Array(
          await crypto.subtle.digest("SHA-256", imageArray),
        );
        const checksumSha256 = Array.from(digest, (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
        const now = Date.now();

        // Keep binary queue data in its own transaction so WebKit cannot
        // abort unrelated metadata writes when storage is under pressure.
        const metadataTransaction = database.transaction(
          "app-metadata",
          "readwrite",
        );
        const metadataDone = transactionDone(metadataTransaction);
        metadataTransaction.objectStore("app-metadata").put({
          key: "mediaSyncLease:callback-v1",
          version: 4,
          owner: "window:terminated-production-realm",
          employeeId: queuedEmployeeId,
          heartbeatAt: now,
          expiresAt: now + 10 * 60 * 1000,
        });
        await metadataDone;

        const queueTransaction = database.transaction(
          "media-upload-queue",
          "readwrite",
        );
        const queueDone = transactionDone(queueTransaction);
        queueTransaction.objectStore("media-upload-queue").put({
          clientId: "22222222-2222-4222-8222-222222222222",
          employeeId: queuedEmployeeId,
          appointmentId: queuedAppointmentId,
          filename: "interrupted.png",
          contentType: "image/png",
          byteCount: imageArray.byteLength,
          checksumSha256,
          caption: null,
          quotedScopeText: "Remove both photographed items.",
          bytes: imageArray.buffer.slice(
            imageArray.byteOffset,
            imageArray.byteOffset + imageArray.byteLength,
          ),
          capturedOffline: true,
          status: "uploading",
          error: null,
          attempts: 1,
          createdAt: now - 12 * 60 * 1000,
          updatedAt: now - 11 * 60 * 1000,
        });
        await queueDone;
        database.close();

        const originalPut = IDBObjectStore.prototype.put;
        const originalCursorUpdate = IDBCursorWithValue.prototype.update;
        const knownQueueClientIds = new Set([
          "22222222-2222-4222-8222-222222222222",
        ]);
        let mediaQueueRewriteAttempts = 0;
        IDBObjectStore.prototype.put = function (
          value: unknown,
          key?: IDBValidKey,
        ) {
          const row =
            typeof value === "object" && value !== null
              ? (value as { clientId?: unknown })
              : null;
          if (this.name === "media-upload-queue") {
            const clientId =
              typeof row?.clientId === "string" ? row.clientId : null;
            if (clientId && knownQueueClientIds.has(clientId)) {
              mediaQueueRewriteAttempts += 1;
              throw new DOMException(
                "Large binary row rewrites are unavailable.",
                "UnknownError",
              );
            }
            if (clientId) knownQueueClientIds.add(clientId);
          }
          return key === undefined
            ? originalPut.call(this, value)
            : originalPut.call(this, value, key);
        };
        IDBCursorWithValue.prototype.update = function (value: unknown) {
          const row =
            typeof value === "object" && value !== null
              ? (value as { clientId?: unknown })
              : null;
          const clientId =
            typeof row?.clientId === "string" ? row.clientId : null;
          if (clientId && knownQueueClientIds.has(clientId)) {
            mediaQueueRewriteAttempts += 1;
            throw new DOMException(
              "Large binary cursor rewrites are unavailable.",
              "UnknownError",
            );
          }
          if (clientId) knownQueueClientIds.add(clientId);
          return originalCursorUpdate.call(this, value);
        };
        (
          window as Window & {
            __mediaQueueRewriteAttempts?: () => number;
          }
        ).__mediaQueueRewriteAttempts = () => mediaQueueRewriteAttempts;
      },
      {
        appointmentId,
        employeeId,
        imageBytes: Array.from(browserDecodablePng),
      },
    );

    await input.setInputFiles([
      {
        name: "first.png",
        mimeType: "image/png",
        buffer: browserDecodablePng,
      },
      {
        name: "second.png",
        mimeType: "image/png",
        buffer: browserDecodablePng,
      },
    ]);

    await expect.poll(() => authPausedClientId).not.toBeNull();
    await expect.poll(() => input.inputValue()).toBe("");
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(() => pausedMeRequests).toBeGreaterThan(0);
    await page.waitForTimeout(250);
    expect(
      intentClientIds.filter((clientId) => clientId === authPausedClientId),
    ).toHaveLength(1);
    reauthenticated = true;
    await page.evaluate(() => window.dispatchEvent(new Event("online")));

    await expect.poll(() => intentClientIds.length).toBe(5);
    await expect.poll(() => completedUploads).toBe(3);
    expect(new Set(intentClientIds).size).toBe(3);
    expect(
      intentUploadModes.filter((mode) => mode === "direct_mobile"),
    ).toHaveLength(3);
    expect(
      intentUploadModes.filter((mode) => mode === "offline_queue"),
    ).toHaveLength(2);
    expect(uploadedObjectByteCounts.size).toBe(3);
    expect(
      Array.from(uploadedObjectByteCounts.values()).every(
        (byteCount) => byteCount > 0,
      ),
    ).toBe(true);
    expect(
      uploadedObjectByteCounts.get(
        mediaIds.get("22222222-2222-4222-8222-222222222222") ?? "",
      ),
    ).toBe(browserDecodablePng.byteLength);
    await expect.poll(() => input.inputValue()).toBe("");
    await expect
      .poll(() =>
        page.evaluate(
          ({ employeeStore, appointmentId: expectedAppointmentId }) =>
            new Promise<number>((resolve, reject) => {
              const request = indexedDB.open("stonegate-mobile", 3);
              request.onerror = () => reject(request.error);
              request.onsuccess = () => {
                const database = request.result;
                const transaction = database.transaction(
                  employeeStore,
                  "readonly",
                );
                const getAll = transaction.objectStore(employeeStore).getAll();
                getAll.onerror = () => reject(getAll.error);
                getAll.onsuccess = () => {
                  const remaining = (
                    getAll.result as Array<{ appointmentId?: string }>
                  ).filter(
                    (row) => row.appointmentId === expectedAppointmentId,
                  ).length;
                  database.close();
                  resolve(remaining);
                };
              };
            }),
          {
            employeeStore: "media-upload-queue",
            appointmentId,
          },
        ),
      )
      .toBe(0);
    expect(
      await page.evaluate(
        () =>
          (
            window as Window & {
              __mediaQueueRewriteAttempts?: () => number;
            }
          ).__mediaQueueRewriteAttempts?.() ?? -1,
      ),
    ).toBe(0);
  });

  test("keeps a queued photo when finalization is not verified ready", async ({
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
            quotedScopeText: "Remove the photographed item.",
            mediaSummary: {
              readyCount: 0,
              pendingCount: 0,
              coverMediaId: null,
              needsScope: false,
            },
            items: [],
            legacyAttachments: [],
          }),
        });
      },
    );

    const mediaId = "33333333-3333-4333-8333-333333333333";
    let completeRequests = 0;
    await page.route(
      `**/api/mobile/appointments/${appointmentId}/media/upload-intents`,
      async (route) => {
        const origin = new URL(route.request().url()).origin;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            intents: [
              {
                mediaId,
                uploadUrl: `${origin}/__e2e/unverified-media-object`,
                headers: {},
                alreadyCompleted: false,
              },
            ],
          }),
        });
      },
    );
    await page.route("**/__e2e/unverified-media-object", async (route) => {
      await route.fulfill({ status: 200, body: "" });
    });
    await page.route(
      `**/api/mobile/appointment-media/${mediaId}/complete`,
      async (route) => {
        completeRequests += 1;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
      },
    );

    await page.goto(`/mobile?screen=calendar&date=${easternDayKey(startAt)}`);
    const card = page.locator(`[data-appointment-id="${appointmentId}"]`);
    await card.getByRole("button", { name: /E2E Contact/u }).click();
    await card.getByText("Quoted Work", { exact: true }).click();
    const input = page
      .locator("label", { hasText: "Choose photos" })
      .locator('input[type="file"]');
    await input.setInputFiles({
      name: "unverified.png",
      mimeType: "image/png",
      buffer: browserDecodablePng,
    });

    await expect.poll(() => completeRequests).toBeGreaterThan(0);
    await expect.poll(() => input.inputValue()).toBe("");
    await expect
      .poll(() =>
        page.evaluate(
          (expectedAppointmentId) =>
            new Promise<number>((resolve, reject) => {
              const request = indexedDB.open("stonegate-mobile", 3);
              request.onerror = () => reject(request.error);
              request.onsuccess = () => {
                const database = request.result;
                const transaction = database.transaction(
                  "media-upload-queue",
                  "readonly",
                );
                const getAll = transaction
                  .objectStore("media-upload-queue")
                  .getAll();
                getAll.onerror = () => reject(getAll.error);
                getAll.onsuccess = () => {
                  const remaining = (
                    getAll.result as Array<{ appointmentId?: string }>
                  ).filter(
                    (row) => row.appointmentId === expectedAppointmentId,
                  ).length;
                  database.close();
                  resolve(remaining);
                };
              };
            }),
          appointmentId,
        ),
      )
      .toBe(1);
  });

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
                thumbnailUrl: `data:image/png;base64,${browserDecodablePng.toString("base64")}`,
                displayUrl: `data:image/png;base64,${browserDecodablePng.toString("base64")}`,
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

    const card = page.locator(`[data-appointment-id="${appointmentId}"]`);
    const cardToggle = card.getByRole("button", { name: /E2E Contact/u });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await cardToggle.click();
    await expect(cardToggle).toHaveAttribute("aria-expanded", "true");

    await card.getByText("Quoted Work", { exact: true }).click();
    await expect(
      page.getByText(
        "Remove the sectional and boxed garage items shown in the photos.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Manage quoted work" }),
    ).toBeVisible();
    await expect(
      page.getByRole("img", { name: "Sectional in garage" }),
    ).toBeVisible();
    await expect(page.getByText("Customer MMS", { exact: true })).toBeVisible();
    await expect(page.getByText("Take photos", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Choose photos", { exact: true }),
    ).toBeVisible();

    await card.getByText("Payment", { exact: true }).click();
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
    await page.getByText("Edit final job total", { exact: true }).click();
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
          name: tender,
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

      const card = page.locator(`[data-appointment-id="${appointmentId}"]`);
      const cardToggle = card.getByRole("button", {
        name: /E2E Contact/u,
      });
      await cardToggle.click();
      await expect(cardToggle).toHaveAttribute("aria-expanded", "false");
      await expect(card.getByText("Paid", { exact: true })).toBeVisible();
      await expect(card.getByText("$325 due", { exact: true })).toHaveCount(0);

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
    browserName,
    isMobile,
  }, testInfo) => {
    test.skip(
      !isMobile,
      "This workflow is covered by the mobile browser projects.",
    );
    test.setTimeout(240_000);

    const { appointmentId, startAt } = await seededAppointment();
    const photoCaption = `${browserName} blue chair ${testInfo.retry}-${Date.now()}`;

    await page.goto(`/mobile?screen=calendar&date=${easternDayKey(startAt)}`);
    const card = page.locator(`[data-appointment-id="${appointmentId}"]`);
    const cardToggle = card.getByRole("button", {
      name: /E2E Contact/u,
    });
    await cardToggle.click();
    await page.getByText("Quoted Work", { exact: true }).click();
    await page.getByRole("button", { name: "Manage quoted work" }).click();

    const scope = page.locator('textarea[placeholder^="Example: Remove"]');
    await scope.fill("Remove the blue chair shown in the crew photo.");
    const scopeSaved = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        new URL(response.url()).pathname ===
          `/api/mobile/appointments/${appointmentId}/quoted-scope` &&
        response.ok(),
      { timeout: 45_000 },
    );
    await page.getByRole("button", { name: "Save scope" }).click();
    await scopeSaved;
    await expect(page.getByText("Quoted scope saved.")).toBeVisible({
      timeout: 30_000,
    });

    await page.getByPlaceholder("Items behind the shed").fill(photoCaption);
    const readyMediaLoaded = page.waitForResponse(
      async (response) => {
        if (
          response.request().method() !== "GET" ||
          new URL(response.url()).pathname !==
            `/api/mobile/appointments/${appointmentId}/media` ||
          !response.ok()
        ) {
          return false;
        }
        try {
          const payload = (await response.json()) as {
            items?: Array<{ caption?: string | null; status?: string }>;
          };
          return (
            payload.items?.some(
              (item) =>
                item.caption === photoCaption && item.status === "ready",
            ) ?? false
          );
        } catch {
          return false;
        }
      },
      { timeout: 105_000 },
    );
    await page
      .locator('input[type="file"][multiple][accept*="image/jpeg"]')
      .setInputFiles({
        name: "blue-chair.png",
        mimeType: "image/png",
        buffer: browserDecodablePng,
      });

    await readyMediaLoaded;
    const uploadedPhoto = page.getByRole("img", { name: photoCaption });
    await expect(uploadedPhoto).toBeVisible({
      timeout: 30_000,
    });
    const uploadedPhotoCard = uploadedPhoto
      .locator("xpath=..")
      .locator("xpath=..");
    await expect(
      uploadedPhotoCard.getByText("Staff photo", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("blue-chair.jpg", { exact: true })).toHaveCount(
      0,
    );

    await cardToggle.click();
    await expect(cardToggle).toHaveAttribute("aria-expanded", "false");
    await expect(
      card.getByText(
        "Quoted work: Remove the blue chair shown in the crew photo.",
        { exact: true },
      ),
    ).toBeVisible();
    const photoCount = card.getByText(/^\d+ photos?$/u);
    await expect(photoCount).toBeVisible();
    await expect
      .poll(async () =>
        Number.parseInt((await photoCount.textContent()) ?? "0", 10),
      )
      .toBeGreaterThan(0);
    await expect(card.getByText("Scope needed", { exact: true })).toHaveCount(
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
          const request = indexedDB.open("stonegate-mobile", 3);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const transactionDone = (transaction: IDBTransaction) =>
          new Promise<void>((resolve, reject) => {
            transaction.oncomplete = () => resolve();
            transaction.onerror = () =>
              reject(
                transaction.error ??
                  new Error("The offline test transaction failed."),
              );
            transaction.onabort = () =>
              reject(
                transaction.error ??
                  new Error("The offline test transaction was aborted."),
              );
          });
        const now = Date.now();
        const snapshotTransaction = database.transaction(
          "appointment-snapshots",
          "readwrite",
        );
        const snapshotDone = transactionDone(snapshotTransaction);
        snapshotTransaction.objectStore("appointment-snapshots").put({
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
        await snapshotDone;

        const queueTransaction = database.transaction(
          "media-upload-queue",
          "readwrite",
        );
        const queueDone = transactionDone(queueTransaction);
        queueTransaction.objectStore("media-upload-queue").put({
          clientId,
          employeeId,
          appointmentId,
          filename: "recover-me.jpg",
          contentType: "image/jpeg",
          byteCount: 3,
          checksumSha256: "0".repeat(64),
          caption: null,
          quotedScopeText: null,
          bytes: new Uint8Array([1, 2, 3]).buffer.slice(0),
          capturedOffline: true,
          status: "finalizing",
          error: null,
          attempts: 1,
          createdAt: now - 25 * 60 * 60 * 1000,
          updatedAt: now - 11 * 60 * 1000,
        });
        await queueDone;
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
          const request = indexedDB.open("stonegate-mobile", 3);
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
        const request = indexedDB.open("stonegate-mobile", 3);
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
    const card = page.locator(`[data-appointment-id="${appointmentId}"]`);
    await card.getByRole("button", { name: /E2E Contact/u }).click();
    await expect(card.getByText("Payment", { exact: true })).toHaveCount(0);

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

test.describe("Mobile appointment action permission boundary", () => {
  test.use({
    storageState: "tests/e2e/storage/mobile-appointment-update-denied.json",
  });

  test("keeps messaging available without appointment update access", async ({
    page,
    isMobile,
  }) => {
    test.skip(
      !isMobile,
      "This workflow is covered by the mobile browser projects.",
    );

    const { appointmentId, startAt } = await seededAppointment();
    const appointmentDay = easternDayKey(startAt);

    for (const screen of ["myday", "calendar"] as const) {
      await page.goto(`/mobile?screen=${screen}&date=${appointmentDay}`);
      const card = page.locator(`[data-appointment-id="${appointmentId}"]`);
      const toggle = card.getByRole("button", {
        name: /E2E Contact/u,
      });

      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await toggle.click();
      await expect(
        card.getByRole("button", { name: "Message", exact: true }),
      ).toBeVisible();
      await expect(card.getByText("Complete job", { exact: true })).toHaveCount(
        0,
      );
      await expect(
        card.getByText("More appointment actions", { exact: true }),
      ).toHaveCount(0);
      await expect(card.getByText("Add note", { exact: true })).toHaveCount(0);
    }
  });
});
