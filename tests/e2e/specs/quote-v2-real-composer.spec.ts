import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { APIRequestContext, BrowserContext } from "@playwright/test";
import postgres from "postgres";
import { expect, test } from "../test";
import { getEnvVar } from "../support/env";
import {
  bootstrapTeamStorage,
  closeTeamAuthStorage,
} from "../support/team-auth";

type SqlClient = ReturnType<typeof postgres>;

type PersistedQuote = {
  id: string;
  current_version_id: string;
  published_version_id: string | null;
  quote_number: string;
  aggregate_state: string;
  aggregate_revision: number;
  version_count: number;
  version_state: string;
};

function sqlClient(): SqlClient {
  const connectionString = getEnvVar("DATABASE_URL");
  const useSsl =
    process.env["DATABASE_SSL"] === "true" ||
    /render\.com|sslmode=require/u.test(connectionString);
  return postgres(connectionString, {
    prepare: false,
    max: 2,
    idle_timeout: 20,
    ...(useSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  });
}

async function loadFixtureQuotes(
  sql: SqlClient,
  contactId: string,
): Promise<PersistedQuote[]> {
  return sql<PersistedQuote[]>`
    SELECT
      quote.id,
      quote.current_version_id,
      quote.published_version_id,
      quote.quote_number,
      quote.aggregate_state,
      quote.aggregate_revision,
      (
        SELECT count(*)::int
        FROM quote_versions AS counted_version
        WHERE counted_version.quote_id = quote.id
      ) AS version_count,
      current_version.state AS version_state
    FROM quotes AS quote
    JOIN quote_versions AS current_version
      ON current_version.id = quote.current_version_id
     AND current_version.quote_id = quote.id
    WHERE quote.contact_id = ${contactId}
      AND quote.engine_version = 'v2'
    ORDER BY quote.created_at ASC
  `;
}

async function mutateQuoteLifecycle(input: {
  request: APIRequestContext;
  siteBase: string;
  quoteId: string;
  versionId: string;
  quoteRevision: number;
  action: "void" | "archive";
}): Promise<number> {
  const response = await input.request.post(
    new URL(
      `/api/team/quotes/v2/quotes/${encodeURIComponent(input.quoteId)}/${input.action}`,
      input.siteBase,
    ).toString(),
    {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "Idempotency-Key": `quote-v2:e2e-cleanup:${input.action}:${randomUUID()}`,
        "If-Match": String(input.quoteRevision),
        Origin: new URL(input.siteBase).origin,
        Referer: new URL("/team/quotes/manage", input.siteBase).toString(),
        "x-correlation-id": `quote-v2-e2e-cleanup-${randomUUID()}`,
      },
      data: {
        confirmation: `${input.action}_quote_v2`,
        versionId: input.versionId,
        quoteRevision: input.quoteRevision,
        reason: "Retire isolated Quote V2 real-composer fixture.",
        notifyCustomer: false,
      },
    },
  );
  const payload = (await response.json().catch(() => null)) as {
    data?: { quoteRevision?: unknown };
    message?: unknown;
  } | null;
  const nextRevision = payload?.data?.quoteRevision;
  if (
    !response.ok() ||
    !Number.isSafeInteger(nextRevision) ||
    Number(nextRevision) <= input.quoteRevision
  ) {
    throw new Error(
      `Quote fixture ${input.action} failed (${response.status()}): ${
        typeof payload?.message === "string"
          ? payload.message
          : await response.text().catch(() => "unreadable response")
      }`,
    );
  }
  return Number(nextRevision);
}

