import { test, expect } from "../host/fixture";
import { bootTerminal, chargeAndPay } from "../host/flows";
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
    const DEMOTED = "[HostStorage] host writeJSON failed — switching to in-memory store for the rest of the session.";

    test.describe("full from launch", () => {
      test.use({ hostOptions: { storageMode: "Full", topUpScript: FINAL_AT_ONCE } });

      test("host storage full → the sale still completes in memory, and nothing survives a restart", async ({ host, page }) => {
        const warnings: string[] = [];
        page.on("console", (m) => { if (m.type() === "warning") warnings.push(m.text()); });
        const frame = await bootTerminal(host);

        // The app tried to write its settings, was refused, and switched to
        // memory for the rest of the session.
        await host.next("storageWriteRejected", (e) => e.key === "settings" && e.mode === "Full");
        await expect.poll(() => warnings.some((w) => w.startsWith(DEMOTED))).toBe(true);

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

        // Once demoted, the app stops knocking on the full host: the sale
        // went to memory without another write attempt.
        expect(host.events.slice(since).filter((e) => e.type === "storageWriteRejected" || e.type === "storageWrite")).toEqual([]);

        // A restart starts a new session. The host is healthy again and the
        // app writes to it again; the memory-only sale is gone.
        await host.setStorageMode("ok");
        const restart = host.mark();
        await host.restartProduct("/history");
        await expect.poll(() => productPath(host)).toBe("/history");
        await host.settle();
        await expect(frame.locator('[data-testid="history-empty"]')).toHaveText("No Transactions Yet");
        await expect(frame.locator(`[data-testid="history-row-${req.id.slice(-4)}"]`)).toHaveCount(0);
        await host.next("storageWrite", (e) => e.key === "settings", { since: restart });
      });
    });

    test.describe("fills up mid-session", () => {
      test.use({ hostOptions: { topUpScript: FINAL_AT_ONCE } });

      test("the sale's own write is refused, and the sale still shows from memory", async ({ host, page }) => {
        const warnings: string[] = [];
        page.on("console", (m) => { if (m.type() === "warning") warnings.push(m.text()); });
        const frame = await bootTerminal(host);
        // Let the launch-time settings write land on the healthy host first.
        await host.next("storageWrite", (e) => e.key === "settings");
        await host.settle();

        await host.setStorageMode("Full");
        const since = host.mark();
        const { req } = await chargeAndPay(host, frame, "3.20");
        await expect(frame.locator('[data-testid="payment-completed"]')).toHaveText("Payment received");

        // The app tried to store the sale on the host and was refused…
        const refused = await host.next("storageWriteRejected", undefined, { since });
        expect(refused).toEqual({ type: "storageWriteRejected", key: "sales", mode: "Full" });
        await expect.poll(() => warnings.some((w) => w.startsWith(DEMOTED))).toBe(true);

        // …and kept it in memory: History and Home still show it.
        await frame.locator('[data-testid="btn-done"]').click();
        await frame.getByRole("link", { name: "History", exact: true }).click();
        const row = frame.locator(`[data-testid="history-row-${req.id.slice(-4)}"]`);
        await expect(row).toBeVisible();
        await expect(row).toContainText("3.20");
        await frame.getByRole("link", { name: "Home", exact: true }).click();
        await expect(frame.locator('[data-testid="todays-income"]')).toHaveText("3.20");
        // One refusal was enough: no further host writes this session.
        expect(host.events.slice(since).filter((e) => e.type === "storageWriteRejected")).toHaveLength(1);
        expect(host.events.slice(since).filter((e) => e.type === "storageWrite")).toEqual([]);
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
