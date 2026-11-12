import { test, expect } from "../host/fixture";
import type { FrameLocator } from "@playwright/test";
import type { T3Host } from "../host/fixture";
import { bootTerminal, charge, chargeAndPay, enterAmount, topicHex, waitForSale } from "../host/flows";

/**
 * The coins pre-flight: before handing out a cheque QR the terminal asks the
 * host's payments bridge for the balance (paymentBalanceSubscribe). A balance
 * or a PermissionDenied means the bridge is up; any other interrupt or 6 s of
 * silence means it is not, and the sale goes back to the keypad with a
 * warning (lib/payments/host-reachability.ts, terminal/page.tsx startPayment).
 */

const OFFLINE_CHARGE = "No connection — can't reach the network to receive the payment. Check WiFi and try again.";
const OFFLINE_PERIODIC = "Offline — can't reach the network to settle a sale.";
const UNSUPPORTED =
  "This Polkadot app build can't take coin payments on the TrUAPI runtime. Update the app, or turn off “TrUAPI runtime (products)” in the Debug menu and restart it.";

const warning = (frame: FrameLocator) => frame.locator('[data-testid="terminal-connectivity-warning"]');

/** Press Charge for `amount` and expect the pre-flight to send it back to the keypad. */
async function chargeRefused(host: T3Host, frame: FrameLocator, amount: string, copy: string, timeout = 15_000) {
  const since = host.mark();
  await enterAmount(frame, amount);
  await frame.locator('[data-testid="btn-charge"]').click();
  // The pre-flight probe went to the host…
  await host.next("balanceSubscribe", undefined, { since, timeout: 10_000 });
  await expect(warning(frame)).toHaveText(copy, { timeout });
  // …and the sale never got as far as a QR.
  await expect(frame.locator('[data-testid="terminal-header"]')).toBeVisible();
  await expect(frame.locator('[data-testid="btn-charge"]')).toBeVisible();
  await expect(frame.locator('[data-testid="qr-code"]')).toHaveCount(0);
  expect(host.events.slice(since).some((e) => e.type === "statementSubscribe" || e.type === "topUp")).toBe(false);
  return since;
}

test.describe("coins pre-flight", () => {
  test("a silent balance bridge: Generating Payment, then the offline copy after ~6 s", async ({ host }) => {
    const frame = await bootTerminal(host);
    await host.setBalanceMode("silent");

    const since = host.mark();
    await enterAmount(frame, "5.00");
    await frame.locator('[data-testid="btn-charge"]').click();
    await host.next("balanceSubscribe", undefined, { since });
    const clicked = Date.now();
    await expect(frame.locator('[data-testid="waiting-text"]')).toHaveText("Generating Payment");
    await expect(frame.locator('[data-testid="qr-code"][data-qr-value]')).toHaveCount(0);

    // The probe gives up after 6 s of silence (isHostPaymentsReachable).
    await expect(warning(frame)).toHaveText(OFFLINE_CHARGE, { timeout: 15_000 });
    expect(Date.now() - clicked).toBeGreaterThan(4_500);
    await expect(frame.locator('[data-testid="terminal-header"]')).toBeVisible();
    expect(host.events.slice(since).some((e) => e.type === "statementSubscribe" || e.type === "topUp")).toBe(false);
  });

  test("a host without payments on this runtime gets the unsupported copy", async ({ host }) => {
    const frame = await bootTerminal(host);
    await host.setBalanceMode("Unsupported");
    // The host interrupts at once with PaymentBalanceErr.Unknown{reason:"Unsupported"}:
    // the merchant is told to update the app, not to check WiFi.
    await chargeRefused(host, frame, "5.00", UNSUPPORTED, 5_000);
    await expect(warning(frame)).not.toContainText("WiFi");
  });

  test("a withheld balance (PermissionDenied) still lets the sale through", async ({ host }) => {
    await host.setBalanceMode("PermissionDenied");
    const frame = await bootTerminal(host);
    await expect(warning(frame)).toHaveCount(0);

    const { req, topUp } = await chargeAndPay(host, frame, "8.80");
    expect(topUp.answer).toBe("accept");
    await expect(frame.locator('[data-testid="payment-completed"]')).toHaveText("Payment received");
    const sale = await waitForSale(host, req.id);
    expect(sale.amount).toBe("8.80");
    await frame.locator('[data-testid="btn-done"]').click();
    await expect(warning(frame)).toHaveCount(0);
  });

  test("once the bridge is back, the next Charge clears the warning and sells", async ({ host }) => {
    const frame = await bootTerminal(host);
    await host.setBalanceMode("Unsupported");
    await chargeRefused(host, frame, "3.30", UNSUPPORTED, 5_000);

    await host.setBalanceMode("send");
    // The keypad kept the amount; Charge again.
    await expect(frame.locator('[data-testid="amount-display"]')).toContainText("3.30");
    const since = host.mark();
    await frame.locator('[data-testid="btn-charge"]').click();
    await expect(frame.locator('[data-testid="waiting-text"]')).toHaveText("Scan QR to pay", { timeout: 30_000 });
    const req = await host.readChequeRequest();
    expect(req.amount).toBe("3.30");
    await host.next("statementSubscribe", (e) => e.topics.includes(topicHex(req.id)), { since });
    const { topUp } = await (async () => {
      const at = host.mark();
      await host.pay({ req });
      return { topUp: await host.waitForTopUp({ since: at }) };
    })();
    expect(topUp.answer).toBe("accept");
    await expect(frame.locator('[data-testid="payment-completed"]')).toBeVisible();
    await waitForSale(host, req.id);
    await frame.locator('[data-testid="btn-done"]').click();
    await expect(frame.locator('[data-testid="terminal-header"]')).toBeVisible();
    await expect(warning(frame)).toHaveCount(0);
  });

  test("the periodic probe flags a silent bridge and clears on the next poll", async ({ host }) => {
    // The indicator is driven by the app's own timers: a 6 s probe timeout and
    // a 15 s poll (use-chain-connectivity.ts), so this runs ~25 s.
    test.slow();
    await host.setBalanceMode("silent");
    const frame = await bootTerminal(host);
    await expect(warning(frame)).toHaveText(OFFLINE_PERIODIC, { timeout: 15_000 });

    const since = host.mark();
    await host.setBalanceMode("send");
    await host.next("balanceSubscribe", undefined, { since, timeout: 20_000 });
    await expect(warning(frame)).toHaveCount(0, { timeout: 5_000 });
    // And a sale goes straight through.
    const req = await charge(host, frame, "1.10");
    expect(req.amount).toBe("1.10");
  });

  test("a host that cannot derive entropy still yields a working cheque", async ({ host }) => {
    await host.setEntropyMode("error");
    const frame = await bootTerminal(host);
    const { req, topUp } = await chargeAndPay(host, frame, "4.40");
    // The terminal asked the host for entropy, got an error, and fell back to
    // the browser's CSPRNG: the QR still carries a usable 32-byte key, and the
    // payer's cheque encrypted to it decrypts.
    expect(host.all("entropy").length).toBeGreaterThanOrEqual(1);
    expect(req.key).toHaveLength(32);
    expect(topUp.answer).toBe("accept");
    await expect(frame.locator('[data-testid="payment-completed"]')).toHaveText("Payment received");
    expect((await waitForSale(host, req.id)).amount).toBe("4.40");
  });
});
