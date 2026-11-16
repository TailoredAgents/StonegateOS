// Read-only, project-scoped Twilio callback inventory. No sends or updates.
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";
const { getTwilioApiBaseUrl } = createRequire(import.meta.url)(
  "../../packages/sdk/src/twilio-provider",
) as typeof import("../../packages/sdk/src/twilio-provider");
const directory = process.argv[2];
if (!directory) throw Error("Private evidence directory required");
const settings = JSON.parse(
  await readFile(path.join(directory, "api-env.json"), "utf8"),
);
if (
  !/^AC[a-f0-9]{32}$/.test(settings.TWILIO_ACCOUNT_SID) ||
  !settings.TWILIO_AUTH_TOKEN ||
  !settings.TWILIO_FROM
)
  throw Error("Missing deployed Twilio configuration");
const apiBase = getTwilioApiBaseUrl({ ...settings, NODE_ENV: "production" });
const headers = {
  authorization:
    "Basic " +
    Buffer.from(
      settings.TWILIO_ACCOUNT_SID + ":" + settings.TWILIO_AUTH_TOKEN,
    ).toString("base64"),
};
async function get(url) {
  const r = await fetch(url, {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw Error("Provider inventory read failed: " + r.status);
  return r.json();
}
let next =
  "/2010-04-01/Accounts/" +
  settings.TWILIO_ACCOUNT_SID +
  "/IncomingPhoneNumbers.json?PageSize=100";
let count = 0;
const selected = [];
while (next) {
  const url = new URL(next, apiBase);
  if (url.origin !== apiBase.origin)
    throw Error("Unexpected provider pagination origin");
  const page = await get(url);
  count += page.incoming_phone_numbers.length;
  if (count > 500) throw Error("Inventory bound exceeded");
  selected.push(
    ...page.incoming_phone_numbers.filter(
      (row) => row.phone_number === settings.TWILIO_FROM,
    ),
  );
  next = page.next_page_uri;
}
if (selected.length !== 1)
  throw Error("Deployed sender must resolve to exactly one phone number");
const number = selected[0],
  match = number.voice_url?.match(/\/Flows\/(FW[a-f0-9]{32})/);
const flow = match
  ? await get("https://studio.twilio.com/v2/Flows/" + match[1])
  : null;
const callbacks = [];
for (const key of [
  "sms_url",
  "sms_fallback_url",
  "voice_url",
  "voice_fallback_url",
  "status_callback",
])
  if (number[key])
    callbacks.push({ source: "phone-number", key, url: number[key] });
for (const state of flow?.definition?.states ?? [])
  if (state.properties?.url)
    callbacks.push({
      source: "studio-flow",
      key: state.name,
      url: state.properties.url,
      method: state.properties.method,
      signatureEnabled: state.properties.add_twilio_auth,
    });
const snapshot = { number, flow };
const sha256 = createHash("sha256")
  .update(JSON.stringify(snapshot))
  .digest("hex");
const receipt = {
  at: new Date().toISOString(),
  accountNumbers: count,
  scopedNumbers: 1,
  unrelatedNumbers: count - 1,
  sha256,
  snapshot,
  callbacks,
};
await writeFile(
  path.join(directory, `provider-callback-inventory-${Date.now()}.json`),
  JSON.stringify(receipt),
  { mode: 0o600, flag: "wx" },
);
console.log(
  JSON.stringify({
    scopedNumbers: 1,
    unrelatedNumbers: count - 1,
    studioStates: flow?.definition?.states?.length ?? 0,
    callbackCount: callbacks.length,
    renderCallbackCount: callbacks.filter(
      (x) => new URL(x.url).hostname === "stonegate-api.onrender.com",
    ).length,
    snapshotSha256: sha256,
  }),
);
