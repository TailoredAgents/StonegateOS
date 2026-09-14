/** Required API pre-deploy check. Reads configuration and database state only. */
import { inspectPartnerPortalReadiness } from "../src/lib/partner-portal-readiness";
import { getApiReadinessSnapshot } from "../src/lib/readiness";

try {
  const portal = inspectPartnerPortalReadiness();
  if (portal.issues.length) {
    console.error(
      JSON.stringify({
        ok: false,
        check: "portal_configuration",
        settings: portal.issues,
      }),
    );
    process.exitCode = 1;
  } else {
    const snapshot = await getApiReadinessSnapshot();
    // Explicit maintenance settings remain deployable. Missing settings do not.
    // Database compatibility and the separate quote configuration are mandatory.
    const checks = {
      configuration: snapshot.checks.configuration.state,
      database: snapshot.checks.database.state,
      migrations: snapshot.checks.migrations.state,
    };
    const ok = Object.values(checks).every((state) => state === "ok");
    console.log(JSON.stringify({ ok, portalMode: portal.mode, checks }));
    if (!ok) process.exitCode = 1;
  }
} catch {
  console.error(
    JSON.stringify({ ok: false, check: "deployment_readiness_unavailable" }),
  );
  process.exitCode = 1;
}

// This CLI owns no writes or background work. Flush its report before exiting;
// application pools intentionally stay alive and the test-only closer rejects
// production use.
process.stdout.write("", () => process.exit(process.exitCode ?? 0));
