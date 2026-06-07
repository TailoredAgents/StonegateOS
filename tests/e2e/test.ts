import { test as base, expect } from "@playwright/test";
import { checkDependencies } from "./support/system-checks";
import { attachServiceLogs } from "./support/log-attachments";

let dependencyStatus: { ok: boolean; reason?: string } | null = null;

async function ensureDependencies() {
  if (dependencyStatus) {
    return dependencyStatus;
  }
  dependencyStatus = await checkDependencies();
  return dependencyStatus;
}

const test = base.extend({});

test.beforeEach(async ({}, testInfo) => {
  const status = await ensureDependencies();
  if (!status.ok) {
    testInfo.skip(true, status.reason ?? "Required services unavailable");
  }
});

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== "passed") {
    await attachServiceLogs(testInfo);
  }
});

export { test, expect };