async function retireFixture(input: {
  sql: SqlClient;
  context: BrowserContext | null;
  siteBase: string;
  contactId: string;
  actorEmail: string;
  retainedActorName: string;
  storagePath: string;
}): Promise<void> {
  const failures: unknown[] = [];
  try {
    if (input.context) {
      const quotes = await loadFixtureQuotes(input.sql, input.contactId);
      for (const quote of quotes) {
        let revision = quote.aggregate_revision;
        let state = quote.aggregate_state;
        if (state === "open") {
          revision = await mutateQuoteLifecycle({
            request: input.context.request,
            siteBase: input.siteBase,
            quoteId: quote.id,
            versionId: quote.current_version_id,
            quoteRevision: revision,
            action: "void",
          });
          state = "voided";
        }
        if (["draft", "declined", "voided"].includes(state)) {
          await mutateQuoteLifecycle({
            request: input.context.request,
            siteBase: input.siteBase,
            quoteId: quote.id,
            versionId: quote.current_version_id,
            quoteRevision: revision,
            action: "archive",
          });
        }
      }
    }
  } catch (error) {
    failures.push(error);
  }

  try {
    const retiredAt = new Date();
    await input.sql.begin(async (transaction) => {
      await transaction`
        SELECT pg_advisory_xact_lock(hashtextextended(${input.contactId}, 0))
      `;
      await transaction`
        UPDATE quote_capabilities AS capability
        SET status = 'revoked',
            revoked_at = coalesce(capability.revoked_at, ${retiredAt}),
            revoked_by_team_member_id = NULL,
            revocation_reason = coalesce(
              nullif(capability.revocation_reason, ''),
              'contact_inactive'
            ),
            updated_at = ${retiredAt}
        WHERE capability.status <> 'revoked'
          AND EXISTS (
            SELECT 1
            FROM quotes AS fixture_quote
            WHERE fixture_quote.id = capability.quote_id
              AND fixture_quote.contact_id = ${input.contactId}
          )
      `;
      await transaction`
        UPDATE contacts
        SET first_name = 'Retired',
            last_name = 'Quote fixture',
            company = NULL,
            email = NULL,
            phone = NULL,
            phone_e164 = NULL,
            deleted_at = coalesce(deleted_at, ${retiredAt}),
            deleted_by = NULL,
            purge_eligible_at = coalesce(
              purge_eligible_at,
              ${retiredAt} + interval '30 days'
            ),
            updated_at = ${retiredAt}
        WHERE id = ${input.contactId}
      `;
      await transaction`
        DELETE FROM team_sessions
        WHERE team_member_id IN (
          SELECT id
          FROM team_members
          WHERE lower(email) = ${input.actorEmail}
             OR name = ${input.retainedActorName}
        )
      `;
      await transaction`
        UPDATE team_members
        SET name = ${input.retainedActorName},
            email = NULL,
            email_normalized = NULL,
            email_identity_status = 'none',
            role_id = NULL,
            active = false,
            phone_e164 = NULL,
            password_hash = NULL,
            password_set_at = NULL,
            permissions_grant = ARRAY[]::text[],
            permissions_deny = ARRAY[]::text[],
            updated_at = ${retiredAt}
        WHERE lower(email) = ${input.actorEmail}
           OR name = ${input.retainedActorName}
      `;
    });
  } catch (error) {
    failures.push(error);
  }

  await input.context?.close().catch((error: unknown) => failures.push(error));
  await closeTeamAuthStorage().catch((error: unknown) => failures.push(error));
  await input.sql
    .end({ timeout: 5 })
    .catch((error: unknown) => failures.push(error));
  await fs
    .rm(input.storagePath, { force: true })
    .catch((error: unknown) => failures.push(error));

  if (failures.length > 0) {
    const details = failures
      .map((failure) =>
        failure instanceof Error ? failure.message : String(failure),
      )
      .join(" | ");
    throw new Error(`Quote V2 fixture cleanup failed: ${details}`);
  }
}

