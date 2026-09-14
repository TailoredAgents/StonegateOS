import { isPartnerLocationSecretConfigured } from "@/lib/partner-location-secrets";

type Environment = Readonly<Record<string, string | undefined>>;

const TRUE = new Set(["1", "true", "yes", "on"]);
const FALSE = new Set(["0", "false", "no", "off"]);

function flag(environment: Environment, name: string): boolean | null {
  const value = environment[name]?.trim().toLowerCase() ?? "";
  return TRUE.has(value) ? true : FALSE.has(value) ? false : null;
}

function keyIsValid(value: string | undefined): boolean {
  return Boolean(value && Buffer.from(value.trim(), "base64").length === 32);
}

/** Configuration-only release check. Never returns credentials or account data. */
export function inspectPartnerPortalReadiness(
  environment: Environment = process.env,
) {
  const production = environment["NODE_ENV"] === "production";
  const issues: string[] = [];
  const readFlag = flag(environment, "PARTNER_PORTAL_V2_READS_ENABLED");
  const writeFlag = flag(environment, "PARTNER_PORTAL_V2_WRITES_ENABLED");
  const reads = readFlag ?? !production;
  const writes = reads && (writeFlag ?? !production);
  if (production) {
    for (const name of [
      "PARTNER_PORTAL_V2_READS_ENABLED",
      "PARTNER_PORTAL_V2_WRITES_ENABLED",
    ]) {
      if (flag(environment, name) === null) issues.push(name);
    }
    if (flag(environment, "PARTNER_PORTAL_PURPOSE_AUTH_ENABLED") !== true)
      issues.push("PARTNER_PORTAL_PURPOSE_AUTH_ENABLED");
    if (flag(environment, "PARTNER_PORTAL_INTERNAL_TEST_MODE") !== false)
      issues.push("PARTNER_PORTAL_INTERNAL_TEST_MODE");
    if (
      flag(environment, "PARTNER_PORTAL_ROUTINE_MAGIC_LOGIN_ENABLED") !== false
    )
      issues.push("PARTNER_PORTAL_ROUTINE_MAGIC_LOGIN_ENABLED");
    if (environment["PARTNER_PORTAL_V2_CANARY_ACCOUNT_IDS"]?.trim())
      issues.push("PARTNER_PORTAL_V2_CANARY_ACCOUNT_IDS");
    if (writes) {
      if (!isPartnerLocationSecretConfigured(environment))
        issues.push(
          "PARTNER_LOCATION_SECRET_KEY_BASE64/current keyring version",
        );
      if (!keyIsValid(environment["PARTNER_PROOF_SHARE_TOKEN_KEY_BASE64"]))
        issues.push("PARTNER_PROOF_SHARE_TOKEN_KEY_BASE64");
    }
  }
  const mode = !reads ? "maintenance" : !writes ? "read_only" : "available";
  return {
    ok: mode === "available" && issues.length === 0,
    mode,
    reads,
    writes,
    issues,
  };
}
