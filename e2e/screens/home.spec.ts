import { test, expect } from "../host/fixture";
import { bootTerminal } from "../host/flows";

// Port of e2e/home.spec.ts onto the Terminal test host.
test.describe("Home page loads via Host API", () => {
  test("shows T3RMINAL heading after host connection", async ({ host }) => {
    await host.next("accountGet", undefined, { timeout: 90_000 });
    const frame = host.productFrame();
    await expect(frame.locator('[data-testid="app-heading"]')).toBeVisible({ timeout: 90_000 });
    await expect(frame.locator('[data-testid="app-heading"]')).toHaveText("T3RMINAL");
  });

  test("auto-redirects to checkout with bottom nav", async ({ host }) => {
    const frame = await bootTerminal(host);

    // Once the host connection resolves, `/` auto-redirects to /terminal —
    // the amount keypad is the first screen a merchant sees.
    await expect(frame.locator('[data-testid="terminal-header"]')).toBeVisible();

    // Bottom nav tabs should be visible on the checkout screen.
    await expect(frame.getByRole("link", { name: "Check out", exact: true })).toBeVisible();
    await expect(frame.getByRole("link", { name: "Home", exact: true })).toBeVisible();
    await expect(frame.getByRole("link", { name: "History", exact: true })).toBeVisible();

    // Settings left the nav — it opens via the gear icon on the Home dashboard.
    await frame.getByRole("link", { name: "Home", exact: true }).click();
    await expect(frame.getByRole("link", { name: "Settings" })).toBeVisible();
  });
});
