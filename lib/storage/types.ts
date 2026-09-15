/**
 * Local Storage Types for T3RMINAL
 * Based on the three-layer storage architecture (Local -> Smart Contract -> Bulletin Chain)
 */

export type SyncStatus = 'pending' | 'synced' | 'failed';
export type TransactionType = 'incoming' | 'outgoing';

/**
 * Stored cart line — a snapshot of an item at the moment of sale, so the
 * printed/re-printed receipt is reproducible even if the catalog later
 * changes the item's name or price.
 */
export interface SaleItem {
  name: string;
  quantity: number;
  /** Per-unit price in human-readable receipt currency (e.g. "2.50"). */
  unitPrice: string;
}

/**
 * Sale record stored locally
 * This represents a completed transaction
 */
export interface SaleRecord {
  id?: number; // Auto-incremented primary key
  saleId: string; // ULID-based unique identifier
  amount: string; // Amount in human-readable format (e.g., "17.00")
  amountPlanck: string; // Amount in planck units
  asset: string; // Asset symbol (e.g., "USD", "HOLLAR")
  assetId: string; // Asset ID on chain

  // Addresses in Substrate format (prefix 42, starts with "5")
  merchantAddress: string; // Recipient address (merchant)
  customerAddress: string; // Sender address (customer)
  customerName?: string; // Optional display name (e.g., "Mason.42")

  // Normalized addresses (Substrate format, prefix 42) for indexing/querying
  merchantAddressNormalized?: string;
  customerAddressNormalized?: string;

  // Transaction details
  transactionHash?: string; // Block hash
  blockNumber?: number;
  blockHash?: string;

  // Timestamps
  timestamp: Date; // When the transaction occurred
  createdAt: Date; // When the record was created locally

  // Sync status
  syncStatus: SyncStatus;
  syncedAt?: Date;
  syncError?: string;

  /**
   * Set once the payment is final. The sale is persisted on best-block (so
   * the merchant can move on) and a background watcher patches this field
   * later: for coins, lib/payments/coinage/topup-watcher.ts on the host's
   * `claimed { finalized: true }`. Absence means "still confirming";
   * presence (or `revertedAt`) means terminal.
   */
  finalizedAt?: Date;

  /**
   * Coins claims only: the host's top-up registration id (32 bytes, hex) the
   * sale was settled from. Lets the watcher resume after an app restart.
   */
  topUpId?: string;

  /**
   * Set when the host's last word on the claim was `notClaimed` after the
   * sale had already been recorded (a reorg took the coins away). The sale
   * stays in History as reverted and is excluded from totals.
   */
  revertedAt?: Date;

  /**
   * Set when the host credited less than the cheque asked for. `amount` /
   * `amountPlanck` hold what was actually credited; these hold the request.
   */
  requestedAmount?: string;
  requestedAmountPlanck?: string;

  // Transaction type
  type: TransactionType;

  /** Itemized lines, when the sale came from /items. Omitted for direct-amount sales. */
  items?: SaleItem[];

  /** Tip portion of `amount` (decimal string), when the sale carried a tip.
   *  `amount` stays the grand total; subtotal = amount − tip. Reports sum this
   *  across receipts to show total tips. */
  tip?: string;

  /** Merchant note entered on the Review-sale step (e.g. "Amazon Gift Card").
   *  Shown on the success screen and receipt; never leaves the device. */
  note?: string;
}

/**
 * Pending payment waiting to be confirmed
 */
export interface PendingPayment {
  id?: number;
  saleId: string;
  amount: string;
  asset: string;
  assetId: string;
  merchantAddress: string;
  qrValue: string;
  createdAt: Date;
  expiresAt?: Date;
  status: 'waiting' | 'expired' | 'cancelled';
}

/**
 * App settings stored locally
 */
export interface AppSettings {
  id?: number;
  key: string;
  value: string;
  updatedAt: Date;
}

/**
 * Cached receipt data
 */
export interface ReceiptCache {
  id?: number;
  saleId: string;
  svgContent: string;
  pdfGenerated: boolean;
  createdAt: Date;
}

/**
 * Sync state tracking
 */
export interface SyncState {
  id?: number;
  lastSyncedBlock: number;
  lastSyncTimestamp: Date;
  syncInProgress: boolean;
}

/**
 * A generated CSV export, kept locally so the Export CSV screen can list
 * recent reports and re-download them without regenerating.
 */
export interface CsvReportRecord {
  id?: number;
  /** Unique id (timestamp-based) used to reference the report. */
  reportId: string;
  /** Human period label, e.g. "12 June 2026" or "12 June - 12 July 2025". */
  label: string;
  fromYmd: string; // YYYY-MM-DD
  toYmd: string; // YYYY-MM-DD
  /** Distinct sales included (not CSV line count). */
  txCount: number;
  /** Full CSV text, ready to download. */
  csv: string;
  createdAt: Date;
}

/**
 * Daily report record stored locally
 * Replaces on-chain BulletinIndex storage
 */
export interface DailyReportRecord {
  id?: number;
  date: string; // YYYY-MM-DD
  cid: string; // IPFS CID
  gatewayUrl: string; // Full IPFS gateway URL
  bulletinBlockHash: string; // Block hash on Bulletin Chain
  entryCount: number; // Number of transactions in report
  merchantAddress: string; // Merchant who finalized
  terminalId?: string; // Terminal that produced the report
  finalized?: boolean; // Once true, the day is locked (no further overwrites)
  signedBy: string; // Who signed the Bulletin Chain transaction
  publishedAt: Date; // When the report was finalized
  periodClosedAt?: string; // Last sale timestamp included in a finalized period
}
