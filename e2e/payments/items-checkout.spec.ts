import { test, expect } from "../host/fixture";
import { bootTerminal, planck, waitForSale } from "../host/flows";
import {
  SYM,
  bootItemsCheckout,
  cartBadge,
  chargeBasket,
  itemsModeStorage,
  openRoute,
  payAndComplete,
  receiptSvg,
  settingValue,
  settingsSeed,
  tile,
  type CatalogItem,
} from "./checkout.helpers";

/**
 * Items mode on /terminal (Settings > Show Items in Checkout): the item grid
 * is the entry screen, the keypad is one tab away and adds Custom Amount
 * lines, and the basket total goes through the same coins sale as the
 * keypad. The lines land on the sale record and in History.
 */

test.describe("items mode checkout", () => {
  // The merchant switched Items mode on in an earlier session.
  test.use({ hostOptions: { storage: itemsModeStorage() } });

  test("tiles, a custom amount and the basket add up to the Charge total", async ({ host }) => {
    const frame = await bootItemsCheckout(host);

    // Items is the default tab; no keypad header in this mode.
    await expect(frame.getByRole("button", { name: "Items", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(frame.getByRole("heading", { name: "All Items" })).toBeVisible();
    await expect(frame.getByTestId("terminal-header")).toHaveCount(0);
    await expect(tile(frame, "Espresso")).toContainText(`2.50 ${SYM}`);
    await expect(tile(frame, "Croissant")).toContainText(`3.20 ${SYM}`);
    await expect(frame.getByTestId("items-charge")).toBeDisabled();
    await expect(cartBadge(frame)).toHaveCount(0);

    // Repeat taps merge into one line; the tile wears the quantity.
    await tile(frame, "Espresso").click();
    await tile(frame, "Espresso").click();
    await tile(frame, "Croissant").click();
    await expect(tile(frame, "Espresso")).toContainText("2Espresso");
    await expect(cartBadge(frame)).toHaveText("3");
    await expect(frame.getByTestId("items-charge")).toHaveText(`Charge 8.20 ${SYM}`);

    // Search narrows the grid.
    await frame.getByRole("textbox", { name: "Search items" }).fill("crois");
    await expect(tile(frame, "Croissant")).toBeVisible();
    await expect(tile(frame, "Espresso")).toHaveCount(0);
    await frame.getByRole("textbox", { name: "Search items" }).fill("zzz");
    await expect(frame.getByText("No items match your search.")).toBeVisible();
    await frame.getByRole("textbox", { name: "Search items" }).fill("");

    // Amount tab: the keypad adds a Custom Amount line and flips back.
    await frame.getByRole("button", { name: "Amount", exact: true }).click();
    await expect(frame.getByText("Enter Custom Amount")).toBeVisible();
    for (const d of ["1", "0", "5"]) await frame.getByTestId(`calc-digit-${d}`).click();
    await expect(frame.getByTestId("items-add-custom")).toHaveText(`Add 1.05 ${SYM}`);
    await frame.getByTestId("items-add-custom").click();
    await expect(frame.getByRole("heading", { name: "All Items" })).toBeVisible();
    await expect(cartBadge(frame)).toHaveText("4");
    await expect(frame.getByTestId("items-charge")).toHaveText(`Charge 9.25 ${SYM}`);

    // Basket: +/- per line, removing the last unit drops the line.
    await frame.getByTestId("cart-button").click();
    const main = frame.locator("main");
    await expect(main.getByText("Total", { exact: true })).toBeVisible();
    await expect(main).toContainText(`9.25 ${SYM}`);
    await expect(main.getByText("Custom Amount")).toBeVisible();
    await frame.getByRole("button", { name: "Add one Croissant" }).click();
    await expect(frame.getByTestId("items-charge")).toHaveText(`Charge 12.45 ${SYM}`);
    await frame.getByRole("button", { name: "Remove one Croissant" }).click();
    await frame.getByRole("button", { name: "Remove one Croissant" }).click();
    await expect(frame.getByRole("button", { name: "Remove one Croissant" })).toHaveCount(0);
    await expect(frame.getByTestId("items-charge")).toHaveText(`Charge 6.05 ${SYM}`);
    await expect(cartBadge(frame)).toHaveText("3");

    // Clear cart asks first; Keep cart keeps it, Clear all empties it.
    await frame.getByRole("button", { name: "Clear cart" }).click();
    await expect(frame.getByText("All 3 items will be removed.")).toBeVisible();
    await frame.getByRole("button", { name: "Keep cart" }).click();
    await expect(frame.getByText("All 3 items will be removed.")).toHaveCount(0);
    await expect(frame.getByTestId("items-charge")).toHaveText(`Charge 6.05 ${SYM}`);
    await frame.getByRole("button", { name: "Clear cart" }).click();
    await frame.getByRole("button", { name: "Clear all" }).click();
    await expect(frame.getByRole("heading", { name: "All Items" })).toBeVisible();
    await expect(cartBadge(frame)).toHaveCount(0);
    await expect(frame.getByTestId("items-charge")).toBeDisabled();
    await expect(frame.getByTestId("items-charge")).toHaveText(`Charge 0.00 ${SYM}`);
    // Nothing was charged.
    expect(host.all("topUp")).toHaveLength(0);
  });

  test("charging the basket completes a coins sale with the lines on the record and in History", async ({ host }) => {
    const frame = await bootItemsCheckout(host);
    await tile(frame, "Espresso").click();
    await tile(frame, "Espresso").click();
    await tile(frame, "Croissant").click();
    await frame.getByRole("button", { name: "Amount", exact: true }).click();
    for (const d of ["1", "0", "5"]) await frame.getByTestId(`calc-digit-${d}`).click();
    await frame.getByTestId("items-add-custom").click();

    const req = await chargeBasket(host, frame, "9.25");
    await expect(frame.getByTestId("qr-amount")).toHaveText("9.25");
    const topUp = await payAndComplete(host, frame, req);
    expect(topUp.amount).toBe(planck("9.25").toString());

    const sale = await waitForSale(host, req.id);
    expect(sale.amount).toBe("9.25");
    expect(sale.items).toEqual([
      { name: "Espresso", quantity: 2, unitPrice: "2.50" },
      { name: "Croissant", quantity: 1, unitPrice: "3.20" },
      { name: "Custom Amount", quantity: 1, unitPrice: "1.05" },
    ]);
    expect(sale.tip).toBeUndefined();

    // The receipt is itemized.
    await frame.getByRole("button", { name: "Review Receipt" }).click();
    const receipt = receiptSvg(frame);
    await expect(receipt).toContainText("2 × Espresso");
    await expect(receipt).toContainText("5.00");
    await expect(receipt).toContainText("1 × Croissant");
    await expect(receipt).toContainText("1 × Custom Amount");
    await expect(receipt).not.toContainText("1 × Amount");
    await frame.getByRole("button", { name: "Close receipt" }).click();

    // Done: back to the item grid with an empty basket.
    await frame.getByTestId("btn-done").click();
    await expect(frame.getByRole("heading", { name: "All Items" })).toBeVisible();
    await expect(cartBadge(frame)).toHaveCount(0);
    await expect(frame.getByTestId("items-charge")).toBeDisabled();
    await expect(tile(frame, "Espresso")).not.toContainText("2Espresso");

    // History detail lists the lines.
    await frame.getByRole("link", { name: "History", exact: true }).click();
    const row = frame.getByTestId(`history-row-${req.id.slice(-4)}`);
    await expect(row).toContainText("9.25");
    await row.click();
    await expect(frame.getByTestId("history-detail-status")).toContainText("Received");
    await expect(frame.getByText("2x Espresso")).toBeVisible();
    await expect(frame.getByText(`5.00 ${SYM}`)).toBeVisible();
    await expect(frame.getByText("1x Croissant")).toBeVisible();
    await expect(frame.getByText(`3.20 ${SYM}`)).toBeVisible();
    await expect(frame.getByText("1x Custom Amount")).toBeVisible();
    await expect(frame.getByText(`1.05 ${SYM}`)).toBeVisible();
    await expect(frame.getByText("Tip", { exact: true })).toHaveCount(0);
  });

  test("a failed pre-flight keeps the basket, and it charges once the host can take payments", async ({ host }) => {
    const frame = await bootItemsCheckout(host);
    await tile(frame, "Croissant").click();
    await tile(frame, "Espresso").click();
    await expect(frame.getByTestId("items-charge")).toHaveText(`Charge 5.70 ${SYM}`);

    // The host's payments bridge stops taking payments. The Charge probes it
    // at once (the periodic probe is 15 s apart) and shows no QR.
    const warning = frame.getByTestId("terminal-connectivity-warning");
    await expect(warning).toHaveCount(0);
    await host.setBalanceMode("Unsupported");
    const since = host.mark();
    await Promise.all([
      host.next("balanceSubscribe", undefined, { since, timeout: 1_500 }),
      frame.getByTestId("items-charge").click(),
    ]);
    await expect(warning).toContainText("This Polkadot app build can't take coin payments");
    // Back on the grid with the basket intact.
    await expect(frame.getByRole("heading", { name: "All Items" })).toBeVisible();
    await expect(cartBadge(frame)).toHaveText("2");
    await expect(frame.getByTestId("items-charge")).toHaveText(`Charge 5.70 ${SYM}`);
    // No cheque was armed: no statement subscription since the Charge.
    expect(host.events.slice(since).filter((e) => e.type === "statementSubscribe")).toHaveLength(0);
    expect(await frame.getByTestId("qr-code").count()).toBe(0);
    expect(host.all("topUp")).toHaveLength(0);

    // The Amount tab comes back clean (the basket's digits were dropped).
    await frame.getByRole("button", { name: "Amount", exact: true }).click();
    await expect(frame.getByTestId("amount-display")).toContainText("0.00");
    await frame.getByRole("button", { name: "Items", exact: true }).click();

    // Payments are back: the same basket charges and completes.
    await host.setBalanceMode("send");
    const req = await chargeBasket(host, frame, "5.70");
    await expect(warning).toHaveCount(0);
    await payAndComplete(host, frame, req);
    const sale = await waitForSale(host, req.id);
    expect(sale.items).toEqual([
      { name: "Croissant", quantity: 1, unitPrice: "3.20" },
      { name: "Espresso", quantity: 1, unitPrice: "2.50" },
    ]);
  });
});

test.describe("items mode settings", () => {
  test("Settings > Show Items in Checkout: add, edit and remove items; it all survives a restart", async ({ host }) => {
    await bootTerminal(host);
    await openRoute(host, "/settings/items");
    const frame = host.productFrame();

    const toggle = frame.getByRole("switch", { name: "Show Items in Checkout" });
    await expect(toggle).toBeEnabled();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(frame.getByText("No items yet. Add the products you sell")).toBeVisible();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect.poll(() => settingValue(host, "checkout-items/enabled")).toBe("1");

    // Add: Save waits for a name and a valid price; "3,5" is normalized.
    await frame.getByRole("button", { name: "Add item" }).click();
    await expect(frame.getByText("Add Item", { exact: true })).toBeVisible();
    const save = frame.getByRole("button", { name: "Save" });
    await expect(save).toBeDisabled();
    await frame.locator("#item-name").fill("Flat white");
    await frame.locator("#item-price").fill("0");
    await expect(save).toBeDisabled();
    await frame.locator("#item-price").fill("3,5");
    await frame.locator("#item-tax").selectOption("10");
    await expect(save).toBeEnabled();
    await save.click();
    const row = (name: string) => frame.locator("main").getByRole("button").filter({ hasText: name });
    await expect(row("Flat white")).toContainText("Each · 10% tax");
    await expect(row("Flat white")).toContainText(`3.50 ${SYM}`);

    await frame.getByRole("button", { name: "Add item" }).click();
    await frame.locator("#item-name").fill("Bagel");
    await frame.locator("#item-price").fill("2");
    await frame.locator("#item-unit").selectOption("kg");
    await save.click();
    await expect(row("Bagel")).toContainText("kg · 23% tax");
    await expect(row("Bagel")).toContainText(`2.00 ${SYM}`);

    await frame.getByRole("button", { name: "Add item" }).click();
    await frame.locator("#item-name").fill("Tea");
    await frame.locator("#item-price").fill("1.80");
    await save.click();
    await expect(row("Tea")).toBeVisible();

    // Edit Bagel's price; remove Tea.
    await row("Bagel").click();
    await expect(frame.getByText("Edit Item", { exact: true })).toBeVisible();
    await expect(frame.locator("#item-name")).toHaveValue("Bagel");
    await frame.locator("#item-price").fill("2.25");
    await save.click();
    await expect(row("Bagel")).toContainText(`2.25 ${SYM}`);
    await row("Tea").click();
    await frame.getByRole("button", { name: "Remove item" }).click();
    await expect(row("Tea")).toHaveCount(0);

    // What the host stores.
    const stored = async () => JSON.parse((await settingValue(host, "checkout-items/list")) ?? "[]") as CatalogItem[];
    await expect.poll(async () => (await stored()).map((i) => i.name)).toEqual(["Flat white", "Bagel"]);
    const list = await stored();
    expect(list.map(({ name, price, unit, taxRate }) => ({ name, price, unit, taxRate }))).toEqual([
      { name: "Flat white", price: "3.50", unit: "Each", taxRate: 10 },
      { name: "Bagel", price: "2.25", unit: "kg", taxRate: 23 },
    ]);
    expect(new Set(list.map((i) => i.id)).size).toBe(2);

    // After a restart: Settings shows the same state…
    await openRoute(host, "/settings/items");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(row("Flat white")).toContainText(`3.50 ${SYM}`);
    await expect(row("Bagel")).toContainText(`2.25 ${SYM}`);
    await expect(row("Tea")).toHaveCount(0);

    // …and Check out opens on the item grid with those items.
    await openRoute(host, "/terminal");
    await expect(frame.getByRole("heading", { name: "All Items" })).toBeVisible();
    await expect(tile(frame, "Flat white")).toContainText(`3.50 ${SYM}`);
    await expect(tile(frame, "Bagel")).toContainText(`2.25 ${SYM}`);
    await expect(tile(frame, "Tea")).toHaveCount(0);

    // Switching it off brings the plain keypad back.
    await openRoute(host, "/settings/items");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect.poll(() => settingValue(host, "checkout-items/enabled")).toBe("0");
    await openRoute(host, "/terminal");
    await expect(frame.getByTestId("terminal-header")).toBeVisible();
    await expect(frame.getByTestId("items-charge")).toHaveCount(0);
  });
});

test.describe("items mode with an empty catalog", () => {
  test.use({ hostOptions: { storage: settingsSeed({ "checkout-items/enabled": "1" }) } });

  test("an empty catalog points to Settings, and the Amount tab still charges", async ({ host }) => {
    const frame = await bootItemsCheckout(host);
    await expect(frame.getByText("No items yet — add them in")).toBeVisible();
    await expect(frame.getByRole("link", { name: "Settings → Show Items in Checkout" })).toHaveAttribute("href", /^\/settings\/items\/?$/);

    await frame.getByRole("button", { name: "Amount", exact: true }).click();
    for (const d of ["4", "0", "0"]) await frame.getByTestId(`calc-digit-${d}`).click();
    await frame.getByTestId("items-add-custom").click();
    const req = await chargeBasket(host, frame, "4.00");
    await payAndComplete(host, frame, req);
    expect((await waitForSale(host, req.id)).items).toEqual([{ name: "Custom Amount", quantity: 1, unitPrice: "4.00" }]);
  });
});
