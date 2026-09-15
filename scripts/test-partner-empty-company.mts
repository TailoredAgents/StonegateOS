import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
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
          DATABASE_URL:
            "postgresql://portal_test:portal_local_only@127.0.0.1:55443/portal_access_browser",
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
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    ),
    false,
    `${path} fits the viewport`,
  );
}

for (const width of [1440, 375]) {
  test(
    `production ${width}px: new activation, all tabs, first location, staff-reviewed request and company tools`,
    { timeout: 360_000 },
    async () => {
      await prepareLocalStorage();
      const staff = await fixture({ action: "staff" });
      const browser = await chromium.launch();
      const staffContext = await browser.newContext({
        ignoreHTTPSErrors: true,
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
      const page = await partnerContext.newPage();
      page.setDefaultTimeout(20_000);
      const storageFailures: Array<{
        method: string;
        error: string | undefined;
      }> = [];
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
          staffPage.getByText("Create a company and invite its Administrator", {
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
            ["overview", "jobs?limit=5", "notifications?state=unread&limit=5"],
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
          ["settings?view=company", ["account-profile", "proof-requirements"]],
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
        await expect(page.getByRole("radio", { checked: true })).toHaveCount(0);
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
        assert.doesNotMatch(JSON.stringify(saved), /synthetic-gate-code-only/);
        const savedDirectoryLocation = saved.locations.find(
          (location: { siteName: string }) =>
            location.siteName === "First local service location",
        );
        assert.ok(savedDirectoryLocation);

        await visit(page, "book");
        await requestStep(page, "Service address");
        await expect(street).toBeVisible();
        await expect(street).toHaveValue("");
        await expect(page.getByRole("radio", { checked: true })).toHaveCount(0);
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
          .locator("#partner-book-service")
          .selectOption("service_request");
        await page
          .locator("#partner-book-description")
          .fill(
            "Local release test only: remove two empty boxes. No real service.",
          );
        await page
          .getByRole("button", { name: "Continue to scheduling", exact: true })
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
          (url) => /^\/partners\/bookings\/[0-9a-f-]{36}$/u.test(url.pathname),
          {
            timeout: 30_000,
          },
        );
        const jobId = new URL(page.url()).pathname.split("/").at(-1)!;
        const result = await portal(page, `jobs/${jobId}`);
        const job = result.job ?? result.data;
        assert.equal(job.status, "under_review");
        assert.equal(job.confirmationMode, "review");
        assert.equal(job.schedule.arrivalWindow, null);

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
          create: { width: 32, height: 32, channels: 3, background: "#8090a0" },
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
          const response = await fetch("/api/partners/portal/payment-intents", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": crypto.randomUUID(),
            },
            body: JSON.stringify({}),
          });
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
        await expect(street).toBeVisible();
        await expect(street).toHaveValue("");
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
          await expect(street).toBeHidden();
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
            serviceRequest: "awaiting_staff",
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
