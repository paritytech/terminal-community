/**
 * T3RMINAL Storage Layer
 *
 * Uses host API localStorage (persisted by Polkadot Desktop) when in host.
 * Falls back to in-memory storage when outside host.
 * Provides the same API as the previous Dexie implementation.
 */

import {
  readTable,
  writeTable,
  addRecord,
  updateRecord,
  findByField,
  findFirstByField,
  clearTable,
} from './host-storage';
import { formatAmountFromPlanck } from '@/lib/utils/format';
import { PUSD_DECIMALS } from '@/lib/utils/asset-ids';
import type {
  SaleRecord,
  PendingPayment,
  AppSettings,
  ReceiptCache,
  SyncState,
  DailyReportRecord,
  CsvReportRecord,
} from './types';

// Table names
const TABLES = {
  sales: 'sales',
  pendingPayments: 'pendingPayments',
  settings: 'settings',
  receiptCache: 'receiptCache',
  syncState: 'syncState',
  dailyReports: 'dailyReports',
  csvReports: 'csvReports',
} as const;

// ========== CSV EXPORT REPORTS ==========

// Cap how many generated CSVs we keep — each record embeds the full CSV text,
// and host localStorage is a shared, finite budget.
const MAX_CSV_REPORTS = 20;

export async function addCsvReport(report: Omit<CsvReportRecord, 'id'>): Promise<number> {
  const all = await readTable<CsvReportRecord>(TABLES.csvReports);
  const next = [...all]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, MAX_CSV_REPORTS - 1);
  const record = { ...report, id: Date.now() };
  await writeTable(TABLES.csvReports, [record, ...next]);
  return record.id;
}

