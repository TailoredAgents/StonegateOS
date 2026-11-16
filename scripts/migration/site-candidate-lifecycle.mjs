import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
const [directory, action] = process.argv.slice(2);
if (!directory || !["start", "check", "stop"].includes(action))
  throw Error(
    "Usage: site-candidate-lifecycle.mjs <private-directory> start|check|stop",
  );
const token = (
  await readFile(path.join(directory, "probe-token"), "utf8")
).trim();
const base =
  "https://stonegate-site-candidate.jeffrey-78e.workers.dev/__candidate";
async function call(route, method = "GET") {
  const r = await fetch(base + route, {
    method,
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(150000),
  });
  if (!r.ok) throw Error("Candidate control status " + r.status);
  return r.json();
}
if (action === "stop") {
  console.log(JSON.stringify(await call("/stop", "POST")));
} else if (action === "start") {
  await call("/start", "POST");
  const start = await call("/status");
  if (!start.healthy || !start.image?.labels?.started)
    throw Error("Candidate not ready");
  await writeFile(
    path.join(directory, "site-candidate-lifecycle-start.json"),
    JSON.stringify(start),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      started: true,
      healthy: start.healthy,
      lease: start.lease,
    }),
  );
} else {
  const start = JSON.parse(
    await readFile(
      path.join(directory, "site-candidate-lifecycle-start.json"),
      "utf8",
    ),
  );
  const current = await call("/status");
  const pass =
    current.healthy === true &&
    current.lastHealth?.healthy === true &&
    current.lastHealth.at > Number(start.image.labels.started) &&
    current.executionId !== start.executionId &&
    current.image?.image === start.image.image &&
    current.image?.labels.started === start.image.labels.started &&
    current.lease === start.lease;
  await writeFile(
    path.join(directory, `site-candidate-lifecycle-${Date.now()}.json`),
    JSON.stringify({ at: new Date().toISOString(), pass, start, current }),
    { mode: 0o600, flag: "wx" },
  );
  console.log(
    JSON.stringify({
      pass,
      healthy: current.healthy,
      alarmHealthy: current.lastHealth?.healthy,
      sameContainer:
        current.image?.labels.started === start.image.labels.started,
      recreatedController: current.executionId !== start.executionId,
    }),
  );
  if (!pass) process.exitCode = 1;
}
