import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium, expect } from "@playwright/test";
const repo = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/u, "");
const require = createRequire(`${repo}/package.json`);
const { build } = createRequire(require.resolve("tsx"))("esbuild");
const employee = "11111111-1111-4111-8111-111111111111",
  a = "22222222-2222-4222-8222-222222222222",
  b = "33333333-3333-4333-8333-333333333333";
const contents = `
  import React from 'react';import {createRoot} from 'react-dom/client';
  import {InboxComposerClient} from './src/app/team/components/InboxComposerClient';
  import {insertInboxComposerDraft,inboxComposerIsBusy} from './src/app/team/inbox-composer-drafts';
  import {InboxAutoScroll} from './src/app/team/components/InboxAutoScroll';
  window.prepareCalls=[];window.prepareResolves=[];window.deferPrepare=false;window.sendCalls=[];window.sendOutcomes=[];window.sendResolves=[];window.refreshCount=0;window.insert=insertInboxComposerDraft;window.isBusy=inboxComposerIsBusy;
  function App(){const [who,setWho]=React.useState('a'),[actor,setActor]=React.useState('${employee}'),[channel,setChannel]=React.useState('sms'),[count,setCount]=React.useState(40),[history,setHistory]=React.useState(false);const id=who==='a'?'${a}':'${b}';return <main>
    <button onClick={()=>setWho('a')}>Customer A</button><button onClick={()=>setWho('b')}>Customer B</button>
    <button onClick={()=>setActor(actor==='${employee}'?'other-employee':'${employee}')}>Switch employee</button>
    <button onClick={()=>setChannel(channel==='sms'?'email':channel==='email'?'web':'sms')}>Switch channel</button>
    <div style={{height:220,overflow:'auto',border:'1px solid gray'}} id="messages">{Array.from({length:count},(_,i)=><p key={i}>Message {i}</p>)}<div id="bottom"/></div>
    <InboxAutoScroll containerId="messages" bottomId="bottom" scopeKey={actor+':'+id+':'+channel} pageKey={history?'older-cursor':'newest'} isViewingNewest={!history} depsKey={id+':'+count}/><button onClick={()=>setCount(count+1)}>New message</button><button onClick={()=>setHistory(!history)}>Toggle history</button>
    <InboxComposerClient employeeId={actor} threadId={id} contactId={channel==='web'?null:id} channel={channel} isPartnerConversation={channel==='web'} initialSubject="Subject"/>
  </main>};createRoot(document.getElementById('root')).render(<App/>);
`;
const actions = `
 export async function prepareInboxMessageAction(data){window.prepareCalls.push(Array.from(data.entries()).map(([k,v])=>[k,typeof v==='string'?v:v.name]));const result={ok:true,prepared:{version:1,employeeId:'${employee}',threadId:data.get('threadId'),contactId:data.get('contactId')||null,channel:data.get('channel'),operationKey:data.get('idempotencyKey'),payload:{body:data.get('body'),subject:data.get('subject'),direction:'outbound',channel:data.get('channel'),expectedContactId:data.get('contactId')||null,...(data.get('audience')?{audience:data.get('audience')}:{ }),...(data.getAll('attachments').length?{mediaUrls:['https://uploads.example.test/photo']}: {})}}};if(window.deferPrepare)return new Promise(resolve=>window.prepareResolves.push(()=>resolve(result)));return result;}
 export async function sendPreparedInboxMessageAction(prepared){window.sendCalls.push(prepared);const result=window.sendOutcomes.shift();if(result==='defer')return new Promise(resolve=>window.sendResolves.push(resolve));if(result==='throw')throw Error('lost');return result||{ok:true,threadId:prepared.threadId,messageId:'44444444-4444-4444-8444-444444444444',channel:prepared.channel,deliveryStatus:'queued',message:'Message queued for sending.'};}
`;