/** Newest first. */
export async function getAllCsvReports(): Promise<CsvReportRecord[]> {
  const all = await readTable<CsvReportRecord>(TABLES.csvReports);
  return [...all].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

// ========== SALES ==========

export async function addSaleRecord(sale: Omit<SaleRecord, 'id' | 'createdAt'>): Promise<number> {
  return addRecord<SaleRecord>(TABLES.sales, {
    ...sale,
    createdAt: new Date(),
  } as SaleRecord);
}

export async function getSalesByMerchant(merchantAddress: string, limit?: number): Promise<SaleRecord[]> {
  const sales = await findByField<SaleRecord>(TABLES.sales, 'merchantAddress', merchantAddress);
  const sorted = sales.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return limit ? sorted.slice(0, limit) : sorted;
}

export async function getSalesByCustomer(customerAddress: string, limit?: number): Promise<SaleRecord[]> {
  const sales = await findByField<SaleRecord>(TABLES.sales, 'customerAddress', customerAddress);
  const sorted = sales.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return limit ? sorted.slice(0, limit) : sorted;
}

export async function getSalesForAddress(address: string, limit?: number): Promise<SaleRecord[]> {
  const all = await readTable<SaleRecord>(TABLES.sales);
  const matching = all.filter(
    (s) => s.merchantAddress === address || s.customerAddress === address ||
           s.merchantAddressNormalized === address || s.customerAddressNormalized === address
  );
  const deduped = new Map<string, SaleRecord>();
  matching.forEach((s) => deduped.set(s.saleId, s));
  const sorted = Array.from(deduped.values()).sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
  return limit ? sorted.slice(0, limit) : sorted;
}

export async function searchSales(address: string, searchTerm: string): Promise<SaleRecord[]> {
  const allSales = await getSalesForAddress(address);
  const term = searchTerm.toLowerCase();
  return allSales.filter(
    (s) =>
      s.customerName?.toLowerCase().includes(term) ||
      s.customerAddress.toLowerCase().includes(term) ||
      s.saleId.toLowerCase().includes(term) ||
      s.merchantAddress.toLowerCase().includes(term)
  );
}

export async function updateSyncStatus(saleId: string, status: SaleRecord['syncStatus'], error?: string): Promise<void> {
  const sale = await findFirstByField<SaleRecord>(TABLES.sales, 'saleId', saleId);
  if (sale?.id) {
    await updateRecord<SaleRecord>(TABLES.sales, sale.id, {
      syncStatus: status,
      syncedAt: status === 'synced' ? new Date() : undefined,
      syncError: error,
    } as Partial<SaleRecord>);
  }
}

/**
 * Stamp `finalizedAt` on the sale once its inclusion block has reached
 * GRANDPA finality. Called from lib/payments/finalization-watcher.ts.
 * Idempotent: no-op for unknown saleIds, won't overwrite an existing
 * timestamp.
 */
export async function markSaleFinalized(saleId: string, at: Date = new Date()): Promise<void> {
  const sale = await findFirstByField<SaleRecord>(TABLES.sales, 'saleId', saleId);
  if (!sale?.id || sale.finalizedAt) return;
  await updateRecord<SaleRecord>(TABLES.sales, sale.id, {
    finalizedAt: at,
  } as Partial<SaleRecord>);
}

/**
 * Coins claim settled partially after the sale was recorded: keep what the
 * cheque asked for on `requestedAmount*`, make `amount*` the credited total,
 * and mark the sale final (a partial claim is the host's last word).
 * Idempotent for an already-final sale.
 */
export async function recordSaleClaimShortfall(saleId: string, creditedPlanck: bigint): Promise<void> {
  const sale = await findFirstByField<SaleRecord>(TABLES.sales, 'saleId', saleId);
  if (!sale?.id || sale.finalizedAt || sale.revertedAt) return;
  await updateRecord<SaleRecord>(TABLES.sales, sale.id, {
    requestedAmount: sale.requestedAmount ?? sale.amount,
    requestedAmountPlanck: sale.requestedAmountPlanck ?? sale.amountPlanck,
    amount: formatAmountFromPlanck(creditedPlanck.toString(), PUSD_DECIMALS),
    amountPlanck: creditedPlanck.toString(),
    finalizedAt: new Date(),
  } as Partial<SaleRecord>);
}

/**
 * Coins claim reverted after the sale was recorded (the host's last word was
 * `notClaimed`). The row stays, flagged, so History can say what happened;
 * totals skip it. Idempotent for an already-final sale.
 */
export async function markSaleReverted(saleId: string, at: Date = new Date()): Promise<void> {
  const sale = await findFirstByField<SaleRecord>(TABLES.sales, 'saleId', saleId);
  if (!sale?.id || sale.finalizedAt || sale.revertedAt) return;
  await updateRecord<SaleRecord>(TABLES.sales, sale.id, {
    revertedAt: at,
  } as Partial<SaleRecord>);
}

/** Coins sales recorded on best-block whose claim has no last word yet. */
export async function getSalesAwaitingClaimFinality(): Promise<Array<{ saleId: string; topUpIdHex: string }>> {
  const all = await readTable<SaleRecord>(TABLES.sales);
  const seen = new Set<string>();
  const pending: Array<{ saleId: string; topUpIdHex: string }> = [];
  for (const sale of all) {
    if (!sale.topUpId || sale.finalizedAt || sale.revertedAt || seen.has(sale.saleId)) continue;
    seen.add(sale.saleId);
    pending.push({ saleId: sale.saleId, topUpIdHex: sale.topUpId });
  }
  return pending;
}

/**
 * Get all sales matching a normalized merchant address for a date range
 */
export async function getSalesForMerchantByDate(
  merchantAddressNormalized: string,
  dateStart: Date,
  dateEnd: Date
): Promise<SaleRecord[]> {
  const all = await readTable<SaleRecord>(TABLES.sales);
  return all
    .filter((s) => {
      const matchAddr = s.merchantAddressNormalized === merchantAddressNormalized ||
                        s.merchantAddress === merchantAddressNormalized;
      const saleDate = new Date(s.timestamp);
      return matchAddr && saleDate >= dateStart && saleDate <= dateEnd;
    })
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
}

// ========== PENDING PAYMENTS ==========

export async function getPendingPayments(merchantAddress: string): Promise<PendingPayment[]> {
  const all = await findByField<PendingPayment>(TABLES.pendingPayments, 'merchantAddress', merchantAddress);
  return all.filter((p) => p.status === 'waiting');
}

// ========== SETTINGS ==========

export async function setSetting(key: string, value: string): Promise<void> {
  const all = await readTable<AppSettings>(TABLES.settings);
  const idx = all.findIndex((s) => s.key === key);
  if (idx >= 0) {
    all[idx] = { ...all[idx], value, updatedAt: new Date() };
    await writeTable(TABLES.settings, all);
  } else {
    await addRecord<AppSettings>(TABLES.settings, { key, value, updatedAt: new Date() } as AppSettings);
  }
}

export async function getSetting(key: string): Promise<string | undefined> {
  const setting = await findFirstByField<AppSettings>(TABLES.settings, 'key', key);
  return setting?.value;
}

export async function deleteSetting(key: string): Promise<void> {
  const all = await readTable<AppSettings>(TABLES.settings);
  const next = all.filter((s) => s.key !== key);
  if (next.length === all.length) return;
  await writeTable(TABLES.settings, next);
}

// ========== RECEIPT CACHE ==========

export async function cacheReceipt(saleId: string, svgContent: string): Promise<void> {
  const existing = await findFirstByField<ReceiptCache>(TABLES.receiptCache, 'saleId', saleId);
  if (!existing) {
    await addRecord<ReceiptCache>(TABLES.receiptCache, {
      saleId,
      svgContent,
      pdfGenerated: false,
      createdAt: new Date(),
    } as ReceiptCache);
  }
}

export async function getCachedReceipt(saleId: string): Promise<ReceiptCache | undefined> {
  return findFirstByField<ReceiptCache>(TABLES.receiptCache, 'saleId', saleId);
}

// ========== DAILY REPORTS ==========

/**
 * Pick the "latest" of two records for the same date — newer publishedAt wins,
 * with id as tiebreaker (auto-increment, so higher id ⇒ written later).
 */
function pickLatest(a: DailyReportRecord, b: DailyReportRecord): DailyReportRecord {
  const aTime = new Date(a.publishedAt).getTime();
  const bTime = new Date(b.publishedAt).getTime();
  if (aTime !== bTime) return bTime > aTime ? b : a;
  return (b.id ?? 0) > (a.id ?? 0) ? b : a;
}

/**
 * Upsert a daily report by date — overwrites any existing record(s) for the
 * same day, collapsing legacy duplicates into one. Mirrors the contract:
 * a non-finalized day's CID is replaced (last write wins), but once a day is
 * finalized the slot is locked and any further write is refused.
 */
export async function addDailyReport(report: Omit<DailyReportRecord, 'id'>): Promise<number> {
  const all = await readTable<DailyReportRecord>(TABLES.dailyReports);
  const sameDate = all.filter((r) => r.date === report.date && r.id !== undefined);

  if (sameDate.length === 0) {
    return addRecord<DailyReportRecord>(TABLES.dailyReports, report as DailyReportRecord);
  }

  // A finalized day is locked — refuse to overwrite it (matches the contract's
  // `require(!finalized)`). The UI hides the buttons, so this is a hard guard.
  if (sameDate.some((r) => r.finalized)) {
    throw new Error(`Day ${report.date} is finalized and cannot be overwritten.`);
  }

  // Keep one record (lowest id — oldest, will be updated in place), drop the rest.
  const keeper = sameDate.reduce((acc, r) => ((r.id ?? Infinity) < (acc.id ?? Infinity) ? r : acc));
  const dropIds = new Set(sameDate.filter((r) => r.id !== keeper.id).map((r) => r.id));
  const cleaned = all.filter((r) => !dropIds.has(r.id));

  // Apply the new report content to the keeper.
  const idx = cleaned.findIndex((r) => r.id === keeper.id);
  if (idx >= 0) cleaned[idx] = { ...cleaned[idx], ...report };

  await writeTable<DailyReportRecord>(TABLES.dailyReports, cleaned);
  return keeper.id as number;
}

/**
 * Returns one record per date — defensive dedupe for legacy rows written
 * before addDailyReport became upsert-by-date. Latest publishedAt wins.
 */
export async function getAllDailyReports(): Promise<DailyReportRecord[]> {
  const reports = await readTable<DailyReportRecord>(TABLES.dailyReports);
  const byDate = new Map<string, DailyReportRecord>();
  for (const r of reports) {
    const prev = byDate.get(r.date);
    byDate.set(r.date, prev ? pickLatest(prev, r) : r);
  }
  return [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
}

export async function getDailyReportByDate(date: string): Promise<DailyReportRecord | undefined> {
  return findFirstByField<DailyReportRecord>(TABLES.dailyReports, 'date', date);
}

/** True only once a day has been finalized (locked) — not merely saved. */
export async function isDayFinalized(date: string): Promise<boolean> {
  const all = await readTable<DailyReportRecord>(TABLES.dailyReports);
  return all.some((r) => r.date === date && r.finalized === true);
}

/** True if any report (saved or finalized) exists locally for the date. */
export async function hasReportForDate(date: string): Promise<boolean> {
  const report = await findFirstByField<DailyReportRecord>(TABLES.dailyReports, 'date', date);
  return !!report;
}

// ========== CLEAR ALL ==========

export async function clearAllData(): Promise<void> {
  await Promise.all(Object.values(TABLES).map((t) => clearTable(t)));
}
