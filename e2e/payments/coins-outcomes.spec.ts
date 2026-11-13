import type { FrameLocator } from "@playwright/test";
import { test, expect } from "../host/fixture";
import type { T3Host } from "../host/fixture";
import { bootTerminal, charge, chargeAndPay, hexOf, planck, storedSales, topUpIdHex, waitForSale } from "../host/flows";
import { buildCheque, randomCoins } from "../host/payer";

/**
 * What the terminal does with each of the host's answers to a claim, at
 * claim time and afterwards (the background watcher following a sale that was
 * recorded on the first best-block `claimed`):
 *
 *   ClaimedPartially{x>0}  → a sale for the credited part, final at once
 *   ClaimedPartially{0}    → "Claim didn't finish", nothing recorded
 *   NotClaimed             → "Claim didn't finish"; Retry registers attempt 2
 *   Claimed{false} → ClaimedPartially / NotClaimed (a reorg) → the recorded
 *                    sale is shrunk / flagged reverted, and totals follow
 *
 * Copy comes from lib/payments/coinage/topup-error.ts (describeTopupFailure),
 * app/(shell)/terminal/page.tsx and app/(shell)/history/page.tsx.
 */

const NOT_CLAIMED_COPY =
  "No coins arrived for this payment. Ask the customer to check their Polkadot app, then retry.";

const last4 = (id: string) => id.slice(-4).toLowerCase();

async function expectClaimError(frame: FrameLocator, copy: string) {
  await expect(frame.locator('[data-testid="waiting-text"]')).toHaveText("Claim didn't finish");
  await expect(frame.locator('[data-testid="coins-claim-error"]')).toHaveText(copy);
  await expect(frame.locator('[data-testid="btn-retry-claim"]')).toBeVisible();
  await expect(frame.locator('[data-testid="btn-retry-claim"]')).toHaveText("Retry claim");
  await expect(frame.locator('[data-testid="coins-claiming"]')).toHaveCount(0);
  // The customer has paid: the QR must not come back.
  await expect(frame.locator('[data-testid="qr-code"]')).not.toHaveAttribute("data-qr-value", /.*/);
  await expect(frame.locator('[data-testid="payment-completed"]')).toHaveCount(0);
}

async function openHistory(frame: FrameLocator) {
  await frame.getByRole("link", { name: "History", exact: true }).click();
  await expect(frame.locator('[data-testid="history-header"]')).toBeVisible();
}

async function finishSale(frame: FrameLocator) {
  await expect(frame.locator('[data-testid="payment-completed"]')).toHaveText("Payment received");
  await frame.locator('[data-testid="btn-done"]').click();
  await expect(frame.locator('[data-testid="terminal-header"]')).toBeVisible();
}

/** The big amount on the "Payment received" screen: the first bare figure in its details card. */
const completedAmount = (frame: FrameLocator) => frame.locator('[data-testid="completed-amount"]');

/**
 * Record a sale on the first best-block `claimed` and wait until only the
 * background watcher still follows the registration: the claim dropped its
 * own subscription and the watcher opened a new one.
 */
async function recordConfirmingSale(host: T3Host, frame: FrameLocator, amount = "12.50") {
  const { req, topUp } = await chargeAndPay(host, frame, amount);
  const claimSub = await host.next("topUpStatusSubscribe", (e) => e.idHex === topUp.idHex);
  expect(claimSub.known).toBe(true);
  const since = host.mark();
  await host.emitTopUpStatus(topUp.idHex, { tag: "Claimed", finalized: false });
  await expect(frame.locator('[data-testid="payment-completed"]')).toHaveText("Payment received");
  const sale = await waitForSale(host, req.id);
  expect(sale.finalizedAt).toBeUndefined();
  expect(sale.topUpId).toBe(topUpIdHex(req.id, 1).slice(2));
  // The claim lets go of its subscription once the sale is settled…
  await host.next("topUpStatusUnsubscribe", (e) => e.idHex === topUp.idHex, { since });
  // …and the background watcher opens its own on the same registration.
  await host.next("topUpStatusSubscribe", (e) => e.idHex === topUp.idHex && e.known, { since });
  await expect.poll(() => host.topUpSubscriberCount(topUp.idHex)).toBe(1);
  return { req, topUp };
}

