import { test, expect } from "../host/fixture";
import { bootTerminal, enterAmount } from "../host/flows";
import { setting } from "./settings.helpers";

/**
 * Voucher (the `standard` pUSD method). It settles by watching the chain
 * itself, and the test host serves no chain (featureSupported → false), so
 * the terminal must refuse to show a QR it could never settle. The voucher
 * flow is not in product use (lib/storage/sale-state.ts); this pins the
 * offline guard only.
 *
 * Why the plan's "Voucher yields a non-cheque QR (polkadotapp://pay?…)" check
 * is not here: Charge runs startPayment() (app/(shell)/terminal/page.tsx),
 * which awaits connectivity.check() before it sets the amount the voucher
 * QR is built from. For Voucher that probe is isChainReachable — a best-block
 * read on Asset Hub — and with no chain it can only answer "offline" (after
 * its 6 s timeout), so the QR is never rendered. The only gap is the moment
 * before the payment-method setting loads, when nothing is probed and a
 * Charge would pass; that is a boot race, not a route a test should rely on.
 * The QR becomes reachable with a served chain (phase 2, e2e/fake-chain).
 */

test.describe("voucher method without a chain", () => {
  test("Charge is refused with the offline copy, and nothing is armed on the host", async ({ host }) => {
    // The chain probe waits up to 6 s for a best block before calling the
    // chain unreachable (lib/payments/chain-reachability.ts); that timer is
    // the subject here.
    test.slow();
    const frame = await bootTerminal(host);

    // Switch to Voucher the way a merchant does.
    await frame.getByRole("link", { name: "Home", exact: true }).click();
    await frame.getByRole("link", { name: "Settings" }).click();
    await frame.getByRole("link", { name: "Payment Method" }).click();
    await frame.getByRole("switch", { name: "Voucher" }).click();
    await expect(frame.getByRole("switch", { name: "Voucher" })).toHaveAttribute("aria-checked", "true");
    await expect.poll(() => setting(host, "terminal/payment-method")).toBe("standard");
    await frame.getByRole("link", { name: "Back to settings" }).click();
    await frame.getByRole("link", { name: "Back to home" }).click();
    await frame.getByRole("link", { name: "Check out", exact: true }).click();
    await expect(frame.locator('[data-testid="terminal-header"]')).toBeVisible();

    // The periodic probe already marks the terminal offline.
    const warning = frame.locator('[data-testid="terminal-connectivity-warning"]');
    await expect(warning).toHaveText("Offline — can't reach the network to settle a sale.", { timeout: 30_000 });

    const since = host.mark();
    await enterAmount(frame, "4.50");
    await frame.locator('[data-testid="btn-charge"]').click();
    // Pre-flight: "Generating Payment" while the probe runs, then back to the keypad.
    await expect(frame.locator('[data-testid="waiting-text"]')).toHaveText("Generating Payment");
    await expect(warning).toHaveText(
      "No connection — can't reach the network to receive the payment. Check WiFi and try again.",
      { timeout: 30_000 },
    );
    await expect(frame.locator('[data-testid="terminal-header"]')).toBeVisible();
    await expect(frame.locator('[data-testid="amount-display"]')).toContainText("4.50");
    await expect(frame.locator('[data-testid="qr-code"]')).toHaveCount(0);
    await expect(frame.getByRole("link", { name: "Check out", exact: true })).toBeVisible();

    // No coins request was armed: no payment key, no cheque topic, no claim.
    const after = host.events.slice(since);
    expect(after.filter((e) => e.type === "entropy")).toHaveLength(0);
    expect(after.filter((e) => e.type === "statementSubscribe")).toHaveLength(0);
    expect(after.filter((e) => e.type === "topUp")).toHaveLength(0);
    expect(after.filter((e) => e.type === "balanceSubscribe")).toHaveLength(0);
  });

  test("switching back to Coins clears the offline warning and charges with a cheque", async ({ host }) => {
    test.slow(); // the 6 s chain probe, as above
    const frame = await bootTerminal(host);
    await frame.getByRole("link", { name: "Home", exact: true }).click();
    await frame.getByRole("link", { name: "Settings" }).click();
    await frame.getByRole("link", { name: "Payment Method" }).click();
    await frame.getByRole("switch", { name: "Voucher" }).click();
    await expect.poll(() => setting(host, "terminal/payment-method")).toBe("standard");
    await frame.getByRole("link", { name: "Back to settings" }).click();
    await frame.getByRole("link", { name: "Back to home" }).click();
    await frame.getByRole("link", { name: "Check out", exact: true }).click();
    const warning = frame.locator('[data-testid="terminal-connectivity-warning"]');
    await expect(warning).toBeVisible({ timeout: 30_000 });

    await frame.getByRole("link", { name: "Home", exact: true }).click();
    await frame.getByRole("link", { name: "Settings" }).click();
    await frame.getByRole("link", { name: "Payment Method" }).click();
    await frame.getByRole("switch", { name: "Coins" }).click();
    await expect.poll(() => setting(host, "terminal/payment-method")).toBe("coins");
    await frame.getByRole("link", { name: "Back to settings" }).click();
    await frame.getByRole("link", { name: "Back to home" }).click();
    const since = host.mark();
    await frame.getByRole("link", { name: "Check out", exact: true }).click();
    await host.next("balanceSubscribe", undefined, { since });
    await expect(warning).toHaveCount(0);

    await enterAmount(frame, "4.50");
    await frame.locator('[data-testid="btn-charge"]').click();
    await expect(frame.locator('[data-testid="waiting-text"]')).toHaveText("Scan QR to pay");
    const req = await host.readChequeRequest();
    expect(req.amount).toBe("4.50");
  });
});
