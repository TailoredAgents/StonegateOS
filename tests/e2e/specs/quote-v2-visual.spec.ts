import { readFileSync } from "node:fs";
import path from "node:path";
import type { Page, Route, TestInfo } from "@playwright/test";
import { expectTeamStateToPassAutomatedWcag } from "../audit/accessibility";
import { expect, test } from "../test";
import {
  acceptQuoteV2E2EFixture,
  archiveQuoteV2E2EFixtures,
  bookQuoteV2E2EFixture,
  closeQuoteV2E2EFixtureConnection,
  createQuoteV2E2EFixture,
  declineQuoteV2E2EFixture,
  issueQuoteV2E2EFixtureRevision,
  requestQuoteV2E2EFixtureChanges,
  supersedeQuoteV2E2EFixture,
  type QuoteV2E2EFixture,
} from "../support/quote-v2";

const VISUAL_ISSUED_AT = new Date("2026-08-30T15:00:00.000Z");
const VISUAL_EXPIRES_AT = new Date("2035-09-29T15:00:00.000Z");
const VISUAL_BROWSER_TIME = new Date("2026-08-31T16:00:00.000Z");
const STABLE_QUOTE_NUMBER = "Q-VISUAL-0001";
const DYNAMIC_LONG_LIVED_EXPIRY = "Sep 29, 2035";
const STABLE_DISPLAY_EXPIRY = "Sep 29, 2026";
// Embedded fonts, fixed time, and disabled motion make Chromium highly stable.
// A 0.2% allowance tolerates residual host rasterization noise while remaining
// well below the footprint of a changed 44px CTA, banner, or proposal card.
const MAX_VISUAL_DIFF_RATIO = 0.002;

function embeddedNotoSans(weight: 400 | 600 | 700): string {
  return readFileSync(
    path.resolve(
      process.cwd(),
      `apps/api/node_modules/@fontsource/noto-sans/files/noto-sans-latin-${weight}-normal.woff2`,
    ),
  ).toString("base64");
}

const VISUAL_FONT_CSS = ([400, 600, 700] as const)
  .map(
    (weight) => `
      @font-face {
        font-family: "Quote Visual Noto Sans";
        font-style: normal;
        font-weight: ${weight};
        font-display: block;
        src: url("data:font/woff2;base64,${embeddedNotoSans(weight)}") format("woff2");
      }
    `,
  )
  .join("\n");

type VisualState =
  | "populated"
  | "loading"
  | "empty"
  | "provider-error"
  | "expired"
  | "superseded"
  | "declined"
  | "revised"
  | "changes-requested"
  | "accepted"
  | "deposit-due"
  | "booked";

type AvailabilityMode = "available" | "loading" | "empty" | "error";

const VISUAL_SURFACES = [
  {
    name: "desktop-light",
    viewport: { width: 1280, height: 900 },
    colorScheme: "light",
    label: "desktop light",
  },
  {
    name: "desktop-dark",
    viewport: { width: 1280, height: 900 },
    colorScheme: "dark",
    label: "desktop dark",
  },
  {
    name: "mobile-light",
    viewport: { width: 375, height: 844 },
    colorScheme: "light",
    label: "mobile light",
  },
  {
    name: "mobile-dark",
    viewport: { width: 375, height: 844 },
    colorScheme: "dark",
    label: "mobile dark",
  },
] as const;

test.use({
  storageState: "tests/e2e/storage/visitor.json",
  serviceWorkers: "block",
});
test.describe.configure({ mode: "serial" });
test.afterEach(async () => archiveQuoteV2E2EFixtures());
test.afterAll(async () => closeQuoteV2E2EFixtureConnection());

function availabilityPath(fixture: QuoteV2E2EFixture): string {
  return `**/api/public/quotes/${fixture.token}/availability`;
}

function fulfillAvailability(
  route: Route,
  mode: Exclude<AvailabilityMode, "loading">,
  fixture: QuoteV2E2EFixture,
): Promise<void> {
  if (mode === "error") {
    return route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        code: "provider_unavailable",
        message: "Calendar provider unavailable",
        retryable: true,
        correlationId: "quote-v2-visual-provider-error",
      }),
    });
  }
  const slots =
    mode === "available"
      ? [
          {
            startAt: "2030-02-01T14:00:00.000Z",
            endAt: "2030-02-01T16:00:00.000Z",
            label: "Fri, Feb 1 · 9:00 AM",
          },
          {
            startAt: "2030-02-01T17:00:00.000Z",
            endAt: "2030-02-01T19:00:00.000Z",
            label: "Fri, Feb 1 · 12:00 PM",
          },
          {
            startAt: "2030-02-02T15:00:00.000Z",
            endAt: "2030-02-02T17:00:00.000Z",
            label: "Sat, Feb 2 · 10:00 AM",
          },
        ]
      : [];
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      availability: {
        state: mode === "available" ? "available" : "empty",
        quoteId: fixture.quoteId,
        versionId: fixture.versionId,
        responseId: null,
        timezone: "America/New_York",
        durationMinutes: 120,
        travelBufferMinutes: 30,
        arrivalWindowMeaning:
          "The selected time is the scheduled service start in the timezone shown. Stonegate will confirm any separate arrival window in the booking confirmation.",
        recommendedSlots: slots,
        days: [{ date: "2030-02-01", slots }],
        generatedAt: "2026-08-31T16:00:00.000Z",
      },
    }),
  });
}

