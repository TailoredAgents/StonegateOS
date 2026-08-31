import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { ensureE2EEnv, getEnvVar } from "./tests/e2e/support/env";

ensureE2EEnv();

const siteBaseUrl = getEnvVar("NEXT_PUBLIC_SITE_URL", "http://localhost:3000");

/**
 * Quote-only release matrix for an already-prepared E2E stack. It deliberately
 * omits the broad suite seed/reset so a focused Quote verification cannot
 * rewrite concurrent Partner fixtures or evidence.
 */
export default defineConfig({
  testDir: path.join(__dirname, "tests/e2e/specs"),
  testMatch: /(?:^|\/)quote-v2-(?:release|zoom)\.spec\.ts$/u,
  timeout: 90_000,
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
        outputFolder: "artifacts/e2e/quote-v2-release-html",
      },
    ],
  ],
  use: {
    baseURL: siteBaseUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    storageState: "tests/e2e/storage/visitor.json",
    serviceWorkers: "block",
  },
  projects: [
    {
      name: "chromium-desktop",
      testMatch: /(?:^|\/)quote-v2-release\.spec\.ts$/u,
      use: devices["Desktop Chrome"],
    },
    {
      name: "firefox-quote-desktop",
      testMatch: /(?:^|\/)quote-v2-release\.spec\.ts$/u,
      use: devices["Desktop Firefox"],
    },
    {
      name: "chromium-quote-zoom-200",
      testMatch: /(?:^|\/)quote-v2-zoom\.spec\.ts$/u,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 640, height: 900 },
        deviceScaleFactor: 2,
      },
    },
  ],
  outputDir: "artifacts/e2e/quote-v2-release-results",
});
