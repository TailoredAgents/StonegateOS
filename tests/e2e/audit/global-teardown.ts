import baseGlobalTeardown from "../global-teardown";
import { ensureE2EEnv } from "../support/env";
import {
  cleanupAuditTeamStorage,
  closeTeamAuthStorage,
} from "../support/team-auth";
import { assertSafeAuditSeedDatabase } from "./db-safety";

export default async function globalTeardown(): Promise<void> {
  ensureE2EEnv();
  assertSafeAuditSeedDatabase();

  try {
    await cleanupAuditTeamStorage();
  } finally {
    try {
      await closeTeamAuthStorage();
    } finally {
      await baseGlobalTeardown();
    }
  }
}