async function createVisualFixture(
  state: VisualState,
): Promise<QuoteV2E2EFixture> {
  let fixture = await createQuoteV2E2EFixture({
    schedulingMode: ["loading", "empty", "provider-error"].includes(state)
      ? "self_schedule"
      : "staff_followup",
    depositCents: state === "deposit-due" ? 25_000 : 0,
    issuedAt:
      state === "expired"
        ? new Date("2025-01-15T15:00:00.000Z")
        : VISUAL_ISSUED_AT,
    expiresAt:
      state === "expired"
        ? new Date("2025-02-14T15:00:00.000Z")
        : VISUAL_EXPIRES_AT,
  });

  if (state === "superseded") {
    await supersedeQuoteV2E2EFixture(fixture);
  } else if (state === "declined") {
    await declineQuoteV2E2EFixture(fixture);
  } else if (state === "revised") {
    fixture = await issueQuoteV2E2EFixtureRevision(fixture);
  } else if (state === "changes-requested") {
    await requestQuoteV2E2EFixtureChanges(fixture);
  } else if (state === "accepted" || state === "deposit-due") {
    await acceptQuoteV2E2EFixture(fixture);
  } else if (state === "booked") {
    await bookQuoteV2E2EFixture(fixture);
  }
  return fixture;
}

async function normalizeDynamicQuoteText(
  page: Page,
  fixture: QuoteV2E2EFixture,
): Promise<void> {
  await page.evaluate(
    ({
      dynamicQuoteNumber,
      stableQuoteNumber,
      dynamicExpiry,
      stableExpiry,
    }) => {
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
      );
      let node = walker.nextNode();
      while (node) {
        if (node.textContent?.includes(dynamicQuoteNumber)) {
          node.textContent = node.textContent.replaceAll(
            dynamicQuoteNumber,
            stableQuoteNumber,
          );
        }
        if (node.textContent?.includes(dynamicExpiry)) {
          node.textContent = node.textContent.replaceAll(
            dynamicExpiry,
            stableExpiry,
          );
        }
        node = walker.nextNode();
      }
    },
    {
      dynamicQuoteNumber: fixture.quoteNumber,
      stableQuoteNumber: STABLE_QUOTE_NUMBER,
      dynamicExpiry: DYNAMIC_LONG_LIVED_EXPIRY,
      stableExpiry: STABLE_DISPLAY_EXPIRY,
    },
  );
}

async function settleVisualSurface(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `
      ${VISUAL_FONT_CSS}
      html, body, main, main *, input, select, textarea, button {
        font-family: "Quote Visual Noto Sans", sans-serif !important;
      }
      *, *::before, *::after {
        animation: none !important;
        caret-color: transparent !important;
        transition: none !important;
      }
      nextjs-portal, [data-nextjs-toast], [data-next-badge-root] {
        display: none !important;
      }
    `,
  });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    scrollTo(0, 0);
  });
}

async function expectVisualPair(
  page: Page,
  state: VisualState,
  fixture: QuoteV2E2EFixture,
  testInfo: TestInfo,
): Promise<void> {
  for (const surface of VISUAL_SURFACES) {
    await page.setViewportSize(surface.viewport);
    await page.emulateMedia({
      colorScheme: surface.colorScheme,
      reducedMotion: "reduce",
    });
    await settleVisualSurface(page);
    // React may rerender when the viewport/theme changes, so normalize only
    // after each surface has reached its final rendered state.
    await normalizeDynamicQuoteText(page, fixture);
    await expect(page.locator("body")).not.toContainText(fixture.quoteNumber);
    await expect(page.locator("body")).toContainText(STABLE_QUOTE_NUMBER);
    if (state !== "expired") {
      await expect(page.locator("body")).not.toContainText(
        DYNAMIC_LONG_LIVED_EXPIRY,
      );
      await expect(page.locator("body")).toContainText(STABLE_DISPLAY_EXPIRY);
    }
    await expect(page).toHaveScreenshot(
      `quote-v2-${state}-${surface.name}.png`,
      {
        animations: "disabled",
        caret: "hide",
        fullPage: true,
        maxDiffPixelRatio: MAX_VISUAL_DIFF_RATIO,
        scale: "css",
      },
    );
    await expectTeamStateToPassAutomatedWcag({
      page,
      testInfo,
      surface: `Quote V2 customer proposal ${state} ${surface.label}`,
      state:
        state === "empty"
          ? "empty"
          : state === "provider-error"
            ? "error"
            : "normal",
      context: "main",
    });
  }
}

