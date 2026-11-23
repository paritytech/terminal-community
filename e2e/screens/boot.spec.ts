import { test, expect } from "../host/fixture";
import { bootTerminal, charge, chargeAndPay, enterAmount, storedSales, waitForSale } from "../host/flows";
import { productPath } from "./screens.helpers";

/**
 * Boot: the splash, the host account handshake and its failure states, the
 * bottom nav, the storage bridge failing, and the host theme.
 */

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

  test.describe("host has no product account", () => {
    test.use({ hostOptions: { accountGetMode: "NotConnected" } });

    test("no product account and no legacy account → 'No merchant account', and Retry reloads", async ({ host }) => {
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
      // The app did ask (and was refused) before giving up.
      expect(host.all("accountGet").length).toBeGreaterThan(0);

      // The host is fixed; Retry reloads the product, which now connects.
      await host.setAccountGetMode("ok");
      const since = host.mark();
      await frame.locator('[data-testid="btn-retry-host-connection"]').click();
      await host.next("productLoad", undefined, { since, timeout: 30_000 });
      await host.next("accountGet", undefined, { since, timeout: 60_000 });
      await expect(frame.locator('[data-testid="terminal-header"]')).toBeVisible({ timeout: 60_000 });
      await expect.poll(() => productPath(host)).toBe("/terminal");
      await expect(failed).toHaveCount(0);
    });
  });

  test.describe("host never answers the account request", () => {
    test.use({ hostOptions: { accountGetMode: "hang" } });

    test("an account request the host never answers → pending, then the slow-connect nudge, then no account", async ({ host }) => {
      // The app's own timers are the subject: the nudge at 15 s and the
      // product-account timeout at 60 s (then the 5 s legacy fallback).
      test.slow();
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
  });

  test.describe("legacy accounts", () => {
    test.use({ hostOptions: { legacyAccounts: true, accountGetMode: "NotConnected" } });

    test("no product account but a legacy one → the terminal boots on it", async ({ host }) => {
      const frame = host.productFrame();
      await expect(frame.locator('[data-testid="terminal-header"]')).toBeVisible({ timeout: 90_000 });
      await expect.poll(() => productPath(host)).toBe("/terminal");
      await expect(frame.locator('[data-testid="host-connection-failed"]')).toHaveCount(0);
      // The product account was asked for and refused; the legacy one carried the boot.
      expect(host.all("accountGet").length).toBeGreaterThan(0);
      // The app is usable: Home renders its dashboard for that account.
      await frame.getByRole("link", { name: "Home", exact: true }).click();
      await expect(frame.locator('[data-testid="todays-income"]')).toHaveText("0.00");
    });
  });

  test.describe("host storage", () => {
    const FINAL_AT_ONCE = [{ status: { tag: "Claimed" as const, finalized: true }, afterMs: 50 }];
    const FULL_COPY = "The Polkadot app's storage is full, so new sales can't be saved. Payments are paused until there is room.";

    test.describe("full from launch", () => {
      test.use({ hostOptions: { storageMode: "Full", topUpScript: FINAL_AT_ONCE } });

      test("host storage full → the merchant is told, no payment is taken, and it sells again once there is room", async ({ host }) => {
        const frame = await bootTerminal(host);

        // The launch-time settings write is refused: no quiet switch to memory,
        // the merchant is told.
        await host.next("storageWriteRejected", (e) => e.key === "settings" && e.mode === "Full");
        const banner = frame.locator('[data-testid="storage-health-banner"]');
        await expect(banner).toHaveAttribute("data-kind", "full");
        await expect(banner).toContainText(FULL_COPY);

        // A sale it could not keep is not taken: no QR, no subscription.
        const since = host.mark();
        await enterAmount(frame, "6.40");
        await frame.locator('[data-testid="btn-charge"]').click();
        await expect(frame.locator('[data-testid="terminal-connectivity-warning"]')).toHaveText(FULL_COPY);
        await expect(frame.locator('[data-testid="waiting-text"]')).toHaveCount(0);
        expect(host.events.slice(since).some((e) => e.type === "statementSubscribe")).toBe(false);

        // Room again: "Check again" clears the banner, and the next sale is kept.
        await host.setStorageMode("ok");
        await frame.locator('[data-testid="btn-storage-check"]').click();
        await expect(banner).toHaveCount(0);
        // The amount is still on the keypad: Charge it again.
        await frame.locator('[data-testid="btn-charge"]').click();
        await expect(frame.locator('[data-testid="waiting-text"]')).toHaveText("Scan QR to pay", { timeout: 30_000 });
        const { req } = await host.pay();
        expect(req.amount).toBe("6.40");
        await expect(frame.locator('[data-testid="payment-completed"]')).toHaveText("Payment received");
        await waitForSale(host, req.id);

        // It survives a restart.
        await host.restartProduct("/history");
        await expect.poll(() => productPath(host)).toBe("/history");
        await host.settle();
        await expect(frame.locator(`[data-testid="history-row-${req.id.slice(-4)}"]`)).toContainText("6.40");
      });
    });

    test.describe("full when the cheque arrives", () => {
      test.use({ hostOptions: { topUpScript: FINAL_AT_ONCE } });

      test("the coins are not claimed while the sale can't be kept; Retry claims them once there is room", async ({ host }) => {
        const frame = await bootTerminal(host);
        await host.next("storageWrite", (e) => e.key === "settings");
        await host.settle();

        const req = await charge(host, frame, "3.20");
        await host.setStorageMode("Full");
        const since = host.mark();
        await host.pay({ req });

        // The claim's record is refused, so the claim does not start.
        await host.next("storageWriteRejected", (e) => e.key === "pendingClaims", { since });
        await expect(frame.locator('[data-testid="coins-claim-error"]')).toContainText("can't save this sale right now");
        expect(host.events.slice(since).some((e) => e.type === "topUp")).toBe(false);

        // Room again: Retry claims, and the sale is kept.
        await host.setStorageMode("ok");
        await frame.locator('[data-testid="btn-retry-claim"]').click();
        await host.waitForTopUp({ since });
        await expect(frame.locator('[data-testid="payment-completed"]')).toHaveText("Payment received");
        const sale = await waitForSale(host, req.id);
        expect(sale.amount).toBe("3.20");
        await expect(frame.locator('[data-testid="sale-not-saved"]')).toHaveCount(0);
      });
    });

    test.describe("fills up during the claim", () => {
      test.use({ hostOptions: { topUpScript: "manual" } });

      /** Charge and pay; the store fills after the claim's record was kept. */
      async function payWhileFilling(host: Parameters<typeof bootTerminal>[0], amount: string) {
        const frame = await bootTerminal(host);
        await host.next("storageWrite", (e) => e.key === "settings");
        await host.settle();
        const { req, topUp } = await chargeAndPay(host, frame, amount);
        await host.setStorageMode("Full");
        await host.emitTopUpStatus(topUp.idHex, { tag: "Claimed", finalized: true });
        await expect(frame.locator('[data-testid="payment-completed"]')).toHaveText("Payment received");
        await host.next("storageWriteRejected", (e) => e.key === "sales");
        return { frame, req };
      }

      test("a paid sale the host will not keep is flagged, and Save again keeps it once there is room", async ({ host }) => {
        const { frame, req } = await payWhileFilling(host, "3.20");
        await expect(frame.locator('[data-testid="sale-not-saved"]')).toBeVisible();
        await expect(frame.locator('[data-testid="storage-health-banner"]')).toHaveAttribute("data-kind", "full");
        expect((await storedSales(host)).find((s) => s.saleId === req.id)).toBeUndefined();

        await host.setStorageMode("ok");
        await frame.locator('[data-testid="btn-save-sale-again"]').click();
        await expect(frame.locator('[data-testid="sale-not-saved"]')).toHaveCount(0);
        const sale = await waitForSale(host, req.id);
        expect(sale.amount).toBe("3.20");
        await expect(frame.locator('[data-testid="storage-health-banner"]')).toHaveCount(0);
        await frame.locator('[data-testid="btn-done"]').click();
        await frame.getByRole("link", { name: "History", exact: true }).click();
        await expect(frame.locator(`[data-testid="history-row-${req.id.slice(-4)}"]`)).toContainText("3.20");
      });

      test("Done does not lose a sale the host would not keep; Check again saves it once there is room", async ({ host }) => {
        const { frame, req } = await payWhileFilling(host, "2.70");
        await expect(frame.locator('[data-testid="sale-not-saved"]')).toBeVisible();
        await frame.locator('[data-testid="btn-done"]').click();

        const banner = frame.locator('[data-testid="storage-health-banner"]');
        await expect(banner.locator('[data-testid="unsaved-sales-count"]')).toHaveText("1 paid sale isn't saved yet.");

        await host.setStorageMode("ok");
        await banner.locator('[data-testid="btn-storage-check"]').click();
        await expect(banner).toHaveCount(0);
        const sale = await waitForSale(host, req.id);
        expect(sale.amount).toBe("2.70");
        expect((await storedSales(host)).filter((s) => s.saleId === req.id)).toHaveLength(1);
      });
    });
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

    test("follows the host's theme live, without a reload", async ({ host }) => {
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
