import { test, expect } from "../host/fixture";
import { bootTerminal, planck, topicHex, waitForSale } from "../host/flows";
import {
  SYM,
  decodeQrIn,
  openRoute,
  payAndComplete,
  productFrameHandle,
  productPath,
  readPendingSale,
  stashPendingSale,
} from "./checkout.helpers";

/**
 * The legacy URL-only path: /items (catalog) -> /tips?subtotal ->
 * /terminal?amount&source=items&tip. The /items catalog is fed only by the
 * retired admin-QR binding, so on this build it is always empty; the specs
 * start from the handoff its Charge leaves behind (the cart in
 * sessionStorage "t3rminal:pending-sale" plus /tips?subtotal=<planck>).
 * Every location change is followed by host.settle (the frame can reload).
 */

const LINES = [
  { name: "Flat white", pricePlanks: planck("3.50").toString(), quantity: 2 },
  { name: "Muffin", pricePlanks: planck("2.70").toString(), quantity: 1 },
];

test.describe("legacy items -> tips -> terminal", () => {
  test("/items shows the empty catalog while no admin config is bound", async ({ host }) => {
    await bootTerminal(host);
    await openRoute(host, "/items");
    const frame = host.productFrame();
    await expect(frame.getByRole("heading", { name: "No items yet" })).toBeVisible();
    await expect(frame.getByRole("link", { name: "Go to Check out" })).toBeVisible();
    await expect(frame.getByRole("button", { name: "Add items to charge" })).toBeDisabled();
    await expect(frame.getByText("Cart · 0 items")).toBeVisible();
  });

  test("an admin-QR import does not bring the /items catalog back (binding retired)", async ({ host }) => {
    await bootTerminal(host);
    const doc = productFrameHandle(host);
    await doc.waitForFunction(() => !!(window as unknown as { __T3R_TEST__?: unknown }).__T3R_TEST__);
    await doc.evaluate(async () => {
      const t = (window as unknown as { __T3R_TEST__: { importAdminQrConfig: (p: unknown, raw: string) => Promise<void> } }).__T3R_TEST__;
      await t.importAdminQrConfig({
        v: 2, type: "t3rminal-config", merchantKey: "mk", merchantId: "m-1", terminalId: "t-1",
        displayName: "Cafe", receivingAddress: "", passwordScheme: "none", reportPassword: "",
        issuedAt: new Date().toISOString(), priceDecimals: 6,
        config: {
          id: "cfg-1", name: "Drinks", updatedAt: new Date().toISOString(),
          items: [{ id: "i-1", name: "Flat white", pricePlancks: "3500000", price: 3.5 }],
        },
      }, "ur:t3rminal-config/test");
    });
    // The import still writes the legacy tables…
    await expect.poll(async () => ((await host.getStorage<unknown[]>("item-catalog")) ?? []).length).toBe(1);

    // …but /items derives its catalog from the (retired, always-null)
    // binding and wipes those tables: the menu stays empty.
    await openRoute(host, "/items");
    const frame = host.productFrame();
    await expect(frame.getByRole("heading", { name: "No items yet" })).toBeVisible();
    await expect(frame.getByRole("button", { name: /Flat white/ })).toHaveCount(0);
    await expect.poll(async () => ((await host.getStorage<unknown[]>("item-catalog")) ?? []).length).toBe(0);
  });

  test("a 10% tip: the QR asks for subtotal + tip, the sale keeps items and tip, Done returns to /items", async ({ host }) => {
    await bootTerminal(host);
    const subtotal = await stashPendingSale(host, LINES);
    expect(subtotal).toBe(planck("9.70"));
    await openRoute(host, `/tips?subtotal=${subtotal}`);
    const frame = host.productFrame();

    await expect(frame.getByText("Add tip", { exact: true })).toBeVisible();
    await expect(frame.getByText("Bill", { exact: true })).toBeVisible();
    await expect(frame.locator("main")).toContainText(`9.70 ${SYM}`);
    for (const pct of ["5%", "7%", "10%", "0%"]) await expect(frame.getByRole("button", { name: pct, exact: true })).toBeVisible();

    const since = host.mark();
    await frame.getByRole("button", { name: "10%", exact: true }).click();
    await expect.poll(() => productPath(host)).toMatch(/^\/terminal\/?$/);
    await host.settle();
    const params = new URL(productFrameHandle(host).url()).searchParams;
    expect(params.get("amount")).toBe(planck("10.67").toString());
    expect(params.get("source")).toBe("items");
    expect(params.get("tip")).toBe(planck("0.97").toString());

    // Straight to the QR: the cheque is for subtotal + tip.
    const req = await host.readChequeRequest();
    expect(req.amount).toBe("10.67");
    await expect(frame.getByTestId("qr-amount")).toHaveText("10.67");
    await expect(frame.getByTestId("waiting-text")).toHaveText("Scan QR to pay");
    await host.next("statementSubscribe", (e) => e.topics.includes(topicHex(req.id)), { since });

    const topUp = await payAndComplete(host, frame, req);
    expect(topUp.amount).toBe(planck("10.67").toString());
    const sale = await waitForSale(host, req.id);
    expect(sale.amount).toBe("10.67");
    expect(sale.tip).toBe("0.97");
    expect(sale.items).toEqual([
      { name: "Flat white", quantity: 2, unitPrice: "3.50" },
      { name: "Muffin", quantity: 1, unitPrice: "2.70" },
    ]);
    // The handoff is consumed with the sale.
    expect(await readPendingSale(host)).toBeNull();

    // Receipt: itemized, with the Subtotal / Tip / Total breakdown.
    await frame.getByRole("button", { name: "Review Receipt" }).click();
    const receipt = frame.locator("main svg").first();
    await expect(receipt).toContainText("2 × Flat white");
    await expect(receipt).toContainText("7.00");
    await expect(receipt).toContainText("1 × Muffin");
    await expect(receipt).toContainText(`Subtotal ${SYM}`);
    await expect(receipt).toContainText("9.70");
    await expect(receipt).toContainText(`Tip ${SYM}`);
    await expect(receipt).toContainText("0.97");
    await expect(receipt).toContainText("10.67");
    await frame.getByRole("button", { name: "Close receipt" }).click();

    // The share envelope carries the tip and the lines.
    await frame.getByRole("button", { name: "Share receipt QR" }).click();
    const shared = new URL((await decodeQrIn(frame.locator("main svg").last())).replace(/^polkadotapp:\/\//, "https://"));
    expect(shared.searchParams.get("a")).toBe("10.67");
    expect(shared.searchParams.get("tp")).toBe("0.97");
    expect(shared.searchParams.getAll("i")).toEqual(["Flat white|2|3.50", "Muffin|1|2.70"]);
    await frame.getByRole("button", { name: "Back to payment" }).click();

    // Done goes back to the items menu, not the keypad.
    await frame.getByTestId("btn-done").click();
    await expect.poll(() => productPath(host)).toMatch(/^\/items\/?$/);
    await host.settle();
    await expect(frame.getByRole("heading", { name: "No items yet" })).toBeVisible();

    // History shows the breakdown.
    await frame.getByRole("link", { name: "History", exact: true }).click();
    const row = frame.getByTestId(`history-row-${req.id.slice(-4)}`);
    await expect(row).toContainText("10.67");
    await row.click();
    await expect(frame.getByTestId("history-detail-status")).toContainText("Received");
    await expect(frame.getByText("2x Flat white")).toBeVisible();
    await expect(frame.getByText("1x Muffin")).toBeVisible();
    const detail = frame.locator("main");
    await expect(detail.getByText("Subtotal", { exact: true })).toBeVisible();
    await expect(detail).toContainText(`9.70 ${SYM}`);
    await expect(detail.getByText("Tip", { exact: true })).toBeVisible();
    await expect(detail).toContainText(`0.97 ${SYM}`);
    await expect(detail).toContainText(`10.67 ${SYM}`);
  });

  test("a 0% tip charges the subtotal and records no tip", async ({ host }) => {
    await bootTerminal(host);
    const subtotal = await stashPendingSale(host, LINES);
    await openRoute(host, `/tips?subtotal=${subtotal}`);
    const frame = host.productFrame();
    await frame.getByRole("button", { name: "0%", exact: true }).click();
    await expect.poll(() => productPath(host)).toMatch(/^\/terminal\/?$/);
    await host.settle();
    const params = new URL(productFrameHandle(host).url()).searchParams;
    expect(params.get("amount")).toBe(subtotal.toString());
    expect(params.get("tip")).toBeNull();

    const req = await host.readChequeRequest();
    expect(req.amount).toBe("9.70");
    await payAndComplete(host, frame, req);
    const sale = await waitForSale(host, req.id);
    expect(sale.amount).toBe("9.70");
    expect(sale.tip).toBeUndefined();
    expect(sale.items).toHaveLength(2);
  });

  test("/tips without a usable subtotal redirects to /items", async ({ host }) => {
    await bootTerminal(host);
    const frame = host.productFrame();

    await openRoute(host, "/tips");
    await expect.poll(() => productPath(host)).toMatch(/^\/items\/?$/);
    await expect(frame.getByRole("heading", { name: "No items yet" })).toBeVisible();
    await expect(frame.getByText("Add tip", { exact: true })).toHaveCount(0);

    await openRoute(host, "/tips?subtotal=abc");
    await expect.poll(() => productPath(host)).toMatch(/^\/items\/?$/);
    await expect(frame.getByRole("heading", { name: "No items yet" })).toBeVisible();
    // Nothing was armed on the way.
    expect(host.all("statementSubscribe")).toHaveLength(0);
  });
});
