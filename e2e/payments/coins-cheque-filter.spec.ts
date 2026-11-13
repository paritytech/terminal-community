import { test, expect, type T3Host } from "../host/fixture";
import type { FrameLocator } from "@playwright/test";
import { bootTerminal, charge, chargeAndPay, enterAmount, hexOf, planck, storedSales, topicHex, topUpIdHex, waitForSale } from "../host/flows";
import { buildCheque, randomCoins, topicFor, type ChequeRequest } from "../host/payer";
import { coinageLog, coinsHex, strangerKey } from "./cheques.helpers";

/**
 * The terminal listens on its payment topic, where anyone can post. Only a
 * cheque for THIS request (its id, its exact amount, sealed to its QR key)
 * may start a claim, and one sale is claimed at most once however many
 * copies of the cheque arrive.
 */

type FrameLoc = Awaited<ReturnType<typeof bootTerminal>>;

/**
 * Inject several statements in one host task, so they reach the app back to
 * back. T3Host only injects one statement per evaluate, and two evaluates may
 * let the app handle the first before the second is even posted.
 */
async function injectTogether(host: { page: import("@playwright/test").Page }, topic: Uint8Array, datas: Uint8Array[]) {
  const t = hexOf(topic);
  const ds = datas.map(hexOf);
  await host.page.evaluate(([t, ds]) => {
    const h = (window as unknown as { __T3_HOST__: { injectStatement(topics: string[], data: string): void } }).__T3_HOST__;
    for (const d of ds) h.injectStatement([t], d);
  }, [t, ds] as const);
}

/** The QR is still up for the same request and nothing was claimed. */
async function expectStillWaiting(host: Parameters<typeof charge>[0], frame: FrameLoc, req: ChequeRequest) {
  await expect(frame.locator('[data-testid="waiting-text"]')).toHaveText("Scan QR to pay");
  await expect(frame.locator('[data-testid="qr-code"]')).toHaveAttribute("data-qr-value", req.raw);
  await expect(frame.locator('[data-testid="coins-claiming"]')).toHaveCount(0);
  await expect(frame.locator('[data-testid="btn-cancel-transaction"]')).toBeVisible();
  expect(host.all("topUp")).toHaveLength(0);
  expect(await host.getTopUps()).toHaveLength(0);
}

/** Pay `req` properly and check that this — and only this — cheque was claimed. */
async function payAndExpectSingleClaim(host: Parameters<typeof charge>[0], frame: FrameLoc, req: ChequeRequest) {
  const since = host.mark();
  const { coins } = await host.pay({ req });
  const topUp = await host.waitForTopUp({ since });
  expect(topUp.idHex).toBe(topUpIdHex(req.id, 1));
  expect(topUp.amount).toBe(planck(req.amount).toString());
  expect(topUp.source).toEqual({ tag: "Coins", keys: coinsHex(coins) });
  await expect(frame.locator('[data-testid="payment-completed"]')).toHaveText("Payment received");
  await expect(frame.locator('[data-testid="sale-id"]')).toHaveText(`#${req.id.slice(-4)}`);
  const sale = await waitForSale(host, req.id);
  expect(sale.amount).toBe(req.amount);
  expect(host.all("topUp")).toHaveLength(1);
  expect(await storedSales(host)).toHaveLength(1);
}

