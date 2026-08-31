import { randomUUID } from "node:crypto";
import type { Page, Route } from "@playwright/test";
import { expect, test } from "../test";
import {
  archiveQuoteV2E2EFixtures,
  bookQuoteV2E2EFixture,
  closeQuoteV2E2EFixtureConnection,
  createQuoteV2E2EFixture,
  issueQuoteV2E2EFixtureRevision,
  supersedeQuoteV2E2EFixture,
  type QuoteV2E2EFixture,
} from "../support/quote-v2";

const OWNER_STORAGE = "tests/e2e/storage/mobile-owner.json";
const CONTACT_ID = "2d5ce865-f4a4-4db1-8434-dfc24698e630";
const PROPERTY_ID = "292e239b-a32e-4ad7-b1f5-1c746190b155";
const COMPOSER_QUOTE_ID = "0f193342-2478-43ad-bce3-09ae582bf018";
const COMPOSER_VERSION_ID = "96d7fc13-97ea-42f0-aa88-72485705228a";

test.use({ storageState: OWNER_STORAGE, serviceWorkers: "block" });
test.afterEach(async () => archiveQuoteV2E2EFixtures());
test.afterAll(async () => closeQuoteV2E2EFixtureConnection());

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "x-correlation-id": `quote-v2-e2e-${randomUUID()}` },
    body: JSON.stringify(body),
  });
}

function draftReceipt(input: {
  quoteRevision: number;
  draftRevision: number;
  totals?: boolean;
}) {
  return {
    ok: true,
    data: {
      quoteId: COMPOSER_QUOTE_ID,
      versionId: COMPOSER_VERSION_ID,
      quoteRevision: input.quoteRevision,
      draftRevision: input.draftRevision,
      totals: input.totals
        ? {
            subtotalMinCents: 125_000,
            subtotalMaxCents: 125_000,
            discountMinCents: 0,
            discountMaxCents: 0,
            feeMinCents: 0,
            feeMaxCents: 0,
            totalMinCents: 125_000,
            totalMaxCents: 125_000,
            depositCents: 0,
            balanceMinCents: 125_000,
            balanceMaxCents: 125_000,
          }
        : null,
    },
  };
}

async function mockComposerDomain(page: Page) {
  let quoteRevision = 1;
  let draftRevision = 1;
  const observed: Array<{ method: string; pathname: string; body: unknown }> =
    [];

  await page.route("**/api/team/contacts?*", (route) =>
    json(route, {
      contacts: [
        {
          id: CONTACT_ID,
          name: "Avery Facilities",
          companyName: "Northstar Commerce",
          title: "Facilities Manager",
          email: "avery.composer@mystos.test",
          phoneE164: "+14045550177",
          properties: [
            {
              id: PROPERTY_ID,
              label: "200 Service Way, Atlanta, GA 30302",
              billingLabel: "100 Billing Plaza, Atlanta, GA 30303",
            },
          ],
        },
      ],
    }),
  );
  await page.route("**/api/team/quotes/v2/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    let body: unknown = null;
    if (request.postData()) {
      try {
        body = request.postDataJSON();
      } catch {
        body = request.postData();
      }
    }
    observed.push({ method: request.method(), pathname: url.pathname, body });

    if (
      request.method() === "GET" &&
      url.pathname.endsWith(`/${COMPOSER_VERSION_ID}/attachments`)
    ) {
      return json(route, { ok: true, attachments: [] });
    }
    if (request.method() === "POST" && url.pathname.endsWith("/quotes")) {
      return json(route, draftReceipt({ quoteRevision, draftRevision }), 201);
    }
    if (request.method() === "PATCH" && url.pathname.endsWith("/draft")) {
      draftRevision =
        Number(request.headers()["if-match"] ?? draftRevision) + 1;
      quoteRevision += 1;
      return json(
        route,
        draftReceipt({ quoteRevision, draftRevision, totals: true }),
      );
    }
    if (request.method() === "POST" && url.pathname.endsWith("/finalize")) {
      quoteRevision += 1;
      return json(
        route,
        draftReceipt({ quoteRevision, draftRevision, totals: true }),
      );
    }
    if (request.method() === "POST" && url.pathname.endsWith("/issue")) {
      return json(route, {
        ok: true,
        data: {
          quoteId: COMPOSER_QUOTE_ID,
          versionId: COMPOSER_VERSION_ID,
          quoteNumber: "Q-E2E-COMPOSER",
          sendAttemptId: "e2e-send-attempt",
          overallState: "requested",
        },
      });
    }
    return json(
      route,
      {
        ok: false,
        code: "not_found",
        message: `Unexpected Quote V2 E2E route: ${request.method()} ${url.pathname}`,
        retryable: false,
        correlationId: randomUUID(),
      },
      404,
    );
  });
  return observed;
}

