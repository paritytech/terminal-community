import { test, expect } from "../host/fixture";
import type { T3Host } from "../host/fixture";
import { bootTerminal, chargeAndPay, storedSales, waitForSale } from "../host/flows";
import type { Hex, HostEvent } from "../host/protocol";
import { encodeAddress } from "@polkadot/util-crypto";
import { coinsSaleRow, merchantAddressFor } from "./resilience.helpers";

/**
 * The background claim watcher across app restarts. A coins sale is recorded
 * at the host's first `claimed { finalized: false }` with the host's topUpId
 * and no `finalizedAt`; TopUpWatcherBoot re-arms a watch for every such sale
 * on each launch, by subscribing to the SAME registration (never registering
 * again). The host page outlives product reloads, like a phone host
 * outliving an app restart.
 */

/** Charge, pay and take the claim to its first (best-block) `claimed`. */
async function confirmingSale(host: T3Host, amount: string) {
  await host.setTopUpScript("manual");
  const frame = await bootTerminal(host);
  const { req, topUp } = await chargeAndPay(host, frame, amount);
  const claimed = host.mark();
  await host.emitTopUpStatus(topUp.idHex, { tag: "Claimed", finalized: false });
  await expect(frame.locator('[data-testid="payment-completed"]')).toHaveText("Payment received");
  const sale = await waitForSale(host, req.id);
  expect(sale.topUpId).toBe(topUp.idHex.slice(2));
  expect(sale.finalizedAt).toBeUndefined();
  // This launch's background watcher opened its own subscription on the
  // registration after the first `claimed` (the claim's one predates it)…
  const watch = await host.next("topUpStatusSubscribe", (e) => e.idHex === topUp.idHex, { since: claimed, timeout: 15_000 });
  expect(watch.known).toBe(true);
  // …and the claim let go of its own: the watcher is the only listener.
  await expect.poll(() => host.topUpSubscriberCount(topUp.idHex)).toBe(1);
  return { frame, req, topUp };
}

/** Restart the product on `path` and wait until the restarted app is up. */
async function restart(host: T3Host, path: string) {
  const since = host.mark();
  await host.restartProduct(path);
  await host.next("productLoad", undefined, { since, timeout: 30_000 });
  await host.next("accountGet", undefined, { since, timeout: 60_000 });
  await host.settle();
  return since;
}

const subscribesTo = (host: T3Host, idHex: Hex, since = 0) =>
  host.events
    .slice(since)
    .filter((e): e is Extract<HostEvent, { type: "topUpStatusSubscribe" }> => e.type === "topUpStatusSubscribe" && e.idHex === idHex);