test.describe("coins cheque filter — cheques the terminal must ignore", () => {
  const otherId = "0123456789abcdef0123456789abcdef";
  const cases: Array<{ name: string; data: (req: ChequeRequest) => Uint8Array; log: (req: ChequeRequest) => RegExp }> = [
    {
      name: "a cheque for a different amount (12.00 for 12.50)",
      data: (req) => buildCheque(req, randomCoins(2), { amount: "12.00" }).data,
      log: () => /amount mismatch: got "12\.00", want "12\.50" — skip/,
    },
    {
      name: 'a cheque whose amount is "12.5" (not the two-decimal wire shape)',
      data: (req) => buildCheque(req, randomCoins(2), { amount: "12.5" }).data,
      log: () => /decrypt failed \(len=\d+\): .*amount must match/,
    },
    {
      name: "a cheque for another payment id on this topic",
      data: (req) => buildCheque(req, randomCoins(2), { id: otherId }).data,
      log: () => new RegExp(`id mismatch: got "${otherId}", want "[0-9a-f]{32}" — skip`),
    },
    {
      name: "a cheque sealed to another terminal's key",
      data: (req) => buildCheque({ ...req, key: strangerKey() }, randomCoins(2)).data,
      log: () => /decrypt failed \(len=\d+\)/,
    },
    {
      name: "a statement carrying random bytes",
      data: () => crypto.getRandomValues(new Uint8Array(140)),
      log: () => /decrypt failed \(len=140\)/,
    },
    {
      name: "a statement with no data",
      data: () => new Uint8Array(0),
      log: () => /statement has no data — skip/,
    },
  ];

  for (const c of cases) {
    test(`ignores ${c.name}, then takes the real cheque`, async ({ host }) => {
      const log = coinageLog(host);
      const frame = await bootTerminal(host);
      const req = await charge(host, frame, "12.50");

      const seen = log.mark();
      await host.injectStatement(topicFor(req.id), c.data(req));
      // The terminal looked at it and said why it skipped it…
      await log.waitFor(c.log(req), seen);
      expect(log.lines.slice(seen).some((l) => l.includes("match!"))).toBe(false);
      // …and nothing moved: same QR, no claim registered with the host.
      await expectStillWaiting(host, frame, req);

      // The genuine cheque still goes through, on the very same subscription.
      await payAndExpectSingleClaim(host, frame, req);
      expect(host.all("statementSubscribe").filter((e) => e.topics.includes(topicHex(req.id)))).toHaveLength(1);
    });
  }

  test("ignores every bad cheque in a row and claims only the real one", async ({ host }) => {
    const log = coinageLog(host);
    const frame = await bootTerminal(host);
    const req = await charge(host, frame, "12.50");

    const seen = log.mark();
    await injectTogether(host, topicFor(req.id), cases.map((c) => c.data(req)));
    for (const c of cases) await log.waitFor(c.log(req), seen);
    await expectStillWaiting(host, frame, req);

    await payAndExpectSingleClaim(host, frame, req);
  });
});

