// Reversible suspension only. Keeps the service, credentials and all database
// rows. Explicit user exclusion plus fresh empty-dependency evidence is required.
import { readFile, writeFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";
const directory = process.argv[2],
  action = process.argv[3] ?? "plan";
if (!directory || !["plan", "suspend"].includes(action))
  throw Error("Private directory and plan|suspend required");
const id = "srv-d6fqpmvgi27c73cgd4jg";
const destinations = JSON.parse(
  await readFile(
    path.join(directory, "authorized-test-destinations.json"),
    "utf8",
  ),
);
if (destinations.discord !== "excluded-user-does-not-use")
  throw Error("Discord exclusion not recorded");
const files = (await readdir(directory))
  .filter((x) => /^discord-dependency-inventory-\d+\.json$/.test(x))
  .sort();
if (!files.length) throw Error("Missing dependency inventory");
const inventory = JSON.parse(
  await readFile(path.join(directory, files.at(-1)), "utf8"),
);
if (
  Date.now() - Date.parse(inventory.at) > 15 * 60000 ||
  !inventory.sourceReadOnly ||
  inventory.subscriptions.total !== 0 ||
  inventory.activeIntents !== 0 ||
  inventory.intents.length !== 0 ||
  inventory.memory.count !== 0
)
  throw Error("Discord dependency inventory is stale or not empty");
const yaml = await readFile(
  path.join(os.homedir(), ".render/cli.yaml"),
  "utf8",
);
const raw = yaml.match(/^\s+key:\s*(.+)$/m)?.[1];
if (!raw) throw Error("Missing Render credential");
const key = raw.startsWith('"') ? JSON.parse(raw) : raw;
async function render(route, method = "GET", body) {
  const r = await fetch("https://api.render.com/v1" + route, {
    method,
    headers: {
      authorization: "Bearer " + key,
      accept: "application/json",
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw Error("Render request failed: " + r.status);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}
const service = await render("/services/" + id);
if (
  service.id !== id ||
  service.name !== "stonegate-discord-agent" ||
  service.ownerId !== "tea-cvl1h0odl3ps738ecuf0" ||
  service.type !== "background_worker" ||
  service.repo !== "https://github.com/TailoredAgents/StonegateOS" ||
  service.branch !== "main" ||
  service.serviceDetails.disk
)
  throw Error("Unexpected Discord service identity or attached disk");
const deploys = await render("/services/" + id + "/deploys?limit=20");
const live = deploys.map((x) => x.deploy ?? x).find((x) => x.status === "live");
if (
  service.suspended !== "suspended" &&
  live?.commit?.id !== "5a90cf86608c76cd85773dbd2362b7fa07d5019c"
)
  throw Error("Discord live revision changed");
const receipt = {
  at: new Date().toISOString(),
  action,
  serviceId: id,
  before: service,
  live,
  inventory,
  steps: [],
  ok: false,
  dataDeleted: false,
};
const filename = path.join(
  directory,
  "discord-suspension-" + action + "-" + Date.now() + ".json",
);
await writeFile(filename, JSON.stringify(receipt, null, 2), {
  mode: 0o600,
  flag: "wx",
});
try {
  if (action === "suspend") {
    if (service.autoDeployTrigger !== "off") {
      await render("/services/" + id, "PATCH", { autoDeployTrigger: "off" });
      receipt.steps.push({
        action: "disable-auto-deploy",
        at: new Date().toISOString(),
      });
    }
    if (service.suspended !== "suspended") {
      await render("/services/" + id + "/suspend", "POST");
      receipt.steps.push({
        action: "request-suspension",
        at: new Date().toISOString(),
      });
    }
    let after, instances;
    for (let i = 0; i < 45; i++) {
      after = await render("/services/" + id);
      instances = await render("/services/" + id + "/instances");
      if (
        after.suspended === "suspended" &&
        after.autoDeployTrigger === "off" &&
        Array.isArray(instances) &&
        instances.length === 0
      )
        break;
      await wait(2000);
    }
    receipt.after = after;
    receipt.instances = instances;
    if (
      after.suspended !== "suspended" ||
      after.autoDeployTrigger !== "off" ||
      !Array.isArray(instances) ||
      instances.length !== 0
    )
      throw Error("Suspension or instance termination not confirmed");
  }
  receipt.ok = true;
} catch (error) {
  receipt.error = error.message;
  process.exitCode = 1;
} finally {
  await writeFile(filename, JSON.stringify(receipt, null, 2), { mode: 0o600 });
  console.log(
    JSON.stringify({
      at: receipt.at,
      action,
      serviceId: id,
      ok: receipt.ok,
      suspended: receipt.after?.suspended,
      automaticDeploys: receipt.after?.autoDeployTrigger,
      remainingInstances: receipt.instances?.length,
      dataDeleted: false,
      error: receipt.error,
    }),
  );
}
