/**
 * Shared CSV-export pipeline, used by the Export CSV screen (/home/export)
 * and Settings → Export sales. Merges saved Bulletin daily reports with local
 * sale records (saved reports win), explodes itemized sales into per-line
 * rows, and renders the CSV text.
 */

import type { DailyReportTransaction } from "@/lib/hooks/use-bulletin";
import { getAllDailyReports, getSalesForMerchantByDate } from "@/lib/storage/database";
import type { SaleRecord } from "@/lib/storage/types";
import { normalizeToAssetHubAddress } from "@/lib/utils/address";

export interface ExportRow {
  saleId: string;
  timestampMs: string;
  timestampIso: string;
  status: string;
  itemName: string;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
  asset: string;
  merchant: string;
  customer: string;
  txHash: string;
  blockNumber: string;
}

export interface SaleLike {
  saleId: string;
  status: string;
  saleTotal: string;
  asset: string;
  merchant: string;
  customer: string;
  txHash: string;
  blockNumber: string;
  timestampMs: string;
  timestampIso: string;
  items?: ReadonlyArray<{ name: string; quantity: number; unitPrice: string }>;
}

export function saleToSaleLike(s: SaleRecord): SaleLike {
  return {
    saleId: s.saleId,
    status: "Finished",
    saleTotal: s.amount,
    asset: s.asset,
    merchant: s.merchantAddressNormalized ?? s.merchantAddress,
    customer: s.customerAddressNormalized ?? s.customerAddress,
    txHash: s.transactionHash ?? "",
    blockNumber: s.blockNumber?.toString() ?? "0",
    timestampMs: new Date(s.timestamp).getTime().toString(),
    timestampIso: new Date(s.timestamp).toISOString(),
    items: s.items,
  };
}

export function txToSaleLike(tx: DailyReportTransaction): SaleLike {
  return {
    saleId: tx.saleId,
    status: tx.status,
    saleTotal: tx.amountFormatted,
    asset: tx.asset,
    merchant: tx.originalMerchant || tx.evmMerchant,
    customer: tx.originalCustomer || tx.evmCustomer,
    txHash: tx.txHash,
    blockNumber: tx.blockNumber,
    timestampMs: tx.timestamp,
    timestampIso: tx.timestampFormatted,
    items: tx.items,
  };
}

function lineTotalOf(unitPrice: string, quantity: number): string {
  const n = Number(unitPrice);
  if (!Number.isFinite(n)) return "";
  return (n * quantity).toFixed(2);
}

function money2(amount: string): string {
  const n = Number(amount);
  return Number.isFinite(n) ? n.toFixed(2) : amount;
}

export function explodeSaleToRows(sale: SaleLike): ExportRow[] {
  const baseShared = {
    saleId: sale.saleId,
    timestampMs: sale.timestampMs,
    timestampIso: sale.timestampIso,
    status: sale.status,
    asset: sale.asset,
    merchant: sale.merchant,
    customer: sale.customer,
    txHash: sale.txHash,
    blockNumber: sale.blockNumber,
  };

  if (!sale.items || sale.items.length === 0) {
    return [{
      ...baseShared,
      itemName: "(amount only)",
      quantity: "1",
      unitPrice: money2(sale.saleTotal),
      lineTotal: money2(sale.saleTotal),
    }];
  }

  return sale.items.map((item) => ({
    ...baseShared,
    itemName: item.name,
    quantity: item.quantity.toString(),
    unitPrice: money2(item.unitPrice),
    lineTotal: lineTotalOf(item.unitPrice, item.quantity),
  }));
}

export function exportSaleKey(sale: SaleLike): string {
  return sale.saleId || sale.txHash || `${sale.timestampMs}:${sale.saleTotal}`;
}

/**
 * Collect the export rows for one YYYY-MM-DD day: saved Bulletin reports for
 * the day first (authoritative), then any local sales not already covered.
 * `readDailyReport` comes from useBulletin at the call site.
 */
