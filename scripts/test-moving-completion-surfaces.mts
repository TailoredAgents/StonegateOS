import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { chromium, expect } from "@playwright/test";

const repo = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/u, "");
const require = createRequire(`${repo}/package.json`);
const { build } = createRequire(require.resolve("tsx"))("esbuild");
const id = "11111111-1111-4111-8111-111111111111";
const member = "22222222-2222-4222-8222-222222222222";
const version = "2026-09-10T12:00:00.000Z";

// Compile the actual private server-rendered form and only its dependencies.
// This keeps the production module private and avoids a separate mock form.
async function componentSource(file: string, name: string): Promise<string> {
  const source = await readFile(file, "utf8");
  const ast = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const declarations = new Map<string, ts.Statement>();
  for (const statement of ast.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name)
      declarations.set(statement.name.text, statement);
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name))
          declarations.set(declaration.name.text, statement);
      }
  }
  const selected = new Set<ts.Statement>();
  const names = new Set<string>([name]);
  const pending = [name];
  while (pending.length) {
    const statement = declarations.get(pending.pop()!);
    if (!statement || selected.has(statement)) continue;
    selected.add(statement);
    const scan = (node: ts.Node) => {
      if (ts.isIdentifier(node) && !names.has(node.text)) {
        names.add(node.text);
        pending.push(node.text);
      }
      ts.forEachChild(node, scan);
    };
    scan(statement);
  }
  const printer = ts.createPrinter();
  const imports = ast.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) || !statement.importClause)
      return [];
    const clause = statement.importClause;
    const defaultName =
      clause.name && names.has(clause.name.text) ? clause.name : undefined;
    const bindings = clause.namedBindings;
    const named =
      bindings && ts.isNamedImports(bindings)
        ? ts.factory.createNamedImports(
            bindings.elements.filter((element) => names.has(element.name.text)),
          )
        : bindings && names.has(bindings.name.text)
          ? bindings
          : undefined;
    if (
      !defaultName &&
      (!named || (ts.isNamedImports(named) && !named.elements.length))
    )
      return [];
    return [
      printer.printNode(
        ts.EmitHint.Unspecified,
        ts.factory.updateImportDeclaration(
          statement,
          statement.modifiers,
          ts.factory.updateImportClause(
            clause,
            clause.isTypeOnly,
            defaultName,
            named,
          ),
          statement.moduleSpecifier,
          statement.attributes,
        ),
        ast,
      ),
    ];
  });
  return `${imports.join("\n")}\n${[...selected].map((statement) => statement.getText(ast)).join("\n")}\nexport {${name}};`;
}

