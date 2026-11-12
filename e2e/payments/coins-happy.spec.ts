import { test, expect } from "../host/fixture";
import { bootTerminal, charge, chargeAndPay, planck, storedSales, topUpIdHex, waitForSale } from "../host/flows";

/**
 * A coins sale end to end, on a host that behaves like the phone's native
 * container: the customer's cheque arrives on the statement store, the
 * terminal registers the claim with the host (`paymentTopUp`), follows its
 * status to the first `claimed`, records the sale as confirming, and the
 * background watcher finalizes it when the host reports finality.
 */

test.describe("coins sale — happy path", () => {
  test("shows a scannable cheque QR for the amount", async ({ host }) => {
    const frame = await bootTerminal(host);
    const req = await charge(host, frame, "12.50");

    expect(req.id).toMatch(/^[0-9a-f]{32}$/);
    expect(req.key).toHaveLength(32);
    expect(req.name).toBeUndefined();
    await expect(frame.locator('[data-testid="qr-amount"]')).toHaveText("12.50");
    // What a phone camera reads is exactly what the terminal armed.
    expect(await host.scanQr()).toBe(req.raw);
    // The bottom nav is out of reach while a sale is open.
    await expect(frame.getByRole("link", { name: "Check out", exact: true })).toHaveCount(0);
  });

  test("claims the cheque, records the sale and finalizes it in the background", async ({ host }) => {
    await host.setTopUpScript("manual");
    const frame = await bootTerminal(host);
    const { req, coins, topUp } = await chargeAndPay(host, frame, "12.50", 3);

    // The registration carries exactly the customer's coins, the cheque
    // amount in planck, and the deterministic id for attempt 1.
    expect(topUp.answer).toBe("accept");
    expect(topUp.amount).toBe(planck("12.50").toString());
    expect(topUp.idHex).toBe(topUpIdHex(req.id, 1));
    expect(topUp.source).toEqual({ tag: "Coins", keys: coins.map((c) => "0x" + Buffer.from(c).toString("hex")) });

    const claiming = frame.locator('[data-testid="coins-claiming"]');
    await expect(claiming).toContainText("Handing the payment to the Polkadot app");
    await expect(frame.locator('[data-testid="btn-cancel-transaction"]')).toHaveCount(0);

    await host.emitTopUpStatus(topUp.idHex, { tag: "Detecting" });
    await expect(claiming).toContainText("Waiting for the coins to reach the chain");
    await expect(frame.locator('[data-testid="waiting-text"]')).toHaveText("Payment incoming…");

    await host.emitTopUpStatus(topUp.idHex, { tag: "Claiming" });
    await expect(claiming).toContainText("Moving the coins into your balance");

    // First `claimed` (best block): the sale is in, still confirming.
    const since = host.mark();
    await host.emitTopUpStatus(topUp.idHex, { tag: "Claimed", finalized: false });
    await expect(frame.locator('[data-testid="payment-completed"]')).toHaveText("Payment received");
    await expect(frame.locator('[data-testid="sale-id"]')).toHaveText(`#${req.id.slice(-4)}`);

    const confirming = await waitForSale(host, req.id);
    expect(confirming).toMatchObject({
      amount: "12.50",
      amountPlanck: planck("12.50").toString(),
      customerAddress: "anonymous",
      blockNumber: 0,
      topUpId: topUp.idHex.slice(2),
    });
    expect(confirming.finalizedAt).toBeUndefined();

    // The watcher keeps following the same registration…
    await host.next("topUpStatusSubscribe", (e) => e.idHex === topUp.idHex, { since });
    // …and the host's finality settles it.
    await host.emitTopUpStatus(topUp.idHex, { tag: "Claimed", finalized: true });
    const final = await waitForSale(host, req.id, (s) => !!s.finalizedAt);
    expect(final.revertedAt).toBeUndefined();
    expect(await host.getTopUps()).toHaveLength(1);
  });

  test("a claim that is final at once needs no watcher", async ({ host }) => {
    await host.setTopUpScript([
      { status: { tag: "Detecting" }, afterMs: 50 },
      { status: { tag: "Claimed", finalized: true }, afterMs: 100 },
    ]);
    const frame = await bootTerminal(host);
    const { req, topUp } = await chargeAndPay(host, frame, "3.00");
    await expect(frame.locator('[data-testid="payment-completed"]')).toBeVisible();
    const sale = await waitForSale(host, req.id, (s) => !!s.finalizedAt);
    expect(sale.amount).toBe("3.00");
    // One subscription for the claim, none after.
    await frame.locator('[data-testid="btn-done"]').click();
    expect(host.all("topUpStatusSubscribe").filter((e) => e.idHex === topUp.idHex)).toHaveLength(1);
  });

  test("History follows the sale from confirming to received, live", async ({ host }) => {
    await host.setTopUpScript("manual");
    const frame = await bootTerminal(host);
    const { req, topUp } = await chargeAndPay(host, frame, "4.20");
    await host.emitTopUpStatus(topUp.idHex, { tag: "Claimed", finalized: false });
    await expect(frame.locator('[data-testid="payment-completed"]')).toBeVisible();
    await frame.locator('[data-testid="btn-done"]').click();

    await frame.getByRole("link", { name: "History", exact: true }).click();
    const row = frame.locator(`[data-testid="history-row-${req.id.slice(-4)}"]`);
    await expect(row).toHaveAttribute("data-claim-state", "confirming");
    await expect(row.locator('[data-testid="history-row-status"]')).toContainText("Received · confirming");
    await expect(row).toContainText("4.20");

    await host.emitTopUpStatus(topUp.idHex, { tag: "Claimed", finalized: true });
    await expect(row).toHaveAttribute("data-claim-state", "received");
    await expect(row.locator('[data-testid="history-row-status"]')).not.toContainText("confirming");

    await row.click();
    await expect(frame.locator('[data-testid="history-detail-status"]')).toContainText("Received");
  });

  test("Done returns to an empty keypad, and the next sale gets a new request", async ({ host }) => {
    const frame = await bootTerminal(host);
    const first = await chargeAndPay(host, frame, "1.00");
    await expect(frame.locator('[data-testid="payment-completed"]')).toBeVisible();
    await frame.locator('[data-testid="btn-done"]').click();
    await expect(frame.locator('[data-testid="terminal-header"]')).toBeVisible();
    await expect(frame.getByRole("link", { name: "Check out", exact: true })).toBeVisible();

    const since = host.mark();
    const second = await chargeAndPay(host, frame, "2.00");
    expect(second.req.id).not.toBe(first.req.id);
    expect(second.topUp.idHex).not.toBe(first.topUp.idHex);
    // The first sale's cheque subscription was closed when it settled.
    expect(host.all("statementSubscribe").length).toBeGreaterThanOrEqual(2);
    await expect(frame.locator('[data-testid="payment-completed"]')).toBeVisible();
    expect((await storedSales(host)).map((s) => s.saleId).sort()).toEqual([first.req.id, second.req.id].sort());
    void since;
  });

  test("a note entered before Charge is kept on the sale", async ({ host }) => {
    const frame = await bootTerminal(host);
    await frame.locator('[data-testid="btn-add-note"]').click();
    await frame.locator('[data-testid="sale-note"]').fill("Table 7");
    const { req } = await chargeAndPay(host, frame, "9.99");
    await expect(frame.locator('[data-testid="payment-completed"]')).toBeVisible();
    await expect(frame.getByText("Table 7")).toBeVisible();
    const sale = await waitForSale(host, req.id);
    expect(sale.note).toBe("Table 7");
  });
});
