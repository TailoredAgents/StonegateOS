import { test, expect } from "../test";
import {
  createE2EMobileAppointment,
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
  if (!seed) throw new Error("The E2E seed did not create a contact.");
  return createE2EMobileAppointment({
    contactId: seed.contactId,
    propertyId: seed.propertyId,
    quotedScopeText: "Remove the sectional and every boxed garage item.",
    finalTotalCents: 32_500,
  });
}

test.describe("Mobile final-total and payout refresh regressions", () => {
  test.use({
    storageState: "tests/e2e/storage/mobile-owner.json",
    serviceWorkers: "block",
  });

  test("accepts a newer server payment summary without replacing a dirty total edit", async ({
    page,
    browserName,
    isMobile,
  }) => {
    test.skip(
      !isMobile || browserName !== "chromium",
      "One mobile engine is sufficient for this focused React reconciliation regression.",
    );

    const { appointmentId, startAt } = await seededAppointment();
    await page.goto(`/mobile?screen=calendar&date=${easternDayKey(startAt)}`);

    const card = page.locator(`[data-appointment-id="${appointmentId}"]`);
    const cardToggle = card.getByRole("button", { name: /E2E Contact/u });
    await expect(card).toBeVisible();
    await cardToggle.click();

    await card.getByText("Payment", { exact: true }).click();
    await expect(card.getByText("$325.00 remaining")).toBeVisible();
    await expect(
      card.getByText("No payments recorded.", { exact: true }),
    ).toBeVisible();
    await card.getByText("Edit final job total", { exact: true }).click();

    const finalTotalInput = card.locator('input[placeholder="350.00"]');
    await finalTotalInput.fill("500.00");
    await expect(
      card.getByRole("button", { name: "Save final job total" }),
    ).toBeEnabled();

    const externalUpdate = await page.request.put(
      `/api/mobile/appointments/${appointmentId}/final-total`,
      {
        data: { finalTotalCents: 47_500 },
      },
    );
    expect(
      externalUpdate.ok(),
      await externalUpdate.text().catch(() => "final-total update failed"),
    ).toBe(true);

    await card.getByText("Quoted Work", { exact: true }).click();
    await card.getByRole("button", { name: "Manage quoted work" }).click();
    const scope = card.getByPlaceholder(
      "Example: Remove the sectional, two mattresses, and boxed garage items shown below.",
    );
    await expect(scope).toBeVisible();
    await scope.fill(
      "Remove the sectional and every boxed garage item; scope reconfirmed.",
    );
    await card.getByRole("button", { name: "Save scope" }).click();
    await expect(
      card.getByText(
        "Quoted scope saved. Any waiting photos will upload now.",
        { exact: true },
      ),
    ).toBeVisible();

    await expect(card.getByText("$475.00 remaining")).toBeVisible();
    await expect(finalTotalInput).toHaveValue("500.00");
    await expect(
      card.getByRole("button", { name: "Save final job total" }),
    ).toBeEnabled();
  });

  test("shows payout refresh progress, ignores duplicate clicks, and reports the refreshed timestamp", async ({
    page,
    browserName,
    isMobile,
  }) => {
    test.skip(
      !isMobile || browserName !== "chromium",
      "One mobile engine is sufficient for this focused client-button regression.",
    );
    test.setTimeout(120_000);

    const initialRefresh = await page.request.post(
      "/api/mobile/owner/payout-runs/refresh",
    );
    const initialPayload = (await initialRefresh.json()) as {
      ok?: boolean;
      payoutRunId?: string;
      reportGeneratedAt?: string | null;
    };
    expect(initialRefresh.ok(), JSON.stringify(initialPayload)).toBe(true);
    expect(initialPayload.ok).toBe(true);
    expect(initialPayload.payoutRunId).toBeTruthy();
    expect(initialPayload.reportGeneratedAt).toBeTruthy();

    await page.goto("/mobile?screen=owner");
    const refreshButton = page.getByRole("button", {
      name: "Refresh current payout",
    });
    await expect(refreshButton).toBeVisible();
    await expect(page.getByText(/^Report ready /u).first()).toBeVisible();

    let requestCount = 0;
    let markRequestStarted!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    let releaseRequest!: () => void;
    const requestGate = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    await page.route(
      "**/api/mobile/owner/payout-runs/refresh",
      async (route) => {
        requestCount += 1;
        markRequestStarted();
        await requestGate;
        await route.continue();
      },
    );

    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().includes("/api/mobile/owner/payout-runs/refresh") &&
        response.request().method() === "POST",
    );
    await refreshButton.click();
    await requestStarted;

    await expect(refreshButton).toBeDisabled();
    await expect(refreshButton).toHaveAttribute("aria-busy", "true");
    await expect(
      page.getByText(
        "Recalculating completed jobs and rebuilding the report. Keep this screen open.",
        { exact: true },
      ),
    ).toBeVisible();

    await refreshButton.evaluate((element) =>
      (element as HTMLButtonElement).click(),
    );
    expect(requestCount).toBe(1);
    await expect(refreshButton).toHaveText(/Refreshing… [1-9]\d*s/u, {
      timeout: 4_000,
    });

    releaseRequest();
    const response = await responsePromise;
    expect(response.ok(), await response.text()).toBe(true);

    await expect(
      page.getByText(/^Payout ready\. Report refreshed at .+\.$/u),
    ).toBeVisible();
    await expect(refreshButton).toBeEnabled();
    await expect(refreshButton).toHaveText("Refresh current payout");
    await expect(page.getByText(/^Report ready /u).first()).toBeVisible();
  });
});
