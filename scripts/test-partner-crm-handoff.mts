import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium, expect, type Page } from "@playwright/test";

const require = createRequire(import.meta.url);
const repo = fileURLToPath(new URL("../", import.meta.url));
const base = "https://localhost:3112";
const password = "Local portal first request passphrase 2026!";

// Uses only the explicitly guarded, disposable local fixture. Credentials and
// invitation URLs are transferred in memory and never persisted as artifacts.
function fixture(input: Record<string, unknown>, crm = false): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [
        require.resolve("tsx/cli"),
        `${repo}apps/api/scripts/${crm ? "partner-crm-handoff-fixture" : "partner-access-browser-fixture"}.ts`,
      ],
      {
        cwd: `${repo}apps/api`,
        timeout: 30_000,
        maxBuffer: 256_000,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
          NODE_ENV: "test",
          DOTENV_CONFIG_PATH: "/dev/null",
          DATABASE_SSL: "false",
          DATABASE_URL:
            "postgresql://portal_test:portal_local_only@127.0.0.1:55443/portal_access_browser",
        },
      },
      (error, stdout, stderr) => {
        if (error)
          return reject(
            Error(
              crm
                ? `Local ${input.action} fixture failed: ${stderr.slice(-4000)}`
                : `Local ${input.action} fixture failed; credential output omitted.`,
            ),
          );
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(Error("Invalid fixture response"));
        }
      },
    );
    child.stdin!.end(JSON.stringify(input));
  });
}

async function prepareLocalStorage() {
  const apiRequire = createRequire(`${repo}apps/api/package.json`);
  const {
    S3Client,
    HeadBucketCommand,
    CreateBucketCommand,
    PutBucketCorsCommand,
  } = apiRequire("@aws-sdk/client-s3");
  const storage = new S3Client({
    endpoint: "http://127.0.0.1:14566",
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
  const Bucket = "partner-release-rehearsal";
  try {
    try {
      await storage.send(new HeadBucketCommand({ Bucket }));
    } catch (error) {
      if (
        (error as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode !== 404
      )
        throw error;
      await storage.send(new CreateBucketCommand({ Bucket }));
    }
    await storage.send(
      new PutBucketCorsCommand({
        Bucket,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: [base],
              AllowedMethods: ["GET", "HEAD", "PUT"],
              AllowedHeaders: ["*"],
              ExposeHeaders: ["etag", "x-amz-checksum-sha256"],
            },
          ],
        },
      }),
    );
  } finally {
    storage.destroy();
  }
}

async function portal(page: Page, path: string) {
  const result = await page.evaluate(async (target) => {
    const response = await fetch(`/api/partners/portal/${target}`);
    return {
      status: response.status,
      body: await response.json().catch(() => null),
    };
  }, path);
  assert.equal(result.status, 200, `${path} must load successfully`);
  assert.equal(result.body?.ok, true, `${path} must contain successful data`);
  return result.body;
}

async function requestStep(page: Page, name: string) {
  await expect(
    page.getByRole("heading", { name, exact: true, level: 2 }),
  ).toBeVisible();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    ),
    false,
    `${name} fits the viewport`,
  );
}

async function currentDraftId(page: Page): Promise<string> {
  await page.waitForURL((url) => Boolean(url.searchParams.get("draftId")));
  return new URL(page.url()).searchParams.get("draftId")!;
}

async function restoreLegacyDraft(page: Page, draftId: string): Promise<void> {
  await expect(page.getByText("Saved", { exact: true }).first()).toBeVisible();
  const { draft } = await portal(page, `booking-drafts/${draftId}`);
  // Simulate opening a request saved by the previous UI. Use the authenticated
  // portal boundary and its current ETag; leaving the page prevents an old form
  // autosave from racing the controlled legacy fixture.
  await page.goto("about:blank");
  const response = await page
    .context()
    .request.patch(`${base}/api/partners/portal/booking-drafts/${draftId}`, {
      headers: { "If-Match": draft.etag, Origin: base },
      data: {
        scope: {
          ...draft.scope,
          itemCount: 7,
          volumeCubicYards: 3.5,
          nonStandard: true,
          restrictedItems: true,
          equipmentNeeds: ["lift_gate"],
        },
      },
    });
  assert.equal(
    response.status(),
    200,
    "The normal portal can save the legacy request fixture",
  );
  assert.equal((await response.json()).ok, true);
  await page.goto(`${base}/partners/book?draftId=${draftId}`);
  await requestStep(page, "Service details");
  const legacy = await openRow(page, "Saved request details");
  await expect(page.locator("#partner-book-item-count")).toHaveValue("7");
  await expect(page.locator("#partner-book-volume")).toHaveValue("3.5");
  await expect(
    page.locator("#partner-book-saved-option-lift_gate"),
  ).toBeChecked();
  await legacy.locator(":scope > summary").click();
}

