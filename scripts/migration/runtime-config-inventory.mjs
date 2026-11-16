// Capture dashboard, SSH launch and actual Linux process-start environments
// privately. This does not inspect mutable JavaScript process memory.
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { compareRuntimeSettings } from "./runtime-settings.mjs";
const directory = process.argv[2];
if (!directory) throw Error("Private evidence directory required");
const workspace = "tea-cvl1h0odl3ps738ecuf0";
const yaml = await readFile(path.join(homedir(), ".render/cli.yaml"), "utf8");
const encoded = yaml.match(/^\s+key:\s*(.+)$/m)?.[1]?.trim();
if (!encoded) throw Error("Render credential unavailable");
const token = encoded.startsWith('"') ? JSON.parse(encoded) : encoded;
async function api(suffix) {
  const r = await fetch("https://api.render.com/v1" + suffix, {
    headers: { authorization: "Bearer " + token },
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw Error("RENDER_HTTP_" + r.status);
  return r.json();
}
const definitions = [
  {
    name: "api",
    service: "srv-d43o7k0dl3ps73a4rhu0",
    revision: "0e66a789ea1c33b297aa5f1324571904c3fa2894",
  },
  {
    name: "outbox",
    service: "srv-d43sdh0dl3ps73a8l70g",
    revision: "0c0026b4cd0e26d65c93480e1aeb7e62596ffb0b",
  },
];
const code = String.raw`const fs=require('node:fs');const {execFileSync}=require('node:child_process');const config=JSON.parse(fs.readFileSync(0,'utf8'));
if(process.env.RENDER_SERVICE_ID!==config.service||process.env.RENDER_GIT_COMMIT!==config.revision)process.exit(42);
const environment={};for(const key of config.keys)if(process.env[key]!==undefined)environment[key]=process.env[key];
const candidates=[];for(const pid of fs.readdirSync('/proc').filter(x=>/^\d+$/.test(x))){try{
const args=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\0').filter(Boolean);const exe=fs.readlinkSync('/proc/'+pid+'/exe');const cwd=fs.readlinkSync('/proc/'+pid+'/cwd');
if(!exe.endsWith('/node')||args.includes('-e'))continue;
const selected=config.name==='api'?args[0]?.startsWith('next-server')&&cwd==='/opt/render/project/src/apps/api':args.includes('--import')&&args.includes('scripts/outbox-worker.ts')&&cwd==='/opt/render/project/src';
if(!selected)continue;
const all={};for(const part of fs.readFileSync('/proc/'+pid+'/environ','utf8').split('\0')){const index=part.indexOf('=');if(index>0)all[part.slice(0,index)]=part.slice(index+1);}
if(all.RENDER_SERVICE_ID!==config.service||all.RENDER_GIT_COMMIT!==config.revision)process.exit(43);
const values={};for(const key of config.keys)if(all[key]!==undefined)values[key]=all[key];
const commandOverrides={};for(const key of ['NODE_ENV','NODE_OPTIONS','OUTBOX_POLL_INTERVAL_MS','OUTBOX_BATCH_SIZE'])if(all[key]!==undefined)commandOverrides[key]=all[key];
candidates.push({pid:Number(pid),executable:exe,node:execFileSync('/proc/'+pid+'/exe',['--version'],{encoding:'utf8',timeout:3000}).trim(),environment:values,commandOverrides});
}catch{}}
if(candidates.length!==1)process.exit(44);
process.stdout.write(JSON.stringify({service:process.env.RENDER_SERVICE_ID,revision:process.env.RENDER_GIT_COMMIT,node:process.version,environment,process:candidates[0]}));`;

const canonical = (values) =>
  JSON.stringify(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)));
const hash = (values) =>
  createHash("sha256").update(canonical(values)).digest("hex");
