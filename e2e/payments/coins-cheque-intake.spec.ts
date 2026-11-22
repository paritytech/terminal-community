import { test, expect, type T3Host } from "../host/fixture";
import { bootTerminal, charge, hexOf, planck, storedSales, topUpIdHex, waitForSale } from "../host/flows";
import { buildCheque, randomCoins, topicFor } from "../host/payer";
import { coinageLog, coinsHex } from "./cheques.helpers";
import { openRoute } from "./checkout.helpers";

/**
 * Anyone who has seen the QR can post a cheque for it, and nothing in a
 * cheque says who sent it. A cheque that is not the customer's must not hold
 * the sale. The terminal keeps every matching cheque and claims them one at
 * a time: the next one goes when the host says a claim credited nothing
 * (lib/payments/coinage/cheque-intake.ts). A claim that waits 40 s for its
 * coins lets the merchant cancel, and is then followed in the background
 * (lib/payments/coinage/claim-handoff.ts). The QR never comes back once a
 * cheque arrived.
 */

/** CHEQUE_STALL_MS. */
const STALL_MS = 40_000;

/** Post several statements in one host task, so they arrive back to back. */
async function injectTogether(host: T3Host, topic: Uint8Array, datas: Uint8Array[]) {
  const t = hexOf(topic);
  const ds = datas.map(hexOf);
  await host.page.evaluate(([t, ds]) => {
    const h = (window as unknown as { __T3_HOST__: { injectStatement(topics: string[], data: string): void } }).__T3_HOST__;
    for (const d of ds) h.injectStatement([t], d);
  }, [t, ds] as const);
}

