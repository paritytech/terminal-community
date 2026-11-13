import { test, expect } from "../host/fixture";
import type { FrameLocator } from "@playwright/test";
import { bootTerminal } from "../host/flows";
import {
  OTHER_MERCHANT,
  noonDaysAgo,
  saleIdFor,
  seedSalesAndOpen,
  topUpIdFor,
  type SeedSale,
} from "./screens.helpers";

/**
 * History and Home read the sale rows in host storage. Each test seeds the
 * 'sales' table for the connected merchant, restarts the product on the
 * screen under test, and checks what the merchant sees.
 */

const row = (frame: FrameLocator, last4: string) => frame.locator(`[data-testid="history-row-${last4}"]`);

/** One sale in each claim state, all today. Suffixes carry a "0" so no base58 address can match a search for them. */
const FOUR_STATES: SeedSale[] = [
  { last4: "0a01", amount: "10.00", state: "received", at: noonDaysAgo(0),
    items: [{ name: "Espresso", quantity: 2, unitPrice: "4.00" }], tip: "2.00" },
  { last4: "0b02", amount: "2.50", state: "confirming", at: noonDaysAgo(0) },
  { last4: "0c03", amount: "4.00", requested: "5.00", state: "partial", at: noonDaysAgo(0) },
  { last4: "0d04", amount: "7.00", state: "reverted", at: noonDaysAgo(0) },
];

