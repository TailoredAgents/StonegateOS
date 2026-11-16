import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { setTimeout as wait } from "node:timers/promises";

// Exercise the actual controller with durable storage and an inert container.
// No provider code or credentials are executed by these failure drills.
const source = await readFile(
  new URL("../../infra/cloudflare/providers/worker.ts", import.meta.url),
  "utf8",
);
const stub =
  "data:text/javascript," +
  encodeURIComponent(
    "export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env;}}",
  );
const code = stripTypeScriptTypes(source, { mode: "strip" })
  .replace('from "cloudflare:workers"', "from " + JSON.stringify(stub))
  .replace(
    'import { providerProbe } from "./probe";',
    'const providerProbe = "inert fixture";',
  );
const { ProviderTrial } = await import(
  "data:text/javascript;base64," + Buffer.from(code).toString("base64")
);

async function fixture({ rows = new Map(), execute, configuration } = {}) {
  const config =
    configuration ??
    JSON.stringify({
      purpose: "authorized-migration-deliveries",
      runId: "SG-CF-000000000000",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
  const calls = [];
  let initialized;
  const ctx = {
    storage: {
      get: async (key) => structuredClone(rows.get(key)),
      put: async (key, value) => {
        rows.set(key, structuredClone(value));
      },
    },
    blockConcurrencyWhile: (fn) => {
      initialized = fn();
    },
    container: {
      running: true,
      images: { base: "pinned-fixture-image" },
      setInactivityTimeout: async () => {},
      getTcpPort: () => ({ fetch: async () => new Response("ok") }),
      exec: async (_args, options) => {
        const action = options.env.MIGRATION_PROVIDER_ACTION;
        calls.push(action);
        const result =
          action === "preflight" ? { ok: true } : await execute(action);
        return {
          output: async () => ({
            stdout: new TextEncoder().encode(JSON.stringify(result)),
          }),
        };
      },
    },
  };
  const trial = new ProviderTrial(ctx, { MIGRATION_PROVIDER_CONFIG: config });
  await initialized;
  return {
    rows,
    calls,
    configuration: config,
    request: (route) =>
      trial.fetch(
        new Request("https://trial.invalid" + route, { method: "POST" }),
      ),
  };
}
test("an accepted send stays blocked across requests and controller reconstruction", async () => {
  const first = await fixture({
    execute: async () => ({
      ok: true,
      certainty: "accepted",
      providerMessageId: "fixture",
    }),
  });
  assert.equal((await first.request("/send/sms")).status, 409);
  assert.deepEqual(first.calls, []);
  assert.equal((await first.request("/preflight")).status, 200);
  assert.equal((await first.request("/send/sms")).status, 200);
  assert.equal((await first.request("/send/sms")).status, 409);
  const next = await fixture({
    rows: first.rows,
    configuration: first.configuration,
    execute: () => {
      throw Error("Must not send");
    },
  });
  assert.equal((await next.request("/send/sms")).status, 409);
  assert.deepEqual(first.calls, ["preflight", "sms"]);
  assert.deepEqual(next.calls, []);
});
test("lost responses and interrupted dispatch remain uncertain and are never retried", async () => {
  const first = await fixture({
    execute: () => {
      throw Error("Response lost after effect");
    },
  });
  await first.request("/preflight");
  assert.equal((await first.request("/send/email")).status, 503);
  assert.equal(first.rows.get("email").phase, "uncertain");
  first.rows.set("sms", { phase: "dispatching", at: new Date().toISOString() });
  const next = await fixture({
    rows: first.rows,
    configuration: first.configuration,
    execute: () => {
      throw Error("Must not send");
    },
  });
  assert.equal(next.rows.get("sms").phase, "uncertain");
  for (const channel of ["sms", "email"])
    assert.equal((await next.request("/send/" + channel)).status, 409);
  assert.deepEqual(next.calls, []);
});
test("concurrent requests cannot admit a second provider operation", async () => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const trial = await fixture({
    execute: async () => {
      await held;
      return { ok: true, certainty: "accepted" };
    },
  });
  await trial.request("/preflight");
  const pending = trial.request("/send/sms");
  for (let i = 0; i < 100 && !trial.calls.includes("sms"); i++) await wait(1);
  try {
    assert.equal((await trial.request("/send/sms")).status, 409);
    assert.deepEqual(trial.calls, ["preflight", "sms"]);
  } finally {
    release();
  }
  assert.equal((await pending).status, 200);
});