async function prepareState(
  page: Page,
  state: VisualState,
  fixture: QuoteV2E2EFixture,
): Promise<() => void> {
  let releaseLoading = () => {};
  if (state === "loading") {
    let releaseRoute: (() => void) | undefined;
    const routeGate = new Promise<void>((resolve) => {
      releaseRoute = resolve;
    });
    releaseLoading = () => releaseRoute?.();
    await page.route(availabilityPath(fixture), async (route) => {
      await routeGate;
      await route.abort("failed");
    });
  } else if (state === "empty") {
    await page.route(availabilityPath(fixture), (route) =>
      fulfillAvailability(route, "empty", fixture),
    );
  } else if (state === "provider-error") {
    await page.route(availabilityPath(fixture), (route) =>
      fulfillAvailability(route, "error", fixture),
    );
  } else {
    await page.route(availabilityPath(fixture), (route) =>
      fulfillAvailability(route, "available", fixture),
    );
  }

  await page.goto(fixture.publicPath, { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("heading", {
      name: /Fixed quote for North warehouse cleanout/i,
    }),
  ).toBeVisible();

  if (["loading", "empty", "provider-error"].includes(state)) {
    const approveButton = page
      .getByRole("button", { name: "Approve & continue" })
      .first();
    await expect(async () => {
      await approveButton.click();
      await expect(
        page.getByRole("heading", { name: "Approve this proposal" }),
      ).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
  }
  if (state === "loading") {
    await expect(
      page.getByRole("status").filter({
        hasText: "Checking current appointment windows",
      }),
    ).toBeVisible();
  } else if (state === "empty") {
    await expect(
      page.locator('[data-availability-state="empty"]'),
    ).toBeVisible();
  } else if (state === "provider-error") {
    await expect(
      page.locator('[data-availability-state="unavailable"]'),
    ).toBeVisible();
  } else if (state === "expired") {
    await expect(
      page.getByText("Expired · View only", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Request updated proposal" }).first(),
    ).toBeVisible();
  } else if (state === "superseded") {
    await expect(
      page.getByText("Superseded · View only", { exact: true }),
    ).toBeVisible();
  } else if (state === "declined") {
    await expect(
      page.getByText("Declined · View only", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("This proposal was declined", { exact: false }).first(),
    ).toBeVisible();
  } else if (state === "revised") {
    await expect(
      page.getByText("Awaiting your approval", { exact: true }),
    ).toBeVisible();
    await expect(
      page.locator("dt", { hasText: "Version" }).locator(".."),
    ).toContainText("2");
  } else if (state === "changes-requested") {
    await expect(
      page.getByText("Changes requested", { exact: true }),
    ).toBeVisible();
  } else if (state === "accepted") {
    await expect(page.getByText("Approved", { exact: true })).toBeVisible();
  } else if (state === "deposit-due") {
    await expect(
      page.getByText("Approved · Deposit due", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Pay deposit securely" }).first(),
    ).toBeVisible();
  } else if (state === "booked") {
    await expect(page.getByText("Booked", { exact: true })).toBeVisible();
    const appointment = page.locator('[data-appointment-status="confirmed"]');
    await expect(appointment).toHaveCount(1);
    await expect(
      appointment.getByRole("heading", { name: "Appointment confirmed" }),
    ).toBeVisible();
    await expect(appointment).not.toContainText("Promised arrival window");
    await expect(appointment).toContainText("Scheduled start and duration");
    await expect(appointment).toContainText("Feb 1, 2030 · 9:00 AM EST");
    await expect(appointment).toContainText("America/New_York");
    await expect(appointment).toContainText("4 hours");
    await expect(appointment).toContainText("not a separate arrival window");
    await expect(
      appointment.locator('time[datetime="2030-02-01T14:00:00.000Z"]'),
    ).toHaveCount(1);
    await expect(
      appointment.locator('time[datetime="2030-02-01T18:00:00.000Z"]'),
    ).toHaveCount(1);
  } else {
    await expect(
      page.getByText("Awaiting your approval", { exact: true }),
    ).toBeVisible();
  }
  await normalizeDynamicQuoteText(page, fixture);
  return releaseLoading;
}

for (const state of [
  "populated",
  "loading",
  "empty",
  "provider-error",
  "expired",
  "superseded",
  "declined",
  "revised",
  "changes-requested",
  "accepted",
  "deposit-due",
  "booked",
] as const satisfies readonly VisualState[]) {
  test(`${state} proposal remains visually stable`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    testInfo.snapshotSuffix = "";
    await page.clock.setFixedTime(VISUAL_BROWSER_TIME);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    const fixture = await createVisualFixture(state);
    const releaseLoading = await prepareState(page, state, fixture);
    try {
      await expectVisualPair(page, state, fixture, testInfo);
    } finally {
      releaseLoading();
    }
  });
}
