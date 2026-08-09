import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { ensureE2EEnv, getEnvVar } from "./tests/e2e/support/env";

ensureE2EEnv();

const siteBaseUrl = getEnvVar("NEXT_PUBLIC_SITE_URL", "http://localhost:3000");

const viewportCases = [
  {
    id: "1440",
    base: devices["Desktop Chrome"],
    viewport: { width: 1440, height: 1000 },
  },
  {
    id: "1024",
    base: devices["Desktop Chrome"],
    viewport: { width: 1024, height: 900 },
  },
  {
    id: "768",
    base: devices["Desktop Chrome"],
    viewport: { width: 768, height: 1024 },
  },
  {
    id: "375",
    base: devices["Pixel 7"],
    viewport: { width: 375, height: 812 },
  },
  {
    id: "320",
    base: devices["Pixel 7"],
    viewport: { width: 320, height: 740 },
  },
] as const;

const auditProjects = viewportCases.flatMap((entry) =>
  (["light", "dark"] as const).map((theme) => ({
    name: `chromium-${entry.id}-${theme}`,
    grepInvert: /@team-a11y/u,
    metadata: { auditTheme: theme },
    use: {
      ...entry.base,
      viewport: entry.viewport,
    },
  })),
);

const accessibilityProjects = [
  {
    name: "a11y-chromium-1440-light",
    grep: /@team-a11y/u,
    metadata: { auditTheme: "light" },
    use: {
      ...devices["Desktop Chrome"],
      viewport: { width: 1440, height: 1000 },
    },
  },
  {
    name: "a11y-chromium-375-dark",
    grep: /@team-a11y/u,
    metadata: { auditTheme: "dark" },
    use: {
      ...devices["Pixel 7"],
      viewport: { width: 375, height: 812 },
    },
  },
] as const;

export default defineConfig({
  testDir: path.join(__dirname, "tests/e2e/audit"),
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ["list"],
    [
      "html",
      {
        open: "never",
        outputFolder: "artifacts/team-crm-audit/playwright-html",
      },
    ],
    [
      "json",
      { outputFile: "artifacts/team-crm-audit/playwright-results.json" },
    ],
  ],
  globalSetup: "./tests/e2e/audit/global-setup.ts",
  globalTeardown: "./tests/e2e/audit/global-teardown.ts",
  use: {
    baseURL: siteBaseUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    storageState: "tests/e2e/storage/visitor.json",
  },
  projects: [...auditProjects, ...accessibilityProjects],
  outputDir: "artifacts/team-crm-audit/playwright-test-results",
});
