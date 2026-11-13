import { test, expect } from "../host/fixture";
import type { T3Host } from "../host/fixture";
import { bootTerminal, chargeAndPay, storedSales, topUpIdHex, waitForSale } from "../host/flows";
import type { Hex } from "../host/protocol";
import { captureConsole } from "./resilience.helpers";

/**
 * The host dropping a top-up status subscription. During the claim the
 * terminal waits 4 s, re-registers the SAME id (the host answers
 * AlreadyExists) and subscribes again, up to 3 times (claim.ts
 * DEFAULT_MAX_RESUBSCRIBES / DEFAULT_CLAIM_BACKOFF_MS). The background
 * watcher re-subscribes after 5 s, up to 5 times, without registering again
 * (topup-watcher.ts). These run on the app's own backoff timers.
 */

const DROP = { Unknown: "test: status stream dropped" } as const;

/** Wait for the next live status subscription on `idHex` after `since`, then drop it. */
async function dropNextSubscription(host: T3Host, idHex: Hex, since: number) {
  await host.next("topUpStatusSubscribe", (e) => e.idHex === idHex, { since, timeout: 20_000 });
  await expect.poll(() => host.topUpSubscriberCount(idHex)).toBe(1);
  const at = host.mark();
  await host.interruptTopUpStatus(idHex, DROP);
  return at;
}

