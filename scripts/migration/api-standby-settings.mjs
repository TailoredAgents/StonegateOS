import { createHash } from "node:crypto";
// Worker secret bindings are limited to 5 KB each. Keep all settings encrypted
// as secrets, split ASCII JSON below 4 KB, and verify the reconstructed values.
export function splitApiStandbySecrets(input) {
  const envelope = JSON.parse(input.SOURCE_API_RUNTIME_CONFIG);
  const environment = envelope.environment;
  const hash = createHash("sha256")
    .update(
      JSON.stringify(
        Object.entries(environment).sort(([a], [b]) => a.localeCompare(b)),
      ),
    )
    .digest("hex");
  if (hash !== envelope.environmentSha256)
    throw Error("Environment fingerprint mismatch");
  const encoded = JSON.stringify(environment).replace(
    /[\u007f-\uffff]/g,
    (value) => "\\u" + value.charCodeAt(0).toString(16).padStart(4, "0"),
  );
  const boundary = Math.ceil(encoded.length / 2);
  if (boundary > 4096) throw Error("Environment exceeds bounded secret parts");
  delete envelope.environment;
  envelope.environmentParts = 2;
  const result = {
    SOURCE_API_RUNTIME_CONFIG: JSON.stringify(envelope),
    SOURCE_API_ENV_1: encoded.slice(0, boundary),
    SOURCE_API_ENV_2: encoded.slice(boundary),
    MIGRATION_PROBE_TOKEN: input.MIGRATION_PROBE_TOKEN,
  };
  if (
    Object.values(result).some(
      (value) => typeof value !== "string" || Buffer.byteLength(value) > 4096,
    )
  )
    throw Error("Standby secret exceeds binding limit");
  return result;
}
