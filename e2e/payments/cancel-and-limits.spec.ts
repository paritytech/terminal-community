import { test, expect } from "../host/fixture";
import { bootTerminal, charge, chargeAndPay, enterAmount, planck, storedSales, topicHex, topUpIdHex, waitForSale } from "../host/flows";
import { navLinks } from "./cheques.helpers";

/**
 * Leaving a sale before the customer pays, the bottom nav around it, the
 * cents keypad, and the largest amount a cheque can carry.
 */

const UNKNOWN_COPY =
  "Couldn't claim the payment. If the Polkadot app is showing a message, dismiss it, then retry.";

test.describe("cancel while waiting for the customer", () => {
  test("Close keeps the QR; Cancel returns to an empty keypad and the cheque is no longer taken", async ({ host }) => {
    const frame = await bootTerminal(host);
    const req = await charge(host, frame, "7.25");
    const subscribes = host.all("statementSubscribe").length;

    // Open the modal, then back out of it.
    await frame.locator('[data-testid="btn-cancel-transaction"]').click();
    const modal = frame.locator('[data-testid="cancel-modal"]');
    await expect(modal).toContainText("Do you want to cancel");
    await expect(modal).toContainText("this transaction?");
    await frame.locator('[data-testid="btn-cancel-modal-close"]').click();
    await expect(modal).toHaveCount(0);

    // Same request, same subscription: the sale is untouched.
    await expect(frame.locator('[data-testid="waiting-text"]')).toHaveText("Scan QR to pay");
    await expect(frame.locator('[data-testid="qr-code"]')).toHaveAttribute("data-qr-value", req.raw);
    await expect(frame.locator('[data-testid="qr-amount"]')).toHaveText("7.25");
    expect(host.all("statementSubscribe")).toHaveLength(subscribes);

    // Now cancel for real.
    await frame.locator('[data-testid="btn-cancel-transaction"]').click();
    await frame.locator('[data-testid="btn-cancel-modal-confirm"]').click();
    await expect(modal).toHaveCount(0);
    await expect(frame.locator('[data-testid="terminal-header"]')).toBeVisible();
    await expect(frame.locator('[data-testid="amount-display"]')).toHaveText("0.00");
    await expect(frame.locator('[data-testid="btn-charge"]')).toBeDisabled();
    await expect(frame.locator('[data-testid="qr-code"]')).toHaveCount(0);

    // The customer pays the abandoned request anyway: nothing is claimed.
    await host.pay({ req });

    // The next sale is the barrier — its claim is the only one the host sees.
    const next = await chargeAndPay(host, frame, "2.00");
    expect(next.req.id).not.toBe(req.id);
    await expect(frame.locator('[data-testid="payment-completed"]')).toHaveText("Payment received");
    await waitForSale(host, next.req.id);
    expect(host.all("topUp").map((e) => e.record.idHex)).toEqual([topUpIdHex(next.req.id, 1)]);
    expect((await storedSales(host)).map((s) => s.saleId)).toEqual([next.req.id]);
  });

  test("Cancel is not offered once the coins are being claimed", async ({ host }) => {
    await host.setTopUpScript("manual");
    const frame = await bootTerminal(host);
    const { topUp } = await chargeAndPay(host, frame, "4.00");
    await expect(frame.locator('[data-testid="coins-claiming"]')).toBeVisible();
    await expect(frame.locator('[data-testid="btn-cancel-transaction"]')).toHaveCount(0);
    await expect(frame.locator('[data-testid="cancel-modal"]')).toHaveCount(0);
    await host.emitTopUpStatus(topUp.idHex, { tag: "Claimed", finalized: false });
    await expect(frame.locator('[data-testid="payment-completed"]')).toBeVisible();
    await expect(frame.locator('[data-testid="btn-cancel-transaction"]')).toHaveCount(0);
  });

  test("the bottom nav is gone while the QR is up and comes back after Cancel", async ({ host }) => {
    const frame = await bootTerminal(host);
    const nav = navLinks(frame);
    await expect(nav.checkout).toBeVisible();
    await expect(nav.checkout).toHaveAttribute("aria-current", "page");
    await expect(nav.checkout).toHaveAttribute("aria-disabled", "false");

    await charge(host, frame, "3.00");
    for (const link of Object.values(nav)) await expect(link).toHaveCount(0);

    // Still gone with the cancel modal open.
    await frame.locator('[data-testid="btn-cancel-transaction"]').click();
    await expect(frame.locator('[data-testid="cancel-modal"]')).toBeVisible();
    for (const link of Object.values(nav)) await expect(link).toHaveCount(0);

    await frame.locator('[data-testid="btn-cancel-modal-confirm"]').click();
    await expect(frame.locator('[data-testid="terminal-header"]')).toBeVisible();
    for (const link of Object.values(nav)) {
      await expect(link).toBeVisible();
      await expect(link).toHaveAttribute("aria-disabled", "false");
    }
    await expect(nav.checkout).toHaveAttribute("aria-current", "page");

    // And it works again.
    await nav.history.click();
    await expect(frame.locator('[data-testid="history-header"]')).toBeVisible();
    await expect(nav.history).toHaveAttribute("aria-current", "page");
  });
});

