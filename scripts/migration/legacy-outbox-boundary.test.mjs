import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { holdLegacyOutboxBoundary } from "./legacy-outbox-boundary.mjs";

const source = `
let count=0; const batchSize=1;
async function runOnce(){const id=++count; console.log('started:'+id); await new Promise(r=>setTimeout(r,700));console.log('committed:'+id);return {total:1};}
async function main(){while(true){const stats=await runOnce(batchSize);console.log('schedulers-finished');}}
main();
`;
async function fixture(run) {
  const dir = await mkdtemp(path.join(tmpdir(), "stonegate-legacy-boundary-"));
  const filename = path.join(dir, "outbox-worker.cjs");
  await writeFile(filename, source);
  const child = spawn(process.execPath, ["--inspect=127.0.0.1:0", filename], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "",
    stderr = "";
  child.stdout.on("data", (x) => (output += x));
  child.stderr.on("data", (x) => (stderr += x));
  try {
    for (let i = 0; i < 100 && !output.includes("started:1"); i++)
      await wait(10);
    const websocket = stderr.match(/ws:\/\/127\.0\.0\.1:\d+\/[0-9a-f-]+/)?.[0];
    assert.ok(websocket);
    await run(
      {
        websocket,
        pid: child.pid,
        filename,
        sha256: createHash("sha256").update(source).digest("hex"),
        timeoutMs: 4000,
      },
      () => output,
    );
  } finally {
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("close", resolve));
    await rm(dir, { recursive: true });
  }
}
test(
  "legacy worker finishes accepted work and schedulers before holding the next batch",
  { timeout: 10000 },
  async () => {
    await fixture(async (options, output) => {
      let settled = false;
      const pending = holdLegacyOutboxBoundary(options).then((x) => {
        settled = true;
        return x;
      });
      pending.catch(() => {});
      await wait(100);
      assert.equal(settled, false);
      const held = await pending;
      try {
        assert.equal(held.paused, true);
        assert.match(output(), /committed:1\nschedulers-finished/);
        assert.doesNotMatch(output(), /started:2/);
        await wait(150);
        assert.doesNotMatch(output(), /started:2/);
      } finally {
        await held.release();
      }
      for (let i = 0; i < 50 && !output().includes("started:2"); i++)
        await wait(10);
      assert.match(output(), /started:2/);
    });
  },
);
test(
  "identity mismatch refuses to pause the worker",
  { timeout: 10000 },
  async () => {
    await fixture(async (options, output) => {
      await assert.rejects(
        holdLegacyOutboxBoundary({ ...options, sha256: "0".repeat(64) }),
        /identity mismatch/,
      );
      for (let i = 0; i < 100 && !output().includes("started:2"); i++)
        await wait(10);
      assert.match(output(), /started:2/);
    });
  },
);

test(
  "boundary timeout leaves the old worker running",
  { timeout: 10000 },
  async () => {
    await fixture(async (options, output) => {
      await assert.rejects(
        holdLegacyOutboxBoundary({ ...options, timeoutMs: 100 }),
        /boundary timeout/,
      );
      for (let i = 0; i < 100 && !output().includes("started:2"); i++)
        await wait(10);
      assert.match(output(), /committed:1/);
      assert.match(output(), /started:2/);
    });
  },
);

test(
  "a hold expires and resumes the old worker unless service termination is confirmed",
  { timeout: 10000 },
  async () => {
    await fixture(async (options, output) => {
      const held = await holdLegacyOutboxBoundary({ ...options, holdMs: 100 });
      try {
        assert.equal(held.paused, true);
        for (let i = 0; i < 100 && !output().includes("started:2"); i++)
          await wait(10);
        assert.equal(held.paused, false);
        assert.match(output(), /started:2/);
      } finally {
        await held.release();
      }
    });
  },
);
