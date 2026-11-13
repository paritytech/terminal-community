import { test, expect } from "../host/fixture";
import { bootTerminal, charge, chargeAndPay, planck, storedSales, topicHex, topUpIdHex, waitForSale } from "../host/flows";
import { navLinks } from "./cheques.helpers";

/**
 * Leaving a sale before the customer pays, the bottom nav around it, the
 * cents keypad, and the largest amount a cheque can carry.
 */

test.describe("cancel while waiting for the customer", () => {
  test("Close keeps the QR; Cancel returns to an empty keypad and the cheque is no longer taken", async ({ host }) => {
    const frame = await bootTerminal(host);
    const req = await charge(host, frame, "7.25");
    const topic = topicHex(req.id);
    expect(await host.statementSubscriberCount(topic)).toBe(1);

    // Open the modal, then back out of it.
    const closed = host.mark();
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
    const sinceClose = (type: "statementSubscribe" | "statementUnsubscribe") =>
      host.events.slice(closed).filter((e) => e.type === type);
    expect(sinceClose("statementSubscribe")).toHaveLength(0);
    expect(sinceClose("statementUnsubscribe")).toHaveLength(0);
    expect(await host.statementSubscriberCount(topic)).toBe(1);

    // Now cancel for real: the terminal closes its subscription to the topic.
    const cancelled = host.mark();
    await frame.locator('[data-testid="btn-cancel-transaction"]').click();
    await frame.locator('[data-testid="btn-cancel-modal-confirm"]').click();
    await expect(modal).toHaveCount(0);
    await host.next("statementUnsubscribe", (e) => e.topics.includes(topic), { since: cancelled, timeout: 15_000 });
    expect(await host.statementSubscriberCount(topic)).toBe(0);
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
    // And the abandoned topic was never re-opened.
    expect(host.events.slice(cancelled).filter((e) => e.type === "statementSubscribe" && e.topics.includes(topic))).toHaveLength(0);
  });

  test.describe("with the claim held by the host", () => {
    test.use({ hostOptions: { topUpScript: "manual" } });

    test("Cancel is not offered once the coins are being claimed", async ({ host }) => {
      const frame = await bootTerminal(host);
      const { topUp } = await chargeAndPay(host, frame, "4.00");
      await expect(frame.locator('[data-testid="coins-claiming"]')).toBeVisible();
      await expect(frame.locator('[data-testid="btn-cancel-transaction"]')).toHaveCount(0);
      await expect(frame.locator('[data-testid="cancel-modal"]')).toHaveCount(0);
      await host.emitTopUpStatus(topUp.idHex, { tag: "Claimed", finalized: false });
      await expect(frame.locator('[data-testid="payment-completed"]')).toBeVisible();
      await expect(frame.locator('[data-testid="btn-cancel-transaction"]')).toHaveCount(0);
    });
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

  // A cheque carries at most 10000 (MAX_AMOUNT in lib/payments/coinage/
  // deeplink.ts). The keypad takes more digits, so an over-limit amount must
  // be refused there, before any host call, not fail behind the QR screen.
  test("above 10000 the merchant is told the limit before anything is armed", async ({ host }) => {
    const frame = await bootTerminal(host);
    for (const digit of "1200000") await frame.locator(`[data-testid="calc-digit-${digit}"]`).click();
    const since = host.mark();
    const shown = Number((await frame.locator('[data-testid="amount-display"]').innerText()).replace(/[^\d.]/g, ""));
    // Acceptable fixes: the keypad stops at the limit, or it shows 12000.00
    // and says why it will not charge it (Charge disabled, or pressed).
    if (shown > 10_000) {
      const chargeBtn = frame.locator('[data-testid="btn-charge"]');
      if (await chargeBtn.isEnabled()) await chargeBtn.click();
      // visible only: the Next dev overlay carries the thrown setup error
      // ("amount exceeds max 10000") in a hidden node.
      await expect(
        frame.getByText(/10,?000/).filter({ hasText: /max|limit|too (large|high|much)|exceed|up to/i, visible: true }).first(),
      ).toBeVisible({ timeout: 10_000 });
    }
    await expect(frame.locator('[data-testid="btn-retry-claim"]')).toHaveCount(0);
    // Still on the keypad: no QR screen was opened for an amount a cheque can't carry.
    await expect(frame.locator('[data-testid="waiting-text"]')).toHaveCount(0);
    await expect(frame.locator('[data-testid="terminal-header"]')).toBeVisible();

    // Nothing reached the host: no pre-flight, no key, no subscription, no claim.
    // (The periodic connectivity check also subscribes to the balance, every
    // 15 s, so this window is kept to the refusal itself.)
    const after = (type: "balanceSubscribe" | "entropy" | "statementSubscribe" | "topUp") =>
      host.events.slice(since).filter((e) => e.type === type);
    expect(after("balanceSubscribe")).toHaveLength(0);
    expect(after("entropy")).toHaveLength(0);
    expect(after("statementSubscribe")).toHaveLength(0);
    expect(after("topUp")).toHaveLength(0);
  });
});
