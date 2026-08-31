import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { ensureE2EEnv, getEnvVar } from "./tests/e2e/support/env";

ensureE2EEnv();

const siteBaseUrl = getEnvVar("NEXT_PUBLIC_SITE_URL", "http://localhost:3000");

/**
 * Focused visual lane for an already-prepared Quote V2 E2E stack. It avoids
 * the broad suite's seed/cleanup hooks so local baseline work cannot disturb a
 * concurrently running product audit. Snapshot paths intentionally omit the
 * host OS: the spec embeds the same Noto Sans files on macOS and Ubuntu.
 */
export default defineConfig({
  testDir: path.join(__dirname, "tests/e2e/specs"),
  testMatch: /(?:^|\/)quote-v2-(?:staff-)?visual\.spec\.ts$/u,
  globalSetup: "./tests/e2e/support/quote-v2-staff-visual-setup.ts",
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
        outputFolder: "artifacts/e2e/quote-v2-visual-html",
      },
    ],
  ],
  snapshotPathTemplate: "{testDir}/{testFilePath}-snapshots/{arg}{ext}",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: siteBaseUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    storageState: "tests/e2e/storage/visitor.json",
    serviceWorkers: "block",
  },
  projects: [{ name: "quote-v2-visual-chromium" }],
  outputDir: "artifacts/e2e/quote-v2-visual-results",
});
