import type { FrameLocator } from "@playwright/test";
import { test, expect } from "../host/fixture";
import { bootTerminal, chargeAndPay } from "../host/flows";
import { MERCHANT_PROFILE, keyFingerprint, productPath, restartOn, setting, waitForBootWrites } from "./settings.helpers";

/**
 * Merchant onboarding and the Settings screens, on the Terminal test host.
 * Everything here persists in host storage (the `settings` table), so each
 * persistence check restarts the product and reads the screen back.
 */

/** The onboarding/receipt fields carry their label as the placeholder. */
const field = (frame: FrameLocator, label: string) => frame.getByPlaceholder(label, { exact: true });

test.describe("merchant onboarding", () => {
  test("Continue waits for the required fields; Finish unlocks Reports and the merchant settings, and it survives a restart", async ({ host }) => {
    await bootTerminal(host);
    await waitForBootWrites(host);

    // /merchant is URL-only while the Become a Merchant flag is off.
    let frame = await restartOn(host, "/merchant");
    await expect(frame.getByText("Unlock tools to run your business")).toBeVisible();
    await frame.getByRole("button", { name: "Become a Merchant" }).click();

    // Your details: Full name, Home address and Phone are required; Extra is not.
    await expect(frame.getByText("Add your details to become a merchant")).toBeVisible();
    const cont = frame.getByRole("button", { name: "Continue" });
    await expect(cont).toBeDisabled();
    await field(frame, "Full name").fill(MERCHANT_PROFILE.fullName);
    await field(frame, "Home address").fill(MERCHANT_PROFILE.homeAddress);
    await expect(cont).toBeDisabled();
    await field(frame, "Phone number").fill("   ");
    await expect(cont).toBeDisabled(); // whitespace is not a phone number
    await field(frame, "Phone number").fill(MERCHANT_PROFILE.phone);
    await expect(cont).toBeEnabled();
    await cont.click();

    // Receipt details: all three required; the preview follows the inputs.
    await expect(frame.getByText("This is what your customers see on the receipt")).toBeVisible();
    await expect(cont).toBeDisabled();
    await field(frame, "Business Name").fill(MERCHANT_PROFILE.businessName);
    await field(frame, "Business Address").fill(MERCHANT_PROFILE.businessAddress);
    await expect(frame.locator("p", { hasText: MERCHANT_PROFILE.businessName }).first()).toBeVisible();
    await expect(cont).toBeDisabled();
    await field(frame, "Tax ID").fill(MERCHANT_PROFILE.taxId);
    await expect(cont).toBeEnabled();
    await cont.click();

    // Review lists what was entered.
    await expect(frame.getByText("Check everything's correct before you finish")).toBeVisible();
    for (const v of [MERCHANT_PROFILE.fullName, MERCHANT_PROFILE.phone, MERCHANT_PROFILE.businessName, MERCHANT_PROFILE.taxId]) {
      await expect(frame.getByText(v, { exact: true })).toBeVisible();
    }
    await frame.getByRole("button", { name: "Finish" }).click();

    // → Home, with the Reports tile.
    await expect.poll(() => productPath(host)).toBe("/home");
    await expect(frame.getByRole("link", { name: "Reports" })).toBeVisible();
    const stored = JSON.parse((await setting(host, "merchant-profile")) ?? "{}");
    expect(stored).toMatchObject({ ...MERCHANT_PROFILE });
    expect(Date.parse(stored.completedAt)).toBeGreaterThan(Date.now() - 120_000);

    // Settings switches to the merchant menu.
    await frame.getByRole("link", { name: "Settings" }).click();
    await expect(frame.getByRole("link", { name: "Merchant Profile" })).toBeVisible();
    await expect(frame.getByRole("link", { name: "Show Items in Checkout" })).toBeVisible();

    // After a restart: still onboarded.
    frame = await restartOn(host, "/settings");
    await expect(frame.getByRole("link", { name: "Merchant Profile" })).toBeVisible();
    await expect(frame.getByRole("link", { name: "Show Items in Checkout" })).toBeVisible();
    frame = await restartOn(host, "/home");
    await expect(frame.getByRole("link", { name: "Reports" })).toBeVisible();

    // Re-entering /merchant is an edit: no promo, prefilled.
    frame = await restartOn(host, "/merchant");
    await expect(frame.getByText("Add your details to become a merchant")).toBeVisible();
    await expect(field(frame, "Full name")).toHaveValue(MERCHANT_PROFILE.fullName);
  });

  test("a fresh install shows neither Reports nor the merchant rows", async ({ host }) => {
    const frame = await bootTerminal(host);
    await frame.getByRole("link", { name: "Home", exact: true }).click();
    await expect(frame.locator('[data-testid="todays-income"]')).toBeVisible();
    await expect(frame.getByRole("link", { name: "Sales" })).toBeVisible();
    await expect(frame.getByRole("link", { name: "Reports" })).toHaveCount(0);
    await frame.getByRole("link", { name: "Settings" }).click();
    for (const row of ["Receipt", "Payment Method", "Details", "Help us fix an issue"]) {
      await expect(frame.getByRole("link", { name: row, exact: true })).toBeVisible();
    }
    await expect(frame.getByRole("link", { name: "Merchant Profile" })).toHaveCount(0);
    await expect(frame.getByRole("link", { name: "Show Items in Checkout" })).toHaveCount(0);
  });
});

