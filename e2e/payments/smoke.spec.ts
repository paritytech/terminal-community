import { test, expect } from "../host/fixture";

test("the app boots on the Terminal test host", async ({ host }) => {
  await host.waitForEvent((e): e is Extract<typeof e, { type: "accountGet" }> => e.type === "accountGet", { timeout: 90_000 });
  const frame = host.productFrame();
  await expect(frame.locator('[data-testid="app-heading"]')).toBeVisible({ timeout: 90_000 });
  await expect(frame.locator('[data-testid="btn-charge"]')).toBeVisible({ timeout: 30_000 });
  console.log(host.events.map((e) => e.type).join(","));
});
