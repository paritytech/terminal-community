import { test, expect } from "../host/fixture";
import { bootTerminal } from "../host/flows";

// Port of e2e/history.spec.ts onto the Terminal test host. The host starts
// with empty storage, so the empty state is now asserted outright.
test.describe("Transaction history page", () => {
  test("navigates to history and shows header", async ({ host }) => {
    const frame = await bootTerminal(host);
    await frame.getByRole("link", { name: "History", exact: true }).click();
    await expect(frame.locator('[data-testid="history-header"]')).toBeVisible({ timeout: 30_000 });
  });

  test("shows empty state when no transactions exist", async ({ host }) => {
    const frame = await bootTerminal(host);
    await frame.getByRole("link", { name: "History", exact: true }).click();
    await expect(frame.locator('[data-testid="history-header"]')).toBeVisible({ timeout: 30_000 });
    await expect(frame.locator('[data-testid="history-search"]')).toBeVisible();
    await expect(frame.locator('[data-testid="history-empty"]')).toHaveText("No Transactions Yet");
  });

  test("search input is functional", async ({ host }) => {
    const frame = await bootTerminal(host);
    await frame.getByRole("link", { name: "History", exact: true }).click();
    await expect(frame.locator('[data-testid="history-header"]')).toBeVisible({ timeout: 30_000 });

    const searchInput = frame.locator('[data-testid="history-search"]');
    await searchInput.fill("test-search-term");
    await expect(searchInput).toHaveValue("test-search-term");
    await expect(frame.getByText("We haven't found any matches")).toBeVisible();
  });
});