test.describe("settings", () => {
  test("Receipt: the business identity entered here is on the next sale's receipt", async ({ host }) => {
    const frame = await bootTerminal(host);
    await frame.getByRole("link", { name: "Home", exact: true }).click();
    await frame.getByRole("link", { name: "Settings" }).click();
    await frame.getByRole("link", { name: "Receipt", exact: true }).click();

    const next = frame.getByRole("button", { name: "Next", exact: true });
    await expect(next).toBeDisabled();
    await field(frame, "Business Name").fill("Corner Bakery");
    await field(frame, "Business Address").fill("Main St 12");
    await expect(next).toBeDisabled();
    await field(frame, "Tax ID").fill("TAX-778");
    await next.click();

    // The preview is the full sample receipt.
    await expect(frame.getByText("Preview", { exact: true })).toBeVisible();
    await expect(frame.getByText("Corner Bakery", { exact: true })).toBeVisible();
    expect(JSON.parse((await setting(host, "merchant-profile")) ?? "{}")).toMatchObject({
      businessName: "Corner Bakery",
      businessAddress: "Main St 12",
      taxId: "TAX-778",
    });
    // Editing the receipt does not onboard the merchant.
    expect(JSON.parse((await setting(host, "merchant-profile"))!).completedAt).toBeUndefined();
    await frame.getByRole("button", { name: "Done" }).click();
    await expect(frame.getByRole("link", { name: "Payment Method" })).toBeVisible();

    // Next sale: its receipt carries the new header.
    await frame.getByRole("link", { name: "Back to home" }).click();
    await frame.getByRole("link", { name: "Check out", exact: true }).click();
    await expect(frame.locator('[data-testid="terminal-header"]')).toBeVisible();
    const { req } = await chargeAndPay(host, frame, "6.40");
    await expect(frame.locator('[data-testid="payment-completed"]')).toBeVisible();
    await frame.getByRole("button", { name: "Review Receipt" }).click();
    await expect(frame.getByText(`Payment Record #${req.id.slice(-4)}`)).toBeVisible();
    const receipt = frame.locator("main svg").first();
    await expect(receipt).toContainText("Corner Bakery");
    await expect(receipt).toContainText("Main St 12");
    await expect(receipt).toContainText("TAX-778");
    await expect(receipt).toContainText("6.40");
  });

  test("Payment Method: Coins by default; Voucher is stored and survives a restart", async ({ host }) => {
    let frame = await bootTerminal(host);
    await frame.getByRole("link", { name: "Home", exact: true }).click();
    await frame.getByRole("link", { name: "Settings" }).click();
    await frame.getByRole("link", { name: "Payment Method" }).click();

    const voucher = frame.getByRole("switch", { name: "Voucher" });
    const coins = frame.getByRole("switch", { name: "Coins" });
    await expect(coins).toHaveAttribute("aria-checked", "true");
    await expect(voucher).toHaveAttribute("aria-checked", "false");
    expect(await setting(host, "terminal/payment-method")).toBeUndefined();

    await voucher.click();
    await expect(voucher).toHaveAttribute("aria-checked", "true");
    await expect(coins).toHaveAttribute("aria-checked", "false");
    await expect.poll(() => setting(host, "terminal/payment-method")).toBe("standard");

    frame = await restartOn(host, "/settings/payment-method");
    await expect(frame.getByRole("switch", { name: "Voucher" })).toHaveAttribute("aria-checked", "true");
    await expect(frame.getByRole("switch", { name: "Coins" })).toHaveAttribute("aria-checked", "false");

    await frame.getByRole("switch", { name: "Coins" }).click();
    await expect.poll(() => setting(host, "terminal/payment-method")).toBe("coins");
    frame = await restartOn(host, "/settings/payment-method");
    await expect(frame.getByRole("switch", { name: "Coins" })).toHaveAttribute("aria-checked", "true");
  });

  test("Details: the terminal name is saved; the terminal ID is minted once and stays", async ({ host }) => {
    await bootTerminal(host);
    await waitForBootWrites(host);
    const mintedId = await setting(host, "terminal/id");

    let frame = await restartOn(host, "/settings/details");
    const name = frame.getByLabel("Terminal name");
    const save = frame.getByRole("button", { name: "Save" });
    await expect(frame.getByText(mintedId!, { exact: true })).toBeVisible();
    await expect(name).toHaveValue("");
    await expect(save).toBeDisabled();

    await name.fill("Front counter");
    await expect(save).toBeEnabled();
    await save.click();
    await expect(frame.getByRole("button", { name: "Saved" })).toBeVisible();
    await expect.poll(() => setting(host, "terminal/name")).toBe("Front counter");

    frame = await restartOn(host, "/settings/details");
    await expect(frame.getByLabel("Terminal name")).toHaveValue("Front counter");
    await expect(frame.getByText(mintedId!, { exact: true })).toBeVisible();
    await expect(frame.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(await setting(host, "terminal/id")).toBe(mintedId);
  });

  test("Report a problem: Send needs a description; View logs opens the captured log", async ({ host }) => {
    const frame = await bootTerminal(host);
    await frame.getByRole("link", { name: "Home", exact: true }).click();
    await frame.getByRole("link", { name: "Settings" }).click();
    await frame.getByRole("link", { name: "Help us fix an issue" }).click();

    await expect(frame.getByRole("heading", { name: "Describe what happened" })).toBeVisible();
    const send = frame.getByRole("button", { name: "Send" });
    const text = frame.getByLabel("Tell us what happened…");
    await expect(send).toBeDisabled();
    await text.fill("   ");
    await expect(send).toBeDisabled();
    await text.fill("The QR did not show");
    await expect(send).toBeEnabled();
    await expect(frame.getByText("19/1200")).toBeVisible();
    await text.fill("");
    await expect(send).toBeDisabled();

    await frame.getByRole("link", { name: "View logs" }).click();
    await expect(frame.getByText("Logs", { exact: true })).toBeVisible();
    // The app's own console lines from this session are in the buffer.
    await expect(frame.getByText(/^[1-9]\d* entries this session$/)).toBeVisible();
    const log = frame.locator("pre");
    await expect(log).toContainText("T3RMINAL logs");
    await expect(log).toContainText("[HostStorage] Using host API localStorage");
    await expect(frame.getByRole("button", { name: "Copy logs" })).toBeEnabled();
  });

  test("On-chain indexing (URL-only): on by default, Local only is stored and survives a restart", async ({ host }) => {
    await bootTerminal(host);
    let frame = await restartOn(host, "/settings/onchain");
    await expect(frame.getByText("On-chain indexing")).toBeVisible();
    const local = frame.getByRole("switch", { name: "Local only" });
    const mirror = frame.getByRole("switch", { name: "Local + on-chain" });
    await expect(mirror).toHaveAttribute("aria-checked", "true");
    await expect(local).toHaveAttribute("aria-checked", "false");

    await local.click();
    await expect(local).toHaveAttribute("aria-checked", "true");
    await expect.poll(() => setting(host, "daily-report/onchain-indexing")).toBe("false");

    frame = await restartOn(host, "/settings/onchain");
    await expect(frame.getByRole("switch", { name: "Local only" })).toHaveAttribute("aria-checked", "true");
    await expect(frame.getByRole("switch", { name: "Local + on-chain" })).toHaveAttribute("aria-checked", "false");
  });

  test.describe("Wallet", () => {
    test.use({ hostOptions: { balance: "12500000", initialPath: "/settings/wallet" } });

    test("Wallet (URL-only) shows the host's coin balance and follows it live", async ({ host }) => {
      await host.next("accountGet", undefined, { timeout: 90_000 });
      const frame = host.productFrame();
      const balance = frame.getByText(/^\d+\.\d{2,} CASH$/);
      await expect(balance).toHaveText("12.50 CASH", { timeout: 60_000 });
      await expect(frame.getByText("Connected via Polkadot host")).toBeVisible();
      await host.settle();

      // The first document's balance subscription reaches the host before the
      // host sees that document's handshake, and the host prunes it as stale
      // (host_changes_needed), so live pushes would go nowhere. Remount the
      // screen with a client-side back/forward — no document reload — to get
      // a subscription the host keeps.
      await frame.locator("header a[href='/settings/']").click();
      await expect(frame.getByRole("link", { name: "Payment Method" })).toBeVisible();
      const since = host.mark();
      await frame.locator("body").evaluate(() => history.back());
      await host.next("balanceSubscribe", undefined, { since });
      await expect(balance).toHaveText("12.50 CASH");

      await host.setBalance(30_000_000n);
      await expect(balance).toHaveText("30.00 CASH");
      await host.setBalance(1_234_567n);
      await expect(balance).toHaveText("1.234567 CASH");
    });
  });

  test("Report Encryption (URL-only): Save shows the key's fingerprint, kept on this device", async ({ host }) => {
    await bootTerminal(host);
    let frame = await restartOn(host, "/settings/encryption");
    await expect(frame.getByText("No key set — reports will upload as plaintext")).toBeVisible();
    const input = frame.getByPlaceholder("Enter a secret phrase");
    const save = frame.getByRole("button", { name: "Save" });
    await expect(save).toBeDisabled();
    await input.fill("  correct horse battery  ");
    await save.click();

    const fp = keyFingerprint("correct horse battery");
    await expect(frame.getByRole("button", { name: "Saved" })).toBeVisible();
    await expect(frame.getByText(fp, { exact: true })).toBeVisible();
    await expect(frame.getByText("Set", { exact: true })).toBeVisible();
    // The passphrase lives in the product's own localStorage, not host storage.
    expect(await setting(host, "t3rminal:manual-encryption-passphrase")).toBeUndefined();

    frame = await restartOn(host, "/settings/encryption");
    await expect(frame.getByText(fp, { exact: true })).toBeVisible();
    await expect(frame.getByRole("button", { name: "Clear" })).toBeVisible();
  });
});