function availabilityPath(token: string): string {
  return `**/api/public/quotes/${token}/availability`;
}

const SCHEDULE_START_MEANING =
  "The selected time is the scheduled service start in the timezone shown. Stonegate will confirm any separate arrival window in the booking confirmation.";

function availabilityBody(input: {
  fixture: QuoteV2E2EFixture;
  state: "available" | "empty";
  slots: Array<{ startAt: string; endAt: string; label: string }>;
}) {
  return {
    availability: {
      state: input.state,
      quoteId: input.fixture.quoteId,
      versionId: input.fixture.versionId,
      responseId: null,
      timezone: "America/New_York",
      durationMinutes: 120,
      travelBufferMinutes: 30,
      arrivalWindowMeaning: SCHEDULE_START_MEANING,
      recommendedSlots: input.slots.slice(0, 3),
      days: [{ date: "2026-09-08", slots: input.slots }],
      generatedAt: "2026-08-31T16:00:00.000Z",
    },
  };
}

test.describe("Quote V2 release journeys", () => {
  test("staff completes all four composer sections, issues once, and reaches management", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.addInitScript(() => globalThis.localStorage.clear());
    const observed = await mockComposerDomain(page);

    await page.goto("/team/quotes/create", { waitUntil: "domcontentloaded" });
    await expect(page).not.toHaveURL(/\/team\/login/u);
    await expect(
      page.getByRole("heading", { name: "Create professional quote" }),
    ).toBeVisible();

    await page.getByRole("radio", { name: /commercial/i }).check();
    await page.getByLabel("Search clients").fill("Northstar");
    await page
      .getByRole("button", {
        name: /Northstar Commerce · Avery Facilities/i,
      })
      .click();
    await page.getByLabel("Service property").selectOption(PROPERTY_ID);
    await page.getByLabel("Service zone").selectOption("zone-core");
    await page
      .getByRole("checkbox", { name: /I confirmed this zone/i })
      .check();
    await page.getByLabel("Project name").fill("North warehouse cleanout");
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(
      page.getByRole("heading", { name: "Items and scope" }),
    ).toBeFocused();
    const item = page.getByRole("group", { name: "Item 1" });
    await item.getByLabel("Name").fill("Commercial cleanout");
    await item.getByLabel("Quantity").fill("1");
    await item
      .getByRole("textbox", { name: "Unit", exact: true })
      .fill("project");
    await item.getByLabel("Unit price", { exact: true }).fill("1250.00");
    await page
      .getByLabel("Customer-facing scope")
      .fill("Remove the listed material and sweep the service area.");
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(
      page.getByRole("heading", { name: "Terms and fulfillment" }),
    ).toBeFocused();
    await expect(page.getByLabel("Proposal type")).toHaveValue("fixed_quote");
    await expect(page.getByLabel("Valid for (days)")).toHaveValue("30");
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(
      page.getByRole("heading", { name: "Review and send" }),
    ).toBeFocused();
    await expect(
      page.getByText("Northstar Commerce", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("$1,250.00", { exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByText("Server draft saved", { exact: true }),
    ).toBeVisible({
      timeout: 15_000,
    });
    const issue = page.getByRole("button", { name: "Freeze version and send" });
    await expect(issue).toBeEnabled();
    await issue.click();

    await expect(
      page.getByRole("heading", { name: "Q-E2E-COMPOSER" }),
    ).toBeVisible();
    expect(
      observed.filter(
        (entry) => entry.method === "POST" && entry.pathname.endsWith("/issue"),
      ),
    ).toHaveLength(1);
    const issueRequest = observed.find((entry) =>
      entry.pathname.endsWith("/issue"),
    );
    expect(issueRequest?.body).toMatchObject({
      confirmation: "issue_quote_version",
      quoteRevision: expect.any(Number),
      sendNow: true,
      recipients: [
        {
          role: "signer",
          name: "Avery Facilities",
          email: "avery.composer@mystos.test",
          channels: ["email"],
        },
      ],
    });

    await page.getByRole("link", { name: "Open quote management" }).click();
    await expect(page).toHaveURL(/\/team\/quotes\/manage/u);
    await expect(
      page.getByRole("heading", { name: "Manage quotes" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Needs action" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Awaiting client" }),
    ).toBeVisible();
  });

  test("public proposal renders an available calendar with three deterministic recommendations", async ({
    page,
  }) => {
    const fixture = await createQuoteV2E2EFixture();
    const slots = [
      ["2026-09-08T13:00:00.000Z", "Tue, Sep 8 · 9:00 AM"],
      ["2026-09-08T16:00:00.000Z", "Tue, Sep 8 · 12:00 PM"],
      ["2026-09-09T14:00:00.000Z", "Wed, Sep 9 · 10:00 AM"],
    ].map(([startAt, label]) => ({
      startAt,
      endAt: new Date(
        new Date(startAt).getTime() + 2 * 60 * 60_000,
      ).toISOString(),
      label,
    }));
    await page.route(availabilityPath(fixture.token), (route) =>
      json(route, availabilityBody({ fixture, state: "available", slots })),
    );

    await page.goto(fixture.publicPath, { waitUntil: "domcontentloaded" });
    await page
      .getByRole("button", { name: "Approve & continue" })
      .first()
      .click();
    const state = page.locator('[data-availability-state="available"]');
    await expect(state).toBeVisible();
    await expect(state.getByRole("radio")).toHaveCount(3);
    await expect(state).toContainText("America/New_York");
    await expect(state).toContainText("scheduled service start");
    await expect(state).toContainText("separate arrival window");
    await expect(state).toContainText("Selecting one does not book it yet");
  });

  test("public proposal distinguishes confirmed empty capacity from provider failure", async ({
    page,
  }) => {
    const fixture = await createQuoteV2E2EFixture();
    await page.route(availabilityPath(fixture.token), (route) =>
      json(route, availabilityBody({ fixture, state: "empty", slots: [] })),
    );

    await page.goto(fixture.publicPath, { waitUntil: "domcontentloaded" });
    await page
      .getByRole("button", { name: "Approve & continue" })
      .first()
      .click();
    const empty = page.locator('[data-availability-state="empty"]');
    await expect(empty).toBeVisible();
    await expect(empty).toContainText("no online windows are open");
    await expect(
      page.getByRole("radio", {
        name: /Approve and have the team contact me/i,
      }),
    ).toBeVisible();
    await expect(
      page.locator('[data-availability-state="unavailable"]'),
    ).toHaveCount(0);
  });

  test("public proposal labels provider errors as unavailable without claiming the calendar is full", async ({
    page,
  }) => {
    const fixture = await createQuoteV2E2EFixture();
    await page.route(availabilityPath(fixture.token), (route) =>
      json(
        route,
        {
          ok: false,
          code: "provider_unavailable",
          message: "Calendar provider unavailable",
          retryable: true,
          correlationId: randomUUID(),
        },
        503,
      ),
    );

    await page.goto(fixture.publicPath, { waitUntil: "domcontentloaded" });
    await page
      .getByRole("button", { name: "Approve & continue" })
      .first()
      .click();
    const unavailable = page.locator('[data-availability-state="unavailable"]');
    await expect(unavailable).toBeVisible();
    await expect(unavailable).toContainText(
      "does not mean appointment windows are full",
    );
    await expect(
      unavailable.getByRole("button", { name: "Retry availability" }),
    ).toBeVisible();
    await expect(page.locator('[data-availability-state="empty"]')).toHaveCount(
      0,
    );
    await expect(page.getByText("no online windows are open")).toHaveCount(0);
  });

  test("expired proposal keeps an update note after a retryable failure", async ({
    page,
  }) => {
    const fixture = await createQuoteV2E2EFixture({
      schedulingMode: "staff_followup",
      issuedAt: new Date("2025-01-15T15:00:00.000Z"),
      expiresAt: new Date("2025-02-14T15:00:00.000Z"),
    });
    await page.route(`**/api/public/quotes/${fixture.token}/refresh`, (route) =>
      json(
        route,
        {
          ok: false,
          code: "provider_unavailable",
          message: "Update request service is temporarily unavailable.",
          retryable: true,
          correlationId: "quote-v2-expired-refresh-retry",
        },
        503,
      ),
    );

    await page.goto(fixture.publicPath, { waitUntil: "domcontentloaded" });
    const requestUpdate = page
      .getByRole("button", { name: "Request updated proposal" })
      .first();
    await expect(requestUpdate).toBeVisible();
    await requestUpdate.click();
    await expect(
      page.getByRole("heading", { name: "Request an updated proposal" }),
    ).toBeVisible();
    const note = page.getByLabel("Note for the team (optional)");
    await note.fill("Please reflect the revised September access schedule.");
    await page.getByRole("button", { name: "Confirm update request" }).click();
    await expect(
      page.getByRole("alert").filter({
        hasText: "Update request service is temporarily unavailable.",
      }),
    ).toBeVisible();
    await expect(note).toHaveValue(
      "Please reflect the revised September access schedule.",
    );
  });

  test("booked proposal reloads the exact appointment confirmation", async ({
    page,
  }) => {
    const fixture = await createQuoteV2E2EFixture({
      schedulingMode: "staff_followup",
    });
    await bookQuoteV2E2EFixture(fixture);

    const assertBooking = async () => {
      await expect(page.getByText("Booked", { exact: true })).toBeVisible();
      const summaries = page.locator('[data-appointment-status="confirmed"]');
      await expect(summaries).toHaveCount(1);
      await expect(
        summaries.first().getByRole("heading", {
          name: "Appointment confirmed",
        }),
      ).toBeVisible();
      await expect(summaries.first()).not.toContainText(
        "Promised arrival window",
      );
      await expect(summaries.first()).toContainText(
        "Scheduled start and duration",
      );
      await expect(summaries.first()).toContainText("America/New_York");
      await expect(summaries.first()).toContainText("4 hours");
      await expect(summaries.first()).toContainText(
        "not a separate arrival window",
      );
      await expect(
        summaries.first().locator('time[datetime="2030-02-01T14:00:00.000Z"]'),
      ).toHaveCount(1);
      await expect(
        summaries.first().locator('time[datetime="2030-02-01T18:00:00.000Z"]'),
      ).toHaveCount(1);
      await expect(page.locator("body")).not.toContainText(
        "schedulingTimezone",
      );
    };

    await page.goto(fixture.publicPath, { waitUntil: "domcontentloaded" });
    await assertBooking();
    await page.reload({ waitUntil: "domcontentloaded" });
    await assertBooking();
  });

  test("a retained superseded link does not inherit a later revision booking", async ({
    page,
  }) => {
    const firstVersion = await createQuoteV2E2EFixture({
      schedulingMode: "staff_followup",
    });
    const acceptedVersion = await issueQuoteV2E2EFixtureRevision(firstVersion);
    await bookQuoteV2E2EFixture(acceptedVersion);

    await page.goto(firstVersion.publicPath, {
      waitUntil: "domcontentloaded",
    });
    await expect(
      page.getByText("Superseded · View only", { exact: true }),
    ).toBeVisible();
    await expect(page.locator("[data-appointment-status]")).toHaveCount(0);
    await expect(page.getByText("Booked", { exact: true })).toHaveCount(0);

    await page.goto(acceptedVersion.publicPath, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByText("Booked", { exact: true })).toBeVisible();
    await expect(
      page.locator('[data-appointment-status="confirmed"]'),
    ).toHaveCount(1);
  });

  test("a proposal superseded after page load rejects every version-bound mutation", async ({
    page,
  }) => {
    const fixture = await createQuoteV2E2EFixture({
      schedulingMode: "staff_followup",
    });
    await page.goto(fixture.publicPath, { waitUntil: "domcontentloaded" });
    await expect(
      page.getByText(fixture.quoteNumber, { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Request changes" }).first().click();
    const changeDetails = page.getByRole("textbox", {
      name: "Details",
      exact: true,
    });
    await changeDetails.fill(
      "Please revise the loading-access assumption before approval.",
    );

    await supersedeQuoteV2E2EFixture(fixture);
    const responsePromise = page.waitForResponse(
      (response) =>
        response
          .url()
          .includes(`/api/public/quotes/${fixture.token}/changes`) &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Send change request" }).click();
    const response = await responsePromise;
    expect(response.status()).toBe(409);
    await expect(
      page.getByRole("alert").filter({
        hasText: "This proposal is no longer open for that action.",
      }),
    ).toBeVisible();
    await expect(changeDetails).toHaveValue(
      "Please revise the loading-access assumption before approval.",
    );

    const staleResults = await page.evaluate(
      async ({ token, quoteId, versionId }) => {
        const post = async (
          action: string,
          path: string,
          body: Record<string, unknown>,
        ) => {
          const mutation = await fetch(
            `/api/public/quotes/${encodeURIComponent(token)}${path}`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "idempotency-key": `quote-v2-stale-${crypto.randomUUID()}`,
              },
              body: JSON.stringify(body),
            },
          );
          const payload = (await mutation.json()) as { code?: unknown };
          return { action, status: mutation.status, code: payload.code };
        };
        const responseId = crypto.randomUUID();
        return Promise.all([
          post("accept", "", {
            decision: "accepted",
            quoteId,
            versionId,
            selectedOptionIds: [],
            signer: {
              name: "Avery Facilities",
              title: "Facilities Manager",
              company: "Northstar Commerce",
              authorityAffirmed: true,
            },
            consentVersion: "fixed_quote-consent-v1",
            consentAffirmed: true,
          }),
          post("decline", "", {
            decision: "declined",
            quoteId,
            versionId,
            category: "other",
            notes: "Superseded-version E2E probe",
            signerName: "Avery Facilities",
          }),
          post("hold", "/hold", {
            quoteId,
            versionId,
            responseId: null,
            startAt: "2026-09-08T13:00:00.000Z",
            timezone: "America/New_York",
          }),
          post("checkout", "/checkout", {
            quoteId,
            versionId,
            responseId,
            holdId: null,
          }),
          post("book", "/book", {
            quoteId,
            versionId,
            responseId,
            holdId: null,
          }),
        ]);
      },
      {
        token: fixture.token,
        quoteId: fixture.quoteId,
        versionId: fixture.versionId,
      },
    );
    expect(staleResults).toEqual(
      ["accept", "decline", "hold", "checkout", "book"].map((action) => ({
        action,
        status: 409,
        code: "conflict",
      })),
    );
  });
});
