import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { ensureE2EEnv, getEnvVar } from "./tests/e2e/support/env";

ensureE2EEnv();

const siteBaseUrl = getEnvVar("NEXT_PUBLIC_SITE_URL", "http://localhost:3000");

export default defineConfig({
  testDir: path.join(__dirname, "tests/e2e/specs"),
  timeout: 60 * 1000,
  expect: {
    timeout: 15 * 1000,
  },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 4 : undefined,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "artifacts/e2e/html-report" }],
    ["junit", { outputFile: "artifacts/e2e/junit/results.xml" }],
    ["json", { outputFile: "artifacts/e2e/json-report.json" }],
  ],
  globalSetup: "./tests/e2e/global-setup.ts",
  globalTeardown: "./tests/e2e/global-teardown.ts",
  use: {
    baseURL: siteBaseUrl,
    trace: "retain-on-failure",
    video: "retry-with-video",
    screenshot: "only-on-failure",
    storageState: "tests/e2e/storage/visitor.json",
  },
  projects: [
    {
      name: "chromium-desktop",
      use: {
        ...devices["Desktop Chrome"],
      },
    },
    {
      name: "chromium-mobile",
      testMatch: /mobile-.*\.spec\.ts/,
      use: {
        ...devices["Pixel 7"],
        isMobile: true,
      },
    },
    {
      name: "webkit-mobile",
      testMatch: /mobile-.*\.spec\.ts/,
      use: {
        ...devices["iPhone 13"],
        isMobile: true,
      },
    },
  ],
  outputDir: "artifacts/e2e/test-results",
});
