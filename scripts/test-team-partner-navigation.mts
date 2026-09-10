import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium, webkit, expect } from "@playwright/test";
import tailwindConfig from "../apps/site/tailwind.config";

// Real navigation policy and components with local synthetic permissions.
// This harness never authenticates a production user, calls a provider, creates
// a company, or sends an invitation. Those remain separate integration gates.
const repo = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/u, "");
const require = createRequire(`${repo}/package.json`);
const { build } = createRequire(require.resolve("tsx"))("esbuild");
const siteRequire = createRequire(`${repo}/apps/site/package.json`);
const css = (
  await siteRequire("postcss")([
    siteRequire("tailwindcss")({
      ...tailwindConfig,
      content: [`${repo}/apps/site/src/**/*.{ts,tsx}`],
    }),
  ]).process(readFileSync(`${repo}/apps/site/src/app/globals.css`, "utf8"), {
    from: `${repo}/apps/site/src/app/globals.css`,
  })
).css;

async function harness() {
  const bundle = await build({
    stdin: {
      contents: `import React from 'react';
        import {createRoot} from 'react-dom/client';
        import {TeamAppShell} from './src/app/team/components/TeamAppShell';
        import {PartnerAdministrationNavigation} from './src/app/team/components/PartnerAdministrationNavigation';
        import {PartnerAdministrationSection} from './src/app/team/components/PartnerAdministrationSection';
        import {PartnerCompanyNavigation} from './src/app/team/components/PartnerCompanyNavigation';
        import {PartnerRelationshipSetup} from './src/app/team/components/PartnerRelationshipSetup';
        import {getTeamNavigationSurfaces,TEAM_PRIMARY_NAVIGATION_IDS,TEAM_SURFACE_GROUP_LABELS} from './src/app/team/surface-registry';
        import {buildAllowedMobileScreens} from './src/app/mobile/lib/session';
        const params=new URLSearchParams(location.search);
        const roles={owner:['*'],support:['partners.accounts.read','partners.invitations.read'],security:['partners.security.read'],crew:['appointments.read','appointments.update'],sales:['sales.read','outbound.read','pipeline.read']};
        const role=params.get('role')||'owner';
        const permissions=roles[role]||[];
        const surfaces=getTeamNavigationSurfaces(permissions);
        window.__mobileScreens=buildAllowedMobileScreens({id:'11111111-1111-4111-8111-111111111111',name:'Local test',email:null,roleSlug:role==='owner'?'owner':'staff',passwordSet:true,permissions});
        window.__navigationIds=surfaces.map(surface=>surface.id);
        const navItem=surface=>({id:surface.id,label:surface.label,href:surface.canonicalPath});
        const quickItems=TEAM_PRIMARY_NAVIGATION_IDS.map(id=>surfaces.find(surface=>surface.id===id)).filter(Boolean).map(navItem);
        const utilityItems=surfaces.filter(surface=>surface.id==='settings').map(navItem);
        const remaining=surfaces.filter(surface=>!TEAM_PRIMARY_NAVIGATION_IDS.includes(surface.id)&&surface.id!=='settings');
        const groups=[...new Set(remaining.map(surface=>surface.group))].map(id=>({id,label:TEAM_SURFACE_GROUP_LABELS[id],items:remaining.filter(surface=>surface.group===id).map(navItem)}));
        const companyId=params.get('p_company')||'44444444-4444-4444-8444-444444444444';
        const sections=role==='owner'?['details','people','jobs','billing','settings']:['details','people'];
        const destinations=[{id:'accounts',label:'Companies',href:'/team/partners',active:true},...(role==='owner'?[{id:'security',label:'Security',href:'/team/partners?p_admin=security',active:false},{id:'quarantine',label:'Quarantine',href:'/team/partners?p_admin=quarantine',active:false}]:[])];
        const companyContent=<><PartnerAdministrationNavigation destinations={destinations} canCreate={role==='owner'}/>{params.has('p_company')?<PartnerCompanyNavigation accountId={companyId} accountName='Example Property Management' section={params.get('p_company_section')||'details'} sections={sections}/>:null}{params.get('p_setup')==='create'?<PartnerRelationshipSetup canCreate={role==='owner'} canInvite={role==='owner'} canConfigure={role==='owner'} openCreate/>:null}</>;
        const root=createRoot(document.getElementById('root'));const render=content=>root.render(<TeamAppShell activeId='partners' title='Partner navigation check' quickItems={quickItems} utilityItems={utilityItems} groups={groups} access={{hasOwner:role==='owner',hasOffice:role==='support',hasCrew:role==='crew'}} classicHref='/team/partners?layout=classic'>{content}</TeamAppShell>);
        async function resolveServerElements(element){if(Array.isArray(element))return Promise.all(element.map(resolveServerElements));if(!React.isValidElement(element))return element;if(typeof element.type==='function'&&element.type.constructor.name==='AsyncFunction')return resolveServerElements(await element.type(element.props));if(!Object.prototype.hasOwnProperty.call(element.props,'children'))return element;return React.cloneElement(element,{},await resolveServerElements(element.props.children));}
        if(params.has('directoryCheck')||sessionStorage.getItem('directoryCheck')){sessionStorage.setItem('directoryCheck','1');PartnerAdministrationSection({filters:{companyId:params.get('p_company')||undefined,companySection:params.get('p_company_section')||undefined,adminView:params.get('p_admin')||undefined,setup:params.get('p_setup')||undefined}}).then(resolveServerElements).then(render)}else render(params.has('companyCheck')||params.has('p_setup')||params.has('p_company')?companyContent:<p>Local navigation verification only.</p>);`,
      resolveDir: `${repo}/apps/site`,
      loader: "tsx",
    },
    absWorkingDir: `${repo}/apps/site`,
    tsconfig: `${repo}/apps/site/tsconfig.json`,
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    minify: true,
    define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
    logLevel: "error",
    plugins: [
      {
        name: "local-navigation-boundaries",
        setup(builder: any) {
          const actionModules = new Map<string, string>();
          builder.onResolve(
            {
              filter:
                /^(node:crypto|next\/navigation|next\/headers|next\/image|@\/lib\/team-session|@\/lib\/team-principal|\.\.\/lib\/api|\.\.\/actions\/partner-relationships)$/,
            },
            (args: any) => ({ path: args.path, namespace: "local" }),
          );
          builder.onLoad({ filter: /.*/, namespace: "local" }, (args: any) => ({
            loader: "jsx",
            resolveDir: `${repo}/apps/site`,
            contents:
              args.path === "node:crypto"
                ? `export const randomUUID=()=>crypto.randomUUID();`
                : args.path === "@/lib/team-principal"
                  ? `const roles={owner:['*'],support:['partners.accounts.read','partners.invitations.read'],security:['partners.security.read'],crew:['appointments.read'],sales:['sales.read']};export const requireCurrentTeamPrincipal=async()=>({memberId:'11111111-1111-4111-8111-111111111111',permissions:roles[new URLSearchParams(location.search).get('role')||'owner']||[]});export const hasTeamPermission=(principal,key)=>principal.permissions.includes('*')||principal.permissions.includes(key);`
                  : args.path === "../lib/api"
                    ? `window.__directoryReads=[];export const callAdminApiAs=async(_principal,path)=>{window.__directoryReads.push(path);const params=new URLSearchParams(location.search);const scenario=params.get('directoryCase');if(scenario==='unavailable')return Response.json({error:'unavailable'},{status:503});if(scenario==='malformed')return Response.json({ok:true,items:null});const query=new URL(path,'http://local.test').searchParams;const requested=query.get('accountId');const company={id:'44444444-4444-4444-8444-444444444444',name:'Example Property Management',status:'active',portalLifecycleStatus:'active',portalAccessEnabled:true,city:'Atlanta',state:'GA',createdAt:'2026-09-01T12:00:00.000Z',website:'https://example.test'};const other={...company,id:'55555555-5555-4555-8555-555555555555',name:'Unrelated company'};let items=scenario==='empty'?[]:scenario==='wrong_company'?[other]:requested&&requested!==company.id?[]:[company];if(path.includes('/memberships?'))items=[{id:'66666666-6666-4666-8666-666666666666',partnerAccountId:scenario==='wrong_contacts'?other.id:company.id,personName:scenario==='wrong_contacts'?'Wrong company person':'Casey Partner',personEmail:'casey@example.test',status:'active',roleKey:'administrator'}];return Response.json({ok:true,resource:path.includes('/memberships?')?'memberships':'accounts',items,page:{hasMore:false,nextCursor:null,limit:50,returned:items.length}});};`
                    : args.path === "next/navigation"
                      ? `const router={push(href){window.__lastNavigation=href;},refresh(){},replace(){}}; const search=new URLSearchParams(location.search);export const useRouter=()=>router;export const useSearchParams=()=>search;export const usePathname=()=>location.pathname;`
                      : args.path === "next/headers"
                        ? `export const cookies=async()=>{throw Error('No session cookies may be read in this test')};`
                        : args.path === "@/lib/team-session"
                          ? `export const TEAM_SESSION_COOKIE='local-test-only';`
                          : args.path === "../actions/partner-relationships"
                            ? `export const searchPartnerRelationshipCompanies=async()=>({ok:true,choices:[],nextCursor:null});export const loadPartnerRelationshipContext=async()=>({ok:false});export const savePartnerRelationship=async()=>{throw Error('Mutations disabled in navigation verification')};export const managePartnerRelationshipInvitation=async()=>{throw Error('Invitations disabled in navigation verification')};`
                            : `import React from 'react';export default function Image({src,alt,width,height,className}){return <img src={src} alt={alt} width={width} height={height} className={className}/>}`,
          }));
          builder.onResolve(
            { filter: /(?:^|\/)actions(?:\/|$)/ },
            (args: any) => {
              const imports = readFileSync(args.importer, "utf8");
              const match = [
                ...imports.matchAll(
                  /import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/gu,
                ),
              ].find((entry) => entry[2] === args.path);
              if (!match)
                throw new Error(
                  `No named action imports found in ${args.importer}: ${args.path}`,
                );
              const names = match[1]
                .split(",")
                .map((value) => value.trim())
                .filter((value) => value && !value.startsWith("type "))
                .map((value) => value.split(/\s+/u)[0]);
              const key = `${args.importer}:${args.path}`;
              actionModules.set(
                key,
                names
                  .map(
                    (name) =>
                      `export const ${name}=async()=>{throw Error('No external actions allowed in navigation tests')};`,
                  )
                  .join("\n"),
              );
              return { path: key, namespace: "disabled-actions" };
            },
          );
          builder.onLoad(
            { filter: /.*/, namespace: "disabled-actions" },
            (args: any) => ({
              contents: actionModules.get(args.path),
              loader: "js",
            }),
          );
        },
      },
    ],
  });
  const server = createServer((request, response) => {
    if (request.url === "/client.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end(bundle.outputFiles[0].contents);
    } else if (request.url === "/style.css") {
      response.setHeader("Content-Type", "text/css");
      response.end(css);
    } else {
      response.setHeader("Content-Type", "text/html");
      response.end(
        '<!doctype html><html lang="en"><head><title>Local partner navigation</title><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/client.js"></script></body></html>',
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

for (const engine of [chromium, webkit]) {
  test(
    `${engine.name()}: direct Partners replaces Sales in desktop and mobile CRM navigation`,
    { timeout: 90_000 },
    async () => {
      const app = await harness();
      const browser = await engine.launch();
      try {
        for (const width of [320, 375, 768, 1024, 1440]) {
          const page = await browser.newPage({
            viewport: { width, height: 900 },
          });
          const errors: string[] = [];
          page.on("pageerror", (error) => {
            errors.push(error.message);
            console.error("Local navigation error:", error.message);
          });
          await page.goto(`${app.url}/team/partners`);
          await expect(
            page.getByRole("heading", { name: "Partner navigation check" }),
          ).toBeVisible();
          const navigation =
            width < 1024
              ? page.getByRole("navigation", {
                  name: "Mobile team navigation",
                  exact: true,
                })
              : page.getByRole("navigation", {
                  name: "Primary team navigation",
                  exact: true,
                });
          if (width < 1024) {
            await expect(
              page
                .getByRole("navigation", {
                  name: "Quick team navigation",
                  exact: true,
                })
                .getByRole("button", { name: "Partners", exact: true }),
            ).toBeVisible();
            await page
              .getByRole("button", { name: "Open navigation", exact: true })
              .click();
          }
          const partners = navigation.getByRole("button", {
            name: "Partners",
            exact: true,
          });
          await expect(partners).toBeVisible();
          await expect(partners).toHaveAttribute("aria-current", "page");
          const target = await partners.boundingBox();
          assert.ok(target && target.height >= 44 && target.width >= 44);
          for (const label of [
            "Sales",
            "Pipeline",
            "Sales HQ",
            "Outbound",
            "Sales Activity",
          ])
            await expect(
              navigation.getByText(label, { exact: true }),
            ).toHaveCount(0);
          await partners.focus();
          await page.keyboard.press("Enter");
          await expect
            .poll(() => page.evaluate(() => (window as any).__lastNavigation))
            .toBe("/team/partners");
          if (width < 1024) {
            await expect(navigation).toHaveCount(0);
            await page
              .getByRole("button", { name: "Open navigation", exact: true })
              .click();
            await page.keyboard.press("Escape");
            await expect(
              page.getByRole("button", {
                name: "Open navigation",
                exact: true,
              }),
            ).toBeFocused();
          }
          assert.equal(
            await page.evaluate(
              () => document.documentElement.scrollWidth > innerWidth,
            ),
            false,
            `overflow at ${width}`,
          );
          assert.deepEqual(errors, []);
          await page.close();
        }
      } finally {
        await browser.close();
        await app.close();
      }
    },
  );

  test(
    `${engine.name()}: Partners remains permission-aware in both CRM policies`,
    { timeout: 60_000 },
    async () => {
      const app = await harness();
      const browser = await engine.launch();
      try {
        const page = await browser.newPage({
          viewport: { width: 1440, height: 900 },
        });
        for (const [role, allowed] of [
          ["owner", true],
          ["support", true],
          ["security", true],
          ["crew", false],
          ["sales", false],
        ] as const) {
          await page.goto(`${app.url}/team/partners?role=${role}`);
          await expect(
            page.getByRole("heading", { name: "Partner navigation check" }),
          ).toBeVisible();
          const values = await page.evaluate(() => ({
            normal: (window as any).__navigationIds,
            mobile: (window as any).__mobileScreens,
          }));
          assert.equal(
            values.normal.includes("partners"),
            allowed,
            `${role} desktop permission`,
          );
          assert.equal(
            values.mobile.includes("partners"),
            allowed,
            `${role} mobile permission`,
          );
          const control = page
            .getByRole("navigation", {
              name: "Primary team navigation",
              exact: true,
            })
            .getByRole("button", { name: "Partners", exact: true });
          if (allowed) await expect(control).toBeVisible();
          else await expect(control).toHaveCount(0);
          for (const legacy of [
            "pipeline",
            "sales-hq",
            "outbound",
            "sales-log",
          ])
            assert.equal(values.normal.includes(legacy), false);
        }
        await page.close();
      } finally {
        await browser.close();
        await app.close();
      }
    },
  );

  test(
    `${engine.name()}: company controls stay focused, accessible, and scoped to the selected company`,
    { timeout: 90_000 },
    async () => {
      const app = await harness();
      const browser = await engine.launch();
      const accountId = "44444444-4444-4444-8444-444444444444";
      try {
        for (const width of [320, 375, 768, 1024, 1440]) {
          const page = await browser.newPage({
            viewport: { width, height: 900 },
          });
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(
            `${app.url}/team/partners?companyCheck=1&p_company=${accountId}`,
          );
          const main = page.getByRole("main");
          await expect(
            main.getByRole("heading", { name: "Partners", exact: true }),
          ).toBeVisible();
          await expect(
            main.getByRole("heading", { name: "Example Property Management" }),
          ).toBeVisible();
          const advanced = main.getByRole("navigation", {
            name: "Advanced partner administration",
          });
          await expect(advanced).toBeHidden();
          await main
            .locator("summary")
            .filter({ hasText: "Advanced administration" })
            .focus();
          await page.keyboard.press("Enter");
          await expect(advanced).toBeVisible();
          await expect(
            advanced.getByRole("link", { name: "Security", exact: true }),
          ).toBeVisible();
          await page.keyboard.press("Enter");
          await expect(advanced).toBeHidden();
          const sections = main.getByRole("navigation", {
            name: "Company sections",
          });
          const expectedSections: Record<string, string> = {
            "Details & contacts": "details",
            "People & invitations": "people",
            "Jobs & service requests": "jobs",
            "Billing & service terms": "billing",
            Settings: "settings",
          };
          for (const [name, section] of Object.entries(expectedSections)) {
            const link = sections.getByRole("link", { name, exact: true });
            await expect(link).toBeVisible();
            const href = await link.getAttribute("href");
            assert.ok(href);
            const url = new URL(href, app.url);
            assert.equal(url.pathname, "/team/partners");
            assert.equal(url.searchParams.get("p_company"), accountId);
            assert.equal(url.searchParams.get("p_company_section"), section);
            assert.equal(url.searchParams.has("out_return"), false);
            const bounds = await link.boundingBox();
            assert.ok(bounds && bounds.height >= 44 && bounds.width >= 44);
          }
          await expect(
            sections.getByRole("link", {
              name: "Details & contacts",
              exact: true,
            }),
          ).toHaveAttribute("aria-current", "page");
          await expect(
            main.getByRole("link", { name: "All companies", exact: true }),
          ).toHaveAttribute("href", "/team/partners");
          assert.equal(
            await page.evaluate(
              () => document.documentElement.scrollWidth > innerWidth,
            ),
            false,
            `company overflow at ${width}`,
          );
          if (width === 320 || width === 1440) {
            await page.addScriptTag({
              path: require.resolve("axe-core/axe.min.js"),
            });
            const violations = await page.evaluate(async () =>
              (
                await (window as any).axe.run(document, {
                  runOnly: {
                    type: "tag",
                    values: ["wcag2a", "wcag2aa", "wcag21aa"],
                  },
                })
              ).violations.map((violation: any) => ({
                id: violation.id,
                nodes: violation.nodes.map((node: any) => node.target),
              })),
            );
            assert.deepEqual(
              violations,
              [],
              `${engine.name()} company navigation accessibility at ${width}`,
            );
            if (engine === chromium)
              await page.screenshot({
                path: `/tmp/stonegate-partner-company-navigation-${width}.png`,
                fullPage: true,
              });
          }
          await main
            .getByRole("link", { name: "Add partner", exact: true })
            .click();
          const create = main.getByRole("button", {
            name: "Create company & invite Administrator",
            exact: true,
          });
          await expect(create).toBeVisible();
          await expect(
            main.getByLabel("Company name", { exact: true }),
          ).toBeVisible();
          const createUrl = new URL(page.url());
          assert.equal(createUrl.pathname, "/team/partners");
          assert.equal(createUrl.searchParams.get("p_setup"), "create");
          assert.equal(
            createUrl.searchParams.has("p_company"),
            false,
            "create must not retain a previously selected company",
          );
          assert.deepEqual(errors, []);
          await page.close();
        }
        const page = await browser.newPage({
          viewport: { width: 375, height: 900 },
        });
        await page.goto(
          `${app.url}/team/partners?companyCheck=1&p_company=${accountId}&role=support`,
        );
        const main = page.getByRole("main");
        await expect(
          main.getByRole("link", { name: "Add partner", exact: true }),
        ).toHaveCount(0);
        await expect(
          main
            .locator("summary")
            .filter({ hasText: "Advanced administration" }),
        ).toHaveCount(0);
        const sections = main.getByRole("navigation", {
          name: "Company sections",
        });
        await expect(sections.getByRole("link")).toHaveCount(2);
        for (const name of [
          "Jobs & service requests",
          "Billing & service terms",
          "Settings",
        ])
          await expect(
            sections.getByRole("link", { name, exact: true }),
          ).toHaveCount(0);
        await page.close();
      } finally {
        await browser.close();
        await app.close();
      }
    },
  );

  test(
    `${engine.name()}: actual company directory opens only the selected company and handles missing or unavailable records`,
    { timeout: 90_000 },
    async () => {
      const app = await harness();
      const browser = await engine.launch();
      const accountId = "44444444-4444-4444-8444-444444444444";
      try {
        const page = await browser.newPage({
          viewport: { width: 375, height: 900 },
        });
        const errors: string[] = [];
        page.on("pageerror", (error) => {
          errors.push(error.message);
          console.error("Local company directory error:", error.message);
        });
        await page.goto(`${app.url}/team/partners?directoryCheck=1`);
        const main = page.getByRole("main");
        const directory = main.getByRole("list", {
          name: "Companies directory",
        });
        await expect(
          directory.getByRole("heading", {
            name: "Example Property Management",
          }),
        ).toBeVisible();
        await expect(
          main.getByRole("link", { name: "Add partner", exact: true }),
        ).toBeVisible();
        await expect(
          main.getByRole("navigation", {
            name: "Advanced partner administration",
          }),
        ).toBeHidden();
        await expect(
          main.getByRole("heading", { name: "Set up partner service" }),
        ).toHaveCount(0);
        await directory
          .getByRole("link", { name: "Open company", exact: true })
          .click();
        await expect(
          main.getByRole("navigation", { name: "Company sections" }),
        ).toBeVisible();
        assert.equal(
          new URL(page.url()).searchParams.get("p_company"),
          accountId,
        );
        const reads: string[] = await page.evaluate(
          () => (window as any).__directoryReads,
        );
        assert.ok(reads.length >= 1);
        for (const path of reads)
          assert.equal(
            new URL(path, app.url).searchParams.get("accountId"),
            accountId,
          );
        await expect(
          main.getByRole("link", {
            name: "View company contacts and invitations",
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          main.getByText("Casey Partner", { exact: true }),
        ).toBeVisible();
        await expect(main.getByRole("alert")).toHaveCount(0);
        await main
          .getByRole("link", { name: "All companies", exact: true })
          .click();
        await expect(
          directory.getByRole("link", { name: "Open company", exact: true }),
        ).toBeVisible();
        assert.equal(new URL(page.url()).searchParams.has("p_company"), false);

        await page.goto(
          `${app.url}/team/partners?directoryCheck=1&directoryCase=empty`,
        );
        await expect(
          main.getByRole("heading", { name: "No matching records" }),
        ).toBeVisible();
        await expect(main.getByRole("alert")).toHaveCount(0);
        for (const scenario of ["unavailable", "malformed"]) {
          await page.goto(
            `${app.url}/team/partners?directoryCheck=1&directoryCase=${scenario}`,
          );
          await expect(main.getByRole("alert")).toContainText(
            "not an empty directory",
          );
          await expect(
            main.getByRole("heading", { name: "No matching records" }),
          ).toHaveCount(0);
          await expect(
            main.getByRole("link", { name: "Retry first page" }),
          ).toBeVisible();
        }
        await page.goto(
          `${app.url}/team/partners?directoryCheck=1&p_company=${accountId}&directoryCase=wrong_contacts`,
        );
        await expect(main.getByRole("alert")).toContainText(
          "Company contacts could not be loaded",
        );
        await expect(
          main.getByText("Wrong company person", { exact: true }),
        ).toHaveCount(0);
        for (const query of [
          `p_company=${accountId}&directoryCase=wrong_company`,
          `p_company=${accountId}&directoryCase=unavailable`,
          "p_company=55555555-5555-4555-8555-555555555555",
          "p_company=invalid-company-id",
          `p_company=${accountId}&role=crew`,
          `p_company=${accountId}&p_company_section=billing&role=support`,
        ]) {
          await page.goto(`${app.url}/team/partners?directoryCheck=1&${query}`);
          await expect(main.getByRole("alert")).toContainText(
            "No other company has been opened in its place",
          );
          await expect(
            main.getByRole("navigation", { name: "Company sections" }),
          ).toHaveCount(0);
          await expect(
            main.getByText("Unrelated company", { exact: true }),
          ).toHaveCount(0);
          await expect(
            main.getByRole("link", { name: "Back to companies" }),
          ).toBeVisible();
          if (query.includes("invalid-company-id") || query.includes("role=")) {
            assert.deepEqual(
              await page.evaluate(() => (window as any).__directoryReads),
              [],
              "invalid or unauthorized company section must not query company data",
            );
          }
        }
        assert.deepEqual(errors, []);
        await page.close();
      } finally {
        await browser.close();
        await app.close();
      }
    },
  );
}
