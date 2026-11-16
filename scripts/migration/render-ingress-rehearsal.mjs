import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import path from "node:path";
const [directory, action] = process.argv.slice(2);
if (!directory || !["create", "deploy", "status", "suspend"].includes(action))
  throw Error(
    "Private directory and explicit create|deploy|status|suspend action required",
  );
const workspace = "tea-cvl1h0odl3ps738ecuf0";
const name = "stonegate-legacy-ingress-validation";
const branch = "codex/cloudflare-migration";
const rootDir = "infra/cloudflare/legacy-api-forwarder";
const repository = "https://github.com/TailoredAgents/StonegateOS";
const yaml = await readFile(path.join(homedir(), ".render/cli.yaml"), "utf8");
const rawKey = yaml.match(/^\s+key:\s*(.+)$/m)?.[1]?.trim();
if (!rawKey) throw Error("Render credential unavailable");
const token = rawKey.startsWith('"') ? JSON.parse(rawKey) : rawKey;
async function api(suffix, method = "GET", body) {
  const r = await fetch("https://api.render.com/v1" + suffix, {
    method,
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw Error("RENDER_HTTP_" + r.status);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}
async function save(filename, value) {
  await writeFile(
    path.join(directory, filename),
    JSON.stringify(value, null, 2),
    { mode: 0o600, flag: "wx" },
  );
}
let recorded;
try {
  recorded = JSON.parse(
    await readFile(path.join(directory, "render-ingress-service.json"), "utf8"),
  );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const matches = (
  await api("/services?ownerId=" + workspace + "&name=" + name + "&limit=100")
)
  .map((row) => row.service)
  .filter((service) => service.name === name);
if (matches.length > 1) throw Error("Duplicate ingress fixture services");
let service = matches[0];
function identity(service) {
  if (
    !service ||
    service.ownerId !== workspace ||
    service.name !== name ||
    service.type !== "web_service" ||
    service.repo !== repository ||
    service.branch !== branch ||
    service.rootDir !== rootDir ||
    service.autoDeployTrigger !== "off" ||
    service.serviceDetails.region !== "virginia" ||
    service.serviceDetails.plan !== "starter" ||
    service.serviceDetails.healthCheckPath !== "/_forwarder/healthz" ||
    service.serviceDetails.envSpecificDetails.startCommand !==
      "node ingress-validation.mjs" ||
    (recorded && service.id !== recorded.service.id)
  )
    throw Error("INGRESS_FIXTURE_IDENTITY_MISMATCH");
}
if (action === "create") {
  if (service || recorded)
    throw Error(
      "Fixture already exists; inspect status instead of creating again",
    );
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const remote = execFileSync(
    "git",
    ["ls-remote", "origin", "refs/heads/" + branch],
    { encoding: "utf8" },
  )
    .trim()
    .split(/\s+/)[0];
  if (remote !== revision)
    throw Error("Branch differs from reviewed local revision");
  const forwarding = JSON.parse(
    await readFile(
      path.join(directory, "legacy-forwarder-secrets.json"),
      "utf8",
    ),
  );
  const credentials = {
    ingressToken: randomBytes(32).toString("hex"),
    expiresAt: new Date(Date.now() + 2 * 3600000).toISOString(),
    revision,
  };
  await save("render-ingress-credentials.json", credentials);
  const configuration = {
    type: "web_service",
    name,
    ownerId: workspace,
    repo: repository,
    branch,
    rootDir,
    autoDeployTrigger: "off",
    envVars: [
      { key: "NODE_VERSION", value: "24.21.0" },
      {
        key: "STONEGATE_FORWARDER_TOKEN",
        value: forwarding.LEGACY_FORWARDER_TOKEN,
      },
      { key: "STONEGATE_INGRESS_TEST_TOKEN", value: credentials.ingressToken },
      { key: "STONEGATE_INGRESS_EXPIRES_AT", value: credentials.expiresAt },
    ],
    serviceDetails: {
      runtime: "node",
      plan: "starter",
      region: "virginia",
      numInstances: 1,
      maxShutdownDelaySeconds: 30,
      healthCheckPath: "/_forwarder/healthz",
      envSpecificDetails: {
        buildCommand:
          "node --check server.mjs\nnode --check ingress-validation.mjs",
        startCommand: "node ingress-validation.mjs",
      },
    },
  };
  await save("render-ingress-create-attempt.json", {
    at: new Date().toISOString(),
    revision,
    configuration,
  });
  const result = await api("/services", "POST", configuration);
  service = result.service ?? result;
  await save("render-ingress-service.json", {
    at: new Date().toISOString(),
    service,
    revision,
  });
  identity(service);
}
if (!service) throw Error("Ingress fixture service is absent");
identity(service);
if (action === "deploy") {
  const credentials = JSON.parse(
    await readFile(
      path.join(directory, "render-ingress-credentials.json"),
      "utf8",
    ),
  );
  if (!(Date.parse(credentials.expiresAt) > Date.now() + 15 * 60000))
    throw Error("INGRESS_CREDENTIAL_WINDOW_TOO_SHORT");
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const remote = execFileSync(
    "git",
    ["ls-remote", "origin", "refs/heads/" + branch],
    { encoding: "utf8" },
  )
    .trim()
    .split(/\s+/)[0];
  if (remote !== revision)
    throw Error("Branch differs from reviewed local revision");
  const attempt = {
    at: new Date().toISOString(),
    serviceId: service.id,
    revision,
  };
  await save("render-ingress-deploy-attempt-" + Date.now() + ".json", attempt);
  if (service.suspended === "suspended")
    await api("/services/" + service.id + "/resume", "POST");
  const result = await api("/services/" + service.id + "/deploys", "POST", {
    commitId: revision,
    clearCache: "do_not_clear",
  });
  await save("render-ingress-deploy-result-" + Date.now() + ".json", {
    ...attempt,
    result,
  });
  await writeFile(
    path.join(directory, "render-ingress-expected.json"),
    JSON.stringify({ ...attempt, deploymentId: result.id }),
    { mode: 0o600 },
  );
  service = await api("/services/" + service.id);
  identity(service);
}
if (action === "suspend") {
  if (service.suspended !== "suspended")
    await api("/services/" + service.id + "/suspend", "POST");
  let instances = [];
  for (let attempt = 0; attempt < 60; attempt++) {
    service = await api("/services/" + service.id);
    identity(service);
    instances = await api("/services/" + service.id + "/instances");
    if (service.suspended === "suspended" && instances.length === 0) break;
    await wait(2000);
  }
  if (service.suspended !== "suspended" || instances.length !== 0)
    throw Error("SUSPENSION_NOT_CONFIRMED");
  await save("render-ingress-suspended-" + Date.now() + ".json", {
    at: new Date().toISOString(),
    serviceId: service.id,
    suspended: true,
    autoDeploy: "off",
    instances: 0,
  });
}
const deployments = await api("/services/" + service.id + "/deploys?limit=1");
console.log(
  JSON.stringify({
    serviceId: service.id,
    url: service.serviceDetails.url,
    suspended: service.suspended,
    autoDeploy: service.autoDeployTrigger,
    deployment: deployments[0]?.deploy
      ? {
          id: deployments[0].deploy.id,
          status: deployments[0].deploy.status,
          revision: deployments[0].deploy.commit?.id,
        }
      : null,
  }),
);