test.describe("Quote V2 real composer", () => {
  test("creates, autosaves, finalizes, issues, and manages exactly one immutable version", async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const runId = randomUUID();
    const contactId = randomUUID();
    const propertyId = randomUUID();
    const actorEmail = `quote-v2-real-${runId}@mystos.test`;
    const retainedActorName = `Retired Quote V2 E2E ${runId}`;
    const storagePath = path.resolve(
      process.cwd(),
      `artifacts/e2e/quote-v2-real-composer/${runId}-office.json`,
    );
    const siteBase = getEnvVar("NEXT_PUBLIC_SITE_URL", "http://localhost:3000");
    const sql = sqlClient();
    const company = `Atlas Facilities ${runId.slice(0, 8)}`;
    const project = `Real composer warehouse ${runId.slice(0, 8)}`;
    const email = `quote-v2-client-${runId}@mystos.test`;
    const phoneSuffix = String(
      Number.parseInt(runId.replaceAll("-", "").slice(0, 8), 16) % 10_000,
    ).padStart(4, "0");
    let context: BrowserContext | null = null;

    try {
      await sql.begin(async (transaction) => {
        await transaction`
          INSERT INTO contacts (
            id, first_name, last_name, company, email, phone, phone_e164,
            preferred_contact_method, source
          ) VALUES (
            ${contactId}, 'Morgan', 'Facilities', ${company}, ${email},
            ${`404555${phoneSuffix}`}, ${`+1404555${phoneSuffix}`},
            'email', 'playwright_quote_v2_real_composer'
          )
        `;
        await transaction`
          INSERT INTO properties (
            id, contact_id, address_key, address_line1, city, state, postal_code
          ) VALUES (
            ${propertyId}, ${contactId}, ${`quote-v2-real:${propertyId}`},
            '4100 Verification Way', 'Atlanta', 'GA', '30303'
          )
        `;
      });
      await bootstrapTeamStorage({
        filename: storagePath,
        name: `Quote V2 E2E Office ${runId.slice(0, 8)}`,
        email: actorEmail,
        role: "office",
        sessionExpiresInMinutes: 60,
        siteBase,
      });

      context = await browser.newContext({
        storageState: storagePath,
        serviceWorkers: "block",
      });
      const page = await context.newPage();
      await page.addInitScript(() => globalThis.localStorage.clear());
      const quoteMutations: Array<{ method: string; pathname: string }> = [];
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (
          request.method() !== "GET" &&
          url.pathname.startsWith("/api/team/quotes/v2/") &&
          (url.pathname.includes("/quotes") ||
            url.pathname.includes("/quote-versions"))
        ) {
          quoteMutations.push({
            method: request.method(),
            pathname: url.pathname,
          });
        }
      });

      await page.goto("/team/quotes/create", {
        waitUntil: "domcontentloaded",
      });
      await expect(page).not.toHaveURL(/\/team\/login/u);
      await expect(
        page.getByRole("heading", { name: "Create professional quote" }),
      ).toBeVisible();

      await page.getByRole("radio", { name: /commercial/iu }).check();
      await page.getByLabel("Search clients").fill(company);
      await page
        .getByRole("button", {
          name: `${company} · Morgan Facilities`,
        })
        .click();
      await page.getByLabel("Service property").selectOption(propertyId);
      await page.getByLabel("Service zone").selectOption("zone-core");
      await page
        .getByRole("checkbox", { name: /I confirmed this zone/iu })
        .check();
      await page.getByLabel("Project name").fill(project);
      await page.getByRole("button", { name: "Continue" }).click();

      await expect(
        page.getByRole("heading", { name: "Items and scope" }),
      ).toBeFocused();
      const item = page.getByRole("group", { name: "Item 1" });
      await item.getByLabel("Name").fill("Commercial cleanout verification");
      await item.getByLabel("Quantity").fill("1");
      await item
        .getByRole("textbox", { name: "Unit", exact: true })
        .fill("project");
      await item.getByLabel("Unit price", { exact: true }).fill("1250.00");
      await page
        .getByLabel("Customer-facing scope")
        .fill(
          "Remove the listed warehouse material and sweep the service area.",
        );
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
      await expect(page.getByText(company, { exact: true })).toBeVisible();
      await expect(
        page.getByText("$1,250.00", { exact: true }).first(),
      ).toBeVisible();
      await expect(
        page.getByText("Server draft saved", { exact: true }),
      ).toBeVisible({ timeout: 20_000 });
      const issue = page.getByRole("button", {
        name: "Freeze version and send",
      });
      await expect(issue).toBeEnabled();
      await issue.click();

      await expect(
        page.getByText("Proposal issued", { exact: true }),
      ).toBeVisible({ timeout: 30_000 });
      const persisted = await loadFixtureQuotes(sql, contactId);
      expect(persisted).toHaveLength(1);
      expect(persisted[0]).toMatchObject({
        aggregate_state: "open",
        version_count: 1,
        version_state: "issued",
      });
      expect(persisted[0]?.current_version_id).toBe(
        persisted[0]?.published_version_id,
      );
      await expect(
        page.getByRole("heading", { name: persisted[0]!.quote_number }),
      ).toBeVisible();

      expect(
        quoteMutations.filter(
          (request) =>
            request.method === "POST" &&
            request.pathname === "/api/team/quotes/v2/quotes",
        ),
      ).toHaveLength(1);
      expect(
        quoteMutations.filter(
          (request) =>
            request.method === "PATCH" && request.pathname.endsWith("/draft"),
        ).length,
      ).toBeGreaterThanOrEqual(1);
      expect(
        quoteMutations.filter(
          (request) =>
            request.method === "POST" && request.pathname.endsWith("/finalize"),
        ),
      ).toHaveLength(1);
      expect(
        quoteMutations.filter(
          (request) =>
            request.method === "POST" && request.pathname.endsWith("/issue"),
        ),
      ).toHaveLength(1);

      await page.getByRole("link", { name: "Open quote management" }).click();
      await expect(page).toHaveURL(/\/team\/quotes\/manage/u);
      await expect(
        page.getByRole("heading", { name: "Manage quotes" }),
      ).toBeVisible();
      await page
        .getByLabel(
          "Search quote number, client, company, project, property, or PO",
        )
        .fill(persisted[0]!.quote_number);
      await page.getByRole("button", { name: "Search", exact: true }).click();
      const quoteList = page.getByRole("list", { name: "Quotes" });
      await expect(quoteList).toContainText(persisted[0]!.quote_number);
      await expect(quoteList).toContainText(project);
      await expect(quoteList).toContainText(company);
      await expect(quoteList.locator(":scope > li")).toHaveCount(1);
    } finally {
      await retireFixture({
        sql,
        context,
        siteBase,
        contactId,
        actorEmail,
        retainedActorName,
        storagePath,
      });
    }
  });
});