test.describe("coins cheque intake — a cheque that is not the customer's", () => {
  test("a cheque the host refuses lets the next one go at once", async ({ host }) => {
    await host.queueTopUpAnswer("InvalidSource");
    const frame = await bootTerminal(host);
    const req = await charge(host, frame, "12.50");
    const junk = randomCoins(1);
    const real = randomCoins(2);

    const since = host.mark();
    await injectTogether(host, topicFor(req.id), [buildCheque(req, junk).data, buildCheque(req, real).data]);

    await expect(frame.locator('[data-testid="payment-completed"]')).toHaveText("Payment received");
    const topUps = host.events.slice(since).filter((e) => e.type === "topUp").map((e) => e.record);
    expect(topUps.map((t) => [t.idHex, t.answer])).toEqual([
      [topUpIdHex(req.id, 1), "InvalidSource"],
      [topUpIdHex(req.id, 2), "accept"],
    ]);
    expect(topUps[1].source).toEqual({ tag: "Coins", keys: coinsHex(real) });
    const sale = await waitForSale(host, req.id);
    expect(sale).toMatchObject({ amount: "12.50", topUpId: topUpIdHex(req.id, 2).slice(2) });
    expect(await storedSales(host)).toHaveLength(1);
  });

  test.describe("with the claims held by the host", () => {
    test.use({ hostOptions: { topUpScript: "manual" } });

    test("a claim stuck waiting for its coins holds the sale — no second claim — until the merchant cancels; if it lands later, it is recorded", async ({ host }) => {
      test.setTimeout(180_000);
      const frame = await bootTerminal(host);
      const req = await charge(host, frame, "9.00");

      let since = host.mark();
      await host.injectStatement(topicFor(req.id), buildCheque(req, randomCoins(1)).data);
      const first = await host.waitForTopUp({ since });
      expect(first.idHex).toBe(topUpIdHex(req.id, 1));
      await host.emitTopUpStatus(first.idHex, { tag: "Detecting" });
      await expect(frame.locator('[data-testid="coins-claiming"]')).toContainText("Waiting for the coins to reach the chain");

      // While the claim is young: no Cancel, no QR.
      const cancel = frame.locator('[data-testid="btn-cancel-transaction"]');
      await expect(cancel).toHaveCount(0);
      await expect(frame.locator('[data-testid="qr-code"]')).not.toHaveAttribute("data-qr-value", /.*/);

      // Another cheque arrives meanwhile. It is kept, but never claimed while
      // the first may still credit — not even once the first has stalled.
      since = host.mark();
      await host.injectStatement(topicFor(req.id), buildCheque(req, randomCoins(2)).data);
      await expect(frame.locator('[data-testid="coins-claim-stalled"]')).toBeVisible({ timeout: STALL_MS + 10_000 });
      expect(host.events.slice(since).filter((e) => e.type === "topUp")).toHaveLength(0);
      await expect(frame.locator('[data-testid="qr-code"]')).not.toHaveAttribute("data-qr-value", /.*/);

      // Stalled: the merchant may give up on the sale.
      await cancel.click();
      await frame.locator('[data-testid="btn-cancel-modal-confirm"]').click();
      await expect(frame.locator('[data-testid="terminal-header"]')).toBeVisible();
      expect(host.events.slice(since).filter((e) => e.type === "topUp")).toHaveLength(0);

      // The first cheque was the customer's after all, just slow. The claim is
      // followed in the background, and the sale is recorded in this session.
      await host.next("topUpStatusSubscribe", (e) => e.idHex === first.idHex, { since });
      await host.emitTopUpStatus(first.idHex, { tag: "Claimed", finalized: true });
      const sale = await waitForSale(host, req.id);
      expect(sale).toMatchObject({ amount: "9.00", topUpId: first.idHex.slice(2) });
      await expect.poll(async () => JSON.stringify((await host.getStorage<unknown>("pendingClaims")) ?? [])).not.toContain(req.id);
    });

    test("a claim that failed but may still be live blocks the next cheque; Retry follows the same registration", async ({ host }) => {
      test.setTimeout(150_000);
      const frame = await bootTerminal(host);
      const req = await charge(host, frame, "6.60");
      const coins = randomCoins(2);
      const id1 = topUpIdHex(req.id, 1);

      let since = host.mark();
      await host.injectStatement(topicFor(req.id), buildCheque(req, coins).data);
      const first = await host.waitForTopUp({ since });
      expect(first).toMatchObject({ idHex: id1, answer: "accept" });

      // The host accepted it, then the status stream drops past the
      // re-subscribes: no last word, so the registration may still credit.
      let mark = 0;
      for (let i = 0; i < 4; i++) {
        await host.next("topUpStatusSubscribe", (e) => e.idHex === id1, { since: mark, timeout: 20_000 });
        await expect.poll(() => host.topUpSubscriberCount(id1)).toBe(1);
        mark = host.mark();
        await host.interruptTopUpStatus(id1, { Unknown: "test: status stream dropped" });
      }
      await expect(frame.locator('[data-testid="waiting-text"]')).toHaveText("Claim didn't finish", { timeout: 20_000 });

      // A second cheque now is not claimed on its own.
      since = host.mark();
      await host.injectStatement(topicFor(req.id), buildCheque(req, randomCoins(1)).data);
      await new Promise((r) => setTimeout(r, 2_000));
      expect(host.events.slice(since).filter((e) => e.type === "topUp")).toHaveLength(0);

      // Retry registers attempt 2 with the same coins; the host answers
      // SourceBusy and the terminal follows registration 1.
      await frame.locator('[data-testid="btn-retry-claim"]').click();
      const retry = await host.waitForTopUp({ since });
      expect(retry).toMatchObject({ idHex: topUpIdHex(req.id, 2), answer: "SourceBusy" });
      expect(retry.source).toEqual({ tag: "Coins", keys: coinsHex(coins) });
      await host.next("topUpStatusSubscribe", (e) => e.idHex === id1, { since });

      await host.emitTopUpStatus(id1, { tag: "Claimed", finalized: true });
      await expect(frame.locator('[data-testid="payment-completed"]')).toHaveText("Payment received");
      await waitForSale(host, req.id, (s) => s.topUpId === id1.slice(2));
      // Never a registration for the second cheque.
      expect(host.all("topUp").map((e) => e.record.idHex)).not.toContain(topUpIdHex(req.id, 3));
    });
  });

  test("a flood of junk on the topic is logged a few lines at a time", async ({ host }) => {
    const log = coinageLog(host);
    const frame = await bootTerminal(host);
    const req = await charge(host, frame, "12.50");
    const seen = log.mark();
    const junk = Array.from({ length: 30 }, () => crypto.getRandomValues(new Uint8Array(140)));
    await injectTogether(host, topicFor(req.id), junk);
    await log.waitFor(/…and \d+ more statement\(s\) skipped/, seen);
    const decryptLines = log.lines.slice(seen).filter((l) => l.includes("decrypt failed"));
    expect(decryptLines.length).toBeLessThanOrEqual(5);

    // And the real cheque still goes through.
    const since = host.mark();
    await host.pay({ req });
    await host.waitForTopUp({ since });
    await expect(frame.locator('[data-testid="payment-completed"]')).toHaveText("Payment received");
  });
});

test.describe("an amount handed over in the URL", () => {
  test("above the cheque limit it lands on the keypad with the limit, not behind a QR", async ({ host }) => {
    await bootTerminal(host);
    const since = host.mark();
    await openRoute(host, `/terminal?amount=${planck("12000.00")}`);
    const frame = host.productFrame();
    await expect(frame.locator('[data-testid="terminal-header"]')).toBeVisible();
    await expect(frame.locator('[data-testid="amount-display"]')).toContainText(/12,?000\.00/);
    await expect(frame.locator('[data-testid="amount-limit"]')).toHaveText(/up to 10,000/);
    await expect(frame.locator('[data-testid="btn-charge"]')).toBeDisabled();
    await expect(frame.locator('[data-testid="waiting-text"]')).toHaveCount(0);
    expect(host.events.slice(since).some((e) => e.type === "statementSubscribe")).toBe(false);
  });

  test("within the limit it is charged through the same pre-flight as the keypad", async ({ host }) => {
    await bootTerminal(host);
    const since = host.mark();
    await openRoute(host, `/terminal?amount=${planck("7.25")}`);
    const frame = host.productFrame();
    await expect(frame.locator('[data-testid="waiting-text"]')).toHaveText("Scan QR to pay", { timeout: 30_000 });
    const req = await host.readChequeRequest();
    expect(req.amount).toBe("7.25");
    // The pre-flight asked the host's payments bridge before the QR went up.
    await host.next("balanceSubscribe", undefined, { since });
  });
});
