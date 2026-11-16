import { readFile, writeFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import webhooks from "../../infra/cloudflare/webhook-journal/node_modules/twilio/lib/webhooks/webhooks.js";
import path from "node:path";
const directory = process.argv[2];
if (!directory) throw Error("Private evidence directory required");
const secrets = JSON.parse(
  await readFile(path.join(directory, "webhook-journal-secrets.json"), "utf8"),
);
const base =
  "https://stonegate-webhook-journal-validation.jeffrey-78e.workers.dev";
const origin = "https://migration-provider.invalid";
const checks = [];
const trials = [];
function check(name, pass) {
  checks.push({ name, pass });
  if (!pass) throw Error("Journal check failed: " + name);
}
async function call(run, route, init = {}, authorized = true) {
  const headers = new Headers(init.headers);
  headers.set("x-migration-trial-id", run);
  if (authorized)
    headers.set("x-migration-journal-key", secrets.MIGRATION_PROBE_TOKEN);
  return fetch(base + route, {
    ...init,
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(30000),
  });
}
async function status(run, fixture = false) {
  const r = await call(
    run,
    fixture ? "/__fixture/status" : "/__journal/status",
  );
  if (!r.ok) throw Error("Journal status unavailable");
  return r.json();
}
function payload(mode = "success", large = false) {
  const form = {
    MessageSid: "SM" + randomUUID().replaceAll("-", ""),
    Body: large ? "a".repeat(200000) : "synthetic only ☃",
    FixtureMode: mode,
  };
  const body = new URLSearchParams(form).toString();
  const route = "/api/webhooks/twilio/sms?preserve=%2F&next=one&next=two";
  const signature = webhooks.getExpectedTwilioSignature(
    secrets.SYNTHETIC_TWILIO_TOKEN,
    origin + route,
    form,
  );
  return {
    route,
    body,
    signature,
    sha: createHash("sha256").update(body).digest("hex"),
    urlSha: createHash("sha256")
      .update(origin + route)
      .digest("hex"),
  };
}
async function ingest(run, item, override = {}) {
  const r = await call(run, item.route, {
    method: "POST",
    body: item.body,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": item.signature,
    },
    ...override,
  });
  await r.body?.cancel();
  return { status: r.status, id: r.headers.get("x-migration-journal-id") };
}
async function replay(run, interrupt = false) {
  const r = await call(run, "/__journal/replay", {
    method: "POST",
    headers: interrupt ? { "x-migration-interrupt-after-commit": "1" } : {},
  });
  return { status: r.status, body: await r.json() };
}
try {
  const run = randomUUID();
  trials.push(run);
  const denied = await call(run, "/__journal/status", {}, false);
  await denied.body?.cancel();
  check("unauthenticated-control-rejected", denied.status === 401);
  const item = payload();
  check(
    "invalid-signature-rejected",
    (await ingest(run, { ...item, signature: "invalid" })).status === 403,
  );
  check(
    "changed-query-rejected",
    (await ingest(run, { ...item, route: item.route + "changed" })).status ===
      403,
  );
  check("rejections-not-persisted", (await status(run)).rows.length === 0);
  const accepted = await Promise.all(
    Array.from({ length: 20 }, () => ingest(run, item)),
  );
  check(
    "concurrent-duplicate-acks-deduplicate",
    accepted.every((x) => x.status === 200 && x.id === accepted[0].id),
  );
  let rows = (await status(run)).rows;
  check(
    "acknowledged-event-is-durable-and-byte-exact",
    rows.length === 1 &&
      rows[0].state === "pending" &&
      rows[0].body_sha === item.sha &&
      rows[0].bytes === Buffer.byteLength(item.body),
  );
  check(
    "ingestion-does-not-dispatch-during-freeze",
    (await status(run, true)).receipts.length === 0,
  );
  const large = payload("success", true);
  const largeAck = await ingest(run, large);
  check(
    "large-form-persists-without-truncation",
    largeAck.status === 200 &&
      (await status(run)).rows.find((x) => x.id === largeAck.id)?.body_sha ===
        large.sha,
  );
  let result = await replay(run);
  check(
    "explicit-replay-delivers-pending",
    result.status === 200 && result.body.processed === 2,
  );
  rows = (await status(run)).rows;
  check(
    "only-confirmed-success-marked-delivered",
    rows.every(
      (x) =>
        x.state === "delivered" &&
        x.attempts === 1 &&
        x.upstream_status === 200,
    ),
  );
  const receipts = (await status(run, true)).receipts;
  check(
    "receiver-reverifies-signature-and-original-url",
    receipts.length === 2 &&
      receipts.every((x) => x.attempts === 1 && x.url_sha === item.urlSha) &&
      receipts.some((x) => x.body_sha === item.sha) &&
      receipts.some((x) => x.body_sha === large.sha),
  );
  result = await replay(run);
  check(
    "delivered-events-not-replayed",
    result.status === 200 && result.body.processed === 0,
  );
  check(
    "duplicate-after-delivery-retains-receipt",
    (await ingest(run, item)).status === 200 &&
      (await status(run)).rows.length === 2 &&
      (await status(run, true)).receipts.every((x) => x.attempts === 1),
  );
  for (const mode of ["lost", "reject", "interrupt"]) {
    const trial = randomUUID();
    trials.push(trial);
    const first = payload(mode === "interrupt" ? "success" : mode);
    const second = payload();
    const ack = await ingest(trial, first);
    await ingest(trial, second);
    result = await replay(trial, mode === "interrupt");
    if (mode === "interrupt")
      check(
        "forced-controller-crash-not-successfully-acknowledged",
        result.status === 503,
      );
    rows = (await status(trial)).rows;
    check(
      mode + ":uncertain-result-preserved",
      rows[0].id === ack.id &&
        rows[0].state === "uncertain" &&
        rows[0].attempts === 1 &&
        rows[0].body_sha === first.sha,
    );
    check(
      mode + ":later-events-remain-pending",
      rows[1].state === "pending" && rows[1].attempts === 0,
    );
    result = await replay(trial);
    check(
      mode + ":replay-requires-reconciliation",
      result.status === 409 && result.body.error === "reconciliation_required",
    );
    const received = (await status(trial, true)).receipts;
    check(
      mode + ":downstream-not-called-twice",
      received.length === 1 &&
        received[0].id === ack.id &&
        received[0].attempts === 1 &&
        received[0].body_sha === first.sha,
    );
    if (mode === "interrupt")
      check(
        "recreated-controller-detects-interrupted-dispatch",
        rows[0].reason === "controller_restarted_during_dispatch",
      );
  }
} catch (error) {
  checks.push({ name: "trial-failed", pass: false, error: error.message });
  process.exitCode = 1;
}
const receipt = {
  at: new Date().toISOString(),
  ok: checks.every((x) => x.pass),
  trials,
  checks,
};
await writeFile(
  path.join(directory, `webhook-journal-validation-${Date.now()}.json`),
  JSON.stringify(receipt, null, 2),
  { mode: 0o600, flag: "wx" },
);
console.log(JSON.stringify(receipt));