function row(page: Page, title: string) {
  return page
    .locator("details")
    .filter({
      has: page.locator(":scope > summary").filter({
        hasText: new RegExp(
          `^\\s*${title.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`,
        ),
      }),
    })
    .first();
}
async function openRow(page: Page, title: string) {
  const details = row(page, title);
  if (
    !(await details.evaluate((element) => (element as HTMLDetailsElement).open))
  )
    await details.locator(":scope > summary").click();
  return details;
}
const expected = {
  serviceLabel: "Demo + haul-off",
  description:
    "HANDOFF: collect seven empty display cabinets and document loading dock condition.",
  accessDetails:
    "Use the east loading dock; check in at reception before unloading.",
  crewInstructions:
    "Protect the blue wall, count seven cabinets, and leave the fire exit clear.",
  onSiteContact: {
    name: "Morgan Facilities",
    phone: "+14045550101",
    email: "morgan.facilities@example.test",
  },
  alternateContact: {
    name: "Riley Backup",
    phone: "+14045550102",
    email: "riley.backup@example.test",
  },
  commercial: {
    poNumber: "WO-HANDOFF-015",
    costCenter: "FACILITIES-EAST",
    projectReference: "DOCK-RESET-2026",
    billingContact: {
      name: "Casey Accounts",
      email: "casey.accounts@example.test",
    },
  },
  proof: { before: 2, after: 3, package: true },
  multiStopDetails:
    "First: east loading dock. Second: west storage room at the same facility.",
  photoCaption: "HANDOFF: existing scratch beside the east loading dock.",
  staffNote: `Staff note: keep the west entrance clear. REFERENCE-${"X".repeat(90)}`,
};

async function loginStaff(page: Page, id: string) {
  await page.goto(`${base}/team/login`);
  const form = page
    .locator("form")
    .filter({ has: page.locator('input[name="password"]') });
  await form
    .locator('input[name="email"]')
    .fill(`access-staff-${id}@example.test`);
  await form
    .locator('input[name="password"]')
    .fill("Local staff access browser passphrase 2026!");
  await form
    .getByRole("button", { name: "Sign in with password", exact: true })
    .click();
  await page.waitForURL((url) => !url.pathname.endsWith("/login"), {
    timeout: 30_000,
  });
}

async function staffRead(page: Page, path: string) {
  const cookie = (await page.context().cookies(base)).find(
    (item) => item.name === "myst-team-session",
  );
  assert.ok(cookie, "Normal staff password sign-in supplies the API session");
  // The same guarded local credential used by the real Site server. Session
  // identity and permissions are still resolved by the normal API boundary.
  const response = await page
    .context()
    .request.get(`http://localhost:3111${path}`, {
      headers: {
        Authorization: `Bearer ${cookie.value}`,
        "x-api-key": "local-access-browser-only-administration-key",
      },
    });
  return { status: response.status(), body: await response.json() };
}

async function createCompany(staffPage: Page, page: Page, suffix: string) {
  const email = `crm-handoff-${suffix}@example.test`;
  await staffPage.goto(`${base}/team/partners?p_admin=accounts&p_setup=create`);
  await staffPage
    .getByLabel("Company name", { exact: true })
    .fill(`Local CRM handoff ${suffix}`);
  await staffPage
    .getByLabel("Administrator name", { exact: true })
    .fill("Local facilities administrator");
  await staffPage
    .getByLabel("Administrator email", { exact: true })
    .fill(email);
  await staffPage
    .getByLabel("Relationship confirmation", { exact: true })
    .fill(
      "Disposable local handoff test: synthetic company and no real service.",
    );
  await staffPage
    .getByRole("button", {
      name: "Create company & invite Administrator",
      exact: true,
    })
    .click();
  await expect(
    staffPage.locator(
      'section[aria-labelledby="partner-relationship-setup-heading"] [role="status"]',
    ),
  ).toBeVisible({ timeout: 30_000 });
  const invitation = await fixture({ action: "invitation", email });
  try {
    await page.goto(invitation.url);
  } catch {
    throw Error("Local invitation navigation failed; token omitted.");
  }
  await page
    .getByRole("button", { name: "Continue to password setup", exact: true })
    .click();
  await page.getByLabel("New password", { exact: true }).fill(password);
  await page
    .getByRole("button", { name: "Finish and sign in", exact: true })
    .click();
  await page.waitForURL(/\/partners\/overview$/u);
  return invitation.accountId as string;
}

