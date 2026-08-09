import type { FullConfig } from "@playwright/test";
import { ensureE2EEnv, getEnvVar } from "./support/env";
import { bootstrapAdminStorage, bootstrapVisitorStorage } from "./support/auth";
import { runE2ESeed } from "./support/seed";
import { waitForHealthcheck } from "./support/health";
import { ensureContentlayerGenerated } from "./support/contentlayer";
import { bootstrapTeamStorage } from "./support/team-auth";
import { resetGoogleCalendarFake } from "./support/google-calendar";
import { resetGoogleAdsFake } from "./support/google-ads";
import { resetMetaFake } from "./support/meta";
import { resetSquareFake } from "./support/square";
import { resetEmailFake } from "./support/email";
import { assertSafeAuditRuntimeEnvironment } from "./audit/runtime-safety";

export default async function globalSetup(_config: FullConfig): Promise<void> {
  const environment = ensureE2EEnv();
  assertSafeAuditRuntimeEnvironment(environment);
  await ensureContentlayerGenerated();

  await runE2ESeed();

  const siteBase = getEnvVar("NEXT_PUBLIC_SITE_URL", "http://localhost:3000");
  const apiBase = getEnvVar("API_BASE_URL", "http://localhost:3001");

  await Promise.all([
    waitForHealthcheck(new URL("/api/healthz", siteBase).toString(), {
      service: "site",
    }),
    waitForHealthcheck(new URL("/api/healthz", apiBase).toString(), {
      service: "api",
    }),
  ]);
  await Promise.all([
    resetGoogleCalendarFake(),
    resetGoogleAdsFake(),
    resetMetaFake(),
    resetSquareFake(),
    resetEmailFake(),
  ]);

  await Promise.all([
    bootstrapVisitorStorage("tests/e2e/storage/visitor.json"),
    bootstrapAdminStorage("tests/e2e/storage/admin.json"),
    bootstrapTeamStorage({
      filename: "tests/e2e/storage/mobile-owner.json",
      name: "E2E Mobile Owner",
      email: "e2e-mobile-owner@mystos.test",
      role: "owner",
      siteBase,
    }),
    bootstrapTeamStorage({
      filename: "tests/e2e/storage/mobile-sales.json",
      name: "E2E Mobile Sales",
      email: "e2e-mobile-sales@mystos.test",
      role: "sales",
      siteBase,
    }),
    bootstrapTeamStorage({
      filename: "tests/e2e/storage/mobile-payment-denied.json",
      name: "E2E Payment Denied",
      email: "e2e-mobile-payment-denied@mystos.test",
      role: "sales",
      permissionsDeny: ["payments.read", "payments.collect"],
      siteBase,
    }),
    bootstrapTeamStorage({
      filename: "tests/e2e/storage/mobile-appointment-update-denied.json",
      name: "E2E Appointment Update Denied",
      email: "e2e-mobile-appointment-update-denied@mystos.test",
      role: "sales",
      permissionsDeny: ["appointments.update"],
      siteBase,
    }),
  ]);
}
