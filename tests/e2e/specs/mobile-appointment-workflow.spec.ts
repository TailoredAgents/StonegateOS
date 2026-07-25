import { expect, test } from "../test";
import {
  getAppointmentStartAt,
  getLatestE2ESeedSummary,
} from "../support/db";

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

test.describe("Mobile appointment quoted work", () => {
  test.use({ storageState: "tests/e2e/storage/mobile-owner.json" });

  test("shows the shared scope and gallery controls", async ({
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

    await page.goto(`/mobile?screen=calendar&date=${easternDayKey(startAt)}`);
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
    await expect(page.getByText("Choose photos", { exact: true })).toBeVisible();
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
  });

  test("keeps an unsynced photo recoverable after its snapshot expires", async ({
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
    await expect(page.getByText("recover-me.jpg", { exact: true })).toBeVisible();
    await expect(page.getByText("Upload interrupted", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Discard" })).toBeVisible();

    await page.context().setOffline(false);
  });
});
