import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium, expect, type Page } from "@playwright/test";

const repo = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/u, "");
const require = createRequire(`${repo}/package.json`);
const { build } = createRequire(require.resolve("tsx"))("esbuild");
const properties = [
  {
    id: "property-a",
    addressLine1: "123 Main Street",
    addressLine2: "Building A, Unit 101",
    city: "Atlanta",
    state: "GA",
    postalCode: "30301",
  },
  {
    id: "property-b",
    addressLine1: "123 Main Street",
    addressLine2: "Building B, Unit 204",
    city: "Atlanta",
    state: "GA",
    postalCode: "30301",
  },
];
const detectedAddress = {
  addressLine1: "456 Detected Avenue",
  city: "Decatur",
  state: "GA",
  postalCode: "30030",
};
const newAddress = {
  addressLine1: "789 New Street",
  addressLine2: "Building B, Unit 204",
  city: "Marietta",
  state: "GA",
  postalCode: "30060",
};
const addressFields = Object.keys(newAddress);
const contents = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {MobileBookingAddressFields} from './src/app/mobile/MobileBookingAddressFields';
const scenario = new URLSearchParams(location.search).get('scenario');
function App() {
  const [submission, setSubmission] = React.useState(null);
  return <form onSubmit={event => {
    event.preventDefault();
    setSubmission(Object.fromEntries(new FormData(event.currentTarget)));
  }}>
    <MobileBookingAddressFields
      properties={scenario === 'empty' || scenario === 'detected' ? [] : ${JSON.stringify(properties)}}
      detectedAddress={scenario === 'detected' ? ${JSON.stringify(detectedAddress)} : undefined}
    />
    <button type="submit">Book appointment</button>
    <output aria-label="Submitted booking">{submission && JSON.stringify(submission)}</output>
  </form>;
}
createRoot(document.getElementById('root')).render(<App/>);
`;

async function serializedForm(page: Page) {
  return page
    .locator("form")
    .evaluate((form: HTMLFormElement) =>
      Object.fromEntries(new FormData(form)),
    );
}

async function fillAddress(page: Page) {
  for (const [name, value] of Object.entries(newAddress)) {
    await page.locator(`input[name="${name}"]`).fill(value);
  }
}

void test("mobile booking preserves unit and building details for the selected address", async (t) => {
  const bundle = await build({
    stdin: { contents, resolveDir: `${repo}/apps/site`, loader: "tsx" },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const server = createServer((request, response) => {
    if (request.url === "/client.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end(bundle.outputFiles[0].contents);
    } else {
      response.setHeader("Content-Type", "text/html");
      response.end(
        '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Booking address</title></head><body><div id="root"></div><script src="/client.js"></script></body></html>',
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Missing test port");
  const base = `http://127.0.0.1:${address.port}/mobile`;
  const browser = await chromium.launch();
  t.after(() => browser.close());

  await t.test(
    "saved addresses show their units and exclude new-address inputs from submission",
    async () => {
      const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
      });
      try {
        await page.goto(base);
        const selector = page.locator('select[name="propertyId"]');
        await expect(selector).toHaveValue("property-a");
        for (const property of properties) {
          const option = selector.locator(`option[value="${property.id}"]`);
          for (const value of [
            property.addressLine1,
            property.addressLine2,
            property.city,
            property.state,
            property.postalCode,
          ]) {
            await expect(option).toContainText(value);
          }
        }
        for (const name of addressFields) {
          const field = page.locator(`input[name="${name}"]`);
          await expect(field).toBeHidden();
          await expect(field).toBeDisabled();
        }
        assert.deepEqual(await serializedForm(page), {
          propertyId: "property-a",
        });
        await page.getByRole("button", { name: "Book appointment" }).click();
        await expect(page.getByLabel("Submitted booking")).toHaveText(
          JSON.stringify({ propertyId: "property-a" }),
        );

        await selector.selectOption("");
        await expect(
          page.getByLabel("Unit / building", { exact: true }),
        ).toBeVisible();
        for (const name of addressFields) {
          const field = page.locator(`input[name="${name}"]`);
          await expect(field).toBeVisible();
          await expect(field).toBeEnabled();
          if (name !== "addressLine2") {
            await expect(field).toHaveAttribute("required", "");
          } else {
            await expect(field).not.toHaveAttribute("required", "");
          }
        }
        assert.equal(
          await page
            .locator("form")
            .evaluate((form: HTMLFormElement) => form.checkValidity()),
          false,
        );
        await fillAddress(page);
        assert.deepEqual(await serializedForm(page), {
          propertyId: "",
          ...newAddress,
        });

        await selector.selectOption("property-b");
        await expect(page.locator('input[name="addressLine2"]')).toBeHidden();
        assert.deepEqual(await serializedForm(page), {
          propertyId: "property-b",
        });
        await page.getByRole("button", { name: "Book appointment" }).click();
        await expect(page.getByLabel("Submitted booking")).toHaveText(
          JSON.stringify({ propertyId: "property-b" }),
        );

        await selector.selectOption("");
        for (const [name, value] of Object.entries(newAddress)) {
          await expect(page.locator(`input[name="${name}"]`)).toHaveValue(
            value,
          );
        }
        await page.getByRole("button", { name: "Book appointment" }).click();
        await expect(page.getByLabel("Submitted booking")).toHaveText(
          JSON.stringify({ propertyId: "", ...newAddress }),
        );
      } finally {
        await page.close();
      }
    },
  );

  await t.test(
    "contacts without saved properties submit a new address including the unit",
    async () => {
      const page = await browser.newPage();
      try {
        await page.goto(`${base}?scenario=empty`);
        await expect(page.locator('input[name="addressLine1"]')).toBeVisible();
        await expect(
          page.getByLabel("Unit / building", { exact: true }),
        ).toBeEnabled();
        await fillAddress(page);
        await page.getByRole("button", { name: "Book appointment" }).click();
        await expect(page.getByLabel("Submitted booking")).toHaveText(
          JSON.stringify({ propertyId: "", ...newAddress }),
        );
      } finally {
        await page.close();
      }
    },
  );

  await t.test(
    "detected addresses keep their defaults and accept unit details",
    async () => {
      const page = await browser.newPage();
      try {
        await page.goto(`${base}?scenario=detected`);
        for (const [name, value] of Object.entries(detectedAddress)) {
          await expect(page.locator(`input[name="${name}"]`)).toHaveValue(
            value,
          );
        }
        await page
          .getByLabel("Unit / building", { exact: true })
          .fill(newAddress.addressLine2);
        await page.getByRole("button", { name: "Book appointment" }).click();
        await expect(page.getByLabel("Submitted booking")).toHaveText(
          JSON.stringify({
            propertyId: "",
            addressLine1: detectedAddress.addressLine1,
            addressLine2: newAddress.addressLine2,
            city: detectedAddress.city,
            state: detectedAddress.state,
            postalCode: detectedAddress.postalCode,
          }),
        );
      } finally {
        await page.close();
      }
    },
  );
});