async function enterDetails(page: Page, serviceKey: string, addOnKey: string) {
  await page.locator("#partner-book-service").selectOption(serviceKey);
  await page.locator("#partner-book-base-option").selectOption("large");
  await page.locator("#partner-book-description").fill(expected.description);
  await openRow(page, "Contact and access");
  for (const [id, value] of Object.entries({
    "contact-name": expected.onSiteContact.name,
    "contact-phone": expected.onSiteContact.phone,
    "contact-email": expected.onSiteContact.email,
    "alternate-name": expected.alternateContact.name,
    "alternate-phone": expected.alternateContact.phone,
    "alternate-email": expected.alternateContact.email,
    access: expected.accessDetails,
    "crew-instructions": expected.crewInstructions,
  }))
    await page.locator(`#partner-book-${id}`).fill(value);
  await page
    .getByRole("checkbox", { name: "Loading dock", exact: true })
    .check();
  const materials = await openRow(page, "Any materials we should review?");
  await materials.getByRole("checkbox", { name: "Paint", exact: true }).check();
  await materials
    .getByRole("checkbox", { name: "Batteries", exact: true })
    .check();
  await openRow(page, "Work order and billing");
  for (const [id, value] of Object.entries({
    po: expected.commercial.poNumber,
    "cost-center": expected.commercial.costCenter,
    project: expected.commercial.projectReference,
    "billing-name": expected.commercial.billingContact.name,
    "billing-email": expected.commercial.billingContact.email,
  }))
    await page.locator(`#partner-book-${id}`).fill(value);
  const proof = await openRow(page, "Completion photos");
  await proof.getByRole("checkbox", { name: /Before photos/ }).check();
  await proof.getByRole("checkbox", { name: /After photos/ }).check();
  await proof.getByRole("checkbox", { name: /Completion report/ }).check();
  await proof.getByLabel("Number of photos", { exact: true }).nth(0).fill("2");
  await proof.getByLabel("Number of photos", { exact: true }).nth(1).fill("3");
  const extras = await openRow(page, "Additional services");
  await extras.getByRole("checkbox", { name: /Extra handling/ }).check();
  await page.locator(`#partner-book-add-on-${addOnKey}`).fill("2");
}

function assertSaved(
  snapshot: any,
  draftId: string,
  serviceKey: string,
  addOnKey: string,
  deadline: string,
  requestedDates: string[],
) {
  const { job, evidence } = snapshot;
  assert.equal(job.bookingDraftId, draftId);
  assert.equal(job.serviceKey, serviceKey);
  assert.equal(job.tierKey, "large");
  const scope = job.scopeSnapshot;
  assert.equal(scope.description, expected.description);
  assert.equal(scope.accessDetails, expected.accessDetails);
  assert.equal(scope.crewInstructions, expected.crewInstructions);
  assert.deepEqual(scope.onSiteContact, expected.onSiteContact);
  assert.deepEqual(scope.scope, {
    itemCount: 7,
    volumeCubicYards: 3.5,
    restrictedItems: true,
    nonStandard: true,
    hazardCategories: ["batteries", "paint"],
    equipmentNeeds: ["lift_gate", "loading_dock"],
    requiredCompletion: { localDate: deadline, localTime: "16:30" },
    multiStop: true,
    multiStopDetails: expected.multiStopDetails,
    alternateContact: expected.alternateContact,
  });
  assert.equal(job.poNumber, expected.commercial.poNumber);
  assert.equal(job.costCenter, expected.commercial.costCenter);
  assert.equal(job.projectReference, expected.commercial.projectReference);
  assert.deepEqual(
    job.billingContactSnapshot,
    expected.commercial.billingContact,
  );
  assert.deepEqual(job.proofRequirementsSnapshot, expected.proof);
  assert.equal(job.addOnsSnapshot.length, 1);
  assert.equal(job.addOnsSnapshot[0].key, addOnKey);
  assert.equal(job.addOnsSnapshot[0].quantity, 2);
  const preferences = scope.preferredWindows;
  assert.deepEqual(
    preferences.map((item: any) => ({
      localDate: item.localDate,
      timeOfDay: item.timeOfDay,
      timezone: item.timezone,
    })),
    requestedDates.map((localDate) => ({
      localDate,
      timeOfDay: "afternoon",
      timezone: "America/New_York",
    })),
  );
  assert.equal(scope.scheduleAssistancePreference, "callback");
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].category, "issue");
  assert.equal(evidence[0].caption, expected.photoCaption);
  assert.equal(evidence[0].status, "ready");
}

