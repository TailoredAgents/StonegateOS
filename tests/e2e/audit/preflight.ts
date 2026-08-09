import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chromium, webkit } from "@playwright/test";
import { ensureE2EEnv } from "../support/env";
import { assertSafeAuditSeedDatabase } from "./db-safety";
import { assertSafeAuditRuntimeEnvironment } from "./runtime-safety";

function assertDockerRuntime(): void {
  const result = spawnSync(
    "docker",
    ["info", "--format", "{{.ServerVersion}}"],
    { encoding: "utf8" },
  );
  if (result.error) {
    throw new Error(
      "Team audit runtime is unavailable: Docker is not installed or is not on PATH.",
    );
  }
  if (result.status !== 0) {
    throw new Error(
      "Team audit runtime is unavailable: the Docker daemon is not reachable.",
    );
  }
}

function assertPlaywrightBrowser(name: string, executablePath: string): void {
  if (!existsSync(executablePath)) {
    throw new Error(
      `Team audit runtime is unavailable: Playwright ${name} is not installed. Install the pinned Playwright browsers before executing the audit.`,
    );
  }
}

const environment = ensureE2EEnv();
assertSafeAuditRuntimeEnvironment(environment);
assertSafeAuditSeedDatabase();
assertDockerRuntime();
assertPlaywrightBrowser("Chromium", chromium.executablePath());
assertPlaywrightBrowser("WebKit", webkit.executablePath());