test.describe("coins claim outcomes", () => {
  // Every status in this file is emitted by the spec.
  test.use({ hostOptions: { topUpScript: "manual" } });

  test("partial claim at claim time records the credited part as a final sale", async ({ host }) => {
    const frame = await bootTerminal(host);
    const { req, topUp } = await chargeAndPay(host, frame, "12.50");
    expect(topUp.amount).toBe(planck("12.50").toString());

    await host.emitTopUpStatus(topUp.idHex, { tag: "ClaimedPartially", actualClaimed: planck("5.00").toString() });

    await expect(frame.locator('[data-testid="payment-completed"]')).toHaveText("Payment received");
    await expect(frame.locator('[data-testid="sale-id"]')).toHaveText(`#${req.id.slice(-4)}`);
    await expect(frame.locator('[data-testid="coins-shortfall"]')).toHaveText(
      "Received 5.00 of 12.50 CASH. The rest didn't arrive.",
    );

    // Stored at the credited amount, with what was asked for, and final:
    // a partial claim is the host's last word.
    const sale = await waitForSale(host, req.id);
    expect(sale).toMatchObject({
      amount: "5.00",
      amountPlanck: planck("5.00").toString(),
      requestedAmount: "12.50",
      requestedAmountPlanck: planck("12.50").toString(),
      topUpId: topUp.idHex.slice(2),
      customerAddress: "anonymous",
    });
    expect(sale.finalizedAt).toBeTruthy();
    expect(sale.revertedAt).toBeUndefined();

    await finishSale(frame);
    await openHistory(frame);
    const row = frame.locator(`[data-testid="history-row-${last4(req.id)}"]`);
    await expect(row).toHaveAttribute("data-claim-state", "partial");
    await expect(row.locator('[data-testid="history-row-status"]')).toContainText("Received 5.00 of 12.50");
    await expect(row).toContainText("5.00 CASH");
    await expect(frame.locator('[data-testid="history-group-total"]')).toHaveText("5.00 CASH");
    await row.click();
    const detail = frame.locator('[data-testid="history-detail-status"]');
    await expect(detail).toHaveAttribute("data-claim-state", "partial");
    await expect(detail).toContainText("Received");
    await expect(detail).toContainText("5.00 of the 12.50 CASH requested arrived");

    // Today's income counts the credited amount, not the requested one.
    await frame.getByRole("link", { name: "Home", exact: true }).click();
    await expect(frame.locator('[data-testid="todays-income"]')).toHaveText("5.00");
    // Final at once: the claim's own subscription was the only one — no
    // watcher — and the claim let go of it.
    expect(host.all("topUpStatusSubscribe").filter((e) => e.idHex === topUp.idHex)).toHaveLength(1);
    expect(host.all("topUpStatusUnsubscribe").filter((e) => e.idHex === topUp.idHex)).toHaveLength(1);
  });

  // BUG(app): on a partial claim the completed screen's big figure is the
  // requested amount (terminal/page.tsx renders `finalAmount`, the charge),
  // not what was credited; only the coins-shortfall line below carries the
  // credited 5.00. The merchant's headline number should be the money in.
  test("partial claim at claim time: the completed screen's amount is the credited one", async ({ host }) => {
    test.fail();
    const frame = await bootTerminal(host);
    const { topUp } = await chargeAndPay(host, frame, "12.50");
    await host.emitTopUpStatus(topUp.idHex, { tag: "ClaimedPartially", actualClaimed: planck("5.00").toString() });
    await expect(frame.locator('[data-testid="coins-shortfall"]')).toHaveText(
      "Received 5.00 of 12.50 CASH. The rest didn't arrive.",
    );
    await expect(completedAmount(frame)).toHaveText("5.00", { timeout: 5_000 });
  });

  test("a partial claim that credited nothing is a failed claim, and no sale is written", async ({ host }) => {
    const frame = await bootTerminal(host);
    const { req, topUp } = await chargeAndPay(host, frame, "12.50");
    await host.emitTopUpStatus(topUp.idHex, { tag: "ClaimedPartially", actualClaimed: "0" });

    await expectClaimError(frame, NOT_CLAIMED_COPY);
    await expect(frame.locator('[data-testid="btn-cancel-transaction"]')).toBeVisible();
    // No sale, no second registration, and nothing left following the claim:
    // the claim let go of its one subscription and no watcher took over.
    expect((await storedSales(host)).find((s) => s.saleId === req.id)).toBeUndefined();
    expect(host.all("topUp").map((e) => e.record.idHex)).toEqual([topUpIdHex(req.id, 1)]);
    await host.next("topUpStatusUnsubscribe", (e) => e.idHex === topUp.idHex);
    expect(host.all("topUpStatusSubscribe").filter((e) => e.idHex === topUp.idHex)).toHaveLength(1);
  });

  test("NotClaimed, then Retry claim registers attempt 2 and the sale carries its id", async ({ host }) => {
    const frame = await bootTerminal(host);
    const { req, coins, topUp } = await chargeAndPay(host, frame, "12.50");
    expect(topUp.idHex).toBe(topUpIdHex(req.id, 1));
    const coinKeys = coins.map(hexOf);

    await host.emitTopUpStatus(topUp.idHex, { tag: "Detecting" });
    await expect(frame.locator('[data-testid="coins-claiming"]')).toContainText("Waiting for the coins to reach the chain");
    await host.emitTopUpStatus(topUp.idHex, { tag: "NotClaimed" });
    await expectClaimError(frame, NOT_CLAIMED_COPY);
    expect((await storedSales(host)).find((s) => s.saleId === req.id)).toBeUndefined();

    // Retry: the same cheque's coins, under the next registration id. No new
    // statement is needed.
    const statementsBefore = host.all("statementSubscribe").length;
    const since = host.mark();
    await frame.locator('[data-testid="btn-retry-claim"]').click();
    const retry = await host.waitForTopUp({ since });
    expect(retry.answer).toBe("accept");
    expect(retry.idHex).toBe(topUpIdHex(req.id, 2));
    expect(retry.amount).toBe(planck("12.50").toString());
    expect(retry.source).toEqual({ tag: "Coins", keys: coinKeys });

    const claiming = frame.locator('[data-testid="coins-claiming"]');
    await expect(claiming).toHaveText("Handing the payment to the Polkadot app · retry 1. This can take a minute.");
    await expect(frame.locator('[data-testid="coins-claim-error"]')).toHaveCount(0);
    await expect(frame.locator('[data-testid="btn-retry-claim"]')).toHaveCount(0);
    await host.emitTopUpStatus(retry.idHex, { tag: "Claiming" });
    await expect(claiming).toContainText("Moving the coins into your balance · retry 1");

    await host.emitTopUpStatus(retry.idHex, { tag: "Claimed", finalized: true });
    await expect(frame.locator('[data-testid="payment-completed"]')).toHaveText("Payment received");
    const sale = await waitForSale(host, req.id, (s) => !!s.finalizedAt);
    expect(sale).toMatchObject({ amount: "12.50", topUpId: retry.idHex.slice(2) });
    expect(sale.requestedAmount).toBeUndefined();
    expect(host.all("statementSubscribe")).toHaveLength(statementsBefore);
    expect((await host.getTopUps()).map((t) => t.idHex)).toEqual([topUpIdHex(req.id, 1), topUpIdHex(req.id, 2)]);
  });

  test("after a failed claim, the same cheque arriving again starts the next registration on its own", async ({ host }) => {
    const frame = await bootTerminal(host);
    const req = await charge(host, frame, "7.00");
    const coins = randomCoins(2);
    const cheque = buildCheque(req, coins);
    let since = host.mark();
    await host.injectStatement(cheque.topic, cheque.data);
    const first = await host.waitForTopUp({ since });
    expect(first.idHex).toBe(topUpIdHex(req.id, 1));
    await host.emitTopUpStatus(first.idHex, { tag: "NotClaimed" });
    await expectClaimError(frame, NOT_CLAIMED_COPY);

    // The customer's app re-sends the very same statement.
    since = host.mark();
    await host.injectStatement(cheque.topic, cheque.data);
    const second = await host.waitForTopUp({ since });
    expect(second.idHex).toBe(topUpIdHex(req.id, 2));
    expect(second.answer).toBe("accept");
    await expect(frame.locator('[data-testid="coins-claiming"]')).toContainText("· retry 1");

    await host.emitTopUpStatus(second.idHex, { tag: "Claimed", finalized: true });
    await expect(frame.locator('[data-testid="payment-completed"]')).toBeVisible();
    const sale = await waitForSale(host, req.id);
    expect(sale.topUpId).toBe(second.idHex.slice(2));
    expect(host.all("topUp")).toHaveLength(2);
  });

  test("a reorg after the sale settles it partially: the watcher records the shortfall", async ({ host }) => {
    const frame = await bootTerminal(host);
    const { req, topUp } = await recordConfirmingSale(host, frame);
    await finishSale(frame);
    await openHistory(frame);
    const row = frame.locator(`[data-testid="history-row-${last4(req.id)}"]`);
    await expect(row).toHaveAttribute("data-claim-state", "confirming");
    await expect(row.locator('[data-testid="history-row-status"]')).toContainText("Received · confirming");

    const since = host.mark();
    await host.emitTopUpStatus(topUp.idHex, { tag: "ClaimedPartially", actualClaimed: planck("5.00").toString() });

    const sale = await waitForSale(host, req.id, (s) => !!s.finalizedAt);
    expect(sale).toMatchObject({
      amount: "5.00",
      amountPlanck: planck("5.00").toString(),
      requestedAmount: "12.50",
      requestedAmountPlanck: planck("12.50").toString(),
      topUpId: topUp.idHex.slice(2),
    });
    expect(sale.revertedAt).toBeUndefined();

    // History follows live.
    await expect(row).toHaveAttribute("data-claim-state", "partial");
    await expect(row.locator('[data-testid="history-row-status"]')).toContainText("Received 5.00 of 12.50");
    await expect(row).toContainText("5.00 CASH");
    await row.click();
    await expect(frame.locator('[data-testid="history-detail-status"]')).toContainText(
      "5.00 of the 12.50 CASH requested arrived",
    );
    // The watch is over: the watcher let go of its subscription.
    await host.next("topUpStatusUnsubscribe", (e) => e.idHex === topUp.idHex, { since });

    await frame.getByRole("link", { name: "Home", exact: true }).click();
    await expect(frame.locator('[data-testid="todays-income"]')).toHaveText("5.00");
    // …and, the History and Home round trip later, it never picked it up again.
    expect(host.events.slice(since).filter((e) => e.type === "topUpStatusSubscribe")).toHaveLength(0);
  });

  test("a reorg after the sale reverts it: flagged in History and left out of the totals", async ({ host }) => {
    const frame = await bootTerminal(host);

    // A sale that stays: final on the first claim.
    const kept = await chargeAndPay(host, frame, "1.00");
    await host.emitTopUpStatus(kept.topUp.idHex, { tag: "Claimed", finalized: true });
    await waitForSale(host, kept.req.id, (s) => !!s.finalizedAt);
    await finishSale(frame);

    // A sale recorded on best block that the host later says never landed.
    const { req, topUp } = await recordConfirmingSale(host, frame);
    await finishSale(frame);
    await frame.getByRole("link", { name: "Home", exact: true }).click();
    const income = frame.locator('[data-testid="todays-income"]');
    await expect(income).toHaveText("13.50"); // confirming sales count until their last word

    const since = host.mark();
    await host.emitTopUpStatus(topUp.idHex, { tag: "NotClaimed" });
    const sale = await waitForSale(host, req.id, (s) => !!s.revertedAt);
    expect(sale.finalizedAt).toBeUndefined();
    expect(sale.amount).toBe("12.50"); // the row stays as recorded, only flagged
    await expect(income).toHaveText("1.00");
    await host.next("topUpStatusUnsubscribe", (e) => e.idHex === topUp.idHex, { since });

    await frame.getByRole("link", { name: "Sales", exact: true }).click();
    await expect(frame.locator('[data-testid="sales-transactions"]')).toHaveText("1");
    await expect(frame.locator('[data-testid="sales-year-total"] span').first()).toHaveText("1.00");

    await openHistory(frame);
    const row = frame.locator(`[data-testid="history-row-${last4(req.id)}"]`);
    await expect(row).toHaveAttribute("data-claim-state", "reverted");
    await expect(row.locator('[data-testid="history-row-status"]')).toContainText("Reverted");
    await expect(row.getByText("12.50 CASH", { exact: true })).toHaveCSS("text-decoration-line", "line-through");
    const keptRow = frame.locator(`[data-testid="history-row-${last4(kept.req.id)}"]`);
    await expect(keptRow).toHaveAttribute("data-claim-state", "received");

    await row.click();
    const detail = frame.locator('[data-testid="history-detail-status"]');
    await expect(detail).toHaveAttribute("data-claim-state", "reverted");
    await expect(detail).toContainText("Reverted");
    await expect(detail).toContainText("The payment didn't complete on chain. Nothing was credited.");
  });
});