const fixtures = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {CalendarEventDetail} from './src/app/team/components/CalendarEventDetail';
import {MobileCompleteAppointmentForm} from 'mobile-form-fixture';
import {AppointmentCard} from 'myday-form-fixture';
import {parseCrewPayoutFormData} from './src/app/team/lib/crew-payout-form';
const params=new URLSearchParams(location.search), surface=params.get('surface')||'calendar';
const permissions=!params.has('readonly'), saved=params.has('saved');
const teamMembers=[{id:'${member}',name:'Alex',active:true}];
const bookingDetails={serviceType:'moving',source:{type:'team_member',teamMemberId:'${member}'},pricing:{mode:'exact'}};
const crewMembers=saved?[{memberId:'${member}',hourlyRateCents:2750,workedMinutes:135}]:[];
const event={id:'db:${id}',appointmentId:'${id}',appointmentType:surface==='convert'?'in_person_quote':'job',status:saved?'completed':'confirmed',source:'db',title:'Moving Job',start:'2026-09-10T14:00:00.000Z',end:'2026-09-10T15:00:00.000Z',version:'${version}',quotedTotalCents:65000,finalTotalCents:saved?65000:null,bookingDetails,crewMembers};
window.__actions=[];window.__refreshes=0;
window.__capture=async(name,data)=>{window.__actions.push({name,data:Array.from(data.entries()),crew:parseCrewPayoutFormData(data)});await new Promise(resolve=>{if(window.__pause)window.__release=resolve;else setTimeout(resolve,180)});};
document.addEventListener('submit',event=>{if(surface!=='myday'||event.defaultPrevented)return;event.preventDefault();window.__capture('myday',new FormData(event.target));});
function App(){return <main><h1>Moving completion</h1>{surface==='calendar'?<CalendarEventDetail event={event} canManageCommissions={permissions} canUpdateAppointments={permissions} canCollectPayments={permissions} canSendCustomerMessages={params.has('messages')} canManageAppointmentMedia={false} canOverrideScheduleConflicts={false} teamMembers={teamMembers}/>:surface==='myday'?<AppointmentCard item={{appointment:{id:'${id}',updatedAt:'${version}',appointmentType:'job',status:saved?'completed':'confirmed',startAt:event.start,quotedTotalCents:65000,finalTotalCents:saved?65000:null,bookingDetails,crewMembers,services:['Moving Job'],contact:{id:'${id}',name:'Test customer',email:null,phone:null,source:null,assignedAssociateMemberId:null},property:{id:'${id}',addressLine1:'123 Test St',city:'Atlanta',state:'GA',postalCode:'30301'},notes:[],soldByMemberId:'${member}',rescheduleToken:'test'},startDate:new Date(event.start),isQuoteOnly:false,serviceLabel:'Moving Job'}} teamMembers={teamMembers} teamMemberNameById={new Map([['${member}','Alex']])} mode='run' canPlaceCalls={false} canUpdateAppointments={permissions} canCollectPayments={permissions} canSendCustomerMessages={params.has('messages')} canManageAppointmentMedia={false} canManageCommissions={permissions} canOverrideAppointmentConflicts={permissions}/>:<MobileCompleteAppointmentForm event={event} appointmentId='${id}' calendarDay='2026-09-10' screen='calendar' teamMembers={teamMembers} currentTeamMemberId='${member}' currentTeamMemberName='Alex' canCollectPayments={permissions} canManagePayments={permissions&&!params.has('crewmanager')} canManageCommissions={permissions} canManageMedia={false} canOverrideAppointmentConflicts={permissions} canSendCustomerMessages={params.has('messages')}/>}</main>};
createRoot(document.getElementById('root')).render(<App/>);`;

void test(
  "actual moving completion surfaces preserve inputs, permissions, corrections and booking changes",
  { timeout: 120000 },
  async () => {
    const bundle = await build({
      stdin: {
        contents: fixtures,
        resolveDir: `${repo}/apps/site`,
        loader: "tsx",
      },
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
      plugins: [
        {
          name: "moving-surface-fixture",
          setup(b: any) {
            b.onResolve(
              { filter: /^(mobile-form-fixture|myday-form-fixture)$/ },
              (args: any) => ({ path: args.path, namespace: "surface" }),
            );
            b.onLoad(
              { filter: /.*/, namespace: "surface" },
              async (args: any) => {
                const mobile = args.path === "mobile-form-fixture";
                const file = `${repo}/apps/site/src/app/${mobile ? "mobile/page.tsx" : "team/components/MyDaySection.tsx"}`;
                return {
                  contents: await componentSource(
                    file,
                    mobile
                      ? "MobileCompleteAppointmentForm"
                      : "AppointmentCard",
                  ),
                  loader: "tsx",
                  resolveDir: path.dirname(file),
                };
              },
            );
            b.onResolve(
              { filter: /^(node:crypto|next\/navigation)$/ },
              (args: any) => ({ path: args.path, namespace: "stub" }),
            );
            b.onLoad({ filter: /.*/, namespace: "stub" }, (args: any) => ({
              loader: "js",
              contents:
                args.path === "node:crypto"
                  ? "export const randomUUID=()=>crypto.randomUUID();"
                  : "export const useRouter=()=>({refresh(){window.__refreshes++},push(){}});",
            }));
            b.onResolve(
              { filter: /(?:^|\/)actions(?:\/[\w-]+)?$/ },
              (args: any) => ({
                path: path.resolve(args.resolveDir, args.path) + ".ts",
                namespace: "actions",
              }),
            );
            b.onLoad(
              { filter: /.*/, namespace: "actions" },
              async (args: any) => {
                const source = await readFile(args.path, "utf8");
                const names = [
                  ...source.matchAll(/export (?:async )?function (\w+)/g),
                ].map((match) => match[1]);
                return {
                  loader: "js",
                  contents: names
                    .map(
                      (name) =>
                        `export async function ${name}(data){if(!(data instanceof FormData))return {ok:true,data:{applicable:false,resources:[],selectedResourceIds:[],requirements:[]}};return window.__capture('${name}',data);}`,
                    )
                    .join("\n"),
                };
              },
            );
          },
        },
      ],
    });
    const server = createServer((request, response) => {
      if (request.url === "/client.js") {
        response.setHeader("content-type", "text/javascript");
        response.end(bundle.outputFiles[0].contents);
      } else {
        response.setHeader("content-type", "text/html");
        response.end(
          '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Moving completion surfaces</title><style>body{font:16px system-ui;margin:16px}input,button,select{min-height:44px}svg{width:20px;height:20px}main{max-width:600px;margin:auto}</style></head><body><div id="root"></div><script src="/client.js"></script></body></html>',
        );
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({
        viewport: { width: 375, height: 900 },
      });
      page.setDefaultTimeout(5000);
      const errors: string[] = [];
      page.on("pageerror", (error) => {
        errors.push(error.message);
        console.error(error.message);
      });
      const visit = async (surface: string, suffix = "") => {
        await page.goto(
          `http://127.0.0.1:${address.port}/?surface=${surface}${suffix}`,
        );
      };
      const fillCrew = async () => {
        await page.locator('[name="crewMemberId"]').check();
        await page
          .getByRole("spinbutton", { name: "Alex hourly rate" })
          .fill("27.50");
        await page
          .getByRole("spinbutton", { name: "Alex hours worked" })
          .fill("2.25");
      };
      for (const surface of ["mobile", "myday"]) {
        await visit(surface);
        await page.getByText("Complete job", { exact: true }).click();
        await page
          .getByRole("button", { name: "Mark complete", exact: true })
          .click();
        await expect(page.getByRole("alert")).toContainText(
          "Select at least one crew",
        );
        assert.equal(await page.evaluate(() => window.__actions.length), 0);
        await fillCrew();
        await page
          .getByRole("spinbutton", { name: "Alex hourly rate" })
          .fill("0");
        await page
          .getByRole("button", { name: "Mark complete", exact: true })
          .click();
        assert.equal(await page.evaluate(() => window.__actions.length), 0);
        await page
          .getByRole("spinbutton", { name: "Alex hourly rate" })
          .fill("27.50");
        if (surface === "myday") {
          await page.getByText("Quote and job size", { exact: true }).click();
          const toggle = page.locator('[name="updateBookingDetails"]');
          await toggle.check();
          await page
            .getByRole("combobox", { name: "Job type", exact: true })
            .selectOption("junk_removal");
          await expect(
            page.locator('[name="crewCompensationMode"]'),
          ).toHaveValue("percentage");
          await expect(
            page.getByRole("spinbutton", { name: "Alex hours worked" }),
          ).toHaveCount(0);
          await toggle.uncheck();
          await expect(
            page.locator('[name="crewCompensationMode"]'),
          ).toHaveValue("hourly");
          await expect(
            page.getByRole("spinbutton", { name: "Alex hours worked" }),
          ).toHaveValue("2.25");
        } else
          await page.evaluate(() => {
            window.__pause = true;
          });
        const button = page.getByRole("button", {
          name: surface === "mobile" ? "Mark complete" : "Mark complete",
          exact: true,
        });
        await button.click();
        if (surface === "mobile") {
          await expect(
            page.getByRole("button", { name: "Saving…", exact: true }),
          ).toBeDisabled();
          await page.evaluate(() => window.__release());
        }
        await expect
          .poll(() => page.evaluate(() => window.__actions.length))
          .toBe(1);
        const action = await page.evaluate(() => window.__actions[0]);
        assert.equal(action.crew.ok, true);
        assert.deepEqual(action.crew.crewMembers, [
          { memberId: member, hourlyRateCents: 2750, workedMinutes: 135 },
        ]);
        await visit(surface, "&saved&messages");
        await page
          .getByText(
            surface === "mobile" ? "Correct completed job" : "Correct crew pay",
            { exact: true },
          )
          .click();
        await expect(page.locator('[name="crewMemberId"]')).toBeChecked();
        await expect(
          page.getByRole("spinbutton", { name: "Alex hours worked" }),
        ).toHaveValue("2.25");
        if (surface === "myday")
          await expect(page.locator('[name="finalTotal"]')).toHaveAttribute(
            "readonly",
            "",
          );
        await page
          .getByRole("spinbutton", { name: "Alex hours worked" })
          .fill("3");
        await expect(page.locator('[name="sendReviewRequest"]')).toHaveCount(0);
        await page
          .getByRole("button", {
            name:
              surface === "mobile"
                ? "Save completed job"
                : "Save crew correction",
            exact: true,
          })
          .click();
        await expect
          .poll(() => page.evaluate(() => window.__actions.length))
          .toBe(1);
        const correction = await page.evaluate(() => window.__actions[0]);
        assert.equal(correction.crew.crewMembers[0].workedMinutes, 180);
        await visit(surface, "&readonly");
        await expect(page.locator('[name="crewMemberId"]')).toHaveCount(0);
      }
      await visit("mobile", "&saved&crewmanager");
      await page.getByText("Correct completed job", { exact: true }).click();
      await expect(page.locator('[name="preserveFinalTotal"]')).toHaveValue(
        "1",
      );
      await expect(page.locator('[name="finalTotal"]')).toHaveCount(0);
      await page
        .getByRole("spinbutton", { name: "Alex hours worked" })
        .fill("3");
      await page
        .getByRole("button", { name: "Save completed job", exact: true })
        .click();
      await expect
        .poll(() => page.evaluate(() => window.__actions.length))
        .toBe(1);
      await visit("convert");
      await page.getByText("Convert to job", { exact: true }).click();
      await page
        .getByRole("combobox", { name: "Job type", exact: true })
        .selectOption("moving");
      await page.getByRole("button", { name: "Exact", exact: true }).click();
      await page.locator('[name="quotedTotal"]').fill("650");
      await page
        .getByRole("button", { name: "Convert + complete", exact: true })
        .click();
      await expect(page.getByRole("alert")).toContainText(
        "Select at least one crew",
      );
      assert.equal(await page.evaluate(() => window.__actions.length), 0);
      await page
        .getByRole("button", { name: "Convert only", exact: true })
        .click();
      await expect
        .poll(() => page.evaluate(() => window.__actions.length))
        .toBe(1);
      assert.equal(
        (await page.evaluate(() => window.__actions[0])).data.find(
          (entry) => entry[0] === "completionMode",
        )?.[1],
        "convert",
      );
      await visit("convert");
      await page.getByText("Convert to job", { exact: true }).click();
      await page
        .getByRole("combobox", { name: "Job type", exact: true })
        .selectOption("moving");
      await page.getByRole("button", { name: "Exact", exact: true }).click();
      await page.locator('[name="quotedTotal"]').fill("650");
      await fillCrew();
      await page.locator('[name="finalTotal"]').fill("650");
      await page
        .getByRole("spinbutton", { name: "Alex hours worked" })
        .fill("");
      await page
        .getByRole("button", { name: "Convert + complete", exact: true })
        .click();
      await expect(page.getByRole("alert")).toContainText(
        "positive hourly rate and hours",
      );
      assert.equal(await page.evaluate(() => window.__actions.length), 0);
      await page
        .getByRole("spinbutton", { name: "Alex hours worked" })
        .fill("2.25");
      await page
        .getByRole("button", { name: "Convert + complete", exact: true })
        .click();
      await expect
        .poll(() => page.evaluate(() => window.__actions.length))
        .toBe(1);
      assert.equal(
        (await page.evaluate(() => window.__actions[0])).crew.crewMembers[0]
          .hourlyRateCents,
        2750,
      );

      await visit("calendar");
      const requests: Array<{ key: string | undefined; form: FormData }> = [];
      let responseIndex = 0;
      let release: (() => void) | undefined;
      await page.route("**/api/team/appointments/status", async (route) => {
        const request = route.request();
        const form = await new Request("http://fixture", {
          method: "POST",
          headers: { "content-type": request.headers()["content-type"]! },
          body: request.postDataBuffer()!,
        }).formData();
        requests.push({ key: request.headers()["idempotency-key"], form });
        const index = responseIndex++;
        if (index === 0)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        await route.fulfill(
          index === 0
            ? {
                status: 409,
                json: {
                  ok: false,
                  message: "This payout period is locked. Use an adjustment.",
                },
              }
            : index === 1
              ? { status: 200, json: { ok: true } }
              : {
                  status: 200,
                  json: {
                    ok: true,
                    data: {
                      appointmentId: id,
                      status: "completed",
                      version: "2026-09-10T12:00:01.000Z",
                      calendarSync: "not_required",
                      customerNotification: "not_requested",
                      reviewRequest: "not_requested",
                    },
                    receipt: {
                      operationId: "fixture",
                      correlationId: "fixture",
                      actorId: member,
                      committedAt: version,
                      entityType: "appointment",
                      entityId: id,
                      version: "2026-09-10T12:00:01.000Z",
                    },
                  },
                },
        );
      });
      await page.locator('[name="crewConfirmed"]').check();
      await page
        .getByRole("button", { name: "Complete job", exact: true })
        .click();
      await expect(page.getByRole("alert")).toContainText(
        "Select at least one crew",
      );
      assert.equal(requests.length, 0);
      await fillCrew();
      await page
        .getByRole("button", { name: "Complete job", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "Saving…", exact: true }),
      ).toBeDisabled();
      await expect.poll(() => requests.length).toBe(1);
      release!();
      await expect(page.getByRole("alert")).toContainText("locked");
      await expect(
        page.getByRole("spinbutton", { name: "Alex hours worked" }),
      ).toHaveValue("2.25");
      await page
        .getByRole("button", { name: "Complete job", exact: true })
        .click();
      await expect(page.getByRole("alert")).toContainText("could not confirm");
      assert.equal(await page.evaluate(() => window.__refreshes), 0);
      await page
        .getByRole("button", { name: "Complete job", exact: true })
        .click();
      await expect.poll(() => page.evaluate(() => window.__refreshes)).toBe(1);
      assert.equal(requests.length, 3);
      assert.equal(requests[0].key, requests[1].key);
      assert.equal(requests[1].key, requests[2].key);
      assert.equal(requests[0].form.get(`crewHourlyRate:${member}`), "27.50");
      assert.equal(requests[0].form.get("expectedVersion"), version);
      await visit("calendar", "&saved");
      await expect(
        page.getByRole("button", { name: "Save crew correction", exact: true }),
      ).toBeVisible();
      await expect(page.locator('[name="finalTotal"]')).toHaveAttribute(
        "readonly",
        "",
      );
      await expect(
        page.getByRole("button", { name: "Reschedule", exact: true }),
      ).toHaveCount(0);
      await visit("calendar", "&readonly");
      await expect(page.locator('[name="crewMemberId"]')).toHaveCount(0);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
