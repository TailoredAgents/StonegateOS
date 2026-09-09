import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium, webkit, expect, type BrowserType } from "@playwright/test";

// Local browser/component checks. Every import response is synthetic and no
// CRM, account, database, email, or SMS service is contacted.
const repo = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/u, "");
const require = createRequire(`${repo}/package.json`);
const { build } = createRequire(require.resolve("tsx"))("esbuild");
const hash = "a".repeat(64);
const counts = {
  total: 53,
  accepted: 51,
  create: 51,
  update: 0,
  unchanged: 1,
  invalid: 0,
  duplicate: 1,
  conflict: 0,
};
const exclusionReport = {
  rowCount: 1,
  truncated: false,
  filename: "skipped-rows.csv",
  csv: '"row_number","status","reason"\r\n"53","duplicate","Repeated email"\r\n',
};
const preview = {
  kind: "outbound_import_preview",
  requestHash: hash,
  previewHash: hash,
  campaign: "property_management",
  assignee: { id: "member-a", name: "Alex Owner" },
  byteLength: 128,
  ignoredHeaders: [],
  counts,
  confirmationPhrase: "IMPORT 51",
  exclusionReport,
  rows: Array.from({ length: 53 }, (_, index) => ({
    rowNumber: index + 2,
    status: index === 51 ? "duplicate" : index === 52 ? "unchanged" : "create",
    reason: index === 51 ? "Repeated email" : null,
    duplicateOfRow: index === 51 ? 2 : null,
    existingContactId: null,
    company: "Example company",
    contactName: `Person ${index + 1}`,
    email: `person${index}@example.test`,
    phone: null,
    plannedChanges: index < 51 ? ["contact.create", "task.create"] : [],
  })),
};
const success = {
  ok: true,
  data: {
    ...preview,
    kind: "outbound_import_result",
    counts: {
      ...counts,
      rowsUpdated: 0,
      contactsCreated: 51,
      contactsModified: 0,
      partnerAccountsResolved: 0,
      partnerLinksCreated: 0,
      contactNotesCreated: 0,
      tasksCreated: 51,
      pipelineRowsCreated: 51,
    },
  },
  receipt: {
    operationId: "operation-a",
    correlationId: "correlation-a",
    actorId: "actor-a",
    committedAt: "2026-09-09T12:00:00.000Z",
    auditEventId: "audit-a",
    entityType: "outbound_import",
    entityId: hash,
    version: hash,
  },
};

