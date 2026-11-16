import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
const directory = process.argv[2];
if (!directory) throw Error("Private evidence directory required");
const isSource = process.argv[3] === "source";
const route = process.argv[3] === "api" || isSource ? "/api-check" : "/check";
const token = (
  await readFile(path.join(directory, "probe-token"), "utf8")
).trim();
const base = isSource
  ? "https://stonegate-source-readiness.jeffrey-78e.workers.dev"
  : "https://stonegate-database-validation.jeffrey-78e.workers.dev";
const { createHash } = await import("node:crypto");
const vm = await import("node:vm");
const probeSource = await readFile(
  new URL(
    "../../infra/cloudflare/containers/database-check.ts",
    import.meta.url,
  ),
  "utf8",
);
const probeCode = vm.runInNewContext(
  probeSource.slice(
    probeSource.indexOf("String.raw`"),
    probeSource.lastIndexOf(";"),
  ),
);
const expectedHash = createHash("sha256").update(probeCode).digest("hex");
const checks = [];
const unauthorized = await fetch(base + "/check", { method: "POST" });
checks.push({
  name: "reject-unauthenticated",
  pass: unauthorized.status === 401,
});
await unauthorized.body?.cancel();
try {
  for (let cycle = 0; cycle < 2; cycle++) {
    const start = performance.now();
    const response = await fetch(base + route, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(180000),
    });
    const result = {
      route,
      cycle,
      status: response.status,
      ms: Math.round(performance.now() - start),
      ...(await response.json()),
    };
    const versionMatches =
      !isSource ||
      response.headers.get("x-stonegate-probe-sha256") === expectedHash;
    checks.push({
      ...result,
      versionMatches,
      pass: response.ok && result.ok === true && versionMatches,
    });
    console.log(JSON.stringify(result));
    const stop = await fetch(base + "/stop", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    });
    await stop.body?.cancel();
    if (!stop.ok) throw Error("Restore container stop failed");
    if (!response.ok) break;
  }
} finally {
  const stop = await fetch(base + "/stop", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
  });
  await stop.body?.cancel();
  if (!stop.ok)
    checks.push({
      name: "container-cleanup",
      pass: false,
      status: stop.status,
    });
  await writeFile(
    path.join(
      directory,
      `container-${isSource ? "source" : "database"}-validation-${Date.now()}.json`,
    ),
    JSON.stringify({ at: new Date().toISOString(), checks }),
    { mode: 0o600, flag: "wx" },
  );
}
console.log(
  JSON.stringify({
    checks: checks.length,
    failures: checks.filter((x) => !x.pass).length,
  }),
);
if (checks.some((x) => !x.pass)) process.exitCode = 1;
