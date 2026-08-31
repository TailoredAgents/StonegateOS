import { readFileSync } from "node:fs";
import path from "node:path";
import type { Page, Route, TestInfo } from "@playwright/test";
import { expectTeamStateToPassAutomatedWcag } from "../audit/accessibility";
import { expect, test } from "../test";

const STAFF_BROWSER_TIME = new Date("2026-08-31T16:00:00.000Z");
const STAFF_QUOTE_ID = "8be9753a-8eb2-4da6-931e-36d9daff069b";
const STAFF_VERSION_ID = "e464d459-f8e6-46e4-8bd7-929d2e2ebf63";
const STAFF_CONTACT_ID = "2d5ce865-f4a4-4db1-8434-dfc24698e630";
const STAFF_PROPERTY_ID = "292e239b-a32e-4ad7-b1f5-1c746190b155";
const STAFF_QUOTE_NUMBER = "Q-STAFF-VISUAL-0001";
const MAX_VISUAL_DIFF_RATIO = 0.002;

const STAFF_SURFACES = [
  {
    name: "desktop-light",
    viewport: { width: 1440, height: 1000 },
    colorScheme: "light",
    label: "desktop light",
  },
  {
    name: "desktop-dark",
    viewport: { width: 1440, height: 1000 },
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

function embeddedNotoSans(weight: 400 | 600 | 700): string {
  return readFileSync(
    path.resolve(
      process.cwd(),
      `apps/api/node_modules/@fontsource/noto-sans/files/noto-sans-latin-${weight}-normal.woff2`,
    ),
  ).toString("base64");
}

const STAFF_FONT_CSS = ([400, 600, 700] as const)
  .map(
    (weight) => `
      @font-face {
        font-family: "Quote Staff Visual Noto Sans";
        font-style: normal;
        font-weight: ${weight};
        font-display: block;
        src: url("data:font/woff2;base64,${embeddedNotoSans(weight)}") format("woff2");
      }
    `,
  )
  .join("\n");

test.use({
  storageState: "tests/e2e/storage/mobile-owner.json",
  serviceWorkers: "block",
});
test.describe.configure({ mode: "serial" });

function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "x-correlation-id": "quote-v2-staff-visual" },
    body: JSON.stringify(body),
  });
}

function draftReceipt(quoteRevision: number, draftRevision: number) {
  return {
    ok: true,
    data: {
      quoteId: STAFF_QUOTE_ID,
      versionId: STAFF_VERSION_ID,
      quoteRevision,
      draftRevision,
      totals: null,
    },
  };
}

async function mockCreateWorkspace(page: Page): Promise<void> {
  let quoteRevision = 1;
  let draftRevision = 1;
  await page.route("**/api/team/contacts?*", (route) =>
    fulfillJson(route, {
      contacts: [
        {
          id: STAFF_CONTACT_ID,
          name: "Avery Facilities",
          companyName: "Northstar Commerce",
          title: "Facilities Manager",
          email: "avery.visual@mystos.test",
          phoneE164: "+14045550177",
          properties: [
            {
              id: STAFF_PROPERTY_ID,
              label: "200 Service Way, Atlanta, GA 30302",
              billingLabel: "100 Billing Plaza, Atlanta, GA 30303",
            },
          ],
        },
      ],
    }),
  );
  await page.route("**/api/team/quotes/v2/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "POST" && pathname.endsWith("/quotes")) {
      return fulfillJson(
        route,
        draftReceipt(quoteRevision, draftRevision),
        201,
      );
    }
    if (request.method() === "PATCH" && pathname.endsWith("/draft")) {
      draftRevision =
        Number(request.headers()["if-match"] ?? draftRevision) + 1;
      quoteRevision += 1;
      return fulfillJson(route, draftReceipt(quoteRevision, draftRevision));
    }
    if (request.method() === "GET" && pathname.endsWith("/attachments")) {
      return fulfillJson(route, { ok: true, attachments: [] });
    }
    return fulfillJson(
      route,
      {
        ok: false,
        code: "not_found",
        message: `Unexpected staff visual request: ${request.method()} ${pathname}`,
        retryable: false,
        correlationId: "quote-v2-staff-visual",
      },
      404,
    );
  });
}

