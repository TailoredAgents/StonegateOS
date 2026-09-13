import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
const repo = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/u, "");
const require = createRequire(`${repo}/package.json`);
const { build } = createRequire(require.resolve("tsx"))("esbuild");
const employee = "11111111-1111-4111-8111-111111111111",
  thread = "22222222-2222-4222-8222-222222222222",
  contact = "33333333-3333-4333-8333-333333333333",
  message = "44444444-4444-4444-8444-444444444444";

void test("inline inbox send prepares once, verifies receipts and preserves exact uncertain replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stonegate-inbox-actions-"));
  try {
    const source = await readFile(
      `${repo}/apps/site/src/app/team/actions.ts`,
      "utf8",
    );
    const functions = source.slice(
      source.indexOf("export async function prepareInboxMessageAction"),
      source.indexOf("export async function retryFailedMessageAction"),
    );
    await build({
      stdin: {
        contents: `
      import {isInboxPreparedMessage} from './apps/site/src/app/team/inbox-composer-types';
      const isUuid=value=>/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
      const requireCurrentTeamPrincipal=async()=>{if(globalThis.__authThrows)throw Error("session");return globalThis.__principal;};
      const hasTeamPermission=(p,k)=>p.permissions.includes(k);
      const callAdminApiAs=async(p,path,init)=>{globalThis.__calls.push({path,init});return globalThis.__answer(path,init);};
      const readErrorMessage=async(res,fallback)=>{const p=await res.json();return p.message||p.error||fallback;};
      const revalidatePath=()=>{}; const teamSurfaceHref=()=>'/team/inbox';
      const cookies=async()=>({set:()=>{}}); const redirect=url=>{throw new Error('redirect:'+url);};
      ${functions}
    `,
        resolveDir: repo,
        loader: "ts",
      },
      outfile: `${directory}/actions.mjs`,
      bundle: true,
      platform: "node",
      format: "esm",
    });
    const actions = await import(
      pathToFileURL(`${directory}/actions.mjs`).href
    );
    const global = globalThis as any;
    let status = 200,
      responsePayload: any,
      headers: Record<string, string> = {};
    function receipt(deliveryStatus = "queued") {
      return {
        message: {
          id: message,
          threadId: thread,
          direction: "outbound",
          channel: "sms",
          deliveryStatus,
          createdAt: "2026-09-13T12:00:00.000Z",
        },
      };
    }
    function reset() {
      status = 200;
      headers = {};
      responsePayload = receipt();
      global.__calls = [];
      global.__authThrows = false;
      global.__principal = {
        memberId: employee,
        permissions: ["messages.send"],
      };
      global.__answer = (path: string) => {
        if (path.includes("?limit="))
          throw Error("Message reads are unavailable");
        if (path.endsWith("/ensure"))
          return Response.json({ threadId: thread });
        if (path.endsWith("/uploads"))
          return Response.json({
            uploads: [{ url: "https://uploads.example.test/photo" }],
          });
        return Response.json(responsePayload, { status, headers });
      };
    }
    function form(withFile = false) {
      const f = new FormData();
      Object.entries({
        threadId: thread,
        contactId: contact,
        channel: "sms",
        body: "Hello customer",
        idempotencyKey: "team-inbox:test-operation-12345",
      }).forEach(([key, value]) => f.set(key, value));
      if (withFile)
        f.append(
          "attachments",
          new Blob(["photo"], { type: "image/jpeg" }),
          "photo.jpg",
        );
      return f;
    }
    reset();
    const prepared = await actions.prepareInboxMessageAction(form(true));
    assert.equal(prepared.ok, true);
    assert.deepEqual(prepared.prepared.payload.mediaUrls, [
      "https://uploads.example.test/photo",
    ]);
    assert.equal(
      global.__calls.filter((call: any) => call.path.endsWith("/messages"))
        .length,
      0,
    );
    status = 503;
    responsePayload = { error: "unavailable" };
    assert.equal(
      (await actions.sendPreparedInboxMessageAction(prepared.prepared))
        .uncertain,
      true,
    );
    const firstDispatch = global.__calls.at(-1);
    status = 200;
    responsePayload = receipt();
    const queued = await actions.sendPreparedInboxMessageAction(
      prepared.prepared,
    );
    assert.equal(queued.ok, true);
    assert.equal(queued.message, "Message queued for sending.");
    assert.deepEqual(global.__calls.at(-1), firstDispatch);
    assert.equal(
      global.__calls.filter((call: any) => call.path.endsWith("/uploads"))
        .length,
      1,
    );
    responsePayload = receipt("delivered");
    assert.equal(
      (await actions.sendPreparedInboxMessageAction(prepared.prepared)).message,
      "Message delivered.",
    );
    responsePayload = receipt("failed");
    assert.match(
      (await actions.sendPreparedInboxMessageAction(prepared.prepared)).message,
      /delivery failed/,
    );
    for (const bad of [
      null,
      { message: { ...receipt().message, threadId: contact } },
      { message: { ...receipt().message, channel: "email" } },
      { message: { ...receipt().message, deliveryStatus: "nonsense" } },
    ]) {
      responsePayload = bad;
      assert.equal(
        (await actions.sendPreparedInboxMessageAction(prepared.prepared))
          .uncertain,
        true,
      );
    }
    status = 409;
    responsePayload = { code: "conflict", retryable: true };
    headers = { "Retry-After": "2" };
    assert.equal(
      (await actions.sendPreparedInboxMessageAction(prepared.prepared))
        .uncertain,
      true,
    );
    headers = {};
    for (const conflict of [
      { code: "conflict", retryable: false },
      { error: "idempotency_key_expired", retryable: false },
      null,
    ]) {
      responsePayload = conflict;
      const unresolved = await actions.sendPreparedInboxMessageAction(
        prepared.prepared,
      );
      assert.equal(unresolved.uncertain, true);
      assert.match(unresolved.error, /Check this conversation's messages/);
    }
    status = 429;
    responsePayload = { error: "rate_limited" };
    assert.equal(
      (await actions.sendPreparedInboxMessageAction(prepared.prepared))
        .uncertain,
      true,
    );
    reset();
    assert.equal(
      (
        await actions.sendPreparedInboxMessageAction({
          ...prepared.prepared,
          payload: { ...prepared.prepared.payload, allowDncOverride: true },
        })
      ).ok,
      false,
    );
    assert.equal(global.__calls.length, 0);
    reset();
    global.__authThrows = true;
    assert.equal(
      (await actions.sendPreparedInboxMessageAction(prepared.prepared))
        .uncertain,
      true,
    );
    assert.equal(global.__calls.length, 0);
    reset();
    global.__principal.permissions = [];
    assert.equal(
      (await actions.sendPreparedInboxMessageAction(prepared.prepared))
        .uncertain,
      true,
    );
    for (const authStatus of [401, 403]) {
      reset();
      status = authStatus;
      responsePayload = { error: "unauthorized" };
      assert.equal(
        (await actions.sendPreparedInboxMessageAction(prepared.prepared))
          .uncertain,
        true,
      );
    }
    reset();
    const bound = await actions.prepareInboxMessageAction(form());
    assert.equal(bound.ok, true);
    assert.equal(bound.prepared.payload.expectedContactId, contact);
    assert.equal(global.__calls.length, 0);
    status = 409;
    responsePayload = { error: "thread_context_mismatch" };
    const mismatch = await actions.sendPreparedInboxMessageAction(
      bound.prepared,
    );
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.uncertain, false);
    assert.match(mismatch.error, /recipient changed/);
    reset();
    global.__principal.permissions = [];
    assert.equal((await actions.prepareInboxMessageAction(form())).ok, false);
    assert.equal(global.__calls.length, 0);
    reset();
    assert.equal(
      (
        await actions.sendPreparedInboxMessageAction({
          ...prepared.prepared,
          employeeId: contact,
        })
      ).ok,
      false,
    );
    assert.equal(global.__calls.length, 0);
    reset();
    const noThread = form();
    noThread.delete("threadId");
    assert.equal((await actions.prepareInboxMessageAction(noThread)).ok, true);
    assert.equal(global.__calls[0].path.endsWith("/ensure"), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