test.describe("coins watcher — resume after a restart", () => {
  test("a restart re-follows the same registration and finalizes the sale", async ({ host }) => {
    const { req, topUp } = await confirmingSale(host, "12.50");

    const since = await restart(host, "/history");
    // TopUpWatcherBoot subscribes to the stored id — the host still knows it.
    const resumed = await host.next("topUpStatusSubscribe", (e) => e.idHex === topUp.idHex, { since, timeout: 30_000 });
    expect(resumed.known).toBe(true);

    const frame = host.productFrame();
    const row = frame.locator(`[data-testid="history-row-${req.id.slice(-4)}"]`);
    await expect(row).toHaveAttribute("data-claim-state", "confirming");
    await expect(row.locator('[data-testid="history-row-status"]')).toContainText("Received · confirming");

    await host.emitTopUpStatus(topUp.idHex, { tag: "Claimed", finalized: true });
    await expect(row).toHaveAttribute("data-claim-state", "received");
    await expect(row.locator('[data-testid="history-row-status"]')).not.toContainText("confirming");
    const final = await waitForSale(host, req.id, (s) => !!s.finalizedAt);
    expect(final.revertedAt).toBeUndefined();
    expect(final.amount).toBe("12.50");

    // Resuming never registers the claim again.
    expect(host.all("topUp")).toHaveLength(1);
    expect(await host.getTopUps()).toHaveLength(1);
    await row.click();
    await expect(frame.locator('[data-testid="history-detail-status"]')).toHaveAttribute("data-claim-state", "received");
  });

  test("a restart then notClaimed reverts the sale and takes it out of today's income", async ({ host }) => {
    const { req, topUp } = await confirmingSale(host, "2.50");

    const since = await restart(host, "/home");
    await host.next("topUpStatusSubscribe", (e) => e.idHex === topUp.idHex && e.known, { since, timeout: 30_000 });
    const frame = host.productFrame();
    const income = frame.locator('[data-testid="todays-income"]');
    await expect(income).toContainText("2.50");

    await host.emitTopUpStatus(topUp.idHex, { tag: "NotClaimed" });
    const reverted = await waitForSale(host, req.id, (s) => !!s.revertedAt);
    expect(reverted.finalizedAt).toBeUndefined();
    await expect(income).not.toContainText("2.50");
    await expect(income).toContainText("0.00");

    await frame.getByRole("link", { name: "History", exact: true }).click();
    const row = frame.locator(`[data-testid="history-row-${req.id.slice(-4)}"]`);
    await expect(row).toHaveAttribute("data-claim-state", "reverted");
    await expect(row.locator('[data-testid="history-row-status"]')).toContainText("Reverted");
    await row.click();
    const detail = frame.locator('[data-testid="history-detail-status"]');
    await expect(detail).toHaveAttribute("data-claim-state", "reverted");
    await expect(detail).toContainText("The payment didn't complete on chain. Nothing was credited.");
  });

  test("a registration the host has forgotten leaves the sale confirming, with no retry", async ({ host }) => {
    test.slow(); // the negative check outlasts the watcher's 5 s re-subscribe backoff
    const { req, topUp } = await confirmingSale(host, "7.00");
    await host.forgetTopUp(topUp.idHex);

    const since = await restart(host, "/history");
    const resumed = await host.next("topUpStatusSubscribe", (e) => e.idHex === topUp.idHex, { since, timeout: 30_000 });
    expect(resumed.known).toBe(false); // the host answers NotFound

    const row = host.productFrame().locator(`[data-testid="history-row-${req.id.slice(-4)}"]`);
    await expect(row).toHaveAttribute("data-claim-state", "confirming");
    await expect(row.locator('[data-testid="history-row-status"]')).toContainText("Received · confirming");
    await host.settle();

    // NotFound ends the watch for this launch: nothing after the watcher's
    // 5 s re-subscribe backoff (WATCH_BACKOFF_MS), so wait past it.
    const quiet = host.mark();
    await host.page.waitForTimeout(7_000);
    expect(subscribesTo(host, topUp.idHex, quiet)).toHaveLength(0);
    expect(subscribesTo(host, topUp.idHex, since).every((e) => !e.known)).toBe(true);
    expect(host.all("topUp")).toHaveLength(1);
    const sale = (await storedSales(host)).find((s) => s.saleId === req.id)!;
    expect(sale.finalizedAt).toBeUndefined();
    expect(sale.revertedAt).toBeUndefined();
    await expect(row).toHaveAttribute("data-claim-state", "confirming");
  });

  test("a launch asks the host about a forgotten registration only once", async ({ host }) => {
    // Regression: TopUpWatcherBoot used to re-run on every `account` object
    // change (three per launch), and a watch that ended on NotFound is no
    // longer in `active`, so one launch asked about the forgotten id 3 times.
    const { topUp } = await confirmingSale(host, "7.10");
    await host.forgetTopUp(topUp.idHex);
    const since = await restart(host, "/history");
    await host.next("topUpStatusSubscribe", (e) => e.idHex === topUp.idHex, { since, timeout: 30_000 });
    await expect(host.productFrame().locator('[data-testid="history-header"]')).toBeVisible();
    await host.settle({ quietMs: 1_500 });
    expect(subscribesTo(host, topUp.idHex, since)).toHaveLength(1);
  });

  test.describe("seeded before boot", () => {
    // Sales a previous launch left behind, in host storage before the product
    // loads (hostOptions), so the very first launch is the one that resumes.
    const merchant = merchantAddressFor("Bob");
    const yesterday = new Date(Date.now() - 60_000).toISOString();
    const confirming = coinsSaleRow(merchant, { id: 1, amount: "4.00" });
    const finalized = coinsSaleRow(merchant, { id: 2, amount: "5.00", finalizedAt: yesterday });
    const reverted = coinsSaleRow(merchant, { id: 3, amount: "6.00", revertedAt: yesterday });
    const partial = coinsSaleRow(merchant, {
      id: 4, amount: "1.00", requestedAmount: "8.00", requestedAmountPlanck: "8000000", finalizedAt: yesterday,
    });
    const confirming2 = coinsSaleRow(merchant, { id: 5, amount: "9.00" });
    test.use({
      hostOptions: {
        root: "Bob",
        initialPath: "/history",
        storage: { sales: [confirming, finalized, reverted, partial, confirming2] },
      },
    });

    test("seeded confirming sales are resumed on boot; settled ones are not watched", async ({ host }) => {
      // The rows are filed under the account this host hands the product.
      expect(merchant).toBe(encodeAddress(Buffer.from((await host.merchantPublicKey(0)).slice(2), "hex"), 42));
      await bootHistory(host);
      // Every sale still confirming gets a watch, on its own stored id…
      for (const s of [confirming, confirming2]) {
        await host.next("topUpStatusSubscribe", (e) => e.idHex === `0x${s.topUpId}`, { timeout: 30_000 });
      }
      const frame = host.productFrame();
      const rowOf = (id: string) => frame.locator(`[data-testid="history-row-${id.slice(-4)}"]`);
      await expect(rowOf(confirming.saleId)).toHaveAttribute("data-claim-state", "confirming");
      await expect(rowOf(confirming2.saleId)).toHaveAttribute("data-claim-state", "confirming");
      await expect(rowOf(finalized.saleId)).toHaveAttribute("data-claim-state", "received");
      await expect(rowOf(reverted.saleId)).toHaveAttribute("data-claim-state", "reverted");
      await expect(rowOf(partial.saleId)).toHaveAttribute("data-claim-state", "partial");
      await expect(rowOf(partial.saleId).locator('[data-testid="history-row-status"]')).toContainText("Received 1.00 of 8.00");

      // …and the settled ones get none. resumePendingTopUpWatches arms every
      // watch in one pass, so once both confirming ids are in, the set is whole.
      const watched = new Set(host.all("topUpStatusSubscribe").map((e) => e.idHex));
      for (const s of [finalized, reverted, partial]) expect(watched.has(`0x${s.topUpId}` as Hex)).toBe(false);
      expect(watched.size).toBe(2);
      // These ids were never registered with this host: NotFound, rows untouched.
      expect(host.all("topUpStatusSubscribe").every((e) => !e.known)).toBe(true);
      expect(host.all("topUp")).toHaveLength(0);
      const stored = await storedSales(host);
      for (const s of [confirming, confirming2]) {
        const row = stored.find((r) => r.saleId === s.saleId)!;
        expect(row.finalizedAt).toBeUndefined();
        expect(row.revertedAt).toBeUndefined();
      }
    });
  });

  test("a reload mid-claim still records the sale once the host claims it", async ({ host }) => {
    // KNOWN GAP: the claim lives only in memory (keys, paymentId, pending
    // claim in use-coinage-payment.ts). A reload after the host registered
    // the top-up but before the first `claimed` loses the sale: the host
    // credits the coins and no SaleRecord is ever written, and nothing on
    // the next launch follows the registration.
    test.fail();
    await host.setTopUpScript("manual");
    const frame = await bootTerminal(host);
    const { req, topUp } = await chargeAndPay(host, frame, "6.40");
    await host.emitTopUpStatus(topUp.idHex, { tag: "Detecting" });
    await expect(frame.locator('[data-testid="coins-claiming"]')).toContainText("Waiting for the coins to reach the chain");

    await restart(host, "/terminal");
    await host.emitTopUpStatus(topUp.idHex, { tag: "Claimed", finalized: true });
    // Correct behaviour: the claim the host completed shows up as a sale.
    await waitForSale(host, req.id, (s) => !!s.finalizedAt, 20_000);
  });
});

/** Wait for a cold start on /history (no keypad here, so not bootTerminal). */
async function bootHistory(host: T3Host) {
  await host.next("accountGet", undefined, { timeout: 90_000 });
  await host.settle();
  await expect(host.productFrame().locator('[data-testid="history-header"]')).toBeVisible({ timeout: 60_000 });
}
