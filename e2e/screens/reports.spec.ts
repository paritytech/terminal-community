import type { FrameLocator } from "@playwright/test";
import { blake2b } from "@noble/hashes/blake2.js";
import { test, expect, type T3Host } from "../host/fixture";
import { bootTerminal } from "../host/flows";
import {
  hostStorageHits,
  keyFingerprint,
  merchantAddress,
  onboardedMerchantStorage,
  preimageText,
  restartOn,
  seedSales,
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
 *
 * Every test boots as an onboarded merchant (seeded before the product
 * loads); today's sales are seeded once the merchant's account is known.
 */

interface StoredReport {
  id?: number;
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

/** Poll the `dailyReports` table until it matches — the write can trail the toast. */
async function waitForReports(host: T3Host, expected: unknown): Promise<StoredReport[]> {
  await expect.poll(() => storedReports(host)).toEqual(expected);
  return storedReports(host);
}

/** blake2b-256 of the bytes — the host's preimage key. */
const keyOf = (text: string) => "0x" + Buffer.from(blake2b(Buffer.from(text, "utf8"), { dkLen: 32 })).toString("hex");

/** Boot, seed today's sales and open Home → Reports in-app. */
async function openReports(host: T3Host, amounts: string[]): Promise<{ frame: FrameLocator; sales: SeededSale[] }> {
  const frame = await bootTerminal(host);
  const sales = amounts.length ? await seedTodaysSales(host, amounts) : [];
  await gotoReportsFromHome(frame, () => frame.getByRole("link", { name: "Home", exact: true }).click());
  return { frame, sales };
}

/**
 * Leave for Home, wait until Home is really on screen, then open Reports.
 * Clicking "Reports" while the previous page is still up can hit one of its
 * own links ("Back to reports", "Recover Reports").
 */
async function gotoReportsFromHome(frame: FrameLocator, leave: () => Promise<void>) {
  await leave();
  await expect(frame.getByTestId("todays-income")).toBeVisible();
  await frame.getByRole("link", { name: "Reports", exact: true }).click();
  await expect(frame.getByText("X-Report", { exact: true })).toBeVisible();
}

/** The global report-job toast (ReportJobProvider). */
const toast = (frame: FrameLocator) => frame.locator('[data-testid="report-job-toast"]');

test.use({ hostOptions: { storage: onboardedMerchantStorage() } });

test.describe("reports", () => {
  test("Save Current Report uploads the period through the host and lists it", async ({ host }) => {
    const { frame, sales } = await openReports(host, ["12.50", "3.20"]);
    await expect(frame.getByText("Saves the current 2 transactions")).toBeVisible();

    const since = host.mark();
    await frame.getByRole("button", { name: "Save Current Report" }).click();
    await expect(toast(frame)).toHaveText("Saved Period 1", { timeout: 60_000 });

    // Allowances claimed, then the permission asked, then exactly one preimage.
    const alloc = await host.next("resourceAllocation", undefined, { since });
    expect(alloc.resources).toEqual(expect.arrayContaining(["BulletinAllowance", "SmartContractAllowance"]));
    const perm = await host.next("permission", (e) => e.tag === "PreimageSubmit", { since });
    expect(perm.granted).toBe(true);
    const submits = host.events.slice(since).filter((e) => e.type === "preimageSubmit");
    expect(submits).toHaveLength(1);
    const submit = submits[0] as Extract<(typeof submits)[number], { type: "preimageSubmit" }>;
    expect(host.events.indexOf(alloc)).toBeLessThan(host.events.indexOf(submit));
    expect(host.events.indexOf(perm)).toBeLessThan(host.events.indexOf(submit));

    // The bytes are the plain JSON report for today's two sales.
    const text = await preimageText(host, submit.key);
    expect(keyOf(text)).toBe(submit.key);
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
    expect((await host.getPreimages()).map((p) => p.key)).toEqual([submit.key]);

    // Kept locally under its CID, open.
    const [stored] = await waitForReports(host, [
      expect.objectContaining({ date: todayKey(), entryCount: 2, finalized: false }),
    ]);
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
    await expect(toast(frame)).toHaveText("Closed Period 1", { timeout: 60_000 });

    const z = await host.next("preimageSubmit", undefined, { since });
    const zReport = JSON.parse(await preimageText(host, z.key)) as ReportJson;
    expect(zReport).toMatchObject({ periodKey: todayKey(), dayFinalized: true, totalTransactions: 3 });
    const [closed] = await waitForReports(host, [
      expect.objectContaining({ date: todayKey(), finalized: true, entryCount: 3 }),
    ]);
    expect(closed.periodClosedAt).toBeTruthy();

    // Nothing left to close: the action is blocked until a new sale.
    await expect(frame.getByRole("button", { name: "No transactions yet" })).toBeDisabled();
    await expect(frame.getByText(/Z-Report · 3 Transactions · Closed/)).toBeVisible();
    expect(host.events.slice(since).filter((e) => e.type === "preimageSubmit")).toHaveLength(1);

    // A sale after the close starts period #02.
    const [late] = await seedTodaysSales(host, ["2.00"]);
    // The screen re-reads sales on the app's own writes only; remount it.
    await gotoReportsFromHome(frame, () => frame.getByRole("link", { name: "Back to home" }).click());
    await frame.getByRole("button", { name: "Current report", exact: true }).click();
    await expect(frame.getByText("Saves the current 1 transactions")).toBeVisible();
    const since2 = host.mark();
    await frame.getByRole("button", { name: "Save Current Report" }).click();
    await expect(toast(frame)).toHaveText("Saved Period 2", { timeout: 60_000 });
    const x = await host.next("preimageSubmit", undefined, { since: since2 });
    const xReport = JSON.parse(await preimageText(host, x.key)) as ReportJson;
    expect(xReport).toMatchObject({ periodKey: `${todayKey()}#02`, periodLabel: "Period 2", totalTransactions: 1 });
    expect(xReport.transactions.map((t) => t.saleId)).toEqual([late.saleId]);
    await expect
      .poll(async () => (await storedReports(host)).map((r) => [r.date, r.finalized]).sort())
      .toEqual([[todayKey(), true], [`${todayKey()}#02`, false]].sort());
  });

  test("Open report reads the saved report back from the host's preimage store", async ({ host }) => {
    const { frame, sales } = await openReports(host, ["4.00", "6.50"]);
    const since = host.mark();
    await frame.getByRole("button", { name: "Save Current Report" }).click();
    await expect(toast(frame)).toHaveText("Saved Period 1", { timeout: 60_000 });
    const { key } = await host.next("preimageSubmit", undefined, { since });
    await waitForReports(host, [expect.objectContaining({ date: todayKey() })]);

    // After a restart nothing of the report is in memory; /daily-reports
    // (URL-only) opens it by CID through the host.
    const f = await restartOn(host, "/daily-reports");
    await expect(f.locator('[data-testid="reports-header"]')).toBeVisible();
    const sinceOpen = host.mark();
    await f.locator('[data-testid="report-view-0"]').click();
    const lookup = await host.next("preimageLookup", (e) => e.key === key, { since: sinceOpen });
    expect(lookup.found).toBe(true);
    await expect(f.getByText("Report Summary")).toBeVisible({ timeout: 30_000 });
    await expect(f.getByText("Transactions (2)")).toBeVisible();
    for (const s of sales) {
      await expect(f.getByText(`#${s.saleId.slice(-4).toUpperCase()}`, { exact: true })).toBeVisible();
    }
    await expect(f.getByText("4.00 CASH")).toBeVisible();
    await expect(f.getByText("6.50 CASH")).toBeVisible();
  });

  test("with an encryption key the uploaded report is ciphertext, and opens only with that key", async ({ host }) => {
    const passphrase = "night shift key";
    await bootTerminal(host);
    const sales = await seedTodaysSales(host, ["9.90", "0.10"]);

    // Set the key on Settings → Report Encryption.
    let frame = await restartOn(host, "/settings/encryption");
    await frame.getByPlaceholder("Enter a secret phrase").fill(passphrase);
    await frame.getByRole("button", { name: "Save" }).click();
    await expect(frame.getByText(keyFingerprint(passphrase), { exact: true })).toBeVisible();

    frame = await restartOn(host, "/home/reports");
    const since = host.mark();
    await frame.getByRole("button", { name: "Save Current Report" }).click();
    await expect(toast(frame)).toHaveText("Saved Period 1", { timeout: 60_000 });
    const { key } = await host.next("preimageSubmit", undefined, { since });

    // What left the device is the v2 envelope, not the report.
    const text = await preimageText(host, key);
    const envelope = JSON.parse(text) as { v: number; encrypted: string; meta: Record<string, unknown> };
    expect(envelope.v).toBe(2);
    expect(envelope.encrypted).toMatch(/^[0-9a-f]+$/);
    expect(envelope.meta).toMatchObject({ date: todayKey(), txCount: 2, keyFingerprint: keyFingerprint(passphrase) });
    for (const s of sales) expect(text).not.toContain(s.saleId);
    expect(text).not.toContain("transactions");
    expect(text).not.toContain(passphrase);
    // Nor did the passphrase reach host storage.
    expect(await hostStorageHits(host, passphrase)).toEqual([]);

    // With the key: opens.
    frame = await restartOn(host, "/daily-reports");
    await frame.locator('[data-testid="report-view-0"]').click();
    await expect(frame.getByText("Transactions (2)")).toBeVisible({ timeout: 30_000 });
    await expect(frame.getByText("9.90 CASH")).toBeVisible();

    // With another key: the ciphertext does not open.
    frame = await restartOn(host, "/settings/encryption");
    await frame.getByPlaceholder("Enter a secret phrase").fill("day shift key");
    await frame.getByRole("button", { name: "Save" }).click();
    await expect(frame.getByText(keyFingerprint("day shift key"), { exact: true })).toBeVisible();
    frame = await restartOn(host, "/daily-reports");
    await frame.locator('[data-testid="report-view-0"]').click();
    await expect(frame.getByText("Report Details")).toBeVisible();
    await expect(frame.getByText("Loading report from IPFS...")).toHaveCount(0, { timeout: 30_000 });
    await expect(frame.getByText("Report Summary")).toHaveCount(0);
    await expect(frame.getByText("9.90 CASH")).toHaveCount(0);

    // With no key: the encrypted-report error. Clear the key the way a
    // merchant would, in Settings → Report Encryption.
    frame = await restartOn(host, "/settings/encryption");
    await frame.getByRole("button", { name: "Clear" }).click();
    await expect(frame.getByText("No key set — reports will upload as plaintext")).toBeVisible();
    frame = await restartOn(host, "/daily-reports");
    await frame.locator('[data-testid="report-view-0"]').click();
    await expect(
      frame.getByText("This report is encrypted. Set your decryption key in Settings → Report Encryption."),
    ).toBeVisible({ timeout: 30_000 });
    await expect(frame.getByText("Report Summary")).toHaveCount(0);
  });

  test("a report encrypted under another key says the key is wrong", async ({ host }) => {
    // The envelope carries the key's fingerprint (meta.keyFingerprint), so
    // the merchant is told the key does not match, not shown a crypto error.
    await bootTerminal(host);
    await seedTodaysSales(host, ["5.55"]);
    let frame = await restartOn(host, "/settings/encryption");
    await frame.getByPlaceholder("Enter a secret phrase").fill("key one");
    await frame.getByRole("button", { name: "Save" }).click();
    await expect(frame.getByText(keyFingerprint("key one"), { exact: true })).toBeVisible();
    frame = await restartOn(host, "/home/reports");
    await frame.getByRole("button", { name: "Save Current Report" }).click();
    await expect(toast(frame)).toHaveText("Saved Period 1", { timeout: 60_000 });

    frame = await restartOn(host, "/settings/encryption");
    await frame.getByPlaceholder("Enter a secret phrase").fill("key two");
    await frame.getByRole("button", { name: "Save" }).click();
    await expect(frame.getByText(keyFingerprint("key two"), { exact: true })).toBeVisible();
    frame = await restartOn(host, "/daily-reports");
    await frame.locator('[data-testid="report-view-0"]').click();
    await expect(frame.getByText("Loading report from IPFS...")).toHaveCount(0, { timeout: 30_000 });
    await expect(frame.getByText("Report Summary")).toHaveCount(0);
    await expect(frame.getByText(/encrypted with a different key/i)).toBeVisible({ timeout: 5_000 });
    await expect(frame.getByText(keyFingerprint("key one"))).toBeVisible();
    await expect(frame.getByText(/invalid tag/i)).toHaveCount(0);
  });

  test("a denied PreimageSubmit permission fails the save with the host's reason", async ({ host }) => {
    const { frame } = await openReports(host, ["8.00"]);
    await host.setPermission("PreimageSubmit", false);

    const since = host.mark();
    await frame.getByRole("button", { name: "Save Current Report" }).click();
    const reason = "The host did not grant the PreimageSubmit permission.";
    await expect(toast(frame)).toContainText(reason, { timeout: 60_000 });
    // The same error stays on the action card after the toast is gone.
    await expect(frame.locator('[data-testid="report-error"]')).toContainText(reason);

    const perm = await host.next("permission", (e) => e.tag === "PreimageSubmit", { since });
    expect(perm.granted).toBe(false);
    expect(host.events.slice(since).filter((e) => e.type === "preimageSubmit")).toHaveLength(0);
    expect(await host.getPreimages()).toEqual([]);
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

  test.describe("retired admin-QR binding (pins)", () => {
    // lib/config/admin-qr-binding.ts returns null, so getMerchantTerminal()
    // never has a merchant/terminal id to read the on-chain index with. These
    // pin that stub; they should change when recovery is rebuilt.
    const NO_CONFIG = "No merchant/terminal config — scan an admin QR before saving reports.";

    test("Recover Reports always errors", async ({ host }) => {
      const { frame } = await openReports(host, []);
      await frame.getByRole("link", { name: "Recover Reports" }).click();
      await expect(frame.getByText("to pull your saved reports from backup")).toBeVisible();
      await frame.getByRole("button", { name: "Pull reports from backup" }).click();
      await expect(frame.locator('[data-testid="report-error"]')).toHaveText(NO_CONFIG);
      expect(await storedReports(host)).toEqual([]);
    });

    test("Settings → Backup → Restore errors on open and on Restore backup", async ({ host }) => {
      await bootTerminal(host);
      // /settings/backup is URL-only; its Restore row is a link.
      const frame = await restartOn(host, "/settings/backup");
      await frame.getByRole("link", { name: /Restore/ }).click();
      const error = frame.locator('[data-testid="restore-error"]');
      // The list loads on mount and fails first…
      await expect(error).toHaveText(NO_CONFIG);
      await expect(frame.getByText("Backed-up reports (0)")).toBeVisible();
      // …and so does the explicit restore.
      await frame.getByRole("button", { name: "Restore backup" }).click();
      await expect(frame.getByRole("button", { name: "Restore backup" })).toBeEnabled();
      await expect(error).toHaveText(NO_CONFIG);
      await expect(frame.getByText(/^Restored \d+ of \d+ report/)).toHaveCount(0);
      expect(await storedReports(host)).toEqual([]);
      expect(host.all("preimageLookup")).toHaveLength(0);
    });
  });
});

test.describe("legacy /daily-reports Z report", () => {
  test("Run Z asks first: Cancel uploads nothing; Close period closes today's period", async ({ host }) => {
    await bootTerminal(host);
    const sales = await seedTodaysSales(host, ["2.40", "1.60"]);
    const frame = await restartOn(host, "/daily-reports");
    const runZ = frame.getByRole("button", { name: "Run Z", exact: true });
    await expect(runZ).toBeEnabled({ timeout: 30_000 });

    const since = host.mark();
    await runZ.click();
    await expect(frame.getByRole("heading", { name: "Run Z report?" })).toBeVisible();
    await expect(frame.getByText(/closes Period 1\./)).toBeVisible();
    await frame.getByRole("button", { name: "Cancel" }).click();
    await expect(frame.getByRole("heading", { name: "Run Z report?" })).toHaveCount(0);
    await expect(toast(frame)).toHaveCount(0);
    expect(host.events.slice(since).filter((e) => e.type === "preimageSubmit")).toHaveLength(0);
    expect(await storedReports(host)).toEqual([]);

    await runZ.click();
    await frame.locator('[data-testid="btn-finalize-period-confirm"]').click();
    await expect(frame.getByRole("heading", { name: "Run Z report?" })).toHaveCount(0);
    await expect(toast(frame)).toHaveText("Closed Period 1", { timeout: 60_000 });

    const z = await host.next("preimageSubmit", undefined, { since });
    const report = JSON.parse(await preimageText(host, z.key)) as ReportJson;
    expect(report).toMatchObject({ periodKey: todayKey(), dayFinalized: true, totalTransactions: 2 });
    expect(report.transactions.map((t) => t.saleId)).toEqual(sales.map((s) => s.saleId));
    await waitForReports(host, [expect.objectContaining({ date: todayKey(), finalized: true, entryCount: 2 })]);

    // The closed period is in the history as a Z report, and there is nothing left to close.
    await expect(frame.locator('[data-testid="report-view-0"]')).toBeVisible();
    await expect(frame.locator("main").getByText("Z report", { exact: true })).toBeVisible();
    await expect(runZ).toBeDisabled();
    // Today's report is not offered for a past-day close.
    await expect(frame.locator('[data-testid="report-finalize-0"]')).toHaveCount(0);
  });

  test("an X report left open on a past day is closed from its history row, with that day's sales only", async ({ host }) => {
    await bootTerminal(host);
    const noonYesterday = new Date();
    noonYesterday.setDate(noonYesterday.getDate() - 1);
    noonYesterday.setHours(12, 0, 0, 0);
    const yesterday = todayKey(noonYesterday);
    const past = await seedSales(host, ["3.00", "4.50"], noonYesterday);
    await seedTodaysSales(host, ["9.00"]);
    // The X report saved yesterday, left open when the day rolled over.
    const merchant = await merchantAddress(host);
    await host.seedStorage("dailyReports", [{
      id: 1, date: yesterday, cid: "bafkreiseededxreport", gatewayUrl: "", bulletinBlockHash: "",
      entryCount: 2, merchantAddress: merchant, terminalId: "T3RMINAL", finalized: false,
      signedBy: merchant, publishedAt: noonYesterday.toISOString(),
    }]);

    const frame = await restartOn(host, "/daily-reports");
    const closeRow = frame.locator('[data-testid="report-finalize-0"]');
    await expect(closeRow).toHaveText("Run Z report", { timeout: 30_000 });

    const since = host.mark();
    await closeRow.click();
    await expect(frame.getByRole("heading", { name: "Run Z report?" })).toBeVisible();
    await expect(frame.getByText(`closes ${yesterday}.`, { exact: false })).toBeVisible();
    await frame.getByRole("button", { name: "Cancel" }).click();
    await expect(frame.getByRole("heading", { name: "Run Z report?" })).toHaveCount(0);
    expect(host.events.slice(since).filter((e) => e.type === "preimageSubmit")).toHaveLength(0);

    await closeRow.click();
    await frame.locator('[data-testid="btn-finalize-confirm"]').click();
    await expect(toast(frame)).toHaveText("Closed Period 1", { timeout: 60_000 });

    const z = await host.next("preimageSubmit", undefined, { since });
    const report = JSON.parse(await preimageText(host, z.key)) as ReportJson;
    expect(report).toMatchObject({ selectedDate: yesterday, periodKey: yesterday, dayFinalized: true, totalTransactions: 2 });
    expect(report.transactions.map((t) => t.saleId)).toEqual(past.map((s) => s.saleId));
    // The open record is locked in place (same row, new CID).
    const [locked] = await waitForReports(host, [
      expect.objectContaining({ id: 1, date: yesterday, finalized: true, entryCount: 2 }),
    ]);
    expect(locked.cid).not.toBe("bafkreiseededxreport");
    await expect(closeRow).toHaveCount(0);
  });
});
