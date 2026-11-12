import type { FrameLocator } from "@playwright/test";
import { blake2b } from "@noble/hashes/blake2.js";
import { test, expect, type T3Host } from "../host/fixture";
import { bootTerminal } from "../host/flows";
import {
  capturePreimages,
  captureConsole,
  hostPreimages,
  keyFingerprint,
  preimageText,
  restartOn,
  seedOnboardedMerchant,
  seedTodaysSales,
  todayKey,
  type SeededSale,
} from "./settings.helpers";

/**
 * Reports (Home → Reports, merchant-only). A report is JSON uploaded through
 * the host's preimage store (Bulletin): the app claims its allowances, asks
 * for the PreimageSubmit permission, submits the bytes and keeps the CID in
 * the `dailyReports` table. Opening a report looks the bytes up again by the
 * CID's digest. No chain is served, so the on-chain mirror always skips.
 */

interface StoredReport {
  date: string;
  cid: string;
  entryCount: number;
  finalized: boolean;
  merchantAddress: string;
  periodClosedAt?: string;
}

interface ReportJson {
  selectedDate: string;
  periodKey: string;
  periodLabel: string;
  totalTransactions: number;
  dayFinalized: boolean;
  terminalId: string;
  transactions: Array<{ saleId: string; amount: string; amountFormatted: string; status: string }>;
}

async function storedReports(host: T3Host): Promise<StoredReport[]> {
  const raw = await host.getStorage<StoredReport[]>("dailyReports");
  return Array.isArray(raw) ? raw : [];
}

/** blake2b-256 of the bytes — the host's preimage key. */
const keyOf = (text: string) => "0x" + Buffer.from(blake2b(Buffer.from(text, "utf8"), { dkLen: 32 })).toString("hex");

/** Boot, onboard the merchant, seed today's sales and open Home → Reports in-app. */
async function openReports(host: T3Host, amounts: string[]): Promise<{ frame: FrameLocator; sales: SeededSale[] }> {
  const frame = await bootTerminal(host);
  await seedOnboardedMerchant(host);
  const sales = amounts.length ? await seedTodaysSales(host, amounts) : [];
  await capturePreimages(host);
  await frame.getByRole("link", { name: "Home", exact: true }).click();
  await frame.getByRole("link", { name: "Reports" }).click();
  await expect(frame.getByText("X-Report", { exact: true })).toBeVisible();
  return { frame, sales };
}

/** The global report-job toast (ReportJobProvider), by its text. */
const toast = (frame: FrameLocator, text: string | RegExp) => frame.locator("div.fixed.top-0").getByText(text);

