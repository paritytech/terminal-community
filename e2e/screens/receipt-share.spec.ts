import type { Download } from "@playwright/test";
import { test, expect, type T3Host } from "../host/fixture";
import { bootTerminal, chargeAndPay, waitForSale } from "../host/flows";
import {
  SYM,
  decodeQrIn,
  decodeQrPixels,
  pdfImage,
  productFrameHandle,
  receiptSvg,
} from "../payments/checkout.helpers";

/**
 * The screens after a coins sale: the receipt review (the SVG receipt the
 * merchant sees and downloads), the share-receipt QR, and the way back to a
 * new sale.
 */

async function completedSale(host: T3Host, amount: string, note?: string) {
  const frame = await bootTerminal(host);
  if (note) {
    await frame.getByTestId("btn-add-note").click();
    await frame.getByTestId("sale-note").fill(note);
  }
  const { req, topUp } = await chargeAndPay(host, frame, amount);
  await expect(frame.getByTestId("payment-completed")).toHaveText("Payment received");
  const last4 = req.id.slice(-4);
  return { frame, req, topUp, last4 };
}

async function readDownload(download: Download): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/**
 * A whole receipt PDF: one page on an 80 mm roll (226.77 pt wide) carrying
 * the receipt as one image, whose QR scans to this sale's receipt envelope.
 */
