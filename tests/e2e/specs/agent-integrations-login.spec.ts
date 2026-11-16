import { test, expect } from "../test";

test.use({ storageState: { cookies: [], origins: [] } });

test("agent controls send signed-out owners to login and preserve the destination", async ({
  page,
}) => {
  const response = await page.goto("/team/tools/integrations");
  expect(response?.status()).toBe(200);
  const destination = new URL(page.url());
  expect(destination.pathname).toBe("/team/login");
  expect(destination.searchParams.get("returnTo")).toBe(
    "/team/tools/integrations",
  );
  await expect(
    page.getByRole("heading", { name: "Stonegate Team Console" }),
  ).toBeVisible();
});