test.describe("History", () => {
  test("lists a sale in each claim state with its own status line", async ({ host }) => {
    await seedSalesAndOpen(host, FOUR_STATES, "/history");
    const frame = host.productFrame();
    await expect(frame.locator('[data-testid="history-header"]')).toBeVisible({ timeout: 60_000 });

    const expectRow = async (last4: string, state: string, status: string, amount: string) => {
      const r = row(frame, last4);
      await expect(r).toHaveAttribute("data-claim-state", state);
      await expect(r).toContainText(`Order #${last4.toUpperCase()}`);
      await expect(r.locator('[data-testid="history-row-status"]')).toHaveText(new RegExp(`^${status} · 12:00$`));
      await expect(r).toContainText(`${amount} CASH`);
    };
    await expectRow("0a01", "received", "Received", "10.00");
    await expectRow("0b02", "confirming", "Received · confirming", "2.50");
    await expectRow("0c03", "partial", "Received 4.00 of 5.00", "4.00");
    await expectRow("0d04", "reverted", "Reverted", "7.00");
    // A reverted sale's amount is struck through.
    await expect(row(frame, "0d04").getByText("7.00 CASH")).toHaveClass(/line-through/);
    await expect(row(frame, "0a01").getByText("10.00 CASH")).not.toHaveClass(/line-through/);
    // All four sit under TODAY.
    await expect(frame.getByRole("heading", { name: "TODAY", exact: true })).toBeVisible();
    await expect(frame.locator('[data-testid^="history-row-"][data-claim-state]')).toHaveCount(4);

    // Host side: on launch the watcher resumes only the confirming sale's
    // claim. This host never heard of it (NotFound), so it stays confirming.
    const resumed = await host.next("topUpStatusSubscribe", (e) => e.idHex === `0x${topUpIdFor("0b02")}`);
    expect(resumed.known).toBe(false);
    const watched = host.all("topUpStatusSubscribe").map((e) => e.idHex);
    for (const settled of ["0a01", "0c03", "0d04"]) expect(watched).not.toContain(`0x${topUpIdFor(settled)}`);
    await expect(row(frame, "0b02")).toHaveAttribute("data-claim-state", "confirming");
  });

  test("the detail screen explains each claim state", async ({ host }) => {
    await seedSalesAndOpen(host, FOUR_STATES, "/history");
    const frame = host.productFrame();
    const status = frame.locator('[data-testid="history-detail-status"]');
    const back = frame.getByRole("button", { name: "Back to history" });

    // Received, with items and a tip.
    await row(frame, "0a01").click();
    await expect(status).toHaveAttribute("data-claim-state", "received");
    await expect(status).toHaveText("Received");
    await expect(frame.getByText(/^Order #0A01 · /)).toBeVisible();
    await expect(frame.getByText("2x Espresso")).toBeVisible();
    const lines = frame.locator("main");
    await expect(lines).toContainText("2x Espresso8.00 CASH");
    await expect(lines).toContainText("Subtotal8.00 CASH");
    await expect(lines).toContainText("Tip2.00 CASH");
    await expect(lines).toContainText("Total10.00 CASH");
    await expect(frame.getByRole("button", { name: "Review Receipt" })).toBeVisible();
    await expect(frame.getByRole("button", { name: "Share Receipt via QR" })).toBeVisible();
    await back.click();

    // Confirming.
    await row(frame, "0b02").click();
    await expect(status).toHaveAttribute("data-claim-state", "confirming");
    await expect(status).toHaveText("ReceivedConfirming on chain…");
    await expect(frame.getByText(/^Order #0B02 · /)).toBeVisible();
    await expect(frame.getByText("Subtotal")).toHaveCount(0);
    await back.click();

    // Partial: the credited amount is the sale amount.
    await row(frame, "0c03").click();
    await expect(status).toHaveAttribute("data-claim-state", "partial");
    await expect(status).toHaveText("Received4.00 of the 5.00 CASH requested arrived");
    await expect(frame.locator("main")).toContainText("Total4.00 CASH");
    await back.click();

    // Reverted.
    await row(frame, "0d04").click();
    await expect(status).toHaveAttribute("data-claim-state", "reverted");
    await expect(status).toHaveText("RevertedThe payment didn't complete on chain. Nothing was credited.");
    await expect(frame.getByText(/^Order #0D04 · /)).toBeVisible();
    await back.click();
    await expect(frame.locator('[data-testid="history-header"]')).toBeVisible();
  });

  test("search finds a sale by the last 4 of its id and by amount", async ({ host }) => {
    await seedSalesAndOpen(host, FOUR_STATES, "/history");
    const frame = host.productFrame();
    const search = frame.locator('[data-testid="history-search"]');
    const rows = frame.locator('[data-testid^="history-row-"][data-claim-state]');
    await expect(rows).toHaveCount(4, { timeout: 60_000 });
    await expect(search).toHaveAttribute("placeholder", "Type Transaction ID");

    // Last 4, typed as the merchant reads it (upper case).
    await search.fill("0C03");
    await expect(rows).toHaveCount(1);
    await expect(row(frame, "0c03")).toBeVisible();
    await expect(frame.getByText("Search result", { exact: true })).toBeVisible();
    // Group eyebrows are hidden while searching.
    await expect(frame.getByRole("heading", { name: "TODAY", exact: true })).toHaveCount(0);

    // Full id.
    await search.fill(saleIdFor("0b02"));
    await expect(rows).toHaveCount(1);
    await expect(row(frame, "0b02")).toBeVisible();

    // Amount.
    await search.fill("7.00");
    await expect(rows).toHaveCount(1);
    await expect(row(frame, "0d04")).toBeVisible();

    // No match.
    await search.fill("0e99");
    await expect(rows).toHaveCount(0);
    await expect(frame.getByText("We haven't found any matches")).toBeVisible();
    await expect(frame.locator('[data-testid="history-empty"]')).toHaveCount(0);

    // Clear brings everything back; so does Cancel.
    await frame.getByRole("button", { name: "Clear search" }).click();
    await expect(search).toHaveValue("");
    await expect(rows).toHaveCount(4);
    await search.fill("0a01");
    await expect(rows).toHaveCount(1);
    await frame.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(search).toHaveValue("");
    await expect(rows).toHaveCount(4);
  });

  test("shows only this merchant's sales, grouped by day", async ({ host }) => {
    await seedSalesAndOpen(
      host,
      [
        { last4: "0a11", amount: "1.00", state: "received", at: noonDaysAgo(0) },
        { last4: "0a12", amount: "2.00", state: "received", at: noonDaysAgo(1) },
        { last4: "0a13", amount: "3.00", state: "received", at: noonDaysAgo(0), merchant: OTHER_MERCHANT },
      ],
      "/history",
    );
    const frame = host.productFrame();
    await expect(row(frame, "0a11")).toBeVisible({ timeout: 60_000 });
    await expect(row(frame, "0a12")).toBeVisible();
    await expect(row(frame, "0a13")).toHaveCount(0);
    const today = frame.locator("section").filter({ has: frame.getByRole("heading", { name: "TODAY", exact: true }) });
    const yesterday = frame.locator("section").filter({ has: frame.getByRole("heading", { name: "YESTERDAY", exact: true }) });
    await expect(today.locator('[data-testid="history-row-0a11"]')).toBeVisible();
    await expect(yesterday.locator('[data-testid="history-row-0a12"]')).toBeVisible();
    // Each day carries its own total — the other merchant's 3.00 is not in it.
    await expect(today.getByTestId("history-group-total")).toHaveText("1.00 CASH");
    await expect(yesterday.getByTestId("history-group-total")).toHaveText("2.00 CASH");
    // Newest first.
    await expect(frame.locator('[data-testid^="history-row-"][data-claim-state]').first()).toHaveAttribute(
      "data-testid",
      "history-row-0a11",
    );
  });

  // BUG(app): History's day total sums every sale, including reverted ones
  // (history/page.tsx group reduce: TODAY shows 23.50 CASH here), while
  // Today's Income and Sales exclude them and SaleRecord.revertedAt documents
  // "excluded from totals". The selector is proven by the passing
  // "grouped by day" test above, so only the wrong value fails here.
  test("a day's total leaves reverted sales out", async ({ host }) => {
    test.fail();
    await seedSalesAndOpen(host, FOUR_STATES, "/history");
    const frame = host.productFrame();
    await expect(frame.locator('[data-testid^="history-row-"][data-claim-state]')).toHaveCount(4, { timeout: 60_000 });
    const totals = frame.getByTestId("history-group-total");
    // 10.00 + 2.50 + 4.00 (credited) — the reverted 7.00 is not money in.
    await expect(totals).toHaveText(["16.50 CASH"], { timeout: 5_000 });
  });

  test("an empty history says so", async ({ host }) => {
    const frame = await bootTerminal(host);
    await frame.getByRole("link", { name: "History", exact: true }).click();
    await expect(frame.locator('[data-testid="history-empty"]')).toHaveText("No Transactions Yet");
    await expect(frame.getByText("Completed sales will show up here.")).toBeVisible();
    expect(await host.getStorage("sales")).toBeUndefined();
    // Searching an empty history is a no-match, not the empty state.
    await frame.locator('[data-testid="history-search"]').fill("0a01");
    await expect(frame.getByText("We haven't found any matches")).toBeVisible();
    await expect(frame.locator('[data-testid="history-empty"]')).toHaveCount(0);
  });
});

test.describe("Home", () => {
  test("Today's Income counts today's money in: confirming yes, partial at the credited amount, reverted no", async ({ host }) => {
    await seedSalesAndOpen(
      host,
      [
        ...FOUR_STATES,
        { last4: "0e05", amount: "100.00", state: "received", at: noonDaysAgo(1) }, // yesterday
        { last4: "0e06", amount: "50.00", state: "received", at: noonDaysAgo(0), merchant: OTHER_MERCHANT },
      ],
      "/home",
    );
    const frame = host.productFrame();
    // 10.00 + 2.50 + 4.00 = 16.50
    await expect(frame.locator('[data-testid="todays-income"]')).toHaveText("16.50", { timeout: 60_000 });
    await expect(frame.getByText("Today's Income")).toBeVisible();
    // Sales is always there; Reports waits for a merchant profile; Export CSV
    // and Become a Merchant are parked behind the flag.
    await expect(frame.getByRole("link", { name: "Sales" })).toHaveAttribute("href", /\/home\/sales\/?$/);
    await expect(frame.getByRole("link", { name: "Reports" })).toHaveCount(0);
    await expect(frame.getByRole("link", { name: "Export CSV" })).toHaveCount(0);
    await expect(frame.getByRole("link", { name: "Become a Merchant" })).toHaveCount(0);
    await expect(frame.getByRole("link", { name: "Settings" })).toBeVisible();
  });

  test("Today's Income is 0.00 with no sales", async ({ host }) => {
    const frame = await bootTerminal(host);
    await frame.getByRole("link", { name: "Home", exact: true }).click();
    await expect(frame.locator('[data-testid="todays-income"]')).toHaveText("0.00");
  });

  test("Sales adds up a multi-day history", async ({ host }) => {
    const seeds: SeedSale[] = [
      { last4: "0f01", amount: "10.00", state: "received", at: noonDaysAgo(0) },
      { last4: "0f02", amount: "4.00", requested: "5.00", state: "partial", at: noonDaysAgo(0) },
      { last4: "0f03", amount: "7.00", state: "reverted", at: noonDaysAgo(0) },
      { last4: "0f04", amount: "20.00", state: "confirming", at: noonDaysAgo(1) },
      { last4: "0f05", amount: "1.50", state: "received", at: noonDaysAgo(3) },
      { last4: "0f06", amount: "30.00", state: "received", at: noonDaysAgo(10) },
      { last4: "0f07", amount: "5.25", state: "received", at: noonDaysAgo(35) },
      { last4: "0f08", amount: "99.00", state: "received", at: noonDaysAgo(400) },
      { last4: "0f09", amount: "500.00", state: "received", at: noonDaysAgo(0), merchant: OTHER_MERCHANT },
    ];
    await seedSalesAndOpen(host, seeds, "/home/sales");
    const frame = host.productFrame();

    // Expected figures, from the seeds, with the screen's own calendar rules
    // (Monday weeks, local days): this merchant, not reverted.
    const now = new Date();
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(dayStart);
    weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const counted = seeds.filter((s) => !s.merchant && s.state !== "reverted");
    const cents = (s: SeedSale) => Math.round(Number(s.amount) * 100);
    const sum = (pick: (s: SeedSale) => boolean) => counted.filter(pick).reduce((t, s) => t + cents(s), 0);
    const money = (c: number) => (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const total = sum(() => true);
    const expected = {
      count: String(counted.length), // 7
      today: money(sum((s) => s.at >= dayStart)), // 14.00
      week: money(sum((s) => s.at >= weekStart)),
      month: money(sum((s) => s.at >= monthStart)),
      average: (total / 100 / counted.length).toLocaleString("en-US", { maximumFractionDigits: 2 }),
      year: money(sum((s) => s.at.getFullYear() === now.getFullYear())),
      days14: money(sum((s) => s.at >= new Date(dayStart.getTime() - 13 * 86_400_000 - 3_600_000))),
    };
    expect(expected.today).toBe("14.00");

    const card = (label: string) => frame.getByText(label, { exact: true }).locator("..");
    await expect(frame.locator('[data-testid="sales-transactions"]')).toHaveText(expected.count, { timeout: 60_000 });
    await expect(card("Today")).toHaveText(`Today${expected.today}CASH`);
    await expect(card("This week")).toHaveText(`This week${expected.week}CASH`);
    await expect(card("This month")).toHaveText(`This month${expected.month}CASH`);
    await expect(card("Average sale")).toHaveText(`Average sale${expected.average}CASH`);
    await expect(frame.getByText(`Total for ${now.getFullYear()}`)).toBeVisible();
    await expect(frame.locator('[data-testid="sales-year-total"]')).toHaveText(`${expected.year}CASH`);

    // This month's bar carries the month's money.
    const monthLabel = now.toLocaleString("en-US", { month: "short" });
    await expect(frame.getByRole("button", { name: `${monthLabel}: ${expected.month} CASH`, exact: true })).toBeVisible();

    // The Days view totals the last 14 days (the 35- and 400-day-old sales drop out).
    await frame.getByRole("tab", { name: "Days" }).click();
    await expect(frame.getByText("Last 14 days")).toBeVisible();
    await expect(frame.locator('[data-testid="sales-year-total"]')).toHaveText(`${expected.days14}CASH`);
    await expect(frame.getByRole("button", { name: `${dayStart.getDate()}: ${expected.today} CASH`, exact: true })).toBeVisible();

    // The Transactions card leads to History.
    await frame.locator('[data-testid="sales-transactions"]').click();
    await expect(frame.locator('[data-testid="history-header"]')).toBeVisible();
  });
});
