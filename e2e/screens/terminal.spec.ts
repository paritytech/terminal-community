import { test, expect } from "../host/fixture";
import { bootTerminal, enterAmount, topicHex } from "../host/flows";
import { gotoInFrame } from "./screens.helpers";

// Port of e2e/terminal.spec.ts onto the Terminal test host.
test.describe("Terminal — POS keypad and QR generation", () => {
  test("navigates to terminal and shows header", async ({ host }) => {
    const frame = await bootTerminal(host);
    // Reach /terminal by URL, as the old spec did, and let the document settle.
    await frame.getByRole("link", { name: "Home", exact: true }).click();
    await expect(frame.locator('[data-testid="todays-income"]')).toBeVisible();
    await gotoInFrame(host, "/terminal");
    await expect(frame.locator('[data-testid="terminal-header"]')).toBeVisible();
  });

  test("enters digits via keypad and displays amount", async ({ host }) => {
    const frame = await bootTerminal(host);
    // Cents-based entry: "42" → keypad presses 4,2,0,0 → 42.00
    await enterAmount(frame, "42");
    await expect(frame.locator('[data-testid="amount-display"]')).toHaveText("42.00");
  });

  test("enters decimal amount", async ({ host }) => {
    const frame = await bootTerminal(host);
    // "12.50" → keypad presses 1,2,5,0
    await enterAmount(frame, "12.50");
    await expect(frame.locator('[data-testid="amount-display"]')).toHaveText("12.50");
  });

  test("backspace removes last digit", async ({ host }) => {
    const frame = await bootTerminal(host);
    await enterAmount(frame, "123");
    await expect(frame.locator('[data-testid="amount-display"]')).toHaveText("123.00");
    // Digits shift right out of the cents slot: 123.00 → 12.30
    await frame.locator('[data-testid="calc-backspace"]').click();
    await expect(frame.locator('[data-testid="amount-display"]')).toHaveText("12.30");
  });

  test("Charge button is disabled with zero amount", async ({ host }) => {
    const frame = await bootTerminal(host);
    await expect(frame.locator('[data-testid="btn-charge"]')).toBeDisabled();
  });

  test("note is optional and lives on the amount screen", async ({ host }) => {
    const frame = await bootTerminal(host);
    // No separate review step — the note field is tucked behind an "Add note"
    // toggle right under the amount, and the field only renders once tapped.
    await expect(frame.locator('[data-testid="sale-note"]')).toHaveCount(0);
    await frame.locator('[data-testid="btn-add-note"]').click();
    await frame.locator('[data-testid="sale-note"]').fill("Amazon Gift Card");
    await expect(frame.locator('[data-testid="sale-note"]')).toHaveValue("Amazon Gift Card");
    // The keypad and Charge are still on the same screen.
    await enterAmount(frame, "5");
    await expect(frame.locator('[data-testid="btn-charge"]')).toHaveText(/Charge 5\.00/);
  });

  test("generates QR code and shows waiting state", async ({ host }) => {
    const frame = await bootTerminal(host);
    const since = host.mark();
    // Enter an amount and charge — that arms the QR directly (no review step)
    await enterAmount(frame, "5");
    await frame.locator('[data-testid="btn-charge"]').click();

    // The waiting state proper — not "Generating Payment", which the old spec
    // accepted — and a real cheque QR, not the loading spinner.
    await expect(frame.locator('[data-testid="waiting-text"]')).toHaveText("Scan QR to pay", { timeout: 15_000 });
    await expect(frame.locator('[data-testid="qr-amount"]')).toHaveText("5.00");
    await expect(frame.locator('[data-testid="qr-code"]')).toBeVisible();
    const req = await host.readChequeRequest();
    expect(req.amount).toBe("5.00");
    // The terminal listens for the customer's cheque on that request's topic.
    await host.next("statementSubscribe", (e) => e.topics.includes(topicHex(req.id)), { since, timeout: 15_000 });
  });
});
