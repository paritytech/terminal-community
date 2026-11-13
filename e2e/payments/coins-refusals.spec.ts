import type { FrameLocator } from "@playwright/test";
import { test, expect } from "../host/fixture";
import { bootTerminal, chargeAndPay, planck, storedSales, topUpIdHex, waitForSale } from "../host/flows";
import { buildCheque, randomCoins } from "../host/payer";

/**
 * The host refusing to register a claim (`host_payment_top_up` → Err). The
 * merchant reads the copy from describeTopupFailure
 * (lib/payments/coinage/topup-error.ts); the classification lives in
 * classifyTopupError there and in claimCoins (lib/payments/coinage/claim.ts):
 *
 *   InvalidSource      → invalid_source
 *   SourceBusy (att.1) → host
 *   AlreadyExists      → not an error: follow that very registration
 *   Unknown{reason}    → classified by the host's words
 */

const COPY = {
  invalid_source: "The Polkadot app couldn't read the coins in this payment.",
  host: "Lost the connection to the Polkadot app. Open it, then retry.",
  timeout: "The coins haven't reached the chain yet. If the Polkadot app is showing a message, dismiss it, then retry.",
  unknown: "Couldn't claim the payment. If the Polkadot app is showing a message, dismiss it, then retry.",
} as const;

async function expectClaimError(frame: FrameLocator, copy: string) {
  await expect(frame.locator('[data-testid="waiting-text"]')).toHaveText("Claim didn't finish");
  await expect(frame.locator('[data-testid="coins-claim-error"]')).toHaveText(copy);
  await expect(frame.locator('[data-testid="btn-retry-claim"]')).toBeVisible();
  await expect(frame.locator('[data-testid="btn-cancel-transaction"]')).toBeVisible();
  await expect(frame.locator('[data-testid="coins-claiming"]')).toHaveCount(0);
  // The customer has paid: the QR must not come back.
  await expect(frame.locator('[data-testid="qr-code"]')).not.toHaveAttribute("data-qr-value", /.*/);
}