async function assertStaffPanel(page: Page) {
  await expect(
    page.getByText(expected.description, { exact: true }).first(),
  ).toBeVisible();
  for (const title of [
    "Service details",
    "Contact and access",
    "Special requirements",
    "Work order and billing",
    "Completion photos",
    "Scheduling",
    "Photos",
  ])
    await openRow(page, title);
  for (const value of [
    expected.accessDetails,
    expected.crewInstructions,
    ...Object.values(expected.onSiteContact),
    ...Object.values(expected.alternateContact),
    expected.commercial.poNumber,
    expected.commercial.costCenter,
    expected.commercial.projectReference,
    ...Object.values(expected.commercial.billingContact),
    expected.multiStopDetails,
  ])
    await expect(page.getByText(value, { exact: false }).first()).toBeVisible();
  const text = await page.locator("[data-partner-request]").first().innerText();
  assert.doesNotMatch(
    await page.locator("body").innerText(),
    /\[partner-portal-v2-review-request\]/u,
    "The structured request replaces generated internal notes",
  );
  for (const value of [
    "Paint",
    "Batteries",
    "Loading dock",
    "Lift gate",
    "3.5",
    "16:30",
    "Extra handling",
    "Large collection",
  ])
    assert.ok(
      text.toLowerCase().includes(value.toLowerCase()),
      `Staff panel must show ${value}`,
    );
  const bounds = await page.evaluate(() => ({
    path: location.pathname,
    textOverflow: (() => {
      const result: unknown[] = [];
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
      );
      let node = walker.nextNode();
      while (node) {
        const range = document.createRange();
        range.selectNodeContents(node);
        const rect = range.getBoundingClientRect();
        if (rect.width && (rect.right > innerWidth + 1 || rect.left < -1))
          result.push({
            text: node.textContent?.trim().slice(0, 100),
            parent: node.parentElement?.className,
            right: rect.right,
            left: rect.left,
          });
        node = walker.nextNode();
      }
      return result.slice(0, 20);
    })(),
    roots: [document.documentElement, document.body].map((element) => ({
      tag: element.tagName,
      rect: element.getBoundingClientRect().toJSON(),
      style: element.getAttribute("style"),
      margin: getComputedStyle(element).margin,
      padding: getComputedStyle(element).padding,
      overflow: getComputedStyle(element).overflow,
    })),
    viewport: innerWidth,
    width: document.documentElement.scrollWidth,
    overflowing: [...document.querySelectorAll("body *")]
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(
        ({ rect }) =>
          rect.width > 0 && (rect.right > innerWidth + 1 || rect.left < -1),
      )
      .slice(-25)
      .map(({ element, rect }) => ({
        tag: element.tagName,
        class: element.className,
        text: element.textContent?.trim().slice(0, 80),
        left: rect.left,
        right: rect.right,
        width: rect.width,
      })),
  }));
  assert.ok(
    bounds.width <= bounds.viewport + 1,
    `CRM detail fits viewport: ${JSON.stringify(bounds)}`,
  );
}