async function harness(engine: BrowserType) {
  const bundle = await build({
    stdin: {
      contents: `import React from'react';import{createRoot}from'react-dom/client';import{OutboundImportClient}from'./src/app/team/components/OutboundImportClient';createRoot(document.getElementById('root')).render(<main><h1>Add contacts</h1><OutboundImportClient members={[{id:'member-a',name:'Alex Owner'}]} defaultMemberId='member-a' directoryUnavailable={false}/></main>);`,
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
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "error",
  });
  const controls = {
    previewStatus: 200,
    executeStatus: 200,
    requests: [] as {
      mode: string;
      key: string | undefined;
      csv: string;
      file: boolean;
    }[],
  };
  const server = createServer(async (request, response) => {
    if (request.url === "/client.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end(bundle.outputFiles[0].contents);
      return;
    }
    if (request.url === "/api/team/outbound/import") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const data = await new Response(Buffer.concat(chunks), {
        headers: { "content-type": request.headers["content-type"]! },
      }).formData();
      const mode = String(data.get("mode"));
      controls.requests.push({
        mode,
        key: request.headers["idempotency-key"] as string | undefined,
        csv: String(data.get("csv") ?? ""),
        file: data.has("file"),
      });
      const status =
        mode === "preview" ? controls.previewStatus : controls.executeStatus;
      response.statusCode = status;
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify(
          status !== 200
            ? {
                ok: false,
                message:
                  status === 409
                    ? "CRM changed; preview again."
                    : "Synthetic unavailable response",
                fieldErrors:
                  status === 422
                    ? { campaign: "Choose a valid campaign." }
                    : undefined,
              }
            : mode === "preview"
              ? { ok: true, preview }
              : success,
        ),
      );
      return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end(
      '<!doctype html><html lang="en"><head><title>Local import test</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script src="/client.js"></script></body></html>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const browser = await engine.launch();
  const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
  await page.goto(`http://127.0.0.1:${address.port}`);
  const upload = async () => {
    await page.getByLabel("Choose a CSV file").setInputFiles({
      name: "contacts.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("company,email\r\nExample,person@example.test\r\n"),
    });
    await page
      .getByRole("button", { name: "Preview import", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Review before importing" }),
    ).toBeVisible();
  };
  return {
    page,
    controls,
    upload,
    close: async () => {
      await browser.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

for (const engine of [chromium, webkit]) {
  test(`${engine.name()}: upload, keyboard review, row filters, confirmation and receipt`, async () => {
    const h = await harness(engine);
    try {
      assert.equal(
        await h.page
          .getByRole("textbox", { name: "Paste CSV with a header row" })
          .isVisible(),
        false,
      );
      const [download] = await Promise.all([
        h.page.waitForEvent("download"),
        h.page.getByRole("button", { name: "Download CSV template" }).click(),
      ]);
      assert.equal(
        download.suggestedFilename(),
        "outbound-contacts-template.csv",
      );
      await h.upload();
      await expect(
        h.page.getByRole("heading", { name: "Review before importing" }),
      ).toBeFocused();
      assert.equal(h.controls.requests.length, 1);
      assert.equal(h.controls.requests[0].mode, "preview");
      assert.equal(h.controls.requests[0].file, true);
      await h.page.getByRole("button", { name: "Next rows" }).click();
      await expect(
        h.page.getByText("Page 2 of 2", { exact: true }),
      ).toBeVisible();
      await h.page.getByLabel("Show contacts").selectOption("excluded");
      await expect(
        h.page.getByText("Showing 1–1 of 1 matching rows."),
      ).toBeVisible();
      assert.equal(
        await h.page.getByRole("button", { name: "Next rows" }).count(),
        0,
      );
      await h.page.getByLabel("Show contacts").selectOption("accepted");
      await expect(
        h.page.getByText("Showing 1–50 of 51 matching rows."),
      ).toBeVisible();
      const confirmation = h.page.getByRole("textbox", {
        name: /Type IMPORT 51/,
      });
      await expect(
        h.page.getByRole("button", { name: "Import 51 accepted rows" }),
      ).toBeDisabled();
      await confirmation.fill("IMPORT 51");
      await confirmation.press("Enter");
      await expect(
        h.page.getByText("Contacts imported", { exact: true }),
      ).toBeVisible();
      assert.equal(
        h.controls.requests.filter((request) => request.mode === "execute")
          .length,
        1,
      );
      await expect(h.page.getByLabel("Choose a CSV file")).toBeDisabled();
      await h.page
        .getByRole("button", { name: "Start another import" })
        .click();
      await expect(h.page.getByLabel("Choose a CSV file")).toBeEnabled();
      await expect(
        h.page.getByRole("button", { name: "Preview import", exact: true }),
      ).toBeDisabled();
    } finally {
      await h.close();
    }
  });

  test(`${engine.name()}: size errors are local; pasted CSV replaces a selected file`, async () => {
    const h = await harness(engine);
    try {
      await h.page.getByLabel("Choose a CSV file").setInputFiles({
        name: "large.csv",
        mimeType: "text/csv",
        buffer: Buffer.alloc(2 * 1024 * 1024 + 1, 65),
      });
      await h.page
        .getByRole("button", { name: "Preview import", exact: true })
        .click();
      await expect(h.page.getByRole("alert")).toBeFocused();
      await expect(h.page.getByLabel("Choose a CSV file")).toHaveAttribute(
        "aria-invalid",
        "true",
      );
      assert.equal(h.controls.requests.length, 0);
      await h.page.getByText("Or paste CSV text", { exact: true }).focus();
      await h.page.keyboard.press("Enter");
      await h.page
        .getByRole("textbox", { name: "Paste CSV with a header row" })
        .fill("company,email\nExample,other@example.test");
      await h.page
        .getByRole("button", { name: "Preview import", exact: true })
        .click();
      await expect(
        h.page.getByRole("heading", { name: "Review before importing" }),
      ).toBeVisible();
      assert.equal(h.controls.requests[0].file, false);
      assert.match(h.controls.requests[0].csv, /other@example.test/);
    } finally {
      await h.close();
    }
  });

  test(`${engine.name()}: failed re-preview cannot leave an old import executable`, async () => {
    const h = await harness(engine);
    try {
      await h.upload();
      h.controls.previewStatus = 422;
      await h.page
        .getByRole("button", { name: "Preview import", exact: true })
        .click();
      await expect(h.page.getByRole("alert")).toBeVisible();
      assert.equal(
        await h.page
          .getByRole("button", { name: "Import 51 accepted rows" })
          .count(),
        0,
      );
      await expect(
        h.page.getByRole("textbox", { name: "Campaign name" }),
      ).toHaveAttribute("aria-invalid", "true");
      await h.page
        .getByRole("textbox", { name: "Campaign name" })
        .fill("new_campaign");
      await expect(
        h.page.getByRole("textbox", { name: "Campaign name" }),
      ).toHaveAttribute("aria-invalid", "false");
      assert.equal(
        h.controls.requests.filter((request) => request.mode === "execute")
          .length,
        0,
      );
    } finally {
      await h.close();
    }
  });

  test(`${engine.name()}: uncertain import locks original inputs and retries the same key`, async () => {
    const h = await harness(engine);
    try {
      await h.upload();
      h.controls.executeStatus = 503;
      await h.page
        .getByRole("textbox", { name: /Type IMPORT 51/ })
        .fill("IMPORT 51");
      await h.page
        .getByRole("button", { name: "Import 51 accepted rows" })
        .click();
      await expect(
        h.page.getByRole("button", { name: "Retry this same import safely" }),
      ).toBeVisible();
      await expect(h.page.getByLabel("Choose a CSV file")).toBeDisabled();
      await expect(
        h.page.getByRole("button", { name: "Preview import", exact: true }),
      ).toBeDisabled();
      // A later authentication failure cannot prove that the first request did
      // not commit. Keep the uncertain original locked until a real receipt.
      h.controls.executeStatus = 403;
      await h.page
        .getByRole("button", { name: "Retry this same import safely" })
        .click();
      await expect(
        h.page.getByRole("button", { name: "Retry this same import safely" }),
      ).toBeEnabled();
      await expect(h.page.getByLabel("Choose a CSV file")).toBeDisabled();
      h.controls.executeStatus = 200;
      await h.page
        .getByRole("button", { name: "Retry this same import safely" })
        .click();
      await expect(
        h.page.getByText("Contacts imported", { exact: true }),
      ).toBeVisible();
      const executions = h.controls.requests.filter(
        (request) => request.mode === "execute",
      );
      assert.equal(executions.length, 3);
      assert(executions[0].key);
      assert.equal(executions[1].key, executions[0].key);
      assert.equal(executions[2].key, executions[0].key);
    } finally {
      await h.close();
    }
  });

  test(`${engine.name()}: changed CRM data clears confirmation and allows a new review`, async () => {
    const h = await harness(engine);
    try {
      await h.upload();
      h.controls.executeStatus = 409;
      await h.page
        .getByRole("textbox", { name: /Type IMPORT 51/ })
        .fill("IMPORT 51");
      await h.page
        .getByRole("button", { name: "Import 51 accepted rows" })
        .click();
      await expect(h.page.getByRole("alert")).toBeVisible();
      assert.equal(
        await h.page
          .getByRole("button", { name: "Import 51 accepted rows" })
          .count(),
        0,
      );
      await expect(h.page.getByLabel("Choose a CSV file")).toBeEnabled();
      await h.page
        .getByRole("button", { name: "Preview import", exact: true })
        .click();
      await expect(
        h.page.getByRole("heading", { name: "Review before importing" }),
      ).toBeVisible();
      await expect(
        h.page.getByRole("textbox", { name: /Type IMPORT 51/ }),
      ).toHaveValue("");
    } finally {
      await h.close();
    }
  });
}