const summary = {
  at: new Date().toISOString(),
  services: [],
  productionChanged: false,
};
for (const definition of definitions) {
  const service = await api("/services/" + definition.service);
  const deployments = await api(
    "/services/" + definition.service + "/deploys?limit=1",
  );
  if (
    service.ownerId !== workspace ||
    service.id !== definition.service ||
    service.repo !== "https://github.com/TailoredAgents/StonegateOS" ||
    service.branch !== "main" ||
    service.suspended !== "not_suspended" ||
    deployments[0]?.deploy.status !== "live" ||
    deployments[0]?.deploy.commit?.id !== definition.revision
  )
    throw Error("SOURCE_IDENTITY_CHANGED:" + definition.name);
  const configured = {};
  let cursor;
  for (let page = 0; page < 10; page++) {
    const rows = await api(
      "/services/" +
        definition.service +
        "/env-vars?limit=100" +
        (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
    );
    for (const row of rows) {
      if (
        !row.envVar ||
        typeof row.envVar.key !== "string" ||
        typeof row.envVar.value !== "string" ||
        Object.hasOwn(configured, row.envVar.key)
      )
        throw Error("INVALID_ENVIRONMENT_PAGE");
      configured[row.envVar.key] = row.envVar.value;
    }
    if (rows.length < 100) break;
    cursor = rows.at(-1).cursor;
    if (!cursor || page === 9) throw Error("ENVIRONMENT_PAGINATION_INCOMPLETE");
  }
  if (Object.keys(configured).length < 20 || !configured.DATABASE_URL)
    throw Error("INCOMPLETE_ENVIRONMENT");
  const command = "node -e '" + code.replaceAll("'", "'\\''") + "'";
  const child = spawn(
    "ssh",
    [
      "-i",
      path.join(homedir(), ".ssh/stonegate_migration_20261115"),
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "UpdateHostKeys=no",
      "-o",
      "ConnectTimeout=10",
      definition.service + "@ssh.virginia.render.com",
      command,
    ],
    { stdio: ["pipe", "pipe", "ignore"] },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
    if (output.length > 256000) child.kill("SIGTERM");
  });
  const timeout = setTimeout(() => child.kill("SIGTERM"), 20000);
  child.stdin.end(
    JSON.stringify({
      service: definition.service,
      revision: definition.revision,
      name: definition.name,
      keys: Object.keys(configured),
    }),
  );
  const [status] = await once(child, "exit");
  clearTimeout(timeout);
  if (status !== 0)
    throw Error("EFFECTIVE_ENVIRONMENT_READ_FAILED:" + definition.name);
  const effective = JSON.parse(output);
  if (
    effective.service !== definition.service ||
    effective.revision !== definition.revision ||
    effective.node !== "v24.21.0"
  )
    throw Error("RUNTIME_IDENTITY_CHANGED");
  const { differingKeys, paddingEquivalentKeys, unexplainedDifferences } =
    compareRuntimeSettings(configured, effective.environment);
  const previous = JSON.parse(
    await readFile(path.join(directory, definition.name + "-env.json"), "utf8"),
  );
  const changedSinceSnapshot = [
    ...new Set([...Object.keys(previous), ...Object.keys(configured)]),
  ].filter((key) => previous[key] !== configured[key]);
  const processComparison = compareRuntimeSettings(
    configured,
    effective.process.environment,
  );
  const entry = {
    ...definition,
    at: new Date().toISOString(),
    node: effective.node,
    processNode: effective.process.node,
    processId: effective.process.pid,
    processEnvironmentSha256: hash(effective.process.environment),
    processDifferingKeys: processComparison.differingKeys,
    processPaddingEquivalentKeys: processComparison.paddingEquivalentKeys,
    processUnexplainedDifferences: processComparison.unexplainedDifferences,
    commandOverrides: effective.process.commandOverrides,
    configuredCount: Object.keys(configured).length,
    effectiveCount: Object.keys(effective.environment).length,
    configuredSha256: hash(configured),
    effectiveSha256: hash(effective.environment),
    differingKeys,
    paddingEquivalentKeys,
    unexplainedDifferences,
    changedSinceSnapshot,
    matches:
      unexplainedDifferences.length === 0 &&
      processComparison.unexplainedDifferences.length === 0,
  };
  const filename =
    definition.name + "-effective-environment-" + Date.now() + ".json";
  await writeFile(
    path.join(directory, filename),
    JSON.stringify(
      {
        ...entry,
        configured,
        effective: effective.environment,
        runningProcess: effective.process,
      },
      null,
      2,
    ),
    { mode: 0o600, flag: "wx" },
  );
  summary.services.push({ ...entry, privateEvidenceFile: filename });
}
summary.ok = summary.services.every((service) => service.matches);
await writeFile(
  path.join(directory, "runtime-config-inventory-" + Date.now() + ".json"),
  JSON.stringify(summary, null, 2),
  { mode: 0o600, flag: "wx" },
);
console.log(JSON.stringify(summary, null, 2));
if (!summary.ok) process.exitCode = 1;