test.describe("coins claim — host refusals", () => {
  test("InvalidSource: the coins can't be read", async ({ host }) => {
    await host.queueTopUpAnswer("InvalidSource");
    const frame = await bootTerminal(host);
    const { req, topUp } = await chargeAndPay(host, frame, "12.50");
    expect(topUp).toMatchObject({ answer: "InvalidSource", idHex: topUpIdHex(req.id, 1), amount: planck("12.50").toString() });

    await expectClaimError(frame, COPY.invalid_source);
    // A refused registration is not a registration: the terminal neither
    // follows it nor registers again on its own, and records nothing.
    expect(host.all("topUpStatusSubscribe")).toHaveLength(0);
    expect(host.all("topUp")).toHaveLength(1);
    expect((await storedSales(host)).find((s) => s.saleId === req.id)).toBeUndefined();
  });

  test("SourceBusy on the first registration: lost-connection copy, and Retry registers attempt 2", async ({ host }) => {
    await host.queueTopUpAnswer("SourceBusy");
    const frame = await bootTerminal(host);
    const { req, coins, topUp } = await chargeAndPay(host, frame, "12.50");
    expect(topUp).toMatchObject({ answer: "SourceBusy", idHex: topUpIdHex(req.id, 1) });

    // With no earlier registration of its own to follow, attempt 1 surfaces it.
    await expectClaimError(frame, COPY.host);
    expect(host.all("topUpStatusSubscribe")).toHaveLength(0);

    const since = host.mark();
    await frame.locator('[data-testid="btn-retry-claim"]').click();
    const retry = await host.waitForTopUp({ since });
    expect(retry).toMatchObject({ answer: "accept", idHex: topUpIdHex(req.id, 2) });
    expect(retry.source).toEqual({ tag: "Coins", keys: coins.map((c) => "0x" + Buffer.from(c).toString("hex")) });
    await expect(frame.locator('[data-testid="payment-completed"]')).toHaveText("Payment received");
    const sale = await waitForSale(host, req.id);
    expect(sale.topUpId).toBe(retry.idHex.slice(2));
  });

  test.describe("AlreadyExists", () => {
    // The spec drives the statuses, so the claim can be read at each stage.
    test.use({ hostOptions: { topUpScript: "manual" } });

    test("AlreadyExists on the first registration: the terminal follows that same id", async ({ host }) => {
      // The host already holds this registration (a claim the app made before
      // a reload, say): it answers AlreadyExists and keeps reporting on it.
      await host.queueTopUpAnswer("AlreadyExists");
      const frame = await bootTerminal(host);
      const { req, topUp } = await chargeAndPay(host, frame, "12.50");
      const id1 = topUpIdHex(req.id, 1);
      expect(topUp).toMatchObject({ answer: "AlreadyExists", idHex: id1 });

      // Not an error: it follows attempt 1's registration, which the host knows.
      const sub = await host.next("topUpStatusSubscribe", (e) => e.idHex === id1);
      expect(sub.known).toBe(true);
      const claiming = frame.locator('[data-testid="coins-claiming"]');
      await expect(claiming).toHaveText("Handing the payment to the Polkadot app. This can take a minute.");
      await expect(frame.locator('[data-testid="coins-claim-error"]')).toHaveCount(0);
      await expect(frame.locator('[data-testid="btn-retry-claim"]')).toHaveCount(0);

      // The host's statuses for that registration drive the screen — still
      // attempt 1, no "retry" label.
      await host.emitTopUpStatus(id1, { tag: "Detecting" });
      await expect(claiming).toHaveText("Waiting for the coins to reach the chain. This can take a minute.");
      await host.emitTopUpStatus(id1, { tag: "Claiming" });
      await expect(claiming).toHaveText("Moving the coins into your balance. This can take a minute.");
      await host.emitTopUpStatus(id1, { tag: "Claimed", finalized: true });

      await expect(frame.locator('[data-testid="payment-completed"]')).toHaveText("Payment received");
      const sale = await waitForSale(host, req.id);
      expect(sale).toMatchObject({ amount: "12.50", topUpId: id1.slice(2) });
      expect(sale.finalizedAt).toBeTruthy();
      // One registration, one subscription, both on attempt 1's id: the
      // terminal neither re-registered nor moved on to attempt 2.
      expect(host.all("topUp").map((e) => e.record.idHex)).toEqual([id1]);
      expect(host.all("topUpStatusSubscribe").map((e) => [e.idHex, e.known])).toEqual([[id1, true]]);
    });
  });

  for (const { reason, kind } of [
    { reason: "test: ledger exploded", kind: "unknown" },
    { reason: "bridge unavailable", kind: "host" },
    { reason: "coins did not appear in time", kind: "timeout" },
  ] as const) {
    test(`Unknown{"${reason}"} shows the ${kind} copy`, async ({ host }) => {
      await host.queueTopUpAnswer({ Unknown: reason });
      const frame = await bootTerminal(host);
      const { req, topUp } = await chargeAndPay(host, frame, "3.00");
      expect(topUp).toMatchObject({ answer: "Unknown", idHex: topUpIdHex(req.id, 1) });
      await expectClaimError(frame, COPY[kind]);
      // The host's own words never reach the merchant.
      await expect(frame.locator('[data-testid="coins-claim-error"]')).not.toContainText(reason);
      expect(host.all("topUpStatusSubscribe")).toHaveLength(0);
      expect(host.all("topUp")).toHaveLength(1);
      expect((await storedSales(host)).find((s) => s.saleId === req.id)).toBeUndefined();
    });
  }

  test("Cancel after a claim error returns to the keypad and drops the sale", async ({ host }) => {
    await host.queueTopUpAnswer("InvalidSource");
    const frame = await bootTerminal(host);
    const first = await chargeAndPay(host, frame, "12.50");
    await expectClaimError(frame, COPY.invalid_source);

    // Close keeps the failed claim on screen.
    await frame.locator('[data-testid="btn-cancel-transaction"]').click();
    const modal = frame.locator('[data-testid="cancel-modal"]');
    await expect(modal).toContainText("Do you want to cancel");
    await frame.locator('[data-testid="btn-cancel-modal-close"]').click();
    await expect(modal).toHaveCount(0);
    await expect(frame.locator('[data-testid="coins-claim-error"]')).toHaveText(COPY.invalid_source);

    // Cancel goes back to an empty keypad with the nav back.
    await frame.locator('[data-testid="btn-cancel-transaction"]').click();
    await frame.locator('[data-testid="btn-cancel-modal-confirm"]').click();
    await expect(frame.locator('[data-testid="terminal-header"]')).toBeVisible();
    await expect(frame.locator('[data-testid="waiting-text"]')).toHaveCount(0);
    await expect(frame.locator('[data-testid="btn-retry-claim"]')).toHaveCount(0);
    await expect(frame.locator('[data-testid="amount-display"]')).not.toContainText("12.50");
    await expect(frame.getByRole("link", { name: "Check out", exact: true })).toBeVisible();

    // The cancelled sale no longer listens: the same customer re-sending its
    // cheque registers nothing, while the next sale goes through normally.
    const resend = buildCheque(first.req, randomCoins(2));
    await host.injectStatement(resend.topic, resend.data);
    const next = await chargeAndPay(host, frame, "2.00");
    await expect(frame.locator('[data-testid="payment-completed"]')).toHaveText("Payment received");
    expect(next.req.id).not.toBe(first.req.id);
    // The screen flips before the sale row is written; wait for the row.
    await waitForSale(host, next.req.id);
    expect(host.all("topUp").map((e) => e.record.idHex)).toEqual([topUpIdHex(first.req.id, 1), topUpIdHex(next.req.id, 1)]);
    expect((await storedSales(host)).map((s) => s.saleId)).toEqual([next.req.id]);
  });
});
