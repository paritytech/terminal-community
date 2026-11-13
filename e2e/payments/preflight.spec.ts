import { test, expect } from "../host/fixture";
import type { FrameLocator } from "@playwright/test";
import type { T3Host } from "../host/fixture";
import { x25519 } from "@noble/curves/ed25519.js";
import { bootTerminal, charge, chargeAndPay, enterAmount, hexOf, topicHex, waitForSale } from "../host/flows";

/**
 * The coins pre-flight: before handing out a cheque QR the terminal asks the
 * host's payments bridge for the balance (paymentBalanceSubscribe). A balance
 * or a PermissionDenied means the bridge is up; any other interrupt or 6 s of
 * silence means it is not, and the sale goes back to the keypad with a
 * warning (lib/payments/host-reachability.ts, terminal/page.tsx startPayment).
 * The same probe runs at boot and every 15 s for the indicator
 * (use-chain-connectivity.ts), which uses the shorter "periodic" copy.
 *
 * Every bridge mode the boot probe must see is set through hostOptions, so it
 * is in force before the product loads.
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

test.describe("coins pre-flight — silent bridge", () => {
  test.use({ hostOptions: { balanceMode: "silent" } });

  test("a silent balance bridge: Generating Payment, then the offline copy after ~6 s", async ({ host }) => {
    // Two of the app's own 6 s probe timeouts (boot, then Charge) are the subject.
    test.slow();
    const frame = await bootTerminal(host);
    // The boot probe heard nothing for 6 s: the indicator's copy.
    await expect(warning(frame)).toHaveText(OFFLINE_PERIODIC, { timeout: 15_000 });

    const since = host.mark();
    await enterAmount(frame, "5.00");
    await frame.locator('[data-testid="btn-charge"]').click();
    await host.next("balanceSubscribe", undefined, { since });
    const clicked = Date.now();
    await expect(frame.locator('[data-testid="waiting-text"]')).toHaveText("Generating Payment");
    await expect(frame.locator('[data-testid="qr-code"][data-qr-value]')).toHaveCount(0);

    // The Charge's own probe gives up after 6 s of silence
    // (isHostPaymentsReachable) and swaps in the blocking copy.
    await expect(warning(frame)).toHaveText(OFFLINE_CHARGE, { timeout: 15_000 });
    expect(Date.now() - clicked).toBeGreaterThan(4_500);
    await expect(frame.locator('[data-testid="terminal-header"]')).toBeVisible();
    expect(host.events.slice(since).some((e) => e.type === "statementSubscribe" || e.type === "topUp")).toBe(false);
  });

  test("the periodic probe flags a silent bridge and clears on the next poll", async ({ host }) => {
    // The indicator is driven by the app's own timers: a 6 s probe timeout and
    // a 15 s poll (use-chain-connectivity.ts), so this runs ~25 s.
    test.slow();
    const frame = await bootTerminal(host);
    // Nobody pressed Charge: this is the boot probe's verdict.
    await expect(warning(frame)).toHaveText(OFFLINE_PERIODIC, { timeout: 15_000 });

    await host.setBalanceMode("send");
    const since = host.mark();
    // The next poll gets a balance and the indicator clears on its own.
    await host.next("balanceSubscribe", undefined, { since, timeout: 20_000 });
    await expect(warning(frame)).toHaveCount(0, { timeout: 20_000 });
    // And a sale goes straight through.
    const req = await charge(host, frame, "1.10");
    expect(req.amount).toBe("1.10");
  });
});

test.describe("coins pre-flight — host has no payments here (Unsupported)", () => {
  test.use({ hostOptions: { balanceMode: "Unsupported" } });

  test("a host without payments on this runtime gets the unsupported copy", async ({ host }) => {
    const frame = await bootTerminal(host);
    // The host interrupts at once with PaymentBalanceErr.Unknown{reason:"Unsupported"}:
    // the merchant is told to update the app, not to check WiFi — at boot…
    await expect(warning(frame)).toHaveText(UNSUPPORTED, { timeout: 5_000 });
    // …and on Charge, well inside the 6 s probe timeout.
    await chargeRefused(host, frame, "5.00", UNSUPPORTED, 5_000);
    await expect(warning(frame)).not.toContainText("WiFi");
  });

  test("once the bridge is back, the next Charge clears the warning and sells", async ({ host }) => {
    const frame = await bootTerminal(host);
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

    const paidAt = host.mark();
    await host.pay({ req });
    const topUp = await host.waitForTopUp({ since: paidAt });
    expect(topUp.answer).toBe("accept");
    await expect(frame.locator('[data-testid="payment-completed"]')).toBeVisible();
    await waitForSale(host, req.id);
    await frame.locator('[data-testid="btn-done"]').click();
    await expect(frame.locator('[data-testid="terminal-header"]')).toBeVisible();
    await expect(warning(frame)).toHaveCount(0);
  });
});

test.describe("coins pre-flight — no balance handler (NotImplemented)", () => {
  // What host-container answers when a host registers no balance handler:
  // Unknown{reason:"Not implemented"}. That is a bridge that can't settle, not
  // a runtime without payments, so it reads as offline.
  test.use({ hostOptions: { balanceMode: "NotImplemented" } });

  test("a host with no balance handler gets the offline copy, not the unsupported one", async ({ host }) => {
    const frame = await bootTerminal(host);
    // The interrupt answers at once, so neither copy waits for the 6 s timeout.
    await expect(warning(frame)).toHaveText(OFFLINE_PERIODIC, { timeout: 5_000 });
    await chargeRefused(host, frame, "2.20", OFFLINE_CHARGE, 5_000);
    await expect(warning(frame)).not.toContainText("Update the app");
  });
});

test.describe("coins pre-flight — balance withheld (PermissionDenied)", () => {
  test.use({ hostOptions: { balanceMode: "PermissionDenied" } });

  test("a withheld balance (PermissionDenied) still lets the sale through", async ({ host }) => {
    const frame = await bootTerminal(host);
    await expect(warning(frame)).toHaveCount(0);

    const since = host.mark();
    const { req, topUp } = await chargeAndPay(host, frame, "8.80");
    // The Charge did ask the bridge, and took the refusal as "up".
    await host.next("balanceSubscribe", undefined, { since, timeout: 1 });
    expect(topUp.answer).toBe("accept");
    await expect(frame.locator('[data-testid="payment-completed"]')).toHaveText("Payment received");
    const sale = await waitForSale(host, req.id);
    expect(sale.amount).toBe("8.80");
    await frame.locator('[data-testid="btn-done"]').click();
    await expect(warning(frame)).toHaveCount(0);
  });
});

test.describe("coins pre-flight — no host entropy", () => {
  test.use({ hostOptions: { entropyMode: "error" } });

  test("a host that cannot derive entropy still yields a working cheque", async ({ host }) => {
    const frame = await bootTerminal(host);
    const since = host.mark();
    const { req, topUp } = await chargeAndPay(host, frame, "4.40");
    // This Charge asked the host for entropy over a fresh random label, got an
    // error, and fell back to that label (the browser's CSPRNG) as the private
    // key: the QR's key is exactly X25519(label).
    const asked = await host.next("entropy", undefined, { since, timeout: 1 });
    expect(hexOf(req.key)).toBe(hexOf(x25519.getPublicKey(Buffer.from(asked.keyHex.slice(2), "hex"))));
    // …and the payer's cheque encrypted to it decrypts.
    expect(topUp.answer).toBe("accept");
    await expect(frame.locator('[data-testid="payment-completed"]')).toHaveText("Payment received");
    expect((await waitForSale(host, req.id)).amount).toBe("4.40");
  });
});
