import { localPartnerRehearsalDatabaseUrl } from "./lib/partner-local-rehearsal";
import { completeLocalPartnerRateSetup } from "./lib/partner-service-rate-browser-setup";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium, webkit, expect, type Page } from "@playwright/test";

const require = createRequire(import.meta.url);
const repo = fileURLToPath(new URL("../", import.meta.url));
const base = "https://localhost:3112";
const password = "Local portal first request passphrase 2026!";

// Uses only the explicitly guarded, disposable local fixture. Credentials and
// invitation URLs are transferred in memory and never persisted as artifacts.
function fixture(input: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [
        require.resolve("tsx/cli"),
        `${repo}apps/api/scripts/partner-access-browser-fixture.ts`,
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
          DATABASE_URL: localPartnerRehearsalDatabaseUrl(),
        },
      },
      (error, stdout) => {
        if (error)
          return reject(
            Error(
              `Local ${input.action} fixture failed; credential output omitted.`,
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

async function visit(
  page: Page,
  path: string,
  reads: string[] = [],
  failures?: string[],
) {
  await page.goto(`${base}/partners/${path}`);
  const titles: Record<string, string> = {
    overview: "Home",
    bookings: "Jobs",
    book: "Request service",
    properties: "Locations",
    photos: "Photos & proof",
    approvals: "Approvals",
    billing: "Billing & documents",
    reports: "Reports",
    tools: "Saved tools & history",
    updates: "Updates",
    settings: "Personal settings",
    "settings?view=company": "Company settings",
    "settings/team": "Team access",
    help: "Help",
  };
  await expect(
    page.getByRole("heading", { name: titles[path], exact: true, level: 1 }),
  ).toBeVisible({ timeout: 20_000 });
  const failureNotice = page.getByText(
    /Some information could not be refreshed|Your next job could not be loaded|The upgraded job workspace|Online requests are not available for this account|We couldn’t load your locations|could not be loaded|could(?:n’t|n't| not) (?:load|refresh)|incomplete response/i,
  );
  await expect(failureNotice, `${path} must render without a failed section`)
    .toHaveCount(0)
    .catch(async () => {
      const message = `${path}: ${(await failureNotice.allTextContents()).join("; ")}`;
      if (failures) failures.push(message);
      else throw Error(message);
    });
  for (const read of reads) {
    try {
      await portal(page, read);
    } catch (error) {
      if (!failures) throw error;
      failures.push(error instanceof Error ? error.message : `${read} failed`);
    }
  }
  const overflow = await page.evaluate(() => {
    if (document.documentElement.scrollWidth <= innerWidth + 1) return [];
    return [...document.querySelectorAll("body *")]
      .filter(
        (element) => element.getBoundingClientRect().right > innerWidth + 1,
      )
      .slice(0, 16)
      .map((element) => ({
        tag: element.tagName,
        className: element.getAttribute("class"),
        right: Math.round(element.getBoundingClientRect().right),
      }));
  });
  if (overflow.length && process.env["PARTNER_MULTI_SERVICE_PREVIEW_DIR"])
    await page.screenshot({
      path: `${process.env["PARTNER_MULTI_SERVICE_PREVIEW_DIR"]}/overflow-${path.replaceAll(/[^a-z]/g, "-")}-${page.viewportSize()?.width}.png`,
      fullPage: true,
    });
  assert.deepEqual(overflow, [], `${path} fits the viewport`);
  if (path === "settings" && (page.viewportSize()?.width ?? 0) < 600) {
    const channels = page.getByRole("region", {
      name: "Notification delivery channels",
      exact: true,
    });
    await channels.focus();
    await channels.press("ArrowRight");
    await expect
      .poll(() => channels.evaluate((element) => element.scrollLeft))
      .toBeGreaterThan(0);
    const sms = channels.getByRole("columnheader", {
      name: "SMS",
      exact: true,
    });
    await sms.scrollIntoViewIfNeeded();
    const regionBox = await channels.boundingBox();
    const smsBox = await sms.boundingBox();
    assert.ok(regionBox && smsBox);
    assert.ok(
      smsBox.x >= regionBox.x &&
        smsBox.x + smsBox.width <= regionBox.x + regionBox.width + 1,
      "The notification table scrolls to the SMS column on a phone",
    );
  }
}

for (const [engine, browserType] of [
  ["chromium", chromium],
  ["webkit", webkit],
] as const)
  for (const width of [1440, 375]) {
    test(
      `production ${engine} ${width}px: new activation, all tabs, first location, staff-reviewed request and company tools`,
      { timeout: 600_000 },
      async () => {
        const matrixIndex =
          (engine === "webkit" ? 2 : 0) + (width === 375 ? 1 : 0);
        await prepareLocalStorage();
        const staff = await fixture({ action: "staff" });
        const browser = await browserType.launch();
        const staffContext = await browser.newContext({
          ignoreHTTPSErrors: true,
          viewport: { width, height: 1000 },
        });
        await staffContext.addCookies([
          {
            name: "myst-team-session",
            value: staff.sessionToken,
            url: base,
            httpOnly: true,
            sameSite: "Lax",
          },
        ]);
        const staffPage = await staffContext.newPage();
        const partnerContext = await browser.newContext({
          ignoreHTTPSErrors: true,
          viewport: { width, height: 1000 },
        });
        let page = await partnerContext.newPage();
        const administratorPage = page;
        page.setDefaultTimeout(20_000);
        const storageFailures: Array<{
          method: string;
          error: string | undefined;
        }> = [];
        const storageResponses: Array<{ method: string; status: number }> = [];
        const browserDiagnostics: string[] = [];
        page.on("console", (message) => {
          if (message.type() === "error")
            browserDiagnostics.push(
              message.text().replace(/https?:\/\/\S+/g, "[URL omitted]"),
            );
        });
        page.on("response", (response) => {
          if (new URL(response.url()).port === "14566")
            storageResponses.push({
              method: response.request().method(),
              status: response.status(),
            });
        });
        page.on("requestfailed", (request) => {
          if (new URL(request.url()).port === "14566")
            storageFailures.push({
              method: request.method(),
              error: request.failure()?.errorText,
            });
        });
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        const suffix = randomUUID();
        const email = `first-company-${suffix}@example.test`;
        try {
          await staffPage.goto(`${base}/team/partners?p_admin=accounts`);
          const addPartner = staffPage.getByRole("link", {
            name: "Add partner",
            exact: true,
          });
          await expect(addPartner).toBeVisible();
          await staffPage.goto(
            new URL((await addPartner.getAttribute("href"))!, base).toString(),
          );
          await expect(
            staffPage.getByText("Company details", {
              exact: true,
            }),
          ).toBeVisible({ timeout: 20_000 });
          await staffPage
            .getByLabel("Company name", { exact: true })
            .fill(`Local first company ${suffix}`);
          await staffPage
            .getByLabel("Administrator name", { exact: true })
            .fill("Local portal administrator");
          await staffPage
            .getByLabel("Administrator email", { exact: true })
            .fill(email);
          await staffPage
            .getByLabel("Relationship confirmation", { exact: true })
            .fill(
              "Disposable release test: synthetic company and relationship only.",
            );
          await staffPage
            .getByRole("button", {
              name: "Create company and continue",
              exact: true,
            })
            .click();
          await completeLocalPartnerRateSetup(staffPage);
          const invitation = await fixture({ action: "invitation", email });
          try {
            await page.goto(invitation.url);
          } catch {
            throw Error("Local invitation navigation failed; token omitted.");
          }
          await page
            .getByRole("button", {
              name: "Continue to password setup",
              exact: true,
            })
            .click();
          await page.getByLabel("New password", { exact: true }).fill(password);
          await page
            .getByRole("button", { name: "Finish and sign in", exact: true })
            .click();
          await page.waitForURL(/\/partners\/overview$/u);

          const me = await portal(page, "me");
          assert.equal(me.account.id, invitation.accountId);
          assert.equal(me.membership.roleKey, "administrator");
          assert.equal(me.availability.reads, true);
          assert.equal(me.availability.writes, true);
          assert.equal(me.availability.instantConfirmation, false);
          assert.deepEqual(me.availability.payments, {
            card: false,
            ach: false,
            hosted: false,
          });
          assert.equal(me.availability.uploads.documents, false);
          assert.ok(
            Object.values(me.workflow.tools).every(
              (enabled) => enabled === false,
            ),
          );
          const home = await portal(page, "overview");
          assert.equal(home.nextJob, null);
          const locations = await portal(page, "locations?limit=100");
          assert.deepEqual(locations.locations, []);
          assert.equal(locations.directory.canCreateLocation, true);
          assert.equal(locations.directory.canManagePortfolio, false);

          const initialFailures: string[] = [];
          for (const [path, reads] of [
            [
              "overview",
              [
                "overview",
                "jobs?limit=5",
                "notifications?state=unread&limit=5",
              ],
            ],
            ["bookings", ["jobs?limit=25"]],
            [
              "book",
              [
                "locations",
                "service-catalog",
                "proof-requirements",
                "cancellation-policy",
              ],
            ],
            ["properties", ["locations?active=all&limit=100"]],
            ["photos", ["jobs?limit=25"]],
            ["approvals", ["approval-requests?limit=25"]],
            [
              "billing",
              [
                "quotes?limit=100",
                "invoices?limit=100",
                "documents?limit=100",
                "statements?limit=100",
              ],
            ],
            ["updates", ["notifications?state=all&limit=25"]],
            [
              "settings",
              [
                "personal-profile",
                "account-profile",
                "sessions",
                "notification-preferences",
                "notification-endpoints",
              ],
            ],
            [
              "settings?view=company",
              ["account-profile", "proof-requirements"],
            ],
            [
              "settings/team",
              ["members?status=all&limit=100", "invitations?limit=100"],
            ],
            ["help", []],
          ] as Array<[string, string[]]>)
            await visit(page, path, reads, initialFailures);
          assert.deepEqual(
            initialFailures,
            [],
            "Every normal tab must load its actual data",
          );
          console.log(
            JSON.stringify({ viewport: width, stage: "all_empty_tabs_passed" }),
          );

          const requestFixture = await fixture({
            action: "approval-rule",
            accountId: invitation.accountId,
            staffId: staff.id,
          });
          await administratorPage.goto(`${base}/partners/settings/team`);
          const coworkerEmail = `operations-${suffix}@example.test`;
          const invitationForm = administratorPage.locator("form").filter({
            has: administratorPage.getByLabel("Work email", { exact: true }),
          });
          await invitationForm
            .getByLabel("Full name", { exact: true })
            .fill("Local operations requester");
          await invitationForm
            .getByLabel("Work email", { exact: true })
            .fill(coworkerEmail);
          await invitationForm
            .getByRole("combobox", { name: "Role", exact: true })
            .selectOption("operations");
          await invitationForm
            .getByRole("button", { name: "Send invitation", exact: true })
            .click();
          await expect(
            administratorPage
              .getByRole("status")
              .filter({ hasText: /invitation/i })
              .first(),
          ).toBeVisible();
          const coworkerInvitation = await fixture({
            action: "invitation",
            email: coworkerEmail,
          });
          const operationsContext = await browser.newContext({
            ignoreHTTPSErrors: true,
            viewport: { width, height: 1000 },
          });
          page = await operationsContext.newPage();
          page.setDefaultTimeout(20_000);
          page.on("pageerror", (error) => pageErrors.push(error.message));
          await page.goto(coworkerInvitation.url).catch(() => {
            throw Error("Local coworker invitation failed; token omitted.");
          });
          await page
            .getByRole("button", {
              name: "Continue to password setup",
              exact: true,
            })
            .click();
          await page.getByLabel("New password", { exact: true }).fill(password);
          await page
            .getByRole("button", { name: "Finish and sign in", exact: true })
            .click();
          await page.waitForURL(/\/partners\/overview$/u);
          assert.equal(
            (await portal(page, "me")).membership.roleKey,
            "operations",
          );

          // Start where a new partner starts: the address is immediately available,
          // without first visiting Locations or opening an add-location panel.
          await visit(page, "book");
          await requestStep(page, "Service address");
          const street = page.getByLabel("Street address", { exact: true });
          await expect(street).toBeVisible();
          await expect(street).toHaveValue("");
          await expect(
            page.getByRole("button", {
              name: "Use a saved address",
              exact: true,
            }),
          ).toHaveCount(0);
          await expect(page.getByRole("radio", { checked: true })).toHaveCount(
            0,
          );
          const addressDraftId = await currentDraftId(page);
          assert.equal(
            (await portal(page, `booking-drafts/${addressDraftId}`)).draft
              .locationId,
            null,
          );
          await expect(street).toBeEnabled();
          if (process.env["PARTNER_RELEASE_SCREENSHOT_PREFIX"]) {
            await page.screenshot({
              path: `${process.env["PARTNER_RELEASE_SCREENSHOT_PREFIX"]}-${width}.png`,
              fullPage: true,
            });
          }
          await street.fill("2 Local Request Way");
          await page
            .getByLabel(/Suite, unit, building, or floor/)
            .fill("Suite 5");
          await page.getByLabel("City", { exact: true }).fill("Atlanta");
          await page.getByLabel("State", { exact: true }).fill("GA");
          await page.getByLabel("ZIP code", { exact: true }).fill("30301");
          await expect(
            page.getByLabel("Location label (optional)", { exact: true }),
          ).toHaveValue("");
          const [createdAddressResponse] = await Promise.all([
            page.waitForResponse(
              (response) =>
                new URL(response.url()).pathname ===
                  "/api/partners/portal/locations" &&
                response.request().method() === "POST",
            ),
            page.getByRole("button", { name: "Continue", exact: true }).click(),
          ]);
          assert.equal(createdAddressResponse.ok(), true);
          const createdAddress = (await createdAddressResponse.json()).location;
          assert.equal(createdAddress.siteName, "2 Local Request Way");
          assert.equal(createdAddress.address.line2, "Suite 5");
          await requestStep(page, "Service details");
          assert.equal(
            (await portal(page, `booking-drafts/${addressDraftId}`)).draft
              .locationId,
            createdAddress.id,
            "Continuing saves the entered address on this request",
          );
          assert.equal((await portal(page, "locations")).locations.length, 1);

          const restoredDescription =
            "Local release draft recovery: two empty boxes.";
          await page
            .getByText("Project notes (optional)", { exact: true })
            .click();
          await page
            .locator("#partner-book-description")
            .fill(restoredDescription);
          await expect
            .poll(
              async () =>
                (await portal(page, `booking-drafts/${addressDraftId}`)).draft
                  .description,
            )
            .toBe(restoredDescription);
          await page.reload();
          await requestStep(page, "Service details");
          assert.equal(await currentDraftId(page), addressDraftId);
          await page
            .getByText("Project notes (optional)", { exact: true })
            .click();
          await expect(page.locator("#partner-book-description")).toHaveValue(
            restoredDescription,
          );
          await page.getByRole("button", { name: "Back", exact: true }).click();
          await requestStep(page, "Service address");
          await expect(
            page.getByText(/2 Local Request Way/).first(),
          ).toBeVisible();
          await expect(street).toBeHidden();
          await expect(
            page.locator("#partner-book-selected-address"),
          ).toHaveAttribute("data-selected-location-id", createdAddress.id);
          assert.equal(
            (await portal(page, `booking-drafts/${addressDraftId}`)).draft
              .locationId,
            createdAddress.id,
            "Restoring the draft retains its explicitly chosen address",
          );
          console.log(
            JSON.stringify({
              viewport: width,
              stage: "address_first_and_draft_restore_passed",
            }),
          );

          await visit(page, "properties");
          await page
            .getByRole("button", { name: "Add location", exact: true })
            .click();
          const form = page.locator("#partner-add-location");
          await form
            .getByLabel("Location name", { exact: true })
            .fill("First local service location");
          await form
            .getByLabel("Street address", { exact: true })
            .fill("1 Local Test Way");
          await form.getByLabel("City", { exact: true }).fill("Atlanta");
          await form.getByLabel("State", { exact: true }).fill("GA");
          await form.getByLabel("ZIP code", { exact: true }).fill("30301");
          await form
            .getByLabel(/Gate code or private access secret/)
            .fill("synthetic-gate-code-only");
          await form
            .getByLabel("Default on-site contact", { exact: true })
            .fill("Local test contact");
          await form
            .getByLabel("Contact phone", { exact: true })
            .fill("+14045550100");
          await form
            .getByRole("button", { name: "Add location", exact: true })
            .click();
          await expect(form).toHaveCount(0);
          const saved = await portal(page, "locations");
          assert.equal(saved.locations.length, 2);
          assert.doesNotMatch(
            JSON.stringify(saved),
            /synthetic-gate-code-only/,
          );
          const savedDirectoryLocation = saved.locations.find(
            (location: { siteName: string }) =>
              location.siteName === "First local service location",
          );
          assert.ok(savedDirectoryLocation);

          await visit(page, "book");
          await requestStep(page, "Service address");
          await expect(street).toBeVisible();
          await expect(street).toHaveValue("");
          await expect(page.getByRole("radio", { checked: true })).toHaveCount(
            0,
          );
          const savedAddressDraftId = await currentDraftId(page);
          assert.equal(
            (await portal(page, `booking-drafts/${savedAddressDraftId}`)).draft
              .locationId,
            null,
            "A fresh request does not silently choose a saved address",
          );
          await page
            .getByRole("button", { name: "Use a saved address", exact: true })
            .click();
          await page
            .getByRole("radio", { name: /First local service location/ })
            .click();
          await expect(
            page.locator("#partner-book-selected-address"),
          ).toHaveAttribute(
            "data-selected-location-id",
            savedDirectoryLocation.id,
          );
          await page
            .getByRole("button", { name: "Continue", exact: true })
            .click();
          await requestStep(page, "Service details");
          await page
            .getByRole("checkbox", { name: "Junk removal", exact: true })
            .check();
          await page
            .getByRole("textbox", {
              name: "What needs to be done?",
              exact: true,
            })
            .fill(
              "Local release test only: remove two empty boxes. No real service.",
            );
          await page
            .getByRole("checkbox", { name: "Painting", exact: true })
            .check();
          await page
            .getByRole("textbox", {
              name: "What needs to be done?",
              exact: true,
            })
            .fill(
              "Local release test only: touch up the empty lobby. No real service.",
            );
          await page
            .getByRole("button", {
              name: "Continue to scheduling",
              exact: true,
            })
            .click();
          await requestStep(page, "Scheduling");
          const preferred = new Date(Date.now() + 2 * 86_400_000)
            .toISOString()
            .slice(0, 10);
          await page.locator('input[type="date"]').first().fill(preferred);
          await page
            .getByRole("button", { name: "Continue", exact: true })
            .click();
          await requestStep(page, "Review and submit");
          await page
            .getByRole("button", { name: "Send service request", exact: true })
            .click();
          await page.waitForURL(
            (url) =>
              /^\/partners\/bookings\/[0-9a-f-]{36}$/u.test(url.pathname),
            {
              timeout: 30_000,
            },
          );
          const jobId = new URL(page.url()).pathname.split("/").at(-1)!;
          const result = await portal(page, `jobs/${jobId}`);
          assert.equal(result.job.modelVersion, 2);
          assert.deepEqual(
            result.job.multiService.serviceLines
              .map((line: { serviceKey: string }) => line.serviceKey)
              .sort(),
            ["junk-removal", "painting"],
          );
          assert.equal(result.job.multiService.visits.length, 0);
          assert.equal(result.job.schedule.arrivalWindow, null);
          assert.equal(result.job.multiService.quotedTotalCents, null);
          await expect(
            page.getByText(/No visits are scheduled yet/),
          ).toBeVisible();

          const job = result.job ?? result.data;
          assert.equal(job.status, "approval_needed");
          assert.equal(job.confirmationMode, "approval");
          assert.equal(job.schedule.arrivalWindow, null);

          const requestUrl = `${base}/team/partners?${new URLSearchParams({ p_admin: "requests", p_request: `service:${jobId}`, p_company: invitation.accountId })}`;
          await staffPage.goto(requestUrl);
          const pricing = staffPage.getByRole("region", {
            name: "Request pricing",
            exact: true,
          });
          await expect(pricing).toBeVisible();
          for (const [label, amount] of [
            ["Junk removal", "100"],
            ["Painting", "200"],
          ]) {
            const row = pricing.locator("details").filter({
              has: staffPage.locator("summary").filter({ hasText: label }),
            });
            if (!(await row.getAttribute("open"))) {
              if (
                !(await row.evaluate(
                  (node) => (node as HTMLDetailsElement).open,
                ))
              )
                await row.locator("summary").click();
            }
            await row
              .getByLabel("Service total ($)", { exact: true })
              .fill(amount);
          }
          await pricing
            .getByLabel("Price review note", { exact: true })
            .fill("Synthetic review of both service scopes and agreed rates.");
          await pricing
            .getByRole("button", { name: "Confirm price", exact: true })
            .click();
          await expect
            .poll(
              async () =>
                (await portal(administratorPage, `jobs/${jobId}`)).job
                  .multiService.quotedTotalCents,
            )
            .toBe(30000);
          const approvals = await portal(
            administratorPage,
            "approval-requests?limit=100",
          );
          const approval = approvals.approvalRequests.find(
            (item: { target: { id: string } }) =>
              item.target.id === jobId &&
              (item as { state?: string }).state === "pending",
          );
          assert.ok(
            approval,
            "The painting request requires a separate company approver",
          );
          assert.equal(
            approval.requestedByCurrentMember,
            false,
            "The administrator is a different person from the requester",
          );
          const operationsApproval = await page.evaluate(
            async (id) =>
              (await fetch(`/api/partners/portal/approval-requests/${id}`))
                .status,
            approval.id,
          );
          assert.equal(
            operationsApproval,
            403,
            "The operations requester cannot use the administrator approval boundary",
          );
          await administratorPage.goto(
            `${base}/partners/approvals/${approval.id}`,
          );
          await expect(
            administratorPage.getByRole("heading", {
              name: /^Junk removal, painting$/i,
              level: 1,
            }),
          ).toBeVisible();
          await administratorPage
            .getByRole("button", { name: "Record approval", exact: true })
            .click();
          await expect
            .poll(
              async () =>
                (await portal(administratorPage, `jobs/${jobId}`)).job.status,
            )
            .toBe("under_review");
          assert.equal(
            (await portal(administratorPage, `jobs/${jobId}`)).job.multiService
              .visits.length,
            0,
            "Company approval alone does not reserve a visit",
          );
          for (let index = 0; index < 2; index += 1) {
            await staffPage.goto(requestUrl);
            const visits = staffPage.getByRole("region", {
              name: "Scheduled visits",
              exact: true,
            });
            await visits
              .getByRole("button", { name: "Schedule a visit", exact: true })
              .click();
            const selectedLabel = index === 0 ? "Junk removal" : "Painting";
            const otherLabel = index === 0 ? "Painting" : "Junk removal";
            await visits
              .getByRole("checkbox", { name: selectedLabel, exact: true })
              .check();
            await visits
              .getByRole("checkbox", { name: otherLabel, exact: true })
              .uncheck();
            const date = new Date(
              Date.now() + (14 + matrixIndex * 14 + index * 7) * 86400000,
            );
            while ([0, 6].includes(date.getUTCDay()))
              date.setUTCDate(date.getUTCDate() + 1);
            await visits
              .getByLabel("Visit date", { exact: true })
              .fill(date.toISOString().slice(0, 10));
            await visits
              .getByRole("combobox", { name: /^Start time \(Eastern\)/ })
              .selectOption("09:00");
            await visits
              .getByLabel("Work duration (minutes)", { exact: true })
              .fill(
                String(index === 0 ? requestFixture.junkDurationMinutes : 120),
              );
            await visits
              .getByText("Crew, truck and equipment", { exact: true })
              .click();
            await visits
              .getByRole("checkbox", {
                name: `${requestFixture.crewLabel} · crew`,
                exact: true,
              })
              .check();
            await visits
              .getByLabel("Travel buffer (minutes)", { exact: true })
              .fill(
                String(
                  index === 0 ? requestFixture.junkTravelBufferMinutes : 0,
                ),
              );
            if (index === 0)
              await visits
                .getByRole("checkbox", {
                  name: `${requestFixture.truckLabel} · truck`,
                  exact: true,
                })
                .check();
            const confirm = visits.getByRole("button", {
              name: "Confirm service",
              exact: true,
            });
            await expect(confirm).toBeEnabled();
            assert.equal(
              await staffPage.evaluate(
                () => document.documentElement.scrollWidth > innerWidth + 1,
              ),
              false,
              "CRM scheduling fits the viewport",
            );
            await confirm.click();
            await expect
              .poll(
                async () =>
                  (await portal(administratorPage, `jobs/${jobId}`)).job
                    .multiService.visits.length,
                { timeout: 30000 },
              )
              .toBe(index + 1)
              .catch(async () => {
                throw Error(
                  JSON.stringify({
                    stage: "confirm_visit",
                    index,
                    alerts: await staffPage
                      .getByRole("alert")
                      .allTextContents(),
                    notices: await visits.getByRole("status").allTextContents(),
                  }),
                );
              });
            const scheduled = (await portal(administratorPage, `jobs/${jobId}`))
              .job;
            assert.equal(
              scheduled.multiService.visits[index].serviceLineIds.length,
              1,
            );
            if (index === 0) {
              assert.equal(scheduled.status, "partially_scheduled");
              assert.equal(
                scheduled.multiService.unscheduledServiceLineIds.length,
                1,
              );
            }
          }
          const scheduled = (await portal(administratorPage, `jobs/${jobId}`))
            .job;
          assert.equal(scheduled.status, "confirmed");
          assert.equal(
            scheduled.multiService.unscheduledServiceLineIds.length,
            0,
          );
          assert.equal(
            new Set(
              scheduled.multiService.visits.flatMap(
                (item: { serviceLineIds: string[] }) => item.serviceLineIds,
              ),
            ).size,
            2,
          );
          await administratorPage.goto(`${base}/partners/bookings/${jobId}`);
          await expect(
            administratorPage.getByRole("heading", {
              name: "Visit 1",
              exact: true,
            }),
          ).toBeVisible();
          await expect(
            administratorPage.getByRole("heading", {
              name: "Visit 2",
              exact: true,
            }),
          ).toBeVisible();
          await expect(
            administratorPage.getByText("Reviewed service price: $100.00", {
              exact: true,
            }),
          ).toBeVisible();
          await expect(
            administratorPage.getByText("Reviewed service price: $200.00", {
              exact: true,
            }),
          ).toBeVisible();
          await expect(
            administratorPage.getByRole("link", {
              name: "Change schedule",
              exact: true,
            }),
          ).toHaveCount(0);
          const firstVisit = administratorPage.locator("li").filter({
            has: administratorPage.getByRole("heading", {
              name: "Visit 1",
              exact: true,
            }),
          });
          await firstVisit
            .getByText("Request a different date", { exact: true })
            .click();
          await firstVisit
            .getByLabel("Preferred date", { exact: true })
            .fill(
              new Date(Date.now() + (7 + matrixIndex * 3) * 86400000)
                .toISOString()
                .slice(0, 10),
            );
          await firstVisit
            .getByRole("button", { name: "Request date change", exact: true })
            .click();
          await expect(firstVisit.getByRole("status"))
            .toContainText("Date change requested for this visit")
            .catch(async () => {
              throw Error(
                JSON.stringify({
                  stage: "request_visit_change",
                  alerts: await firstVisit.getByRole("alert").allTextContents(),
                  date: await firstVisit
                    .getByLabel("Preferred date", { exact: true })
                    .inputValue(),
                  button: await firstVisit
                    .getByRole("button", {
                      name: /Request date change|Sending request/,
                    })
                    .textContent(),
                }),
              );
            });
          const afterChange = (await portal(administratorPage, `jobs/${jobId}`))
            .job;
          assert.deepEqual(
            afterChange.multiService.visits,
            scheduled.multiService.visits,
            "A visit change request preserves both confirmed visits until staff accepts it",
          );
          assert.ok(
            afterChange.pendingRescheduleRequest?.id,
            "The requested date change is linked to this job",
          );
          await staffPage.goto(
            `${base}/team/partners?${new URLSearchParams({ p_admin: "requests", p_request: `reschedule:${afterChange.pendingRescheduleRequest.id}`, p_company: invitation.accountId })}`,
          );
          const changeDate = new Date(
            Date.now() + (7 + matrixIndex * 3) * 86400000,
          );
          while ([0, 6].includes(changeDate.getUTCDay()))
            changeDate.setUTCDate(changeDate.getUTCDate() + 1);
          await staffPage
            .getByLabel("Replacement date", { exact: true })
            .fill(changeDate.toISOString().slice(0, 10));
          await staffPage
            .getByRole("combobox", { name: /^Start time \(Eastern\)/ })
            .selectOption("09:00");
          await staffPage
            .getByLabel("Decision reason", { exact: true })
            .fill(
              "Synthetic client-approved date change for the first service visit.",
            );
          const acceptReplacement = staffPage.getByRole("button", {
            name: "Accept replacement",
            exact: true,
          });
          await expect(acceptReplacement).toBeEnabled();
          await acceptReplacement.click();
          await expect
            .poll(
              async () =>
                (
                  await portal(administratorPage, `jobs/${jobId}`)
                ).job.multiService.visits.find(
                  (item: { id: string }) =>
                    item.id === scheduled.multiService.visits[0].id,
                ).startAt,
              { timeout: 30000 },
            )
            .not.toBe(scheduled.multiService.visits[0].startAt)
            .catch(async () => {
              throw Error(
                JSON.stringify({
                  stage: "accept_visit_change",
                  alerts: await staffPage.getByRole("alert").allTextContents(),
                  notices: await staffPage
                    .getByRole("status")
                    .allTextContents(),
                }),
              );
            });
          const acceptedChange = (
            await portal(administratorPage, `jobs/${jobId}`)
          ).job;
          assert.deepEqual(
            acceptedChange.multiService.visits.find(
              (item: { id: string }) =>
                item.id === scheduled.multiService.visits[1].id,
            ),
            scheduled.multiService.visits[1],
            "Accepting the first visit's date change leaves the second visit intact",
          );
          assert.equal(
            acceptedChange.multiService.visits.length,
            2,
            "Accepting a date change updates the same visit without adding another",
          );
          await staffPage.goto(
            `${base}/team/partners?p_admin=accounts&p_company=${invitation.accountId}&p_company_section=billing`,
          );
          await staffPage
            .getByRole("button", { name: "Create invoice draft", exact: true })
            .click();
          await staffPage
            .getByRole("combobox", { name: /^Job/ })
            .selectOption(jobId);
          await expect(
            staffPage.getByText(/approved or final CRM job total of \$300.00/),
          ).toBeVisible();
          assert.equal(
            await staffPage
              .getByRole("textbox", { name: /Description/ })
              .count(),
            2,
            "Invoice editor receives both service lines without creating an invoice",
          );
          page = administratorPage;
          console.log(
            JSON.stringify({
              engine,
              viewport: width,
              stage:
                "multi_service_price_approval_two_visits_date_change_and_billing_passed",
            }),
          );

          await page.goto(`${base}/partners/photos?jobId=${jobId}`);
          await expect(
            page.getByRole("heading", {
              name: "Photos & proof",
              exact: true,
              level: 1,
            }),
          ).toBeVisible();
          const apiRequire = createRequire(`${repo}apps/api/package.json`);
          const photo: Buffer = await apiRequire("sharp")({
            create: {
              width: 32,
              height: 32,
              channels: 3,
              background: "#8090a0",
            },
          })
            .png()
            .toBuffer();
          await page.locator(`#proof-files-${jobId}`).setInputFiles({
            name: "local-release-photo.png",
            mimeType: "image/png",
            buffer: photo,
          });
          await page
            .getByRole("button", { name: "Upload photos", exact: true })
            .click();
          await expect
            .poll(
              async () =>
                (await portal(page, `jobs/${jobId}/proof`)).proof.media.filter(
                  (file: { downloadIntent: unknown }) => file.downloadIntent,
                ).length,
              { timeout: 30_000 },
            )
            .toBe(1)
            .catch(async () => {
              throw Error(
                JSON.stringify({
                  stage: "photo_processing",
                  storageFailures,
                  storageResponses,
                  browserDiagnostics,
                  notices: await page.getByRole("alert").allTextContents(),
                }),
              );
            });
          const proof = (await portal(page, `jobs/${jobId}/proof`)).proof;
          assert.equal(proof.documentUploadsAvailable, false);
          assert.ok(
            proof.media[0].downloadIntent,
            "Accepted photo has an authorized viewing URL",
          );
          await expect(
            page.getByText(/PDF uploads are not available yet/),
          ).toBeVisible();
          await page.goto(`${base}/partners/bookings/${jobId}`);
          await page
            .getByLabel("Message Stonegate", { exact: true })
            .fill("Synthetic release check: an in-portal message only.");
          await page
            .getByRole("button", { name: "Send message", exact: true })
            .click();
          await expect(
            page.getByText(
              "Synthetic release check: an in-portal message only.",
              { exact: true },
            ),
          ).toBeVisible();
          const paymentAttempt = await page.evaluate(async () => {
            const response = await fetch(
              "/api/partners/portal/payment-intents",
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "Idempotency-Key": crypto.randomUUID(),
                },
                body: JSON.stringify({}),
              },
            );
            return { status: response.status, body: await response.json() };
          });
          assert.equal(paymentAttempt.status, 503);
          assert.equal(paymentAttempt.body.ok, false);
          console.log(
            JSON.stringify({
              viewport: width,
              stage: "first_request_photo_and_message_passed",
            }),
          );

          await staffPage.goto(
            `${base}/team/partners?p_admin=accounts&p_company=${invitation.accountId}&p_company_section=settings`,
          );
          for (const label of [
            "Saved service templates",
            "Recurring service",
            "Bulk requests",
            "Reports",
            "Portfolio tools",
            "Approval rules",
          ]) {
            await staffPage
              .getByRole("checkbox", { name: label, exact: true })
              .check();
          }
          await staffPage
            .getByRole("button", { name: "Save company tools", exact: true })
            .click();
          await expect
            .poll(async () =>
              Object.values((await portal(page, "me")).workflow.tools).every(
                (enabled) => enabled === true,
              ),
            )
            .toBe(true);

          // An account default remains a reusable preference, not an implicit
          // service-address choice for every new request.
          await visit(page, "properties");
          await page
            .getByRole("button", { name: "Make default", exact: true })
            .first()
            .click();
          await expect
            .poll(
              async () =>
                (await portal(page, "locations")).directory.defaultLocationId,
            )
            .toBeTruthy();
          const defaultDirectory = await portal(page, "locations");
          await visit(page, "book");
          await requestStep(page, "Service address");
          const administratorStreet = page.getByLabel("Street address", {
            exact: true,
          });
          await expect(administratorStreet).toBeVisible();
          await expect(administratorStreet).toHaveValue("");
          const freshDraftId = await currentDraftId(page);
          assert.equal(
            (await portal(page, `booking-drafts/${freshDraftId}`)).draft
              .locationId,
            null,
            "An account default is not preselected on a fresh request",
          );

          const explicitAddress = defaultDirectory.locations.find(
            (location: { id: string }) =>
              location.id !== defaultDirectory.directory.defaultLocationId,
          );
          assert.ok(
            explicitAddress,
            "Fixture has a non-default address to choose",
          );
          for (const parameter of ["locationId", "propertyId"]) {
            await page.goto(
              `${base}/partners/book?${parameter}=${explicitAddress.id}`,
            );
            await requestStep(page, "Service address");
            await expect(administratorStreet).toBeHidden();
            await expect(
              page.locator("#partner-book-selected-address"),
            ).toHaveAttribute("data-selected-location-id", explicitAddress.id);
            await expect(
              page.getByRole("button", { name: "Change address", exact: true }),
            ).toBeVisible();
            const explicitDraftId = await currentDraftId(page);
            assert.equal(
              (await portal(page, `booking-drafts/${explicitDraftId}`)).draft
                .locationId,
              explicitAddress.id,
              `An explicit ${parameter} link preserves the chosen address`,
            );
          }
          for (const path of [
            "overview",
            "bookings",
            "book",
            "properties",
            "photos",
            "approvals",
            "billing",
            "reports",
            "tools",
            "updates",
            "settings",
            "settings?view=company",
            "settings/team",
            "help",
          ])
            await visit(
              page,
              path,
              path === "tools"
                ? ["service-templates", "recurring-series", "bulk-imports"]
                : path === "reports"
                  ? ["reports?kind=operational"]
                  : [],
            );
          await visit(page, "billing");
          await expect(
            page.getByText(/Pay your deposit or invoice securely here/),
          ).toHaveCount(0);

          // An entirely new browser context proves password login, not just the
          // activation session, reaches fully loaded company data.
          const loginContext = await browser.newContext({
            ignoreHTTPSErrors: true,
            viewport: { width, height: 1000 },
          });
          const loginPage = await loginContext.newPage();
          await loginPage.goto(`${base}/partners/login`);
          await loginPage.getByLabel("Email", { exact: true }).fill(email);
          await loginPage.locator('input[name="password"]').fill(password);
          await loginPage
            .getByRole("button", { name: "Sign in", exact: true })
            .click();
          await loginPage.waitForURL(/\/partners\/overview$/u);
          await portal(loginPage, "overview");
          assert.equal(
            (await portal(loginPage, "locations")).locations.length,
            2,
          );
          assert.deepEqual(
            pageErrors,
            [],
            "No client rendering exceptions during the full journey",
          );
          console.log(
            JSON.stringify({
              viewport: width,
              activation: "passed",
              allTabs: "passed",
              firstLocation: "passed",
              addressFirst: "passed",
              savedAddressChoice: "explicit",
              draftRestore: "passed",
              serviceRequest: "two_confirmed_visits",
              companyTools: "enabled",
              passwordLogin: "passed",
            }),
          );
        } finally {
          await browser.close();
        }
      },
    );
  }
