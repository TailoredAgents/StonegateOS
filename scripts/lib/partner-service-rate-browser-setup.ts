import { mkdirSync } from "node:fs";
import { expect, type Page } from "@playwright/test";
import { PARTNER_SERVICE_DEFINITIONS } from "../../packages/pricing/src/partner-services";

/** Enter synthetic agreed rates through the real staff editor in local rehearsals. */
export async function completeLocalPartnerRateSetup(page: Page): Promise<void> {
  const editor = page.getByRole("region", {
    name: "Service rates",
    exact: true,
  });
  await expect(editor).toBeVisible({ timeout: 30_000 });
  const activate = page.getByRole("button", {
    name: "Activate portal & invite Administrator",
    exact: true,
  });
  await expect(activate).toBeDisabled();
  for (const service of PARTNER_SERVICE_DEFINITIONS) {
    const section = editor
      .locator("details")
      .filter({ has: page.getByText(service.label, { exact: true }) });
    const heading = section.locator(":scope > summary");
    if (
      !(await section.evaluate(
        (element) => (element as HTMLDetailsElement).open,
      ))
    )
      await heading.click();
    const rates = section.getByLabel("Rate (USD)", { exact: true });
    await expect(rates).toHaveCount(service.variants.length);
    for (let index = 0; index < service.variants.length; index++) {
      await rates.nth(index).fill("12.50");
      await section
        .getByLabel("What this rate covers", { exact: true })
        .nth(index)
        .fill(
          `Synthetic local ${service.label} job scope; no real service or price.`,
        );
      const included = section.locator('textarea[id$="-included"]').nth(index);
      if (service.key === "pressure-washing" && index === 0)
        await included.fill("");
      else if (!(await included.inputValue()).trim())
        await included.fill(
          "Requested work within the synthetic agreed scope is included.",
        );
      if (
        service.key === "painting" ||
        service.key === "drywall-repair-paint"
      ) {
        await section
          .getByLabel(/Who supplies materials\?/)
          .nth(index)
          .selectOption("stonegate");
        await section
          .getByLabel("Included coats", { exact: true })
          .nth(index)
          .fill("2");
      }
    }
    await heading.click();
  }
  await editor
    .getByRole("button", { name: "Publish rates", exact: true })
    .click();
  await expect(
    editor
      .getByRole("alert")
      .filter({ hasText: /Pressure washing.*Included work/ }),
  ).toBeVisible();
  const incompleteService = editor
    .locator("details")
    .filter({ has: page.getByText("Pressure washing", { exact: true }) });
  const included = incompleteService
    .locator('textarea[id$="-included"]')
    .first();
  await expect(included).toBeVisible();
  await expect(included).toHaveAttribute("aria-invalid", "true");
  await expect(included).toHaveAttribute(
    "aria-describedby",
    /inclusions-error/,
  );
  await expect(activate).toBeDisabled();
  await included.fill(
    "Requested pressure washing of the agreed surfaces is included.",
  );
  const screenshotDirectory = process.env["PARTNER_MULTI_SERVICE_PREVIEW_DIR"];
  if (screenshotDirectory) {
    mkdirSync(screenshotDirectory, { recursive: true });
    await editor.screenshot({
      path: `${screenshotDirectory}/rates-${page.viewportSize()?.width ?? "desktop"}.png`,
    });
  }
  await editor
    .getByRole("button", { name: "Publish rates", exact: true })
    .click();
  await expect(activate)
    .toBeEnabled({ timeout: 10_000 })
    .catch(async () => {
      throw Error(
        JSON.stringify({
          stage: "published_rate_activation",
          alerts: await page.getByRole("alert").allTextContents(),
          notices: await editor.getByRole("status").allTextContents(),
          errors: await editor.locator('[id$="-error"]').allTextContents(),
        }),
      );
    });
  await activate.click();
  await expect(activate).toHaveCount(0, { timeout: 30_000 });
}