function assertStaffDto(
  data: any,
  jobId: string,
  accountId: string,
  addOnKey: string,
  deadline: string,
  dates: string[],
  confirmed = false,
) {
  assert.equal(data.version, 1);
  assert.equal(data.jobId, jobId);
  assert.equal(data.accountId, accountId);
  assert.equal(data.service.label, expected.serviceLabel);
  assert.equal(data.service.tierKey, "large");
  assert.equal(data.service.tierLabel, "Large collection");
  assert.equal(data.description, expected.description);
  assert.equal(data.accessDetails, expected.accessDetails);
  assert.equal(data.crewInstructions, expected.crewInstructions);
  assert.deepEqual(data.onSiteContact, expected.onSiteContact);
  assert.deepEqual(data.alternateContact, expected.alternateContact);
  assert.deepEqual(data.commercial, expected.commercial);
  assert.deepEqual(data.proof, expected.proof);
  assert.equal(data.scope.itemCount, 7);
  assert.equal(data.scope.volumeCubicYards, 3.5);
  assert.equal(data.scope.restrictedItems, true);
  assert.equal(data.scope.nonStandard, true);
  assert.deepEqual(data.scope.hazardCategories, ["batteries", "paint"]);
  assert.deepEqual(data.scope.equipmentNeeds, ["lift_gate", "loading_dock"]);
  assert.deepEqual(data.scope.requiredCompletion, {
    localDate: deadline,
    localTime: "16:30",
  });
  assert.equal(data.scope.multiStop, true);
  assert.equal(data.scope.multiStopDetails, expected.multiStopDetails);
  assert.deepEqual(data.scope.additionalFields, []);
  assert.deepEqual(data.addOns, [
    {
      key: addOnKey,
      label: "Extra handling",
      unitLabel: "item",
      quantity: 2,
      unitAmountMinor: 3500,
      lineTotalMinor: 7000,
      currency: "USD",
      requiresReview: true,
    },
  ]);
  assert.deepEqual(
    data.scheduling.preferredWindows,
    dates.map((localDate) => ({
      localDate,
      timeOfDay: "afternoon",
      timezone: "America/New_York",
    })),
  );
  assert.equal(data.scheduling.assistancePreference, "callback");
  assert.equal(data.scheduling.requestedWindow, null);
  assert.equal(Boolean(data.scheduling.confirmedWindow), confirmed);
  assert.equal(Boolean(data.scheduling.confirmedStartAt), confirmed);
  assert.equal(data.location.address.line2, "Dock B");
  assert.equal(data.photos.count, 1);
  assert.deepEqual(data.visibility, { financials: true, photos: true });
  assert.doesNotMatch(
    JSON.stringify(data),
    /local-private-handoff-door-code-915|accessSecretCiphertext|access_secret_ciphertext/,
  );
}