test.describe("coins status subscription — resubscribe", () => {
  test.slow();

  test("one drop mid-claim: re-register the same id, follow it again, complete", async ({ host }) => {
    const logs = captureConsole(host.page);
    await host.setTopUpScript("manual");
    const frame = await bootTerminal(host);
    const { req, topUp } = await chargeAndPay(host, frame, "12.50");
    const id1 = topUpIdHex(req.id, 1);
    expect(topUp.idHex).toBe(id1);

    await host.next("topUpStatusSubscribe", (e) => e.idHex === id1);
    await host.emitTopUpStatus(id1, { tag: "Detecting" });
    const claiming = frame.locator('[data-testid="coins-claiming"]');
    await expect(claiming).toContainText("Waiting for the coins to reach the chain");

    const dropped = await dropNextSubscription(host, id1, 0);
    const droppedAt = Date.now();
    // The terminal keeps the merchant on the claim, no error.
    await expect(claiming).toBeVisible();
    await expect(frame.locator('[data-testid="coins-claim-error"]')).toHaveCount(0);

    // ~4 s later: the same id again — the host already has it.
    const again = await host.waitForTopUp({ since: dropped, timeout: 15_000 });
    expect(Date.now() - droppedAt).toBeGreaterThan(3_000);
    expect(again.idHex).toBe(id1);
    expect(again.answer).toBe("AlreadyExists");
    const resub = await host.next("topUpStatusSubscribe", (e) => e.idHex === id1, { since: dropped });
    expect(resub.known).toBe(true);
    await expect.poll(() => logs.some((l) => /status subscription dropped .* re-subscribing \(1\)/.test(l))).toBe(true);
    // The host replays the latest status to the new subscriber.
    await expect(claiming).toContainText("Waiting for the coins to reach the chain");
    await expect(claiming).not.toContainText("retry");

    await host.emitTopUpStatus(id1, { tag: "Claimed", finalized: true });
    await expect(frame.locator('[data-testid="payment-completed"]')).toHaveText("Payment received");
    const sale = await waitForSale(host, req.id, (s) => !!s.finalizedAt);
    expect(sale.topUpId).toBe(id1.slice(2));
    // Only one registration ever existed on the host.
    expect(await host.getTopUps()).toHaveLength(1);
    expect(host.all("topUp").map((e) => e.record.answer)).toEqual(["accept", "AlreadyExists"]);
  });

  test("more than 3 drops: timeout copy; Retry finds the coins busy and follows attempt 1", async ({ host }) => {
    await host.setTopUpScript("manual");
    const frame = await bootTerminal(host);
    const { req } = await chargeAndPay(host, frame, "6.00");
    const id1 = topUpIdHex(req.id, 1);
    const id2 = topUpIdHex(req.id, 2);

    // The first subscription plus 3 re-subscribes, each dropped.
    let since = 0;
    for (let i = 0; i < 4; i++) since = await dropNextSubscription(host, id1, since);

    await expect(frame.locator('[data-testid="waiting-text"]')).toHaveText("Claim didn't finish", { timeout: 15_000 });
    await expect(frame.locator('[data-testid="coins-claim-error"]')).toHaveText(
      "The coins haven't reached the chain yet. If the Polkadot app is showing a message, dismiss it, then retry.",
    );
    // Each re-subscribe re-registered attempt 1; no fifth subscription came.
    expect(host.all("topUp").map((e) => [e.record.idHex, e.record.answer])).toEqual([
      [id1, "accept"], [id1, "AlreadyExists"], [id1, "AlreadyExists"], [id1, "AlreadyExists"],
    ]);
    expect(host.all("topUpStatusSubscribe").filter((e) => e.idHex === id1)).toHaveLength(4);
    // A failed claim records nothing.
    expect((await storedSales(host)).some((s) => s.saleId === req.id)).toBe(false);

    // Retry registers attempt 2 with the same coins; attempt 1 still holds
    // them, so the host answers SourceBusy and the terminal follows attempt 1.
    const retryAt = host.mark();
    await frame.locator('[data-testid="btn-retry-claim"]').click();
    const retry = await host.waitForTopUp({ since: retryAt });
    expect(retry.idHex).toBe(id2);
    expect(retry.answer).toBe("SourceBusy");
    await host.next("topUpStatusSubscribe", (e) => e.idHex === id1, { since: retryAt });
    expect(host.events.slice(retryAt).some((e) => e.type === "topUpStatusSubscribe" && e.idHex === id2)).toBe(false);
    await expect(frame.locator('[data-testid="coins-claiming"]')).toContainText("· retry 1");

    await host.emitTopUpStatus(id1, { tag: "Claimed", finalized: true });
    await expect(frame.locator('[data-testid="payment-completed"]')).toHaveText("Payment received");
    const sale = await waitForSale(host, req.id, (s) => !!s.finalizedAt);
    expect(sale.topUpId).toBe(id1.slice(2));
    expect((await host.getTopUps()).map((t) => t.idHex)).toEqual([id1]);
  });

  test("a dropped watcher re-subscribes after ~5 s and still finalizes the sale", async ({ host }) => {
    await host.setTopUpScript("manual");
    const frame = await bootTerminal(host);
    const { req, topUp } = await chargeAndPay(host, frame, "9.00");
    await host.next("topUpStatusSubscribe", (e) => e.idHex === topUp.idHex);
    const claimedAt = host.mark();
    await host.emitTopUpStatus(topUp.idHex, { tag: "Claimed", finalized: false });
    await expect(frame.locator('[data-testid="payment-completed"]')).toBeVisible();
    await waitForSale(host, req.id);

    // The watcher's own subscription, opened after the claim's closed.
    const dropped = await dropNextSubscription(host, topUp.idHex, claimedAt);
    const droppedAt = Date.now();
    const resub = await host.next("topUpStatusSubscribe", (e) => e.idHex === topUp.idHex, { since: dropped, timeout: 15_000 });
    expect(Date.now() - droppedAt).toBeGreaterThan(4_000);
    expect(resub.known).toBe(true);
    // The watcher follows; it never registers the claim again.
    expect(host.all("topUp")).toHaveLength(1);
    expect((await waitForSale(host, req.id)).finalizedAt).toBeUndefined();

    await host.emitTopUpStatus(topUp.idHex, { tag: "Claimed", finalized: true });
    const sale = await waitForSale(host, req.id, (s) => !!s.finalizedAt);
    expect(sale.revertedAt).toBeUndefined();
    expect(sale.topUpId).toBe(topUp.idHex.slice(2));
  });
});
