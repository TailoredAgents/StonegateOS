import type { FullConfig } from "@playwright/test";
import { ensureE2EEnv, getEnvVar } from "../support/env";
import { bootstrapVisitorStorage } from "../support/auth";
import { ensureContentlayerGenerated } from "../support/contentlayer";
import { waitForHealthcheck } from "../support/health";
import { runE2ESeed } from "../support/seed";
import { resetGoogleCalendarFake } from "../support/google-calendar";
import { resetGoogleAdsFake } from "../support/google-ads";
import { resetMetaFake } from "../support/meta";
import { resetEmailFake } from "../support/email";
import {
  bootstrapTeamStorage,
  cleanupAuditTeamStorage,
  closeTeamAuthStorage,
} from "../support/team-auth";
import { assertSafeAuditSeedDatabase } from "./db-safety";
import { assertSafeAuditRuntimeEnvironment } from "./runtime-safety";

export default async function globalSetup(_config: FullConfig): Promise<void> {
  const environment = ensureE2EEnv();
  assertSafeAuditRuntimeEnvironment(environment);
  assertSafeAuditSeedDatabase();
  let auditFixtureBootstrapStarted = false;

  try {
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
      resetEmailFake(),
    ]);

    await bootstrapVisitorStorage("tests/e2e/storage/visitor.json");
    auditFixtureBootstrapStarted = true;
    await cleanupAuditTeamStorage();

    await Promise.all([
      bootstrapTeamStorage({
        filename: "tests/e2e/storage/audit-owner.json",
        name: "Audit Owner",
        email: "audit-owner@mystos.test",
        phoneE164: "+14045551001",
        role: "owner",
        siteBase,
      }),
      bootstrapTeamStorage({
        filename: "tests/e2e/storage/audit-office.json",
        name: "Audit Office",
        email: "audit-office@mystos.test",
        role: "office",
        siteBase,
      }),
      bootstrapTeamStorage({
        filename: "tests/e2e/storage/audit-sales.json",
        name: "Audit Sales",
        email: "audit-sales@mystos.test",
        role: "sales",
        siteBase,
      }),
      bootstrapTeamStorage({
        filename: "tests/e2e/storage/audit-crew.json",
        name: "Audit Crew",
        email: "audit-crew@mystos.test",
        role: "crew",
        siteBase,
      }),
      bootstrapTeamStorage({
        filename: "tests/e2e/storage/audit-read-only.json",
        name: "Audit Read Only",
        email: "audit-read-only@mystos.test",
        role: "read_only",
        siteBase,
      }),
      bootstrapTeamStorage({
        filename: "tests/e2e/storage/audit-custom-grant.json",
        name: "Audit Custom Grant",
        email: "audit-custom-grant@mystos.test",
        role: "custom_audit",
        permissionsGrant: ["messages.read", "messages.send"],
        siteBase,
      }),
      bootstrapTeamStorage({
        filename: "tests/e2e/storage/audit-custom-deny.json",
        name: "Audit Custom Deny",
        email: "audit-custom-deny@mystos.test",
        role: "custom_audit",
        permissionsGrant: ["quotes.*", "appointments.read"],
        permissionsDeny: ["quotes.delete"],
        siteBase,
      }),
      bootstrapTeamStorage({
        filename: "tests/e2e/storage/audit-inactive.json",
        name: "Audit Inactive",
        email: "audit-inactive@mystos.test",
        role: "office",
        active: false,
        siteBase,
      }),
      bootstrapTeamStorage({
        filename: "tests/e2e/storage/audit-expired.json",
        name: "Audit Expired",
        email: "audit-expired@mystos.test",
        role: "office",
        sessionExpiresInMinutes: -5,
        siteBase,
      }),
    ]);
  } catch (error) {
    if (auditFixtureBootstrapStarted) {
      try {
        await cleanupAuditTeamStorage();
      } catch (cleanupError) {
        console.warn(
          "[team-audit setup] partial-fixture cleanup failed",
          cleanupError,
        );
      }
    }
    throw error;
  } finally {
    await closeTeamAuthStorage();
  }
}