for (const width of [1440, 375])
  test(
    `production ${width}px: every request field and draft photo reaches CRM scheduling`,
    { timeout: 360_000 },
    async () => {
      await prepareLocalStorage();
      const staff = await fixture({ action: "staff" });
      // The local TLS proxy uses a disposable self-signed certificate. Chromium
      // applies context.ignoreHTTPSErrors to pages, but its mobile service worker
      // needs this browser flag too. This script has no remote-server option.
      const browser = await chromium.launch({
        args: ["--ignore-certificate-errors"],
      });
      const staffContext = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width, height: 1000 },
      });
      const partnerContext = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width, height: 1000 },
      });
      const staffPage = await staffContext.newPage(),
        page = await partnerContext.newPage();
      staffPage.setDefaultTimeout(20_000);
      page.setDefaultTimeout(20_000);
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      staffPage.on("pageerror", (error) => pageErrors.push(error.message));
      let configured: { accountId: string; profileId: string } | null = null;
      try {
        await loginStaff(staffPage, staff.id);
        const accountId = await createCompany(staffPage, page, randomUUID());
        const { serviceKey, serviceLabel, addOnKey, profileId } = await fixture(
          { action: "configure", accountId },
          true,
        );
        configured = { accountId, profileId };
        expected.serviceLabel = serviceLabel;
        await page.goto(`${base}/partners/book`);
        await requestStep(page, "Service address");
        await page
          .getByLabel("Street address", { exact: true })
          .fill("15 Local Handoff Way");
        await page
          .getByLabel("Suite, unit, building, or floor (optional)", {
            exact: true,
          })
          .fill("Dock B");
        await page.getByLabel("City", { exact: true }).fill("Atlanta");
        await page.getByLabel("State", { exact: true }).fill("GA");
        await page.getByLabel("ZIP code", { exact: true }).fill("30301");
        const additionalAddress = await openRow(
          page,
          "Add another service address",
        );
        await additionalAddress
          .getByRole("checkbox", {
            name: "This request includes another address",
            exact: true,
          })
          .check();
        await page
          .locator("#partner-book-multi-stop-details")
          .fill(expected.multiStopDetails);
        await page
          .getByRole("button", { name: "Continue", exact: true })
          .click();
        await requestStep(page, "Service details");
        const draftId = await currentDraftId(page);
        await fixture(
          {
            action: "location-secret",
            accountId,
            locationId: (await portal(page, `booking-drafts/${draftId}`)).draft
              .locationId,
          },
          true,
        );
        const day = (offset: number) => {
          const date = new Date();
          date.setUTCDate(date.getUTCDate() + offset);
          return date.toISOString().slice(0, 10);
        };
        const requestedDates = [day(2), day(3), day(4)],
          deadline = day(6);
        await restoreLegacyDraft(page, draftId);
        await enterDetails(page, serviceKey, addOnKey);
        await expect
          .poll(
            async () =>
              (await portal(page, `booking-drafts/${draftId}`)).draft
                .selectedAddOns[0]?.quantity,
          )
          .toBe(2);
        // Restore a saved draft before adding media to exercise every populated field.
        await page.reload();
        await requestStep(page, "Service details");
        await openRow(page, "Contact and access");
        await expect(page.locator("#partner-book-alternate-email")).toHaveValue(
          expected.alternateContact.email,
        );
        await openRow(page, "Work order and billing");
        await expect(page.locator("#partner-book-billing-email")).toHaveValue(
          expected.commercial.billingContact.email,
        );
        const apiRequire = createRequire(`${repo}apps/api/package.json`);
        const sharp = apiRequire("sharp");
        const photo = await sharp({
          create: {
            width: 32,
            height: 32,
            channels: 3,
            background: { r: 65, g: 113, b: 173 },
          },
        })
          .png()
          .toBuffer();
        await page.locator(`#draft-photo-files-${draftId}`).setInputFiles({
          name: "handoff-dock-issue.png",
          mimeType: "image/png",
          buffer: photo,
        });
        await openRow(page, "Photo details (optional)");
        await page
          .locator(`#draft-photo-category-${draftId}`)
          .selectOption("issue");
        await page
          .locator(`#draft-photo-caption-${draftId}`)
          .fill(expected.photoCaption);
        await page
          .getByRole("button", { name: "Continue to scheduling", exact: true })
          .click();
        await requestStep(page, "Service details");
        assert.equal(
          await page
            .locator(`#draft-photo-files-${draftId}`)
            .evaluate((input) => (input as HTMLInputElement).files?.length),
          1,
          "Pending photo is retained when Continue is blocked",
        );
        await page
          .getByRole("button", { name: "Attach photos", exact: true })
          .click();
        await expect
          .poll(
            async () =>
              (
                await portal(page, `booking-drafts/${draftId}/media`)
              ).media.filter((item: any) => item.status === "ready").length,
            { timeout: 30_000 },
          )
          .toBe(1);
        await expect(
          page.getByText(expected.photoCaption, { exact: true }).first(),
        ).toBeVisible();
        await page
          .getByRole("button", { name: "Continue to scheduling", exact: true })
          .click();
        await requestStep(page, "Scheduling");
        await openRow(page, "Completion deadline");
        await page.locator("#partner-book-required-date").fill(deadline);
        await page.locator("#partner-book-required-time").fill("16:30");
        for (let index = 0; index < 3; index++)
          await page
            .locator(`#partner-book-preferred-date-${index + 1}`)
            .fill(requestedDates[index]!);
        await page
          .locator("#partner-book-preferred-time")
          .selectOption("afternoon");
        await page
          .locator(
            'input[name="partner-book-schedule-assistance"][value="callback"]',
          )
          .check();
        await page
          .getByRole("button", { name: "Continue", exact: true })
          .click();
        await requestStep(page, "Review and submit");
        for (const value of [
          expected.description,
          expected.accessDetails,
          expected.crewInstructions,
          expected.alternateContact.name,
          expected.commercial.poNumber,
          expected.multiStopDetails,
        ])
          await expect(
            page.getByText(value, { exact: false }).first(),
          ).toBeVisible();
        await page
          .getByRole("button", { name: "Send service request", exact: true })
          .click();
        await page.waitForURL(
          (url) => /^\/partners\/bookings\/[0-9a-f-]+$/u.test(url.pathname),
          {
            timeout: 30_000,
          },
        );
        const jobId = new URL(page.url()).pathname.split("/").at(-1)!;
        const portalJob = (await portal(page, `jobs/${jobId}`)).job;
        assert.equal(portalJob.status, "under_review");
        assert.equal(portalJob.confirmationMode, "review");
        assert.equal(portalJob.arrivalWindow ?? null, null);
        const before = await fixture(
          { action: "snapshot", accountId, jobId },
          true,
        );
        assertSaved(
          before,
          draftId,
          serviceKey,
          addOnKey,
          deadline,
          requestedDates,
        );
        assert.equal(before.appointment.startAt, null);
        const detailPath = `/api/admin/partner-management/v1/service-requests/${jobId}`;
        const wrongAccount = await staffRead(
          staffPage,
          `${detailPath}?accountId=${randomUUID()}`,
        );
        assert.equal(wrongAccount.status, 404);
        assert.equal(wrongAccount.body.ok, false);
        assert.equal(wrongAccount.body.request, undefined);
        const detail = await staffRead(
          staffPage,
          `${detailPath}?accountId=${accountId}`,
        );
        assert.equal(detail.status, 200);
        assert.equal(detail.body.request.id, jobId);
        assertStaffDto(
          detail.body.request.partnerRequest,
          jobId,
          accountId,
          addOnKey,
          deadline,
          requestedDates,
        );
        assert.equal(
          detail.body.request.photos[0].filename,
          "handoff-dock-issue.png",
        );
        assert.equal(detail.body.request.photos[0].category, "issue");
        assert.equal(
          detail.body.request.photos[0].caption,
          expected.photoCaption,
        );
        assert.doesNotMatch(
          JSON.stringify(detail.body),
          /local-private-handoff-door-code-915|accessSecretCiphertext|access_secret_ciphertext/,
        );
        assert.doesNotMatch(
          JSON.stringify(portalJob),
          /local-private-handoff-door-code-915|accessSecretCiphertext/,
        );
        const companyJobs = `${base}/team/partners?p_admin=operations&p_company=${accountId}&p_company_section=jobs`;
        await staffPage.goto(companyJobs);
        await staffPage
          .getByRole("button", {
            name: new RegExp(
              expected.serviceLabel.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
            ),
          })
          .click();
        await assertStaffPanel(staffPage);
        await expect(
          staffPage.getByRole("img", {
            name: expected.photoCaption,
            exact: true,
          }),
        ).toBeVisible();
        await expect
          .poll(async () =>
            staffPage
              .getByRole("img", { name: expected.photoCaption, exact: true })
              .evaluate((img) => (img as HTMLImageElement).naturalWidth),
          )
          .toBeGreaterThan(0);
        await staffPage
          .getByLabel("New date", { exact: true })
          .fill(requestedDates[0]!);
        await staffPage
          .getByLabel("Eastern time", { exact: true })
          .fill("13:00");
        await staffPage
          .getByRole("button", { name: "Schedule service", exact: true })
          .click();
        await expect
          .poll(
            async () =>
              (await fixture({ action: "snapshot", accountId, jobId }, true))
                .job.publicStatus,
            { timeout: 30_000 },
          )
          .toBe("confirmed");
        const after = await fixture(
          { action: "snapshot", accountId, jobId },
          true,
        );
        assertSaved(
          after,
          draftId,
          serviceKey,
          addOnKey,
          deadline,
          requestedDates,
        );
        assert.ok(after.appointment.startAt);
        assert.ok(after.appointment.promisedArrivalStartAt);
        assert.equal(after.appointment.resourceAssignmentSnapshot.length, 2);
        assert.deepEqual(
          after.job.scopeSnapshot.scope,
          before.job.scopeSnapshot.scope,
          "Staff confirmation preserves requested work",
        );
        const scheduledDetail = await staffRead(
          staffPage,
          `${detailPath}?accountId=${accountId}`,
        );
        assert.equal(scheduledDetail.status, 200);
        assertStaffDto(
          scheduledDetail.body.request.partnerRequest,
          jobId,
          accountId,
          addOnKey,
          deadline,
          requestedDates,
          true,
        );
        const feed = await staffRead(
          staffPage,
          `/api/admin/calendar/feed?start=${requestedDates[0]}T00:00:00Z&end=${requestedDates[1]}T23:59:59Z`,
        );
        assert.equal(feed.status, 200);
        const event = feed.body.appointments.find(
          (item: any) => item.appointmentId === after.appointment.id,
        );
        assert.ok(event, "Scheduled request appears in the real calendar feed");
        assertStaffDto(
          event.partnerRequest,
          jobId,
          accountId,
          addOnKey,
          deadline,
          requestedDates,
          true,
        );
        const appointments = await staffRead(
          staffPage,
          `/api/appointments?propertyId=${after.appointment.propertyId}&limit=10`,
        );
        assert.equal(appointments.status, 200);
        const appointment = appointments.body.appointments.find(
          (item: any) => item.id === after.appointment.id,
        );
        assert.ok(
          appointment,
          "Scheduled request appears in the real appointments response",
        );
        assertStaffDto(
          appointment.partnerRequest,
          jobId,
          accountId,
          addOnKey,
          deadline,
          requestedDates,
          true,
        );
        const restricted = await fixture(
          { action: "restricted-staff", accountId },
          true,
        );
        const restrictedContext = await browser.newContext({
          ignoreHTTPSErrors: true,
        });
        const restrictedPage = await restrictedContext.newPage();
        await loginStaff(restrictedPage, restricted.id);
        const restrictedAppointments = await staffRead(
          restrictedPage,
          `/api/appointments?propertyId=${after.appointment.propertyId}&limit=10`,
        );
        assert.equal(restrictedAppointments.status, 200);
        const restrictedRequest = restrictedAppointments.body.appointments.find(
          (item: any) => item.id === after.appointment.id,
        )?.partnerRequest;
        assert.ok(restrictedRequest);
        assert.deepEqual(restrictedRequest.visibility, {
          financials: false,
          photos: false,
        });
        assert.equal(restrictedRequest.description, expected.description);
        assert.equal(restrictedRequest.commercial.billingContact, null);
        assert.equal(restrictedRequest.photos.detailPath, null);
        assert.equal(restrictedRequest.addOns[0].unitAmountMinor, null);
        assert.equal(restrictedRequest.addOns[0].lineTotalMinor, null);
        assert.doesNotMatch(
          JSON.stringify(restrictedRequest),
          /casey.accounts@example.test|local-private-handoff-door-code-915/,
        );
        const restrictedDetail = await staffRead(
          restrictedPage,
          `${detailPath}?accountId=${accountId}`,
        );
        assert.equal(restrictedDetail.status, 403);
        assert.equal(restrictedDetail.body.request, undefined);
        await restrictedContext.close();
        await staffPage.goto(companyJobs);
        await staffPage
          .getByRole("button", {
            name: new RegExp(
              expected.serviceLabel.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
            ),
          })
          .click();
        await assertStaffPanel(staffPage);
        if (process.env["PARTNER_CRM_SCREENSHOT_DIR"]) {
          const directory = process.env["PARTNER_CRM_SCREENSHOT_DIR"]!;
          await mkdir(directory, { recursive: true });
          await staffPage
            .locator(`[data-partner-request="${jobId}"]`)
            .screenshot({
              path: `${directory}/crm-request-${width}.png`,
            });
        }
        await staffPage.goto(
          `${base}/team/calendar?calView=day&cal=${requestedDates[0]}&eventId=${encodeURIComponent(event.id)}`,
        );
        await assertStaffPanel(staffPage);
        await expect(
          staffPage.getByRole("img", {
            name: expected.photoCaption,
            exact: true,
          }),
        ).toBeVisible();
        const noteForm = staffPage.locator(
          'form[action="/api/team/appointments/notes"]',
        );
        await noteForm
          .getByLabel("Add appointment note", { exact: true })
          .fill(expected.staffNote);
        const noteResponse = staffPage.waitForResponse(
          (response) =>
            new URL(response.url()).pathname ===
              "/api/team/appointments/notes" &&
            response.request().method() === "POST",
        );
        await noteForm
          .getByRole("button", { name: "Add note", exact: true })
          .click();
        assert.equal((await noteResponse).status(), 200);
        await staffPage.reload();
        await assertStaffPanel(staffPage);
        await expect(
          staffPage.getByText(expected.staffNote, { exact: true }),
        ).toBeVisible();
        await staffPage.goto(
          `${base}/mobile?screen=calendar&date=${requestedDates[0]}&jobId=${after.appointment.id}`,
        );
        await openRow(staffPage, "Request details");
        await assertStaffPanel(staffPage);
        if (await row(staffPage, "Notes").count())
          await openRow(staffPage, "Notes");
        await expect(
          staffPage.getByText(expected.staffNote, { exact: true }),
        ).toBeVisible();
        await expect(
          staffPage.getByRole("img", {
            name: expected.photoCaption,
            exact: true,
          }),
        ).toBeVisible();
        await page.reload();
        assert.equal(
          (await portal(page, `jobs/${jobId}`)).job.status,
          "confirmed",
        );
        assert.deepEqual(
          pageErrors,
          [],
          "Both actual applications render without client errors",
        );
        console.log(
          JSON.stringify({
            width,
            handoff: "all fields and draft photo preserved",
            staffSchedule: "confirmed",
            companyId: accountId,
            jobId,
          }),
        );
      } finally {
        if (configured)
          await fixture({ action: "release-profile", ...configured }, true);
        await browser.close();
      }
    },
  );