async function mockManageWorkspace(page: Page): Promise<void> {
  await page.route("**/api/team/quotes/v2/quotes?*", (route) =>
    fulfillJson(route, {
      quotes: [
        {
          id: STAFF_QUOTE_ID,
          quoteNumber: STAFF_QUOTE_NUMBER,
          aggregateState: "open",
          quoteRevision: 3,
          currentVersionId: STAFF_VERSION_ID,
          publishedVersionId: STAFF_VERSION_ID,
          versionNumber: 2,
          versionState: "issued",
          documentType: "fixed_quote",
          audience: "commercial",
          client: {
            name: "Avery Facilities",
            company: "Northstar Commerce",
          },
          project: {
            name: "North warehouse cleanout",
            purchaseOrder: "PO-VISUAL-2026",
            property: {
              addressLine1: "200 Service Way",
              city: "Atlanta",
              state: "GA",
            },
          },
          totals: {
            minimumCents: 125_000,
            maximumCents: 125_000,
            depositCents: 25_000,
            currency: "USD",
          },
          expiresAt: "2026-09-29T15:00:00.000Z",
          updatedAt: "2026-08-31T15:45:00.000Z",
          deliveryState: "delivered",
          owner: {
            id: "7c74c486-45d4-4208-a650-a252ac3b3714",
            name: "E2E Sales Owner",
          },
          bucket: "awaiting_client",
          nextAction: {
            code: "await_client_response",
            label: "Await client response",
          },
        },
      ],
      nextCursor: null,
    }),
  );
}

async function settleStaffSurface(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `
      ${STAFF_FONT_CSS}
      html, body, main, main *, input, select, textarea, button {
        font-family: "Quote Staff Visual Noto Sans", sans-serif !important;
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

async function setStaffTheme(
  page: Page,
  theme: "light" | "dark",
): Promise<void> {
  const shell = page.locator(".team-theme-light, .team-theme-dark").first();
  await expect(shell).toBeVisible();
  const desiredClass = `team-theme-${theme}`;
  if (
    !(await shell.evaluate(
      (element, className) => element.classList.contains(className),
      desiredClass,
    ))
  ) {
    await page
      .locator(`button[aria-label="Use ${theme} theme"]:visible`)
      .first()
      .click();
  }
  await expect(shell).toHaveClass(
    new RegExp(`(?:^|\\s)${desiredClass}(?:\\s|$)`, "u"),
  );
}

async function expectStaffVisualMatrix(
  page: Page,
  workspace: "create" | "manage",
  testInfo: TestInfo,
): Promise<void> {
  for (const surface of STAFF_SURFACES) {
    await page.setViewportSize(surface.viewport);
    await page.emulateMedia({
      colorScheme: surface.colorScheme,
      reducedMotion: "reduce",
    });
    await setStaffTheme(page, surface.colorScheme);
    await settleStaffSurface(page);
    const dimensions = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
    await expect(page).toHaveScreenshot(
      `quote-v2-staff-${workspace}-${surface.name}.png`,
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
      surface: `Quote V2 staff ${workspace} workspace ${surface.label}`,
      state: "normal",
    });
  }
}

test("staff Create workspace remains visually stable", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  testInfo.snapshotSuffix = "";
  await page.clock.setFixedTime(STAFF_BROWSER_TIME);
  await page.addInitScript(() => globalThis.localStorage.clear());
  await mockCreateWorkspace(page);
  await page.goto("/team/quotes/create", { waitUntil: "domcontentloaded" });
  await expect(page).not.toHaveURL(/\/team\/login/u);
  await expect(
    page.getByRole("heading", { name: "Create professional quote" }),
  ).toBeVisible();
  await page.getByRole("radio", { name: /commercial/i }).check();
  await page.getByLabel("Search clients").fill("Northstar");
  await page
    .getByRole("button", { name: /Northstar Commerce · Avery Facilities/i })
    .click();
  await page.getByLabel("Service property").selectOption(STAFF_PROPERTY_ID);
  await page.getByLabel("Service zone").selectOption("zone-core");
  await page.getByRole("checkbox", { name: /I confirmed this zone/i }).check();
  await page.getByLabel("Project name").fill("North warehouse cleanout");
  await expect(
    page.getByText("Server draft saved", { exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  await expectStaffVisualMatrix(page, "create", testInfo);
});

test("staff Manage workspace remains visually stable", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  testInfo.snapshotSuffix = "";
  await page.clock.setFixedTime(STAFF_BROWSER_TIME);
  await mockManageWorkspace(page);
  await page.goto("/team/quotes/manage", { waitUntil: "domcontentloaded" });
  await expect(page).not.toHaveURL(/\/team\/login/u);
  await expect(
    page.getByRole("heading", { name: "Manage quotes" }),
  ).toBeVisible();
  await page
    .getByLabel(
      "Search quote number, client, company, project, property, or PO",
    )
    .fill(STAFF_QUOTE_NUMBER);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(
    page.getByText(STAFF_QUOTE_NUMBER, { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("Northstar Commerce", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("Await client response", { exact: true }),
  ).toBeVisible();
  await expectStaffVisualMatrix(page, "manage", testInfo);
});
