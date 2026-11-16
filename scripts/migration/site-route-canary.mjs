// A single preserved public CSS file tests the actual zone routing path before
// any broad website route. Always remove this exact temporary route afterwards.
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
const [directory, host] = process.argv.slice(2);
if (
  !directory ||
  !["stonegatejunkremoval.com", "www.stonegatejunkremoval.com"].includes(host)
)
  throw Error("Private evidence directory and exact website host required");
const oauth = JSON.parse(
  (
    await readFile(
      path.join(homedir(), "Library/Preferences/.wrangler/config/default.toml"),
      "utf8",
    )
  ).match(/^oauth_token\s*=\s*(".*")\s*$/m)[1],
);
const api =
  "https://api.cloudflare.com/client/v4/zones/7eb7c6c85a93c7b0cae01de78028a40f/workers/routes";
async function cf(suffix, method = "GET", body) {
  const r = await fetch(api + suffix, {
    method,
    headers: {
      authorization: "Bearer " + oauth,
      "content-type": "application/json",
      "cache-control": "no-cache",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const d = await r.json();
  if (!r.ok || !d.success) throw Error("Route request failed: " + r.status);
  return d.result;
}
const css = "/_next/static/chunks/01636fdab6b170b6.css";
const pattern = "https://" + host + css + "*";
const script = "stonegate-site-rollback-validation";
if ((await cf("")).some((r) => r.pattern === pattern))
  throw Error("Canary route already exists");
let route;
const attempts = [];
let cleaned = false;
try {
  route = await cf("", "POST", { pattern, script });
  for (let i = 0; i < 40; i++) {
    const r = await fetch("https://" + host + css + "?migration_canary=" + i, {
      redirect: "manual",
      headers: { "cache-control": "no-cache" },
      signal: AbortSignal.timeout(15000),
    });
    const bytes = Buffer.from(await r.arrayBuffer());
    const check = {
      at: new Date().toISOString(),
      status: r.status,
      bytes: bytes.length,
      route: r.headers.get("x-migration-site-route"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    check.pass =
      check.status === 200 &&
      check.route === "preserved-static" &&
      check.bytes === 3968 &&
      check.sha256 ===
        "8fc6da7a117cb65eb798c173fd12af0b6eef75aa8cbf1410c14acd16d72f7643";
    attempts.push(check);
    if (check.pass) break;
    if (i % 10 === 0)
      console.log(
        JSON.stringify({
          waiting: true,
          host,
          status: check.status,
          seconds: i * 2,
        }),
      );
    await delay(2000);
  }
} finally {
  if (route) {
    await cf("/" + route.id, "DELETE");
    cleaned = true;
  }
  const receipt = {
    at: new Date().toISOString(),
    host,
    pattern,
    routeId: route?.id,
    ok: attempts.at(-1)?.pass === true && cleaned,
    attempts,
    cleaned,
  };
  await writeFile(
    path.join(directory, "site-route-canary-" + Date.now() + ".json"),
    JSON.stringify(receipt, null, 2),
    { mode: 0o600, flag: "wx" },
  );
  console.log(
    JSON.stringify({
      ...receipt,
      attempts: attempts.length,
      last: attempts.at(-1),
    }),
  );
  if (!receipt.ok) process.exitCode = 1;
}