test.describe("cents keypad", () => {
  test("00, leading zeros, the 9-digit cap and backspace build the amount the cheque asks for", async ({ host }) => {
    const frame = await bootTerminal(host);
    const display = frame.locator('[data-testid="amount-display"]');
    const chargeBtn = frame.locator('[data-testid="btn-charge"]');
    const press = async (...keys: string[]) => {
      for (const k of keys) await frame.locator(k === "<" ? '[data-testid="calc-backspace"]' : `[data-testid="calc-digit-${k}"]`).click();
    };

    // Nothing entered: 0.00 and no Charge.
    await expect(display).toHaveText("0.00");
    await expect(chargeBtn).toBeDisabled();
    await expect(chargeBtn).toHaveText(/^Charge 0\.00/);

    // Leading zeros are dropped, whichever key typed them.
    await press("0", "00", "0");
    await expect(display).toHaveText("0.00");
    await expect(chargeBtn).toBeDisabled();

    // 00 appends two digits: 5 → 0.05, 00 → 5.00.
    await press("5");
    await expect(display).toHaveText("0.05");
    await expect(chargeBtn).toBeEnabled();
    await press("00");
    await expect(display).toHaveText("5.00");

    // Backspace drops the last cent digit, down to nothing.
    await press("<");
    await expect(display).toHaveText("0.50");
    await press("<", "<");
    await expect(display).toHaveText("0.00");
    await expect(chargeBtn).toBeDisabled();
    await press("<");
    await expect(display).toHaveText("0.00");

    // Nine digits at most; further keys are ignored.
    await press("1", "2", "3", "4", "5", "6", "7", "8", "9");
    await expect(display).toHaveText("1234567.89");
    await press("0", "00", "5");
    await expect(display).toHaveText("1234567.89");
    await press("<");
    await expect(display).toHaveText("123456.78");

    // Clear it and charge 10.05 typed as 1, 00, 5: the cheque asks for exactly that.
    for (let i = 0; i < 8; i++) await press("<");
    await expect(display).toHaveText("0.00");
    await press("1", "00", "5");
    await expect(display).toHaveText("10.05");
    await expect(chargeBtn).toHaveText(/^Charge 10\.05/);
    const since = host.mark();
    await chargeBtn.click();
    await expect(frame.locator('[data-testid="waiting-text"]')).toHaveText("Scan QR to pay");
    await expect(frame.locator('[data-testid="qr-amount"]')).toHaveText("10.05");
    const req = await host.readChequeRequest();
    expect(req.amount).toBe("10.05");
    await host.next("statementSubscribe", (e) => e.topics.includes(topicHex(req.id)), { since });
  });
});

test.describe("amount limit", () => {
  test("10000.00, the largest cheque amount, is charged and claimed", async ({ host }) => {
    const frame = await bootTerminal(host);
    const { req, topUp } = await chargeAndPay(host, frame, "10000.00");
    expect(req.amount).toBe("10000.00");
    expect(topUp.amount).toBe(planck("10000.00").toString());
    await expect(frame.locator('[data-testid="payment-completed"]')).toHaveText("Payment received");
    const sale = await waitForSale(host, req.id);
    expect(sale.amount).toBe("10000.00");
  });

  // Pins CURRENT behaviour (see bugs in the report): the keypad takes up to
  // 9,999,999.99 but a cheque carries at most 10000 (MAX_AMOUNT). Setup
  // throws before any QR is minted, the banner stays on "Generating Payment"
  // under a generic claim error, "Retry claim" does nothing (there is no
  // pending claim) and only Cancel gets the merchant out.
  test("above 10000 no cheque is armed; Retry does nothing and Cancel returns to the keypad", async ({ host }) => {
    const frame = await bootTerminal(host);
    await enterAmount(frame, "12000.00");
    const since = host.mark();
    await frame.locator('[data-testid="btn-charge"]').click();

    const error = frame.locator('[data-testid="coins-claim-error"]');
    await expect(error).toHaveText(UNKNOWN_COPY);
    await expect(frame.locator('[data-testid="qr-amount"]')).toHaveText("12000.00");
    await expect(frame.locator('[data-testid="waiting-text"]')).toHaveText("Generating Payment");
    await expect(frame.locator('[data-testid="qr-code"]')).not.toHaveAttribute("data-qr-value", /.+/);
    for (const link of Object.values(navLinks(frame))) await expect(link).toHaveCount(0);

    // Host side: the pre-flight ran, but no key, no subscription, no claim.
    expect(host.all("balanceSubscribe").length).toBeGreaterThan(0);
    const after = (type: "entropy" | "statementSubscribe" | "topUp") => host.events.slice(since).filter((e) => e.type === type);
    expect(after("entropy")).toHaveLength(0);
    expect(after("statementSubscribe")).toHaveLength(0);

    // Retry claim is offered but has nothing to retry.
    const retry = frame.locator('[data-testid="btn-retry-claim"]');
    await expect(retry).toBeVisible();
    await retry.click();
    await expect(error).toHaveText(UNKNOWN_COPY);
    await expect(frame.locator('[data-testid="coins-claiming"]')).toHaveCount(0);
    expect(after("statementSubscribe")).toHaveLength(0);
    expect(after("topUp")).toHaveLength(0);

    // Cancel is the way out.
    await frame.locator('[data-testid="btn-cancel-transaction"]').click();
    await frame.locator('[data-testid="btn-cancel-modal-confirm"]').click();
    await expect(frame.locator('[data-testid="terminal-header"]')).toBeVisible();
    await expect(frame.locator('[data-testid="amount-display"]')).toHaveText("0.00");
    await expect(navLinks(frame).checkout).toBeVisible();
    expect(after("topUp")).toHaveLength(0);
    expect(await storedSales(host)).toHaveLength(0);
  });
});
