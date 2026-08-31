import type { FullConfig } from "@playwright/test";
import { ensureE2EEnv, getEnvVar } from "./env";
import { bootstrapTeamStorage } from "./team-auth";

/**
 * Creates only the synthetic Quote owner/session required by the staff visual
 * lane. It intentionally performs no database seed, cleanup, provider reset,
 * or Partner fixture mutation.
 */
export default async function quoteV2StaffVisualSetup(
  _config: FullConfig,
): Promise<void> {
  ensureE2EEnv();
  await bootstrapTeamStorage({
    filename: "tests/e2e/storage/mobile-owner.json",
    name: "E2E Mobile Owner",
    email: "e2e-mobile-owner@mystos.test",
    role: "owner",
    siteBase: getEnvVar("NEXT_PUBLIC_SITE_URL", "http://localhost:3000"),
  });
}
