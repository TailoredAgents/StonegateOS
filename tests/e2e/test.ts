import { test as base, expect } from "@playwright/test";
import { checkDependencies } from "./support/system-checks";
import { attachServiceLogs } from "./support/log-attachments";

let dependencyStatus: { ok: boolean; reason?: string } | null = null;

async function ensureDependencies() {
  if (dependencyStatus?.ok) {
    return dependencyStatus;
  }

  const status = await checkDependencies();
  if (status.ok) {
    dependencyStatus = status;
  }
  return status;
}

const test = base.extend({});

test.beforeEach(async ({}, testInfo) => {
  const status = await ensureDependencies();
  if (!status.ok) {
    const reason = status.reason ?? "Required services unavailable";
    if (process.env.CI) {
      throw new Error(reason);
    }
    testInfo.skip(true, reason);
  }
});

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== "passed") {
    await attachServiceLogs(testInfo);
  }
});

export { test, expect };