export async function fetchExportRowsForDate(
  date: string,
  merchantIdentity: string,
  readDailyReport: (cid: string) => Promise<{ transactions: DailyReportTransaction[] }>,
): Promise<ExportRow[]> {
  const storedReports = await getAllDailyReports();
  const reportsForDay = storedReports
    .filter((entry) => entry.date === date || entry.date.startsWith(`${date}#`))
    .sort((a, b) => a.date.localeCompare(b.date));

  const salesByKey = new Map<string, SaleLike>();
  for (const entry of reportsForDay) {
    try {
      const report = await readDailyReport(entry.cid);
      for (const tx of report.transactions) {
        const sale = txToSaleLike(tx);
        salesByKey.set(exportSaleKey(sale), sale);
      }
    } catch (err) {
      console.warn(`[Export] could not read report ${entry.date}:`, err);
    }
  }

  const merchant = normalizeToAssetHubAddress(merchantIdentity);
  const dayStart = new Date(date + "T00:00:00");
  const dayEnd = new Date(date + "T23:59:59.999");
  const sales = await getSalesForMerchantByDate(merchant, dayStart, dayEnd);
  for (const localSale of sales.map(saleToSaleLike)) {
    const key = exportSaleKey(localSale);
    if (!salesByKey.has(key)) salesByKey.set(key, localSale);
  }

  return [...salesByKey.values()]
    .sort((a, b) => Number(a.timestampMs) - Number(b.timestampMs))
    .flatMap(explodeSaleToRows);
}

const CSV_HEADERS = [
  "Sale ID",
  "Timestamp",
  "Timestamp Formatted",
  "Status",
  "Item",
  "Quantity",
  "Unit Price",
  "Line Total",
  "Asset",
  "Merchant",
  "Customer",
  "Tx Hash",
  "Block Number",
];

// A cell a spreadsheet would read as a formula: =, +, -, @, or a leading tab
// or carriage return (which some apps strip before parsing the rest).
const FORMULA_START = /^[=+\-@\t\r]/;
// Plain numbers ("-5.00", "+1") start with - or + but are data, not formulas.
const PLAIN_NUMBER = /^[+-]?\d+(\.\d+)?$/;

/**
 * One CSV cell. Quotes per RFC 4180 and neutralises formula injection
 * (CWE-1236): a text cell that a spreadsheet would evaluate gets a leading
 * apostrophe, so `=HYPERLINK(...)` in an item name shows as text in Excel,
 * LibreOffice or Google Sheets instead of running.
 */
export function csvCell(val: string | number | null | undefined): string {
  if (val === null || val === undefined) return "";
  let s = String(val);
  if (FORMULA_START.test(s) && !PLAIN_NUMBER.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** One CSV line from its cells. */
export function csvLine(values: ReadonlyArray<string | number | null | undefined>): string {
  return values.map(csvCell).join(",");
}

export function buildCsv(rows: ExportRow[]): string {
  const csvRows = rows.map((r) =>
    [
      r.saleId,
      r.timestampMs,
      r.timestampIso,
      r.status,
      r.itemName,
      r.quantity,
      r.unitPrice,
      r.lineTotal,
      r.asset,
      r.merchant,
      r.customer,
      r.txHash,
      r.blockNumber,
    ].map(csvCell).join(","),
  );
  return [CSV_HEADERS.join(","), ...csvRows].join("\n");
}

/** Count distinct sales across export rows (rows are per-item lines). */
export function countDistinctSales(rows: ExportRow[]): number {
  return new Set(rows.map((r) => r.saleId || `${r.timestampMs}:${r.txHash}`)).size;
}

export function formatYmd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function todayString(): string {
  return formatYmd(new Date());
}

export function enumerateDateRange(fromYmd: string, toYmd: string): string[] {
  const from = new Date(fromYmd + "T00:00:00");
  const to = new Date(toYmd + "T00:00:00");
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
    return [];
  }
  const out: string[] = [];
  const cur = new Date(from);
  while (cur <= to) {
    out.push(formatYmd(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}