async function expectReceiptPdf(pdf: Buffer, saleId: string, amount: string) {
  expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  expect(pdf.subarray(-8).toString("latin1")).toMatch(/%%EOF\s*$/);
  const text = pdf.toString("latin1");
  expect(text.match(/\/Type \/Page\b/g)).toHaveLength(1);
  expect(text).toMatch(/\/MediaBox \[0 0 226\.77/);
  const { width, height, pixels } = pdfImage(pdf);
  const scanned = new URL((await decodeQrPixels(pixels, width, height, 3)).replace(/^polkadotapp:\/\//, "https://"));
  expect(scanned.pathname).toBe("/r");
  expect(scanned.searchParams.get("id")).toBe(saleId);
  expect(scanned.searchParams.get("a")).toBe(amount);
  expect(scanned.searchParams.get("as")).toBe(SYM);
}

test.describe("receipt and share after a sale", () => {
  test("Review Receipt shows the record number and amount; Close returns to the sale", async ({ host }) => {
    const { frame, req, last4 } = await completedSale(host, "7.40");
    expect((await waitForSale(host, req.id)).amount).toBe("7.40");

    const since = host.mark();
    await frame.getByRole("button", { name: "Review Receipt" }).click();
    await expect(frame.getByText(`Payment Record #${last4}`, { exact: true })).toBeVisible();
    // The receipt is the generated SVG (not the HTML fallback): record number
    // upper-cased, the full sale id, one "Amount" line, Total and Paid.
    const receipt = receiptSvg(frame);
    await expect(receipt).toBeVisible();
    await expect(receipt).toContainText("RECORD");
    await expect(receipt).toContainText(`#${last4.toUpperCase()}`);
    await expect(receipt).toContainText("1 × Amount");
    await expect(receipt).toContainText(`Total ${SYM}`);
    await expect(receipt).toContainText(`Paid ${SYM}`);
    await expect(receipt).toContainText("7.40");
    const svgText = (await receipt.textContent()) ?? "";
    expect(svgText.replace(/\s+/g, "")).toContain(`SaleID:${req.id}`);
    await expect(frame.getByText("PAYMENT RECEIPT")).toHaveCount(0);

    await frame.getByRole("button", { name: "Close receipt" }).click();
    await expect(frame.getByTestId("payment-completed")).toBeVisible();
    await expect(frame.getByTestId("sale-id")).toHaveText(`#${last4}`);
    // Reviewing the receipt wrote nothing new: no storage write, no new
    // registration, since before Review Receipt.
    expect(host.events.slice(since).filter((e) => e.type === "storageWrite")).toEqual([]);
    expect(host.events.slice(since).filter((e) => e.type === "topUp")).toEqual([]);
  });

  test("the receipt note shows on the sale and on its receipt", async ({ host }) => {
    // The note field promises "Only visible on your receipt".
    const { frame, req } = await completedSale(host, "5.10", "Gift wrap");
    await expect(frame.getByText("Gift wrap")).toBeVisible();
    expect((await waitForSale(host, req.id)).note).toBe("Gift wrap");

    await frame.getByRole("button", { name: "Review Receipt" }).click();
    const receipt = receiptSvg(frame);
    await expect(receipt).toContainText("5.10");
    await expect(receipt).toContainText("Gift wrap", { timeout: 5_000 });
  });

  test("Download receipt hands a PDF to the host's files bridge", async ({ host }) => {
    const { frame, req } = await completedSale(host, "12.00");
    // The phone hosts expose window.host.ext.files.save; the test host page
    // has none, so stand one up in the product document (feature-detected
    // at click time).
    await productFrameHandle(host).evaluate(() => {
      const w = window as unknown as { host?: unknown; __saved?: unknown[] };
      w.__saved = [];
      w.host = {
        ext: {
          files: {
            save: async (name: string, base64: string, mime: string) => {
              (w.__saved as unknown[]).push({ name, mime, base64 });
              return { savedAs: `/Download/${name}` };
            },
          },
        },
      };
    });

    await frame.getByRole("button", { name: "Review Receipt" }).click();
    await frame.getByRole("button", { name: "Download receipt" }).click();

    const saved = () =>
      productFrameHandle(host).evaluate(() => (window as unknown as { __saved: unknown[] }).__saved);
    await expect.poll(async () => (await saved()).length, { timeout: 30_000 }).toBe(1);
    const [file] = (await saved()) as Array<{ name: string; mime: string; base64: string }>;
    expect(file.name).toBe(`receipt-${req.id.slice(0, 8)}.pdf`);
    expect(file.mime).toBe("application/pdf");
    await expectReceiptPdf(Buffer.from(file.base64, "base64"), req.id, "12.00");
    // Still on the receipt.
    await expect(frame.getByText(`Payment Record #${req.id.slice(-4)}`)).toBeVisible();
  });

  test("Download receipt without a files bridge falls back to a browser download", async ({ host }) => {
    const { frame, req } = await completedSale(host, "3.30");
    await frame.getByRole("button", { name: "Review Receipt" }).click();
    await expect(receiptSvg(frame)).toContainText("3.30");

    const [download] = await Promise.all([
      host.page.waitForEvent("download", { timeout: 30_000 }),
      frame.getByRole("button", { name: "Download receipt" }).click(),
    ]);
    expect(download.suggestedFilename()).toBe(`receipt-${req.id.slice(0, 8)}.pdf`);
    await expectReceiptPdf(await readDownload(download), req.id, "3.30");
    // Still on the receipt.
    await expect(frame.getByText(`Payment Record #${req.id.slice(-4)}`)).toBeVisible();
  });

  test("Share receipt QR shows a scannable receipt envelope; Back returns to the sale", async ({ host }) => {
    const { frame, req, last4 } = await completedSale(host, "4.75");

    await frame.getByRole("button", { name: "Share receipt QR" }).click();
    await expect(frame.getByText("Share Receipt", { exact: true })).toBeVisible();
    await expect(frame.getByRole("heading", { name: /Scan QR\s*to Receive Receipt/ })).toBeVisible();
    await expect(frame.getByText(`Payment Receipt: Order #${last4}`)).toBeVisible();
    // Full-screen view: no tab bar.
    await expect(frame.getByRole("link", { name: "Check out", exact: true })).toHaveCount(0);

    const value = await decodeQrIn(frame.locator("main svg").last());
    const url = new URL(value.replace(/^polkadotapp:\/\//, "https://"));
    expect(value.startsWith("polkadotapp://")).toBe(true);
    expect(url.pathname).toBe("/r");
    expect(url.searchParams.get("v")).toBe("1");
    expect(url.searchParams.get("id")).toBe(req.id);
    expect(url.searchParams.get("a")).toBe("4.75");
    expect(url.searchParams.get("as")).toBe(SYM);
    expect(url.searchParams.get("tp")).toBeNull();

    await frame.getByRole("button", { name: "Back", exact: true }).click();
    await expect(frame.getByTestId("payment-completed")).toBeVisible();

    await frame.getByRole("button", { name: "Share receipt QR" }).click();
    await frame.getByRole("button", { name: "Back to payment" }).click();
    await expect(frame.getByTestId("payment-completed")).toBeVisible();
    await expect(frame.getByTestId("sale-id")).toHaveText(`#${last4}`);
  });

  test("the New sale arrow returns to an empty keypad", async ({ host }) => {
    const { frame, req } = await completedSale(host, "2.20");

    await frame.getByRole("button", { name: "New sale" }).click();
    await expect(frame.getByTestId("terminal-header")).toBeVisible();
    await expect(frame.getByTestId("amount-display")).toContainText("0.00");
    await expect(frame.getByTestId("btn-charge")).toBeDisabled();
    await expect(frame.getByTestId("btn-charge")).toHaveText(`Charge 0.00 ${SYM}`);
    await expect(frame.getByRole("link", { name: "Check out", exact: true })).toBeVisible();
    // The sale stays recorded, and nothing else was registered.
    expect((await waitForSale(host, req.id)).amount).toBe("2.20");
    expect(await host.getTopUps()).toHaveLength(1);
  });
});