void test("inbox composer preserves scoped drafts and exact sends through navigation and recovery", async (t) => {
  const bundle = await build({
    stdin: { contents, resolveDir: `${repo}/apps/site`, loader: "tsx" },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    plugins: [
      {
        name: "mocks",
        setup(b: any) {
          b.onResolve(
            {
              filter:
                /^(next\/navigation|\.\.\/actions|\.\/InboxSpeechToTextButtonClient)$/,
            },
            (args: any) => ({ path: args.path, namespace: "mock" }),
          );
          b.onLoad({ filter: /.*/, namespace: "mock" }, (args: any) => ({
            contents:
              args.path === "next/navigation"
                ? "export const useRouter=()=>({refresh:()=>window.refreshCount++,replace:()=>{}});"
                : args.path === "../actions"
                  ? actions
                  : "export const InboxSpeechToTextButtonClient=()=>null;",
            loader: "js",
          }));
        },
      },
    ],
  });
  const script = bundle.outputFiles[0].text;
  const server = createServer((req, res) => {
    res.setHeader(
      "Content-Type",
      req.url === "/app.js" ? "application/javascript" : "text/html",
    );
    res.end(
      req.url === "/app.js"
        ? script
        : '<!doctype html><style>button{min-height:34px;margin:3px}textarea{display:block;width:95%;min-height:80px}main{max-width:600px;margin:auto}</style><div id="root"></div><script src="/app.js"></script>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("missing server");
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 800, height: 800 },
  });
  const page = await context.newPage();
  const url = `http://127.0.0.1:${address.port}`;
  const textarea = page.locator("#inbox-thread-body");
  async function reset() {
    await page.goto(url);
    await page.evaluate(() => sessionStorage.clear());
    await page.reload();
    await textarea.waitFor();
  }
  try {
    await t.test(
      "typing, additive insertion, employee/channel/thread isolation and reload",
      async () => {
        await reset();
        await textarea.fill("Draft A");
        await page
          .getByRole("button", { name: "Customer B", exact: true })
          .click();
        await expect(textarea).toHaveValue("");
        await textarea.fill("Draft B");
        await page.evaluate(
          ({ employee, a }) =>
            (window as any).insert({
              employeeId: employee,
              threadId: a,
              contactId: a,
              channel: "sms",
              body: "A extra",
            }),
          { employee, a },
        );
        await expect(textarea).toHaveValue("Draft B");
        await page
          .getByRole("button", { name: "Customer A", exact: true })
          .click();
        await expect(textarea).toHaveValue("Draft A\n\nA extra");
        await page.reload();
        await expect(textarea).toHaveValue("Draft A\n\nA extra");
        await page.evaluate(
          ({ employee, a }) =>
            (window as any).insert({
              employeeId: employee,
              threadId: a,
              contactId: a,
              channel: "sms",
              body: "Current extra",
            }),
          { employee, a },
        );
        await expect(textarea).toHaveValue(
          "Draft A\n\nA extra\n\nCurrent extra",
        );
        await page.getByRole("button", { name: "Switch employee" }).click();
        await expect(textarea).toHaveValue("");
        assert.equal(
          await page.evaluate(
            ({ employee, a }) =>
              (window as any).insert({
                employeeId: employee,
                threadId: a,
                contactId: a,
                channel: "sms",
                body: "stale",
              }),
            { employee, a },
          ),
          false,
        );
        await page.getByRole("button", { name: "Switch employee" }).click();
        await expect(textarea).not.toHaveValue("");
        await page.getByRole("button", { name: "Switch channel" }).click();
        await expect(textarea).toHaveValue("");
        await page.getByLabel("Subject", { exact: true }).fill("Email subject");
        await textarea.fill("Email text");
        await page
          .getByRole("button", { name: "Customer B", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Customer A", exact: true })
          .click();
        await expect(page.getByLabel("Subject", { exact: true })).toHaveValue(
          "Email subject",
        );
        await expect(textarea).toHaveValue("Email text");
      },
    );
    await t.test(
      "attachments survive in-app switches and honestly require reattachment after reload",
      async () => {
        await reset();
        await textarea.fill("Photo reply");
        await page.locator('input[type="file"]').setInputFiles({
          name: "photo.jpg",
          mimeType: "image/jpeg",
          buffer: Buffer.from("photo"),
        });
        await page
          .getByRole("button", { name: "Customer B", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Customer A", exact: true })
          .click();
        await expect(
          page.getByText("photo.jpg", { exact: true }),
        ).toBeVisible();
        await expect(page.getByText(/Reattach these files/)).toHaveCount(0);
        await page.reload();
        await expect(textarea).toHaveValue("Photo reply");
        await expect(page.getByText(/Reattach these files/)).toBeVisible();
        await page.getByRole("button", { name: "Remove photo.jpg" }).click();
        await expect(page.getByText(/Reattach these files/)).toHaveCount(0);
      },
    );
    await t.test(
      "expired unresolved draft replays exact prepared uploads/key after reload and preserves later edits",
      async () => {
        await reset();
        await textarea.fill("Original reply");
        await page.locator('input[type="file"]').setInputFiles({
          name: "photo.jpg",
          mimeType: "image/jpeg",
          buffer: Buffer.from("photo"),
        });
        await page.evaluate(() => (window as any).sendOutcomes.push("throw"));
        await page.getByRole("button", { name: "Send", exact: true }).click();
        await expect(
          page.getByRole("button", { name: "Check previous send" }),
        ).toBeVisible();
        const first = await page.evaluate(() => (window as any).sendCalls[0]);
        await textarea.fill("Later edited reply");
        await page.evaluate(() => {
          for (let index = 0; index < sessionStorage.length; index++) {
            const key = sessionStorage.key(index);
            if (!key?.startsWith("stonegate:inbox-draft:v1:")) continue;
            const saved = JSON.parse(sessionStorage.getItem(key)!);
            saved.updatedAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
            sessionStorage.setItem(key, JSON.stringify(saved));
          }
        });
        await page.reload();
        await expect(textarea).toHaveValue("Later edited reply");
        await page.getByRole("button", { name: "Check previous send" }).click();
        await expect(
          page.getByText("Message queued for sending."),
        ).toBeVisible();
        await expect(textarea).toHaveValue("Later edited reply");
        assert.deepEqual(
          await page.evaluate(() => (window as any).sendCalls[0]),
          first,
        );
        assert.equal(
          await page.evaluate(() => (window as any).prepareCalls.length),
          0,
        );
      },
    );
    await t.test(
      "rapid clicks dispatch once and confirmed send clears only submitted text",
      async () => {
        await reset();
        await textarea.fill("First reply");
        await page.evaluate(() => (window as any).sendOutcomes.push("defer"));
        await page
          .getByRole("button", { name: "Send", exact: true })
          .evaluate((button) => {
            (button as HTMLButtonElement).click();
            (button as HTMLButtonElement).click();
          });
        await expect
          .poll(() => page.evaluate(() => (window as any).sendCalls.length))
          .toBe(1);
        await textarea.fill("First reply\n\nLater addition");
        await page.evaluate(
          ({ a }) =>
            (window as any).sendResolves[0]({
              ok: true,
              threadId: a,
              channel: "sms",
              deliveryStatus: "queued",
              message: "Message queued for sending.",
            }),
          { a },
        );
        await expect(textarea).toHaveValue("Later addition");
        await expect(
          page.getByRole("button", { name: "Check previous send" }),
        ).toHaveCount(0);
        await page.getByRole("button", { name: "Send", exact: true }).click();
        await expect(textarea).toHaveValue("");
        await page.reload();
        await expect(textarea).toHaveValue("");
      },
    );
    await t.test(
      "slow preparation stays locked across recipient remounts",
      async () => {
        await reset();
        await textarea.fill("Slow upload reply");
        await page.evaluate(() => {
          (window as any).deferPrepare = true;
        });
        await page.getByRole("button", { name: "Send", exact: true }).click();
        await expect
          .poll(() => page.evaluate(() => (window as any).prepareCalls.length))
          .toBe(1);
        await page
          .getByRole("button", { name: "Customer B", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Customer A", exact: true })
          .click();
        await expect(
          page.getByRole("button", { name: "Sending…", exact: true }),
        ).toBeDisabled();
        await page.locator("[data-inbox-composer]").evaluate((form) => {
          form.dispatchEvent(
            new Event("submit", { bubbles: true, cancelable: true }),
          );
        });
        assert.equal(
          await page.evaluate(() => (window as any).prepareCalls.length),
          1,
        );
        await page.evaluate(() => (window as any).prepareResolves[0]());
        await expect
          .poll(() => page.evaluate(() => (window as any).sendCalls.length))
          .toBe(1);
        await expect(textarea).toHaveValue("");
        await expect(
          page.getByText("Message queued for sending."),
        ).toBeVisible();
        assert.equal(
          await page.evaluate(() => (window as any).refreshCount),
          1,
        );
      },
    );
    await t.test(
      "partner audience drafts stay separate and opening does not send",
      async () => {
        await reset();
        await page.getByRole("button", { name: "Switch channel" }).click();
        await page.getByRole("button", { name: "Switch channel" }).click();
        await page
          .getByLabel("Who can see this message?")
          .selectOption("partner");
        await textarea.fill("Partner reply");
        await page
          .getByLabel("Who can see this message?")
          .selectOption("internal");
        await expect(textarea).toHaveValue("");
        await textarea.fill("Internal note");
        await page
          .getByLabel("Who can see this message?")
          .selectOption("partner");
        await expect(textarea).toHaveValue("Partner reply");
        assert.equal(
          await page.evaluate(() => (window as any).sendCalls.length),
          0,
        );
      },
    );
    await t.test(
      "ordinary text-only drafts still expire after seven days",
      async () => {
        await reset();
        await textarea.fill("Old unsent text");
        await page.evaluate(() => {
          for (let index = 0; index < sessionStorage.length; index++) {
            const key = sessionStorage.key(index);
            if (!key?.startsWith("stonegate:inbox-draft:v1:")) continue;
            const saved = JSON.parse(sessionStorage.getItem(key)!);
            saved.updatedAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
            sessionStorage.setItem(key, JSON.stringify(saved));
          }
        });
        await page.reload();
        await expect(textarea).toHaveValue("");
      },
    );
    await t.test(
      "storage failure preserves drafts in memory across navigation",
      async () => {
        await reset();
        await page.evaluate(() => {
          Storage.prototype.setItem = () => {
            throw Error("blocked");
          };
          Storage.prototype.getItem = () => {
            throw Error("blocked");
          };
        });
        await textarea.fill("Memory draft");
        await expect(
          page.getByText(/Browser storage is unavailable/),
        ).toBeVisible();
        await page
          .getByRole("button", { name: "Customer B", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Customer A", exact: true })
          .click();
        await expect(textarea).toHaveValue("Memory draft");
      },
    );
    await t.test(
      "new messages preserve historical reading position and never scroll the page",
      async () => {
        await reset();
        await page.locator("#messages").evaluate((element) => {
          element.scrollTop = 50;
          element.dispatchEvent(new Event("scroll"));
        });
        const before = await page.evaluate(() => window.scrollY);
        await page.getByRole("button", { name: "New message" }).click();
        assert.equal(
          await page
            .locator("#messages")
            .evaluate((element) => element.scrollTop),
          50,
        );
        assert.equal(await page.evaluate(() => window.scrollY), before);
        await page
          .getByRole("button", { name: "Customer B", exact: true })
          .click();
        await expect
          .poll(() =>
            page.locator("#messages").evaluate((element) => element.scrollTop),
          )
          .toBeGreaterThan(50);
        await page
          .getByRole("button", { name: "Customer A", exact: true })
          .click();
        await expect
          .poll(() =>
            page.locator("#messages").evaluate((element) => element.scrollTop),
          )
          .toBe(50);
        await page.getByRole("button", { name: "Toggle history" }).click();
        await expect
          .poll(() =>
            page.locator("#messages").evaluate((element) => element.scrollTop),
          )
          .toBe(0);
        await page.getByRole("button", { name: "Toggle history" }).click();
        await expect
          .poll(() =>
            page.locator("#messages").evaluate((element) => element.scrollTop),
          )
          .toBe(50);
      },
    );
  } finally {
    await context.close();
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