test.describe("reports", () => {
  test("Save Current Report uploads the period through the host and lists it", async ({ host }) => {
    const logs = captureConsole(host);
    const { frame, sales } = await openReports(host, ["12.50", "3.20"]);
    await expect(frame.getByText("Saves the current 2 transactions")).toBeVisible();

    const since = host.mark();
    await frame.getByRole("button", { name: "Save Current Report" }).click();
    await expect(toast(frame, "Saved Period 1")).toBeVisible({ timeout: 60_000 });

    // Allowances were claimed, the permission asked, and exactly one preimage submitted.
    expect(logs.some((l) => l.includes("[allowances] BulletinAllowance: Allocated"))).toBe(true);
    expect(logs.some((l) => l.includes("[allowances] SmartContractAllowance(0): Allocated"))).toBe(true);
    const perm = await host.next("permission", (e) => e.tag === "PreimageSubmit", { since });
    expect(perm.granted).toBe(true);
    const submits = host.events.slice(since).filter((e) => e.type === "preimageSubmit");
    expect(submits).toHaveLength(1);
    const { key } = submits[0] as { key: string };

    // The bytes are the plain JSON report for today's two sales.
    const text = await preimageText(host, key);
    expect(keyOf(text)).toBe(key);
    const report = JSON.parse(text) as ReportJson;
    expect(report).toMatchObject({
      selectedDate: todayKey(),
      periodKey: todayKey(),
      periodLabel: "Period 1",
      totalTransactions: 2,
      dayFinalized: false,
      terminalId: "T3RMINAL",
    });
    expect(report.transactions.map((t) => [t.saleId, t.amount, t.amountFormatted, t.status])).toEqual(
      sales.map((s) => [s.saleId, s.amountPlanck, s.amount, "Finished"]),
    );
    const total = report.transactions.reduce((sum, t) => sum + BigInt(t.amount), 0n);
    expect(total).toBe(15_700_000n);
    expect((await hostPreimages(host)).map((p) => p.key)).toEqual([key]);

    // Kept locally under its CID (whose digest is the preimage key), open.
    const [stored] = await storedReports(host);
    expect(stored).toMatchObject({ date: todayKey(), entryCount: 2, finalized: false });
    expect(stored.cid).toMatch(/^b/);

    // History row on the Reports screen.
    await expect(frame.getByText(/X-Report · 2 Transactions · Saved · \d{2}:\d{2}/)).toBeVisible();
    await expect(frame.getByText("No reports yet.")).toHaveCount(0);
    // The period stays open: the same sales can be saved again.
    await expect(frame.getByRole("button", { name: "Save Current Report" })).toBeEnabled();
  });

  test("Save Report & Close the Day locks the period; new sales open period #02", async ({ host }) => {
    const { frame } = await openReports(host, ["5.00", "7.25", "1.10"]);
    await frame.getByRole("button", { name: "Day summary", exact: true }).click();
    await expect(frame.getByText("Ends the day and saves a summary of 3 transactions")).toBeVisible();

    const since = host.mark();
    await frame.getByRole("button", { name: "Save Report & Close the Day" }).click();
    await expect(frame.getByText("Do you want to save the report and close the day?")).toBeVisible();
    await frame.getByRole("button", { name: "Proceed" }).click();
    await expect(toast(frame, "Closed Period 1")).toBeVisible({ timeout: 60_000 });

    const z = await host.next("preimageSubmit", undefined, { since });
    const zReport = JSON.parse(await preimageText(host, z.key)) as ReportJson;
    expect(zReport).toMatchObject({ periodKey: todayKey(), dayFinalized: true, totalTransactions: 3 });
    const [closed] = await storedReports(host);
    expect(closed).toMatchObject({ date: todayKey(), finalized: true, entryCount: 3 });
    expect(closed.periodClosedAt).toBeTruthy();

    // Nothing left to close: the action is blocked until a new sale.
    const action = frame.getByRole("button", { name: "No transactions yet" });
    await expect(action).toBeDisabled();
    await expect(frame.getByText(/Z-Report · 3 Transactions · Closed/)).toBeVisible();
    expect(host.events.slice(since).filter((e) => e.type === "preimageSubmit")).toHaveLength(1);

    // A sale after the close starts period #02.
    const [late] = await seedTodaysSales(host, ["2.00"]);
    // The screen re-reads sales on the app's own writes only; remount it.
    await frame.getByRole("link", { name: "Back to home" }).click();
    await frame.getByRole("link", { name: "Reports" }).click();
    await frame.getByRole("button", { name: "Current report", exact: true }).click();
    await expect(frame.getByText("Saves the current 1 transactions")).toBeVisible();
    const since2 = host.mark();
    await frame.getByRole("button", { name: "Save Current Report" }).click();
    await expect(toast(frame, "Saved Period 2")).toBeVisible({ timeout: 60_000 });
    const x = await host.next("preimageSubmit", undefined, { since: since2 });
    const xReport = JSON.parse(await preimageText(host, x.key)) as ReportJson;
    expect(xReport).toMatchObject({ periodKey: `${todayKey()}#02`, periodLabel: "Period 2", totalTransactions: 1 });
    expect(xReport.transactions[0].saleId).toBe(late.saleId);
    expect((await storedReports(host)).map((r) => [r.date, r.finalized]).sort()).toEqual(
      [[todayKey(), true], [`${todayKey()}#02`, false]].sort(),
    );
  });

  test("Open report reads the saved report back from the host's preimage store", async ({ host }) => {
    const { frame, sales } = await openReports(host, ["4.00", "6.50"]);
    await frame.getByRole("button", { name: "Save Current Report" }).click();
    await expect(toast(frame, "Saved Period 1")).toBeVisible({ timeout: 60_000 });

    // After a restart nothing of the report is in memory; /daily-reports
    // (URL-only) opens it by CID through the host.
    const f = await restartOn(host, "/daily-reports");
    await expect(f.locator('[data-testid="reports-header"]')).toBeVisible();
    await f.locator('[data-testid="report-view-0"]').click();
    await expect(f.getByText("Report Summary")).toBeVisible({ timeout: 30_000 });
    await expect(f.getByText("Transactions (2)")).toBeVisible();
    for (const s of sales) {
      await expect(f.getByText(`#${s.saleId.slice(-4).toUpperCase()}`, { exact: true })).toBeVisible();
    }
    await expect(f.getByText("4.00 CASH")).toBeVisible();
    await expect(f.getByText("6.50 CASH")).toBeVisible();
  });

  test("with an encryption key the uploaded report is ciphertext, and opens only with the key", async ({ host }) => {
    const passphrase = "night shift key";
    await bootTerminal(host);
    await seedOnboardedMerchant(host);
    const sales = await seedTodaysSales(host, ["9.90", "0.10"]);
    await capturePreimages(host);

    // Set the key (product-origin localStorage) on Settings → Report Encryption.
    let frame = await restartOn(host, "/settings/encryption");
    await frame.getByPlaceholder("Enter a secret phrase").fill(passphrase);
    await frame.getByRole("button", { name: "Save" }).click();
    await expect(frame.getByText(keyFingerprint(passphrase), { exact: true })).toBeVisible();

    frame = await restartOn(host, "/home/reports");
    const since = host.mark();
    await frame.getByRole("button", { name: "Save Current Report" }).click();
    await expect(toast(frame, "Saved Period 1")).toBeVisible({ timeout: 60_000 });
    const { key } = await host.next("preimageSubmit", undefined, { since });

    // What left the device is the v2 envelope, not the report.
    const text = await preimageText(host, key);
    const envelope = JSON.parse(text) as { v: number; encrypted: string; meta: Record<string, unknown> };
    expect(envelope.v).toBe(2);
    expect(envelope.encrypted).toMatch(/^[0-9a-f]+$/);
    expect(envelope.meta).toMatchObject({ date: todayKey(), txCount: 2, keyFingerprint: keyFingerprint(passphrase) });
    for (const s of sales) expect(text).not.toContain(s.saleId);
    expect(text).not.toContain("transactions");

    // With the key: opens.
    frame = await restartOn(host, "/daily-reports");
    await frame.locator('[data-testid="report-view-0"]').click();
    await expect(frame.getByText("Transactions (2)")).toBeVisible({ timeout: 30_000 });
    await expect(frame.getByText("9.90 CASH")).toBeVisible();
    await frame.getByRole("button", { name: "Close", exact: true }).click();

    // Without it: the encrypted-report error.
    await frame.locator("body").evaluate(() => localStorage.removeItem("t3rminal:manual-encryption-passphrase"));
    await frame.locator('[data-testid="report-view-0"]').click();
    await expect(
      frame.getByText("This report is encrypted. Set your decryption key in Settings → Report Encryption."),
    ).toBeVisible({ timeout: 30_000 });
    await expect(frame.getByText("Report Summary")).toHaveCount(0);
  });

  test("a denied PreimageSubmit permission fails the save with the host's reason", async ({ host }) => {
    const { frame } = await openReports(host, ["8.00"]);
    await host.setPermission("PreimageSubmit", false);

    const since = host.mark();
    await frame.getByRole("button", { name: "Save Current Report" }).click();
    const reason = "The host did not grant the PreimageSubmit permission.";
    await expect(toast(frame, new RegExp(reason.replace(/\./g, "\\.")))).toBeVisible({ timeout: 60_000 });
    // The same error stays on the action card after the toast is gone.
    await expect(frame.locator("p.text-red-400")).toContainText(reason);

    const perm = await host.next("permission", (e) => e.tag === "PreimageSubmit", { since });
    expect(perm.granted).toBe(false);
    expect(host.events.slice(since).filter((e) => e.type === "preimageSubmit")).toHaveLength(0);
    expect(await hostPreimages(host)).toEqual([]);
    expect(await storedReports(host)).toEqual([]);
    await expect(frame.getByText("No reports yet.")).toBeVisible();
    // Nothing is locked: the merchant can retry.
    await expect(frame.getByRole("button", { name: "Save Current Report" })).toBeEnabled();
  });

  test("with no sales today both reports are disabled", async ({ host }) => {
    const { frame } = await openReports(host, []);
    await expect(frame.getByText("Saves the current 0 transactions")).toBeVisible();
    await expect(frame.getByRole("button", { name: "No transactions yet" })).toBeDisabled();
    await frame.getByRole("button", { name: "Day summary", exact: true }).click();
    await expect(frame.getByText("Ends the day and saves a summary of 0 transactions")).toBeVisible();
    await expect(frame.getByRole("button", { name: "No transactions yet" })).toBeDisabled();
    await expect(frame.getByText("No reports yet.")).toBeVisible();
    expect(host.all("preimageSubmit")).toHaveLength(0);
  });

  test("Recover Reports pins the retired admin-QR binding: it always errors", async ({ host }) => {
    // lib/config/admin-qr-binding.ts returns null, so there is never a
    // merchant/terminal id to read the on-chain index with. This pins that
    // stub; it should change when recovery is rebuilt.
    const { frame } = await openReports(host, []);
    await frame.getByRole("link", { name: "Recover Reports" }).click();
    await expect(frame.getByText("to pull your saved reports from backup")).toBeVisible();
    await frame.getByRole("button", { name: "Pull reports from backup" }).click();
    await expect(frame.locator("main p.text-red-400")).toHaveText(
      "No merchant/terminal config — scan an admin QR before saving reports.",
    );
    expect(await storedReports(host)).toEqual([]);
  });
});
