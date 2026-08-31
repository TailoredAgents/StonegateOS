import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { ensureE2EEnv, getEnvVar } from "./tests/e2e/support/env";

ensureE2EEnv();

const siteBaseUrl = getEnvVar("NEXT_PUBLIC_SITE_URL", "http://localhost:3000");

/**
 * One isolated real-stack Quote V2 creation journey. This configuration has
 * no global seed/reset and the spec owns unique auth, CRM, and cleanup state.
 */
export default defineConfig({
  testDir: path.join(__dirname, "tests/e2e/specs"),
  testMatch: /quote-v2-real-composer\.spec\.ts$/u,
  timeout: 120_000,
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
        outputFolder: "artifacts/e2e/quote-v2-real-composer-html",
      },
    ],
  ],
  use: {
    baseURL: siteBaseUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    serviceWorkers: "block",
  },
  projects: [
    {
      name: "quote-v2-real-composer-chromium",
      use: devices["Desktop Chrome"],
    },
  ],
  outputDir: "artifacts/e2e/quote-v2-real-composer-results",
});
