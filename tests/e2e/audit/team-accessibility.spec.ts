import { expect, test } from "@playwright/test";
import { getLatestE2ESeedSummary } from "../support/db";
import { expectTeamStateToPassAutomatedWcag } from "./accessibility";

const OWNER_STORAGE = "tests/e2e/storage/audit-owner.json";
const DESKTOP_A11Y_PROJECT = "a11y-chromium-1440-light";
const PHONE_A11Y_PROJECT = "a11y-chromium-375-dark";
const A11Y_PROJECTS = new Set([DESKTOP_A11Y_PROJECT, PHONE_A11Y_PROJECT]);

const TEAM_SURFACES = [
  ["Calendar", "/team/calendar"],
  ["Inbox", "/team/inbox"],
  ["Contacts", "/team/contacts"],
  ["Quotes", "/team/quotes/manage"],
  ["Expenses", "/team/expenses"],
  ["Pipeline", "/team/sales/pipeline"],
  ["Sales HQ", "/team/sales/hq"],
  ["Outbound", "/team/sales/outbound"],
  ["Partners", "/team/sales/outbound/partners"],
  ["Sales Activity", "/team/sales/hq/activity"],
  ["Marketing Ads", "/team/marketing/ads"],
  ["Marketing Website", "/team/marketing/website"],
  ["Marketing SEO", "/team/marketing/seo"],
  ["Owner HQ", "/team/owner"],
  ["Policy Center", "/team/admin/policy"],
  ["Messaging Automation", "/team/admin/automation"],
  ["Commissions", "/team/admin/commissions"],
  ["Access", "/team/admin/access"],
  ["Audit Log", "/team/admin/audit"],
  ["Merge Queue", "/team/admin/merge"],
  ["Agent", "/team/tools/agent"],
  ["Simulator", "/team/tools/simulator"],
  ["Settings", "/team/settings"],
] as const;

test.describe("authenticated Team WCAG scans @team-a11y", () => {
  test.use({ storageState: OWNER_STORAGE });

  test.beforeEach(async ({ page }, testInfo) => {
    if (!A11Y_PROJECTS.has(testInfo.project.name)) {
      throw new Error(
        `The Team accessibility suite ran in unsupported project ${testInfo.project.name}.`,
      );
    }
    testInfo.setTimeout(90_000);
    const theme =
      testInfo.project.metadata["auditTheme"] === "dark" ? "dark" : "light";
    await page.addInitScript((value) => {
      globalThis.localStorage.setItem("team.theme.v1", value);
    }, theme);
    await page.emulateMedia({ reducedMotion: "reduce" });
  });

  for (const [surface, route] of TEAM_SURFACES) {
    test(`${surface} normal state passes the serious/critical gate`, async ({
      page,
    }, testInfo) => {
      const response = await page.goto(route, {
        waitUntil: "domcontentloaded",
      });
      expect(response?.status() ?? 599).toBeLessThan(500);
      await expect(page).not.toHaveURL(/\/team\/login/u);
      await expect(page.locator("main")).toBeVisible();
      await expectTeamStateToPassAutomatedWcag({
        page,
        testInfo,
        surface,
        state: "normal",
      });
    });
  }

  test("representative empty, error, modal, and drawer states pass the automated gate", async ({
    page,
  }, testInfo) => {
    if (testInfo.project.name === DESKTOP_A11Y_PROJECT) {
      await test.step("empty Contacts result", async () => {
        await page.goto("/team/contacts?q=wcag-empty-state-no-match", {
          waitUntil: "domcontentloaded",
        });
        await expect(
          page.getByText("No contacts yet.", { exact: true }),
        ).toBeVisible();
        await expectTeamStateToPassAutomatedWcag({
          page,
          testInfo,
          surface: "Contacts",
          state: "empty",
        });
      });

      await test.step("authenticated instant-quote error", async () => {
        await page.goto("/team/instant-quotes/not-a-real-quote", {
          waitUntil: "domcontentloaded",
        });
        await expect(page.getByRole("alert")).toContainText("Quote not found");
        await expectTeamStateToPassAutomatedWcag({
          page,
          testInfo,
          surface: "Instant quote detail",
          state: "error",
        });
      });

      await test.step("Inbox workflow modal", async () => {
        const seed = await getLatestE2ESeedSummary();
        if (!seed) {
          throw new Error(
            "The disposable audit database is missing its E2E seed.",
          );
        }
        await page.goto(
          `/team/inbox?contactId=${encodeURIComponent(seed.contactId)}&channel=sms`,
          { waitUntil: "domcontentloaded" },
        );
        await expect(page.getByText("Customer workspace")).toBeVisible();
        await page.getByRole("button", { name: "Create quote" }).click();
        const dialog = page.getByRole("dialog", { name: "Create quote" });
        await expect(dialog).toBeVisible();
        await expectTeamStateToPassAutomatedWcag({
          page,
          testInfo,
          surface: "Inbox workflow",
          state: "modal",
        });
      });
      return;
    }

    await test.step("mobile navigation drawer", async () => {
      await page.goto("/team/settings", { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "Open navigation" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await expectTeamStateToPassAutomatedWcag({
        page,
        testInfo,
        surface: "Team shell navigation",
        state: "drawer",
      });
    });
  });
});
