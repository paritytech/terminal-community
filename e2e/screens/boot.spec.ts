import { test, expect } from "../host/fixture";
import type { T3Host } from "../host/fixture";
import { bootTerminal, chargeAndPay, storedSales } from "../host/flows";
import { productFrameHandle, productPath } from "./screens.helpers";

/**
 * Boot: the splash, the host account handshake and its failure states, the
 * bottom nav, the storage bridge failing, and the host theme.
 */

/**
 * Put the host's accountGet in `mode` before the product asks for its
 * account. The product is already loading when the fixture hands over the
 * host, so if it has asked already, wipe its cached account and restart it.
 */
async function startWithAccountMode(host: T3Host, mode: "NotConnected" | "hang") {
  await host.setAccountGetMode(mode);
  if (host.all("accountGet").length > 0) {
    await productFrameHandle(host)?.evaluate(() => localStorage.removeItem("web3-connect")).catch(() => {});
    await host.restartProduct("/");
  }
}

const NO_ACCOUNT_BODY =
  "The host returned no account for this terminal. Finish setting up your identity in the Polkadot app, then retry.";

test.describe("boot", () => {
  test("/ shows the splash, then lands on Check out once the account resolves", async ({ host }) => {
    const frame = host.productFrame();
    await host.next("accountGet", undefined, { timeout: 90_000 });
    const accountAsk = host.all("accountGet")[0];
    // The product asks for its own product account, scoped to its host.
    expect(accountAsk.productId).toBe("localhost:5199");

    await expect(frame.locator('[data-testid="app-heading"]')).toHaveText("T3RMINAL", { timeout: 90_000 });
    await expect(frame.locator('[data-testid="terminal-header"]')).toBeVisible({ timeout: 90_000 });
    await expect.poll(() => productPath(host)).toBe("/terminal");
    // The splash is gone and nothing failed on the way.
    await expect(frame.locator('[data-testid="app-heading"]')).toHaveCount(0);
    await expect(frame.locator('[data-testid="host-connection-failed"]')).toHaveCount(0);
    // The connected app subscribes to the host theme and the balance probe.
    await host.next("balanceSubscribe", undefined, { timeout: 30_000 });
  });

  test("the bottom nav marks the current tab on every route", async ({ host }) => {
    const frame = await bootTerminal(host);
    const checkout = frame.getByRole("link", { name: "Check out", exact: true });
    const home = frame.getByRole("link", { name: "Home", exact: true });
    const history = frame.getByRole("link", { name: "History", exact: true });

    const expectCurrent = async (current: typeof checkout | null) => {
      for (const tab of [checkout, home, history]) {
        if (tab === current) await expect(tab).toHaveAttribute("aria-current", "page");
        else await expect(tab).not.toHaveAttribute("aria-current", /.*/);
        await expect(tab).toHaveAttribute("aria-disabled", "false");
      }
    };

    await expectCurrent(checkout);

    await home.click();
    await expect(frame.locator('[data-testid="todays-income"]')).toBeVisible();
    await expect.poll(() => productPath(host)).toBe("/home");
    await expectCurrent(home);

    await history.click();
    await expect(frame.locator('[data-testid="history-header"]')).toBeVisible();
    await expect.poll(() => productPath(host)).toBe("/history");
    await expectCurrent(history);

    // Settings (through Home's gear) shows no active tab.
    await home.click();
    await frame.getByRole("link", { name: "Settings" }).click();
    await expect.poll(() => productPath(host)).toBe("/settings");
    await expectCurrent(null);

    await checkout.click();
    await expect(frame.locator('[data-testid="terminal-header"]')).toBeVisible();
    await expectCurrent(checkout);
  });

  test("no product account and no legacy account → 'No merchant account', and Retry reloads", async ({ host }) => {
    await startWithAccountMode(host, "NotConnected");
    const frame = host.productFrame();

    const failed = frame.locator('[data-testid="host-connection-failed"]');
    await expect(failed).toBeVisible({ timeout: 90_000 });
    await expect(failed).toHaveAttribute("data-reason", "no-accounts");
    await expect(failed).toHaveAttribute("role", "alert");
    await expect(failed).toContainText("No merchant account");
    await expect(failed).toContainText(NO_ACCOUNT_BODY);
    await expect(frame.locator('[data-testid="app-heading"]')).toBeVisible();
    await expect(frame.locator('[data-testid="host-connection-pending"]')).toHaveCount(0);
    // It stays on the splash: no route to Check out without an account.
    expect(productPath(host)).toBe("/");
    expect(host.all("accountGet").length).toBeGreaterThan(0);

    // The host is fixed; Retry reloads the product, which now connects.
    await host.setAccountGetMode("ok");
    const since = host.mark();
    const loadsBefore = host.all("productLoad").length;
    await frame.locator('[data-testid="btn-retry-host-connection"]').click();
    await host.next("productLoad", undefined, { since, timeout: 30_000 });
    await host.next("accountGet", undefined, { since, timeout: 60_000 });
    expect(host.all("productLoad").length).toBeGreaterThan(loadsBefore);
    await expect(frame.locator('[data-testid="terminal-header"]')).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => productPath(host)).toBe("/terminal");
  });

  test("an account request the host never answers → pending, then the slow-connect nudge, then no account", async ({ host }) => {
    // The app's own timers are the subject: the nudge at 15 s and the
    // product-account timeout at 60 s (then the 5 s legacy fallback).
    test.slow();
    await startWithAccountMode(host, "hang");
    const frame = host.productFrame();

    await host.next("accountGet", undefined, { timeout: 90_000 });
    const pending = frame.locator('[data-testid="host-connection-pending"]');
    await expect(pending).toHaveText("Connecting to host…", { timeout: 30_000 });
    await expect(pending).toHaveText("Still connecting to host… the app is taking longer than usual.", {
      timeout: 25_000,
    });
    expect(productPath(host)).toBe("/");

    // After the product-account timeout the app falls back to legacy
    // accounts; this host has none.
    const failed = frame.locator('[data-testid="host-connection-failed"]');
    await expect(failed).toHaveAttribute("data-reason", "no-accounts", { timeout: 75_000 });
    await expect(pending).toHaveCount(0);
  });

  test.describe("legacy accounts", () => {
    test.use({ hostOptions: { legacyAccounts: true } });

    test("no product account but a legacy one → the terminal boots on it", async ({ host }) => {
      await startWithAccountMode(host, "NotConnected");
      const frame = host.productFrame();
      await expect(frame.locator('[data-testid="terminal-header"]')).toBeVisible({ timeout: 90_000 });
      await expect.poll(() => productPath(host)).toBe("/terminal");
      await expect(frame.locator('[data-testid="host-connection-failed"]')).toHaveCount(0);
      expect(host.all("accountGet").length).toBeGreaterThan(0);
      // The app is usable: Home renders its dashboard for that account.
      await frame.getByRole("link", { name: "Home", exact: true }).click();
      await expect(frame.locator('[data-testid="todays-income"]')).toHaveText("0.00");
    });
  });

  test("host storage full → the sale still completes in memory, and nothing survives a restart", async ({ host }) => {
    await host.setTopUpScript([{ status: { tag: "Claimed", finalized: true }, afterMs: 50 }]);
    const frame = await bootTerminal(host);

    await host.setStorageMode("Full");
    const since = host.mark();
    const { req } = await chargeAndPay(host, frame, "6.40");
    await expect(frame.locator('[data-testid="payment-completed"]')).toHaveText("Payment received");
    await frame.locator('[data-testid="btn-done"]').click();

    // The app carries on from memory: History and Home show the sale.
    await frame.getByRole("link", { name: "History", exact: true }).click();
    const row = frame.locator(`[data-testid="history-row-${req.id.slice(-4)}"]`);
    await expect(row).toBeVisible();
    await expect(row).toContainText("6.40");
    await frame.getByRole("link", { name: "Home", exact: true }).click();
    await expect(frame.locator('[data-testid="todays-income"]')).toHaveText("6.40");

    // The host accepted nothing.
    expect(host.events.slice(since).filter((e) => e.type === "storageWrite")).toEqual([]);
    expect(await storedSales(host)).toEqual([]);

    // A restart (host healthy again) finds no sale.
    await host.setStorageMode("ok");
    await host.restartProduct("/history");
    await expect.poll(() => productPath(host)).toBe("/history");
    await host.settle();
    await expect(frame.locator('[data-testid="history-empty"]')).toHaveText("No Transactions Yet");
    await expect(frame.locator(`[data-testid="history-row-${req.id.slice(-4)}"]`)).toHaveCount(0);
    expect(await storedSales(host)).toEqual([]);
  });

  test.describe("dark host", () => {
    test.use({ hostOptions: { theme: "dark" } });

    test("boots in the host's dark theme and keeps it for the next launch", async ({ host }) => {
      const frame = await bootTerminal(host);
      const html = frame.locator("html");
      await expect(html).toHaveAttribute("data-theme", "berlin-night");
      // Stored for the anti-flash script on the next launch.
      expect(await html.evaluate(() => localStorage.getItem("pds-theme"))).toBe("berlin-night");
      // A restart paints the same theme.
      await host.restartProduct("/terminal/");
      await expect.poll(() => productPath(host)).toBe("/terminal");
      await host.settle();
      await expect(frame.locator('[data-testid="terminal-header"]')).toBeVisible();
      await expect(html).toHaveAttribute("data-theme", "berlin-night");
    });

    // FIXME(host): live theme changes never reach the product. The product
    // posts host_theme_subscribe_start BEFORE host_handshake_request, so
    // e2e/host/page.ts tags that subscription with the previous generation and
    // prunes it on the handshake; host.setTheme then has no subscriber.
    test.fixme("follows the host's theme live, without a reload", async ({ host }) => {
      const frame = await bootTerminal(host);
      const html = frame.locator("html");
      await html.evaluate((el) => el.setAttribute("data-e2e-doc", "same"));
      await host.setTheme("light");
      await expect(html).toHaveAttribute("data-theme", "berlin-day");
      await host.setTheme("dark");
      await expect(html).toHaveAttribute("data-theme", "berlin-night");
      await expect(html).toHaveAttribute("data-e2e-doc", "same");
    });
  });
});
