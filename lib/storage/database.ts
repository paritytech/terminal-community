/**
 * T3RMINAL Storage Layer
 *
 * Uses the host's local storage inside a host, memory outside one (see
 * ./host-storage.ts). Every change runs under its table's lock, and a host
 * failure rejects instead of being swallowed.
 */

import {
  readTable,
  mutateTable,
  addRecord,
  updateWhere,
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

// Cap the generated CSVs we keep — each record embeds the full CSV text, and
// host localStorage is a shared, finite budget. By count and by size: one
// 92-day export can be larger than twenty one-day ones, and a write the host
// refuses as full fails the sale writes after it too.
const MAX_CSV_REPORTS = 20;
const MAX_CSV_CACHE_CHARS = 1_000_000;

/**
 * Keep the export for re-download. Resolves to its id, or null when it alone
 * is too large to keep (it can still be downloaded now).
 */
export async function addCsvReport(report: Omit<CsvReportRecord, 'id'>): Promise<number | null> {
  const size = (r: Pick<CsvReportRecord, 'csv'>) => r.csv?.length ?? 0;
  if (size(report) > MAX_CSV_CACHE_CHARS) return null;
  return mutateTable<CsvReportRecord, number>(TABLES.csvReports, (all) => {
    const id = Date.now();
    const record = { ...report, id } as CsvReportRecord;
    const kept: CsvReportRecord[] = [record];
    let total = size(record);
    const newestFirst = [...all].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    for (const r of newestFirst) {
      if (kept.length >= MAX_CSV_REPORTS || total + size(r) > MAX_CSV_CACHE_CHARS) break;
      kept.push(r);
      total += size(r);
    }
    return { records: kept, result: id };
  });
}

/** Newest first. */
export async function getAllCsvReports(): Promise<CsvReportRecord[]> {
  const all = await readTable<CsvReportRecord>(TABLES.csvReports);
  return [...all].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

// ========== SALES ==========

/**
 * Record a sale once. A sale whose `saleId` is already stored (the in-session
 * path and a resume both settling one claim, say) is not added again; the
 * stored row's id is returned.
 */
export async function addSaleRecord(sale: Omit<SaleRecord, 'id' | 'createdAt'>): Promise<number> {
  return mutateTable<SaleRecord, number>(TABLES.sales, (records) => {
    const existing = records.find((r) => r.saleId === sale.saleId);
    if (existing?.id != null) return { records: null, result: existing.id };
    let maxId = 0;
    for (const r of records) if (typeof r.id === 'number' && r.id > maxId) maxId = r.id;
    const id = maxId + 1;
    return { records: [...records, { ...sale, id, createdAt: new Date() } as SaleRecord], result: id };
  });
}

/** Change every stored row of one sale (legacy duplicates included). */
function updateSale(saleId: string, update: (sale: SaleRecord) => Partial<SaleRecord> | null): Promise<number> {
  return updateWhere<SaleRecord>(TABLES.sales, (s) => s.saleId === saleId, update);
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
  await updateSale(saleId, () => ({
    syncStatus: status,
    syncedAt: status === 'synced' ? new Date() : undefined,
    syncError: error,
  }) as Partial<SaleRecord>);
}

/**
 * Stamp `finalizedAt` on the sale once its inclusion block has reached
 * finality. Called from lib/payments/coinage/topup-watcher.ts.
 * Idempotent: no-op for unknown saleIds, won't overwrite an existing
 * timestamp.
 */
export async function markSaleFinalized(saleId: string, at: Date = new Date()): Promise<void> {
  await updateSale(saleId, (sale) => (sale.finalizedAt ? null : ({ finalizedAt: at } as Partial<SaleRecord>)));
}

/**
 * Coins claim settled partially after the sale was recorded: keep what the
 * cheque asked for on `requestedAmount*`, make `amount*` the credited total,
 * and mark the sale final (a partial claim is the host's last word).
 * Idempotent for an already-final sale.
 */
export async function recordSaleClaimShortfall(saleId: string, creditedPlanck: bigint): Promise<void> {
  const at = new Date();
  await updateSale(saleId, (sale) =>
    sale.finalizedAt || sale.revertedAt
      ? null
      : ({
          requestedAmount: sale.requestedAmount ?? sale.amount,
          requestedAmountPlanck: sale.requestedAmountPlanck ?? sale.amountPlanck,
          amount: formatAmountFromPlanck(creditedPlanck.toString(), PUSD_DECIMALS),
          amountPlanck: creditedPlanck.toString(),
          finalizedAt: at,
        } as Partial<SaleRecord>),
  );
}

/**
 * Coins claim reverted after the sale was recorded (the host's last word was
 * `notClaimed`). The row stays, flagged, so History can say what happened;
 * totals skip it. Idempotent for an already-final sale.
 */
export async function markSaleReverted(saleId: string, at: Date = new Date()): Promise<void> {
  await updateSale(saleId, (sale) =>
    sale.finalizedAt || sale.revertedAt ? null : ({ revertedAt: at } as Partial<SaleRecord>),
  );
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
  await mutateTable<AppSettings>(TABLES.settings, (all) => {
    const idx = all.findIndex((s) => s.key === key);
    if (idx >= 0) {
      const next = [...all];
      next[idx] = { ...next[idx], value, updatedAt: new Date() };
      return { records: next, result: undefined };
    }
    let maxId = 0;
    for (const s of all) if (typeof s.id === 'number' && s.id > maxId) maxId = s.id;
    return { records: [...all, { id: maxId + 1, key, value, updatedAt: new Date() } as AppSettings], result: undefined };
  });
}

export async function getSetting(key: string): Promise<string | undefined> {
  const setting = await findFirstByField<AppSettings>(TABLES.settings, 'key', key);
  return setting?.value;
}

export async function deleteSetting(key: string): Promise<void> {
  await mutateTable<AppSettings>(TABLES.settings, (all) => {
    const next = all.filter((s) => s.key !== key);
    return { records: next.length === all.length ? null : next, result: undefined };
  });
}

// ========== RECEIPT CACHE ==========

export async function cacheReceipt(saleId: string, svgContent: string): Promise<void> {
  const existing = await findFirstByField<ReceiptCache>(TABLES.receiptCache, 'saleId', saleId);
  if (existing) return;
  await mutateTable<ReceiptCache>(TABLES.receiptCache, (all) => {
    if (all.some((r) => r.saleId === saleId)) return { records: null, result: undefined };
    let maxId = 0;
    for (const r of all) if (typeof r.id === 'number' && r.id > maxId) maxId = r.id;
    const record = { id: maxId + 1, saleId, svgContent, pdfGenerated: false, createdAt: new Date() } as ReceiptCache;
    return { records: [...all, record], result: undefined };
  });
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
  return mutateTable<DailyReportRecord, number>(TABLES.dailyReports, (all) => {
    const sameDate = all.filter((r) => r.date === report.date && r.id !== undefined);

    if (sameDate.length === 0) {
      let maxId = 0;
      for (const r of all) if (typeof r.id === 'number' && r.id > maxId) maxId = r.id;
      const id = maxId + 1;
      return { records: [...all, { ...report, id } as DailyReportRecord], result: id };
    }

    // A finalized day is locked — refuse to overwrite it (matches the contract's
    // `require(!finalized)`). The UI hides the buttons, so this is a hard guard.
    // Checked under the table's lock, so a finalize that just landed counts.
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

    return { records: cleaned, result: keeper.id as number };
  });
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