test.describe("coins cheque filter — one sale, one claim", () => {
  test("two valid cheques arriving back to back are claimed once", async ({ host }) => {
    const frame = await bootTerminal(host);
    const req = await charge(host, frame, "8.40");
    const first = randomCoins(2);
    const second = randomCoins(3);

    const since = host.mark();
    await injectTogether(host, topicFor(req.id), [buildCheque(req, first).data, buildCheque(req, second).data]);
    const topUp = await host.waitForTopUp({ since });
    expect(topUp.source).toEqual({ tag: "Coins", keys: coinsHex(first) });
    expect(topUp.idHex).toBe(topUpIdHex(req.id, 1));

    await expect(frame.locator('[data-testid="payment-completed"]')).toHaveText("Payment received");
    await waitForSale(host, req.id);
    expect(host.all("topUp")).toHaveLength(1);
    expect(await storedSales(host)).toHaveLength(1);
  });

  test.describe("with the claim held by the host", () => {
    test.use({ hostOptions: { topUpScript: "manual" } });

    test("the same cheque re-sent while claiming and after payment is claimed once", async ({ host }) => {
      const frame = await bootTerminal(host);
      const req = await charge(host, frame, "6.00");
      const coins = randomCoins(2);
      const { topic, data } = buildCheque(req, coins);

      const since = host.mark();
      await host.injectStatement(topic, data);
      const topUp = await host.waitForTopUp({ since });
      const claiming = frame.locator('[data-testid="coins-claiming"]');
      await expect(claiming).toContainText("Handing the payment to the Polkadot app");

      // While the claim runs: the customer's app re-posts the same statement.
      await host.injectStatement(topic, data);
      // Statuses travel the same channel after it, so once the UI shows this
      // stage the duplicate has been delivered — and dropped.
      await host.emitTopUpStatus(topUp.idHex, { tag: "Detecting" });
      await expect(claiming).toContainText("Waiting for the coins to reach the chain");
      expect(host.all("topUp")).toHaveLength(1);

      await host.emitTopUpStatus(topUp.idHex, { tag: "Claimed", finalized: false });
      await expect(frame.locator('[data-testid="payment-completed"]')).toHaveText("Payment received");
      await waitForSale(host, req.id);

      // After payment: once more.
      await host.injectStatement(topic, data);
      await frame.locator('[data-testid="btn-done"]').click();
      await expect(frame.locator('[data-testid="terminal-header"]')).toBeVisible();

      // The next sale is the barrier: its claim is the second and last one.
      const next = await chargeAndPay(host, frame, "2.00");
      expect(next.topUp.idHex).toBe(topUpIdHex(next.req.id, 1));
      const ids = host.all("topUp").map((e) => e.record.idHex);
      expect(ids).toEqual([topUpIdHex(req.id, 1), topUpIdHex(next.req.id, 1)]);
      const sales = await storedSales(host);
      expect(sales.filter((s) => s.saleId === req.id)).toHaveLength(1);
    });
  });

  // The terminal shows its QR before it subscribes to the payment topic. With
  // the host holding new subscriptions, the customer pays first, and the
  // cheque reaches the terminal through the store's replay on release, as it
  // would from a real store that already holds it.
  test.describe("cheques already in the store", () => {
    /** Charge with the host holding the subscription; returns the QR's request. */
    async function chargeBeforeSubscribe(host: T3Host, frame: FrameLocator, amount: string) {
      await host.holdStatementSubscriptions(true);
      const since = host.mark();
      await enterAmount(frame, amount);
      await frame.locator('[data-testid="btn-charge"]').click();
      const req = await host.readChequeRequest();
      // The subscription was asked for but is not open yet.
      await host.next("statementSubscribe", (e) => e.topics.includes(topicHex(req.id)), { since });
      expect(await host.statementSubscriberCount(topicHex(req.id))).toBe(0);
      return { req, since };
    }

    test("a cheque posted before the terminal subscribes is replayed and claimed", async ({ host }) => {
      const log = coinageLog(host);
      const frame = await bootTerminal(host);
      const seen = log.mark();
      const { req, since } = await chargeBeforeSubscribe(host, frame, "5.75");
      const coins = randomCoins(2);
      const { topic, data } = buildCheque(req, coins);
      await host.injectStatement(topic, data);
      expect(host.events.slice(since).filter((e) => e.type === "topUp")).toHaveLength(0);

      await host.holdStatementSubscriptions(false);
      // It came in the subscription's first page (the store's replay).
      await log.waitFor(/page: 1 statement\(s\), isComplete=true/, seen);
      const topUp = await host.waitForTopUp({ since });
      expect(topUp.idHex).toBe(topUpIdHex(req.id, 1));
      expect(topUp.amount).toBe(planck("5.75").toString());
      expect(topUp.source).toEqual({ tag: "Coins", keys: coinsHex(coins) });

      await expect(frame.locator('[data-testid="payment-completed"]')).toHaveText("Payment received");
      await expect(frame.locator('[data-testid="sale-id"]')).toHaveText(`#${req.id.slice(-4)}`);
      const sale = await waitForSale(host, req.id);
      expect(sale).toMatchObject({ amount: "5.75", amountPlanck: planck("5.75").toString(), topUpId: topUp.idHex.slice(2) });
      expect(host.all("topUp")).toHaveLength(1);
    });

    test("two valid cheques already in the store reach the terminal in one page and are claimed once", async ({ host }) => {
      const log = coinageLog(host);
      const frame = await bootTerminal(host);
      const seen = log.mark();
      const { req, since } = await chargeBeforeSubscribe(host, frame, "3.30");
      const first = randomCoins(2);
      const second = randomCoins(2);
      await host.injectStatement(topicFor(req.id), buildCheque(req, first).data);
      await host.injectStatement(topicFor(req.id), buildCheque(req, second).data);

      await host.holdStatementSubscriptions(false);
      // Both arrive in the subscription's first page; the first one wins.
      await log.waitFor(/page: 2 statement\(s\), isComplete=true/, seen);
      const topUp = await host.waitForTopUp({ since });
      expect(topUp.idHex).toBe(topUpIdHex(req.id, 1));
      expect(topUp.source).toEqual({ tag: "Coins", keys: coinsHex(first) });
      await expect(frame.locator('[data-testid="payment-completed"]')).toHaveText("Payment received");
      await expect(frame.locator('[data-testid="sale-id"]')).toHaveText(`#${req.id.slice(-4)}`);
      await waitForSale(host, req.id);
      expect(host.all("topUp")).toHaveLength(1);
      expect(await storedSales(host)).toHaveLength(1);
    });
  });
});
